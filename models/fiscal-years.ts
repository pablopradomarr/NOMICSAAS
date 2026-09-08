/**
 * E3 · T8 — Ejercicios contables (`docs/design/E3-libro-diario.md` §4.1).
 *
 * Reglas del experto contable que viven aquí: B-2/B-3 (bloqueo secuencial y
 * arrastre del desbloqueo, en `models/period-locks.ts`), B-4 (cerrar exige los
 * doce meses bloqueados, T-26 y T-27 posteados y los invariantes en PASS) y N-7
 * (`REGULARIZATION` → `CLOSING` → `OPENING` del ejercicio siguiente, en ese
 * orden y con los números correlativos que les toque).
 *
 * **No existe reapertura** (decisión 4 de §9.2): un ejercicio `CLOSED` es una
 * cuenta anual formulada. Lo que llega tarde se registra con T-22.
 */

import { createHash } from "node:crypto"

import {
  canCloseFiscalYear,
  closingChecklist,
  closingSeal,
  PENDING_RECOMPUTE_STEP_CODES,
  REOPENING_REVERSAL_ORDER,
  type ClosingStepResult,
  type ManualAnswer,
} from "@/lib/closing/checklist"
import { tenantTransaction, type TenantTransactionClient } from "@/lib/db"
import { resolveReversalDate } from "@/lib/ledger/dates"
import { buildReversal } from "@/lib/ledger/void"
import {
  createClosingRunTx,
  sealedClosingRun,
  readChecklistInput,
  updateClosingRunTx,
  type ClosingRunRow,
  type ClosingStepRecord,
} from "@/models/closing"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { runInvariants as runInvariantsPure } from "@/lib/ledger/invariants"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { Cents, EntryDraft, LocalDate, PostedEntry } from "@/lib/ledger/types"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import {
  abort,
  abortWith,
  AnyClient,
  computeLedgerHash,
  getAccountBalances,
  getEntries,
  getEntry,
  getLedgerContext,
  LedgerResult,
  listPeriodLockRefs,
  modelErr,
  modelFail,
  modelOk,
  postEntryTx,
  runLedgerTransaction,
} from "@/models/ledger"
import { lockedMonths, lockPeriodTx, monthsBetween } from "@/models/period-locks"
import type { FiscalYear } from "@/prisma/client"
import { randomUUID } from "node:crypto"

export { lockPeriod, unlockPeriod, listPeriodLocks, lockedMonths } from "@/models/period-locks"

export async function listFiscalYears(db: AnyClient): Promise<FiscalYear[]> {
  return await db.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
}

export async function getFiscalYear(db: AnyClient, id: string): Promise<FiscalYear | null> {
  return await db.fiscalYear.findFirst({ where: { id } })
}

export async function getFiscalYearByCode(db: AnyClient, code: string): Promise<FiscalYear | null> {
  return await db.fiscalYear.findFirst({ where: { code } })
}

/** El ejercicio que contiene una fecha contable, si existe. */
export async function getFiscalYearForDate(db: AnyClient, date: LocalDate): Promise<FiscalYear | null> {
  return await db.fiscalYear.findFirst({
    where: { startDate: { lte: toUtcDate(date) }, endDate: { gte: toUtcDate(date) } },
  })
}

export type OpenFiscalYearInput = { code: string; startDate: LocalDate; endDate: LocalDate }

/**
 * Alta de ejercicio. Se permite el ejercicio irregular (< 12 meses); lo que no
 * se permite es solaparse con otro, y de eso se encarga además el `EXCLUDE
 * USING gist` de la BD (§2.4), que es la barrera que no se puede olvidar.
 */
