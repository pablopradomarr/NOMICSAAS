/**
 * E4 · T10 — Informe de PyG analítica (`docs/design/E4-analitica.md` §4).
 *
 * Lee (líneas + configuración), delega el cálculo en `lib/analytics/margins.ts`
 * —que es puro— y cachea el resultado **por petición** con clave
 * `(ledgerHash, analyticsHash, periodo)`. La caché es de petición a propósito:
 * una caché de proceso serviría cifras de otra organización o de antes de una
 * reclasificación, que es exactamente lo que `analyticsHash` existe para evitar.
 */

import { analyticsHash as computeAnalyticsHash, marginConfigHash } from "@/lib/analytics/hash"
import { runAnalyticInvariants } from "@/lib/analytics/invariants"
import { buildAnalyticPnl, type AnalyticPnl } from "@/lib/analytics/margins"
import type { AnalyticLine, AnalyticPeriod, AnalyticsConfig, LocalDate } from "@/lib/analytics/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { ProvenanceContext } from "@/lib/ledger/provenance"
import type { TenantTransactionClient } from "@/lib/db"
import { computeLedgerHash } from "@/models/ledger"
import { getAnalyticLines, getAnalyticsConfig } from "@/models/analytics"
import { cache } from "react"

export type AnalyticPnlReport = {
  pnl: AnalyticPnl
  config: AnalyticsConfig
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  /** I4 + los doce `I-E4-*` sobre el mismo conjunto de líneas. */
  checks: CheckResult[]
}

export type AnalyticPnlRequest = {
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string
  /** Contexto de provenance del informe: `run_id`, git-sha y moneda base. */
  provenance: Omit<ProvenanceContext, "ledgerHash" | "module">
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

  const [config, lines, ledgerHash] = await Promise.all([
    getAnalyticsConfig(tx, { periodEnd: request.to }),
    getAnalyticLines(tx, {
      from: request.from,
      to: request.to,
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
    }),
    computeLedgerHash(tx, {
      from: request.from,
      to: request.to,
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
    }),
  ])

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
    null
  )

  const key = analyticPnlCacheKey({
    organizationId: tx.$organizationId,
    from: request.from,
    to: request.to,
    fiscalYearId: request.fiscalYearId ?? null,
    ledgerHash,
    analyticsHash,
    marginConfigHash: configHash,
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
  const pnl = buildAnalyticPnl(lines, config, period, provCtx, { analyticsHash, marginConfigHash: configHash })
  const checks = runAnalyticInvariants({ lines, config, period })

  const report: AnalyticPnlReport = { pnl, config, ledgerHash, analyticsHash, marginConfigHash: configHash, checks }
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

/** Envoltura memoizada por petición de React (RSC). */
export const getAnalyticPnlCached = cache(getAnalyticPnl)
