/**
 * E7 · T5 — Tipos del barrido de invariantes (`docs/design/E7-auditoria.md` §3).
 *
 * `lib/audit/**` es **motor puro**: sin IO, sin `Date.now()`, sin Prisma y sin
 * LLM. Todo lo que necesita llega ya leído en tipos planos; los `models/` de T9
 * los rellenan. Los literales coinciden con los enums del esquema
 * (`audit_scope_kind`, `audit_trigger`, `check_family`) para que la conversión
 * en el borde sea la identidad.
 */

import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"
import type { Provenance } from "@/lib/ledger/provenance"
import type { Cents, LocalDate } from "@/lib/ledger/types"

export type { CheckResult, CheckStatus, Cents, LocalDate, Provenance }

/**
 * Las familias del semáforo (§3.1). Enum, no texto libre (O-21). Eran siete en
 * E7; **E9 añade `CIERRE`** (§6.3 de `docs/design/E9-cierre-recurrentes.md`):
 * los I-E9-* no son ni conciliación ni camino documental, y enterrarlos en
 * `INTEGRIDAD` habría dejado el cierre sin tarjeta propia en `/audit`.
 */
export type CheckFamily =
  | "PARTIDA_DOBLE"
  | "ESTADOS"
  | "ANALITICA"
  | "LIQUIDACION"
  | "DOCUMENTAL"
  | "CONCILIACION"
  | "CIERRE"
  | "INTEGRIDAD"

/**
 * `SIN_EVALUAR` es un estado **propio**, no un «OK» tímido: la diferencia entre
 * «comprobado y bien» y «no comprobado» es la razón de ser de la pantalla (R3).
 */
export type FamilyStatus = "OK" | "AVISO" | "FALLO" | "SIN_EVALUAR"

export type AuditScopeKind = "ORGANIZATION" | "FISCAL_YEAR" | "PERIOD"
export type AuditTrigger = "MANUAL" | "SCHEDULED" | "POST_CLOSE" | "POST_IMPORT"

export type AuditScope = {
  kind: AuditScopeKind
  fiscalYearId?: string | null
  periodStart?: LocalDate | null
  periodEnd?: LocalDate | null
}

export type AuditCounts = { PASS: number; FAIL: number; WARN: number; INFO: number; total: number }

export type FamilySummary = {
  family: CheckFamily
  status: FamilyStatus
  counts: AuditCounts
  checkIds: readonly string[]
}

/** Las cuatro cifras que mira quien firma (O-19). */
export type HeadlineMetric = "ACTIVO" | "PN_MAS_PASIVO" | "RESULTADO" | "TESORERIA"

export const HEADLINE_METRICS: readonly HeadlineMetric[] = ["ACTIVO", "PN_MAS_PASIVO", "RESULTADO", "TESORERIA"]

export type HeadlineFigure = { cents: Cents; provenance?: Provenance }

/**
 * Derivadas por SQL del mismo `ledgerHash` que sella el run: no es una cifra de
 * informe almacenada (ADR-0003), es la foto del sello.
 */
export type HeadlineFigures = Readonly<Record<HeadlineMetric, HeadlineFigure>>

/** Qué se evaluó de verdad y qué se declaró INFO, y por qué (§2.2). */
export type CoverageReport = {
  /** Bloques presentes en la entrada: `analytics`, `reports`, `documents`… */
  evaluated: readonly string[]
  /** Bloques ausentes, con el motivo por el que no se pudo evaluar. */
  skipped: readonly { block: string; reason: string }[]
  /** Asientos materializados y tope aplicado, cuando lo hay. */
  entriesConsidered?: number
  maxMaterializedEntries?: number
}

export type ManualReviewFlagRef = {
  id: string
  /** `null` = toda la organización. */
  scope?: string | null
  checkFamily?: CheckFamily | null
  reason: string
  periodStart?: LocalDate | null
  periodEnd?: LocalDate | null
  /** Una marca levantada ya no fuerza revisión. */
  clearedAt?: string | null
}

/**
 * **O-20.** Toda la configuración que puede mover un check sin mover un dato.
 * Sin ella, bajar un umbral servía el barrido cacheado —justo cuando hay que
 * rebarrer— y el diff concluía `cause: "NINGUNA"` con deltas.
 */
export type AuditConfigSnapshot = {
  /** Umbral de WARN por encima del cual el sello exige revisión. */
  warnThreshold: number
  maxMaterializedEntries: number
  /** Variante del plan de la organización (`PYMES`, `NORMAL`…). */
  planVariant: string
  /** Por cuenta bancaria (código de la `BankAccount`), no global. */
  matchToleranceDays?: Readonly<Record<string, number>>
  transitWarnDays?: Readonly<Record<string, number>>
  ignoredMaterialityCents?: Readonly<Record<string, Cents>>
  /** Revisión forzada por configuración de la organización. */
  forceReview?: boolean
  /** Cualquier otro umbral con nombre, para no tener que versionar este tipo. */
  extras?: Readonly<Record<string, string | number | boolean>>
}

export type AuditHashes = {
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
}

/** Lo que el borde escribe en `invariant_runs` (§2.2). */
export type InvariantRunDraft = {
  organizationId: string
  scopeKind: AuditScopeKind
  fiscalYearId: string | null
  periodStart: LocalDate | null
  periodEnd: LocalDate | null
  trigger: AuditTrigger
  refDate: LocalDate
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  checksHash: string
  checks: readonly CheckResult[]
  counts: { global: AuditCounts; byFamily: readonly FamilySummary[] }
  coverage: CoverageReport
  headline: HeadlineFigures
  seal: import("@/lib/ledger/invariants").Seal
  sealReasons: readonly import("@/lib/ledger/invariants").SealReason[]
  storeSweepId: string | null
  durationMs: number
  runById: string | null
  /** Ids sin familia declarada: entran en INTEGRIDAD y se nombran (§3.1). */
  unknownIds: readonly string[]
}

/** Un run ya persistido, tal como lo leen el historial y el diff. */
export type InvariantRunRef = {
  id: string
  createdAt?: string
  gitSha: string
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
  checks: readonly CheckResult[]
  headline: HeadlineFigures
}