export async function openFiscalYear(
  organizationId: string,
  input: OpenFiscalYearInput,
  actor: Actor
): Promise<LedgerResult<FiscalYear>> {
  if (input.endDate < input.startDate) {
    return modelFail(modelErr("FY_DATES", "endDate", "La fecha de fin no puede ser anterior a la de inicio"))
  }
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    {
      const existing = await tx.fiscalYear.findMany()
      if (existing.some((fy) => fy.code === input.code)) {
        abort(modelErr("FY_DUPLICATE_CODE", "code", `Ya existe el ejercicio ${input.code}`))
      }
      const overlap = existing.find(
        (fy) => fromUtcDate(fy.startDate) <= input.endDate && fromUtcDate(fy.endDate) >= input.startDate
      )
      if (overlap) {
        abort(modelErr("FY_OVERLAP", "startDate", `El periodo se solapa con el ejercicio ${overlap.code}`))
      }

      const created = await tx.fiscalYear.create({
        data: {
          organizationId,
          code: input.code,
          startDate: toUtcDate(input.startDate),
          endDate: toUtcDate(input.endDate),
          status: "OPEN",
          lastEntryNumber: 0,
        },
      })

      await writeAuditLog(tx, {
        entity: "FiscalYear",
        entityId: created.id,
        action: "open",
        after: { code: input.code, startDate: input.startDate, endDate: input.endDate, status: "OPEN" },
        userId: actor.userId ?? null,
      })

      return created
    }
  })
}

/** Alias del diseño (§4.1). */
export const createFiscalYear = openFiscalYear

export type CloseFiscalYearResult = {
  fiscalYear: FiscalYear
  regularizacion: PostedEntry | null
  cierre: PostedEntry | null
  apertura: PostedEntry | null
  lockedMonths: number[]
  ledgerHash: string
}

/**
 * Cierre del ejercicio, TODO en una transacción (B-4 + N-7):
 *
 *  1. T-26 `REGULARIZACION_RESULTADO` con los saldos de los grupos 6 y 7.
 *  2. T-27 `CIERRE_EJERCICIO` con los saldos de balance resultantes.
 *  3. T-28 `APERTURA_EJERCICIO` en el ejercicio siguiente, si existe y está
 *     abierto — espejo exacto del cierre (I-E3-6).
 *  4. Bloqueo de los doce meses que falten, secuencialmente (B-2).
 *  5. Invariantes I1, I7–I10, I-E3-1…7 sobre el ejercicio: cualquier FAIL
 *     aborta la transacción entera y el ejercicio NO se cierra.
 *  6. `status = CLOSED`, `closedAt`, `closedById` y `AuditLog`.
 *
 * El orden importa: los asientos de sistema se postean con el ejercicio abierto
 * y el mes 12 sin bloquear (si no, los rechaza el trigger
 * `journal_entries_period_open`), y los bloqueos se ponen después, de modo que
 * al terminar se cumple B-4 en su totalidad.
 *
 * **Divergencia respecto de §4.1 del diseño**, que aplazaba T-26/T-27 a E9: el
 * encargo de esta tarea pide la orquestación completa en E3. Lo que E9 sigue
 * aportando es la base imponible con ajustes extracontables (T-25), que aquí no
 * se genera: el ejercicio se cierra con el impuesto que ya se haya contabilizado.
 */
