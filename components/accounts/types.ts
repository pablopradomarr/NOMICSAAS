/**
 * E2 · T10 — DTOs que el Server Component envía al árbol del plan.
 *
 * El cliente NO consulta la base de datos ni calcula nada contable: recibe el
 * plan ya resuelto y sólo filtra, ordena y pinta.
 */

import type { AnalyticType, CashflowCategory, PgcVariant, PlanAccount, Statement } from "@/lib/accounts/types"

export type { PlanAccount }

/** Catálogos cerrados que alimentan los selects de clasificación (R-15). */
export type ClassificationCatalog = {
  variant: PgcVariant
  epigraphs: readonly string[]
  analyticTypes: readonly AnalyticType[]
  cashflowCategories: readonly CashflowCategory[]
  statements: readonly Statement[]
}

/** Etiquetas en español oficial del PGC. */
export const STATEMENT_LABELS: Record<string, string> = {
  BALANCE_ACTIVO: "Balance · Activo",
  BALANCE_PASIVO: "Balance · Pasivo",
  BALANCE_PN: "Balance · Patrimonio neto",
  PYG: "Pérdidas y ganancias",
  ECPN: "Cambios en el patrimonio neto",
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

export const CASHFLOW_LABELS: Record<string, string> = {
  OPERATING: "Explotación",
  INVESTING: "Inversión",
  FINANCING: "Financiación",
}

export const LEVEL_LABELS: Record<number, string> = {
  1: "Grupo",
  2: "Subgrupo",
  3: "Cuenta",
  4: "Subcuenta",
}

export function levelLabel(level: number): string {
  return LEVEL_LABELS[level] ?? "Subcuenta propia"
}
