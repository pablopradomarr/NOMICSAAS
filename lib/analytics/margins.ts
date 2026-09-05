/**
 * E4 · T5/T7 — Motor de la PyG analítica (`docs/design/E4-analitica.md` §3.2).
 *
 * Funciones PURAS: sin IO, sin Prisma, sin LLM, sin `Date.now()`. Reciben las
 * líneas ya leídas por `models/`. Agregados en `number` de céntimos enteros
 * (JS los representa exactos hasta 2^53, muy por encima de cualquier agregado
 * contable) y `BigInt` en `levelTotalsBig` para quien necesite pasar de ahí.
 *
 * La serialización canónica de `buildAnalyticPnl` reproduce **byte a byte**
 * `docs/design/fixtures/pyg-analitica-esperada.json` (criterio 8 de §8.1).
 */

import { cellProvenance, type Confidence, type Provenance, type ProvenanceContext } from "@/lib/ledger/provenance"
import {
  AnalyticLine,
  AnalyticPeriod,
  AnalyticsConfig,
  AnalyticsError,
  AnalyticType,
  Cents,
  cecoColumn,
  ColumnKey,
  COST_CENTER_KINDS,
  CostCenterKind,
  EXCLUDED_ENTRY_KINDS,
  MARGIN_LEVELS,
  MarginLevel,
  projectColumn,
} from "@/lib/analytics/types"

// ─────────────────────────────────────────────────────────────────────────────
// Reglas de destino: tipo efectivo, nivel y columna
// ─────────────────────────────────────────────────────────────────────────────

const DIRECT_TYPES: ReadonlySet<AnalyticType> = new Set<AnalyticType>([
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
])

/** Grupo PGC: el primer dígito. */
export const accountGroup = (code: string): string => code.slice(0, 1)

/** Solo los grupos 6 y 7 tienen destino analítico (R-A1). */
export const isPnlAccount = (code: string): boolean => accountGroup(code) === "6" || accountGroup(code) === "7"

/**
 * Tipo de la cuenta CON herencia de hoja: `6080 → 608 → COSTE_DIRECTO_MC1`,
 * `6300 → 630 → NO_ANALITICO`. El seed marca el tipo en el nivel donde es
 * informativo, no en cada hoja.
 */
export function accountAnalyticType(
  accountCode: string,
  byAccount: ReadonlyMap<string, AnalyticType | null>
): AnalyticType | null {
  for (let code = accountCode; code.length > 0; code = code.slice(0, -1)) {
    const type = byAccount.get(code)
    if (type) return type
  }
  return null
}

/**
 * R-A2/R-A3/R-A4 — tipo analítico EFECTIVO. Lo usa `post.ts` al construir la
 * línea; la matriz nunca lo recalcula, lee el persistido.
 *   1. override explícito del input
 *   2. `INDIRECTO_CECO` + `projectId` ⇒ `COSTE_DIRECTO_MC2`  (R-A3, sin WARN)
 *      tipo directo + `costCenterId` ⇒ `INDIRECTO_CECO`      (R-A4, sin WARN)
 *   3. default de la cuenta, con herencia de hoja
 */
export function resolveEffectiveAnalyticType(
  input: {
    accountCode: string
    analyticType?: AnalyticType | null
    projectId?: string | null
    costCenterId?: string | null
  },
  config: Pick<AnalyticsConfig, "analyticTypeByAccount">
): AnalyticType | null {
  if (input.analyticType) return input.analyticType
  const base = accountAnalyticType(input.accountCode, config.analyticTypeByAccount)
  if (base === null) return null
  const hasProject = input.projectId !== null && input.projectId !== undefined
  const hasCostCenter = input.costCenterId !== null && input.costCenterId !== undefined
  // R-A3: un servicio exterior imputado a un proyecto concreto es coste directo
  // de ejecución y se descuenta en MC2, no vía CECO.
  if (base === "INDIRECTO_CECO" && hasProject) return "COSTE_DIRECTO_MC2"
  // R-A4: una cuenta de tipo directo posteada a un CECO es indirecta de hecho.
  if (DIRECT_TYPES.has(base) && hasCostCenter && !hasProject) return "INDIRECTO_CECO"
  return base
}

