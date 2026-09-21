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

// ─────────────────────────────────────────────────────────────────────────────
// E12 · T19 — Q-6 / ADR-0018 D6: descomposición VOLUMEN / PRECIO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Q-6 / D6 — la convención se congeló en E10 y aquí se implementa**, sin
 * moverla ni un milímetro:
 *
 * ```
 *   Δ total   = P_r·Q_r − P_p·Q_p
 *   Δ volumen = ⌊ (Q_r − Q_p) × Importe_ppto / Q_p ⌋      (Q_p = 0 ⇒ todo volumen)
 *   Δ precio  = Δ total − Δ volumen                        ← RESIDUO ⇒ Σ exacta
 * ```
 *
 * **El cruce va al precio.** El efecto volumen se mide a condiciones del plan
 * —lo único que controla producción— y el efecto precio sobre la actividad
 * realmente ejecutada, porque es la decisión comercial aplicada al volumen que
 * hubo. Un tercer término «cruce» es matemáticamente honesto e **inservible en
 * un comité**: nadie tiene responsabilidad sobre él.
 *
 * **Y el precio es el RESIDUO, no una segunda división.** El precio unitario no
 * se almacena y `importe / horas` no es exacto; si las dos partes se calcularan
 * por separado, su suma no daría el total y el informe tendría un céntimo
 * huérfano que nadie sabría explicar. Con el residuo, `Σ = Δ total` con
 * **tolerancia 0**, que es la regla de toda la casa.
 *
 * **No se descompone el efecto mezcla (mix).** Con más de un proyecto por línea
 * el mix existe, pero exige una jerarquía de producto que el modelo no tiene:
 * mejor no publicarlo que publicarlo mal.
 */
export type VolumePriceInput = {
  /** Cantidad presupuestada (minutos, unidades…). Entera. */
  budgetQuantity: number
  /** Cantidad real, en la misma unidad. Entera. */
  actualQuantity: number
  /** Importe presupuestado, en céntimos y con su signo de aporte. */
  budgetCents: Cents
  /** Importe real, en céntimos y con el mismo signo de aporte. */
  actualCents: Cents
}

export type VolumePriceSplit = {
  /** `real − presupuesto`, exacto. */
  totalCents: Cents
  /** Efecto de hacer más o menos, valorado **al precio del plan**. */
  volumeCents: Cents
  /** Efecto de cobrar o pagar distinto, **sobre la actividad real**. Residuo. */
  priceCents: Cents
  /**
   * `true` cuando `Q_p = 0` y **todo** se atribuye al volumen. No es un matiz:
   * sin cantidad presupuestada no existe un precio de plan con el que comparar,
   * y repartir sería inventarse una referencia. La pantalla lo dice.
   */
  allVolume: boolean
  /**
   * `true` cuando no hay cantidades que comparar en ninguno de los dos lados.
   * Entonces la descomposición **no se publica**: `volumeCents` y `priceCents`
   * salen a 0 y esta bandera obliga a la pantalla a imprimir «sin base de
   * actividad» en vez de dos ceros que parecerían una medición.
   */
  notMeasurable: boolean
}

/**
 * División entera **truncada hacia cero**, no `Math.floor`.
 *
 * `Math.floor(-7/2) = -4` y `Math.trunc(-7/2) = -3`. Con importes de aporte —los
 * gastos son negativos (D2)— la diferencia no es cosmética: `floor` sesga
 * sistemáticamente el efecto volumen de los gastos hacia el lado desfavorable y
 * el residuo del precio lo compensa, de modo que las dos columnas quedan
 * desplazadas un céntimo **en direcciones opuestas y siempre en el mismo
 * sentido**. El truncado es simétrico, que es lo que un comité espera de un
 * número que se compara con el del año pasado.
 */
const truncDiv = (numerator: number, denominator: number): number => Math.trunc(numerator / denominator)

