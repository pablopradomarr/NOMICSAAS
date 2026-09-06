/**
 * E5 · T5 — Motor de liquidación de CECOs (`docs/design/E5-liquidacion.md` §3.1,
 * `docs/design/E5-validacion-liquidacion.md` §1–§2, ADR-0004 + ADR-0013).
 *
 * Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()` (lo verifica
 * `.claude/hooks/guard.sh`). Toda la aritmética es **entera**: prohibidos
 * `float`, `Decimal`, `round()` y los porcentajes intermedios.
 *
 * Reproduce **byte a byte** `docs/design/fixtures/liquidacion-esperada.json`
 * (criterio 1 de §8.1): el generador Python es la única fuente de verdad y este
 * módulo es su espejo en TypeScript, desempates incluidos.
 */

import { createHash } from "node:crypto"

import {
  AnalyticLine,
  AnalyticsConfig,
  Cents,
  CostCenterMarginLevel,
  LocalDate,
  MarginLevel,
} from "@/lib/analytics/types"
import { contribution, isPnlLine, resolveDestination } from "@/lib/analytics/margins"
import { formatBps } from "@/lib/money"
import type { AllocPeriod, Driver, TargetKind, ZeroBaseFallback } from "@/prisma/client"

export type { AllocPeriod, Driver, TargetKind, ZeroBaseFallback }

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** R-A12: una subvención finalista NO es capacidad de absorción de estructura. */
export const REVENUE_SHARE_EXCLUDED_PREFIXES: readonly string[] = ["74"]

/** Los dos niveles que un CECO puede tener, y por tanto los que viajan. */
export const ALLOCATABLE_LEVELS: readonly CostCenterMarginLevel[] = ["EBITDA", "MC3"]

export type TargetFilter = {
  projectStatus?: readonly ("PLANNED" | "ACTIVE" | "CLOSED")[]
  businessLineCodes?: readonly string[]
  costCenterCodes?: readonly string[]
  excludeProjectCodes?: readonly string[]
}

export type RuleTargetSpec = {
  projectId?: string | null
  businessLineId?: string | null
  costCenterId?: string | null
  percentBps?: number | null
  amountCents?: Cents | null
  sortOrder?: number
}

export type AllocationRuleSpec = {
  id: string
  code: string
  name: string
  sourceCostCenterId: string
  targetKind: TargetKind
  driver: Driver
  period: AllocPeriod
  priority: number
  sourceShareBps: number
  zeroBaseFallback: ZeroBaseFallback
  targetFilter: TargetFilter | null
  validFrom: LocalDate
  validTo: LocalDate | null
  isActive: boolean
  /** Sólo `FIXED_PERCENT` y `MANUAL`; los drivers calculados no tienen targets. */
  targets: readonly RuleTargetSpec[]
}

export type DateWindow = { from: LocalDate; to: LocalDate }

export type AllocationPeriodRef = {
  kind: AllocPeriod
  /** Etiqueta canónica del periodo: `2026-11`, `2026-Q2`, `2026`. */
  label: string
  start: LocalDate
  end: LocalDate
  fiscalYearId: string
  fiscalYearStart: LocalDate
  fiscalYearEnd: LocalDate
}

/**
 * `AllocationLine` ya emitida por un run VIGENTE de periodo más fino ⊂ P. Es lo
 * que hace que una regla mensual y una anual sobre el mismo CECO convivan sin
 * doble reparto (`yaRepartido` de I5).
 */
export type PriorAllocation = {
  runPeriodStart: LocalDate
  runPeriodEnd: LocalDate
  sourceCostCenterId: string
  marginLevel: CostCenterMarginLevel
  amountCents: Cents
}

export type AllocationInput = {
  /** Líneas del EJERCICIO, no sólo del periodo: `YTD` y `PRIOR_PERIOD` las necesitan. */
  lines: readonly AnalyticLine[]
  config: AnalyticsConfig
  rules: readonly AllocationRuleSpec[]
  period: AllocationPeriodRef
  priorAllocations: readonly PriorAllocation[]
  /** Id del run que se está simulando o sellando; sólo etiqueta la salida. */
  runId?: string
}

export type AllocationTargetRef =
  | { kind: "PROJECT"; id: string; code: string }
  | { kind: "BUSINESS_LINE"; id: string; code: string }
  | { kind: "COST_CENTER"; id: string; code: string }

/** Lo que la matriz consume: una línea de reparto ya resuelta. */
export type AppliedAllocation = {
  runId: string
  ruleId: string
  ruleCode: string
  sourceCostCenterId: string
  sourceCostCenterCode: string
  targetKind: TargetKind
  target: AllocationTargetRef
  marginLevel: CostCenterMarginLevel
  amountCents: Cents
  driverBase: number
  driverBaseTotal: number
  driverShareBps: number
  fallbackApplied: ZeroBaseFallback | null
  eligibilityReason: "ACTIVITY_IN_PERIOD" | null
}

export type AllocationWarning =
  | {
      code: "W-E5-ZERO-BASE"
      ruleCode: string
      period: string
      fallback: ZeroBaseFallback
      unallocatedCents: Cents
      detail: string
    }
  | { code: "W-E5-NEG-BASE"; ruleCode: string; period: string; targets: readonly string[]; detail: string }
  | { code: "W-E5-ARCHIVED-TARGET"; ruleCode: string; period: string; targets: readonly string[]; detail: string }

export type AllocationErrorCode =
  | "ALLOCATION_CYCLE"
  | "ALLOCATION_PRIORITY_NOT_TOPOLOGICAL"
  | "CASCADE_PERIOD_MISMATCH"
  | "ALLOCATION_TARGET_NOT_ALLOCATABLE"
  | "SOURCE_SHARE_NOT_100"
  | "FIXED_PERCENT_NOT_100"
  | "MANUAL_AMOUNT_MISMATCH"
  | "DRIVER_UNAVAILABLE"
  | "PERIOD_CROSSES_FISCAL_YEAR"
  | "SOURCE_NOT_ALLOCATABLE"
  /**
   * Revisión ronda 1, BLOQUEA #1 — el destino elegido exige destinos explícitos
   * y la regla no los trae (o los trae un driver que no los admite).
   */
  | "TARGETS_REQUIRED"
  /**
   * ADR-0013 D4 — la regla está vigente, tiene saldo que repartir y **no puede
   * repartir un céntimo**. Se rechaza; nunca se reparte 0 € en silencio.
   */
  | "RULE_INERT"

export type AllocationError = { code: AllocationErrorCode; message: string; ruleCodes?: readonly string[] }

/** Base, repartido y residual por `(fuente, nivel)`. Es I5.a hecha dato. */
export type SourceBalance = {
  sourceCostCenterId: string
  sourceCostCenterCode: string
  marginLevel: CostCenterMarginLevel
  /** `own − yaRepartido + recibido`, es decir la base liquidable del run. */
  baseCents: Cents
  /** La parte de la base que las reglas del periodo declaran liquidar. */
  liquidatedCents: Cents
  allocatedCents: Cents
  /** `liquidated − allocated`. Tolerancia 0: cualquier valor ≠ 0 es un fallo. */
  residualCents: Cents
  /** `base − liquidated`: lo que ninguna regla del periodo reparte. */
  pendingCents: Cents
}