/** Índice `analyticType → nivel` de la configuración vigente (R-A7). */
export function levelByType(config: Pick<AnalyticsConfig, "levels">): ReadonlyMap<AnalyticType, MarginLevel> {
  const out = new Map<AnalyticType, MarginLevel>()
  for (const row of config.levels) {
    for (const type of row.analyticTypes) out.set(type, row.level)
  }
  return out
}

/**
 * Nivel de margen. Determinista y total.
 *   `INDIRECTO_CECO`  → `CostCenter.marginLevel` (MC3 | EBITDA)   (R-A6/R-A7)
 *   `NO_ANALITICO`    → `RESULTADO` si la cuenta ∈ `incomeTaxPrefixes`,
 *                       si no `config.nonAnalyticLevel`           (R-A11)
 *   resto             → por `MarginLevelConfig.analyticTypes`
 * `CostCenter.marginLevel` NO se aplica a ningún otro tipo: un `668` en
 * `CC-FIN` cae en BAI, no en EBITDA (R-A6).
 */
export function resolveLevel(line: AnalyticLine, config: AnalyticsConfig): MarginLevel {
  const type = line.analyticType
  if (type === null) {
    throw new AnalyticsError("TYPE_UNKNOWN", `La línea ${line.lineNo} de ${line.entryId} no tiene tipo analítico efectivo`)
  }
  if (type === "INDIRECTO_CECO") {
    const ceco = findCostCenter(line, config)
    if (ceco.marginLevel !== "MC3" && ceco.marginLevel !== "EBITDA") {
      throw new AnalyticsError(
        "CECO_MARGIN_LEVEL",
        `El centro de coste ${ceco.code} tiene marginLevel ${ceco.marginLevel}: solo MC3 o EBITDA`
      )
    }
    return ceco.marginLevel
  }
  if (type === "NO_ANALITICO") {
    return config.incomeTaxPrefixes.some((p) => line.accountCode.startsWith(p)) ? "RESULTADO" : config.nonAnalyticLevel
  }
  const level = levelByType(config).get(type)
  if (!level) {
    throw new AnalyticsError("TYPE_UNKNOWN", `El tipo ${type} no está en ningún nivel de MarginLevelConfig (MLC-1)`)
  }
  return level
}

function findCostCenter(line: AnalyticLine, config: AnalyticsConfig) {
  const ceco = config.costCenters.find((c) => c.id === line.costCenterId)
  if (!ceco) {
    throw new AnalyticsError(
      "CECO_UNKNOWN",
      `La línea ${line.lineNo} de ${line.entryId} apunta a un centro de coste desconocido (${line.costCenterId})`
    )
  }
  return ceco
}

function findProject(line: AnalyticLine, config: AnalyticsConfig) {
  const project = config.projects.find((p) => p.id === line.projectId)
  if (!project) {
    throw new AnalyticsError(
      "PROJECT_UNKNOWN",
      `La línea ${line.lineNo} de ${line.entryId} apunta a un proyecto desconocido (${line.projectId})`
    )
  }
  return project
}

/**
 * Columna. **La fija el tipo efectivo, no la dimensión** (R-A5). Excepción
 * única: `AMORTIZACION_DETERIORO` con `projectId` va a la columna del proyecto.
 */
