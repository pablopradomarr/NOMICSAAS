/**
 * E10 · T7 — El presupuesto en la matriz de E4
 * (`docs/design/E10-presupuesto-horas.md` §3.2).
 *
 * Módulo PURO. **Reutiliza** `resolveDestination` / `resolveColumn` de
 * `lib/analytics/margins.ts`: la columna la fija el tipo efectivo (R-A5), el
 * nivel de un `INDIRECTO_CECO` lo fija `CostCenter.marginLevel` (R-A6/R-A7) y
 * `NO_ANALITICO` se parte por `nonAnalyticLevel` (R-A11). Reimplementar esas
 * tres reglas aquí sería garantizar que las dos matrices divergen el día que
 * alguien toque una regla de destino, y una desviación distinta de cero sin que
 * nada hubiera cambiado.
 */

import { resolveDestination } from "@/lib/analytics/margins"
import type { AnalyticLine, AnalyticsConfig, ColumnKey, MarginLevel } from "@/lib/analytics/types"
import {
  businessLineColumn,
  cecoColumn,
  COST_CENTER_KINDS,
  MARGIN_LEVELS,
  projectColumn,
  type CostCenterKind,
} from "@/lib/analytics/types"
import type {
  BudgetCell,
  BudgetVersion,
  Cents,
  DateWindow,
  UnresolvedBudgetCell,
} from "@/lib/budget/types"
import { monthKey } from "@/lib/budget/types"

/** Estado de imputación de una matriz: en bruto o pasada por la liquidación. */
export type BudgetAllocationState = "NONE" | "SETTLED"

export type BudgetMatrix = {
  levels: readonly MarginLevel[]
  columns: readonly ColumnKey[]
  businessLineCodes: readonly string[]
  /** `M[nivel][columna]` CUMULATIVA, exactamente como `buildAnalyticPnl`. */
  cumulativeCents: Record<string, Record<string, Cents>>
  /** No cumulativo y DENSO, para poder restar dos matrices sin casos especiales. */
  contributionByLevelCents: Record<string, Record<string, Cents>>
  levelTotalsCents: Record<string, Cents>
  /** Los mismos totales en `BigInt`, para agregados por encima de 2⁵³. */
  levelTotalsBig: Record<string, bigint>
  /** Cumulativa por mes `YYYY-MM`. */
  byMonth: Record<string, Record<string, Record<string, Cents>>>
  /** Agregado de PRESENTACIÓN por línea de negocio: `[nivel][código]`. No suma. */
  businessLineMatrixCents: Record<string, Record<string, Cents>>
  /** Celdas que no se pudieron situar. Alimentan I-E10-1 y salen en pantalla. */
  unresolved: readonly UnresolvedBudgetCell[]
  /** Número de celdas de importe que entraron en la matriz. */
  cellCount: number
  months: readonly string[]
  /** **O-E10-4** — `NONE` = presupuesto en bruto; `SETTLED` = ya liquidado. */
  allocationState: BudgetAllocationState
  /** `rulesHash` de la liquidación presupuestaria; `null` con `NONE`. */
  budgetRulesHash: string | null
  /** Avisos de la liquidación presupuestaria, etiquetados como del presupuesto. */
  settlementWarnings: readonly BudgetSettlementWarning[]
}

/** Aviso de la liquidación presupuestaria: el del motor + su etiqueta. */
export type BudgetSettlementWarning = {
  scope: "PRESUPUESTO"
  code: string
  ruleCode: string
  period: string
  detail: string
}

/** Columnas de la matriz, en el orden del JSON sellado. */
export function budgetColumns(config: AnalyticsConfig): ColumnKey[] {
  return [
    ...config.projects.map((p) => projectColumn(p.code)),
    // Las columnas `BL:` existen SIEMPRE en el presupuesto: una liquidación
    // presupuestaria puede depositar importe en ellas (E5-D3) y una matriz que
    // cambiase de columnas según el toggle no se podría restar con la del real.
    ...config.businessLines.map((b) => businessLineColumn(b.code)),
    ...COST_CENTER_KINDS.map((k) => cecoColumn(k as CostCenterKind)),
    "AMORTIZACION_DETERIORO",
    "FINANCIERO",
    "EXTRAORDINARIO",
    "NO_ANALITICO",
  ]
}

