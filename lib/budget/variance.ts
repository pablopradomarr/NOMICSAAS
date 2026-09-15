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

// ─────────────────────────────────────────────────────────────────────────────
// P6 · §5.1 — provenance POR CELDA (auditoría ronda 1, hallazgo H-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **H-7.** La ronda 0 persistía un bloque de run con
 * `generatedFrom: ["journal_lines", "allocation_lines", "budget_lines"]` y los
 * tres sellos. Con eso una celda se reconstruye **a mano** —el propio auditor
 * tuvo que escribir las consultas—, pero no es el drill-down que §5.1 promete:
 * «**tres** consultas parametrizadas **por celda**, porque una celda de
 * desviación no se reproduce con una sola».
 *
 * Aquí se compone esa provenance, celda a celda y en forma canónica. Es un
 * módulo puro: las consultas son **texto parametrizado** que se copia y se
 * ejecuta, nunca SQL que este módulo lance.
 */
export type BudgetProvenanceContext = {
  runId: string
  organizationId: string
  fiscalYearId: string
  budgetIdsByMonth: Readonly<Record<string, string>>
  periodStart: string
  periodEnd: string
  ledgerHash: string
  budgetHash: string
  analyticsKey: string
  gitSha: string
  baseCurrency: string
  /** Con imputaciones, la celda lleva además el reparto y su base de horas. */
  withAllocations: boolean
  /** `analyticTypes` por nivel de la configuración de márgenes vigente. */
  levelTypes: Readonly<Record<string, readonly string[]>>
}

export type BudgetCellProvenance = {
  valor: Cents | null
  moneda: string
  metrica: string
  run_id: string
  ledgerHash: string
  budgetHash: string
  analyticsKey: string
  calculado_por: string
  registros_origen: Readonly<Record<string, string>>
  confianza: "calculado" | "no_comparable"
}

/**
 * Los tipos analíticos que recogen **todos los niveles hasta `level`**, como
 * lista SQL.
 *
 * **Re-auditoría de la ronda 1, punto 3.** La primera versión filtraba por los
 * tipos **del nivel**, y la matriz es **ACUMULATIVA**: MC3 de `PROJ:P-01` no es
 * lo que aporta MC3, es INGRESOS + MC1 + MC2 + MC3. Con el filtro por nivel, la
 * consulta de una celda de MC3 devolvía **0 filas** —MC3 no recoge ningún tipo
 * por sí mismo— y sólo cuadraba el nivel base. Una provenance que devuelve cero
 * filas sobre una celda de −4 484 000 c es peor que ninguna: dice que no hay
 * origen.
 *
 * El nivel de una línea del diario **no está en la fila**: se deriva del tipo
 * analítico efectivo y de la configuración de márgenes (`marginConfigHash`, que
 * viaja en `analyticsKey`), así que la consulta filtra por tipo y nombra los
 * niveles en un comentario, en vez de fingir una columna que no existe.
 */
const levelsUpTo = (level: MarginLevel): MarginLevel[] =>
  MARGIN_LEVELS.slice(0, MARGIN_LEVELS.indexOf(level) + 1) as MarginLevel[]

const cumulativeTypesOf = (level: MarginLevel, ctx: BudgetProvenanceContext): string => {
  const levels = levelsUpTo(level)
  const types = new Set<string>()
  for (const l of levels) {
    const own = ctx.levelTypes[l] ?? []
    // MC3 y EBITDA no recogen ningún tipo por sí mismos: les llega
    // `INDIRECTO_CECO` encaminado por el `marginLevel` del CECO de la línea
    // (E5-D1). La consulta lo incluye en vez de quedarse sin filtro.
    if (own.length === 0) types.add("INDIRECTO_CECO")
    for (const t of own) types.add(t)
  }
  return [...types].sort().map((t) => `'${t}'`).join(", ")
}

/** Los niveles acumulados, como lista SQL, para `margin_level IN (…)`. */
const cumulativeLevelsOf = (level: MarginLevel): string =>
  levelsUpTo(level)
    .map((l) => `'${l}'`)
    .join(", ")

/**
 * Ventana `[desde, hasta]` de la celda: su mes, o **el periodo entero** del
 * informe cuando la celda es del acumulado (`month === null`).
 *
 * **Re-auditoría, punto 3.** El error hermano del anterior: la consulta de
 * presupuesto fijaba `bl.month = '<mes>-01'` incluso en una celda ANUAL, así que
 * apuntaba sólo a enero. El rango se abre a todos los meses del periodo, y los
 * `budget_id` que lo gobiernan salen de la composición (O-E10-9), no de uno.
 */