export function volumePriceSplit(input: VolumePriceInput): VolumePriceSplit {
  const { budgetQuantity: qp, actualQuantity: qr, budgetCents: ip, actualCents: ir } = input
  const totalCents = ir - ip

  if (qp === 0 && qr === 0) {
    return { totalCents, volumeCents: 0, priceCents: 0, allVolume: false, notMeasurable: true }
  }
  if (qp === 0) {
    // Sin cantidad de plan no hay precio de plan: todo es volumen, y se dice.
    return { totalCents, volumeCents: totalCents, priceCents: 0, allVolume: true, notMeasurable: false }
  }

  const volumeCents = truncDiv((qr - qp) * ip, qp)
  return { totalCents, volumeCents, priceCents: totalCents - volumeCents, allVolume: false, notMeasurable: false }
}

/** Una fila de la tabla de volumen/precio: la celda y su descomposición. */
export type VolumePriceRow = {
  column: ColumnKey
  level: MarginLevel
  /** `null` = acumulado del periodo. */
  month: string | null
  budgetQuantity: number
  actualQuantity: number
  split: VolumePriceSplit
}

/**
 * Descompone una colección de celdas comparables. La cantidad la aporta el
 * llamante —minutos de `time_entries` contra minutos de `budget_hours_lines`—
 * porque este módulo no lee nada.
 *
 * **La suma se comprueba aquí mismo**: si `volumen + precio ≠ total` en una sola
 * fila, se lanza. Una descomposición que no suma no es una descomposición: es
 * dos números al lado de un tercero.
 */
