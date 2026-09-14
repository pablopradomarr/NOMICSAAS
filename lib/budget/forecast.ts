/**
 * E10 · T8 — La reproyección (`docs/design/E10-presupuesto-horas.md` §3.4).
 *
 * Módulo PURO y ENTERO. `forecast(m) = real(m)` si `m ≤ cutoff`,
 * `presupuesto(m)` si `m > cutoff`. Nada más, y por eso es auditable.
 */

import type { ColumnKey } from "@/lib/analytics/types"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import type { BudgetMatrix } from "@/lib/budget/matrix"
import type { Cents } from "@/lib/budget/types"

export type ForecastSource = "REAL_CERRADO" | "PRESUPUESTO_ABIERTO"

export type ForecastMonth = {
  source: ForecastSource
  /** Versión de presupuesto de la que sale el mes; `null` si el mes es real. */
  provenanceBudget: string | null
  /** APORTE del mes (no cumulativo), denso. */
  contributionCents: Record<string, Record<string, Cents>>
}

export type ForecastMatrix = {
  cutoffMonth: string | null
  months: readonly string[]
  columns: readonly ColumnKey[]
  byMonth: Record<string, ForecastMonth>
  provenanceByMonth: Record<string, ForecastSource>
  /** Cumulativa del ejercicio reproyectado. */
  matrixCents: Record<string, Record<string, Cents>>
  levelTotalsCents: Record<string, Cents>
  levelTotalsBig: Record<string, bigint>
}

/** Matriz mensual CUMULATIVA, tal y como la devuelven E4 y `buildBudgetMatrix`. */
export type MonthlyCumulative = Record<string, Record<string, Record<string, Cents>>>

const emptyDense = (columns: readonly ColumnKey[]): Record<string, Cents> => {
  const row: Record<string, Cents> = {}
  for (const column of columns) row[column] = 0
  return row
}

/**
 * Cumulativa → aporte. La acumulación por nivel es una biyección, así que el
 * llamante puede pasar la matriz que ya tiene y no una segunda representación
 * que podría quedar desincronizada de la primera.
 */
export function decumulate(
  cumulative: Record<string, Record<string, Cents>> | undefined,
  columns: readonly ColumnKey[]
): Record<string, Record<string, Cents>> {
  const out: Record<string, Record<string, Cents>> = {}
  let previous = emptyDense(columns)
  for (const level of MARGIN_LEVELS) {
    const current: Record<string, Cents> = {}
    const row: Record<string, Cents> = {}
    for (const column of columns) {
      const value = cumulative?.[level]?.[column] ?? 0
      current[column] = value
      row[column] = value - previous[column]
    }
    out[level] = row
    previous = current
  }
  return out
}

/** Aporte → cumulativa. */
export function cumulateContribution(
  contribution: Record<string, Record<string, Cents>>,
  columns: readonly ColumnKey[]
): Record<string, Record<string, Cents>> {
  const running = emptyDense(columns)
  const out: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) {
    for (const column of columns) running[column] += contribution[level]?.[column] ?? 0
    out[level] = { ...running }
  }
  return out
}

export type BuildForecastInput = {
  /** Matriz CUMULATIVA del REAL por mes `YYYY-MM`. */
  actualByMonth: MonthlyCumulative
  budget: BudgetMatrix
  fiscalYearMonths: readonly string[]
  /**
   * Último mes CERRADO, `YYYY-MM`. Lo decide el borde —el mayor mes con
   * `PeriodLock` del ejercicio, o el fin del ejercicio si está `CLOSED`— y viaja
   * como parámetro, de modo que entra en `paramsHash` y dos ejecuciones del
   * mismo informe con el mismo corte dan el mismo resultado (P7).
   * `null` = ningún mes cerrado ⇒ todo presupuesto.
   */
  cutoffMonth: string | null
  /** Etiqueta de la versión de presupuesto que cubre cada mes (O-E10-9). */
  budgetProvenanceByMonth?: Record<string, string>
}

/**
 * **I-E10-7**: cada mes del ejercicio aparece EXACTAMENTE una vez y con UNA sola
 * procedencia. Ni solape —un mes contado dos veces infla el año— ni hueco —un
 * mes ausente lo desinfla—, y las dos cosas son invisibles en el total si nadie
 * las comprueba.
 */
export function buildForecast(input: BuildForecastInput): ForecastMatrix {
  const { budget, cutoffMonth } = input
  const columns = budget.columns
  const months = [...input.fiscalYearMonths]

  const byMonth: Record<string, ForecastMonth> = {}
  const provenanceByMonth: Record<string, ForecastSource> = {}
  const totals: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) totals[level] = emptyDense(columns)

  for (const month of months) {
    const source: ForecastSource =
      cutoffMonth !== null && month <= cutoffMonth ? "REAL_CERRADO" : "PRESUPUESTO_ABIERTO"
    const cumulative = source === "REAL_CERRADO" ? input.actualByMonth[month] : budget.byMonth[month]
    const contributionCents = decumulate(cumulative, columns)
    byMonth[month] = {
      source,
      provenanceBudget:
        source === "REAL_CERRADO" ? null : (input.budgetProvenanceByMonth?.[month] ?? null),
      contributionCents,
    }
    provenanceByMonth[month] = source
    for (const level of MARGIN_LEVELS) {
      for (const column of columns) totals[level][column] += contributionCents[level][column]
    }
  }

  const matrixCents = cumulateContribution(totals, columns)
  const levelTotalsCents: Record<string, Cents> = {}
  const levelTotalsBig: Record<string, bigint> = {}
  for (const level of MARGIN_LEVELS) {
    let total = 0
    let big = BigInt(0)
    for (const column of columns) {
      total += matrixCents[level][column]
      big += BigInt(matrixCents[level][column])
    }
    levelTotalsCents[level] = total
    levelTotalsBig[level] = big
  }

  return { cutoffMonth, months, columns, byMonth, provenanceByMonth, matrixCents, levelTotalsCents, levelTotalsBig }
}

/**
 * **I-E10-7** hecha comprobación: los meses del forecast son EXACTAMENTE los del
 * ejercicio, sin repetición ni ausencia, y cada uno con una sola procedencia.
 */
export function forecastCoversFiscalYear(
  forecast: ForecastMatrix,
  fiscalYearMonths: readonly string[]
): { ok: boolean; missing: string[]; extra: string[] } {
  const covered = Object.keys(forecast.byMonth)
  const wanted = new Set(fiscalYearMonths)
  const missing = fiscalYearMonths.filter((m) => forecast.byMonth[m] === undefined)
  const extra = covered.filter((m) => !wanted.has(m))
  return { ok: missing.length === 0 && extra.length === 0 && covered.length === fiscalYearMonths.length, missing, extra }
}
