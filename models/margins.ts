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
 * Caché por petición (`react.cache`): dos celdas de la misma pantalla que
 * pidan el mismo periodo comparten un solo cálculo, y la clave incluye los dos
 * hashes, de modo que una reclasificación en la misma petición produce una
 * entrada nueva.
 */
const memo = new Map<string, AnalyticPnlReport>()

export const clearMarginCache = (): void => memo.clear()

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

  /**
   * BUG E4-UI-1 (T14): la clave NO contenía las dimensiones, y `marginConfigHash`
   * tampoco las cubre (sólo niveles, CECOs, prefijos de impuesto y
   * `nonAnalyticLevel`). Con la caché viva entre peticiones, dar de alta un
   * proyecto no invalidaba nada y la matriz seguía sirviéndose SIN su columna
   * hasta que cambiara el diario. Se añade la huella de las dimensiones, que es
   * justo lo que decide el juego de columnas de `buildAnalyticPnl`.
   */
  const dimensionsKey = [
    ...config.businessLines.map((b) => `${b.id}:${b.code}:${b.sortOrder}:${b.isActive}`),
    ...config.projects.map((p) => `${p.id}:${p.code}:${p.businessLineId}:${p.status}:${p.isActive}`),
  ].join(",")

  const key = `${tx.$organizationId}|${request.from}|${request.to}|${ledgerHash}|${analyticsHash}|${configHash}|${dimensionsKey}`
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
  memo.set(key, report)
  return report
}

/** Envoltura memoizada por petición de React (RSC). */
export const getAnalyticPnlCached = cache(getAnalyticPnl)
