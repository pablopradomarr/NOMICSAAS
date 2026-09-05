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
  AnalyticsErrorCode,
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

/** Los ocho valores del enum `AnalyticType`. Un valor fuera de aquí es basura. */
export const ANALYTIC_TYPES: ReadonlySet<string> = new Set<AnalyticType>([
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "NO_ANALITICO",
])

/** Motivo por el que una línea no se pudo clasificar por la vía normal. */
export type ResolutionFallback = { code: AnalyticsErrorCode; message: string }

/**
 * Destino completo de una línea. **Total**: siempre devuelve nivel y columna.
 * Una línea que no se puede clasificar cae en `NO_ANALITICO` con `fallback`
 * relleno, y el aporte se conserva: I4 (Σ matriz = PyG contable) sigue en PASS
 * aunque los datos estén sucios. Antes esto lanzaba y tumbaba la pantalla.
 */
export type LineDestination = {
  analyticType: AnalyticType | null
  level: MarginLevel
  column: ColumnKey
  fallback: ResolutionFallback | null
}

/** R-A11: el impuesto sobre beneficios va clavado a RESULTADO. */
const nonAnalyticLevelOf = (line: AnalyticLine, config: AnalyticsConfig): MarginLevel =>
  config.incomeTaxPrefixes.some((p) => line.accountCode.startsWith(p)) ? "RESULTADO" : config.nonAnalyticLevel

const where = (line: AnalyticLine): string => `La línea ${line.lineNo} de ${line.entryId}`

/**
 * Destino (tipo efectivo, nivel y columna) de una línea 6/7, sin excepciones
 * salvo la incoherencia de configuración `CECO_MARGIN_LEVEL` (la BD tiene un
 * CHECK que la impide, así que ahí sí queremos ruido).
 *
 * Orden:
 *   1. tipo persistido, si es un `AnalyticType` conocido;
 *   2. si es NULL o desconocido, se REHACE por el default de la cuenta con las
 *      reglas R-A3/R-A4 (`resolveEffectiveAnalyticType`) — el caso normal de una
 *      línea 6/7 con CECO o proyecto y `analytic_type` sin poblar;
 *   3. si tampoco hay default, columna `NO_ANALITICO` + `fallback` (I-E4-1).
 */
/**
 * E6 · T20 (deuda de E4) — índices O(1) por configuración.
 *
 * `resolveDestination` hacía `config.projects.find(...)` y
 * `config.costCenters.find(...)` **por línea**: con 60 proyectos y 40 000 líneas
 * son 2,4 millones de comparaciones de cadena por informe, y la matriz analítica
 * se nota. Los índices se memoizan por la IDENTIDAD del objeto de configuración
 * en un `WeakMap`, así que se construyen una vez por petición y se recogen con
 * la propia configuración; una configuración nueva —una reimputación, un
 * proyecto de alta— produce un objeto nuevo y por tanto un índice nuevo, sin
 * invalidación manual que pueda quedarse obsoleta.
 */
type ConfigIndex = {
  projectsById: ReadonlyMap<string, AnalyticsConfig["projects"][number]>
  costCentersById: ReadonlyMap<string, AnalyticsConfig["costCenters"][number]>
}

const configIndexCache = new WeakMap<AnalyticsConfig, ConfigIndex>()

function configIndex(config: AnalyticsConfig): ConfigIndex {
  const cached = configIndexCache.get(config)
  if (cached) return cached
  const index: ConfigIndex = {
    projectsById: new Map(config.projects.map((p) => [p.id, p])),
    costCentersById: new Map(config.costCenters.map((c) => [c.id, c])),
  }
  configIndexCache.set(config, index)
  return index
}

