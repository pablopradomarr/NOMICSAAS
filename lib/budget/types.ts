/**
 * E10 · T7 — Tipos del presupuesto (`docs/design/E10-presupuesto-horas.md` §3.1).
 *
 * Módulo PURO: sin IO, sin Prisma, sin LLM, sin `Date.now()`. El hook
 * `.claude/hooks/guard.sh` cubre `lib/budget/**` desde T3.
 *
 * Toda la aritmética es ENTERA: céntimos (`Cents`) y minutos. Los agregados que
 * pueden pasar de 2⁵³ se exponen además en `BigInt` (`levelTotalsBig`), igual
 * que hace `buildAnalyticPnl`.
 */

import type { AnalyticType, Cents, LocalDate, MarginLevel } from "@/lib/analytics/types"

export type { AnalyticType, Cents, LocalDate, MarginLevel }

/** `BudgetScenario` de Prisma, sin importar el cliente en un módulo puro. */
export type BudgetScenario = "BASE" | "REVISADO"

/** `BudgetStatus` de Prisma. Sólo `VIGENTE` está sellado (ADR-0018 D3). */
export type BudgetStatus = "BORRADOR" | "VIGENTE" | "SUSTITUIDO"

/**
 * **O-A6** — exactamente UNA dimensión por celda: proyecto o CECO, nunca las
 * dos ni ninguna. El tipo lo hace imposible de construir mal.
 */
export type BudgetDimension =
  | { kind: "PROJECT"; id: string; code: string; businessLineCode: string | null }
  | { kind: "COST_CENTER"; id: string; code: string }

/** Celda de importe de una versión de presupuesto. */
export type BudgetCell = {
  /** Primer día del mes presupuestado: `2026-03-01`. */
  month: LocalDate
  /** `null` = total de la dimensión, sin desglose por cuenta (O-A6). */
  accountCode: string | null
  dimension: BudgetDimension
  /** **O-E10-23**: nunca nulo. Sin él, el CHECK de signo no comprobaría nada. */
  analyticType: AnalyticType
  /** **O-E10-7**: congelado en la línea y parte del `budgetHash`. */
  marginLevel: MarginLevel
  /** APORTE (D2): ingreso +, gasto −. */
  amountCents: Cents
  /** Excepción de signo DECLARADA (rappel, devolución, reversión): O-E10-6. */
  signException: boolean
}

/** Celda de horas presupuestadas (Q-2: MINUTOS enteros, nunca centésimas). */
export type BudgetHoursCell = {
  month: LocalDate
  dimension: BudgetDimension
  employeeCode: string | null
  minutes: number
}

/** Una versión de presupuesto completa, tal y como la lee el motor. */
export type BudgetVersion = {
  id: string
  /** Código visible (`2026-BASE`, `2026-REV1`). Es la etiqueta de procedencia. */
  code: string
  scenario: BudgetScenario
  revision: number
  status: BudgetStatus
  fiscalYearId: string
  fiscalYearStart: LocalDate
  fiscalYearEnd: LocalDate
  validFrom: LocalDate
  validTo: LocalDate | null
  /** **O-E10-9**: `null` = cubre los doce meses; con valor, sustituye desde ese mes. */
  partialFrom: LocalDate | null
  cells: readonly BudgetCell[]
  hours: readonly BudgetHoursCell[]
}

/** Celda que no se pudo situar en la matriz. Nunca se «arregla» en silencio. */
export type UnresolvedBudgetCell = {
  month: LocalDate
  accountCode: string | null
  dimensionKind: BudgetDimension["kind"]
  dimensionCode: string
  code: "CECO_UNKNOWN" | "PROJECT_UNKNOWN" | "DEST_MISSING" | "TYPE_UNKNOWN" | "LEVEL_DRIFT"
  message: string
}

/** Ventana de fechas cerrada por los dos extremos. */
export type DateWindow = { from: LocalDate; to: LocalDate }

/** Mes canónico `YYYY-MM` de una fecha o de un primer-día-de-mes. */
export const monthKey = (date: LocalDate): string => date.slice(0, 7)

/** Primer día del mes `YYYY-MM`. */
export const monthStart = (month: string): LocalDate => `${month}-01`

/** Los doce meses `YYYY-MM` de un ejercicio, del inicio al fin, inclusive. */
export function fiscalYearMonths(start: LocalDate, end: LocalDate): string[] {
  const out: string[] = []
  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7))
  const last = monthKey(end)
  for (let guard = 0; guard < 1200; guard++) {
    const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
    out.push(key)
    if (key >= last) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}
