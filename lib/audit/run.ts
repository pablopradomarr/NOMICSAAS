/**
 * E7 · T5 — La foto del barrido y su sello (`docs/design/E7-auditoria.md` §3.2).
 *
 * Dos sellos propios y un principio:
 *
 * - **`checksHash`** (I-E7-7): sha256 de la forma canónica de `checks`
 *   (`id ‖ status ‖ evidencia`). Es lo que demuestra que la fila no se ha
 *   editado por SQL. La evidencia entra a propósito: cambiar «diferencia 0,00 €»
 *   por «diferencia 12,00 €» sin tocar el `status` sería una mentira que un hash
 *   de sólo estados no vería.
 * - **`configHash`** (O-20): sha256 de TODA la configuración que puede mover un
 *   check sin mover un dato. Sin él, bajar un umbral servía el barrido cacheado
 *   —justo cuando hay que rebarrer— y `diffRuns` concluía `cause: "NINGUNA"` con
 *   deltas, caso que el criterio 4 declara imposible.
 * - **El sello es uno**: se reutiliza `seal()` de `lib/ledger/invariants.ts`.
 *   E7 no define un segundo criterio de sellado; sólo aporta cuatro motivos
 *   nuevos al vocabulario (§3.2).
 *
 * Módulo PURO.
 */

import { createHash } from "node:crypto"

import { countsOf, groupByFamily, unknownCheckIds } from "@/lib/audit/families"
import type {
  AuditConfigSnapshot,
  AuditHashes,
  AuditScope,
  AuditTrigger,
  CheckResult,
  CoverageReport,
  HeadlineFigures,
  InvariantRunDraft,
  LocalDate,
  ManualReviewFlagRef,
} from "@/lib/audit/types"
import { seal, type Seal, type SealReason } from "@/lib/ledger/invariants"

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/**
 * Los cuatro motivos de sello que aporta E7 (§3.2 y §5.3). Son de tipo
 * `AVISO`/`ENTORNO`: **no convierten un informe correcto en sospechoso**, pero
 * impiden que una cifra suba a `✓ validado contra fuente` (§3.6).
 */
export const E7_SEAL_REASONS = [
  "CONCILIACION_PENDIENTE",
  "ALMACEN_NO_BARRIDO",
  "PARTIDA_EN_TRANSITO_ANTIGUA",
  "DIFERENCIA_DE_CAMBIO_SIN_RECONOCER",
] as const
export type E7SealReason = (typeof E7_SEAL_REASONS)[number]

export const E7_SEAL_REASON_TEXT: Readonly<Record<E7SealReason, string>> = {
  CONCILIACION_PENDIENTE: "hay cuentas bancarias con movimientos sin conciliar en el periodo",
  ALMACEN_NO_BARRIDO: "el almacén de ficheros no se ha barrido después del último documento ingerido",
  PARTIDA_EN_TRANSITO_ANTIGUA: "hay partidas en tránsito más antiguas que el plazo declarado de la cuenta",
  DIFERENCIA_DE_CAMBIO_SIN_RECONOCER: "hay diferencias de cambio medidas y no reconocidas a fecha de cierre (768/668)",
}

export const E7_SEAL_REASON_KIND: Readonly<Record<E7SealReason, SealReason["kind"]>> = {
  CONCILIACION_PENDIENTE: "AVISO",
  ALMACEN_NO_BARRIDO: "ENTORNO",
  PARTIDA_EN_TRANSITO_ANTIGUA: "AVISO",
  DIFERENCIA_DE_CAMBIO_SIN_RECONOCER: "AVISO",
}

/** Los motivos de E7 en la forma que `seal()` concatena (H-4). */
export const e7Reasons = (codes: readonly E7SealReason[] | undefined): SealReason[] =>
  [...new Set(codes ?? [])].sort().map((code) => ({
    kind: E7_SEAL_REASON_KIND[code],
    code,
    message: `${code} · ${E7_SEAL_REASON_TEXT[code]}`,
  }))

/**
 * Forma canónica de `checks`: una fila TSV por check, ordenada por
 * `(id, status, evidencia)`. El orden se impone aquí y no se hereda del orden en
 * que corrieron: dos barridos del mismo estado deben dar el mismo `checksHash`
 * aunque el motor haya reordenado los bloques.
 */
export function canonicalChecksForm(checks: readonly CheckResult[]): string {
  return [...checks]
    .map((c) => [c.id, c.status, c.evidencia].join("\t"))
    .sort()
    .join("\n")
}

/** sha256 de la forma canónica de `checks` (I-E7-7). */
export function checksHashOf(checks: readonly CheckResult[]): string {
  return sha256(canonicalChecksForm(checks))
}