export function resolveDestination(line: AnalyticLine, config: AnalyticsConfig): LineDestination {
  const declared = line.analyticType
  const known = declared !== null && ANALYTIC_TYPES.has(declared) ? declared : null

  let type = known
  if (type !== null) {
    // R-A3/R-A4 sobre el tipo persistido: la dimensión de la línea manda cuando
    // contradice al tipo (p. ej. una línea rutada a CC-NA por R-A8 conserva
    // `INGRESO_DIRECTO` y sin esto quedaría sin columna).
    const hasProject = line.projectId !== null && line.projectId !== undefined
    const hasCostCenter = line.costCenterId !== null && line.costCenterId !== undefined
    if (type === "INDIRECTO_CECO" && hasProject && !hasCostCenter) type = "COSTE_DIRECTO_MC2"
    else if (DIRECT_TYPES.has(type) && hasCostCenter && !hasProject) type = "INDIRECTO_CECO"
  }
  if (type === null) {
    // R-A4 y R-A3: default de la cuenta con herencia de hoja, ajustado por la
    // dimensión que sí trae la línea.
    type = resolveEffectiveAnalyticType(
      {
        accountCode: line.accountCode,
        analyticType: null,
        projectId: line.projectId,
        costCenterId: line.costCenterId,
      },
      config
    )
    if (type === null) {
      const detalle = declared === null ? "no tiene tipo analítico" : `tiene el tipo desconocido «${declared}»`
      return {
        analyticType: null,
        level: nonAnalyticLevelOf(line, config),
        column: "NO_ANALITICO",
        fallback: {
          code: "TYPE_UNKNOWN",
          message: `${where(line)} ${detalle} y la cuenta ${line.accountCode} no tiene tipo por defecto (R-A4)`,
        },
      }
    }
  }

  if (type === "NO_ANALITICO") {
    return { analyticType: type, level: nonAnalyticLevelOf(line, config), column: "NO_ANALITICO", fallback: null }
  }

  if (type === "INDIRECTO_CECO") {
    const ceco = line.costCenterId ? configIndex(config).costCentersById.get(line.costCenterId) : undefined
    if (!ceco) {
      return {
        analyticType: type,
        level: nonAnalyticLevelOf(line, config),
        column: "NO_ANALITICO",
        fallback: {
          code: "CECO_UNKNOWN",
          message: `${where(line)} apunta a un centro de coste desconocido (${line.costCenterId})`,
        },
      }
    }
    if (ceco.marginLevel !== "MC3" && ceco.marginLevel !== "EBITDA") {
      // Incoherencia de CONFIGURACIÓN, no de datos: la impide un CHECK en la BD.
      // Error de CONFIGURACIÓN, no de cuadre: bloquea el informe entero en vez
      // de inventar un nivel (§5.1, casos límite). Un fallback silencioso
      // movería importe de nivel sin que nadie lo supiera, que es peor que no
      // pintar la matriz. En la práctica es inalcanzable: el CHECK
      // `cost_centers_margin_level` lo impide en la base desde E4.
      throw new AnalyticsError(
        "CECO_MARGIN_LEVEL",
        `El centro de coste ${ceco.code} tiene marginLevel ${ceco.marginLevel}: solo admite MC3 o EBITDA. ` +
          "Corrígelo en /analytics/cost-centers antes de emitir la PyG analítica"
      )
    }
    return { analyticType: type, level: ceco.marginLevel, column: cecoColumn(ceco.kind), fallback: null }
  }

  const configured = levelByType(config).get(type)
  const level = configured ?? nonAnalyticLevelOf(line, config)
  const levelFallback: ResolutionFallback | null = configured
    ? null
    : { code: "TYPE_UNKNOWN", message: `El tipo ${type} no está en ningún nivel de MarginLevelConfig (MLC-1)` }

  const projectOf = (): { column: ColumnKey; fallback: ResolutionFallback | null } => {
    const project = line.projectId ? configIndex(config).projectsById.get(line.projectId) : undefined
    if (project) return { column: projectColumn(project.code), fallback: levelFallback }
    return {
      column: "NO_ANALITICO",
      fallback:
        levelFallback ??
        (line.projectId
          ? { code: "PROJECT_UNKNOWN", message: `${where(line)} apunta a un proyecto desconocido (${line.projectId})` }
          : { code: "DEST_MISSING", message: `Tipo ${type} sin proyecto en ${where(line).toLowerCase()}` }),
    }
  }

  if (DIRECT_TYPES.has(type)) return { analyticType: type, level, ...projectOf() }
  if (type === "AMORTIZACION_DETERIORO") {
    if (!line.projectId) return { analyticType: type, level, column: "AMORTIZACION_DETERIORO", fallback: levelFallback }
    return { analyticType: type, level, ...projectOf() }
  }
  if (type === "FINANCIERO") return { analyticType: type, level, column: "FINANCIERO", fallback: levelFallback }
  if (type === "EXTRAORDINARIO") return { analyticType: type, level, column: "EXTRAORDINARIO", fallback: levelFallback }
  return { analyticType: type, level, column: "NO_ANALITICO", fallback: levelFallback }
}