const inWindow = (month: string, window: DateWindow): boolean =>
  month >= monthKey(window.from) && month <= monthKey(window.to)

/** Meses `YYYY-MM` de la ventana, en orden. */
export function windowMonths(window: DateWindow): string[] {
  const out: string[] = []
  let year = Number(window.from.slice(0, 4))
  let month = Number(window.from.slice(5, 7))
  const last = monthKey(window.to)
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
    if (key > last) break
    out.push(key)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/**
 * Celda → línea sintética, para poder llamar a las funciones de destino de E4
 * **sin copiarlas**. No se persiste: sólo viaja hasta `resolveDestination`.
 */
export function budgetCellAsLine(cell: BudgetCell, index: number, fiscalYearId: string): AnalyticLine {
  const isProject = cell.dimension.kind === "PROJECT"
  return {
    id: `budget#${index}`,
    entryId: `budget#${index}`,
    entryNumber: index,
    entryDate: cell.month,
    entryKind: "NORMAL",
    fiscalYearId,
    lineNo: index,
    accountCode: cell.accountCode ?? "",
    debitCents: cell.amountCents < 0 ? -cell.amountCents : 0,
    creditCents: cell.amountCents > 0 ? cell.amountCents : 0,
    analyticType: cell.analyticType,
    projectId: isProject ? cell.dimension.id : null,
    costCenterId: isProject ? null : cell.dimension.id,
    businessLineId: null,
  }
}

const emptyDense = (columns: readonly ColumnKey[]): Record<string, Cents> => {
  const row: Record<string, Cents> = {}
  for (const column of columns) row[column] = 0
  return row
}

const cumulate = (
  contrib: Record<string, Record<string, Cents>>,
  columns: readonly ColumnKey[],
  delta?: Record<string, Record<string, Cents>>
): Record<string, Record<string, Cents>> => {
  const running = emptyDense(columns)
  const out: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) {
    for (const column of columns) {
      running[column] += contrib[level]?.[column] ?? 0
      if (delta) running[column] += delta[level]?.[column] ?? 0
    }
    out[level] = { ...running }
  }
  return out
}

/**
 * Matriz del presupuesto, CUMULATIVA por nivel, con las MISMAS funciones de
 * destino que la del real.
 *
 * El **nivel** sale del `marginLevel` congelado de la celda (O-E10-7), no de la
 * configuración vigente: es lo que hace que el `budgetHash` signifique algo. Si
 * la configuración de hoy lo situaría en otro nivel, la celda entra igual —en
 * su nivel congelado— y la discrepancia se declara en `unresolved` como
 * `LEVEL_DRIFT`, para que I-E10-1 la vea en vez de que se mueva sola.
 */
