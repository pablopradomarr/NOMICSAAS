/**
 * E4 · T4 — `analyticsHash` y `marginConfigHash` (E4-D2, §2.5).
 *
 * El tercer sello: cambia con la reclasificación, con `MarginLevelConfig`, con
 * el `analyticType` de una cuenta y con una liquidación nueva de CECOs (E5).
 * Caduca únicamente los `ReportRun` de tipo `PYG_ANALITICA`, `PRESUPUESTO_REAL`
 * y `DASHBOARD`; los financieros siguen vigentes porque `ledgerHash` no cambia.
 *
 * Módulo PURO.
 */

import { createHash } from "node:crypto"

import type { AnalyticsConfig, AnalyticType, MarginLevel } from "@/lib/analytics/types"

const NULL_TOKEN = "∅"
const nullable = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? NULL_TOKEN : v)
const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** Lo mínimo que una línea aporta al sello analítico. */
export type AnalyticHashableLine = {
  entryId: string
  lineNo: number
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  analyticType?: AnalyticType | null
}

/** Orden canónico del sello analítico: `(entryId, lineNo)`. */
function canonicalSort(lines: readonly AnalyticHashableLine[]): AnalyticHashableLine[] {
  return [...lines].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0) || a.lineNo - b.lineNo)
}

export function canonicalAnalyticsForm(lines: readonly AnalyticHashableLine[]): string {
  return canonicalSort(lines)
    .map((l) =>
      [
        l.entryId,
        String(l.lineNo),
        nullable(l.projectId),
        nullable(l.costCenterId),
        nullable(l.businessLineId),
        nullable(l.analyticType),
      ].join("\t")
    )
    .join("\n")
}

/**
 * Forma canónica de la configuración: los ocho niveles con su reparto de tipos,
 * el desdoblamiento de `NO_ANALITICO` (R-A11) y el `marginLevel` de cada CECO,
 * que es la otra mitad del ruteo (R-A7). Sin los CECOs, cambiar `CC-OPS` de MC3
 * a EBITDA movería importe entre niveles sin cambiar ningún hash.
 */
export function canonicalMarginConfigForm(
  config: Pick<AnalyticsConfig, "levels" | "costCenters" | "incomeTaxPrefixes" | "nonAnalyticLevel">
): string {
  const levels = [...config.levels]
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.level < b.level ? -1 : 1))
    .map((l) =>
      [
        l.level as MarginLevel,
        String(l.sortOrder),
        [...l.analyticTypes].sort().join(","),
        l.validFrom,
        nullable(l.validTo),
      ].join("\t")
    )
  const cecos = [...config.costCenters]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((c) => [c.code, c.kind, c.marginLevel, c.allocatable ? "1" : "0"].join("\t"))
  return [
    `nonAnalyticLevel\t${config.nonAnalyticLevel}`,
    `incomeTaxPrefixes\t${[...config.incomeTaxPrefixes].join(",")}`,
    ...levels,
    ...cecos,
  ].join("\n")
}

export function marginConfigHash(
  config: Pick<AnalyticsConfig, "levels" | "costCenters" | "incomeTaxPrefixes" | "nonAnalyticLevel">
): string {
  return sha256(canonicalMarginConfigForm(config))
}

/**
 * `(entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)`
 * **+** `marginConfigHash` **+** `allocationRunId` vigente (E5).
 */
export function analyticsHash(
  lines: readonly AnalyticHashableLine[],
  configHash: string,
  allocationRunId?: string | null
): string {
  return sha256(
    [canonicalAnalyticsForm(lines), `marginConfigHash\t${configHash}`, `allocationRunId\t${nullable(allocationRunId)}`].join(
      "\n"
    )
  )
}
