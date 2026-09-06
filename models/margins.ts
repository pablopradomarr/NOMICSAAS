/**
 * E4 · T10 — Informe de PyG analítica (`docs/design/E4-analitica.md` §4).
 *
 * Lee (líneas + configuración), delega el cálculo en `lib/analytics/margins.ts`
 * —que es puro— y cachea el resultado **por petición** con clave
 * `(ledgerHash, analyticsHash, periodo)`. La caché es de petición a propósito:
 * una caché de proceso serviría cifras de otra organización o de antes de una
 * reclasificación, que es exactamente lo que `analyticsHash` existe para evitar.
 */

import { EMPTY_RUN_SET_HASH, analyticsHash as computeAnalyticsHash, marginConfigHash } from "@/lib/analytics/hash"
import { runAnalyticInvariants } from "@/lib/analytics/invariants"
import { buildAnalyticPnl, buildMatrixView, cellQuery, type AnalyticPnl, type MatrixView } from "@/lib/analytics/margins"
import type { AnalyticLine, AnalyticPeriod, AnalyticsConfig, ColumnKey, LocalDate, MarginLevel } from "@/lib/analytics/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { ProvenanceContext } from "@/lib/ledger/provenance"
import type { TenantTransactionClient } from "@/lib/db"
import { computeLedgerHash } from "@/models/ledger"
import { getAnalyticLines, getAnalyticsConfig } from "@/models/analytics"
import { getAppliedAllocations } from "@/models/allocations"
import type { AppliedAllocation } from "@/lib/analytics/allocate"
import { cache } from "react"

export type AnalyticPnlReport = {
  pnl: AnalyticPnl
  config: AnalyticsConfig
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  /** E5 · O-E5-7 — el CUARTO sello. `sha256("")` sin imputaciones. */
  allocationRunSetHash: string
  /** Los `AllocationRun` vigentes que la matriz ha sumado. */
  allocationRunIds: string[]
  /** `true` con el toggle «con imputaciones» activado. */
  withAllocations: boolean
  /** I4 + los doce `I-E4-*` sobre el mismo conjunto de líneas. */
  checks: CheckResult[]
}

export type AnalyticPnlRequest = {
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string
  /** Contexto de provenance del informe: `run_id`, git-sha y moneda base. */
  provenance: Omit<ProvenanceContext, "ledgerHash" | "module">
  /**
   * E5 — con `true` la matriz suma las imputaciones vigentes del periodo y
   * compone el `analyticsHash` con el `allocationRunSetHash` real; con `false`
   * (default) reproduce EXACTAMENTE el comportamiento de E4. Son dos informes
   * distintos a propósito: la caché no debe servir el uno por el otro.
   */
  withAllocations?: boolean
}

/**
 * BUG E4-UI-1 (T14) — la caché era un `Map` de MÓDULO: vivía entre peticiones y
 * entre organizaciones, sin tope de tamaño. Dos consecuencias: crecía sin
 * límite en el proceso, y una entrada calculada antes de dar de alta un proyecto
 * seguía sirviéndose (la matriz aparecía sin su columna) porque la clave no
 * cubría las dimensiones.
 *
 * Ahora es **por petición** y **acotada**:
 *  - `react.cache` da un `Map` distinto por petición de RSC / server action; y
 *    fuera de una petición (scripts, tests, colas) devuelve un `Map` nuevo en
 *    cada llamada, es decir, no cachea nada — que es el comportamiento seguro.
 *  - `MAX_CACHE_ENTRIES` acota el mapa: una pantalla pide dos o tres periodos,
 *    no cien. Al llenarse se desaloja la entrada más antigua (FIFO).
 */
const MAX_CACHE_ENTRIES = 8

const requestCache = cache((): Map<string, AnalyticPnlReport> => new Map())

/**
 * Clave de la caché: `(orgId, periodo, ledgerHash, analyticsHash,
 * marginConfigHash)` **más la huella de las dimensiones**, que es lo que decide
 * el juego de columnas de `buildAnalyticPnl` y que ningún hash de los otros
 * cubre: `marginConfigHash` sólo lleva niveles, CECOs, prefijos de impuesto y
 * `nonAnalyticLevel`, y `analyticsHash` sólo la asignación de las líneas. Sin
 * ella, dar de alta un proyecto no invalidaba nada.
 */
