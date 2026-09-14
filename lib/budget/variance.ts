/**
 * E10 · T8 — Desviaciones presupuesto ↔ real
 * (`docs/design/E10-presupuesto-horas.md` §3.3).
 *
 * Módulo PURO y ENTERO. `desviación = real − presupuesto`, resta y nada más:
 * un porcentaje redondeado no mueve ni un céntimo del importe (criterio 3).
 */

import type { ColumnKey, MarginLevel } from "@/lib/analytics/types"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import type { BudgetAllocationState, BudgetMatrix } from "@/lib/budget/matrix"
import type { ForecastMatrix } from "@/lib/budget/forecast"
import type { Cents } from "@/lib/budget/types"

/**
 * Lo mínimo que la matriz del REAL aporta a la comparación. `AnalyticPnl` lo
 * satisface tal cual, y por eso no hay conversión ni copia por medio.
 */
export type ActualMatrix = {
  matrixCents: Record<string, Record<string, Cents>>
  columns: readonly ColumnKey[]
}

export type VarianceCell = {
  level: MarginLevel
  column: ColumnKey
  /** `null` = la celda es del acumulado del periodo, no de un mes. */
  month: string | null
  actualCents: Cents
  /** `null` = sin presupuesto para la celda, o celda no comparable. */
  budgetCents: Cents | null
  /** `real − presupuesto`, EXACTO (I-E10-2). */
  varianceCents: Cents | null
  /** Puntos básicos ENTEROS; `null` si el presupuesto es 0. */
  varianceBps: number | null
  forecastCents: Cents | null
  /**
   * **O-E10-4 / I-E10-18.** `true` cuando la celda NO se publica porque el
   * presupuesto y el real están en estados de imputación distintos: las tres
   * columnas derivadas salen `null` y la UI imprime la leyenda, en vez de
   * calcular una desviación que no significa nada.
   */
  notComparable: boolean
}

/** El primer nivel que la liquidación de estructura puede mover. */
export const FIRST_ALLOCATED_LEVEL: MarginLevel = "MC3"

const levelIndex = (level: MarginLevel): number => MARGIN_LEVELS.indexOf(level)

/** ¿La columna es de una dimensión concreta, y no un agregado de la compañía? */
export const isDimensionColumn = (column: ColumnKey): boolean =>
  column.startsWith("PROJ:") || column.startsWith("BL:") || column.startsWith("CECO:")

/**
 * `varianceBps = ⌊|real − ppto| · 10000 / |ppto|⌋` **con signo**, en ENTERO.
 *
 * Con presupuesto 0 devuelve `null` y decide el umbral absoluto: es la misma
 * regla que `deltaBps` de `lib/ledger/report-run.ts`. Ni `Float`, ni `NaN`, ni
 * `Infinity`, que es lo que sale de dividir por cero en coma flotante y lo que
 * después se imprime en un comité.
 */
export function varianceBps(actualCents: Cents, budgetCents: Cents): number | null {
  if (budgetCents === 0) return null
  const delta = actualCents - budgetCents
  const magnitude = Math.floor((Math.abs(delta) * 10000) / Math.abs(budgetCents))
  return delta < 0 ? -magnitude : magnitude
}

export type BuildVarianceInput = {
  actual: ActualMatrix
  budget: BudgetMatrix
  forecast?: ForecastMatrix | null
  actualAllocationState: BudgetAllocationState
  /** Etiqueta del mes cuando la matriz es mensual; `null` para el acumulado. */
  month?: string | null
}

/**
 * Celdas de desviación de una matriz contra otra.
 *
 * **Regla de comparabilidad (I-E10-18)**: si `budget.allocationState` y el
 * estado del real no coinciden, toda celda **por dimensión** de nivel ≥ MC3 sale
 * con `notComparable = true`. Las de INGRESOS, MC1 y MC2 sí se publican —la
 * liquidación no las toca— y el **total compañía** también, porque ahí la
 * imputación es de suma cero (E5-D1).
 *
 * Sin presupuesto, las tres columnas derivadas son `null`: **nunca 0**, que es
 * una cifra y afirmaría algo falso (misma regla que el comparativo de ADR-0012).
 */