export function resolveColumn(line: AnalyticLine, config: AnalyticsConfig): ColumnKey {
  const type = line.analyticType
  if (type === null) {
    throw new AnalyticsError("TYPE_UNKNOWN", `La línea ${line.lineNo} de ${line.entryId} no tiene tipo analítico efectivo`)
  }
  if (DIRECT_TYPES.has(type)) {
    if (!line.projectId) {
      throw new AnalyticsError("DEST_MISSING", `Tipo ${type} sin proyecto en la línea ${line.lineNo} de ${line.entryId}`)
    }
    return projectColumn(findProject(line, config).code)
  }
  if (type === "INDIRECTO_CECO") return cecoColumn(findCostCenter(line, config).kind)
  if (type === "AMORTIZACION_DETERIORO") {
    return line.projectId ? projectColumn(findProject(line, config).code) : "AMORTIZACION_DETERIORO"
  }
  if (type === "FINANCIERO") return "FINANCIERO"
  if (type === "EXTRAORDINARIO") return "EXTRAORDINARIO"
  return "NO_ANALITICO"
}

/** Aporte: `creditCents − debitCents`. Ingreso +, gasto −, contra-cuentas solas. */
export const contribution = (line: Pick<AnalyticLine, "debitCents" | "creditCents">): Cents =>
  line.creditCents - line.debitCents

/** ¿Entra en la PyG? Grupo 6/7 y `entryKind ∉ {REGULARIZATION, CLOSING, OPENING}` (I3). */
export const isPnlLine = (line: Pick<AnalyticLine, "accountCode" | "entryKind">): boolean =>
  isPnlAccount(line.accountCode) && !EXCLUDED_ENTRY_KINDS.has(line.entryKind)

/** Cifra de la PyG contable (definición única de I3). **E6 la hereda**. */
export function pnlContableCents(lines: readonly AnalyticLine[]): Cents {
  let total = 0
  for (const line of lines) if (isPnlLine(line)) total += contribution(line)
  return total
}

/** Núcleo testeable: a qué celda va una línea, sin sumar nada. */
export function classifyLine(
  line: AnalyticLine,
  config: AnalyticsConfig
): { level: MarginLevel; column: ColumnKey; amountCents: Cents } {
  return { level: resolveLevel(line, config), column: resolveColumn(line, config), amountCents: contribution(line) }
}

/**
 * % de margen con 1 decimal, en puntos básicos ENTEROS (nada de Float).
 * `null` si los ingresos de la columna son 0: se pinta `—`, nunca `0 %` ni NaN
 * (gap G-05, I-E4-6). Ningún porcentaje se persiste.
 */
export function marginBps(marginCents: Cents, revenueCents: Cents): number | null {
  if (revenueCents === 0) return null
  // Décimas de punto porcentual, redondeadas al entero más próximo y sin float:
  // 1 pp = 100 bps, 1 décima = 10 bps.
  const scaled = (marginCents * 10000) / revenueCents
  return Math.round(scaled / 10) * 10
}

// ─────────────────────────────────────────────────────────────────────────────
// Matriz
// ─────────────────────────────────────────────────────────────────────────────

export type LineDetail = {
  entryRef: string
  lineNo: number
  accountCode: string
  analyticType: AnalyticType
  projectCode: string | null
  costCenterCode: string | null
  level: MarginLevel
  column: ColumnKey
  amountCents: Cents
}

export type AnalyticCheck = {
  id: string
  level?: MarginLevel
  status: "PASS" | "FAIL" | "WARN"
  expected: number
  actual: number
  evidencia: string
}

export type AnalyticPnl = {
  levels: readonly MarginLevel[]
  columns: readonly ColumnKey[]
  businessLineCodes: readonly string[]
  /** Cumulativa: `M[nivel][col] = Σ aportes de los niveles ≤ nivel`. */
  matrixCents: Record<string, Record<string, Cents>>
  businessLineMatrixCents: Record<string, Record<string, Cents>>
  levelTotalsCents: Record<string, Cents>
  /** Los mismos totales en `BigInt`, para agregados > 2³¹ (I1). */
  levelTotalsBig: Record<string, bigint>
  /** No cumulativo y disperso: solo las celdas con aporte. */
  contributionByLevelCents: Record<string, Record<string, Cents>>
  pygContableCents: Cents
  lineCount67: number
  checks: readonly AnalyticCheck[]
  lineDetail: readonly LineDetail[]
  /** Ids de línea cubiertos por la matriz (I4.c). */
  coveredLineIds: ReadonlySet<string>
  /** Provenance por celda, clave `${level}|${column}`. No entra en el canónico. */
  provenance: ReadonlyMap<string, Provenance>
  period: AnalyticPeriod
}

