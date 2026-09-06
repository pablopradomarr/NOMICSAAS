/**
 * E4 · T8 — I4 y los doce invariantes propios de la épica
 * (`docs/design/E4-analitica.md` §5, `E4-validacion-analitica.md` §5).
 *
 * Módulo PURO. Se re-exportan desde `lib/ledger/invariants.ts`, que es donde
 * `runInvariants` los cablea cuando el llamante aporta el bloque `analytics`.
 */

import {
  buildAllocationGraph,
  checkTopologicalOrder,
  findCycle,
  linesHash as computeLinesHash,
  type AllocationRuleSpec,
  type AppliedAllocation,
  type SourceBalance,
} from "@/lib/analytics/allocate"
import {
  buildAnalyticPnl,
  contribution,
  isPnlAccount,
  isPnlLine,
  pnlContableCents,
  resolveDestination,
} from "@/lib/analytics/margins"
import { validateMarginLevels } from "@/lib/analytics/seed"
import {
  AnalyticLine,
  AnalyticPeriod,
  AnalyticsConfig,
  Cents,
  MARGIN_LEVELS,
  MarginLevel,
} from "@/lib/analytics/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { PostedEntry } from "@/lib/ledger/types"

const pass = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "PASS", evidencia } : { id, status: "PASS", evidencia, query }
const fail = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "FAIL", evidencia } : { id, status: "FAIL", evidencia, query }
const warn = (id: string, evidencia: string): CheckResult => ({ id, status: "WARN", evidencia })

export type AnalyticsInvariantInput = {
  lines: readonly AnalyticLine[]
  config: AnalyticsConfig
  period: AnalyticPeriod
  entries?: readonly PostedEntry[]
  /** Totales esperados por nivel, cuando el llamante los tiene sellados. */
  expectedLevelTotalsCents?: Readonly<Record<string, Cents>>
  /** E5 — imputaciones vigentes. Con ellas, I4 se evalúa sobre la matriz IMPUTADA. */
  allocations?: readonly AppliedAllocation[]
}

const lineKey = (l: AnalyticLine): string => l.id ?? `${l.entryId}#${l.lineNo}`

// ─────────────────────────────────────────────────────────────────────────────
// I4 — Σ matriz analítica = PyG contable (tolerancia 0)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I4.a ∀ nivel, Σ columnas = Σ aportes de los niveles ≤ nivel.
 * I4.b Σ columnas(RESULTADO) = Σ aportes = I3.
 * I4.c cobertura y unicidad: cada línea 6/7 contribuye a exactamente una celda.
 *
 * Nunca `WARN`: o cuadra o no.
 */
