/**
 * E10 · T15 — Modelos de vista del **editor de presupuesto**.
 *
 * Mismo contrato que `components/analytics/allocation-types.ts`: objetos planos
 * y serializables, importes en **céntimos enteros**, fechas `"YYYY-MM-DD"` y
 * meses `"YYYY-MM"`. **El navegador no suma ni un céntimo**: las filas, los
 * totales de fila, los de mes, los de nivel de margen y el total general llegan
 * ya resueltos del servidor (`app/(app)/analytics/budget/shared.ts`, que compone
 * sobre `lib/budget/matrix.ts`). Lo único que el cliente decide es qué texto ha
 * tecleado el usuario y en qué celda, y eso viaja en **texto** hasta
 * `ui-actions.ts`, donde `lib/money.parseCents` lo convierte.
 *
 * El aviso de signo que se pinta mientras se escribe es exactamente eso, un
 * aviso: compara el signo tecleado con el que el tipo analítico exige (O-E10-6)
 * y no bloquea nada. Quien decide es `checkBudgetSign` en el servidor, y detrás
 * el `CHECK budget_lines_sign_by_type`.
 */

export const BUDGET_ANALYTIC_TYPES = [
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "NO_ANALITICO",
] as const

export type BudgetAnalyticType = (typeof BUDGET_ANALYTIC_TYPES)[number]

/** El signo que el tipo analítico exige al APORTE (ADR-0018 D2). */
export type ExpectedSign = "POSITIVO" | "NEGATIVO" | "LIBRE"

/**
 * Espejo de `POSITIVE_TYPES` / `NEGATIVE_TYPES` de `lib/budget/hash.ts`. Aquí
 * vive sólo para **rotular** la columna y avisar en el acto; la comprobación de
 * verdad es del servidor.
 */
export const EXPECTED_SIGN: Readonly<Record<string, ExpectedSign>> = {
  INGRESO_DIRECTO: "POSITIVO",
  COSTE_DIRECTO_MC1: "NEGATIVO",
  COSTE_DIRECTO_MC2: "NEGATIVO",
  INDIRECTO_CECO: "NEGATIVO",
  AMORTIZACION_DETERIORO: "NEGATIVO",
  FINANCIERO: "LIBRE",
  EXTRAORDINARIO: "LIBRE",
  NO_ANALITICO: "LIBRE",
}

export const SIGN_LABEL: Readonly<Record<ExpectedSign, string>> = {
  POSITIVO: "+ ingreso",
  NEGATIVO: "− gasto",
  LIBRE: "± libre",
}

export const BUDGET_STATUS_LABEL: Readonly<Record<string, string>> = {
  BORRADOR: "Borrador",
  VIGENTE: "Vigente",
  SUSTITUIDO: "Sustituido",
}

export const BUDGET_SCENARIO_LABEL: Readonly<Record<string, string>> = {
  BASE: "Base",
  REVISADO: "Revisado",
}

/** Una celda del editor: su importe en céntimos y el id de su fila. */
export type BudgetSheetCell = {
  /** `null` = no hay dato (se pinta `—`, nunca `0`). */
  amountCents: number | null
  /** Excepción de signo declarada (rappel, devolución, reversión): O-E10-6. */
  signException: boolean
}

/** Una fila del editor: dimensión × cuenta × tipo analítico, y sus doce meses. */
export type BudgetSheetRow = {
  key: string
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionId: string
  dimensionCode: string
  dimensionName: string
  accountCode: string | null
  analyticType: string
  /** Congelado en la línea (O-E10-7). Lo pone el servidor, no el formulario. */
  marginLevel: string
  cells: Readonly<Record<string, BudgetSheetCell>>
  /** Σ de los doce meses, **sumada en el servidor**. */
  totalCents: number
  /** Celdas cuyo signo el servidor rechazaría, con su motivo. */
  signIssues: readonly { month: string; message: string }[]
}

/** La hoja completa, con todos sus totales ya resueltos en el servidor. */
export type BudgetSheetView = {
  months: readonly string[]
  rows: readonly BudgetSheetRow[]
  /** Σ por mes de todas las filas. */
  monthTotalsCents: Readonly<Record<string, number>>
  /** Σ por nivel de margen (de `buildBudgetMatrix`, no de esta tabla). */
  levelTotalsCents: readonly { level: string; cents: number }[]
  totalCents: number
  /** Celdas que la matriz no pudo situar. Nunca se arreglan en silencio. */
  unresolved: readonly { month: string; dimensionCode: string; code: string; message: string }[]
}

/** Cabecera de una versión, tal y como la pinta el selector. */
export type BudgetVersionView = {
  id: string
  label: string
  name: string
  scenario: string
  revision: number
  status: string
  fiscalYearId: string
  fiscalYearCode: string
  validFrom: string
  validTo: string | null
  partialFrom: string | null
  budgetHash: string | null
  sealedAt: string | null
  lineCount: number
  hoursLineCount: number
  totalCents: number
}

export type BudgetDimensionOption = {
  id: string
  code: string
  name: string
  kind: "PROJECT" | "COST_CENTER"
}

export type FiscalYearOption = { id: string; code: string; startDate: string; endDate: string }

/** Una fila del diff entre dos versiones, ya calculada por la acción. */
export type BudgetDiffRowView = {
  key: string
  month: string
  accountCode: string | null
  dimensionKind: string
  dimensionCode: string
  analyticType: string
  fromCents: number | null
  toCents: number | null
  deltaCents: number
}

/** `2026-03` → `mar 2026`. Formato, no cálculo. */
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

export function monthLabel(month: string): string {
  const [year, m] = month.split("-")
  const index = Number(m) - 1
  return `${MONTH_SHORT[index] ?? m} ${year}`
}

/** Clave estable de una fila del editor. La misma en servidor y en cliente. */
export const sheetRowKey = (input: {
  dimensionKind: string
  dimensionId: string
  accountCode: string | null
  analyticType: string
}): string => `${input.dimensionKind}:${input.dimensionId}|${input.accountCode ?? "∅"}|${input.analyticType}`