/** Referencia estable de una línea para I4.c cuando no trae `id`. */
const lineKey = (line: AnalyticLine): string => line.id ?? `${line.entryId}#${line.lineNo}`

export type BuildOptions = {
  /** Etiqueta de asiento del detalle (`entryRef`). Default: `entryId`. */
  entryRefOf?: (line: AnalyticLine) => string
  /** `analyticsHash` y `marginConfigHash` para la provenance de cada celda. */
  analyticsHash?: string
  marginConfigHash?: string
  /** `confianza` de la provenance: "comprobado" con I4 en PASS. */
  confidence?: Confidence
}

/**
 * PyG analítica **cumulativa** del periodo. Sin imputaciones (E5).
 *
 * Devuelve además `contributionByLevelCents` (no cumulativo), los agregados por
 * línea de negocio, `levelTotals`, la provenance por celda y el bloque `checks`.
 */
export function buildAnalyticPnl(
  lines: readonly AnalyticLine[],
  config: AnalyticsConfig,
  period: AnalyticPeriod,
  provCtx: ProvenanceContext,
  opts: BuildOptions = {}
): AnalyticPnl {
  const columns: ColumnKey[] = [
    ...config.projects.map((p) => projectColumn(p.code)),
    ...COST_CENTER_KINDS.map((k) => cecoColumn(k as CostCenterKind)),
    "AMORTIZACION_DETERIORO",
    "FINANCIERO",
    "EXTRAORDINARIO",
    "NO_ANALITICO",
  ]
  const businessLineCodes = config.businessLines.map((b) => b.code)
  const projectCodeById = new Map(config.projects.map((p) => [p.id, p.code]))
  const cecoCodeById = new Map(config.costCenters.map((c) => [c.id, c.code]))
  const blCodeById = new Map(config.businessLines.map((b) => [b.id, b.code]))
  const blCodeOfProject = new Map(
    config.projects.map((p) => [p.code, blCodeById.get(p.businessLineId) ?? null] as const)
  )

  const contrib: Record<string, Map<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) contrib[level] = new Map()

  const detail: LineDetail[] = []
  const covered = new Set<string>()
  let pygContable = 0
  let lineCount67 = 0

  for (const line of lines) {
    if (!isPnlLine(line)) continue
    lineCount67++
    const amount = contribution(line)
    pygContable += amount
    const { level, column } = classifyLine(line, config)
    contrib[level].set(column, (contrib[level].get(column) ?? 0) + amount)
    covered.add(lineKey(line))
    detail.push({
      entryRef: opts.entryRefOf ? opts.entryRefOf(line) : line.entryId,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      analyticType: line.analyticType as AnalyticType,
      projectCode: line.projectId ? (projectCodeById.get(line.projectId) ?? null) : null,
      costCenterCode: line.costCenterId ? (cecoCodeById.get(line.costCenterId) ?? null) : null,
      level,
      column,
      amountCents: amount,
    })
  }

  // Matriz CUMULATIVA.
  const matrixCents: Record<string, Record<string, Cents>> = {}
  const running = new Map<string, Cents>(columns.map((c) => [c, 0]))
  for (const level of MARGIN_LEVELS) {
    for (const column of columns) running.set(column, (running.get(column) ?? 0) + (contrib[level].get(column) ?? 0))
    const row: Record<string, Cents> = {}
    for (const column of columns) row[column] = running.get(column) ?? 0
    matrixCents[level] = row
  }

  // Agregados por línea de negocio (presentación; NO suman al total).
  const businessLineMatrixCents: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) {
    const row: Record<string, Cents> = {}
    for (const code of businessLineCodes) {
      row[code] = config.projects
        .filter((p) => blCodeOfProject.get(p.code) === code)
        .reduce((acc, p) => acc + (matrixCents[level][projectColumn(p.code)] ?? 0), 0)
    }
    businessLineMatrixCents[level] = row
  }

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

  const contributionByLevelCents: Record<string, Record<string, Cents>> = {}
  for (const level of MARGIN_LEVELS) {
    const row: Record<string, Cents> = {}
    for (const column of [...contrib[level].keys()].sort()) row[column] = contrib[level].get(column) ?? 0
    contributionByLevelCents[level] = row
  }

  const checks = buildChecks({
    levelTotalsCents,
    pygContable,
    lineCount67,
    detail,
    businessLineCodes,
    blCodeOfProject,
  })

  // Provenance por celda (§7): métrica, hashes y consulta PARAMETRIZADA.
  const provenance = new Map<string, Provenance>()
  const confidence: Confidence = opts.confidence ?? (checks.every((c) => c.status === "PASS") ? "comprobado" : "calculado")
  for (const level of MARGIN_LEVELS) {
    for (const column of columns) {
      provenance.set(
        `${level}|${column}`,
        cellProvenance(
          metricOf(level, column),
          matrixCents[level][column],
          {
            organizationId: config.organizationId,
            from: period.from,
            to: period.to,
            ...(period.fiscalYearId ? { fiscalYearId: period.fiscalYearId } : {}),
            query: queryFor(column),
            extraParams: paramsFor(column, config),
            ...(opts.analyticsHash ? { analyticsHash: opts.analyticsHash } : {}),
            ...(opts.marginConfigHash ? { marginConfigHash: opts.marginConfigHash } : {}),
          },
          provCtx,
          confidence
        )
      )
    }
  }

  return {
    levels: MARGIN_LEVELS,
    columns,
    businessLineCodes,
    matrixCents,
    businessLineMatrixCents,
    levelTotalsCents,
    levelTotalsBig,
    contributionByLevelCents,
    pygContableCents: pygContable,
    lineCount67,
    checks,
    lineDetail: detail,
    coveredLineIds: covered,
    provenance,
    period,
  }
}