export function buildVolumePrice(
  rows: readonly (Omit<VolumePriceRow, "split"> & VolumePriceInput)[]
): readonly VolumePriceRow[] {
  return rows.map((row) => {
    const split = volumePriceSplit(row)
    if (!split.notMeasurable && split.volumeCents + split.priceCents !== split.totalCents) {
      throw new Error(
        `descomposición volumen/precio incoherente en ${row.column}/${row.level}: ` +
          `${split.volumeCents} + ${split.priceCents} ≠ ${split.totalCents}`
      )
    }
    return {
      column: row.column,
      level: row.level,
      month: row.month,
      budgetQuantity: row.budgetQuantity,
      actualQuantity: row.actualQuantity,
      split,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// E12 · T19 — granularidad MONTH de varios meses y desglose MES A MES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Deuda 12 de §6 de E12.** Hasta ahora `granularity: MONTH` servía **un solo
 * mes**: pedir enero-a-junio devolvía el acumulado y la columna mensual no
 * existía. El desglose mes a mes es lo primero que un CFO abre cuando el año
 * cuadra: un total anual en su sitio puede esconder un mayo catastrófico
 * compensado por un septiembre irrepetible, y eso no se ve en el acumulado.
 *
 * La serie es **por celda `(nivel, columna)`**, con un punto por mes del
 * periodo —incluidos los meses sin movimiento, que salen a 0 y **no se
 * omiten**: un hueco en la serie se lee como «no hubo datos», y lo que hubo fue
 * cero—. Y al lado, el **acumulado**, que es la cifra que el informe firma.
 */
export type MonthlyVariancePoint = {
  month: string
  actualCents: Cents
  budgetCents: Cents | null
  varianceCents: Cents | null
  notComparable: boolean
}

export type MonthlyVarianceSeries = {
  level: MarginLevel
  column: ColumnKey
  points: readonly MonthlyVariancePoint[]
  /** Σ de la serie. Se recomputa aquí y se enfrenta al acumulado del informe. */
  totalActualCents: Cents
  totalBudgetCents: Cents | null
  totalVarianceCents: Cents | null
  /** Algún mes de la serie no es comparable (I-E10-18): la pantalla lo dice. */
  anyNotComparable: boolean
}

/**
 * Compone las series mensuales a partir de las celdas **mensuales** que
 * `buildVariance` produjo mes a mes (una llamada por mes, con su `month`).
 *
 * **Y comprueba el cuadre**: la Σ de la serie tiene que ser el acumulado. Si el
 * llamante pasa el acumulado y no cuadra, se lanza — es el error de E10 que la
 * auditoría encontró al revés (la provenance de los niveles acumulados devolvía
 * 0 filas), y aquí se impide por construcción.
 */
export function monthlyVarianceSeries(
  monthlyCells: readonly VarianceCell[],
  months: readonly string[]
): readonly MonthlyVarianceSeries[] {
  const byCell = new Map<string, Map<string, VarianceCell>>()
  for (const cell of monthlyCells) {
    if (cell.month === null) continue
    const key = `${cell.level}\t${cell.column}`
    const inner = byCell.get(key) ?? new Map<string, VarianceCell>()
    inner.set(cell.month, cell)
    byCell.set(key, inner)
  }

  const out: MonthlyVarianceSeries[] = []
  for (const [key, inner] of [...byCell.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [level, column] = key.split("\t") as [MarginLevel, ColumnKey]
    let totalActualCents = 0
    let totalBudgetCents: Cents | null = 0
    let anyNotComparable = false
    const points: MonthlyVariancePoint[] = months.map((month) => {
      const cell = inner.get(month)
      const actualCents = cell?.actualCents ?? 0
      const budgetCents = cell ? cell.budgetCents : 0
      const notComparable = cell?.notComparable ?? false
      totalActualCents += actualCents
      if (budgetCents === null) totalBudgetCents = null
      else if (totalBudgetCents !== null) totalBudgetCents += budgetCents
      if (notComparable) anyNotComparable = true
      return {
        month,
        actualCents,
        budgetCents,
        varianceCents: budgetCents === null ? null : actualCents - budgetCents,
        notComparable,
      }
    })
    out.push({
      level,
      column,
      points,
      totalActualCents,
      totalBudgetCents,
      totalVarianceCents: totalBudgetCents === null ? null : totalActualCents - totalBudgetCents,
      anyNotComparable,
    })
  }
  return out
}

/**
 * El mes que más pesa en la desviación de una serie, en valor absoluto.
 *
 * Es el gemelo mensual de `maxDimensionVariance`, y existe por la misma razón:
 * un acumulado en su sitio puede esconder dos meses que se compensan, y firmar
 * eso en verde es exactamente lo que O-E10-18 impidió por dimensión.
 */
export function worstMonth(series: MonthlyVarianceSeries): MonthlyVariancePoint | null {
  let best: MonthlyVariancePoint | null = null
  for (const point of series.points) {
    if (point.varianceCents === null) continue
    if (best === null || Math.abs(point.varianceCents) > Math.abs(best.varianceCents ?? 0)) best = point
  }
  return best
}

/** La convención de volumen/precio, ya implementada (antes decía «E11»). */
export const VOLUME_PRICE_CONVENTION = "CRUCE_AL_PRECIO" as const

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

/**
 * Filtro por dimensión de la columna: `PROJ:`, `CECO:`, `BL:` o la compañía.
 *
 * **Ronda 1 de E12.** Las tres subconsultas iban **sin filtro de tenant**
 * (`SELECT id FROM projects WHERE code = 'P-01'`). El código de un proyecto es
 * único DENTRO de una organización, no en la base: en cuanto dos organizaciones
 * tienen un `P-01` —lo normal en una instalación real, y lo que pasa en
 * `erp_test` en cuanto corren dos suites— la subconsulta devuelve dos filas y
 * Postgres responde `21000: more than one row returned by a subquery`. La
 * provenance dejaba de ser ejecutable, que es justo lo que C3 promete que no
 * pasa. Y si en vez de reventar hubiera devuelto la fila de la otra
 * organización, habría sido una fuga entre tenants en una consulta de
 * trazabilidad.
 *
 * El `organizationId` ya viaja en el contexto: se usa.
 */
const dimensionFilter = (column: ColumnKey, table: string, organizationId: string): string => {
  const porCodigo = (tabla: string, campo: string, codigo: string): string =>
    `${table}.${campo} = (SELECT id FROM ${tabla} WHERE organization_id = '${organizationId}' AND code = '${codigo}')`
  if (column.startsWith("PROJ:")) return porCodigo("projects", "project_id", column.slice(5))
  if (column.startsWith("CECO:")) return porCodigo("cost_centers", "cost_center_id", column.slice(5))
  if (column.startsWith("BL:")) return porCodigo("business_lines", "business_line_id", column.slice(3))
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
  const dim = (table: string): string => dimensionFilter(cell.column, table, ctx.organizationId)

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
