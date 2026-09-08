"use server"

/**
 * E9 · T15 — Server actions del IVA periódico (§5.2, ADR-0016 D4 y D8).
 *
 * La regla que gobierna este fichero es una: **el libro manda y el servidor
 * recalcula**. La vista previa y el botón recorren exactamente el mismo camino
 * —`readVatBook` → `vatSettlement`— y, antes de postear, se compara el
 * `ledgerHash` con el que el usuario vio (§9.3 de E7). Si el diario cambió entre
 * medias, la acción **rechaza y lo dice**: liquidar sobre cifras que ya no son
 * las que se enseñaron es la manera de sellar un número equivocado.
 *
 * Todas las mutaciones son **ADMIN** (§10): liquidar, revertir, cerrar la
 * prorrata y barrer el RECC mueven la declaración de un impuesto.
 */

import {
  closeProrrataYearSchema,
  createVatRegimePeriodSchema,
  listVatSettlementsSchema,
  model303QuerySchema,
  reccYearEndSchema,
  reverseVatSettlementSchema,
  setProvisionalProrrataSchema,
  settleVatSchema,
  vatBookQuerySchema,
} from "@/forms/vat"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import {
  capitalGoodsGuard,
  casillas303,
  lastVatPeriodOfYear,
  prorrataDefinitivaBps,
  prorrataRegularization,
  prorrataRegularizationLines,
  prorrataTerms,
  prorrateableQuotaCents,
  reccYearEndSweep,
  vatPeriodBounds,
  vatRegimeAt,
  vatSettlement,
  type ClosingStepResult,
  type IvaRegime,
  type Model303View,
  type ProrrataTerms,
  type VatBookRowE9,
  type VatPeriodKind,
} from "@/lib/closing/vat"
import { buildFromTemplate } from "@/lib/ledger/templates"
import { readCapitalGoodRefs } from "@/models/closing"
import type { EntryDraft, LocalDate } from "@/lib/ledger/types"
import {
  computeLedgerHash,
  formatLedgerErrors,
  getLedgerContext,
  postEntryTx,
  runLedgerTransaction,
  todayLocalDate,
  voidEntry,
  type LedgerResult,
} from "@/models/ledger"
import {
  closeProrrataYearTx,
  createVatRegimePeriodTx,
  createVatSettlementTx,
  getProrrataYear,
  listVatSettlements,
  readReccAccruals,
  readVatBook,
  readVatRegimePeriods,
  reverseVatSettlementTx,
  type VatSettlementRow,
} from "@/models/vat"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createHash } from "node:crypto"

const VAT_PATH = "/reports/vat"

/** Códigos del plan de las cuatro cuentas de IVA, resueltos por el mapa (§4.4). */
const IVA_KEYS = { input: "IVA_SOPORTADO", output: "IVA_REPERCUTIDO" } as const

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

const bookHashOf = (book: readonly VatBookRowE9[]): string =>
  createHash("sha256")
    .update(book.map((r) => `${r.id}|${r.ivaPeriod}|${r.baseCents}|${r.cuotaTotalCents}`).join("\n"))
    .digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// Contratos
// ─────────────────────────────────────────────────────────────────────────────

export type VatBookView = {
  period: string
  regime: IvaRegime
  periodKind: VatPeriodKind
  book: VatBookRowE9[]
  ledgerHash: string
  bookHash: string
}

export type SettleVatResult = {
  period: string
  dryRun: boolean
  draft: EntryDraft | null
  entryId: string | null
  entryNumber: number | null
  outputCents: number
  inputCents: number
  resultCents: number
  ledgerHash: string
  /** Los pasos que bloquearon la liquidación, si los hubo (O-11, O-12). */
  blockers: ClosingStepResult[]
}