function metricOf(level: MarginLevel, column: ColumnKey): string {
  const lower = level.toLowerCase()
  if (column.startsWith("PROJ:")) return `${lower}.proyecto.${column.slice(5)}`
  if (column.startsWith("CECO:")) return `${lower}.ceco.${column.slice(5)}`
  return `${lower}.${column.toLowerCase()}`
}

const BASE_QUERY =
  "SELECT id FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3 " +
  "AND left(account_code, 1) IN ('6','7') AND entry_kind NOT IN ('REGULARIZATION','CLOSING','OPENING')"

function queryFor(column: ColumnKey): string {
  if (column.startsWith("PROJ:")) return `${BASE_QUERY} AND project_id = $4`
  if (column.startsWith("CECO:")) return `${BASE_QUERY} AND cost_center_id = ANY($4)`
  return `${BASE_QUERY} AND analytic_type = $4`
}

function paramsFor(column: ColumnKey, config: AnalyticsConfig): readonly string[] {
  if (column.startsWith("PROJ:")) {
    return [config.projects.find((p) => p.code === column.slice(5))?.id ?? ""]
  }
  if (column.startsWith("CECO:")) {
    const kind = column.slice(5)
    return [config.costCenters.filter((c) => c.kind === kind).map((c) => c.id).join(",")]
  }
  return [column]
}