export async function closeFiscalYear(
  organizationId: string,
  fiscalYearId: string,
  actor: Actor,
  reason: string,
  opts: { skipInvariants?: boolean; refDate?: LocalDate } = {}
): Promise<LedgerResult<CloseFiscalYearResult>> {
  return await runLedgerTransaction(
    organizationId,
    actor.userId,
    async (tx) => {
      const fy = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId } })
      if (!fy) abort(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
      if (fy.status === "CLOSED") {
        abort(modelErr("FY_CLOSED", "fiscalYearId", `El ejercicio ${fy.code} ya está cerrado`))
      }

      const startDate = fromUtcDate(fy.startDate)
      const endDate = fromUtcDate(fy.endDate)
      const refDate = opts.refDate ?? endDate

      // ── 1. Regularización (T-26) ──────────────────────────────────────────
      const balances = await getAccountBalances(tx, { upTo: endDate, fiscalYearId })
      const pnl = [...balances.entries()].filter(
        ([code, saldo]) => (code.startsWith("6") || code.startsWith("7")) && saldo !== 0
      )

      let regularizacion: PostedEntry | null = null
      if (pnl.length > 0) {
        const ctx = await getLedgerContext(tx, refDate, { balances })
        const built = buildFromTemplate(
          "REGULARIZACION_RESULTADO",
          { entryDate: endDate, description: `Regularización del ejercicio ${fy.code}` },
          ctx
        )
        if (!built.ok) abortWith(built.errors)
        regularizacion = await postEntryTx(tx, built.value, actor)
      }

      // ── 2. Cierre (T-27) con los saldos ya regularizados ──────────────────
      const afterRegularization = await getAccountBalances(tx, { upTo: endDate, fiscalYearId })
      const balanceSheet = new Map(
        [...afterRegularization.entries()].filter(
          ([code, saldo]) => !code.startsWith("6") && !code.startsWith("7") && saldo !== 0
        )
      )

      let cierre: PostedEntry | null = null
      if (balanceSheet.size > 0) {
        const ctx = await getLedgerContext(tx, refDate, { balances: afterRegularization })
        const built = buildFromTemplate(
          "CIERRE_EJERCICIO",
          { entryDate: endDate, description: `Cierre del ejercicio ${fy.code}` },
          ctx
        )
        if (!built.ok) abortWith(built.errors)
        cierre = await postEntryTx(tx, built.value, actor)
      }

      // ── 3. Apertura del siguiente (T-28), espejo exacto (I-E3-6) ──────────
      let apertura: PostedEntry | null = null
      const next = await tx.fiscalYear.findFirst({
        where: { startDate: { gt: fy.endDate }, status: "OPEN" },
        orderBy: { startDate: "asc" },
      })
      if (next && balanceSheet.size > 0) {
        const nextStart = fromUtcDate(next.startDate)
        const ctx = await getLedgerContext(tx, nextStart, { balances: balanceSheet })
        const built = buildFromTemplate(
          "APERTURA_EJERCICIO",
          { entryDate: nextStart, fiscalYearId: next.id, description: `Apertura del ejercicio ${next.code}` },
          ctx
        )
        if (!built.ok) abortWith(built.errors)
        const draft: EntryDraft = { ...built.value, fiscalYearId: next.id }
        apertura = await postEntryTx(tx, draft, actor)
      }

      // ── 4. B-4: todos los meses del ejercicio bloqueados, en su secuencia ──
      const already = await lockedMonths(tx, fiscalYearId)
      for (const month of monthsBetween(startDate, endDate)) {
        if (already.includes(month)) continue
        await lockPeriodTx(tx, { fiscalYearId, month, reason: `Cierre del ejercicio ${fy.code}` }, actor)
      }
      const finalLocks = await lockedMonths(tx, fiscalYearId)

      // ── 5. Invariantes (B-4) ──────────────────────────────────────────────
      const ledgerHashValue = await computeLedgerHash(tx, { fiscalYearId })
      if (!opts.skipInvariants) {
        const page = await getEntries(tx, { fiscalYearId }, { take: 100_000 })
        const fiscalYearRows = await tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
        const periodLocks = await listPeriodLockRefs(tx)
        const accounts = await tx.ledgerAccount.findMany({ select: { code: true, isPostable: true, isActive: true } })
        const validacion = runInvariantsPure(
          {
            runId: randomUUID(),
            gitSha: process.env.GIT_SHA ?? "desconocido",
            organizationId,
            ledgerHash: ledgerHashValue,
            entries: page.entries,
            fiscalYears: fiscalYearRows.map((row) => ({
              id: row.id,
              code: row.code,
              startDate: fromUtcDate(row.startDate),
              endDate: fromUtcDate(row.endDate),
              status: row.status,
              lastEntryNumber: row.lastEntryNumber,
            })),
            periodLocks,
            accounts: accounts.map((a) => ({ ...a, organizationId })),
          },
          refDate
        )
        const failed = validacion.checks.filter((c) => c.status === "FAIL")
        if (failed.length > 0) {
          // Abortar, NO devolver: si se devolviera, Prisma haría COMMIT y el
          // ejercicio quedaría con T-26/T-27/T-28 y los doce bloqueos puestos
          // pese a no haber pasado los invariantes (BLOQUEA #1).
          abort(
            modelErr(
              "INVARIANTS_FAILED",
              "fiscalYearId",
              `No se cierra el ejercicio: ${failed.map((c) => `${c.id} (${c.evidencia})`).join(" · ")}`
            )
          )
        }
      }

      // ── 6. CLOSED ─────────────────────────────────────────────────────────
      const closed = await tx.fiscalYear.update({
        where: { id: fiscalYearId },
        data: { status: "CLOSED", closedAt: new Date(), closedById: actor.userId ?? null },
      })

      await writeAuditLog(tx, {
        entity: "FiscalYear",
        entityId: fiscalYearId,
        action: "close",
        before: { code: fy.code, status: "OPEN", lastEntryNumber: fy.lastEntryNumber },
        after: {
          code: fy.code,
          status: "CLOSED",
          lastEntryNumber: closed.lastEntryNumber,
          regularizacionEntryId: regularizacion?.id ?? null,
          cierreEntryId: cierre?.id ?? null,
          aperturaEntryId: apertura?.id ?? null,
          lockedMonths: finalLocks,
          ledgerHash: ledgerHashValue,
        },
        reason,
        userId: actor.userId ?? null,
      })

      return {
        fiscalYear: closed,
        regularizacion,
        cierre,
        apertura,
        lockedMonths: finalLocks,
        ledgerHash: ledgerHashValue,
      }
    },
    { timeout: 120_000, maxWait: 15_000 }
  )
}

