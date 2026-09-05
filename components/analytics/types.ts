/**
 * E4 · T13/T14/T15 — Modelos de vista de la analítica.
 *
 * Todo lo que cruza de un Server Component a un Client Component va por aquí:
 * objetos planos, serializables, importes en **céntimos enteros**, fechas
 * `"YYYY-MM-DD"` y porcentajes en **puntos básicos enteros** (`marginBps`, que
 * calcula `lib/analytics/margins.ts` EN EL SERVIDOR). El navegador no suma ni
 * divide ninguna cifra contable: sólo la pinta.
 */

import type { CheckRow, Provenance, SealView } from "@/components/ledger/types"

export type { CheckRow, Provenance, SealView }

/** Cabecera de la PyG analítica: los tres sellos de E4-D2 (§2.5). */
export type AnalyticsHeaderView = {
  from: string
  to: string
  baseCurrency: string
  runId: string
  gitSha: string
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  seal: SealView
  checks: CheckRow[]
}

/** Columna de la matriz. `aggregate` = agregado de presentación: NO suma al total. */
export type MatrixColumnKind = "project" | "businessLine" | "ceco" | "other" | "total"

export type MatrixHeader = {
  key: string
  label: string
  /** Segunda línea de la cabecera: código, `kind` del CECO, línea de negocio… */
  sub?: string
  kind: MatrixColumnKind
  /** Agregado de presentación (subtotal de línea de negocio): no entra en I4. */
  aggregate?: boolean
}

export type MatrixCell = {
  /** Importe en céntimos. `null` en las filas de porcentaje. */
  cents?: number | null
  /** Puntos básicos enteros de `marginBps`. `null` ⇒ se pinta `—`. */
  bps?: number | null
  /** Clave de la celda para buscar su detalle (`${level}|${column}`). */
  detailKey?: string
  /** Texto secundario: EBIT/BAI/RESULTADO en columna de proyecto (§6). */
  muted?: boolean
}

export type MatrixRow = {
  id: string
  label: string
  /** `level` = nivel de margen; `margin` = fila de porcentaje. */
  kind: "level" | "margin"
  note?: string
  cells: MatrixCell[]
}

/** Detalle de una celda: provenance + las líneas que la aportan. */
export type CellDetail = {
  title: string
  /** Aporte NO cumulativo de este nivel en esta columna. */
  contributionCents: number
  cumulativeCents: number
  provenance?: Provenance
  lines: CellLine[]
}

export type CellLine = {
  entryRef: string
  lineNo: number
  accountCode: string
  accountName: string
  analyticType: string
  projectCode: string | null
  costCenterCode: string | null
  amountCents: number
}

export type MatrixView = {
  headers: MatrixHeader[]
  rows: MatrixRow[]
  /** Cabecera de la primera columna ("Nivel" o "Proyecto / centro"). */
  cornerLabel: string
  details: Record<string, CellDetail>
  check: {
    label: string
    differenceCents: number
    balanced: boolean
  }
}

// ── Dimensiones ──────────────────────────────────────────────────────────────

export type BusinessLineOption = { id: string; code: string; name: string }

export type ProjectRow = {
  id: string
  code: string
  name: string
  businessLineId: string
  businessLineCode: string | null
  status: "PLANNED" | "ACTIVE" | "CLOSED"
  closedAt?: string | null
  isActive: boolean
  lineCount: number
  counterpartyId?: string | null
  startDate?: string | null
  endDate?: string | null
  budgetRevenueCents?: number | null
  budgetCostCents?: number | null
  /** Del periodo, salido de la matriz (`INGRESOS` de su columna). */
  periodRevenueCents?: number | null
  /** MC2 del periodo de su columna. */
  periodMc2Cents?: number | null
  /** MC3 del periodo de su columna. */
  periodMc3Cents?: number | null
  /** `INGRESOS − presupuesto de ingresos`, en céntimos. Calculado. */
  revenueVarianceCents?: number | null
}

export type CostCenterRow = {
  id: string
  code: string
  name: string
  kind: string
  marginLevel: "MC3" | "EBITDA"
  allocatable: boolean
  isActive: boolean
  isSystem?: boolean
  lineCount: number
  imputedCents: number
}

export type BusinessLineRow = {
  id: string
  code: string
  name: string
  color: string
  isSystem: boolean
  isActive: boolean
  projectCount: number
  lineCount: number
}

/** Opción de destino analítico de una línea 6/7. */
export type DimensionOption = {
  id: string
  code: string
  name: string
  /** `project` o `costCenter`: el combobox de destino ofrece las dos familias. */
  family: "project" | "costCenter"
  disabled?: boolean
  hint?: string
}

// ── Configuración ────────────────────────────────────────────────────────────

export type MarginLevelRowView = {
  level: string
  label: string
  analyticTypes: string[]
  sortOrder: number
  isVisible: boolean
  validFrom: string
  validTo: string | null
}

export const MARGIN_LEVEL_LABELS: Record<string, string> = {
  INGRESOS: "Ingresos",
  MC1: "Margen de contribución 1",
  MC2: "Margen de contribución 2",
  MC3: "Margen de contribución 3",
  EBITDA: "EBITDA",
  EBIT: "EBIT",
  BAI: "Resultado antes de impuestos",
  RESULTADO: "Resultado del ejercicio",
}

export const ANALYTIC_TYPE_LABELS: Record<string, string> = {
  INGRESO_DIRECTO: "Ingreso directo",
  COSTE_DIRECTO_MC1: "Coste directo (MC1)",
  COSTE_DIRECTO_MC2: "Coste directo (MC2)",
  INDIRECTO_CECO: "Indirecto de centro de coste",
  AMORTIZACION_DETERIORO: "Amortización y deterioro",
  FINANCIERO: "Financiero",
  EXTRAORDINARIO: "Extraordinario",
  NO_ANALITICO: "No analítico",
}

export const COST_CENTER_KIND_LABELS: Record<string, string> = {
  MARKETING_VENTAS: "Marketing y ventas",
  OPERACIONES_INDIRECTAS: "Operaciones indirectas",
  G_A: "General y administración",
  DESARROLLO_PRODUCTO: "Desarrollo de producto",
  FINANCIERO: "Financiero",
  EXTRAORDINARIO: "Extraordinario",
  OTROS: "Otros",
  SIN_ASIGNAR: "Sin asignar",
}

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  PLANNED: "Previsto",
  ACTIVE: "Activo",
  CLOSED: "Cerrado",
}

/** `4520` puntos básicos → `45,2 %`. No es un cálculo: es el formato. */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—"
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    .format(bps / 100)
    .replace("-", "−")} %`
}