function buildChecks(input: {
  levelTotalsCents: Record<string, Cents>
  pygContable: Cents
  lineCount67: number
  detail: readonly LineDetail[]
  businessLineCodes: readonly string[]
  blCodeOfProject: ReadonlyMap<string, string | null>
}): AnalyticCheck[] {
  const { levelTotalsCents, pygContable, lineCount67, detail } = input
  const checks: AnalyticCheck[] = []
  checks.push({
    id: "I4",
    level: "RESULTADO",
    status: levelTotalsCents.RESULTADO === pygContable ? "PASS" : "FAIL",
    expected: pygContable,
    actual: levelTotalsCents.RESULTADO,
    evidencia: "Sigma columnas (RESULTADO) = PyG contable I3",
  })
  checks.push({
    id: "I-E4-1",
    status: detail.length === lineCount67 ? "PASS" : "FAIL",
    expected: lineCount67,
    actual: detail.length,
    evidencia: "toda linea 6/7 del periodo tiene destino en la matriz",
  })
  const badBl = detail.filter(
    (d) => d.projectCode !== null && !input.businessLineCodes.includes(input.blCodeOfProject.get(d.projectCode) ?? "")
  )
  checks.push({
    id: "I-E4-3",
    status: badBl.length === 0 ? "PASS" : "FAIL",
    expected: 0,
    actual: badBl.length,
    evidencia: "businessLine de toda linea con proyecto = la del proyecto",
  })
  const badDim = detail.filter(
    (d) => d.analyticType !== "NO_ANALITICO" && (d.projectCode === null) === (d.costCenterCode === null)
  )
  checks.push({
    id: "I-E4-2",
    status: badDim.length === 0 ? "PASS" : "FAIL",
    expected: 0,
    actual: badDim.length,
    evidencia: "linea 6/7 no NO_ANALITICO con exactamente una dimension",
  })
  const badNa = detail.filter((d) => d.analyticType === "NO_ANALITICO" && (d.projectCode || d.costCenterCode))
  checks.push({
    id: "I-E4-4",
    status: badNa.length === 0 ? "PASS" : "FAIL",
    expected: 0,
    actual: badNa.length,
    evidencia: "NO_ANALITICO nunca lleva dimension",
  })
  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialización canónica (criterio 8: byte a byte contra el JSON sellado)
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalMeta = {
  schemaVersion: string
  generatedBy: string
  note: string
  sourceFixture: string
  fiscalYear: string
}

/**
 * Misma forma que `json.dumps(..., ensure_ascii=False, indent=2) + "\n"` del
 * generador Python. El orden de las claves es el del generador: cambiarlo rompe
 * el test byte a byte, que es exactamente lo que debe pasar.
 */
export function canonicalAnalyticPnlJson(pnl: AnalyticPnl, config: AnalyticsConfig, meta: CanonicalMeta): string {
  const marginLevelConfig: Record<string, readonly AnalyticType[]> = {}
  for (const level of MARGIN_LEVELS) {
    marginLevelConfig[level] = config.levels.find((l) => l.level === level)?.analyticTypes ?? []
  }
  const out = {
    schemaVersion: meta.schemaVersion,
    generatedBy: meta.generatedBy,
    note: meta.note,
    source: {
      fixture: meta.sourceFixture,
      fiscalYear: meta.fiscalYear,
      excludedKinds: [...EXCLUDED_ENTRY_KINDS].sort(),
    },
    marginLevelConfig,
    nonAnalyticSplit: {
      taxPrefixes: [...config.incomeTaxPrefixes],
      taxLevel: "RESULTADO",
      nonAnalyticLevel: config.nonAnalyticLevel,
    },
    levels: [...pnl.levels],
    columns: [...pnl.columns],
    matrixCents: pnl.matrixCents,
    businessLineMatrixCents: pnl.businessLineMatrixCents,
    levelTotalsCents: pnl.levelTotalsCents,
    contributionByLevelCents: pnl.contributionByLevelCents,
    pygContableCents: pnl.pygContableCents,
    lineCount67: pnl.lineCount67,
    checks: pnl.checks.map((c) =>
      c.level === undefined
        ? { id: c.id, status: c.status, expected: c.expected, actual: c.actual, evidencia: c.evidencia }
        : { id: c.id, level: c.level, status: c.status, expected: c.expected, actual: c.actual, evidencia: c.evidencia }
    ),
    lineDetail: pnl.lineDetail,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