/**
 * Meses de un ejercicio, en su secuencia. Vive en `models/period-locks.ts`
 * (lo necesita B-2) y se reexporta aquí, que es donde se busca.
 */
export { monthsBetween } from "@/models/period-locks"

/** Saldos de un ejercicio, para la UI de cierre (vista previa de T-26/T-27). */
export async function getFiscalYearBalances(
  organizationId: string,
  fiscalYearId: string,
  actor: Actor = { userId: null }
): Promise<Map<string, Cents>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const fy = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId } })
    if (!fy) return new Map<string, Cents>()
    return await getAccountBalances(tx, { upTo: fromUtcDate(fy.endDate), fiscalYearId })
  })
}

// ═════════════════════════════════════════════════════════════════════════════
// E9 · T13 — El cierre como ACTO: checklist, orden de O-17 y reapertura de D1
// ═════════════════════════════════════════════════════════════════════════════

/**
 * **La enmienda de ADR-0016 D1 al comentario de cabecera de este fichero.** E3
 * decía «no existe reapertura» sin condición. Se matiza: no existe reapertura de
 * cuentas **formuladas**. Reabrir un ejercicio `CLOSED` con las cuentas en
 * `BORRADOR` no toca ninguna cuenta rendida, respeta el art. 29.1 CCom —nada se
 * borra, son cuatro contra-asientos— y el art. 30 CCom.
 */

/**
 * Ejecuta los pasos del checklist y sella un `ClosingRun`. **No postea nada**
 * (§5.2): es la acción de lectura que el asistente refresca, y por eso la puede
 * lanzar un VIEWER.
 *
 * El `ClosingRun` nace `COMPROBADO` si los **nueve bloqueantes** están en PASS y
 * `BORRADOR` en cualquier otro caso. `closeFiscalYearE9` exige `COMPROBADO` **y
 * el mismo `ledgerHash`**: entre el checklist y el botón puede haber entrado un
 * asiento, y cerrar sobre una foto vieja es sellar un número que ya no existe.
 */
export async function runClosingChecklist(
  organizationId: string,
  fiscalYearId: string,
  actor: Actor,
  opts: { refDate?: LocalDate; answers?: Readonly<Record<string, ManualAnswer>> } = {}
): Promise<LedgerResult<ClosingRunRow>> {
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const started = process.hrtime.bigint()
    const fy = await tx.fiscalYear.findFirst({ where: { id: fiscalYearId } })
    if (!fy) abort(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
    const refDate = opts.refDate ?? fromUtcDate(fy.endDate)

    const org = await tx.organization.findFirst({ where: { id: organizationId }, select: { baseCurrency: true } })
    const input = await readChecklistInput(tx, {
      fiscalYearId,
      refDate,
      baseCurrency: org?.baseCurrency ?? "EUR",
    })
    if (opts.answers) input.answers = { ...input.answers, ...opts.answers }

    const steps = closingChecklist(input, refDate)
    const { seal, reasons } = closingSeal(steps)
    const ledgerHashValue = await computeLedgerHash(tx, { fiscalYearId })
    const durationMs = Number((process.hrtime.bigint() - started) / BigInt(1_000_000))

    return await createClosingRunTx(
      tx,
      {
        fiscalYearId,
        refDate,
        steps: steps.map((s) => ({ ...s, answer: input.answers?.[s.step] })) as ClosingStepRecord[],
        ledgerHash: ledgerHashValue,
        planHash: await hashOfPlan(tx),
        accountMapHash: await hashOfAccountMap(tx),
        configHash: "0".repeat(64),
        gitSha: process.env.GIT_SHA ?? "desconocido",
        seal,
        sealReasons: reasons,
        durationMs,
        status: canCloseFiscalYear(steps).ok ? "COMPROBADO" : "BORRADOR",
      },
      actor
    )
  })
}