export function buildBudgetMatrix(
  version: BudgetVersion,
  config: AnalyticsConfig,
  window: DateWindow
): BudgetMatrix {
  const columns = budgetColumns(config)
  const months = windowMonths(window)
  const businessLineCodes = config.businessLines.map((b) => b.code)

  const contrib: Record<string, Record<string, Cents>> = {}
  const contribByMonth: Record<string, Record<string, Record<string, Cents>>> = {}
  for (const level of MARGIN_LEVELS) contrib[level] = emptyDense(columns)
  for (const month of months) {
    contribByMonth[month] = {}
    for (const level of MARGIN_LEVELS) contribByMonth[month][level] = emptyDense(columns)
  }

  const unresolved: UnresolvedBudgetCell[] = []
  let cellCount = 0
  let index = 0

  for (const cell of version.cells) {
    index += 1
    const month = monthKey(cell.month)
    if (!inWindow(month, window)) continue
    const dest = resolveDestination(budgetCellAsLine(cell, index, version.fiscalYearId), config)
    const level = cell.marginLevel
    if (dest.fallback) {
      unresolved.push({
        month: cell.month,
        accountCode: cell.accountCode,
        dimensionKind: cell.dimension.kind,
        dimensionCode: cell.dimension.code,
        code: dest.fallback.code as UnresolvedBudgetCell["code"],
        message: dest.fallback.message,
      })
    } else if (dest.level !== level) {
      unresolved.push({
        month: cell.month,
        accountCode: cell.accountCode,
        dimensionKind: cell.dimension.kind,
        dimensionCode: cell.dimension.code,
        code: "LEVEL_DRIFT",
        message:
          `La celda se selló en ${level} y la configuración vigente la situaría en ${dest.level}: ` +
          "se respeta el nivel sellado (O-E10-7) y la discrepancia se declara",
      })
    }
    cellCount += 1
    contrib[level][dest.column] = (contrib[level][dest.column] ?? 0) + cell.amountCents
    const monthRow = contribByMonth[month]
    if (monthRow) monthRow[level][dest.column] = (monthRow[level][dest.column] ?? 0) + cell.amountCents
  }

  const cumulativeCents = cumulate(contrib, columns)
  const byMonth: Record<string, Record<string, Record<string, Cents>>> = {}
  for (const month of months) byMonth[month] = cumulate(contribByMonth[month], columns)

  return {
    levels: MARGIN_LEVELS,
    columns,
    businessLineCodes,
    cumulativeCents,
    contributionByLevelCents: contrib,
    ...totalsOf(cumulativeCents, columns, config),
    byMonth,
    unresolved,
    cellCount,
    months,
    allocationState: "NONE",
    budgetRulesHash: null,
    settlementWarnings: [],
  }
}

/**
 * Reconstruye la matriz cumulativa a partir del APORTE y un Δ de imputación.
 *
 * Se aplica al aporte, nunca a la cumulativa ya construida: por eso INGRESOS,
 * MC1 y MC2 salen idénticas y `Σ_c Δ[ℓ][c] = 0` en cada nivel (E5 · I-E5-6).
 */
export function applyAllocationDelta(
  matrix: BudgetMatrix,
  delta: Record<string, Record<string, Cents>>,
  config: AnalyticsConfig
): Pick<BudgetMatrix, "cumulativeCents" | "levelTotalsCents" | "levelTotalsBig" | "businessLineMatrixCents"> {
  const cumulativeCents = cumulate(matrix.contributionByLevelCents, matrix.columns, delta)
  return { cumulativeCents, ...totalsOf(cumulativeCents, matrix.columns, config) }
}

/** Totales por nivel (`number` y `BigInt`) y agregado por línea de negocio. */
function totalsOf(
  cumulativeCents: Record<string, Record<string, Cents>>,
  columns: readonly ColumnKey[],
  config: AnalyticsConfig
): Pick<BudgetMatrix, "levelTotalsCents" | "levelTotalsBig" | "businessLineMatrixCents"> {
  const blCodeById = new Map(config.businessLines.map((b) => [b.id, b.code]))
  const blCodeOfProject = new Map(config.projects.map((p) => [p.code, blCodeById.get(p.businessLineId) ?? null]))
  const levelTotalsCents: Record<string, Cents> = {}
  const levelTotalsBig: Record<string, bigint> = {}
  const businessLineMatrixCents: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) {
    let total = 0
    let big = BigInt(0)
    for (const column of columns) {
      total += cumulativeCents[level][column]
      big += BigInt(cumulativeCents[level][column])
    }
    levelTotalsCents[level] = total
    levelTotalsBig[level] = big
    const row: Record<string, Cents> = {}
    for (const b of config.businessLines) {
      row[b.code] =
        config.projects
          .filter((p) => blCodeOfProject.get(p.code) === b.code)
          .reduce((acc, p) => acc + (cumulativeCents[level][projectColumn(p.code)] ?? 0), 0) +
        (cumulativeCents[level][businessLineColumn(b.code)] ?? 0)
    }
    businessLineMatrixCents[level] = row
  }
  return { levelTotalsCents, levelTotalsBig, businessLineMatrixCents }
}