const canonicalRecord = (label: string, record: Readonly<Record<string, string | number | boolean>> | undefined): string[] =>
  Object.entries(record ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${label}.${key}\t${String(value)}`)

/**
 * Forma canónica de la configuración del barrido (O-20). Claves ordenadas y
 * TSV, como el resto de formas canónicas del proyecto (ADR-0011): un hash de
 * `JSON.stringify` dependería del orden de inserción del objeto.
 */
export function canonicalConfigForm(config: AuditConfigSnapshot): string {
  return [
    `warnThreshold\t${config.warnThreshold}`,
    `maxMaterializedEntries\t${config.maxMaterializedEntries}`,
    `planVariant\t${config.planVariant}`,
    `forceReview\t${config.forceReview === true ? "1" : "0"}`,
    ...canonicalRecord("matchToleranceDays", config.matchToleranceDays),
    ...canonicalRecord("transitWarnDays", config.transitWarnDays),
    ...canonicalRecord("ignoredMaterialityCents", config.ignoredMaterialityCents),
    ...canonicalRecord("extras", config.extras),
  ].join("\n")
}

export function configHashOf(config: AuditConfigSnapshot): string {
  return sha256(canonicalConfigForm(config))
}

export type AuditRunInput = {
  organizationId: string
  runId: string
  checks: readonly CheckResult[]
  scope: AuditScope
  trigger: AuditTrigger
  hashes: AuditHashes
  headline: HeadlineFigures
  gitSha: string
  lastGitSha: string | null
  refDate: LocalDate
  /** Marcas de revisión vivas del alcance: una sola fuerza revisión (§2.7). */
  manualFlags: readonly ManualReviewFlagRef[]
  coverage: CoverageReport
  durationMs: number
  /** Umbral de WARN del sello. Viene de la misma configuración que `configHash`. */
  warnThreshold?: number
  /** Los cuatro motivos propios de E7, ya decididos por el llamante. */
  auditReasons?: readonly E7SealReason[]
  storeSweepId?: string | null
  runById?: string | null
}

/**
 * Compone el `InvariantRun` que el borde persiste. No lee nada, no escribe nada
 * y no consulta el reloj: la `refDate` y la duración entran por parámetro.
 *
 * **`seal` y `sealReasons` dicen lo mismo** (H-4 de la auditoría, ronda 1). Los
 * cuatro motivos propios de E7 entran en `seal()` por `auditReasons`, igual que
 * los seis de E8 entran por `documentReasons`: un AVISO que no mueve el sello es
 * decorativo, y la ronda 1 dejaba `seal = VALIDADO_AUTOMATICAMENTE` con ocho
 * pendientes de hasta 183 días listados en `sealReasons`. La equivalencia «sin
 * razones ⇔ VALIDADO AUTOMÁTICAMENTE» se conserva: es `seal()` quien las
 * concatena, y `sealReasons` es exactamente `computedSeal.razones`.
 */
export function buildInvariantRun(input: AuditRunInput): InvariantRunDraft {
  const checks = [...input.checks]
  const activeFlags = input.manualFlags.filter((f) => f.clearedAt === null || f.clearedAt === undefined)
  const computedSeal: Seal = seal(
    {
      run_id: input.runId,
      ledgerHash: input.hashes.ledgerHash,
      gitSha: input.gitSha,
      refDate: input.refDate,
      organizationId: input.organizationId,
      checks,
    },
    {
      gitSha: input.gitSha,
      lastGitSha: input.lastGitSha,
      warnThreshold: input.warnThreshold ?? 0,
      forceReview: activeFlags.length > 0,
      auditReasons: e7Reasons(input.auditReasons),
    }
  )

  return {
    organizationId: input.organizationId,
    scopeKind: input.scope.kind,
    fiscalYearId: input.scope.fiscalYearId ?? null,
    periodStart: input.scope.periodStart ?? null,
    periodEnd: input.scope.periodEnd ?? null,
    trigger: input.trigger,
    refDate: input.refDate,
    ledgerHash: input.hashes.ledgerHash,
    analyticsKey: input.hashes.analyticsKey,
    planHash: input.hashes.planHash,
    accountMapHash: input.hashes.accountMapHash,
    configHash: input.hashes.configHash,
    gitSha: input.gitSha,
    checksHash: checksHashOf(checks),
    checks,
    counts: { global: countsOf(checks), byFamily: groupByFamily(checks) },
    coverage: input.coverage,
    headline: input.headline,
    seal: computedSeal,
    sealReasons: computedSeal.razones,
    storeSweepId: input.storeSweepId ?? null,
    durationMs: input.durationMs,
    runById: input.runById ?? null,
    unknownIds: unknownCheckIds(checks),
  }
}