export type CloseFiscalYearE9Result = CloseFiscalYearResult & {
  closingRunId: string
  /** Los ids de los doce asientos de O-17 que este cierre ha posteado o hallado. */
  entryIds: Record<string, string | null>
  reclassReversalEntryId: string | null
}

/**
 * **El cierre con el orden de O-17.** Envuelve `closeFiscalYear`: los pasos 1-8
 * (recurrentes, RECC, prorrata, IVA, valor actual, diferencias de cambio,
 * reclasificación e impuesto) se postean **antes**, uno a uno, con
 * `postClosingStepAction`; aquí se comprueba **en servidor** que están hechos y
 * se rematan los pasos 9-12 en **una sola transacción**:
 *
 *  9. T-26 regularización — barre 6/7, **incluida la `6300`**
 * 10. T-27 cierre — con los saldos **ya reclasificados**
 * 11. T-28 apertura — nº 1 de N+1, espejo exacto (I-E9-14)
 * 12. Contra-asiento de T-32 — nº 2 de N+1 (O-8)
 *
 * Tres barreras antes de tocar nada: `ClosingRun` **`COMPROBADO`**, **mismo
 * `ledgerHash`** y los **nueve bloqueantes en PASS**. La tercera se comprueba
 * aquí y no sólo al pintar el botón (D1.1, criterio 31).
 */
export async function closeFiscalYearE9(
  organizationId: string,
  input: { fiscalYearId: string; closingRunId: string; reason: string; refDate?: LocalDate },
  actor: Actor
): Promise<LedgerResult<CloseFiscalYearE9Result>> {
  const guard = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const run = await tx.closingRun.findFirst({ where: { id: input.closingRunId } })
    if (!run) return "El cierre comprobado no existe en esta organización: lance el checklist antes de cerrar"
    if (run.fiscalYearId !== input.fiscalYearId) return "El cierre comprobado es de otro ejercicio"
    if (run.status !== "COMPROBADO") {
      return `El cierre está en estado ${run.status}: sólo se cierra desde un checklist COMPROBADO (D1.1)`
    }
    const current = await computeLedgerHash(tx, { fiscalYearId: input.fiscalYearId })
    if (current !== run.ledgerHash) {
      return (
        "El diario ha cambiado desde que se comprobó el cierre: vuelva a lanzar el checklist y revise los pasos " +
        "(el ejercicio NO se ha cerrado)"
      )
    }
    const steps = (Array.isArray(run.steps) ? (run.steps as ClosingStepRecord[]) : []) as ClosingStepResult[]
    const blockers = canCloseFiscalYear(steps)
    if (!blockers.ok) {
      return `No se cierra el ejercicio: ${blockers.blockers.map((b) => `${b.step} (${b.evidencia})`).join(" · ")}`
    }
    return null
  })
  if (typeof guard === "string") {
    return modelFail(modelErr("INVARIANTS_FAILED", "fiscalYearId", guard))
  }

  const closed = await closeFiscalYear(organizationId, input.fiscalYearId, actor, input.reason, {
    refDate: input.refDate,
  })
  if (!closed.ok) return closed

  // El sello del `ClosingRun` se cierra DESPUÉS de que el ejercicio esté
  // cerrado: un run `CERRADO` con el ejercicio abierto sería un sello que no
  // sella nada.
  const sealed = await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const reversal = await tx.journalEntry.findFirst({
      where: { templateCode: "RECLASIFICACION_VENCIMIENTOS", voidedAt: null, fiscalYearId: input.fiscalYearId },
      select: { id: true },
    })
    const run = await updateClosingRunTx(
      tx,
      {
        id: input.closingRunId,
        status: "CERRADO",
        entryIds: {
          ...(closed.value.regularizacion ? { regularizacionEntryId: closed.value.regularizacion.id } : {}),
          ...(closed.value.cierre ? { cierreEntryId: closed.value.cierre.id } : {}),
          ...(closed.value.apertura ? { aperturaEntryId: closed.value.apertura.id } : {}),
          ...(reversal ? { reclassEntryId: reversal.id } : {}),
        },
        closedAt: new Date(),
        closedById: actor.userId ?? null,
      },
      actor
    )
    return { run, reclassEntryId: reversal?.id ?? null }
  })
  if (!sealed.ok) return modelFail(...sealed.errors)

  return modelOk({
    ...closed.value,
    closingRunId: input.closingRunId,
    entryIds: {
      regularizacion: closed.value.regularizacion?.id ?? null,
      cierre: closed.value.cierre?.id ?? null,
      apertura: closed.value.apertura?.id ?? null,
    },
    reclassReversalEntryId: sealed.value.reclassEntryId,
  })
}