export function analyticPnlCacheKey(input: {
  organizationId: string
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string | null
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  allocationRunSetHash: string
  config: Pick<AnalyticsConfig, "businessLines" | "projects" | "costCenters">
}): string {
  const dimensions = [
    ...input.config.businessLines.map((b) => `B${b.id}:${b.code}:${b.sortOrder}:${b.isActive}`),
    ...input.config.projects.map((p) => `P${p.id}:${p.code}:${p.businessLineId}:${p.status}:${p.isActive}`),
    ...input.config.costCenters.map((c) => `C${c.id}:${c.code}:${c.kind}:${c.marginLevel}:${c.isActive}`),
  ].join(",")
  return [
    input.organizationId,
    input.from,
    input.to,
    input.fiscalYearId ?? "*",
    input.ledgerHash,
    input.analyticsHash,
    input.marginConfigHash,
    input.allocationRunSetHash,
    dimensions,
  ].join("|")
}

/** Vacía la caché de ESTA petición. Sólo la usan los tests. */
export const clearMarginCache = (): void => requestCache().clear()

/** Informe completo. No calcula nada por su cuenta: compone y delega. */
export async function getAnalyticPnl(
  tx: TenantTransactionClient,
  request: AnalyticPnlRequest
): Promise<AnalyticPnlReport> {
  const period: AnalyticPeriod = {
    from: request.from,
    to: request.to,
    fiscalYearId: request.fiscalYearId ?? null,
  }

  // Hallazgo #6: **una sola lectura** de las líneas alimenta al motor y al
  // `analyticsHash`. El `ledgerHash` sí sale de un agregado en la base (no
  // materializa el diario) y la configuración es una lectura de catálogo.
  // En SERIE: `getAnalyticLines` y `computeLedgerHash` son `$queryRaw` y dentro
  // de la transacción comparten la ÚNICA conexión; en paralelo, el adaptador
  // `pg` avisa de «client is already executing a query».
  const config = await getAnalyticsConfig(tx, { periodEnd: request.to })
  const lines = await getAnalyticLines(tx, {
    from: request.from,
    to: request.to,
    ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
  })
  const ledgerHash = await computeLedgerHash(tx, {
    from: request.from,
    to: request.to,
    ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
  })

  // E5: la tercera lectura, también EN SERIE. Sin imputaciones no toca la base.
  const withAllocations = request.withAllocations === true
  const applied = withAllocations
    ? await getAppliedAllocations(tx, { from: request.from, to: request.to })
    : { lines: [] as AppliedAllocation[], runIds: [] as string[], runSetHash: EMPTY_RUN_SET_HASH }

  const configHash = marginConfigHash(config)
  const analyticsHash = computeAnalyticsHash(
    lines.map((l: AnalyticLine) => ({
      entryId: l.entryId,
      lineNo: l.lineNo,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
      businessLineId: l.businessLineId,
      analyticType: l.analyticType,
    })),
    configHash,
    applied.runSetHash
  )

  const key = analyticPnlCacheKey({
    organizationId: tx.$organizationId,
    from: request.from,
    to: request.to,
    fiscalYearId: request.fiscalYearId ?? null,
    ledgerHash,
    analyticsHash,
    marginConfigHash: configHash,
    allocationRunSetHash: applied.runSetHash,
    config,
  })
  const memo = requestCache()
  const cached = memo.get(key)
  if (cached) return cached

  const provCtx: ProvenanceContext = {
    ...request.provenance,
    ledgerHash,
    module: "lib/analytics/margins.ts",
  }
  const pnl = buildAnalyticPnl(lines, config, period, provCtx, {
    analyticsHash,
    marginConfigHash: configHash,
    ...(withAllocations ? { allocations: applied.lines } : {}),
  })
  const checks = runAnalyticInvariants({
    lines,
    config,
    period,
    ...(withAllocations ? { allocations: applied.lines } : {}),
  })

  const report: AnalyticPnlReport = {
    pnl,
    config,
    ledgerHash,
    analyticsHash,
    marginConfigHash: configHash,
    allocationRunSetHash: applied.runSetHash,
    allocationRunIds: applied.runIds,
    withAllocations,
    checks,
  }
  // Acotada: FIFO sobre la entrada más antigua. Una pantalla pide dos o tres
  // periodos; lo que no puede es crecer sin techo dentro de una petición.
  while (memo.size >= MAX_CACHE_ENTRIES) {
    const oldest = memo.keys().next()
    if (oldest.done) break
    memo.delete(oldest.value)
  }
  memo.set(key, report)
  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// Detalle de una celda, BAJO DEMANDA (hallazgo #5)
// ─────────────────────────────────────────────────────────────────────────────

export type CellDetailLine = {
  lineId: string
  entryId: string
  /** Etiqueta del asiento en la UI: su número dentro del ejercicio. */
  entryRef: string
  entryNumber: number
  lineNo: number
  entryDate: LocalDate
  accountCode: string
  accountName: string
  analyticType: string
  projectCode: string | null
  costCenterCode: string | null
  description: string | null
  debitCents: number
  creditCents: number
  amountCents: number
}

export type CellDetail = {
  level: MarginLevel
  column: ColumnKey
  /** La consulta parametrizada que ha producido estas filas (provenance). */
  query: string
  /** Suma de los aportes devueltos: debe coincidir con la celda pintada. */
  amountCents: number
  lines: CellDetailLine[]
  truncated: boolean
}

const DETAIL_LIMIT = 500

/**
 * Ejecuta la consulta de provenance de UNA celda y devuelve sus líneas.
 *
 * Es lo que hace innecesario serializar `lineDetail` entero al cliente: la
 * tabla se pinta con `MatrixView` (sin líneas) y el drill-down pide sólo la
 * celda que el usuario ha pinchado. La consulta es la MISMA que va en la
 * provenance, con los mismos parámetros, así que el número que devuelve es por
 * construcción el que se muestra.
 */
export async function getCellDetail(
  tx: TenantTransactionClient,
  request: { level: MarginLevel; column: ColumnKey; from: LocalDate; to: LocalDate; fiscalYearId?: string }
): Promise<CellDetail> {
  const config = await getAnalyticsConfig(tx, { periodEnd: request.to })
  const period: AnalyticPeriod = {
    from: request.from,
    to: request.to,
    fiscalYearId: request.fiscalYearId ?? null,
  }
  const { query, params } = cellQuery(request.level, request.column, config, period)

  // La consulta de provenance devuelve ids; aquí se envuelve para traer también
  // las columnas que el drill-down enseña, sin tocar el filtro.
  const rows = await tx.$queryRawUnsafe<
    {
      id: string
      entry_id: string
      entry_number: number
      line_no: number
      entry_date: Date
      account_code: string
      account_name: string | null
      analytic_type: string | null
      project_code: string | null
      cost_center_code: string | null
      description: string | null
      debit_cents: number
      credit_cents: number
    }[]
  >(
    `SELECT l.id, l.entry_id, e.entry_number, l.line_no, l.entry_date, l.account_code,
            a.name AS account_name, l.analytic_type::text AS analytic_type,
            p.code AS project_code, c.code AS cost_center_code,
            l.description, l.debit_cents, l.credit_cents
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
       LEFT JOIN accounts a ON a.organization_id = l.organization_id AND a.code = l.account_code
       LEFT JOIN projects p ON p.id = l.project_id
       LEFT JOIN cost_centers c ON c.id = l.cost_center_id
      WHERE l.id IN (${query})
      ORDER BY l.entry_date, e.entry_number, l.line_no
      LIMIT ${DETAIL_LIMIT + 1}`,
    ...params
  )

  const truncated = rows.length > DETAIL_LIMIT
  const lines: CellDetailLine[] = rows.slice(0, DETAIL_LIMIT).map((r) => ({
    lineId: r.id,
    entryId: r.entry_id,
    entryRef: String(r.entry_number),
    entryNumber: r.entry_number,
    lineNo: r.line_no,
    entryDate: r.entry_date.toISOString().slice(0, 10),
    accountCode: r.account_code,
    accountName: r.account_name ?? "",
    analyticType: r.analytic_type ?? "",
    projectCode: r.project_code,
    costCenterCode: r.cost_center_code,
    description: r.description,
    debitCents: r.debit_cents,
    creditCents: r.credit_cents,
    amountCents: r.credit_cents - r.debit_cents,
  }))

  return {
    level: request.level,
    column: request.column,
    query,
    amountCents: rows.slice(0, DETAIL_LIMIT).reduce((a, r) => a + r.credit_cents - r.debit_cents, 0),
    lines,
    truncated,
  }
}

/** La matriz lista para pintar, sin líneas dentro (hallazgo #5). */
export const matrixViewOf = (report: AnalyticPnlReport): MatrixView => buildMatrixView(report.pnl, report.config)
