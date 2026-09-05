/**
 * E4 · T8 — I4 y los doce invariantes propios de la épica
 * (`docs/design/E4-analitica.md` §5, `E4-validacion-analitica.md` §5).
 *
 * Módulo PURO. Se re-exportan desde `lib/ledger/invariants.ts`, que es donde
 * `runInvariants` los cablea cuando el llamante aporta el bloque `analytics`.
 */

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
    pnl = buildAnalyticPnl(input.lines, input.config, input.period, {
      runId: "invariants",
      ledgerHash: "",
      gitSha: "",
      baseCurrency: "EUR",
      module: "lib/analytics/margins.ts",
    })
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

/** Los trece checks de la épica, en orden de presentación en Auditoría. */
export function runAnalyticInvariants(input: AnalyticsInvariantInput): CheckResult[] {
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
  return checks
}
