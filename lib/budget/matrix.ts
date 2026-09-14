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

import {
  allocate,
  daysInMonth,
  effectiveRules,
  periodBounds,
  periodLabel,
  rulesHash,
  type AllocationPeriodRef,
  type AllocationRuleSpec,
  type AllocPeriod,
  type AppliedAllocation,
  type PriorAllocation,
  type Result,
} from "@/lib/analytics/allocate"
import { resolveDestination } from "@/lib/analytics/margins"
import type { AnalyticLine, AnalyticsConfig, ColumnKey, MarginLevel } from "@/lib/analytics/types"
import { DAILY_MINUTES_CEILING, type HeadcountRow, type TimeEntryRow } from "@/lib/time/aggregate"
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
  BudgetHoursCell,
  BudgetVersion,
  Cents,
  DateWindow,
  LocalDate,
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
  /** Las celdas de la ventana. La liquidación presupuestaria las vuelve a leer. */
  cells: readonly BudgetCell[]
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
  const cells: BudgetCell[] = []
  let cellCount = 0
  let index = 0

  for (const cell of version.cells) {
    index += 1
    const month = monthKey(cell.month)
    if (!inWindow(month, window)) continue
    cells.push(cell)
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
    cells,
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

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-4 — liquidación presupuestaria, en dry-run PURO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Escalera de liquidación de un ejercicio: los doce meses, los cuatro
 * trimestres y el año, en ese orden. Es la misma de E5 (`run_all` del fixture) y
 * el orden importa: una regla anual reparte lo que las mensuales no repartieron.
 */
export function settlementLadder(period: AllocationPeriodRef): AllocationPeriodRef[] {
  const monthStarts: LocalDate[] = []
  let cursor = period.fiscalYearStart
  for (let guard = 0; guard < 24 && cursor <= period.fiscalYearEnd; guard++) {
    monthStarts.push(cursor)
    const year = Number(cursor.slice(0, 4))
    const month = Number(cursor.slice(5, 7))
    cursor = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`
  }

  const labels: { kind: AllocPeriod; label: string }[] = []
  const push = (kind: AllocPeriod, label: string): void => {
    if (!labels.some((l) => l.kind === kind && l.label === label)) labels.push({ kind, label })
  }
  for (const start of monthStarts) push("MONTH", periodLabel("MONTH", start))
  for (const start of monthStarts) push("QUARTER", periodLabel("QUARTER", start))
  for (const start of monthStarts) push("YEAR", periodLabel("YEAR", start))

  const out: AllocationPeriodRef[] = []
  for (const { kind, label } of labels) {
    const bounds = periodBounds(label)
    // Sólo los periodos que caben ENTEROS en el del informe y en el ejercicio:
    // un run a medias inventaría un devengo que la regla no declara (E5 §3.3).
    if (bounds.from < period.start || bounds.to > period.end) continue
    if (bounds.from < period.fiscalYearStart || bounds.to > period.fiscalYearEnd) continue
    out.push({
      kind,
      label,
      start: bounds.from,
      end: bounds.to,
      fiscalYearId: period.fiscalYearId,
      fiscalYearStart: period.fiscalYearStart,
      fiscalYearEnd: period.fiscalYearEnd,
    })
  }
  return out
}

/**
 * Horas presupuestadas → partes sintéticos que el driver `HOURS` sabe leer.
 *
 * Se parten en trozos de como mucho `DAILY_MINUTES_CEILING` minutos repartidos
 * en días distintos del mes, porque `assertTimeEntryRow` **rechaza** —con razón—
 * un parte de más de 1 440 minutos: un mes presupuestado de 1 751 minutos no es
 * un día imposible, es un mes, y así se escribe. Ningún trozo sale del mes, de
 * modo que cualquier ventana MONTH/QUARTER/YEAR ve exactamente el mismo total.
 */
export function budgetHoursAsTimeEntries(hours: readonly BudgetHoursCell[]): TimeEntryRow[] {
  const out: TimeEntryRow[] = []
  let seq = 0
  for (const cell of hours) {
    if (cell.minutes <= 0) continue
    const year = Number(cell.month.slice(0, 4))
    const month = Number(cell.month.slice(5, 7))
    const days = daysInMonth(year, month)
    let pending = cell.minutes
    for (let day = 1; day <= days && pending > 0; day++) {
      const minutes = Math.min(pending, DAILY_MINUTES_CEILING)
      pending -= minutes
      seq += 1
      out.push({
        id: `budget-hours#${seq}`,
        employeeId: cell.employeeCode ?? "budget-employee",
        employeeCode: cell.employeeCode ?? "PRESUPUESTO",
        date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        target:
          cell.dimension.kind === "PROJECT"
            ? { kind: "PROJECT", id: cell.dimension.id, code: cell.dimension.code }
            : { kind: "COST_CENTER", id: cell.dimension.id, code: cell.dimension.code },
        businessLineCode: cell.dimension.kind === "PROJECT" ? cell.dimension.businessLineCode : null,
        minutes,
        productive: true,
        // Un presupuesto de horas no se «aprueba»: es el plan. Entra como base
        // del driver, y por eso nunca emite `W-E10-UNAPPROVED-HOURS`.
        approved: true,
      })
    }
  }
  return out
}

