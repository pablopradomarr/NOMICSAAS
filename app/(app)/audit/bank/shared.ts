import "server-only"

import type { BankAccountView, PendingView, SummaryView } from "@/components/bank/types"
import { badgeForFigure, explainPending } from "@/lib/audit/confidence"
import type { BankReconciliationSummary, PendingItem } from "@/lib/audit/invariants-e7"
import type { BankAccountRow } from "@/models/bank"

/**
 * E7 · T16 — Conversión al modelo de vista de la conciliación.
 *
 * Aquí no se calcula ningún cuadre: `reconciliationSummary()` ya lo hizo —la
 * MISMA derivación que usa I-E7-1— y lo único que se añade es, por cada
 * pendiente, si está **explicado** según el criterio verificable de §3.6
 * (`explainPending`, motor puro). Enumerar un pendiente no lo explica: eso sería
 * conceder el sello por enumeración.
 */

export const toAccountView = (account: BankAccountRow): BankAccountView => ({
  id: account.id,
  code: account.code,
  name: account.name,
  accountCode: account.accountCode,
  currency: account.currency,
  iban: account.iban,
  isActive: account.isActive,
  matchToleranceDays: account.matchToleranceDays,
  transitWarnDays: account.transitWarnDays,
  anchorDate: account.reconciledFromDate,
  anchorBalanceCents: account.reconciledOpeningBalanceCents,
  hasCsvMapping: account.csvMapping !== null && account.csvMapping !== undefined,
})

const toPendingView = (
  item: PendingItem,
  transitWarnDays: number,
  resolvedLaterIds: ReadonlySet<string>
): PendingView => {
  const explained = explainPending(item, { transitWarnDays, resolvedLaterIds })
  return {
    side: item.side,
    id: item.id,
    date: item.date,
    amountCents: item.amountCents,
    kind: item.kind,
    ageDays: item.ageDays,
    description: item.description,
    explicado: explained.explicado,
    motivo: explained.motivo,
  }
}

/**
 * `invariantsPass` es «¿han pasado los invariantes del diario que sostienen la
 * cifra?». Se responde con el último barrido sellado: sin barrido, la respuesta
 * honesta es **no** —y el badge se queda en `calculado`—, porque nadie ha
 * comprobado nada todavía.
 */
export function toSummaryView(
  summary: BankReconciliationSummary,
  account: BankAccountRow,
  opts: { invariantsPass: boolean }
): SummaryView {
  /**
   * **H-5.** `resolvedLaterIds` sale del propio cuadre: son los pendientes que
   * un grupo vivo **a caballo del corte** ya recoge —el cheque de diciembre
   * punteado contra su cargo de enero—. La ronda 1 pasaba aquí un `new Set()`
   * fijo, de modo que los criterios 1 y 2 de «explicado» (§3.6) eran código
   * muerto y la pantalla llamaba «sin explicar» a pendientes que sí lo estaban.
   */
  const resolvedLaterIds = new Set(summary.resolvedLaterIds)
  const badge = badgeForFigure({
    accountCodes: [summary.accountCode],
    bankAccounts: [account],
    summaries: [summary],
    invariantsPass: opts.invariantsPass,
    resolvedLaterIds: summary.resolvedLaterIds,
  }).badge

  return {
    bankAccountId: summary.bankAccountId,
    accountCode: summary.accountCode,
    currency: summary.currency,
    cutoff: summary.cutoff,
    anchored: summary.anchored,
    chainCovered: summary.chain.covered,
    chainGaps: summary.chain.gaps.map((gap) => ({ from: gap.from, to: gap.to })),
    saldoExtractoCents: summary.saldoExtracto,
    saldoContableCents: summary.saldoContable,
    ueCents: summary.ue,
    ubCents: summary.ub,
    diferenciaCents: summary.diferencia,
    pendientesBanco: summary.pendientesBanco.map((item) => toPendingView(item, account.transitWarnDays, resolvedLaterIds)),
    pendientesLibros: summary.pendientesLibros.map((item) => toPendingView(item, account.transitWarnDays, resolvedLaterIds)),
    ignoradosCents: summary.ignoradosCents,
    ignoradosCount: summary.ignoradosCount,
    importeCeroCount: summary.importeCeroCount,
    pendientesAntiguosCount: summary.pendientesAntiguos.length,
    regularizationLineIds: summary.regularizationLineIds,
    evaluable: summary.evaluable,
    motivoNoEvaluable: summary.motivoNoEvaluable,
    badge,
    // H-3: la mide el motor con la tasa de cierre; la pantalla sólo la enseña.
    diferenciaDeCambioCents: summary.fxDifferenceCents,
  }
}