export type AllocationResult = {
  runId: string
  period: AllocationPeriodRef
  lines: readonly AppliedAllocation[]
  balances: readonly SourceBalance[]
  warnings: readonly AllocationWarning[]
  /** Códigos, en orden de ejecución. */
  rulesApplied: readonly string[]
  totalAllocatedCents: Cents
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

const ok = <T, E>(value: T): Result<T, E> => ({ ok: true, value })
const err = <T>(code: AllocationErrorCode, message: string, ruleCodes?: readonly string[]): Result<T, AllocationError> => ({
  ok: false,
  error: ruleCodes === undefined ? { code, message } : { code, message, ruleCodes },
})

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética: mayor resto (Hamilton), determinista y ENTERO (§1.4)
// ─────────────────────────────────────────────────────────────────────────────

export type HamiltonWeight = { code: string; weight: number }
export type HamiltonShare = { code: string; amountCents: Cents; shareBps: number; remainderApplied: boolean }

/**
 * Mayor resto (Hamilton). `Σ resultado = amountCents` EXACTO (tolerancia 0).
 *
 *   qᵢ = ⌊A·wᵢ / W⌋ · restoᵢ = A·wᵢ − qᵢ·W · r = A − Σqᵢ
 *   +1 céntimo a los `r` de mayor resto; EMPATE → **menor `code`**.
 *
 * `A = |amountCents|` y el signo se restituye al final: truncar con signo sesga
 * el redondeo hacia cero y dejaría saldo permanente en un CECO acreedor.
 * El desempate por menor código es arbitrario pero **estable**, que es lo único
 * que se le pide a un desempate (P7); «al mayor receptor» depende del orden de
 * lectura de la base y rompe la reproducibilidad byte a byte.
 *
 * Diferencia deliberada con `splitLargestRemainder` de `lib/money.ts`: aquélla
 * desempata por mayor peso y luego por índice —orden de llegada—, que aquí no
 * sirve. Ésta desempata por código y devuelve además la cuota en bps y qué
 * receptores absorbieron remanente, que es lo que `AllocationLine` persiste.
 */
export function hamilton(amountCents: Cents, weights: readonly HamiltonWeight[]): readonly HamiltonShare[] {
  const positive = weights.filter((w) => w.weight > 0)
  const total = positive.reduce((a, w) => a + w.weight, 0)
  if (total === 0 || amountCents === 0) {
    return weights.map((w) => ({ code: w.code, amountCents: 0, shareBps: 0, remainderApplied: false }))
  }
  const sign = amountCents >= 0 ? 1 : -1
  const abs = Math.abs(amountCents)

  // Revisión ronda 1, #11 / auditoría hallazgo 4: el producto `A·wᵢ` y el resto
  // se calculan en **BigInt**. Con importes y bases de una empresa de 10 M€ el
  // producto supera 2^53 (25 M c × 700 M c = 1,75e16) y el resto, calculado por
  // diferencia de dos dobles enormes, quedaba cuantizado a múltiplos de ~256: la
  // suma seguía siendo exacta, pero el desempate dejaba de ser el real. En BigInt
  // la exactitud es **por construcción**, que es lo que exige §1.4. El cociente
  // cabe siempre en `Number` (qᵢ ≤ A ≤ 2^53).
  const totalBig = BigInt(total)
  const absBig = BigInt(abs)

  const quotient = new Map<string, number>()
  const remainder = new Map<string, bigint>()
  for (const w of positive) {
    const product = absBig * BigInt(w.weight)
    const q = product / totalBig
    quotient.set(w.code, Number(q))
    remainder.set(w.code, product - q * totalBig)
  }
  let left = abs
  for (const q of quotient.values()) left -= q

  // Orden: mayor resto primero; a igual resto, MENOR código.
  const zero = BigInt(0)
  const order = [...positive].sort((a, b) => {
    const ra = remainder.get(a.code) ?? zero
    const rb = remainder.get(b.code) ?? zero
    if (rb > ra) return 1
    if (rb < ra) return -1
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })
  const bumped = new Set<string>()
  for (const w of order.slice(0, left)) {
    quotient.set(w.code, (quotient.get(w.code) ?? 0) + 1)
    bumped.add(w.code)
  }

  return weights.map((w) => ({
    code: w.code,
    amountCents: sign * (quotient.get(w.code) ?? 0),
    shareBps: w.weight > 0 ? Number((BigInt(w.weight) * BigInt(10000)) / totalBig) : 0,
    remainderApplied: bumped.has(w.code),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Fechas: aritmética de cadenas, sin `Date` (el motor es puro)
// ─────────────────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
export const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1]

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))
const yearOf = (d: LocalDate): number => Number(d.slice(0, 4))
const monthOf = (d: LocalDate): number => Number(d.slice(5, 7))

/** Etiqueta canónica del periodo que contiene `date`, según la periodicidad. */
export function periodLabel(kind: AllocPeriod, date: LocalDate): string {
  const y = yearOf(date)
  const m = monthOf(date)
  if (kind === "YEAR") return String(y)
  if (kind === "QUARTER") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
  return `${y}-${pad2(m)}`
}

/** `[start, end]` de una etiqueta canónica (`2026`, `2026-Q2`, `2026-11`). */
export function periodBounds(label: string): DateWindow {
  const y = Number(label.slice(0, 4))
  if (label.length === 4) return { from: `${y}-01-01`, to: `${y}-12-31` }
  if (label.includes("Q")) {
    const q = Number(label.slice(-1))
    const m0 = 3 * q - 2
    const m1 = 3 * q
    return { from: `${y}-${pad2(m0)}-01`, to: `${y}-${pad2(m1)}-${pad2(daysInMonth(y, m1))}` }
  }
  const m = Number(label.slice(5, 7))
  return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(daysInMonth(y, m))}` }
}

/**
 * ¿Cabe al menos UN periodo completo de periodicidad `kind` dentro de
 * `[from, to]`? (revisión ronda 2, R2-1 · diseño §3.3 y criterio 18).
 *
 * Es la pregunta «¿esta regla ya tenía que haber liquidado dentro del periodo
 * que estoy mirando?». Un informe **mensual** con una regla **anual** responde
 * `false`: el saldo del CECO no es un descuadre, es **pendiente de liquidar**, y
 * prorratear el anual entre los meses inventaría un devengo que la regla no
 * declara. Un informe **anual** con reglas **mensuales** responde `true`: los
 * doce meses caben, así que a 31-12 el CECO tiene que estar a cero.
 */
export function settlementPeriodFitsIn(kind: AllocPeriod, from: LocalDate, to: LocalDate): boolean {
  const firstYear = yearOf(from)
  const lastYear = yearOf(to)
  for (let y = firstYear; y <= lastYear; y++) {
    const labels =
      kind === "YEAR"
        ? [String(y)]
        : kind === "QUARTER"
          ? [1, 2, 3, 4].map((q) => `${y}-Q${q}`)
          : Array.from({ length: 12 }, (_, i) => `${y}-${pad2(i + 1)}`)
    for (const label of labels) {
      const bounds = periodBounds(label)
      if (bounds.from >= from && bounds.to <= to) return true
    }
  }
  return false
}

/** Ventana del periodo INMEDIATAMENTE anterior del mismo tipo (`PRIOR_PERIOD`). */
export function priorPeriodWindow(kind: AllocPeriod, label: string): DateWindow {
  const y = Number(label.slice(0, 4))
  if (kind === "YEAR") return periodBounds(String(y - 1))
  if (kind === "QUARTER") {
    const q = Number(label.slice(-1))
    return q === 1 ? periodBounds(`${y - 1}-Q4`) : periodBounds(`${y}-Q${q - 1}`)
  }
  const m = Number(label.slice(5, 7))
  return m === 1 ? periodBounds(`${y - 1}-12`) : periodBounds(`${y}-${pad2(m - 1)}`)
}

const within = (date: LocalDate, w: DateWindow): boolean => date >= w.from && date <= w.to
const contains = (outer: DateWindow, inner: DateWindow): boolean => inner.from >= outer.from && inner.to <= outer.to

// ─────────────────────────────────────────────────────────────────────────────
// Grafo de cascada
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationGraph = {
  /** Aristas `fuente → CECO destino`, con la regla que las produce. */
  edges: readonly { period: AllocPeriod; from: string; to: string; ruleCode: string; priority: number }[]
  /** Adyacencia por `${period}|${cecoId}`. */
  adjacency: ReadonlyMap<string, readonly string[]>
}

const adjKey = (period: AllocPeriod, node: string): string => `${period}|${node}`

/** Grafo `fuente → CECO destino` de las reglas vigentes de UN `period`. */
export function buildAllocationGraph(rules: readonly AllocationRuleSpec[]): AllocationGraph {
  const edges: { period: AllocPeriod; from: string; to: string; ruleCode: string; priority: number }[] = []
  const adjacency = new Map<string, string[]>()
  for (const rule of rules) {
    for (const target of rule.targets) {
      if (!target.costCenterId) continue
      edges.push({
        period: rule.period,
        from: rule.sourceCostCenterId,
        to: target.costCenterId,
        ruleCode: rule.code,
        priority: rule.priority,
      })
      const key = adjKey(rule.period, rule.sourceCostCenterId)
      const list = adjacency.get(key) ?? []
      list.push(target.costCenterId)
      adjacency.set(key, list)
    }
  }
  return { edges, adjacency }
}

/**
 * DFS con pila explícita. Devuelve **el ciclo nombrado**, no un booleano: lo que
 * el usuario necesita es la lista de CECOs, no la noticia de que hay un ciclo
 * (I-E5-1). Las autoaristas son ciclos triviales y salen igual.
 */
export function findCycle(graph: AllocationGraph): readonly string[] | null {
  const periods = new Set(graph.edges.map((e) => e.period))
  for (const period of [...periods].sort()) {
    const nodes = new Set<string>()
    for (const e of graph.edges) {
      if (e.period !== period) continue
      nodes.add(e.from)
      nodes.add(e.to)
    }
    const state = new Map<string, 0 | 1 | 2>()
    for (const start of [...nodes].sort()) {
      if (state.get(start)) continue
      const stack: { node: string; next: number; path: string[] }[] = [{ node: start, next: 0, path: [start] }]
      state.set(start, 1)
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]
        const children = graph.adjacency.get(adjKey(period, frame.node)) ?? []
        if (frame.next >= children.length) {
          state.set(frame.node, 2)
          stack.pop()
          continue
        }
        const child = children[frame.next++]
        if (state.get(child) === 1) return [...frame.path, child]
        if (state.get(child) === 2) continue
        state.set(child, 1)
        stack.push({ node: child, next: 0, path: [...frame.path, child] })
      }
    }
  }
  return null
}

/**
 * I-E5-8 — `(priority, code)` es orden topológico: para toda arista `a → b`,
 * TODA regla con fuente `b` y el mismo `period` tiene prioridad estrictamente
 * mayor. Devuelve las aristas infractoras; el motor **no reordena en silencio**,
 * porque reordenar cambiaría el resultado que el usuario aprobó en la simulación.
 */
export function checkTopologicalOrder(
  rules: readonly AllocationRuleSpec[],
  graph: AllocationGraph
): readonly { from: string; to: string }[] {
  const bad: { from: string; to: string }[] = []
  for (const edge of graph.edges) {
    for (const rule of rules) {
      if (rule.sourceCostCenterId !== edge.to || rule.period !== edge.period) continue
      if (rule.priority <= edge.priority) bad.push({ from: edge.ruleCode, to: rule.code })
    }
  }
  return bad.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))
}

// ─────────────────────────────────────────────────────────────────────────────
// Bases del driver y base liquidable
// ─────────────────────────────────────────────────────────────────────────────

type Indexes = {
  projectById: ReadonlyMap<string, AnalyticsConfig["projects"][number]>
  cecoById: ReadonlyMap<string, AnalyticsConfig["costCenters"][number]>
  blById: ReadonlyMap<string, AnalyticsConfig["businessLines"][number]>
}

const indexesOf = (config: AnalyticsConfig): Indexes => ({
  projectById: new Map(config.projects.map((p) => [p.id, p])),
  cecoById: new Map(config.costCenters.map((c) => [c.id, c])),
  blById: new Map(config.businessLines.map((b) => [b.id, b])),
})

/** `aporte(l) = credit − debit`; un coste es negativo (definición de E4). */
type Classified = {
  line: AnalyticLine
  analyticType: string | null
  amountCents: Cents
}

function classifyLines(lines: readonly AnalyticLine[], config: AnalyticsConfig): Classified[] {
  const out: Classified[] = []
  for (const line of lines) {
    if (!isPnlLine(line)) continue
    out.push({
      line,
      analyticType: resolveDestination(line, config).analyticType,
      amountCents: contribution(line),
    })
  }
  return out
}

const classify = (input: AllocationInput): Classified[] => classifyLines(input.lines, input.config)

/** Ingresos directos por proyecto, `74x` EXCLUIDO (R-A12), en una ventana. */
function revenueByProject(classified: readonly Classified[], window: DateWindow): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const c of classified) {
    if (c.analyticType !== "INGRESO_DIRECTO" || !c.line.projectId) continue
    if (!within(c.line.entryDate, window)) continue
    if (REVENUE_SHARE_EXCLUDED_PREFIXES.some((p) => c.line.accountCode.startsWith(p))) continue
    out.set(c.line.projectId, (out.get(c.line.projectId) ?? 0) + c.amountCents)
  }
  return out
}

/** Coste directo MC1 + MC2 por proyecto (positivo), en una ventana. */
function directCostByProject(classified: readonly Classified[], window: DateWindow): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const c of classified) {
    if (c.analyticType !== "COSTE_DIRECTO_MC1" && c.analyticType !== "COSTE_DIRECTO_MC2") continue
    if (!c.line.projectId || !within(c.line.entryDate, window)) continue
    out.set(c.line.projectId, (out.get(c.line.projectId) ?? 0) - c.amountCents)
  }
  return out
}

/**
 * `own(s,P)` — saldo propio del CECO: `Σ −aporte` de las líneas con tipo
 * efectivo `INDIRECTO_CECO` y ese CECO. Nunca `AMORTIZACION_DETERIORO` (nivel
 * EBIT, R-A5), ni `FINANCIERO`, ni `EXTRAORDINARIO`, ni `NO_ANALITICO`.
 */
export function costCenterOwnCents(
  classified: readonly Classified[],
  window: DateWindow
): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const c of classified) {
    if (c.analyticType !== "INDIRECTO_CECO" || !c.line.costCenterId) continue
    if (!within(c.line.entryDate, window)) continue
    out.set(c.line.costCenterId, (out.get(c.line.costCenterId) ?? 0) - c.amountCents)
  }
  return out
}

/**
 * Base liquidable POR NIVEL: `own(s,P)|ℓ − yaRepartido(s,P,ℓ) + recibido(s,R,ℓ)`.
 *
 * `own` entra en el nivel del propio CECO; lo recibido en cascada conserva el
 * nivel con el que viajó (E5-D1). Un CECO puede sostener a la vez un bucket MC3
 * (suyo) y uno EBITDA (recibido), y cada uno se reparte por separado.
 */
export function liquidableBase(
  sourceCostCenterId: string,
  input: AllocationInput,
  ctx: {
    own: ReadonlyMap<string, Cents>
    cecoById: Indexes["cecoById"]
    received: ReadonlyMap<string, Cents>
  }
): Map<CostCenterMarginLevel, Cents> {
  const base = new Map<CostCenterMarginLevel, Cents>()
  const add = (level: CostCenterMarginLevel, cents: Cents): void => {
    base.set(level, (base.get(level) ?? 0) + cents)
  }

  const ceco = ctx.cecoById.get(sourceCostCenterId)
  if (ceco) add(ceco.marginLevel, ctx.own.get(sourceCostCenterId) ?? 0)

  const window: DateWindow = { from: input.period.start, to: input.period.end }
  for (const prior of input.priorAllocations) {
    if (prior.sourceCostCenterId !== sourceCostCenterId) continue
    if (!contains(window, { from: prior.runPeriodStart, to: prior.runPeriodEnd })) continue
    add(prior.marginLevel, -prior.amountCents)
  }
  for (const level of ALLOCATABLE_LEVELS) {
    const received = ctx.received.get(level)
    if (received) add(level, received)
  }
  for (const [level, cents] of [...base.entries()]) if (cents === 0) base.delete(level)
  return base
}

// ─────────────────────────────────────────────────────────────────────────────
// Elegibilidad y pesos del driver
// ─────────────────────────────────────────────────────────────────────────────

const DRIVERS_OF_ACTIVITY: ReadonlySet<Driver> = new Set<Driver>(["REVENUE_SHARE", "DIRECT_COST_SHARE", "HOURS"])

function eligibleProjects(
  rule: AllocationRuleSpec,
  config: AnalyticsConfig,
  activityByProject: ReadonlyMap<string, Cents>
): { project: AnalyticsConfig["projects"][number]; eligibilityReason: "ACTIVITY_IN_PERIOD" | null }[] {
  const filter = rule.targetFilter ?? {}
  const wanted = filter.projectStatus ?? ["ACTIVE"]
  const excluded = new Set(filter.excludeProjectCodes ?? [])
  const out: { project: AnalyticsConfig["projects"][number]; eligibilityReason: "ACTIVITY_IN_PERIOD" | null }[] = []
  for (const project of config.projects) {
    if (excluded.has(project.code)) continue
    // Una dimensión archivada NUNCA es destino (§1.3, I-E5-7).
    if (!project.isActive) continue
    // Un proyecto PLANNED no recibe imputación tenga o no base: cargarle
    // estructura crea un margen negativo antes del primer ingreso.
    if (project.status === "PLANNED") continue
    if (wanted.includes(project.status)) {
      out.push({ project, eligibilityReason: null })
      continue
    }
    // §1.3 — un proyecto que consumió estructura en enero y cerró en marzo DEBE
    // cargar con la estructura de enero: excluirlo la trasladaría a los vivos y
    // falsearía dos márgenes a la vez. Sólo para drivers de actividad.
    if (project.status === "CLOSED" && DRIVERS_OF_ACTIVITY.has(rule.driver) && (activityByProject.get(project.id) ?? 0) > 0) {
      out.push({ project, eligibilityReason: "ACTIVITY_IN_PERIOD" })
    }
  }
  return out.sort((a, b) => (a.project.code < b.project.code ? -1 : a.project.code > b.project.code ? 1 : 0))
}

type WeightRow = {
  target: AllocationTargetRef
  weight: number
  eligibilityReason: "ACTIVITY_IN_PERIOD" | null
}

type DriverWeights = {
  rows: readonly WeightRow[]
  fallbackApplied: ZeroBaseFallback | null
}

/**
 * Pesos del driver por receptor elegible, **leídos del diario** (§1.1), nunca de
 * memoria ni de una tabla de resultados. Un receptor con base negativa recibe
 * peso 0 y queda excluido (§1.3): un peso negativo daría cuotas > 100 % a los
 * demás y un **ingreso** de estructura al que devolvió.
 */
export function driverWeights(
  rule: AllocationRuleSpec,
  input: AllocationInput,
  ctx: {
    classified: readonly Classified[]
    indexes: Indexes
    warnings: AllocationWarning[]
    unallocatedCents: Cents
  }
): DriverWeights {
  const { indexes } = ctx
  const label = input.period.label
  const window: DateWindow = { from: input.period.start, to: input.period.end }

  // Targets explícitos: la base es la propia tabla de targets, no el diario.
  // **Sólo** `FIXED_PERCENT` y `MANUAL` (BLOQUEA #1): con cualquier otro driver
  // los pesos salen del diario y del filtro, y `validate()` ya ha rechazado la
  // combinación con `TARGETS_REQUIRED` antes de llegar aquí.
  if (rule.driver === "FIXED_PERCENT" || rule.driver === "MANUAL") {
    const rows: WeightRow[] = []
    for (const target of [...rule.targets].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      const ref = targetRefOf(target, indexes)
      if (!ref) continue
      rows.push({ target: ref, weight: rule.driver === "MANUAL" ? 0 : (target.percentBps ?? 0), eligibilityReason: null })
    }
    return { rows, fallbackApplied: null }
  }

  const source: ReadonlyMap<string, Cents> | null =
    rule.driver === "REVENUE_SHARE"
      ? revenueByProject(ctx.classified, window)
      : rule.driver === "DIRECT_COST_SHARE"
        ? directCostByProject(ctx.classified, window)
        : null

  const eligible = eligibleProjects(rule, input.config, source ?? new Map())

  if (rule.driver === "EQUAL") {
    return {
      rows: eligible.map((e) => ({
        target: { kind: "PROJECT", id: e.project.id, code: e.project.code },
        weight: 1,
        eligibilityReason: e.eligibilityReason,
      })),
      fallbackApplied: null,
    }
  }

  if (source === null) return { rows: [], fallbackApplied: null }

  const rows: WeightRow[] = eligible.map((e) => ({
    target: { kind: "PROJECT" as const, id: e.project.id, code: e.project.code },
    weight: Math.max(0, source.get(e.project.id) ?? 0),
    eligibilityReason: e.eligibilityReason,
  }))
  const negatives = eligible.filter((e) => (source.get(e.project.id) ?? 0) < 0).map((e) => e.project.code)
  if (negatives.length > 0) {
    ctx.warnings.push({
      code: "W-E5-NEG-BASE",
      ruleCode: rule.code,
      period: label,
      targets: negatives,
      detail: "base negativa en el periodo: peso 0, excluido del reparto",
    })
  }
  if (rows.reduce((a, r) => a + r.weight, 0) !== 0) return { rows, fallbackApplied: null }

  // Base cero (§1.2): el fallback es CONFIGURACIÓN declarada, nunca una decisión
  // enterrada en el código, y el aplicado se escribe en cada línea.
  const fallback = rule.zeroBaseFallback
  ctx.warnings.push({
    code: "W-E5-ZERO-BASE",
    ruleCode: rule.code,
    period: label,
    fallback,
    unallocatedCents: ctx.unallocatedCents,
    detail: "base del driver = 0 en el periodo",
  })
  if (fallback === "SKIP_WARN") return { rows: [], fallbackApplied: null }
  if (fallback === "EQUAL") {
    return { rows: rows.map((r) => ({ ...r, weight: 1 })), fallbackApplied: "EQUAL" }
  }
  const widened: DateWindow =
    fallback === "YTD"
      ? { from: input.period.fiscalYearStart, to: input.period.end }
      : priorPeriodWindow(input.period.kind, label)
  const widenedSource =
    rule.driver === "REVENUE_SHARE" ? revenueByProject(ctx.classified, widened) : directCostByProject(ctx.classified, widened)
  const widenedRows = rows.map((r) => ({ ...r, weight: Math.max(0, widenedSource.get(r.target.id) ?? 0) }))
  // (b) si el fallback tampoco produce base > 0, se degrada a `SKIP_WARN`.
  if (widenedRows.reduce((a, r) => a + r.weight, 0) === 0) return { rows: [], fallbackApplied: null }
  return { rows: widenedRows, fallbackApplied: fallback }
}

function targetRefOf(target: RuleTargetSpec, indexes: Indexes): AllocationTargetRef | null {
  if (target.projectId) {
    const p = indexes.projectById.get(target.projectId)
    return p ? { kind: "PROJECT", id: p.id, code: p.code } : null
  }
  if (target.businessLineId) {
    const b = indexes.blById.get(target.businessLineId)
    return b ? { kind: "BUSINESS_LINE", id: b.id, code: b.code } : null
  }
  if (target.costCenterId) {
    const c = indexes.cecoById.get(target.costCenterId)
    return c ? { kind: "COST_CENTER", id: c.id, code: c.code } : null
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación previa (pasos 1–5 de §3.1)
// ─────────────────────────────────────────────────────────────────────────────

/** Reglas vigentes a `periodEnd`, activas y del MISMO `period` que el run. */
export function effectiveRules(rules: readonly AllocationRuleSpec[], period: AllocationPeriodRef): AllocationRuleSpec[] {
  return rules
    .filter(
      (r) =>
        r.isActive &&
        r.period === period.kind &&
        r.validFrom <= period.end &&
        (r.validTo === null || r.validTo >= period.end)
    )
    .sort((a, b) => a.priority - b.priority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

function validate(
  rules: readonly AllocationRuleSpec[],
  input: AllocationInput,
  indexes: Indexes
): AllocationError | null {
  const period = input.period
  if (period.start < period.fiscalYearStart || period.end > period.fiscalYearEnd) {
    return {
      code: "PERIOD_CROSSES_FISCAL_YEAR",
      message: `el periodo ${period.label} (${period.start} … ${period.end}) no cabe en el ejercicio ${period.fiscalYearStart} … ${period.fiscalYearEnd}: un run pertenece a UN ejercicio`,
    }
  }

  for (const rule of rules) {
    if (rule.driver === "HOURS" || rule.driver === "HEADCOUNT") {
      return {
        code: "DRIVER_UNAVAILABLE",
        message: `el driver ${rule.driver === "HOURS" ? "HORAS" : "PLANTILLA"} de la regla ${rule.code} necesita partes de horas, que llegan en E10. Elige otro driver o deja el CECO sin liquidar`,
        ruleCodes: [rule.code],
      }
    }
    // BLOQUEA #1 / ADR-0013 D4 — CONTRATO de `targetKind` × `driver`.
    //
    // Los pesos de un driver CALCULADO (`REVENUE_SHARE`, `DIRECT_COST_SHARE`,
    // `EQUAL`) se leen del diario POR PROYECTO: una línea de negocio o un centro
    // de coste no tienen «ingreso directo» ni «coste directo» propios con los que
    // ponderar. Por eso un destino `COST_CENTERS` / `BUSINESS_LINES` sólo se
    // declara con destinos EXPLÍCITOS (`FIXED_PERCENT`, `MANUAL`). Antes, la
    // combinación se guardaba y repartía 0 € sin decir nada: exactamente la
    // «regla inerte» que D4 prohíbe.
    if (rule.targetKind === "COST_CENTERS" || rule.targetKind === "BUSINESS_LINES") {
      if (rule.driver !== "FIXED_PERCENT" && rule.driver !== "MANUAL") {
        return {
          code: "TARGETS_REQUIRED",
          message: `la regla ${rule.code} reparte a ${rule.targetKind === "COST_CENTERS" ? "centros de coste" : "líneas de negocio"} con el driver ${rule.driver}, que calcula sus pesos por proyecto desde el diario: declara los destinos con porcentaje fijo (FIXED_PERCENT) o con importes (MANUAL)`,
          ruleCodes: [rule.code],
        }
      }
      if (rule.targets.length === 0) {
        return {
          code: "TARGETS_REQUIRED",
          message: `la regla ${rule.code} reparte a ${rule.targetKind === "COST_CENTERS" ? "centros de coste" : "líneas de negocio"} y no declara ningún destino: no repartiría un céntimo`,
          ruleCodes: [rule.code],
        }
      }
    }
    if ((rule.driver === "FIXED_PERCENT" || rule.driver === "MANUAL") && rule.targets.length === 0) {
      return {
        code: "TARGETS_REQUIRED",
        message: `la regla ${rule.code} usa el driver ${rule.driver} y no declara ningún destino: los destinos explícitos son su única base de reparto`,
        ruleCodes: [rule.code],
      }
    }
    const source = indexes.cecoById.get(rule.sourceCostCenterId)
    if (!source || !source.allocatable || !source.isActive) {
      return {
        code: "SOURCE_NOT_ALLOCATABLE",
        message: `el centro de coste fuente de la regla ${rule.code} (${source?.code ?? rule.sourceCostCenterId}) no es imputable`,
        ruleCodes: [rule.code],
      }
    }
    for (const target of rule.targets) {
      if (!target.costCenterId) continue
      const ceco = indexes.cecoById.get(target.costCenterId)
      if (!ceco || !ceco.allocatable || !ceco.isActive) {
        return {
          code: "ALLOCATION_TARGET_NOT_ALLOCATABLE",
          message: `la regla ${rule.code} tiene por destino el centro de coste ${ceco?.code ?? target.costCenterId}, que no es imputable: quedaría con saldo inmovilizado y sin regla para sacarlo`,
          ruleCodes: [rule.code],
        }
      }
    }
    if (rule.driver === "FIXED_PERCENT") {
      const sum = rule.targets.reduce((a, t) => a + (t.percentBps ?? 0), 0)
      if (sum !== 10000) {
        return {
          code: "FIXED_PERCENT_NOT_100",
          message: `la regla ${rule.code} reparte ${formatBps(sum)} % entre sus destinos: Σ de porcentajes debe ser exactamente 100 %`,
          ruleCodes: [rule.code],
        }
      }
    }
  }

  // I-E5-3: Σ sourceShareBps = 10000 por (fuente, period) vigente.
  const bySource = new Map<string, { sum: number; codes: string[] }>()
  for (const rule of rules) {
    const entry = bySource.get(rule.sourceCostCenterId) ?? { sum: 0, codes: [] }
    entry.sum += rule.sourceShareBps
    entry.codes.push(rule.code)
    bySource.set(rule.sourceCostCenterId, entry)
  }
  for (const [cecoId, entry] of [...bySource.entries()].sort()) {
    if (entry.sum === 10000) continue
    const code = indexes.cecoById.get(cecoId)?.code ?? cecoId
    return {
      code: "SOURCE_SHARE_NOT_100",
      message: `las reglas de ${code} (${period.kind}) reparten el ${formatBps(entry.sum)} % de su saldo: falta declarar qué pasa con el ${formatBps(10000 - entry.sum)} % restante`,
      ruleCodes: entry.codes,
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Núcleo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liquidación de UN periodo. Idéntica a `previewAllocation`: `allocate` existe
 * por legibilidad del llamante —`models/allocations.ts` simula con una y sella
 * con la otra— y un test comprueba que devuelven el MISMO objeto (P7).
 */
export function allocate(input: AllocationInput): Result<AllocationResult, AllocationError> {
  const indexes = indexesOf(input.config)
  const rules = effectiveRules(input.rules, input.period)
  const runId = input.runId ?? `RUN-${input.period.label}`

  const graph = buildAllocationGraph(rules)
  const cycle = findCycle(graph)
  if (cycle) {
    const names = cycle.map((id) => indexes.cecoById.get(id)?.code ?? id)
    return err(
      "ALLOCATION_CYCLE",
      `las reglas forman un ciclo: ${names.join(" → ")}. Ninguna liquidación puede resolverlo`
    )
  }
  const notTopological = checkTopologicalOrder(rules, graph)
  if (notTopological.length > 0) {
    return err(
      "ALLOCATION_PRIORITY_NOT_TOPOLOGICAL",
      `la prioridad de las reglas no es un orden topológico de la cascada: ${notTopological
        .map((e) => `${e.from} → ${e.to}`)
        .join("; ")}`,
      notTopological.map((e) => e.from)
    )
  }
  const invalid = validate(rules, input, indexes)
  if (invalid) return { ok: false, error: invalid }

  const classified = classify(input)
  const own = costCenterOwnCents(classified, { from: input.period.start, to: input.period.end })
  const warnings: AllocationWarning[] = []
  const lines: AppliedAllocation[] = []
  const rulesApplied: string[] = []

  /** Lo recibido en cascada DENTRO de este run, por `(cecoId, nivel)`. */
  const received = new Map<string, Map<CostCenterMarginLevel, Cents>>()
  /** Porción del saldo que toca a cada regla, por `(cecoId|ruleCode, nivel)`. */
  const slice = new Map<string, Map<CostCenterMarginLevel, Cents>>()
  /** Base liquidable calculada al ejecutar la primera regla de cada fuente. */
  const baseOf = new Map<string, Map<CostCenterMarginLevel, Cents>>()
  const liquidated = new Map<string, Map<CostCenterMarginLevel, Cents>>()
  const allocatedOut = new Map<string, Map<CostCenterMarginLevel, Cents>>()

  const bump = (
    store: Map<string, Map<CostCenterMarginLevel, Cents>>,
    key: string,
    level: CostCenterMarginLevel,
    cents: Cents
  ): void => {
    const inner = store.get(key) ?? new Map<CostCenterMarginLevel, Cents>()
    inner.set(level, (inner.get(level) ?? 0) + cents)
    store.set(key, inner)
  }

  const rulesBySource = new Map<string, AllocationRuleSpec[]>()
  for (const rule of rules) {
    const list = rulesBySource.get(rule.sourceCostCenterId) ?? []
    list.push(rule)
    rulesBySource.set(rule.sourceCostCenterId, list)
  }

  for (const rule of rules) {
    const sourceId = rule.sourceCostCenterId
    const sourceCode = indexes.cecoById.get(sourceId)?.code ?? sourceId

    // La base de cada fuente se recalcula AL EJECUTAR SU PRIMERA REGLA, con lo
    // recibido en cascada dentro del propio run ya incluido: así un CECO que
    // recibe y reparte en la misma liquidación funciona sin pasada extra. El
    // orden topológico garantiza que ya ha recibido todo lo que va a recibir.
    if (!baseOf.has(sourceId)) {
      const base = liquidableBase(sourceId, input, {
        own,
        cecoById: indexes.cecoById,
        received: received.get(sourceId) ?? new Map(),
      })
      baseOf.set(sourceId, base)
      const siblings = rulesBySource.get(sourceId) ?? []
      // Paso 7, primer Hamilton: el saldo del CECO se reparte entre SUS reglas
      // por `sourceShareBps`, también con mayor resto para que Σ sea exacta.
      for (const [level, cents] of base.entries()) {
        const parts = hamilton(
          cents,
          siblings.map((r) => ({ code: r.code, weight: r.sourceShareBps }))
        )
        for (const part of parts) {
          if (part.amountCents === 0) continue
          bump(slice, `${sourceId}|${part.code}`, level, part.amountCents)
          bump(liquidated, sourceId, level, part.amountCents)
        }
      }
    }

    const portion = slice.get(`${sourceId}|${rule.code}`)
    if (!portion || portion.size === 0) continue

    const unallocated = [...portion.values()].reduce((a, b) => a + b, 0)
    const warningsBefore = warnings.length
    const weights = driverWeights(rule, input, { classified, indexes, warnings, unallocatedCents: unallocated })
    const weightTotal = weights.rows.reduce((a, r) => a + r.weight, 0)
    const declaredZeroBase = warnings
      .slice(warningsBefore)
      .some((w) => w.code === "W-E5-ZERO-BASE" && w.ruleCode === rule.code)

    if (rule.driver === "MANUAL") {
      // I-E5-10: Σ importes = base liquidable, comprobado ANTES de persistir.
      const declared = [...rule.targets].reduce((a, t) => a + (t.amountCents ?? 0), 0)
      if (declared !== unallocated) {
        return err(
          "MANUAL_AMOUNT_MISMATCH",
          `la regla manual ${rule.code} declara ${declared} c y la base liquidable de ${sourceCode} en ${input.period.label} es ${unallocated} c: un reparto manual no se reescala solo`,
          [rule.code]
        )
      }
      const levels = [...portion.keys()].sort()
      // Un `MANUAL` sólo es representable con un único nivel: si el CECO
      // sostiene dos buckets, los importes declarados no dicen a cuál van.
      if (levels.length > 1) {
        return err(
          "MANUAL_AMOUNT_MISMATCH",
          `la regla manual ${rule.code} liquida ${sourceCode} en dos niveles de margen (${levels.join(", ")}): declara una regla por nivel`,
          [rule.code]
        )
      }
      const level = levels[0]
      const sorted = [...rule.targets].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      for (const target of sorted) {
        const ref = targetRefOf(target, indexes)
        if (!ref || !target.amountCents) continue
        lines.push({
          runId,
          ruleId: rule.id,
          ruleCode: rule.code,
          sourceCostCenterId: sourceId,
          sourceCostCenterCode: sourceCode,
          targetKind: rule.targetKind,
          target: ref,
          marginLevel: level,
          amountCents: target.amountCents,
          driverBase: Math.abs(target.amountCents),
          driverBaseTotal: Math.abs(declared),
          driverShareBps: declared === 0 ? 0 : Math.floor((Math.abs(target.amountCents) * 10000) / Math.abs(declared)),
          fallbackApplied: null,
          eligibilityReason: null,
        })
        if (ref.kind === "COST_CENTER") bump(received, ref.id, level, target.amountCents)
      }
      bump(allocatedOut, sourceId, level, unallocated)
      if (!rulesApplied.includes(rule.code)) rulesApplied.push(rule.code)
      continue
    }

    if (weights.rows.length === 0 || weightTotal === 0) {
      // ADR-0013 D4 — la regla tiene saldo y no puede repartirlo. Que la base del
      // driver sea 0 es un caso DECLARADO (`zeroBaseFallback`, con su aviso
      // `W-E5-ZERO-BASE`); no tener receptores, o que ninguno pese, no lo es: es
      // una regla inerte, y una regla inerte se rechaza, no se ignora.
      if (declaredZeroBase) continue
      return err(
        "RULE_INERT",
        `la regla ${rule.code} liquida ${unallocated} c de ${sourceCode} en ${input.period.label} y no tiene ningún receptor con peso: revisa el filtro de destinos, el driver o los destinos declarados`,
        [rule.code]
      )
    }

    // Los niveles en orden alfabético: EBITDA antes que MC3. Es arbitrario pero
    // TOTAL, que es lo que la reproducibilidad byte a byte exige.
    for (const level of [...portion.keys()].sort()) {
      const amount = portion.get(level) ?? 0
      if (amount === 0) continue
      // Paso 7, segundo Hamilton: la fracción de la regla entre sus receptores.
      const parts = hamilton(
        amount,
        weights.rows.map((r) => ({ code: r.target.code, weight: r.weight }))
      )
      const byCode = new Map(weights.rows.map((r) => [r.target.code, r]))
      for (const part of parts) {
        const row = byCode.get(part.code)
        if (!row) continue
        if (part.amountCents === 0 && part.shareBps === 0) continue
        lines.push({
          runId,
          ruleId: rule.id,
          ruleCode: rule.code,
          sourceCostCenterId: sourceId,
          sourceCostCenterCode: sourceCode,
          targetKind: rule.targetKind,
          target: row.target,
          // E5-D1: el nivel es el del CECO donde nació el gasto, NO el del
          // receptor ni el del emisor intermedio. Cambiarlo movería importe
          // entre niveles y tumbaría I4.a en la fila MC3.
          marginLevel: level,
          amountCents: part.amountCents,
          driverBase: row.weight,
          driverBaseTotal: weightTotal,
          driverShareBps: part.shareBps,
          fallbackApplied: weights.fallbackApplied,
          eligibilityReason: row.eligibilityReason,
        })
        if (row.target.kind === "COST_CENTER") bump(received, row.target.id, level, part.amountCents)
      }
      bump(allocatedOut, sourceId, level, amount)
      if (!rulesApplied.includes(rule.code)) rulesApplied.push(rule.code)
    }
  }

  // I5.a hecha dato: base, liquidado y residual por `(fuente, nivel)`.
  const emitted = new Map<string, Cents>()
  for (const line of lines) {
    const key = `${line.sourceCostCenterId}|${line.marginLevel}`
    emitted.set(key, (emitted.get(key) ?? 0) + line.amountCents)
  }
  const balances: SourceBalance[] = []
  for (const [sourceId, base] of [...baseOf.entries()].sort()) {
    const code = indexes.cecoById.get(sourceId)?.code ?? sourceId
    const levels = new Set<CostCenterMarginLevel>([
      ...base.keys(),
      ...(liquidated.get(sourceId)?.keys() ?? []),
      ...(allocatedOut.get(sourceId)?.keys() ?? []),
    ])
    for (const level of [...levels].sort()) {
      const baseCents = base.get(level) ?? 0
      const liq = allocatedOut.get(sourceId)?.get(level) ?? 0
      const alloc = emitted.get(`${sourceId}|${level}`) ?? 0
      balances.push({
        sourceCostCenterId: sourceId,
        sourceCostCenterCode: code,
        marginLevel: level,
        baseCents,
        liquidatedCents: liq,
        allocatedCents: alloc,
        residualCents: alloc - liq,
        pendingCents: baseCents - liq,
      })
    }
  }

  return ok({
    runId,
    period: input.period,
    lines,
    balances,
    warnings,
    rulesApplied,
    totalAllocatedCents: lines.reduce((a, l) => a + l.amountCents, 0),
  })
}

/**
 * **Simulación**: mismo cálculo que `allocate`, sin sellos y sin efectos. Es lo
 * que la UI muestra antes de liquidar, y lo que hace que un run sellado nunca
 * sorprenda: el usuario aprueba EXACTAMENTE lo que se va a persistir.
 */
export const previewAllocation = (input: AllocationInput): Result<AllocationResult, AllocationError> => allocate(input)

// ─────────────────────────────────────────────────────────────────────────────
// I5.a fuera del motor: base liquidable RECONSTRUIDA desde lo persistido
// (auditoría E5, hallazgo 2)
// ─────────────────────────────────────────────────────────────────────────────

/** Un run VIGENTE tal y como lo ve el barrido de invariantes. */
export type SealedRunRef = { id: string; periodStart: LocalDate; periodEnd: LocalDate }

export type ReconstructedBalance = SourceBalance & { runId: string }

/**
 * Base liquidable por `(run, CECO fuente, nivel)` reconstruida **desde el diario
 * y las líneas persistidas**, sin volver a ejecutar el motor.
 *
 * `checkI5` comprueba I5.a recorriendo `input.balances`, y el único llamante de
 * producción no las aportaba: el PASS declaraba «0 combinación(es)» y I5.a no se
 * evaluaba nunca fuera de los tests unitarios (hallazgo 2 del auditor). Esto la
 * repone por un camino INDEPENDIENTE del que produjo las líneas — la base sale
 * del diario, no de lo que el motor dijo en su día—, que es lo que le da valor:
 * un `UPDATE` sobre `allocation_lines` mueve el repartido y no la base, y la
 * diferencia aparece.
 *
 *   base(R, s, ℓ) = own(s, periodo de R)|ℓ − yaRepartido(runs ⊊ R) + recibido(en R)
 *
 * Sólo se emiten las combinaciones que el run REPARTIÓ: un CECO con base y sin
 * regla no es un descuadre de I5.a (lo cubre I5.b), es saldo pendiente.
 */
export function reconstructBalances(input: {
  lines: readonly AnalyticLine[]
  config: AnalyticsConfig
  runs: readonly SealedRunRef[]
  allocations: readonly AppliedAllocation[]
}): ReconstructedBalance[] {
  const classified = classifyLines(input.lines, input.config)
  const cecoById = new Map(input.config.costCenters.map((c) => [c.id, c]))
  const byRun = new Map<string, AppliedAllocation[]>()
  for (const a of input.allocations) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a])

  const out: ReconstructedBalance[] = []
  for (const run of [...input.runs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const mine = byRun.get(run.id) ?? []
    if (mine.length === 0) continue
    const window: DateWindow = { from: run.periodStart, to: run.periodEnd }
    const own = costCenterOwnCents(classified, window)

    // `yaRepartido`: runs vigentes de periodo ESTRICTAMENTE contenido en el de R
    // (el mismo filtro que `loadRunContext`).
    const prior = new Map<string, Cents>()
    for (const other of input.runs) {
      if (other.id === run.id) continue
      if (other.periodStart < run.periodStart || other.periodEnd > run.periodEnd) continue
      if (other.periodStart === run.periodStart && other.periodEnd === run.periodEnd) continue
      for (const a of byRun.get(other.id) ?? []) {
        const key = `${a.sourceCostCenterId}|${a.marginLevel}`
        prior.set(key, (prior.get(key) ?? 0) + a.amountCents)
      }
    }

    const received = new Map<string, Cents>()
    const allocated = new Map<string, Cents>()
    for (const a of mine) {
      const outKey = `${a.sourceCostCenterId}|${a.marginLevel}`
      allocated.set(outKey, (allocated.get(outKey) ?? 0) + a.amountCents)
      if (a.target.kind === "COST_CENTER") {
        const inKey = `${a.target.id}|${a.marginLevel}`
        received.set(inKey, (received.get(inKey) ?? 0) + a.amountCents)
      }
    }

    for (const key of [...allocated.keys()].sort()) {
      const [sourceId, level] = key.split("|") as [string, CostCenterMarginLevel]
      const ceco = cecoById.get(sourceId)
      const ownCents = ceco && ceco.marginLevel === level ? (own.get(sourceId) ?? 0) : 0
      const baseCents = ownCents - (prior.get(key) ?? 0) + (received.get(key) ?? 0)
      const allocatedCents = allocated.get(key) ?? 0
      out.push({
        runId: run.id,
        sourceCostCenterId: sourceId,
        sourceCostCenterCode: ceco?.code ?? sourceId,
        marginLevel: level,
        baseCents,
        // Σ sourceShareBps = 10000 por (fuente, periodicidad) vigente (I-E5-3),
        // así que lo que las reglas del periodo declaran liquidar ES la base.
        liquidatedCents: baseCents,
        allocatedCents,
        residualCents: allocatedCents - baseCents,
        pendingCents: 0,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellos y serialización canónica
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")
const NULL_TOKEN = "∅"

/**
 * Forma canónica de las reglas vigentes, ordenada por `(priority, code)`, CON
 * `sourceShareBps`, `zeroBaseFallback`, `targetFilter` y los targets dentro. Sin
 * cualquiera de los cuatro, cambiar una regla no cambiaría el sello y un run
 * caducado pasaría por vigente.
 */
export function canonicalRulesForm(rules: readonly AllocationRuleSpec[]): string {
  return [...rules]
    .sort((a, b) => a.priority - b.priority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((r) =>
      [
        r.code,
        r.sourceCostCenterId,
        r.targetKind,
        r.driver,
        r.period,
        String(r.priority),
        String(r.sourceShareBps),
        r.zeroBaseFallback,
        r.targetFilter === null ? NULL_TOKEN : JSON.stringify(r.targetFilter, Object.keys(r.targetFilter).sort()),
        r.validFrom,
        r.validTo ?? NULL_TOKEN,
        r.isActive ? "1" : "0",
        [...r.targets]
          .map((t) =>
            [t.projectId ?? NULL_TOKEN, t.businessLineId ?? NULL_TOKEN, t.costCenterId ?? NULL_TOKEN, String(t.percentBps ?? NULL_TOKEN), String(t.amountCents ?? NULL_TOKEN)].join(
              ","
            )
          )
          .sort()
          .join(";"),
      ].join("\t")
    )
    .join("\n")
}

export const rulesHash = (rules: readonly AllocationRuleSpec[]): string => sha256(canonicalRulesForm(rules))

/**
 * Forma canónica de las LÍNEAS de un run (auditoría E5, hallazgo 1).
 *
 * El run sellaba `ledgerHash`, `analyticsHash`, `rulesHash` y `gitSha` — es
 * decir, sus ENTRADAS— pero ningún hash de su SALIDA. Consecuencia demostrada
 * por el auditor: mover el céntimo de remanente de Hamilton entre dos receptores
 * del mismo (run, regla, nivel) por `UPDATE` directo mantiene la Σ por fuente,
 * el cierre a 0, la cota de I-E5-4 y el total del run, y **todos los invariantes
 * daban PASS** pese a que el reparto ya no era el que dicta el desempate por
 * menor código (P7). Con `linesHash`, esa alteración se ve.
 *
 * El orden es TOTAL y no depende del orden de lectura: `(regla, fuente, tipo de
 * destino, destino, nivel)` identifica una línea dentro de un run, y el importe
 * y las columnas del driver van dentro del hash.
 */
export function canonicalLinesForm(lines: readonly AppliedAllocation[]): string {
  return [...lines]
    .map((l) =>
      [
        l.ruleCode,
        l.sourceCostCenterCode,
        l.target.kind,
        l.target.code,
        l.marginLevel,
        String(l.amountCents),
        String(l.driverBase),
        String(l.driverBaseTotal),
        String(l.driverShareBps),
        l.fallbackApplied ?? NULL_TOKEN,
        l.eligibilityReason ?? NULL_TOKEN,
      ].join("\t")
    )
    .sort()
    .join("\n")
}

export const linesHash = (lines: readonly AppliedAllocation[]): string => sha256(canonicalLinesForm(lines))

/** Fila serializable de `liquidacion-esperada.json` (`allocationLines`). */
export type CanonicalAllocationLine = {
  runId: string
  ruleCode: string
  sourceCostCenterCode: string
  targetKind: TargetKind
  target: string
  marginLevel: MarginLevel
  amountCents: Cents
  driverBase: number
  driverBaseTotal: number
  driverShareBps: number
  fallback: ZeroBaseFallback | null
}

export const canonicalLine = (line: AppliedAllocation): CanonicalAllocationLine => ({
  runId: line.runId,
  ruleCode: line.ruleCode,
  sourceCostCenterCode: line.sourceCostCenterCode,
  targetKind: line.targetKind,
  target: line.target.code,
  marginLevel: line.marginLevel,
  amountCents: line.amountCents,
  driverBase: line.driverBase,
  driverBaseTotal: line.driverBaseTotal,
  driverShareBps: line.driverShareBps,
  fallback: line.fallbackApplied,
})

/** Fila serializable de `liquidacion-esperada.json` (`warnings`). */
export function canonicalWarning(w: AllocationWarning): Record<string, unknown> {
  if (w.code === "W-E5-ZERO-BASE") {
    return { code: w.code, rule: w.ruleCode, period: w.period, fallback: w.fallback, detail: w.detail }
  }
  return { code: w.code, rule: w.ruleCode, period: w.period, targets: [...w.targets], detail: w.detail }
}

export type CanonicalRunRow = {
  runId: string
  period: string
  periodKind: AllocPeriod
  periodStart: LocalDate
  periodEnd: LocalDate
  rulesApplied: readonly string[]
  lineCount: number
  totalAllocatedCents: Cents
  supersededById: string | null
  reversedAt: string | null
}

export const canonicalRun = (result: AllocationResult): CanonicalRunRow => ({
  runId: result.runId,
  period: result.period.label,
  periodKind: result.period.kind,
  periodStart: result.period.start,
  periodEnd: result.period.end,
  // El generador ordena los códigos; el motor los devuelve en orden de
  // ejecución, que es la misma información con otra clave de orden.
  rulesApplied: [...result.rulesApplied].sort(),
  lineCount: result.lines.length,
  totalAllocatedCents: result.totalAllocatedCents,
  supersededById: null,
  reversedAt: null,
})

export type CanonicalCtx = {
  schemaVersion: string
  generatedBy: string
  note: string
  source: { fixture: string; e4Expected: string; fiscalYear: string; excludedKinds: readonly string[] }
  /** Las reglas TAL CUAL el JSON sellado las escribe (códigos, no ids). */
  rules: unknown
  driverBases: unknown
  levels: readonly string[]
  columns: readonly string[]
  allocationDeltaCents: Record<string, Record<string, Cents>>
  matrixCents: Record<string, Record<string, Cents>>
  businessLineMatrixCents: Record<string, Record<string, Cents>>
  levelTotalsCents: Record<string, Cents>
  levelTotalsE4Cents: Record<string, Cents>
  pygContableCents: Cents
  lineCount67: number
  annexHoursIllustrative: unknown
  checks: unknown
}

/**
 * Serialización byte-idéntica a `docs/design/fixtures/liquidacion-esperada.json`
 * (`json.dumps(..., ensure_ascii=False, indent=2) + "\n"`). El orden de las
 * claves es el del generador: cambiarlo rompe el test byte a byte, que es
 * exactamente lo que debe pasar.
 */
export function canonicalAllocationJson(
  runs: readonly CanonicalRunRow[],
  lines: readonly CanonicalAllocationLine[],
  warnings: readonly AllocationWarning[],
  ctx: CanonicalCtx
): string {
  const out = {
    schemaVersion: ctx.schemaVersion,
    generatedBy: ctx.generatedBy,
    note: ctx.note,
    source: ctx.source,
    rules: ctx.rules,
    driverBases: ctx.driverBases,
    runs,
    allocationLines: lines,
    warnings: warnings.map(canonicalWarning),
    levels: ctx.levels,
    columns: ctx.columns,
    allocationDeltaCents: ctx.allocationDeltaCents,
    matrixCents: ctx.matrixCents,
    businessLineMatrixCents: ctx.businessLineMatrixCents,
    levelTotalsCents: ctx.levelTotalsCents,
    levelTotalsE4Cents: ctx.levelTotalsE4Cents,
    pygContableCents: ctx.pygContableCents,
    lineCount67: ctx.lineCount67,
    annexHoursIllustrative: ctx.annexHoursIllustrative,
    checks: ctx.checks,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