export type ProrrataView = {
  year: number
  provisionalBps: number | null
  definitiveBps: number | null
  terms: ProrrataTerms
  prorrateableQuotaCents: number
  adjustmentCents: number | null
  capitalGoods: ClosingStepResult
  closedAt: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const vatBookAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<VatBookView>> => {
    const parsed = vatBookQuerySchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { period } = parsed.data
    const data = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const { end } = vatPeriodBounds(period)
      const lctx = await getLedgerContext(tx, end)
      const { book } = await readVatBook(tx, {
        period,
        inputVatCode: lctx.map(IVA_KEYS.input) ?? "472",
        outputVatCode: lctx.map(IVA_KEYS.output) ?? "477",
      })
      const regimes = await readVatRegimePeriods(tx)
      const regime = vatRegimeAt(regimes, end)
      return {
        period,
        regime: (regime?.regime ?? "GENERAL") as IvaRegime,
        periodKind: (regime?.periodKind ?? "TRIMESTRAL") as VatPeriodKind,
        book,
        ledgerHash: await computeLedgerHash(tx, { from: vatPeriodBounds(period).start, to: end }),
        bookHash: bookHashOf(book),
      }
    })
    return { success: true, data }
  }
)

/** **O-13.** Las casillas con su fórmula y su origen; las no ofrecidas, con su motivo. */
export const model303Action = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<Model303View>> => {
    const parsed = model303QuerySchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { period } = parsed.data
    const data = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const { end } = vatPeriodBounds(period)
      const lctx = await getLedgerContext(tx, end)
      const { book } = await readVatBook(tx, {
        period,
        inputVatCode: lctx.map(IVA_KEYS.input) ?? "472",
        outputVatCode: lctx.map(IVA_KEYS.output) ?? "477",
      })
      const regime = vatRegimeAt(await readVatRegimePeriods(tx), end)
      return casillas303({
        period,
        book,
        regime: (regime?.regime ?? "GENERAL") as IvaRegime,
        importDeferral: regime?.importDeferral ?? false,
      })
    })
    return { success: true, data }
  }
)

export const listVatSettlementsAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<VatSettlementRow[]>> => {
    const parsed = listVatSettlementsSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      listVatSettlements(tx, { period: parsed.data.period ?? undefined, liveOnly: parsed.data.liveOnly })
    )
    return { success: true, data: rows }
  }
)

/** La pestaña de prorrata: provisional, definitiva, términos y la guardia de O-12. */
export const prorrataAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<ProrrataView>> => {
    const parsed = closeProrrataYearSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { year } = parsed.data
    const data = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => prorrataViewFor(tx, year))
    return { success: true, data }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Liquidación (ADMIN) — recomputo en servidor antes de postear
// ─────────────────────────────────────────────────────────────────────────────