export function checkI4(input: AnalyticsInvariantInput): CheckResult {
  const query =
    "SELECT SUM(credit_cents - debit_cents) FROM journal_lines WHERE organization_id = $1 " +
    "AND entry_date BETWEEN $2 AND $3 AND left(account_code, 1) IN ('6','7') " +
    "AND entry_kind NOT IN ('REGULARIZATION','CLOSING','OPENING')"
  let pnl
  try {
    pnl = buildAnalyticPnl(
      input.lines,
      input.config,
      input.period,
      { runId: "invariants", ledgerHash: "", gitSha: "", baseCurrency: "EUR", module: "lib/analytics/margins.ts" },
      // E5: con imputaciones, I4 se comprueba sobre la matriz IMPUTADA. El Δ es
      // de suma cero en cada nivel, así que los ocho totales no se mueven: el
      // invariante lo VERIFICA, no lo presupone.
      input.allocations === undefined ? {} : { allocations: input.allocations }
    )
  } catch (error) {
    return fail("I4", `la matriz no se puede calcular: ${(error as Error).message}`, query)
  }

  const failures: string[] = []

  // I4.a — nivel a nivel, contra la suma acumulada de aportes.
  const contribByLevel = new Map<MarginLevel, Cents>()
  for (const level of MARGIN_LEVELS) {
    contribByLevel.set(
      level,
      Object.values(pnl.contributionByLevelCents[level] ?? {}).reduce((a, b) => a + b, 0)
    )
  }
  let running = 0
  for (const level of MARGIN_LEVELS) {
    running += contribByLevel.get(level) ?? 0
    if (pnl.levelTotalsCents[level] !== running) {
      failures.push(`I4.a nivel ${level}: matriz ${pnl.levelTotalsCents[level]} ≠ aportes acumulados ${running}`)
    }
    const expected = input.expectedLevelTotalsCents?.[level]
    if (expected !== undefined && expected !== pnl.levelTotalsCents[level]) {
      failures.push(`I4.a nivel ${level}: matriz ${pnl.levelTotalsCents[level]} ≠ esperado ${expected}`)
    }
  }

  // I4.b — RESULTADO = I3.
  const i3 = pnlContableCents(input.lines)
  if (pnl.levelTotalsCents.RESULTADO !== i3) {
    failures.push(`I4.b RESULTADO ${pnl.levelTotalsCents.RESULTADO} ≠ PyG contable ${i3} (diferencia ${pnl.levelTotalsCents.RESULTADO - i3})`)
  }

  // I4.c — cobertura y unicidad.
  const expectedLines = input.lines.filter(isPnlLine)
  const uncovered = expectedLines.filter((l) => !pnl.coveredLineIds.has(lineKey(l)))
  if (uncovered.length > 0) {
    failures.push(
      `I4.c ${uncovered.length} línea(s) 6/7 sin celda: ` +
        uncovered.slice(0, 10).map((l) => `${l.entryId}#${l.lineNo} (${l.accountCode})`).join(", ")
    )
  }
  if (pnl.lineDetail.length !== expectedLines.length) {
    failures.push(`I4.c cobertura ${pnl.lineDetail.length}/${expectedLines.length}`)
  }

  return failures.length === 0
    ? pass("I4", `matriz cuadrada con la PyG contable (${i3} c) en los 8 niveles · ${expectedLines.length} línea(s) 6/7 cubiertas`, query)
    : fail("I4", failures.join(" · "), query)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E4-1 … I-E4-12
// ─────────────────────────────────────────────────────────────────────────────

/** I-E4-1 — cobertura: toda línea 6/7 tiene destino, o es `NO_ANALITICO`. */
export function checkIE41(input: AnalyticsInvariantInput): CheckResult {
  const orphans = input.lines.filter(
    (l) => isPnlLine(l) && l.analyticType !== "NO_ANALITICO" && !l.projectId && !l.costCenterId
  )
  // Líneas que el motor ha tenido que degradar a NO_ANALITICO (tipo NULL o
  // desconocido sin default de cuenta, CECO/proyecto inexistente). No lanzan:
  // se declaran aquí en WARN, o FAIL si la organización exige destino (R-A8).
  const degraded = input.lines
    .filter(isPnlLine)
    .map((l) => ({ line: l, fallback: resolveDestination(l, input.config).fallback }))
    .filter((d): d is { line: AnalyticLine; fallback: NonNullable<typeof d.fallback> } => d.fallback !== null)
  const unassignedId = input.config.unassignedCostCenterId
  const inUnassigned = input.lines.filter((l) => isPnlLine(l) && unassignedId !== null && l.costCenterId === unassignedId)
  const unassignedCents = inUnassigned.reduce((a, l) => a + contribution(l), 0)

  if (orphans.length > 0) {
    const evidencia = `${orphans.length} línea(s) 6/7 sin destino: ${orphans
      .slice(0, 10)
      .map((l) => `${l.entryId}#${l.lineNo} (${l.accountCode})`)
      .join(", ")}`
    return input.config.analyticsRequired ? fail("I-E4-1", evidencia) : warn("I-E4-1", evidencia)
  }
  if (degraded.length > 0) {
    const evidencia =
      `${degraded.length} línea(s) 6/7 servidas en la columna NO_ANALITICO porque su destino no es resoluble: ` +
      degraded
        .slice(0, 10)
        .map((d) => `${d.line.entryId}#${d.line.lineNo} (${d.line.accountCode}, ${d.fallback.code})`)
        .join(", ")
    return input.config.analyticsRequired ? fail("I-E4-1", evidencia) : warn("I-E4-1", evidencia)
  }
  if (inUnassigned.length > 0) {
    return warn(
      "I-E4-1",
      `${inUnassigned.length} línea(s) en el CECO SIN_ASIGNAR por ${unassignedCents} c: reclasifícalas desde /analytics/pyg`
    )
  }
  return pass("I-E4-1", "toda línea 6/7 del periodo tiene destino analítico o es NO_ANALITICO")
}