/**
 * Nivel de margen. Determinista y **total** (nunca lanza por datos sucios).
 *   `INDIRECTO_CECO`  → `CostCenter.marginLevel` (MC3 | EBITDA)   (R-A6/R-A7)
 *   `NO_ANALITICO`    → `RESULTADO` si la cuenta ∈ `incomeTaxPrefixes`,
 *                       si no `config.nonAnalyticLevel`           (R-A11)
 *   resto             → por `MarginLevelConfig.analyticTypes`
 * `CostCenter.marginLevel` NO se aplica a ningún otro tipo: un `668` en
 * `CC-FIN` cae en BAI, no en EBITDA (R-A6).
 */
export function resolveLevel(line: AnalyticLine, config: AnalyticsConfig): MarginLevel {
  return resolveDestination(line, config).level
}

/**
 * Columna. **La fija el tipo efectivo, no la dimensión** (R-A5). Excepción
 * única: `AMORTIZACION_DETERIORO` con `projectId` va a la columna del proyecto.
 */
export function resolveColumn(line: AnalyticLine, config: AnalyticsConfig): ColumnKey {
  return resolveDestination(line, config).column
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
  const dest = resolveDestination(line, config)
  return { level: dest.level, column: dest.column, amountCents: contribution(line) }
}

/**
 * % de margen con 1 decimal, en puntos básicos ENTEROS (nada de Float).
 * `null` si los ingresos de la columna son 0: se pinta `—`, nunca `0 %` ni NaN
 * (gap G-05, I-E4-6). Ningún porcentaje se persiste.
 */
export function marginBps(marginCents: Cents, revenueCents: Cents): number | null {
  if (revenueCents === 0) return null
  // Décimas de punto porcentual: 1 pp = 100 bps, 1 décima = 10 bps.
  //
  // Hallazgo #9: el redondeo es **simétrico** (half away from zero). Con
  // `Math.round` —que redondea hacia +∞— un −0,05 % se convertía en −0,0 % y un
  // +0,05 % en +0,1 %: el mismo margen en valor absoluto se presentaba distinto
  // según el signo, y una pérdida pequeña se veía como cero.
  const scaled = (marginCents * 10000) / revenueCents
  const tenths = scaled / 10
  const rounded = tenths < 0 ? -Math.round(-tenths) : Math.round(tenths)
  return rounded * 10
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
  /** Solo presente si la línea NO se pudo clasificar por la vía normal. */
  fallback?: string
}

