/**
 * E6 · T11 — Panel reescrito **sobre el libro diario** (cierra G-05 y G-06).
 *
 * El panel heredado de TaxHacker sumaba `Transaction.total` por moneda, pintaba
 * `NaN %` cuando no había base y contaba como 0 los documentos sin contabilizar.
 * Aquí no hay ninguna cifra que no salga del diario, ningún porcentaje sin base
 * se pinta como número, y los documentos sin asiento **se declaran**, no se
 * suman como cero.
 *
 * Todos los KPI salen de los MISMOS motores que los informes: ingresos y
 * resultado de `buildPyg`, tesorería de `buildCashflowDirect`, EBITDA de la
 * definición única de §8.5. Un panel con su propia aritmética es cómo nacen los
 * dos EBITDA que no cuadran (I-E6-19 lo comprueba).
 *
 * Módulo PURO: `refDate` entra por parámetro.
 */

import type { Cents, LocalDate } from "@/lib/ledger/types"
import { cellProvenance, type Provenance } from "@/lib/ledger/provenance"
import { buildAging, type AgingReport } from "@/lib/ledger/reports/aging"
import { buildCashflowDirect } from "@/lib/ledger/reports/cashflow"
import { buildPyg } from "@/lib/ledger/reports/pyg"
import {
  buildAccountIndex,
  isCashAccount,
  type AccountIndex,
  type PgcVariant,
  type ProvenanceContext,
  type ReportLine,
  type ReportPeriod,
  type StatementAccount,
} from "@/lib/ledger/reports/types"

export type DashboardParams = ReportPeriod & {
  variant: PgcVariant
  /** «Hoy» del panel: decide el aging. Va en `params` y por tanto en `paramsHash`. */
  refDate: LocalDate
  /** Prefijos de las cuentas a envejecer. Por defecto clientes y proveedores. */
  receivablePrefixes?: readonly string[]
  payablePrefixes?: readonly string[]
  incomeTaxAccountCodes?: readonly string[]
  /**
   * G-06: documentos subidos que TODAVÍA no tienen asiento. No se suman a nada;
   * se declaran. Lo cuenta `models/transactions.ts` y entra por parámetro para
   * que el motor siga siendo puro.
   */
  unpostedDocumentCount?: number
}

export type DashboardKpi = {
  key: string
  label: string
  cents: Cents
  /** `null` cuando no hay base: la UI pinta «—», jamás `NaN` ni `0 %` (G-05). */
  previousCents: Cents | null
  deltaBps: number | null
  provenance?: Provenance
}

export type MonthlySeriesPoint = {
  month: string
  ingresosCents: Cents
  gastosCents: Cents
  resultadoCents: Cents
  tesoreriaCents: Cents
}

export type DashboardReport = {
  refDate: LocalDate
  kpis: DashboardKpi[]
  aging: { clientes: AgingReport; proveedores: AgingReport }
  monthly: MonthlySeriesPoint[]
  /** G-06: se declara, no se suma como cero. */
  unposted: { count: number; note: string } | null
  notes: readonly string[]
}

export const UNPOSTED_NOTE = (n: number): string =>
  `${n} documento(s) sin asiento: no entran en ninguna cifra de este panel.`

const DEFAULT_RECEIVABLE_PREFIXES = ["430", "431", "432", "435", "436"] as const
const DEFAULT_PAYABLE_PREFIXES = ["400", "401", "403", "404", "410"] as const