export type ReopenFiscalYearResult = {
  fiscalYear: FiscalYear
  /** Los **cuatro** contra-asientos de O-21, en orden T-28 → T-27 → T-26 → T-25. */
  reversalEntryIds: string[]
  /** Los pasos 5-7, que no se revierten y quedan a recomputar (O-21). */
  pendingRecompute: readonly string[]
  closingRunId: string | null
  warnings: string[]
}

/**
 * **Reapertura (D1, con O-20 y O-21).**
 *
 * 1. `status = CLOSED`, `accountsApprovalStatus = BORRADOR`, rol ADMIN, motivo
 *    ≥ 30 caracteres y confirmación escribiendo el código del ejercicio.
 * 2. Con las cuentas **FORMULADAS** o posteriores se rechaza — pero el mensaje
 *    **ofrece la salida**: *«requiere acuerdo de reformulación (NRV 23ª);
 *    regístrelo y vuelva a marcar el ejercicio como BORRADOR»*. Si el producto
 *    no ofrece salida, el usuario la fabricará por SQL.
 * 3. **(Q-1.2)** Con el modelo 200 presentado, aviso obligatorio del art. 122
 *    LGT, recogido en `AuditLog`.
 * 4. **(O-21)** Revierte T-28 → T-27 → T-26 → **T-25**. Sin T-25, al recerrar el
 *    impuesto se posteaba otra vez y `6300` quedaba al doble con `4752`
 *    duplicado. Los pasos 5-7 **no se revierten** —son idempotentes— y quedan
 *    `PENDIENTE_RECOMPUTO`.
 * 5. **(O-20)** La numeración pasa a ser **por asiento vivo**: el nuevo T-28 se
 *    acepta aunque su `entryNumber` no sea 1, porque N-1′ mira la **menor
 *    `entryDate` no anulada**, no la posición absoluta.
 * 6. Reabrir N con **N+1 ya cerrado** es **bloqueante**.
 *
 * Todo en **una** transacción: o hay cuatro contra-asientos y el ejercicio
 * abierto, o no hay nada.
 */
