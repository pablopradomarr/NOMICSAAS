/**
 * E4 · T5 — Tipos de la capa analítica (`docs/design/E4-analitica.md` §3.1).
 *
 * Módulo PURO: sin IO, sin Prisma, sin `Date.now()`. El hook
 * `.claude/hooks/guard.sh` lo verifica antes de escribir.
 */

import type { AnalyticType } from "@/lib/accounts/types"
import type { CostCenterKind, EntryKind, MarginLevel } from "@/prisma/client"

/** Entero en céntimos (misma definición que `lib/ledger/types`). */
export type Cents = number
/** "YYYY-MM-DD", sin zona: es la columna `@db.Date`, un día natural. */
export type LocalDate = string

export type { AnalyticType, CostCenterKind, EntryKind, MarginLevel }

/** Los ocho niveles, en orden de presentación y de acumulación (MLC-3). */
export const MARGIN_LEVELS = [
  "INGRESOS",
  "MC1",
  "MC2",
  "MC3",
  "EBITDA",
  "EBIT",
  "BAI",
  "RESULTADO",
] as const satisfies readonly MarginLevel[]

/** Los ocho `kind` de CECO, en el orden de columnas del JSON sellado. */
export const COST_CENTER_KINDS = [
  "OPERACIONES_INDIRECTAS",
  "DESARROLLO_PRODUCTO",
  "MARKETING_VENTAS",
  "G_A",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "OTROS",
  "SIN_ASIGNAR",
] as const satisfies readonly CostCenterKind[]

/** Niveles admisibles para un CECO (CHECK `cost_centers_margin_level`). */
export type CostCenterMarginLevel = Extract<MarginLevel, "MC3" | "EBITDA">

/** MLC-5: `Organization.nonAnalyticLevel`. Nunca contamina los márgenes. */
export type NonAnalyticLevel = Extract<MarginLevel, "EBITDA" | "EBIT" | "BAI">

/** R-A11: prefijos del impuesto sobre beneficios, clavados en `RESULTADO`. */
export const INCOME_TAX_PREFIXES: readonly string[] = ["630", "633", "638"]

/** `kind` de asiento excluidos de la PyG (I3, y por tanto de I4). */
export const EXCLUDED_ENTRY_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>([
  "REGULARIZATION",
  "CLOSING",
  "OPENING",
])

/** Línea del diario tal y como la ve la analítica. Superconjunto de `ReportLine`. */
export type AnalyticLine = {
  id?: string
  entryId: string
  entryNumber: number
  entryDate: LocalDate
  entryKind: EntryKind
  fiscalYearId: string
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  /** Tipo EFECTIVO ya resuelto y persistido al postear (R-A2). */
  analyticType: AnalyticType | null
  projectId: string | null
  costCenterId: string | null
  businessLineId: string | null
}

export type BusinessLineRef = {
  id: string
  code: string
  name: string
  sortOrder: number
  isActive: boolean
}

export type ProjectRef = {
  id: string
  code: string
  name: string
  businessLineId: string
  status: "PLANNED" | "ACTIVE" | "CLOSED"
  sortOrder: number
  isActive: boolean
  /** O-A8 / I-E4-10: sin fecha de cierre el invariante no es comprobable. */
  closedAt?: LocalDate | null
}

export type CostCenterRef = {
  id: string
  code: string
  name: string
  kind: CostCenterKind
  marginLevel: CostCenterMarginLevel
  allocatable: boolean
  sortOrder: number
  isActive: boolean
  isSystem?: boolean
}

export type MarginLevelRow = {
  level: MarginLevel
  label: string
  analyticTypes: readonly AnalyticType[]
  sortOrder: number
  isVisible: boolean
  validFrom: LocalDate
  validTo: LocalDate | null
}

export type AnalyticsConfig = {
  organizationId: string
  /** La vigente para el periodo del informe, elegida por `entryDate` (§8.4). */
  levels: readonly MarginLevelRow[]
  businessLines: readonly BusinessLineRef[]
  projects: readonly ProjectRef[]
  costCenters: readonly CostCenterRef[]
  unassignedCostCenterId: string | null
  /** Tipo por cuenta CON herencia de hoja ya resuelta (`6080 → 608`). */
  analyticTypeByAccount: ReadonlyMap<string, AnalyticType | null>
  /** R-A11. Default `["630","633","638"]`. */
  incomeTaxPrefixes: readonly string[]
  /** MLC-5: EBITDA (default) | EBIT | BAI. */
  nonAnalyticLevel: NonAnalyticLevel
  /** R-A8: con `false`, las líneas sin destino se rutean a `CC-NA`. */
  analyticsRequired: boolean
}

/**
 * Clave de columna, EXACTAMENTE la del JSON sellado: los CECOs se agrupan por
 * `kind` (una columna por kind, no una por CECO) y los cuatro tipos con columna
 * propia van sueltos. Las columnas de línea de negocio son agregados de
 * presentación y NO pertenecen a este conjunto: sumarlas duplicaría proyectos.
 */
/**
 * **E5 · E5-D3** — `BL:<código>` es una columna REAL del total: lo imputado a
 * una línea de negocio y no bajado a proyecto. Es distinta de
 * `businessLineMatrixCents`, que es PRESENTACIÓN (agregado de proyectos) y no
 * suma. Sólo aparece cuando la matriz se construye CON imputaciones.
 */
export type ColumnKey =
  | `PROJ:${string}`
  | `BL:${string}`
  | `CECO:${CostCenterKind}`
  | "AMORTIZACION_DETERIORO"
  | "FINANCIERO"
  | "EXTRAORDINARIO"
  | "NO_ANALITICO"

export const projectColumn = (code: string): ColumnKey => `PROJ:${code}`
export const businessLineColumn = (code: string): ColumnKey => `BL:${code}`
export const cecoColumn = (kind: CostCenterKind): ColumnKey => `CECO:${kind}`

export type AnalyticPeriod = {
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string | null
  /** Etiqueta del ejercicio, solo para la serialización canónica. */
  fiscalYearCode?: string | null
}

/** Error de configuración o de datos que impide calcular la matriz. */
export type AnalyticsErrorCode =
  | "CECO_MARGIN_LEVEL"
  | "CECO_UNKNOWN"
  | "PROJECT_UNKNOWN"
  | "DEST_MISSING"
  | "DEST_BOTH"
  | "DIM_ON_NON_ANALYTIC"
  | "DIM_ON_NON_PNL"
  | "TYPE_UNKNOWN"

export class AnalyticsError extends Error {
  constructor(
    readonly code: AnalyticsErrorCode,
    message: string
  ) {
    super(message)
    this.name = "AnalyticsError"
  }
}