export function buildVariance(input: BuildVarianceInput): readonly VarianceCell[] {
  const { actual, budget, forecast, actualAllocationState } = input
  const month = input.month ?? null
  const comparable = actualAllocationState === budget.allocationState
  const cells: VarianceCell[] = []

  for (const level of MARGIN_LEVELS) {
    for (const column of budget.columns) {
      const actualCents = actual.matrixCents[level]?.[column] ?? 0
      const plannedCents = budget.cumulativeCents[level]?.[column] ?? 0
      if (actualCents === 0 && plannedCents === 0) continue
      const notComparable =
        !comparable && isDimensionColumn(column) && levelIndex(level) >= levelIndex(FIRST_ALLOCATED_LEVEL)
      const forecastCents = forecast ? (forecast.matrixCents[level]?.[column] ?? 0) : null
      cells.push({
        level,
        column,
        month,
        actualCents,
        budgetCents: notComparable ? null : plannedCents,
        varianceCents: notComparable ? null : actualCents - plannedCents,
        varianceBps: notComparable ? null : varianceBps(actualCents, plannedCents),
        forecastCents: notComparable ? null : forecastCents,
        notComparable,
      })
    }
  }
  return cells
}

/** Cuántas celdas se publican y cuántas no (la leyenda de la pantalla). */
export function varianceCoverage(cells: readonly VarianceCell[]): {
  publishedCells: number
  notComparableCells: number
} {
  const notComparableCells = cells.filter((c) => c.notComparable).length
  return { publishedCells: cells.length - notComparableCells, notComparableCells }
}

/**
 * **O-E10-18** — la desviación por dimensión más grande del nivel, en valor
 * absoluto. El total compañía puede dar 0 c y 0 bps con dos proyectos
 * descontrolados que se compensan; sin esto, el informe se firmaba en verde.
 */
export function maxDimensionVariance(
  cells: readonly VarianceCell[],
  level: MarginLevel
): { column: ColumnKey; varianceCents: Cents; varianceBps: number | null } | null {
  let best: { column: ColumnKey; varianceCents: Cents; varianceBps: number | null } | null = null
  for (const cell of cells) {
    if (cell.level !== level || cell.notComparable || cell.varianceCents === null) continue
    if (!isDimensionColumn(cell.column)) continue
    if (best === null || Math.abs(cell.varianceCents) > Math.abs(best.varianceCents)) {
      best = { column: cell.column, varianceCents: cell.varianceCents, varianceBps: cell.varianceBps }
    }
  }
  return best
}

/**
 * **Q-6 / D6 — descomposición volumen / precio. Convención CONGELADA; la
 * implementación es de E11.** Se escribe aquí para que las columnas no cambien
 * de significado cuando llegue:
 *
 *   Δ total   = P_r·Q_r − P_p·Q_p
 *   Δ volumen = ⌊ (Q_r − Q_p) × Importe_ppto / Q_p ⌋      (Q_p = 0 ⇒ todo volumen)
 *   Δ precio  = Δ total − Δ volumen                        ← RESIDUO ⇒ Σ exacta
 *
 * El **cruce va al precio**: el efecto volumen se mide a condiciones del plan
 * —lo único que controla producción— y el efecto precio sobre la actividad
 * realmente ejecutada. Un tercer término «cruce» es honesto e inservible en un
 * comité: nadie tiene responsabilidad sobre él. El precio unitario **no se
 * almacena** y `importe / horas` no es exacto, de ahí el residuo. **No se
 * descompone el efecto mezcla**: exige una jerarquía de producto que el modelo
 * no tiene, y mejor no publicarlo que publicarlo mal.
 */
export const VOLUME_PRICE_CONVENTION = "E11" as const
