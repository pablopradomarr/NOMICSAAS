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

import { tenantTransaction } from "@/lib/db"
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
  getLedgerContext,
  LedgerResult,
  listPeriodLockRefs,
  modelErr,
  modelFail,
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
        const [page, fiscalYearRows, periodLocks, accounts] = await Promise.all([
          getEntries(tx, { fiscalYearId }, { take: 100_000 }),
          tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } }),
          listPeriodLockRefs(tx),
          tx.ledgerAccount.findMany({ select: { code: true, isPostable: true, isActive: true } }),
        ])
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