export const settleVatAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<SettleVatResult>> => {
    const parsed = settleVatSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { period, dryRun, expectedLedgerHash } = parsed.data

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const { start, end } = vatPeriodBounds(period)
      const lctx = await getLedgerContext(tx, end)
      const inputVatCode = lctx.map(IVA_KEYS.input) ?? "472"
      const outputVatCode = lctx.map(IVA_KEYS.output) ?? "477"

      // (1) Recomputo en servidor: el libro de AHORA, no el de la vista previa.
      const ledgerHash = await computeLedgerHash(tx, { from: start, to: end })
      if (expectedLedgerHash && expectedLedgerHash !== ledgerHash) {
        throw new Error(
          "El diario ha cambiado desde la vista previa: revise las cifras y vuelva a liquidar (la liquidación NO se ha posteado)"
        )
      }

      const { book, balances } = await readVatBook(tx, { period, inputVatCode, outputVatCode })
      const regimes = await readVatRegimePeriods(tx)
      const regime = vatRegimeAt(regimes, end)
      const blockers: ClosingStepResult[] = []

      // (2) O-11: si es el ÚLTIMO periodo del año, la prorrata tiene que estar
      // cerrada antes; su regularización se postea contra 472 ANTES de T-23.
      const year = Number(period.slice(0, 4))
      let prorrataAdjustmentCents = 0
      if (period === lastVatPeriodOfYear(year, (regime?.periodKind ?? "TRIMESTRAL") as VatPeriodKind)) {
        const prorrata = await getProrrataYear(tx, year)
        if (prorrata) {
          if (prorrata.closedAt === null) {
            blockers.push({
              step: "PRORRATA_DEFINITIVA",
              block: "Fiscal",
              status: "FAIL",
              blocking: true,
              evidencia: `La prorrata definitiva de ${year} no está cerrada: ciérrela antes de liquidar ${period} (O-11)`,
            })
          }
          prorrataAdjustmentCents = prorrata.adjustmentCents ?? 0
        }
        // (3) O-12: la guardia de bienes de inversión es BLOQUEANTE.
        const view = await prorrataViewFor(tx, year)
        if (view.capitalGoods.status === "FAIL") blockers.push(view.capitalGoods)
      }

      const built = vatSettlement({
        period,
        regime: (regime?.regime ?? "GENERAL") as IvaRegime,
        book,
        balance: balances[0],
        prorrataAdjustmentCents,
        capitalGoodsBlocking: blockers.length > 0,
        entryDate: end,
      })
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))

      const draftInput = built.value
      const entry = buildFromTemplate("REGULARIZACION_IVA", { ...draftInput, entryDate: end }, lctx)
      if (!entry.ok) throw new Error(formatLedgerErrors(entry.errors as never))

      const resultCents = draftInput.outputCents - draftInput.inputCents
      if (dryRun || blockers.length > 0) {
        return {
          period,
          dryRun: true,
          draft: entry.value,
          entryId: null,
          entryNumber: null,
          outputCents: draftInput.outputCents,
          inputCents: draftInput.inputCents,
          resultCents,
          ledgerHash,
          blockers,
        }
      }

      const posted = await postEntryTx(tx, entry.value, { userId: ctx.user.id })
      await createVatSettlementTx(
        tx,
        {
          periodKind: (regime?.periodKind ?? "TRIMESTRAL") as VatPeriodKind,
          period,
          periodStart: start,
          periodEnd: end,
          regime: (regime?.regime ?? "GENERAL") as IvaRegime,
          importDeferral: regime?.importDeferral ?? false,
          entryId: posted.id,
          outputCents: draftInput.outputCents,
          inputCents: draftInput.inputCents,
          resultCents,
          ledgerHash,
          bookHash: bookHashOf(book),
          gitSha: process.env.GIT_SHA ?? "desconocido",
        },
        { userId: ctx.user.id }
      )
      return {
        period,
        dryRun: false,
        draft: entry.value,
        entryId: posted.id,
        entryNumber: posted.entryNumber,
        outputCents: draftInput.outputCents,
        inputCents: draftInput.inputCents,
        resultCents,
        ledgerHash,
        blockers,
      }
    })

    if (result.ok && !result.value.dryRun) revalidatePath(VAT_PATH)
    return toActionState(result)
  }
)

