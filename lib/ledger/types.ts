/**
 * E3 · T4 — Tipos del motor contable (`docs/design/E3-libro-diario.md` §3.1,
 * alineados con el contrato de `docs/design/E3-asientos-tipo.md` §0).
 *
 * Módulo PURO: sin IO, sin Prisma, sin `new Date()`. La fecha de referencia
 * entra siempre por parámetro (`ctx.refDate`). El hook `.claude/hooks/guard.sh`
 * lo verifica antes de escribir.
 */

import type { AccountKey, AnalyticType, Plan } from "@/lib/accounts/types"
import type { BusinessLineRef, CostCenterRef, ProjectRef } from "@/lib/analytics/types"
import type { TaxRateRow } from "@/lib/taxes/types"
import type { EntryKind, SourceType, TaxRoundingMode } from "@/prisma/client"

export type { AccountKey, AnalyticType, EntryKind, Plan, SourceType, TaxRateRow, TaxRoundingMode }
export type { BusinessLineRef, CostCenterRef, ProjectRef }

/** Entero en céntimos; en una línea SIEMPRE ≥ 0 (el signo lo da el lado). */
export type Cents = number

/** "YYYY-MM-DD", sin zona: es la columna `@db.Date`, un día natural. */
export type LocalDate = string

// ─────────────────────────────────────────────────────────────────────────────
// Errores
// ─────────────────────────────────────────────────────────────────────────────

export type LedgerErrorCode =
  | "UNBALANCED"
  | "LINE_SIDE"
  | "LINE_NEGATIVE"
  | "TOO_FEW_LINES"
  | "ONE_SIDED_ENTRY"
  | "ZERO_LINE"
  | "ACCOUNT_UNKNOWN"
  | "ACCOUNT_NOT_POSTABLE"
  | "ACCOUNT_INACTIVE"
  | "MAP_KEY_UNMAPPED"
  | "FY_NOT_FOUND"
  | "FY_CLOSED"
  | "DATE_OUT_OF_FY"
  | "MONTH_LOCKED"
  | "FUTURE_DATE"
  | "DATE_FORMAT"
  | "TAX_RATE_NOT_IN_FORCE"
  | "TAX_SIDE_MISMATCH"
  | "DOCUMENT_TOTAL_MISMATCH"
  | "TAX_BASE_MISMATCH"
  | "TAX_ROUNDING_EXCEEDED"
  | "PRORRATA_NOT_CONFIGURED"
  | "RECTIFICATION_SIGN"
  | "RECTIFICATION_EXCEEDS"
  | "PAYMENT_EXCEEDS_LIABILITY"
  | "ANALYTIC_DEST_MISSING"
  | "ANALYTIC_DIM_UNAVAILABLE"
  // E4 · T6 (§3.3): C-9 activo.
  | "ANALYTIC_DEST_UNKNOWN"
  | "ANALYTIC_DEST_BOTH"
  | "ANALYTIC_DEST_INACTIVE"
  | "ANALYTIC_PROJECT_CLOSED"
  | "ANALYTIC_DIM_ON_NON_PNL"
  | "ANALYTIC_DIM_ON_NON_ANALYTIC"
  | "ALREADY_REVERSED"
  | "REVERSAL_OF_REVERSAL"
  | "REVERSAL_TARGET_KIND"
  | "TEMPLATE_INPUT"
  | "TENANT_MISMATCH"

export type LedgerError = {
  code: LedgerErrorCode
  /** Comprobación del experto que lo produce: "C-1", "CA-2", "R-IVA-7"… */
  check?: string
  field: string
  message: string
  /** Línea a la que se ancla el error (1..n), si aplica. */
  lineNo?: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: LedgerError[] }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T>(...errors: LedgerError[]): Result<T> => ({ ok: false, errors })