/** I-E4-2 — `(projectId IS NULL) <> (costCenterId IS NULL)` en 6/7 no `NO_ANALITICO`. */
export function checkIE42(input: AnalyticsInvariantInput): CheckResult {
  const bad = input.lines.filter(
    (l) => isPnlLine(l) && l.analyticType !== "NO_ANALITICO" && (l.projectId === null) === (l.costCenterId === null)
  )
  const query =
    "SELECT id FROM journal_lines WHERE left(account_code,1) IN ('6','7') AND analytic_type <> 'NO_ANALITICO' " +
    "AND (project_id IS NULL) = (cost_center_id IS NULL)"
  return bad.length === 0
    ? pass("I-E4-2", "ninguna línea 6/7 lleva las dos dimensiones ni ninguna", query)
    : fail("I-E4-2", `${bad.length} línea(s) con destino no excluyente: ${bad.slice(0, 10).map((l) => `${l.entryId}#${l.lineNo}`).join(", ")}`, query)
}

/** I-E4-3 — `businessLineId` = el del proyecto; NULL con CECO (R-A9). */
export function checkIE43(input: AnalyticsInvariantInput): CheckResult {
  const blOfProject = new Map(input.config.projects.map((p) => [p.id, p.businessLineId]))
  const failures: string[] = []
  for (const l of input.lines) {
    if (l.projectId) {
      const expected = blOfProject.get(l.projectId)
      if (expected !== undefined && l.businessLineId !== expected) {
        failures.push(`${l.entryId}#${l.lineNo}: línea de negocio ${l.businessLineId} ≠ ${expected}`)
      }
    } else if (l.businessLineId !== null) {
      failures.push(`${l.entryId}#${l.lineNo}: línea de negocio sin proyecto`)
    }
  }
  return failures.length === 0
    ? pass("I-E4-3", "la línea de negocio de cada línea es la de su proyecto, y NULL sin proyecto")
    : fail("I-E4-3", failures.slice(0, 10).join(" · "))
}

/** I-E4-4 — `NO_ANALITICO` (en particular `630`) sin ninguna dimensión. */
export function checkIE44(input: AnalyticsInvariantInput): CheckResult {
  const bad = input.lines.filter(
    (l) => l.analyticType === "NO_ANALITICO" && (l.projectId || l.costCenterId || l.businessLineId)
  )
  return bad.length === 0
    ? pass("I-E4-4", "ninguna línea NO_ANALITICO lleva dimensión")
    : fail("I-E4-4", `${bad.length} línea(s) NO_ANALITICO con dimensión: ${bad.slice(0, 10).map((l) => `${l.entryId}#${l.lineNo} (${l.accountCode})`).join(", ")}`)
}

/** I-E4-5 — ninguna línea de grupos 1–5 lleva dimensión ni `analyticType`. */
export function checkIE45(input: AnalyticsInvariantInput): CheckResult {
  const bad = input.lines.filter(
    (l) => !isPnlAccount(l.accountCode) && (l.projectId || l.costCenterId || l.businessLineId || l.analyticType)
  )
  const query =
    "SELECT id FROM journal_lines WHERE left(account_code,1) NOT IN ('6','7') " +
    "AND (project_id IS NOT NULL OR cost_center_id IS NOT NULL OR business_line_id IS NOT NULL OR analytic_type IS NOT NULL)"
  return bad.length === 0
    ? pass("I-E4-5", "los grupos 1–5 no llevan destino analítico (CHECK journal_lines_analytics_only_pnl)", query)
    : fail("I-E4-5", `${bad.length} línea(s) de balance con dimensión: ${bad.slice(0, 10).map((l) => `${l.entryId}#${l.lineNo} (${l.accountCode})`).join(", ")}`, query)
}

/**
 * I-E4-6 — ningún porcentaje de margen se persiste. Es una comprobación de
 * gobierno (grep en CI + test de `marginBps`), no de datos.
 */
export function checkIE46(): CheckResult {
  return {
    id: "I-E4-6",
    status: "INFO",
    evidencia:
      "los % de margen son cálculo puro en el renderizador (marginBps, bps enteros); no hay columna ni tabla que los guarde",
  }
}

/** I-E4-7 — tenant de las tres dimensiones (extensión de I10, con FK real). */
export function checkIE47(input: AnalyticsInvariantInput): CheckResult {
  const projects = new Set(input.config.projects.map((p) => p.id))
  const cecos = new Set(input.config.costCenters.map((c) => c.id))
  const bls = new Set(input.config.businessLines.map((b) => b.id))
  const failures: string[] = []
  for (const l of input.lines) {
    if (l.projectId && !projects.has(l.projectId)) failures.push(`${l.entryId}#${l.lineNo}: proyecto ajeno`)
    if (l.costCenterId && !cecos.has(l.costCenterId)) failures.push(`${l.entryId}#${l.lineNo}: centro de coste ajeno`)
    if (l.businessLineId && !bls.has(l.businessLineId)) failures.push(`${l.entryId}#${l.lineNo}: línea de negocio ajena`)
  }
  const query =
    "SELECT l.id FROM journal_lines l LEFT JOIN projects p ON p.id = l.project_id " +
    "WHERE l.project_id IS NOT NULL AND (p.id IS NULL OR p.organization_id <> l.organization_id)"
  return failures.length === 0
    ? pass("I-E4-7", "las tres dimensiones de cada línea son de su propia organización", query)
    : fail("I-E4-7", failures.slice(0, 10).join(" · "), query)
}

/** I-E4-8 — estabilidad: dos ejecuciones con los mismos sellos dan la misma matriz. */
export function checkIE48(input: AnalyticsInvariantInput): CheckResult {
  const ctx = { runId: "x", ledgerHash: "", gitSha: "", baseCurrency: "EUR", module: "lib/analytics/margins.ts" }
  let same: boolean
  try {
    const a = buildAnalyticPnl(input.lines, input.config, input.period, ctx)
    const b = buildAnalyticPnl(input.lines, input.config, input.period, ctx)
    same = JSON.stringify(a.matrixCents) === JSON.stringify(b.matrixCents)
  } catch (error) {
    return fail("I-E4-8", `la matriz no se puede calcular: ${(error as Error).message}`)
  }
  return same
    ? pass("I-E4-8", "dos ejecuciones de la matriz sobre el mismo conjunto son idénticas (P7)")
    : fail("I-E4-8", "la matriz no es reproducible: dos ejecuciones difieren")
}

/** I-E4-9 — MLC-1 y MLC-2 en `MarginLevelConfig`. */
export function checkIE49(input: AnalyticsInvariantInput): CheckResult {
  const issues = validateMarginLevels(input.config.levels)
  return issues.length === 0
    ? pass("I-E4-9", "cada AnalyticType está en exactamente un nivel y MC3/EBITDA no listan INDIRECTO_CECO")
    : fail("I-E4-9", issues.map((i) => `${i.code}: ${i.message}`).join(" · "))
}

/**
 * I-E4-10 — proyecto `CLOSED` sin líneas nuevas posteriores a `closedAt`, salvo
 * excepción ADMIN **y salvo `REVERSAL`** (§8.7). WARN, no FAIL.
 */
export function checkIE410(input: AnalyticsInvariantInput): CheckResult {
  const closed = new Map(
    input.config.projects.filter((p) => p.status === "CLOSED" && p.closedAt).map((p) => [p.id, p.closedAt as string])
  )
  const offenders = input.lines.filter((l) => {
    if (!l.projectId || l.entryKind === "REVERSAL") return false
    const closedAt = closed.get(l.projectId)
    return closedAt !== undefined && l.entryDate > closedAt
  })
  return offenders.length === 0
    ? pass("I-E4-10", "ningún proyecto cerrado recibe líneas posteriores a su cierre")
    : warn(
        "I-E4-10",
        `${offenders.length} línea(s) posteriores al cierre de su proyecto: ${offenders.slice(0, 10).map((l) => `${l.entryId}#${l.lineNo}`).join(", ")}`
      )
}

/**
 * I-E4-11 — contra-asiento con dimensión espejo: `Σ aporte = 0` **por cuenta y
 * por (proyecto, CECO, analyticType)**, no solo por cuenta (§8.7).
 */
export function checkIE411(entries: readonly PostedEntry[]): CheckResult {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const failures: string[] = []
  let pairs = 0
  for (const rev of entries.filter((e) => e.kind === "REVERSAL")) {
    if (!rev.reversesEntryId) continue
    const original = byId.get(rev.reversesEntryId)
    if (!original) continue
    pairs++
    const net = new Map<string, number>()
    for (const l of [...original.lines, ...rev.lines]) {
      const key = [l.accountCode, l.projectId ?? "∅", l.costCenterId ?? "∅", l.analyticType ?? "∅"].join("|")
      net.set(key, (net.get(key) ?? 0) + l.debitCents - l.creditCents)
    }
    const residuals = [...net.entries()].filter(([, v]) => v !== 0)
    if (residuals.length > 0) {
      failures.push(
        `asiento ${rev.entryNumber}: ${residuals.map(([k, v]) => `${k} = ${v}`).slice(0, 5).join(", ")}`
      )
    }
  }
  return failures.length === 0
    ? pass("I-E4-11", `${pairs} par(es) original/contra-asiento cuadran a 0 por cuenta y por destino analítico`)
    : fail("I-E4-11", failures.join(" · "))
}

/** Cuentas rectificativas de C-12 ampliado a la analítica (I-E4-12). */
export const RECTIFYING_ACCOUNT_PREFIXES: readonly string[] = ["606", "608", "609", "706", "708", "709"]

/**
 * I-E4-12 — toda línea rectificativa lleva la dimensión de la línea que
 * rectifica. Se comprueba dentro del propio asiento: la rectificativa y la
 * línea rectificada conviven en él (T-02/T-05).
 */
export function checkIE412(entries: readonly PostedEntry[]): CheckResult {
  const failures: string[] = []
  let checked = 0
  for (const e of entries) {
    const rectifying = e.lines.filter((l) => RECTIFYING_ACCOUNT_PREFIXES.some((p) => l.accountCode.startsWith(p)))
    if (rectifying.length === 0) continue
    const dims = new Set(
      e.lines
        .filter((l) => isPnlAccount(l.accountCode))
        .map((l) => `${l.projectId ?? "∅"}|${l.costCenterId ?? "∅"}`)
    )
    checked += rectifying.length
    if (dims.size > 1) {
      failures.push(`asiento ${e.entryNumber}: la rectificativa no comparte destino con la línea rectificada (${[...dims].join(" / ")})`)
    }
  }
  return failures.length === 0
    ? pass("I-E4-12", `${checked} línea(s) rectificativas con la dimensión de la línea rectificada`)
    : fail("I-E4-12", failures.slice(0, 10).join(" · "))
}

/**
 * Ejecuta un check aislando su excepción: un fallo del motor analítico se
 * declara como FAIL de ese invariante, nunca tumba el informe que lo pide
 * (E4-UI-1.b). El sello resultante es entonces `REQUIERE REVISIÓN`.
 */
function safely(id: string, run: () => CheckResult): CheckResult {
  try {
    return run()
  } catch (error) {
    return fail(id, `el motor analítico no ha podido evaluar ${id}: ${(error as Error).message}`)
  }
}

/**
 * Entrada del barrido analítico. Cuando trae `allocations`, arrastra además el
 * contexto de liquidación: BLOQUEA #3 de la revisión — `models/margins.ts` ya
 * pasaba `allocations` y esta función la IGNORABA, así que I5 y los doce
 * `I-E5-*` no se ejecutaban en ningún camino de producción y el sello
 * «comprobado» de la PyG imputada no acreditaba la liquidación que mostraba.
 */
export type AnalyticInvariantsInput = AnalyticsInvariantInput &
  Partial<Omit<AllocationInvariantInput, keyof AnalyticsInvariantInput>>

/** Los trece checks de la épica, en orden de presentación en Auditoría. */
export function runAnalyticInvariants(input: AnalyticInvariantsInput): CheckResult[] {
  const checks = [
    safely("I4", () => checkI4(input)),
    safely("I-E4-1", () => checkIE41(input)),
    safely("I-E4-2", () => checkIE42(input)),
    safely("I-E4-3", () => checkIE43(input)),
    safely("I-E4-4", () => checkIE44(input)),
    safely("I-E4-5", () => checkIE45(input)),
    checkIE46(),
    safely("I-E4-7", () => checkIE47(input)),
    safely("I-E4-8", () => checkIE48(input)),
    safely("I-E4-9", () => checkIE49(input)),
    safely("I-E4-10", () => checkIE410(input)),
  ]
  if (input.entries) {
    const entries = input.entries
    checks.push(
      safely("I-E4-11", () => checkIE411(entries)),
      safely("I-E4-12", () => checkIE412(entries))
    )
  }
  // E5 · BLOQUEA #3 — con imputaciones en la matriz, I5 y los doce `I-E5-*`
  // viajan con ella: la pantalla, el `ReportRun` sellado y el barrido de
  // `scripts/run-invariants.ts` enseñan exactamente los mismos checks.
  if (input.allocations !== undefined) {
    checks.push(...checkAllocationInvariants({ ...input, allocations: input.allocations }))
  }
  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// E5 · T8 — I5 y los doce invariantes de la liquidación
// (`docs/design/E5-liquidacion.md` §5, `E5-validacion-liquidacion.md` §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entrada de los invariantes de E5. Todo lo que necesitan viene YA leído: el
 * módulo sigue siendo puro y los mismos datos que alimentan la matriz alimentan
 * los checks, así que no pueden divergir.
 */
export type AllocationInvariantInput = AnalyticsInvariantInput & {
  allocations: readonly AppliedAllocation[]
  /** Reglas vigentes del periodo, para I-E5-1, I-E5-2, I-E5-3 e I-E5-8. */
  rules?: readonly AllocationRuleSpec[]
  /** Base, liquidado y residual por `(fuente, nivel)` que devolvió el motor. */
  balances?: readonly SourceBalance[]
  /** Runs que han aportado, con su estado, para I-E5-9. */
  runs?: readonly { id: string; status: string; totalAllocatedCents: Cents }[]
  /**
   * Auditoría E5, hallazgo 1 — el `linesHash` SELLADO de cada run. Con él,
   * I-E5-12 deja de ser INFO y se comprueba sobre datos: se recalcula el hash de
   * las líneas persistidas y se compara con el que el run guardó.
   */
  runLinesHashes?: readonly { id: string; linesHash: string | null }[]
  /** Δ por nivel y columna, cuando el llamante ya lo tiene calculado. */
  allocationDeltaCents?: Record<string, Record<string, Cents>>
}

/**
 * **I5 — tolerancia 0.**
 *
 *   I5.a  ∀R, ∀s, ∀ℓ: Σ AllocationLine = base liquidada
 *   I5.b  cierre: todo CECO imputable con regla queda a 0 en su columna
 *   I5.c  CC-FIN / CC-EXT / CC-NA nunca son fuente ni destino
 *
 * La tolerancia es **0**, no 1 céntimo: el mayor resto reparte el remanente
 * entero. Con tolerancia 1, un motor que dejara un céntimo pasaría el invariante
 * y la columna del CECO no llegaría nunca a cero — un fallo silencioso
 * permanente a cambio de nada.
 */
export function checkI5(input: AllocationInvariantInput): CheckResult {
  const failures: string[] = []
  const query =
    "SELECT run_id, source_cost_center_id, margin_level, SUM(amount_cents) FROM allocation_lines " +
    "WHERE organization_id = $1 GROUP BY 1, 2, 3"

  // I5.a — por (run, fuente, nivel), contra la base que el motor liquidó.
  let combos = 0
  for (const balance of input.balances ?? []) {
    combos++
    if (balance.residualCents !== 0) {
      failures.push(
        `I5.a ${balance.sourceCostCenterCode}/${balance.marginLevel}: repartido ${balance.allocatedCents} ≠ base liquidada ${balance.liquidatedCents} (diferencia ${balance.residualCents})`
      )
    }
  }

  // I5.b — cierre: todo CECO imputable con regla vigente queda a 0.
  const cecoById = new Map(input.config.costCenters.map((c) => [c.id, c]))
  const sourcesWithRule = new Set((input.rules ?? []).map((r) => r.sourceCostCenterId))
  const own = new Map<string, Cents>()
  for (const line of input.lines) {
    if (!isPnlLine(line) || !line.costCenterId) continue
    if (resolveDestination(line, input.config).analyticType !== "INDIRECTO_CECO") continue
    own.set(line.costCenterId, (own.get(line.costCenterId) ?? 0) - contribution(line))
  }
  const net = new Map<string, Cents>()
  for (const a of input.allocations) {
    const outKey = `${a.sourceCostCenterId}|${a.marginLevel}`
    net.set(outKey, (net.get(outKey) ?? 0) - a.amountCents)
    if (a.target.kind === "COST_CENTER") {
      const inKey = `${a.target.id}|${a.marginLevel}`
      net.set(inKey, (net.get(inKey) ?? 0) + a.amountCents)
    }
  }
  for (const cecoId of sourcesWithRule) {
    const ceco = cecoById.get(cecoId)
    if (!ceco || !ceco.allocatable) continue
    for (const level of ["MC3", "EBITDA"] as const) {
      const residual = (ceco.marginLevel === level ? (own.get(cecoId) ?? 0) : 0) + (net.get(`${cecoId}|${level}`) ?? 0)
      if (residual !== 0) {
        failures.push(`I5.b ${ceco.code}/${level}: quedan ${residual} c sin liquidar al cierre`)
      }
    }
  }

  // I5.c — los no imputables no aparecen ni como fuente ni como destino.
  for (const a of input.allocations) {
    const source = cecoById.get(a.sourceCostCenterId)
    if (source && !source.allocatable) failures.push(`I5.c ${source.code} no es imputable y aparece como fuente`)
    if (a.target.kind === "COST_CENTER") {
      const target = cecoById.get(a.target.id)
      if (target && !target.allocatable) failures.push(`I5.c ${target.code} no es imputable y aparece como destino`)
    }
  }

  return failures.length === 0
    ? pass(
        "I5",
        `${combos} combinación(es) (run, CECO fuente, nivel) con diferencia 0 · ${input.allocations.length} línea(s) de reparto`,
        query
      )
    : fail("I5", failures.slice(0, 10).join(" · "), query)
}

/** I-E5-1 — el grafo `fuente → CECO destino` de un mismo `period` es un DAG. */
export function checkIE51(rules: readonly AllocationRuleSpec[], config: AnalyticsConfig): CheckResult {
  const cycle = findCycle(buildAllocationGraph(rules))
  if (cycle === null) return pass("I-E5-1", "el grafo de cascada no tiene ciclos ni autoaristas")
  const codeById = new Map(config.costCenters.map((c) => [c.id, c.code]))
  return fail("I-E5-1", `ciclo en las reglas de liquidación: ${cycle.map((id) => codeById.get(id) ?? id).join(" → ")}`)
}

/** I-E5-2 — `Σ percentBps = 10000` en toda regla `FIXED_PERCENT`. */
export function checkIE52(rules: readonly AllocationRuleSpec[]): CheckResult {
  const bad = rules
    .filter((r) => r.driver === "FIXED_PERCENT")
    .filter((r) => r.targets.reduce((a, t) => a + (t.percentBps ?? 0), 0) !== 10000)
  return bad.length === 0
    ? pass("I-E5-2", "toda regla FIXED_PERCENT reparte exactamente el 100 % entre sus destinos")
    : fail("I-E5-2", `reglas con Σ % ≠ 100: ${bad.map((r) => r.code).join(", ")}`)
}

/** I-E5-3 — `Σ sourceShareBps = 10000` por `(fuente, period)` vigente. */
export function checkIE53(rules: readonly AllocationRuleSpec[], config: AnalyticsConfig): CheckResult {
  const codeById = new Map(config.costCenters.map((c) => [c.id, c.code]))
  const agg = new Map<string, number>()
  for (const r of rules) {
    const key = `${codeById.get(r.sourceCostCenterId) ?? r.sourceCostCenterId}/${r.period}`
    agg.set(key, (agg.get(key) ?? 0) + r.sourceShareBps)
  }
  const bad = [...agg.entries()].filter(([, v]) => v !== 10000)
  return bad.length === 0
    ? pass("I-E5-3", "cada CECO fuente declara qué se hace con el 100 % de su saldo en cada periodicidad")
    : fail("I-E5-3", `Σ sourceShareBps ≠ 10000 en: ${bad.map(([k, v]) => `${k} = ${v}`).join(", ")}`)
}

/**
 * I-E5-4 — remanente acotado: `0 ≤ r ≤ n − 1` y **ningún receptor absorbe más de
 * un céntimo** de remanente. Se comprueba sobre el reparto real: cada línea
 * dista del cociente exacto en menos de un céntimo.
 */
export function checkIE54(input: AllocationInvariantInput): CheckResult {
  const failures: string[] = []
  const byRun = new Map<string, AppliedAllocation[]>()
  for (const a of input.allocations) {
    const key = `${a.runId}|${a.ruleCode}|${a.marginLevel}`
    byRun.set(key, [...(byRun.get(key) ?? []), a])
  }
  for (const [key, group] of byRun) {
    const total = group.reduce((acc, a) => acc + a.amountCents, 0)
    const weightTotal = group[0].driverBaseTotal
    if (weightTotal <= 0) continue
    for (const a of group) {
      const exactFloor = Math.floor((Math.abs(total) * a.driverBase) / weightTotal)
      const got = Math.abs(a.amountCents)
      if (got !== exactFloor && got !== exactFloor + 1) {
        failures.push(`${key} → ${a.target.code}: ${got} c fuera de [${exactFloor}, ${exactFloor + 1}]`)
      }
    }
  }
  return failures.length === 0
    ? pass("I-E5-4", "el mayor resto reparte como máximo un céntimo de remanente por receptor")
    : fail("I-E5-4", failures.slice(0, 10).join(" · "))
}

/** I-E5-5 — ni fuente ni destino con `allocatable = false`. */
export function checkIE55(input: AllocationInvariantInput): CheckResult {
  const cecoById = new Map(input.config.costCenters.map((c) => [c.id, c]))
  const bad: string[] = []
  for (const a of input.allocations) {
    const source = cecoById.get(a.sourceCostCenterId)
    if (source && !source.allocatable) bad.push(`${source.code} (fuente)`)
    if (a.target.kind === "COST_CENTER") {
      const t = cecoById.get(a.target.id)
      if (t && !t.allocatable) bad.push(`${t.code} (destino)`)
    }
  }
  return bad.length === 0
    ? pass("I-E5-5", "CC-FIN, CC-EXT y CC-NA no aparecen como fuente ni como destino de ninguna imputación")
    : fail("I-E5-5", `centros no imputables en el reparto: ${[...new Set(bad)].join(", ")}`)
}

/**
 * I-E5-6 — **el nivel viaja con el importe**: `Σ_c Δ[ℓ][c] = 0` en cada nivel.
 * Es lo que hace que I4 se cumpla por construcción tras imputar; si un solo
 * nivel no suma cero, el motor movió importe entre niveles (violación de E5-D1)
 * o perdió una línea.
 */
export function checkIE56(delta: Record<string, Record<string, Cents>>): CheckResult {
  const bad = MARGIN_LEVELS.filter(
    (level) => Object.values(delta[level] ?? {}).reduce((a, b) => a + b, 0) !== 0
  )
  return bad.length === 0
    ? pass("I-E5-6", "la imputación es un traspaso interno de suma cero en CADA nivel de margen (E5-D1)")
    : fail("I-E5-6", `niveles cuyo Δ no suma cero: ${bad.join(", ")}`)
}

/** I-E5-7 — ningún destino archivado ni proyecto `CLOSED`/`PLANNED` sin anotar. */
export function checkIE57(input: AllocationInvariantInput): CheckResult {
  const projectById = new Map(input.config.projects.map((p) => [p.id, p]))
  const blById = new Map(input.config.businessLines.map((b) => [b.id, b]))
  const cecoById = new Map(input.config.costCenters.map((c) => [c.id, c]))
  const bad: string[] = []
  for (const a of input.allocations) {
    if (a.target.kind === "PROJECT") {
      const p = projectById.get(a.target.id)
      if (!p) continue
      if (!p.isActive) bad.push(`${p.code} archivado`)
      else if (p.status === "PLANNED") bad.push(`${p.code} en estado PLANNED`)
      else if (p.status === "CLOSED" && a.eligibilityReason !== "ACTIVITY_IN_PERIOD") {
        bad.push(`${p.code} cerrado sin anotar ACTIVITY_IN_PERIOD`)
      }
    } else if (a.target.kind === "BUSINESS_LINE") {
      const b = blById.get(a.target.id)
      if (b && !b.isActive) bad.push(`${b.code} archivada`)
    } else {
      const c = cecoById.get(a.target.id)
      if (c && !c.isActive) bad.push(`${c.code} archivado`)
    }
  }
  return bad.length === 0
    ? pass("I-E5-7", "ninguna imputación apunta a una dimensión archivada ni a un proyecto que no la admita")
    : fail("I-E5-7", `destinos no admisibles: ${[...new Set(bad)].join(", ")}`)
}

/** I-E5-8 — `(priority, code)` es orden topológico del grafo de cascada. */
export function checkIE58(rules: readonly AllocationRuleSpec[]): CheckResult {
  const bad = checkTopologicalOrder(rules, buildAllocationGraph(rules))
  return bad.length === 0
    ? pass("I-E5-8", "el receptor de una cascada reparte con prioridad posterior a la del donante")
    : fail("I-E5-8", `aristas cuya prioridad no es topológica: ${bad.map((e) => `${e.from} → ${e.to}`).join("; ")}`)
}

/** I-E5-9 — sólo los runs `SEALED` aportan a la matriz. */
export function checkIE59(input: AllocationInvariantInput): CheckResult {
  const runs = input.runs
  if (!runs) return { id: "I-E5-9", status: "INFO", evidencia: "sin runs en el contexto: no hay nada que contrastar" }
  const live = new Set(runs.filter((r) => r.status === "SEALED").map((r) => r.id))
  const intruders = [...new Set(input.allocations.filter((a) => !live.has(a.runId)).map((a) => a.runId))]
  const expected = runs.filter((r) => live.has(r.id)).reduce((a, r) => a + r.totalAllocatedCents, 0)
  const actual = input.allocations.reduce((a, l) => a + l.amountCents, 0)
  if (intruders.length > 0) {
    return fail("I-E5-9", `la matriz suma líneas de run(s) no vigentes: ${intruders.join(", ")}`)
  }
  return expected === actual
    ? pass("I-E5-9", `sólo los ${live.size} run(s) vigentes aportan (${actual} c)`)
    : fail("I-E5-9", `la matriz suma ${actual} c y los runs vigentes declaran ${expected} c`)
}

/** I-E5-10 — `MANUAL` cuadrado: `Σ amountCents = base(s,R,ℓ)` antes de persistir. */
export function checkIE510(input: AllocationInvariantInput): CheckResult {
  const manual = (input.rules ?? []).filter((r) => r.driver === "MANUAL")
  if (manual.length === 0) return pass("I-E5-10", "no hay reglas MANUAL vigentes")
  const byRule = new Map<string, Cents>()
  for (const a of input.allocations) byRule.set(a.ruleCode, (byRule.get(a.ruleCode) ?? 0) + a.amountCents)
  const bad = manual.filter((r) => {
    const declared = r.targets.reduce((a, t) => a + (t.amountCents ?? 0), 0)
    const emitted = byRule.get(r.code)
    return emitted !== undefined && emitted !== declared
  })
  return bad.length === 0
    ? pass("I-E5-10", `las ${manual.length} regla(s) MANUAL reparten exactamente los importes declarados`)
    : fail("I-E5-10", `reglas MANUAL descuadradas: ${bad.map((r) => r.code).join(", ")}`)
}

/**
 * I-E5-11 — inmutabilidad. Es una comprobación de GOBIERNO: la barrera real son
 * el `GRANT` de columna, las políticas `RESTRICTIVE` y el trigger
 * `allocation_runs_append_only`, y quien la ejercita es
 * `tests/integration-rls/e5-tenant.test.ts` con un `42501` en la mano.
 */
export function checkIE511(): CheckResult {
  return {
    id: "I-E5-11",
    status: "INFO",
    evidencia:
      "allocation_lines es append-only puro y allocation_runs sólo admite UPDATE de status, superseded_by_id, reversed_at, reversed_by_id y reversal_reason (GRANT de columna + políticas RESTRICTIVE + trigger)",
  }
}

/**
 * I-E5-12 — reproducibilidad byte a byte con los mismos sellos (P7).
 *
 * **Verificable sobre datos** desde la ronda 1 (auditoría, hallazgo 1): se
 * recalcula el `linesHash` de las líneas persistidas de cada run y se compara
 * con el que el run selló. Es lo único que detecta el caso B del auditor —mover
 * el céntimo de remanente de Hamilton entre dos receptores del mismo (run,
 * regla, nivel) por `UPDATE` directo—, que mantiene Σ por fuente, cierre a 0,
 * la cota de I-E5-4 y el total del run, y por tanto pasaba TODOS los demás.
 */
export function checkIE512(input: AllocationInvariantInput & { reproduce?: () => string }): CheckResult {
  const query =
    "SELECT run_id, lines_hash FROM allocation_runs WHERE organization_id = $1 AND status = 'SEALED'"
  const sealed = (input.runLinesHashes ?? []).filter((r) => r.linesHash !== null)
  if (sealed.length > 0) {
    const byRun = new Map<string, AppliedAllocation[]>()
    for (const a of input.allocations) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a])
    const failures: string[] = []
    for (const run of sealed) {
      const recomputed = computeLinesHash(byRun.get(run.id) ?? [])
      if (recomputed !== run.linesHash) {
        failures.push(
          `run ${run.id}: las líneas de hoy hashean ${recomputed.slice(0, 12)}… y el run selló ${(run.linesHash ?? "").slice(0, 12)}…`
        )
      }
    }
    const unsealed = (input.runLinesHashes ?? []).length - sealed.length
    return failures.length === 0
      ? pass(
          "I-E5-12",
          `las líneas de ${sealed.length} run(s) reproducen su linesHash sellado, desempates incluidos` +
            (unsealed > 0 ? ` · ${unsealed} run(s) anteriores a 20260910110000 sin sello de líneas` : ""),
          query
        )
      : fail("I-E5-12", failures.slice(0, 10).join(" · "), query)
  }
  if (!input.reproduce) {
    return {
      id: "I-E5-12",
      status: "INFO",
      evidencia:
        (input.runLinesHashes ?? []).length > 0
          ? "los runs del periodo son anteriores a 20260910110000 y no tienen linesHash: reproducibilidad comprobada en lib/analytics/allocate.test.ts"
          : "reproducibilidad comprobada en lib/analytics/allocate.test.ts",
    }
  }
  return input.reproduce() === input.reproduce()
    ? pass("I-E5-12", "dos ejecuciones con los mismos sellos producen el mismo reparto, desempates incluidos")
    : fail("I-E5-12", "el reparto no es reproducible: dos ejecuciones difieren")
}

/** Los trece de E5, en orden de presentación en Auditoría. */
export function checkAllocationInvariants(input: AllocationInvariantInput): CheckResult[] {
  const rules = input.rules ?? []
  return [
    safely("I5", () => checkI5(input)),
    safely("I-E5-1", () => checkIE51(rules, input.config)),
    safely("I-E5-2", () => checkIE52(rules)),
    safely("I-E5-3", () => checkIE53(rules, input.config)),
    safely("I-E5-4", () => checkIE54(input)),
    safely("I-E5-5", () => checkIE55(input)),
    safely("I-E5-6", () => checkIE56(input.allocationDeltaCents ?? deltaOf(input))),
    safely("I-E5-7", () => checkIE57(input)),
    safely("I-E5-8", () => checkIE58(rules)),
    safely("I-E5-9", () => checkIE59(input)),
    safely("I-E5-10", () => checkIE510(input)),
    checkIE511(),
    safely("I-E5-12", () => checkIE512(input)),
  ]
}

/** Δ por nivel y columna cuando el llamante no lo trae ya calculado. */
function deltaOf(input: AllocationInvariantInput): Record<string, Record<string, Cents>> {
  const out: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) out[level] = {}
  const kindById = new Map(input.config.costCenters.map((c) => [c.id, c.kind]))
  for (const a of input.allocations) {
    const sourceKind = kindById.get(a.sourceCostCenterId)
    if (!sourceKind) continue
    const source = `CECO:${sourceKind}`
    const target =
      a.target.kind === "PROJECT"
        ? `PROJ:${a.target.code}`
        : a.target.kind === "BUSINESS_LINE"
          ? `BL:${a.target.code}`
          : `CECO:${kindById.get(a.target.id) ?? "OTROS"}`
    const row = out[a.marginLevel]
    row[source] = (row[source] ?? 0) + a.amountCents
    row[target] = (row[target] ?? 0) - a.amountCents
  }
  return out
}