export function buildDashboard(
  lines: readonly ReportLine[],
  accounts: readonly StatementAccount[] | AccountIndex,
  params: DashboardParams,
  ctx?: ProvenanceContext,
  comparative?: { lines: readonly ReportLine[]; label: string }
): DashboardReport {
  const index = "byCode" in accounts ? (accounts as AccountIndex) : buildAccountIndex(accounts as StatementAccount[])

  const pygParams = {
    organizationId: params.organizationId,
    from: params.from,
    to: params.to,
    baseCurrency: params.baseCurrency,
    variant: params.variant,
    ...(params.fiscalYearId ? { fiscalYearId: params.fiscalYearId } : {}),
  }
  const pyg = buildPyg(lines, index, pygParams)
  const cashflow = buildCashflowDirect(lines, index, {
    ...pygParams,
    ...(params.incomeTaxAccountCodes ? { incomeTaxAccountCodes: params.incomeTaxAccountCodes } : {}),
  })

  const previousPyg = comparative ? buildPyg(comparative.lines, index, pygParams) : null
  const previousCash = comparative
    ? buildCashflowDirect(comparative.lines, index, pygParams).closingCashCents
    : null

  // Epígrafe 1 = INCN, la misma cifra que la PyG. No se recalcula aquí.
  const incn = pyg.byEpigraphNumberCents["1"] ?? 0
  const previousIncn = previousPyg ? (previousPyg.byEpigraphNumberCents["1"] ?? 0) : null

  const kpi = (key: string, label: string, cents: Cents, previousCents: Cents | null, metric: string): DashboardKpi => {
    const row: DashboardKpi = {
      key,
      label,
      cents,
      previousCents,
      // G-05: sin base, `null`. La UI lo pinta «—»; un 0 % afirmaría algo falso.
      deltaBps: previousCents === null || previousCents === 0 ? null : Math.round(((cents - previousCents) * 10_000) / Math.abs(previousCents)),
    }
    if (ctx) {
      row.provenance = cellProvenance(
        metric,
        cents,
        { organizationId: params.organizationId, from: params.from, to: params.to },
        ctx
      )
    }
    return row
  }

  const kpis: DashboardKpi[] = [
    kpi("ingresos", "Ingresos (INCN)", incn, previousIncn, "dashboard.ingresos"),
    kpi("ebitda", "EBITDA", pyg.ebitdaCents, previousPyg?.ebitdaCents ?? null, "dashboard.ebitda"),
    kpi("resultado", "Resultado del ejercicio", pyg.resultadoDelEjercicioCents, previousPyg?.resultadoDelEjercicioCents ?? null, "dashboard.resultado"),
    kpi("tesoreria", "Tesorería", cashflow.closingCashCents, previousCash, "dashboard.tesoreria"),
  ]

  // El aging se calcula sobre el ejercicio y **sin el asiento de cierre**: tras
  // el `CLOSING` la 4300 queda a cero, pero el cliente sigue debiendo el dinero.
  // Envejecer el diario cerrado daría una cartera vacía el 31 de diciembre.
  const agingLines = lines.filter(
    (l) =>
      (params.fiscalYearId === undefined || l.fiscalYearId === params.fiscalYearId) &&
      l.entryKind !== "CLOSING" &&
      l.entryKind !== "REGULARIZATION"
  )
  const aging = {
    clientes: buildAging(agingLines, {
      refDate: params.refDate,
      accountPrefixes: params.receivablePrefixes ?? DEFAULT_RECEIVABLE_PREFIXES,
      naturalSide: "DEUDOR",
    }),
    proveedores: buildAging(agingLines, {
      refDate: params.refDate,
      accountPrefixes: params.payablePrefixes ?? DEFAULT_PAYABLE_PREFIXES,
      naturalSide: "ACREEDOR",
    }),
  }

  return {
    refDate: params.refDate,
    kpis,
    aging,
    monthly: monthlySeries(lines, index, params, cashflow.openingCashCents),
    unposted:
      params.unpostedDocumentCount && params.unpostedDocumentCount > 0
        ? { count: params.unpostedDocumentCount, note: UNPOSTED_NOTE(params.unpostedDocumentCount) }
        : null,
    notes: [cashflow.header],
  }
}

/**
 * Series mensuales. Los meses **sin movimiento se imprimen con ceros**: un
 * gráfico con meses ausentes es indistinguible de uno truncado.
 */
function monthlySeries(
  lines: readonly ReportLine[],
  index: AccountIndex,
  params: DashboardParams,
  openingCash: Cents
): MonthlySeriesPoint[] {
  const inScope = (l: ReportLine): boolean =>
    (params.fiscalYearId === undefined || l.fiscalYearId === params.fiscalYearId) &&
    l.entryDate >= params.from &&
    l.entryDate <= params.to

  const months = monthsBetween(params.from, params.to)
  const ingresos = new Map<string, Cents>()
  const gastos = new Map<string, Cents>()
  const cash = new Map<string, Cents>()

  for (const l of lines) {
    if (!inScope(l)) continue
    const month = l.entryDate.slice(0, 7)
    if (isCashAccount(l.accountCode) && l.entryKind !== "OPENING" && l.entryKind !== "CLOSING") {
      cash.set(month, (cash.get(month) ?? 0) + l.debitCents - l.creditCents)
    }
    if (index.statementOf(l.accountCode) !== "PYG") continue
    if (l.entryKind === "OPENING" || l.entryKind === "CLOSING" || l.entryKind === "REGULARIZATION") continue
    const aporte = l.creditCents - l.debitCents
    if (l.accountCode.startsWith("7")) ingresos.set(month, (ingresos.get(month) ?? 0) + aporte)
    else gastos.set(month, (gastos.get(month) ?? 0) + aporte)
  }

  let running = openingCash
  return months.map((month) => {
    running += cash.get(month) ?? 0
    const i = ingresos.get(month) ?? 0
    const g = gastos.get(month) ?? 0
    return { month, ingresosCents: i, gastosCents: g, resultadoCents: i + g, tesoreriaCents: running }
  })
}

/** Meses `YYYY-MM` del rango, ambos incluidos. Aritmética entera, sin `Date`. */
export function monthsBetween(from: LocalDate, to: LocalDate): string[] {
  const out: string[] = []
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))]
  // Cota dura: un rango absurdo no debe colgar el proceso.
  for (let guard = 0; guard < 1_200 && (y < ty || (y === ty && m <= tm)); guard++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}