export function err(
  code: LedgerErrorCode,
  field: string,
  message: string,
  opts: { lineNo?: number; check?: string } = {}
): LedgerError {
  const e: LedgerError = { code, field, message }
  if (opts.check !== undefined) e.check = opts.check
  if (opts.lineNo !== undefined) e.lineNo = opts.lineNo
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrador de asiento
// ─────────────────────────────────────────────────────────────────────────────

export type DraftLine = {
  lineNo: number
  /** Preferente: toda contrapartida que decide el MOTOR es una AccountKey. */
  accountKey?: AccountKey | null
  /** Solo cuentas que decide el usuario o el documento: 621, 628, 681, 216… */
  accountCode?: string | null
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  taxRateId?: string | null
  /** Base sobre la que se calculó esta cuota. Null si la línea no es de impuesto. */
  taxBaseCents?: Cents | null
  counterpartyId?: string | null
  /** Una línea de 43x/40x POR VENCIMIENTO (decisión 6 de §9.2). */
  dueDate?: LocalDate | null
  /** Se persiste ya: es un enum, no una FK (§2.3, D-E3-1). */
  analyticType?: AnalyticType | null
  /** E4: el motor los acepta en el tipo y los RECHAZA al validar (§2.3). */
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
}

/** Línea ya normalizada por `buildEntry`: `accountCode` resuelto y obligatorio. */
export type ResolvedLine = DraftLine & { accountCode: string }

export type EntryDraft = {
  organizationId: string
  fiscalYearId: string
  /** Las tres fechas (O-1). `entryDate` la fija resolveEntryDate, no el usuario. */
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  entryDate: LocalDate
  description: string
  kind: EntryKind
  sourceType: SourceType
  sourceId?: string | null
  transactionId?: string | null
  fileId?: string | null
  templateCode?: string | null
  /** Sellado en el asiento (O-2, R-IVA-4). */
  taxRoundingMode: TaxRoundingMode
  reversesEntryId?: string | null
  lines: ResolvedLine[]
}

/** Lo que `buildEntry` recibe: como el borrador, pero sin fecha contable resuelta. */
export type EntryInput = {
  organizationId: string
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  /** Solo T-27/T-28 y los tests fijan la fecha contable a mano. */
  entryDate?: LocalDate | null
  description: string
  kind?: EntryKind
  sourceType?: SourceType
  sourceId?: string | null
  transactionId?: string | null
  fileId?: string | null
  templateCode?: string | null
  reversesEntryId?: string | null
  lines: DraftLine[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto
// ─────────────────────────────────────────────────────────────────────────────

export type FiscalYearRef = {
  id: string
  code: string
  startDate: LocalDate
  endDate: LocalDate
  status: "OPEN" | "CLOSED"
}

export type PeriodLockRef = { fiscalYearId: string; month: number }

export type LedgerPolicy = {
  taxRoundingMode: TaxRoundingMode
  /** O-7: puntos básicos (90 % = 9000), NO por mil. */
  prorrataBps: number | null
  redondeoToleranciaCents: number
  analyticsRequired: boolean
}

/** Todo lo que el motor necesita saber de la organización. Se compone en `models/`. */
export type LedgerContext = {
  organizationId: string
  /** "hoy" SIEMPRE por parámetro. */
  refDate: LocalDate
  plan: Plan
  /** I-plan-1 ya validado al construir el ctx; null = clave sin mapear. */
  map: (key: AccountKey) => string | null
  rates: readonly TaxRateRow[]
  fiscalYears: readonly FiscalYearRef[]
  periodLocks: readonly PeriodLockRef[]
  policy: LedgerPolicy
  /**
   * D-E3-1: `available: false` en E3, `true` desde E4. Con `true`, C-9 muerde:
   * el motor resuelve el tipo efectivo (R-A2/R-A3/R-A4), exige destino en las
   * líneas 6/7 y lo valida contra estos catálogos (§3.3).
   */
  dimensions: {
    available: boolean
    projects?: readonly ProjectRef[]
    costCenters?: readonly CostCenterRef[]
    businessLines?: readonly BusinessLineRef[]
    /** `CC-NA`: destino automático con `analyticsRequired = false` (R-A8). */
    unassignedCostCenterId?: string | null
  }
  baseCurrency: string
  /**
   * Saldos por cuenta (`Σdebe − Σhaber`, negativo = acreedor) del periodo que
   * el llamante haya leído con `models/ledger.getAccountBalances`. Solo las
   * plantillas del bloque C (T-26/T-27/T-28) los necesitan; el motor no lee la
   * BD, así que los aporta quien la lee.
   */
  balances?: ReadonlyMap<string, Cents>
}

// ─────────────────────────────────────────────────────────────────────────────
// Asiento ya posteado (entrada de `buildReversal`, informes e invariantes)
// ─────────────────────────────────────────────────────────────────────────────

export type PostedLine = {
  id?: string
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  taxRateId?: string | null
  taxBaseCents?: Cents | null
  counterpartyId?: string | null
  dueDate?: LocalDate | null
  analyticType?: AnalyticType | null
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  entryDate: LocalDate
  fiscalYearId: string
  entryKind: EntryKind
}

export type PostedEntry = {
  id: string
  organizationId: string
  fiscalYearId: string
  entryNumber: number
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  entryDate: LocalDate
  description: string
  kind: EntryKind
  taxRoundingMode: TaxRoundingMode
  sourceType: SourceType
  sourceId?: string | null
  templateCode?: string | null
  reversesEntryId?: string | null
  voidedAt?: string | null
  entryHash?: string
  lines: PostedLine[]
}