/** Revertir es **contra-asiento** y libera B-6: el periodo vuelve a admitir IVA. */
export const reverseVatSettlementAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ period: string; reversalEntryId: string }>> => {
    const parsed = reverseVatSettlementSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data

    const live = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      listVatSettlements(tx, { period: v.period, liveOnly: true })
    )
    const settlement = live[0]
    if (!settlement) return { success: false, error: `No hay liquidación viva del periodo ${v.period}` }

    const voided = await voidEntry(ctx.org.id, settlement.entryId, v.reason, { userId: ctx.user.id })
    if (!voided.ok) return { success: false, error: formatLedgerErrors(voided.errors) }

    const noted = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await reverseVatSettlementTx(
        tx,
        { period: v.period, reversalEntryId: voided.value.reversal.id, reason: v.reason },
        { userId: ctx.user.id }
      )
      return { period: v.period, reversalEntryId: voided.value.reversal.id }
    })
    if (noted.ok) revalidatePath(VAT_PATH)
    return toActionState(noted)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Prorrata definitiva y RECC (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-10 / O-11.** Deriva numerador y denominador del libro de emitidas, calcula
 * la definitiva, postea la regularización **en el último periodo del año y antes
 * de su T-23**, y **fija la provisional de N+1** (art. 105.Dos, I-E9-10b).
 *
 * Con documentos **sin clasificar** no hay porcentaje: el resultado es `INFO`
 * con su lista y no se postea nada (criterio 14).
 */
export const closeProrrataYearAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<ProrrataView & { entryId: string | null }>> => {
    const parsed = closeProrrataYearSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { year, dryRun } = parsed.data

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const view = await prorrataViewFor(tx, year)
      if (view.terms.status === "INFO" || view.terms.definitiveBps === null) {
        throw new Error(
          `La prorrata de ${year} no se puede cerrar: ${view.terms.unclassified.length} documentos sin clave de operación ` +
            "(O-10). Clasifíquelos y vuelva a intentarlo; el motor no deduce ninguna clave"
        )
      }
      if (view.capitalGoods.status === "FAIL") throw new Error(view.capitalGoods.evidencia)
      if (view.provisionalBps === null) throw new Error(`No hay prorrata provisional declarada para ${year}`)

      const regimes = await readVatRegimePeriods(tx)
      const kind = (vatRegimeAt(regimes, `${year}-12-31`)?.periodKind ?? "TRIMESTRAL") as VatPeriodKind
      const period = lastVatPeriodOfYear(year, kind)
      const { end } = vatPeriodBounds(period)

      const reg = prorrataRegularization({
        prorrateableQuotaCents: view.prorrateableQuotaCents,
        provisionalBps: view.provisionalBps,
        definitiveBps: view.terms.definitiveBps,
      })
      if (dryRun) return { ...view, definitiveBps: view.terms.definitiveBps, adjustmentCents: reg.adjustmentCents, entryId: null }

      // La regularización de la prorrata NO tiene plantilla propia: son las dos
      // líneas de `prorrataRegularizationLines` (472/639 o 634/472, cuentas que
      // el PGC fija literalmente en la definición de la 634 y la 639). Se
      // resuelven por el mapa del plan y se postean como asiento de sistema con
      // el `ivaPeriod` del ÚLTIMO periodo del año (art. 105.Uno, O-11).
      const lctx = await getLedgerContext(tx, end)
      const fy = lctx.fiscalYears.find((f) => f.startDate <= end && end <= f.endDate)
      if (!fy) throw new Error(`No hay ejercicio abierto que contenga ${end}`)
      const lines = prorrataRegularizationLines(reg, year).map((l) => {
        const accountCode = l.accountKey ? lctx.map(l.accountKey) : null
        if (!accountCode) throw new Error(`La clave ${String(l.accountKey)} no está mapeada en el plan de la organización`)
        return { ...l, accountCode }
      })
      const draft: EntryDraft = {
        organizationId: ctx.org.id,
        fiscalYearId: fy.id,
        entryDate: end,
        description: `Regularización de la prorrata definitiva ${year} (art. 105 LIVA)`,
        kind: "NORMAL",
        sourceType: "SYSTEM",
        sourceId: `prorrata/${year}`,
        templateCode: "REGULARIZACION_IVA",
        taxRoundingMode: lctx.policy.taxRoundingMode,
        // `iva_period` lo deriva la columna generada de M5 desde las fechas del
        // asiento: fechándolo el último día del periodo cae donde el art. 105.Uno
        // exige, sin escribir a mano una columna que la base calcula.
        lines,
      }
      const posted = await postEntryTx(tx, draft, { userId: ctx.user.id })

      await closeProrrataYearTx(
        tx,
        {
          year,
          definitiveBps: view.terms.definitiveBps,
          numeratorCents: view.terms.numeratorCents,
          denominatorCents: view.terms.denominatorCents,
          prorrateableQuotaCents: view.prorrateableQuotaCents,
          unclassifiedCount: view.terms.unclassified.length,
          adjustmentCents: reg.adjustmentCents,
          regularizationEntryId: posted.id,
          regularizationPeriod: period,
        },
        { userId: ctx.user.id }
      )
      return { ...view, definitiveBps: view.terms.definitiveBps, adjustmentCents: reg.adjustmentCents, entryId: posted.id }
    })

    if (result.ok && !dryRun) revalidatePath(VAT_PATH)
    return toActionState(result)
  }
)