export type BudgetSettlementError = { code: "BUDGET_NOT_SETTLEABLE"; reason: string }

/** Un «run» del dry-run presupuestario. No se persiste: sólo se informa. */
export type BudgetDryRunRef = {
  runId: string
  period: string
  periodKind: AllocPeriod
  rulesApplied: readonly string[]
  lineCount: number
  totalAllocatedCents: Cents
}

export type SettleBudgetInput = {
  rules: readonly AllocationRuleSpec[]
  budgetHours: readonly BudgetHoursCell[]
  headcount: readonly HeadcountRow[]
  config: AnalyticsConfig
  period: AllocationPeriodRef
}

export type SettledBudget = {
  matrix: BudgetMatrix
  /** Las líneas de reparto del dry-run, en el orden de la escalera. */
  lines: readonly AppliedAllocation[]
  /** Δ por nivel y columna: `Σ_c Δ[ℓ][c] = 0` en todo nivel (I-E5-6). */
  allocationDeltaCents: Record<string, Record<string, Cents>>
  runs: readonly BudgetDryRunRef[]
}

/**
 * **O-E10-4 — liquidación presupuestaria, en dry-run PURO.**
 *
 * El bloqueante de fondo de la ronda 0: el presupuesto se teclea sobre proyectos
 * y CECOs, y el real con `withAllocations = true` ya ha trasladado el saldo de
 * los CECOs a las columnas de proyecto. **Por debajo de MC2 las dos matrices no
 * miden lo mismo.** Con `CC-OPS` presupuestado y ejecutado en 900 000 c exactos
 * y las horas exactamente previstas, P-01 recibe 400 000 c en el real y 0 en el
 * presupuesto: desviación de MC3 de P-01 de −400 000 c con ejecución perfecta, y
 * el total compañía cuadra, que es lo que hace que nadie lo detecte.
 *
 * La corrección es pasar el presupuesto por **el mismo `allocate()`**, con las
 * **mismas reglas vigentes** y con los drivers de actividad alimentados por las
 * **horas presupuestadas**. No se persiste nada: no es un `AllocationRun`, no
 * ocupa el índice único de periodo y no caduca informes; el `rulesHash` usado
 * viaja en `params` del `ReportRun`.
 *
 * Si el presupuesto **no puede seguir** al real —no hay horas presupuestadas
 * para una regla `HOURS`, o falta el snapshot de una `HEADCOUNT`— devuelve
 * `BUDGET_NOT_SETTLEABLE` con el motivo, y el informe aplica la salida mínima de
 * I-E10-18. **Nunca produce una matriz mixta.**
 */