/** Línea que cayó en `NO_ANALITICO` (o en un nivel de reserva) por datos sucios. */
export type UnresolvedLine = {
  entryRef: string
  lineNo: number
  accountCode: string
  code: AnalyticsErrorCode
  message: string
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
  /** Líneas degradadas a `NO_ANALITICO`: alimentan I-E4-1 en WARN/FAIL. */
  unresolved: readonly UnresolvedLine[]
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
  const unresolved: UnresolvedLine[] = []
  const covered = new Set<string>()
  let pygContable = 0
  let lineCount67 = 0

  for (const line of lines) {
    if (!isPnlLine(line)) continue
    lineCount67++
    const amount = contribution(line)
    pygContable += amount
    const { level, column, analyticType, fallback } = resolveDestination(line, config)
    contrib[level].set(column, (contrib[level].get(column) ?? 0) + amount)
    covered.add(lineKey(line))
    const entryRef = opts.entryRefOf ? opts.entryRefOf(line) : line.entryId
    if (fallback) {
      unresolved.push({
        entryRef,
        lineNo: line.lineNo,
        accountCode: line.accountCode,
        code: fallback.code,
        message: fallback.message,
      })
    }
    detail.push({
      entryRef,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      analyticType: analyticType ?? "NO_ANALITICO",
      projectCode: line.projectId ? (projectCodeById.get(line.projectId) ?? null) : null,
      costCenterCode: line.costCenterId ? (cecoCodeById.get(line.costCenterId) ?? null) : null,
      level,
      column,
      amountCents: amount,
      ...(fallback ? { fallback: fallback.code } : {}),
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
    unresolved,
    analyticsRequired: config.analyticsRequired,
  })

  // Provenance por celda (§7): métrica, hashes y consulta PARAMETRIZADA.
  const provenance = new Map<string, Provenance>()
  const confidence: Confidence = opts.confidence ?? (checks.every((c) => c.status === "PASS") ? "comprobado" : "calculado")
  for (const level of MARGIN_LEVELS) {
    for (const column of columns) {
      const cell = cellQuery(level, column, config, period)
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
            query: cell.query,
            extraParams: cell.params.slice(3),
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
    unresolved,
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

/**
 * Consulta de provenance de una celda (§7, hallazgo #3 de la revisión).
 *
 * **La celda de la matriz es CUMULATIVA**: `M[nivel][col]` es la suma de los
 * aportes de todos los niveles ≤ nivel en esa columna. La consulta reproduce
 * EXACTAMENTE ese valor —no el aporte incremental del nivel—, porque es el
 * número que la pantalla muestra y el que el usuario pincha. El aporte
 * incremental vive en `contributionByLevelCents` y su provenance se obtiene con
 * `cellQuery(..., { incremental: true })`.
 *
 * Para lograrlo, el filtro no puede ser «esta columna» a secas: hay que acotar
 * también QUÉ líneas de esa columna caen en un nivel ≤ el de la celda. Como el
 * nivel de una línea se deriva del tipo efectivo (y, para `INDIRECTO_CECO`, del
 * `marginLevel` de su CECO; y para `NO_ANALITICO`, del prefijo de cuenta), el
 * filtro se materializa en conjuntos concretos de `analytic_type` y de
 * `cost_center_id`, que viajan como **arrays parametrizados** (`= ANY($n)`),
 * nunca interpolados ni concatenados en una cadena.
 */
const BASE_QUERY =
  "SELECT id FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3 " +
  "AND left(account_code, 1) IN ('6','7') AND entry_kind NOT IN ('REGULARIZATION','CLOSING','OPENING')"

/** Índice de nivel en el orden de acumulación (`INGRESOS` = 0 … `RESULTADO` = 7). */
const levelIndex = (level: MarginLevel): number => MARGIN_LEVELS.indexOf(level)

/** Tipos con columna y nivel FIJOS por configuración (todos salvo INDIRECTO_CECO y NO_ANALITICO). */
function typesAtOrBelow(level: MarginLevel, config: AnalyticsConfig, only: readonly AnalyticType[]): string[] {
  const byType = levelByType(config)
  const max = levelIndex(level)
  return only.filter((t) => {
    const l = byType.get(t)
    return l !== undefined && levelIndex(l) <= max
  })
}

export type CellQuery = { query: string; params: readonly (string | readonly string[])[] }

export type CellQueryOptions = {
  /** `true` para el aporte del nivel; por defecto, el valor CUMULATIVO. */
  incremental?: boolean
}

/**
 * Consulta parametrizada que devuelve **exactamente** las líneas que suman la
 * celda `(level, column)`. Los tres primeros parámetros son siempre
 * `(organizationId, from, to)`.
 */
export function cellQuery(
  level: MarginLevel,
  column: ColumnKey,
  config: AnalyticsConfig,
  period: AnalyticPeriod,
  opts: CellQueryOptions = {}
): CellQuery {
  const base: (string | readonly string[])[] = [config.organizationId, period.from, period.to]
  const at = levelIndex(level)
  /** Niveles admitidos: sólo el de la celda si es incremental, todos los ≤ si no. */
  const accepts = (candidate: MarginLevel): boolean =>
    opts.incremental ? candidate === level : levelIndex(candidate) <= at

  if (column.startsWith("PROJ:")) {
    // A una columna de proyecto sólo llegan los tres tipos directos y
    // `AMORTIZACION_DETERIORO` con proyecto (R-A5, excepción única).
    const types = typesAtOrBelow(
      level,
      config,
      ["INGRESO_DIRECTO", "COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2", "AMORTIZACION_DETERIORO"] as const
    ).filter((t) => accepts(levelByType(config).get(t as AnalyticType) as MarginLevel))
    const projectId = config.projects.find((p) => p.code === column.slice(5))?.id ?? ""
    return {
      query: `${BASE_QUERY} AND project_id = $4 AND analytic_type = ANY($5::analytic_type[])`,
      params: [...base, projectId, types],
    }
  }

  if (column.startsWith("CECO:")) {
    // A una columna de CECO sólo llega `INDIRECTO_CECO`, y su nivel es el
    // `marginLevel` del propio CECO (R-A6/R-A7): se filtra por los ids cuyo
    // nivel entra en la celda.
    const kind = column.slice(5)
    const ids = config.costCenters.filter((c) => c.kind === kind && accepts(c.marginLevel)).map((c) => c.id)
    return {
      query: `${BASE_QUERY} AND cost_center_id = ANY($4::uuid[]) AND analytic_type = 'INDIRECTO_CECO'`,
      params: [...base, ids],
    }
  }

  if (column === "AMORTIZACION_DETERIORO") {
    const included = accepts(levelByType(config).get("AMORTIZACION_DETERIORO") ?? "EBIT")
    return {
      query: `${BASE_QUERY} AND project_id IS NULL AND analytic_type = ANY($4::analytic_type[])`,
      params: [...base, included ? ["AMORTIZACION_DETERIORO"] : []],
    }
  }

  if (column === "FINANCIERO" || column === "EXTRAORDINARIO") {
    const included = accepts(levelByType(config).get(column) ?? "BAI")
    return {
      query: `${BASE_QUERY} AND analytic_type = ANY($4::analytic_type[])`,
      params: [...base, included ? [column] : []],
    }
  }

  // `NO_ANALITICO` se parte en dos por R-A11: el impuesto sobre beneficios está
  // clavado en RESULTADO y el resto cae en `nonAnalyticLevel`.
  const taxIncluded = accepts("RESULTADO")
  const restIncluded = accepts(config.nonAnalyticLevel)
  const prefixes = [...config.incomeTaxPrefixes]
  if (taxIncluded && restIncluded) {
    return { query: `${BASE_QUERY} AND analytic_type = 'NO_ANALITICO'`, params: base }
  }
  if (taxIncluded) {
    return {
      query: `${BASE_QUERY} AND analytic_type = 'NO_ANALITICO' AND left(account_code, 3) = ANY($4::text[])`,
      params: [...base, prefixes],
    }
  }
  if (restIncluded) {
    return {
      query: `${BASE_QUERY} AND analytic_type = 'NO_ANALITICO' AND left(account_code, 3) <> ALL($4::text[])`,
      params: [...base, prefixes],
    }
  }
  return { query: `${BASE_QUERY} AND false`, params: base }
}

function buildChecks(input: {
  levelTotalsCents: Record<string, Cents>
  pygContable: Cents
  lineCount67: number
  detail: readonly LineDetail[]
  businessLineCodes: readonly string[]
  blCodeOfProject: ReadonlyMap<string, string | null>
  unresolved: readonly UnresolvedLine[]
  analyticsRequired: boolean
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
  // I-E4-1: cobertura. Toda línea 6/7 tiene celda (la matriz es total), pero las
  // que llegan ahí degradadas a NO_ANALITICO no son un PASS: WARN, o FAIL si la
  // organización exige destino analítico (R-A8).
  const degraded = input.unresolved
  checks.push({
    id: "I-E4-1",
    status:
      detail.length !== lineCount67
        ? "FAIL"
        : degraded.length === 0
          ? "PASS"
          : input.analyticsRequired
            ? "FAIL"
            : "WARN",
    expected: lineCount67,
    actual: detail.length - degraded.length,
    evidencia:
      degraded.length === 0
        ? "toda linea 6/7 del periodo tiene destino en la matriz"
        : `${degraded.length} linea(s) 6/7 sin destino resoluble, servidas en NO_ANALITICO: ` +
          degraded
            .slice(0, 10)
            .map((u) => `${u.entryRef}#${u.lineNo} (${u.accountCode}, ${u.code})`)
            .join(", "),
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
  // Las líneas degradadas ya las reporta I-E4-1: no se cuentan dos veces.
  const badDim = detail.filter(
    (d) => d.fallback === undefined && d.analyticType !== "NO_ANALITICO" && (d.projectCode === null) === (d.costCenterCode === null)
  )
  checks.push({
    id: "I-E4-2",
    status: badDim.length === 0 ? "PASS" : "FAIL",
    expected: 0,
    actual: badDim.length,
    evidencia: "linea 6/7 no NO_ANALITICO con exactamente una dimension",
  })
  const badNa = detail.filter(
    (d) => d.fallback === undefined && d.analyticType === "NO_ANALITICO" && (d.projectCode || d.costCenterCode)
  )
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

// ─────────────────────────────────────────────────────────────────────────────
// Vista de la matriz para la UI (hallazgo #5 de la revisión)
// ─────────────────────────────────────────────────────────────────────────────

export type MatrixCell = {
  level: MarginLevel
  column: ColumnKey
  /** Valor CUMULATIVO: el que se pinta. */
  amountCents: Cents
  /** Aporte del nivel (no cumulativo), para el desglose de la fila. */
  contributionCents: Cents
  /** % sobre los ingresos de la columna, en bps enteros. `null` = se pinta «—». */
  marginBps: number | null
}

export type MatrixColumn = {
  key: ColumnKey
  kind: "PROJECT" | "COST_CENTER" | "TYPE"
  /** Etiqueta corta ya resuelta: código de proyecto, `kind` de CECO o el tipo. */
  label: string
  /** Sólo en columnas de proyecto: bajo qué línea de negocio se agrupa. */
  businessLineCode: string | null
}

/**
 * Matriz lista para pintar, **sin una sola línea de diario dentro**.
 *
 * Motivo (hallazgo #5): serializar `lineDetail` al cliente son 85 objetos en el
 * fixture y decenas de miles en un ejercicio real, para pintar una tabla de
 * 8 × N celdas que no los usa. El detalle de una celda se pide **bajo demanda**
 * con `analyticCellDetailAction`, que ejecuta la consulta parametrizada de la
 * provenance de esa celda.
 *
 * El acceso a celda es **O(1)**: `cellAt(level, column)` indexa un `Map` por
 * `${level}|${column}` en vez de recorrer filas.
 */
export type MatrixView = {
  levels: readonly { level: MarginLevel; label: string; isVisible: boolean }[]
  columns: readonly MatrixColumn[]
  businessLineCodes: readonly string[]
  cells: ReadonlyMap<string, MatrixCell>
  businessLineMatrixCents: Record<string, Record<string, Cents>>
  levelTotalsCents: Record<string, Cents>
  cellAt: (level: MarginLevel, column: ColumnKey) => MatrixCell | undefined
  totalAt: (level: MarginLevel) => Cents
}

export const cellKey = (level: MarginLevel, column: ColumnKey): string => `${level}|${column}`

export function buildMatrixView(pnl: AnalyticPnl, config: AnalyticsConfig): MatrixView {
  const projectByCode = new Map(config.projects.map((p) => [p.code, p]))
  const blCodeById = new Map(config.businessLines.map((b) => [b.id, b.code]))

  const columns: MatrixColumn[] = pnl.columns.map((key) => {
    if (key.startsWith("PROJ:")) {
      const code = key.slice(5)
      const project = projectByCode.get(code)
      return {
        key,
        kind: "PROJECT" as const,
        label: code,
        businessLineCode: project ? (blCodeById.get(project.businessLineId) ?? null) : null,
      }
    }
    if (key.startsWith("CECO:")) {
      return { key, kind: "COST_CENTER" as const, label: key.slice(5), businessLineCode: null }
    }
    return { key, kind: "TYPE" as const, label: key, businessLineCode: null }
  })

  const cells = new Map<string, MatrixCell>()
  for (const level of pnl.levels) {
    for (const column of pnl.columns) {
      const amountCents = pnl.matrixCents[level][column] ?? 0
      cells.set(cellKey(level, column), {
        level,
        column,
        amountCents,
        contributionCents: pnl.contributionByLevelCents[level]?.[column] ?? 0,
        // El denominador del margen es SIEMPRE la fila de ingresos de la misma
        // columna: un margen sobre otra base no es comparable entre columnas.
        marginBps: marginBps(amountCents, pnl.matrixCents.INGRESOS[column] ?? 0),
      })
    }
  }

  return {
    levels: pnl.levels.map((level) => {
      const row = config.levels.find((l) => l.level === level)
      return { level, label: row?.label ?? level, isVisible: row?.isVisible ?? true }
    }),
    columns,
    businessLineCodes: pnl.businessLineCodes,
    cells,
    businessLineMatrixCents: pnl.businessLineMatrixCents,
    levelTotalsCents: pnl.levelTotalsCents,
    cellAt: (level, column) => cells.get(cellKey(level, column)),
    totalAt: (level) => pnl.levelTotalsCents[level] ?? 0,
  }
}