export async function reopenFiscalYear(
  organizationId: string,
  input: {
    fiscalYearId: string
    reason: string
    confirmCode: string
    acknowledgeTaxFiling?: boolean
    acknowledgeNextYear?: boolean
  },
  actor: Actor
): Promise<LedgerResult<ReopenFiscalYearResult>> {
  if (input.reason.trim().length < 30) {
    return modelFail(modelErr("FY_DATES", "reason", "Reabrir un ejercicio exige un motivo de al menos 30 caracteres"))
  }
  return await runLedgerTransaction(
    organizationId,
    actor.userId,
    async (tx) => {
      const fy = await tx.fiscalYear.findFirst({ where: { id: input.fiscalYearId } })
      if (!fy) abort(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
      if (fy.status !== "CLOSED") abort(modelErr("FY_CLOSED", "fiscalYearId", `El ejercicio ${fy.code} no está cerrado`))
      if (input.confirmCode.trim() !== fy.code) {
        abort(
          modelErr("FY_DATES", "confirmCode", `Escriba el código del ejercicio (${fy.code}) para confirmar la reapertura`)
        )
      }
      if (fy.accountsApprovalStatus !== "BORRADOR") {
        abort(
          modelErr(
            "FY_CLOSED",
            "accountsApprovalStatus",
            `Las cuentas de ${fy.code} están ${fy.accountsApprovalStatus}: reabrir ahora requiere un acuerdo de ` +
              "REFORMULACIÓN (NRV 23ª, arts. 253, 272 y 279 LSC). Regístrelo y vuelva a marcar el ejercicio como " +
              "BORRADOR; entonces la reapertura estará disponible"
          )
        )
      }

      const warnings: string[] = []
      if (fy.taxFilingStatus !== "NO_PRESENTADO") {
        if (input.acknowledgeTaxFiling !== true) {
          abort(
            modelErr(
              "FY_CLOSED",
              "taxFilingStatus",
              "El modelo 200 de este ejercicio ya se ha presentado: reabrir obliga a autoliquidación complementaria " +
                "o rectificativa (art. 122 LGT). Confirme que lo asume para continuar"
            )
          )
        }
        warnings.push(
          "Modelo 200 ya presentado: la reapertura obliga a autoliquidación complementaria o rectificativa (art. 122 LGT)"
        )
      }

      // (6) N+1 cerrado bloquea: hay que reabrir antes el posterior.
      const next = await tx.fiscalYear.findFirst({
        where: { startDate: { gt: fy.endDate } },
        orderBy: { startDate: "asc" },
      })
      if (next?.status === "CLOSED") {
        abort(
          modelErr(
            "FY_CLOSED",
            "fiscalYearId",
            `El ejercicio siguiente (${next.code}) está cerrado: reábralo antes que ${fy.code}`
          )
        )
      }
      if (next) {
        const posteriores = await tx.journalEntry.count({
          where: { fiscalYearId: next.id, voidedAt: null, kind: { not: "OPENING" } },
        })
        if (posteriores > 0 && input.acknowledgeNextYear !== true) {
          abort(
            modelErr(
              "FY_CLOSED",
              "fiscalYearId",
              `El ejercicio ${next.code} ya tiene ${posteriores} asientos posteriores a su apertura: la apertura se ` +
                "anulará y habrá que volver a generarla al recerrar. Confirme que lo asume para continuar"
            )
          )
        }
      }

      // (4) O-21 · los CUATRO contra-asientos, en orden inverso.
      const reversalEntryIds: string[] = []
      for (const templateCode of REOPENING_REVERSAL_ORDER) {
        const target = await tx.journalEntry.findFirst({
          where: {
            templateCode,
            voidedAt: null,
            fiscalYearId: templateCode === "APERTURA_EJERCICIO" ? (next?.id ?? input.fiscalYearId) : input.fiscalYearId,
          },
          orderBy: { entryNumber: "desc" },
          select: { id: true },
        })
        if (!target) continue
        const reversalId = await voidEntryInTx(tx, target.id, `Reapertura de ${fy.code}: ${input.reason}`, actor)
        reversalEntryIds.push(reversalId)
      }

      const reopened = await tx.fiscalYear.update({
        where: { id: input.fiscalYearId },
        data: { status: "OPEN", closedAt: null, closedById: null },
      })

      // Sólo un cierre **sellado** se reabre: un `ClosingRun` en BORRADOR es un
      // checklist, no un cierre, y marcarlo `REABIERTO` rompería
      // `closing_runs_closed_coherent` —que exige `closed_at` en CERRADO y
      // REABIERTO— además de mentir sobre lo que pasó.
      const run = await sealedClosingRun(tx, input.fiscalYearId)
      if (run) {
        const steps = run.steps.map((s) =>
          PENDING_RECOMPUTE_STEP_CODES.includes(s.step)
            ? {
                ...s,
                status: "PENDIENTE_RECOMPUTO" as const,
                evidencia:
                  "El ejercicio se ha reabierto: este ajuste es idempotente y hay que reevaluarlo antes de recerrar (O-21)",
              }
            : s
        )
        await updateClosingRunTx(
          tx,
          {
            id: run.id,
            status: "REABIERTO",
            steps,
            seal: "REQUIERE_REVISION",
            sealReasons: [...new Set([...run.sealReasons, "CIERRE_REABIERTO"])],
            reopen: { at: new Date(), byId: actor.userId ?? null, reason: input.reason, entryIds: reversalEntryIds },
          },
          actor
        )
      }

      await writeAuditLog(tx, {
        entity: "FiscalYear",
        entityId: input.fiscalYearId,
        action: "REOPEN",
        before: { code: fy.code, status: "CLOSED", taxFilingStatus: fy.taxFilingStatus },
        after: {
          status: "OPEN",
          reversalEntryIds,
          pendingRecompute: [...PENDING_RECOMPUTE_STEP_CODES],
          warnings,
        },
        reason: input.reason,
        userId: actor.userId ?? null,
      })

      return {
        fiscalYear: reopened,
        reversalEntryIds,
        pendingRecompute: PENDING_RECOMPUTE_STEP_CODES,
        closingRunId: run?.id ?? null,
        warnings,
      }
    },
    { timeout: 120_000, maxWait: 15_000 }
  )
}

/**
 * Contra-asiento **dentro** de la transacción en curso. `voidEntry` abre la
 * suya, y `runLedgerTransaction` prohíbe el anidamiento a propósito (una
 * mutación del diario no puede abrir otra): la reapertura son cuatro
 * contra-asientos **atómicos**, así que aquí se usa el mismo camino —
 * `buildReversal` + `postEntryTx` + marca de anulación— sobre `tx`.
 */
async function voidEntryInTx(
  tx: TenantTransactionClient,
  entryId: string,
  reason: string,
  actor: Actor
): Promise<string> {
  const original = await getEntry(tx, entryId)
  if (!original) abort(modelErr("ENTRY_NOT_FOUND", "entryId", "El asiento a anular no existe en esta organización"))
  const existingReversals = await tx.journalEntry.findMany({ where: { reversesEntryId: entryId }, select: { id: true } })

  const probe = await getLedgerContext(tx, "9999-12-31")
  const resolved = resolveReversalDate(original.entryDate, probe, null)
  if (!resolved.ok) abortWith(resolved.errors)
  const ctx = await getLedgerContext(tx, resolved.value.entryDate)
  const built = buildReversal(original, { reason, requestedDate: null, existingReversals }, ctx)
  if (!built.ok) abortWith(built.errors)

  const reversal = await postEntryTx(tx, built.value, actor)
  await tx.journalEntry.update({
    where: { id: entryId },
    data: { voidedAt: new Date(), voidedById: actor.userId ?? null, voidReason: reason },
  })
  await writeAuditLog(tx, {
    entity: "JournalEntry",
    entityId: entryId,
    action: "void",
    before: { entryNumber: original.entryNumber, voidedAt: null },
    after: { reversalEntryId: reversal.id, reversalEntryNumber: reversal.entryNumber },
    reason,
    userId: actor.userId ?? null,
  })
  return reversal.id
}

/** sha256 del plan vigente: dos cierres con el mismo plan comparten `planHash`. */
async function hashOfPlan(tx: TenantTransactionClient): Promise<string> {
  const rows = await tx.ledgerAccount.findMany({
    select: { code: true, isPostable: true, isActive: true, isMonetary: true },
    orderBy: { code: "asc" },
  })
  return createHash("sha256")
    .update(rows.map((r) => `${r.code}|${r.isPostable ? 1 : 0}|${r.isActive ? 1 : 0}|${r.isMonetary ? 1 : 0}`).join("\n"))
    .digest("hex")
}

/** sha256 del mapa de claves contables vigente. */
async function hashOfAccountMap(tx: TenantTransactionClient): Promise<string> {
  const rows = await tx.organizationAccountMap.findMany({ select: { key: true, accountCode: true }, orderBy: { key: "asc" } })
  return createHash("sha256")
    .update(rows.map((r) => `${r.key}|${r.accountCode}`).join("\n"))
    .digest("hex")
}