export function settleBudgetMatrix(
  matrix: BudgetMatrix,
  input: SettleBudgetInput
): Result<SettledBudget, BudgetSettlementError> {
  const ladder = settlementLadder(input.period)
  const applicable = ladder.flatMap((p) => effectiveRules(input.rules, p))

  const budgetMinutes = input.budgetHours.reduce((acc, c) => acc + Math.max(0, c.minutes), 0)
  const hoursRules = applicable.filter((r) => r.driver === "HOURS")
  if (hoursRules.length > 0 && budgetMinutes === 0) {
    return {
      ok: false,
      error: {
        code: "BUDGET_NOT_SETTLEABLE",
        reason:
          `las reglas ${[...new Set(hoursRules.map((r) => r.code))].sort().join(", ")} reparten por HORAS y el ` +
          "presupuesto no declara ni un minuto: el presupuesto no puede seguir al real y las celdas por " +
          "dimensión de nivel ≥ MC3 NO se publican (I-E10-18)",
      },
    }
  }
  const headcountRules = applicable.filter((r) => r.driver === "HEADCOUNT")
  if (headcountRules.length > 0 && input.headcount.length === 0) {
    return {
      ok: false,
      error: {
        code: "BUDGET_NOT_SETTLEABLE",
        reason:
          `las reglas ${[...new Set(headcountRules.map((r) => r.code))].sort().join(", ")} reparten por PLANTILLA ` +
          "y no hay ningún snapshot en el periodo: el presupuesto no puede seguir al real y las celdas por " +
          "dimensión de nivel ≥ MC3 NO se publican (I-E10-18)",
      },
    }
  }

  const lines = matrix.cells.map((cell, i) => budgetCellAsLine(cell, i + 1, input.period.fiscalYearId))
  const timeEntries = budgetHoursAsTimeEntries(input.budgetHours)

  const applied: AppliedAllocation[] = []
  const priorAllocations: PriorAllocation[] = []
  const warnings: BudgetSettlementWarning[] = []
  const runs: BudgetDryRunRef[] = []

  for (const period of ladder) {
    const result = allocate({
      lines,
      config: input.config,
      rules: input.rules,
      period,
      priorAllocations,
      timeEntries,
      headcount: input.headcount,
    })
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: "BUDGET_NOT_SETTLEABLE",
          reason: `la liquidación presupuestaria de ${period.label} falla con ${result.error.code}: ${result.error.message}`,
        },
      }
    }
    applied.push(...result.value.lines)
    for (const line of result.value.lines) {
      priorAllocations.push({
        runPeriodStart: period.start,
        runPeriodEnd: period.end,
        sourceCostCenterId: line.sourceCostCenterId,
        marginLevel: line.marginLevel,
        amountCents: line.amountCents,
      })
    }
    for (const warning of result.value.warnings) {
      warnings.push({
        scope: "PRESUPUESTO",
        code: warning.code,
        ruleCode: warning.ruleCode,
        period: warning.period,
        detail: warning.detail,
      })
    }
    runs.push({
      runId: result.value.runId,
      period: period.label,
      periodKind: period.kind,
      rulesApplied: result.value.rulesApplied,
      lineCount: result.value.lines.length,
      totalAllocatedCents: result.value.totalAllocatedCents,
    })
  }

  // Δ de imputación sobre el APORTE, con el nivel del CECO donde nació el gasto
  // (E5-D1): la fuente se alivia y el receptor se carga en el MISMO nivel.
  const cecoKindById = new Map(input.config.costCenters.map((c) => [c.id, c.kind]))
  const allocationDeltaCents: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) allocationDeltaCents[level] = {}
  for (const line of applied) {
    const sourceKind = cecoKindById.get(line.sourceCostCenterId)
    if (!sourceKind) continue
    const sourceColumn = cecoColumn(sourceKind)
    const targetColumn: ColumnKey | null =
      line.target.kind === "PROJECT"
        ? projectColumn(line.target.code)
        : line.target.kind === "BUSINESS_LINE"
          ? businessLineColumn(line.target.code)
          : (() => {
              const kind = cecoKindById.get(line.target.id)
              return kind ? cecoColumn(kind) : null
            })()
    if (!targetColumn) continue
    const delta = allocationDeltaCents[line.marginLevel]
    delta[sourceColumn] = (delta[sourceColumn] ?? 0) + line.amountCents
    delta[targetColumn] = (delta[targetColumn] ?? 0) - line.amountCents
  }

  const settled: BudgetMatrix = {
    ...matrix,
    ...applyAllocationDelta(matrix, allocationDeltaCents, input.config),
    allocationState: "SETTLED",
    budgetRulesHash: rulesHash(input.rules),
    settlementWarnings: warnings,
  }
  return { ok: true, value: { matrix: settled, lines: applied, allocationDeltaCents, runs } }
}