/** **T-36.** Barrido del 31/12 del art. 163 *terdecies*: devengo, no aviso. */
export const reccYearEndAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ year: number; entryId: string | null; lines: number; dryRun: boolean }>> => {
    const parsed = reccYearEndSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { year, dryRun } = parsed.data
    const cutoff: LocalDate = `${year}-12-31`

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const pending = await readReccAccruals(tx, { cutoff })
      const sweep = reccYearEndSweep(
        pending.map((p) => ({
          id: p.transactionId,
          side: "EMITIDA" as const,
          documentNumber: p.documentNumber,
          operationDate: p.operationDate,
          totalQuotaCents: p.totalQuotaCents,
          accruedCents: p.accruedCents,
        })),
        cutoff
      )
      if (sweep.length === 0) return { year, entryId: null, lines: 0, dryRun }
      if (dryRun) return { year, entryId: null, lines: sweep.length, dryRun: true }

      const lctx = await getLedgerContext(tx, cutoff)
      const built = buildFromTemplate(
        "DEVENGO_RECC",
        {
          cutoff,
          entryDate: cutoff,
          pending: pending
            .filter((p) => p.totalQuotaCents - p.accruedCents > 0)
            .map((p) => ({
              id: p.transactionId,
              side: "EMITIDA" as const,
              documentNumber: p.documentNumber,
              operationDate: p.operationDate,
              totalQuotaCents: p.totalQuotaCents,
              accruedCents: p.accruedCents,
            })),
        },
        lctx
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))
      const posted = await postEntryTx(tx, built.value, { userId: ctx.user.id })
      return { year, entryId: posted.id, lines: sweep.length, dryRun: false }
    })

    if (result.ok && !dryRun) revalidatePath(VAT_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Régimen y prorrata provisional (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export const createVatRegimePeriodAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ validFrom: LocalDate }>> => {
    const parsed = createVatRegimePeriodSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await createVatRegimePeriodTx(tx, { ...v, validTo: v.validTo ?? null }, { userId: ctx.user.id })
      return { validFrom: v.validFrom }
    })
    if (result.ok) revalidatePath(VAT_PATH)
    return toActionState(result)
  }
)

export const setProvisionalProrrataAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ year: number; provisionalBps: number }>> => {
    const parsed = setProvisionalProrrataSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const existing = await tx.prorrataYear.findFirst({ where: { year: v.year } })
      if (existing?.closedAt) {
        throw new Error(`La prorrata de ${v.year} ya está cerrada: rectificarla es un contra-asiento de la regularización`)
      }
      if (existing) {
        await tx.prorrataYear.update({ where: { id: existing.id }, data: { provisionalBps: v.provisionalBps } })
      } else {
        await tx.prorrataYear.create({
          data: { organizationId: ctx.org.id, year: v.year, provisionalBps: v.provisionalBps },
        })
      }
      return { year: v.year, provisionalBps: v.provisionalBps }
    })
    if (result.ok) revalidatePath(VAT_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

/** La vista de prorrata del año, **derivada**: aquí no se teclea un porcentaje. */
async function prorrataViewFor(
  tx: Parameters<typeof readVatBook>[0],
  year: number
): Promise<ProrrataView> {
  const cutoff: LocalDate = `${year}-12-31`
  const lctx = await getLedgerContext(tx, cutoff)
  const { book } = await readVatBook(tx, {
    year,
    inputVatCode: lctx.map(IVA_KEYS.input) ?? "472",
    outputVatCode: lctx.map(IVA_KEYS.output) ?? "477",
  })
  const terms = prorrataTerms(book, year)
  const quota = prorrateableQuotaCents(book, year)
  const stored = await getProrrataYear(tx, year)

  const goods = await readCapitalGoodRefs(tx, { from: `${year - 9}-01-01`, to: cutoff })
  const years: { year: number; bps: number }[] = []
  for (let y = year - 9; y <= year; y++) {
    const row = await getProrrataYear(tx, y)
    const bps = row?.definitiveBps ?? (y === year ? terms.definitiveBps : null)
    if (bps !== null) years.push({ year: y, bps })
  }
  const capitalGoods = capitalGoodsGuard({
    year,
    prorrataByYear: years,
    assets: goods,
  })

  return {
    year,
    provisionalBps: stored?.provisionalBps ?? null,
    definitiveBps: stored?.definitiveBps ?? terms.definitiveBps,
    terms,
    prorrateableQuotaCents: quota,
    adjustmentCents: stored?.adjustmentCents ?? null,
    capitalGoods,
    closedAt: stored?.closedAt ?? null,
  }
}

export { prorrataDefinitivaBps, todayLocalDate }