const cellWindow = (cell: VarianceCell, ctx: BudgetProvenanceContext): { from: string; to: string } => {
  if (cell.month === null) return { from: ctx.periodStart, to: ctx.periodEnd }
  const [y, m] = cell.month.split("-").map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${cell.month}-01`, to: `${cell.month}-${String(last).padStart(2, "0")}` }
}

/** Filtro por dimensión de la columna: `PROJ:`, `CECO:`, `BL:` o la compañía. */
const dimensionFilter = (column: ColumnKey, table: string): string => {
  if (column.startsWith("PROJ:")) return `${table}.project_id = (SELECT id FROM projects WHERE code = '${column.slice(5)}')`
  if (column.startsWith("CECO:")) return `${table}.cost_center_id = (SELECT id FROM cost_centers WHERE code = '${column.slice(5)}')`
  if (column.startsWith("BL:")) return `${table}.business_line_id = (SELECT id FROM business_lines WHERE code = '${column.slice(3)}')`
  return "true /* columna de compañía: sin filtro de dimensión */"
}

/**
 * Los meses de la ventana agrupados por la versión que los GOBIERNA (O-E10-9).
 *
 * No vale `budget_id IN (…) AND month BETWEEN …`: la BASE cubre los doce meses y
 * la `REVISADO` parcial sólo julio-diciembre, así que el producto cartesiano
 * cuenta julio-diciembre **dos veces**. La composición es mes a mes, y la
 * consulta tiene que decirlo igual que la dice el informe.
 */
const monthsByBudget = (ctx: BudgetProvenanceContext, from: string, to: string): [string, string[]][] => {
  const desde = from.slice(0, 7)
  const hasta = to.slice(0, 7)
  const out = new Map<string, string[]>()
  for (const [month, id] of Object.entries(ctx.budgetIdsByMonth)) {
    if (month < desde || month > hasta) continue
    out.set(id, [...(out.get(id) ?? []), month].sort())
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** `((t.budget_id = 'X' AND t.month IN (…)) OR …)`, la composición en SQL. */
const composicionFilter = (grupos: [string, string[]][], table: string): string =>
  "(" +
  grupos
    .map(
      ([id, months]) =>
        `(${table}.budget_id = '${id}' AND ${table}.month IN (${months.map((m) => `'${m}-01'`).join(", ")}))`
    )
    .join(" OR ") +
  ")"

export function budgetCellProvenance(cell: VarianceCell, ctx: BudgetProvenanceContext): BudgetCellProvenance {
  const { from, to } = cellWindow(cell, ctx)
  const grupos = monthsByBudget(ctx, from, to)
  const niveles = cumulativeLevelsOf(cell.level)
  const dim = (table: string): string => dimensionFilter(cell.column, table)

  const registros: Record<string, string> = {
    // (1) El REAL: las líneas del diario que la celda ACUMULA, de todos los
    //     niveles hasta el suyo y de todos los meses de la ventana. Se excluyen
    //     regularización, cierre y apertura, que no son PyG (I3).
    real:
      `SELECT jl.id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id ` +
      `AND je.organization_id = jl.organization_id WHERE jl.organization_id = '${ctx.organizationId}' ` +
      `AND je.entry_date BETWEEN '${from}' AND '${to}' AND ${dim("jl")} ` +
      `AND jl.entry_kind NOT IN ('REGULARIZATION', 'CLOSING', 'OPENING') ` +
      `AND jl.analytic_type IN (${cumulativeTypesOf(cell.level, ctx)}) /* niveles ${niveles} */`,
    // (2) El IMPUTADO: sólo con el toggle de imputaciones; sin él la celda no
    //     lleva estructura repartida y una consulta vacía engañaría.
    ...(ctx.withAllocations
      ? {
          imputado:
            `SELECT al.id FROM allocation_lines al JOIN allocation_runs ar ON ar.id = al.run_id ` +
            `AND ar.organization_id = al.organization_id WHERE al.organization_id = '${ctx.organizationId}' ` +
            `AND ar.status = 'SEALED' AND ar.period_start >= '${from}' AND ar.period_end <= '${to}' ` +
            `AND ${dim("al").replace(/\b(project_id|cost_center_id|business_line_id)\b/, "target_$1")} ` +
            `AND al.margin_level IN (${niveles})`,
        }
      : {}),
    // (3) El PRESUPUESTO: las líneas de las versiones que gobiernan los meses de
    //     la ventana (O-E10-9), acumuladas hasta el nivel de la celda.
    presupuesto:
      grupos.length === 0
        ? `-- ${from}…${to} no tiene ninguna versión de presupuesto que lo cubra: la celda sale VACÍA con leyenda, nunca a cero`
        : `SELECT bl.id FROM budget_lines bl WHERE bl.organization_id = '${ctx.organizationId}' ` +
          `AND ${composicionFilter(grupos, "bl")} ` +
          `AND ${dim("bl")} AND bl.margin_level IN (${niveles})`,
    // (4) Las HORAS presupuestadas: la base con la que el dry-run de O-E10-4
    //     repartió la estructura hasta esta celda. Desde la ronda 1 entran
    //     además en el `budgetHash` (ADR-0018 D2), así que la consulta y el
    //     sello hablan de lo mismo.
    ...(ctx.withAllocations && grupos.length > 0
      ? {
          horas:
            `SELECT bhl.id FROM budget_hours_lines bhl WHERE bhl.organization_id = '${ctx.organizationId}' ` +
            `AND ${composicionFilter(grupos, "bhl")} AND ${dim("bhl")}`,
        }
      : {}),
  }

  return {
    valor: cell.varianceCents,
    moneda: ctx.baseCurrency,
    metrica: `desviacion.${cell.level.toLowerCase()}.${cell.column}.${cell.month ?? "periodo"}`,
    run_id: ctx.runId,
    ledgerHash: `sha256:${ctx.ledgerHash}`,
    budgetHash: `sha256:${ctx.budgetHash}`,
    analyticsKey: ctx.analyticsKey,
    calculado_por: `lib/budget/variance.ts@${ctx.gitSha}`,
    registros_origen: registros,
    confianza: cell.notComparable ? "no_comparable" : "calculado",
  }
}

/** La provenance de TODAS las celdas del informe, en el orden de la matriz. */
export const budgetProvenanceByCell = (
  cells: readonly VarianceCell[],
  ctx: BudgetProvenanceContext
): BudgetCellProvenance[] => cells.map((cell) => budgetCellProvenance(cell, ctx))
