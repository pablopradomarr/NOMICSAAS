/**
 * E2 · T3 — Tipos del motor del plan de cuentas (docs/design/E2-plan-cuentas.md §3).
 *
 * Módulo PURO: sin IO, sin `Date.now()`, sin Prisma. La fecha de referencia
 * entra siempre por parámetro. El hook `.claude/hooks/guard.sh` lo verifica.
 */

import type {
  AccountKey,
  AccountOrigin,
  AnalyticType,
  CashflowCategory,
  Nature,
  PgcVariant,
  Statement,
  TaxAppliesTo,
  TaxKind,
} from "@/prisma/client"

export type { AccountKey, AccountOrigin, AnalyticType, CashflowCategory, Nature, PgcVariant, Statement, TaxAppliesTo, TaxKind }

/** Código de cuenta ya validado contra `^[1-9][0-9]{0,11}$` (R-01). */
export type AccountCode = string & { readonly __brand: "AccountCode" }

/** Una cuenta del plan, sin campos técnicos (id, timestamps). */
export type PlanAccount = {
  code: string
  name: string
  level: number
  parentCode: string | null
  nature: Nature
  statement: Statement | null
  epigraph: string | null
  epigraphPymes: string | null
  bidirectional: boolean
  isContra: boolean
  analyticType: AnalyticType | null
  cashflowCategory: CashflowCategory | null
  isPostable: boolean
  isActive: boolean
  isSystem: boolean
  origin: AccountOrigin
}

/** Índice inmutable del plan de una organización. Se construye una vez por request. */
export type Plan = {
  byCode: ReadonlyMap<string, PlanAccount>
  /** Códigos ordenados ascendentemente por texto. */
  codes: readonly string[]
}

/**
 * Bucket de cashflow de la contrapartida (E6, columna `cashflow_bucket` del seed).
 * La `CashflowCategory` de tres valores se DERIVA con `cashflowCategoryOf`, no se
 * almacena aparte. `null` solo en 57x (la propia tesorería), en los contenedores
 * mixtos de nivel 1 (`4`, `5`) y en los grupos 8/9 (ECPN).
 */
export type CashflowBucket =
  | "COBROS_CLIENTES"
  | "PAGOS_PROVEEDORES"
  | "PAGOS_PERSONAL"
  | "PAGOS_IMPUESTOS"
  | "OTROS_EXPLOTACION"
  | "INVERSION"
  | "FINANCIACION"

/** Categoría del EFE derivada del bucket (nunca se persiste por separado). */
export const cashflowCategoryOf = (b: CashflowBucket): "OPERATING" | "INVESTING" | "FINANCING" =>
  b === "INVERSION" ? "INVESTING" : b === "FINANCIACION" ? "FINANCING" : "OPERATING"

/** Fila del seed `seeds/npgc.csv` ya parseada (14 columnas tras E6). */
export type SeedAccount = {
  code: string
  name: string
  level: number
  parentCode: string | null
  group: string
  nature: Nature
  statement: Statement | null
  epigraph: string | null
  analyticType: AnalyticType | null
  bidirectional: boolean
  isContra: boolean
  pymes: boolean
  epigraphPymes: string | null
  cashflowBucket: CashflowBucket | null
}

/**
 * Uso de una cuenta. En E2 `movementCount` es SIEMPRE 0 (no hay diario);
 * E3 lo rellena desde `journal_lines`. La firma no cambia (riesgo R6).
 */
export type AccountUsage = {
  movementCount: number
  childCount: number
  mappedKeys: readonly AccountKey[]
  taxRateCodes: readonly string[]
}

export const EMPTY_USAGE: AccountUsage = {
  movementCount: 0,
  childCount: 0,
  mappedKeys: [],
  taxRateCodes: [],
}

export type AccountErrorCode =
  | "CODE_FORMAT"
  | "CODE_DUPLICATE"
  | "CODE_TOO_SHORT"
  | "PARENT_NOT_FOUND"
  | "PARENT_INACTIVE"
  | "PARENT_HAS_MOVEMENTS"
  | "SYSTEM_ACCOUNT"
  | "HAS_CHILDREN"
  | "HAS_MOVEMENTS"
  | "IS_MAPPED"
  | "IS_TAXED"
  | "STATEMENT_LOCKED"
  | "EPIGRAPH_LOCKED"
  | "ROLE_REQUIRED"
  | "REASON_REQUIRED"
  | "CODE_IMMUTABLE"
  | "STATEMENT_GROUP_MISMATCH"
  | "EPIGRAPH_UNKNOWN"
  | "ANALYTIC_INCOHERENT"
  | "CASHFLOW_UNEXPECTED"
  | "CLOSED_PERIOD"
  | "VARIANT_LOCKED"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_NOT_POSTABLE"
  | "KEY_MISSING"
  | "RATE_RANGE"
  | "RATE_OVERLAP"
  | "VALIDITY_RANGE"
  | "RATE_LINK"
  | "CSV_HEADER"
  | "CSV_ROW"
  | "CSV_CYCLE"

export type AccountError = {
  code: AccountErrorCode
  field: string
  message: string
  /** Nº de fila (1 = primera fila de datos) en los errores de CSV. */
  row?: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: AccountError[] }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = <T>(...errors: AccountError[]): Result<T> => ({ ok: false, errors })

export const err = (code: AccountErrorCode, field: string, message: string, row?: number): AccountError =>
  row === undefined ? { code, field, message } : { code, field, message, row }

/** Avisos (R-13, R-16, R-17, R-18): no bloquean, se pintan en el editor. */
export type AccountWarning = {
  code: "ANALYTIC_INCOHERENT" | "CONTRA_UNMARKED" | "CASHFLOW_UNEXPECTED" | "ALLOCATION_STALE"
  accountCode: string
  message: string
}
