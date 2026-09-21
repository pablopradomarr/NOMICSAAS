"use server"

/**
 * E10 · T14 — Server actions del informe **presupuesto vs real** (§4.2 y §5.1).
 *
 * Tres cosas que sólo pasan aquí:
 *
 *  · **`BUDGET_NOT_SEALED` es del borde.** `budgetVsActual()` lanza un
 *    `BudgetReportError` tipado y esta capa lo traduce a español contable: un
 *    borrador no firma un informe (O-E10-5), pero **sí** se puede ver en
 *    previsualización, y el mensaje lo dice.
 *  · **La previsualización no escribe.** `previewBudgetVsActualAction` es el
 *    patrón de `previewAllocation` de E5: dry-run puro, **sin fila en
 *    `report_runs`**, con la banda «borrador, no firmable».
 *  · **El drill-down en ≤ 3 clics** son TRES consultas independientes (§5.1 y
 *    §8): el diario (`analyticCellDetailAction`), el reparto
 *    (`allocationCellDetailAction`) y el presupuesto —que es la que vive aquí,
 *    porque las líneas de presupuesto no están en el diario—.
 *
 * Emitir un `ReportRun` es un **hecho**, no una mutación: por eso leer es
 * `VIEWER` (precedente de E6).
 */

import { budgetCellDetailSchema, budgetVsActualSchema } from "@/forms/budget"
import { ActionState } from "@/lib/actions"
import type { AnalyticsConfig } from "@/lib/analytics/types"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { getBudgetVersion } from "@/models/budget"
import {
  budgetVsActual,
  BudgetReportError,
  type BudgetProfitabilityRow,
  type VolumePriceRow,
  type BudgetVsActualView,
} from "@/models/reports"
import { Role } from "@/prisma/client"
import { z } from "zod"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

/**
 * Los tres códigos del informe, en español contable y **con la salida**. El
 * modelo dice qué pasó; aquí se dice qué hacer, que es lo que la pantalla
 * necesita enseñar.
 */
function budgetReportMessage(error: BudgetReportError): string {
  if (error.code === "BUDGET_NOT_SEALED") {
    return `${error.message}. Puedes verla en previsualización, pero un informe firmado necesita una versión sellada`
  }
  if (error.code === "BUDGET_NOT_FOUND") {
    return `${error.message}. Elige una versión en el selector, o crea la BASE del ejercicio`
  }
  return `${error.message}. Abre el ejercicio en Configuración → Ejercicios`
}

// ─────────────────────────────────────────────────────────────────────────────
// Contratos de salida (C3 arranca de aquí)
// ─────────────────────────────────────────────────────────────────────────────

/** La TERCERA consulta de la procedencia (§5.1): las líneas de presupuesto. */
export type BudgetCellDetailRow = {
  month: string
  accountCode: string | null
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionCode: string
  analyticType: string
  marginLevel: string
  amountCents: number
  signException: boolean
}

export type BudgetCellDetail = {
  budgetId: string
  budgetCode: string
  level: string
  column: string
  month: string | null
  rows: readonly BudgetCellDetailRow[]
  totalCents: number
  /** Qué consulta reproduce la cifra. La celda es auditable sin recomputar. */
  query: string
}

export type ProjectProfitabilityPayload = {
  runId: string | null
  sealed: boolean
  budgetHash: string
  rows: readonly BudgetProfitabilityRow[]
  absorption: unknown
  /**
   * **E12 · T19 (Q-6 / D6)** — la descomposición volumen/precio del mismo
   * informe. Va en el payload y no se recalcula en la ficha del proyecto: dos
   * cifras que salen de dos sitios distintos acaban discrepando, y ésta es
   * justamente la que un comité mira al lado del margen por hora.
   */
  volumePrice: readonly VolumePriceRow[]
}

// ─────────────────────────────────────────────────────────────────────────────
// El informe (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Informe **sellado**: exige una versión `VIGENTE` y emite un `ReportRun` con
 * `budgetHash` como noveno componente de la clave. Contra un `BORRADOR`
 * responde `BUDGET_NOT_SEALED` y **no escribe ninguna fila**.
 */
export const budgetVsActualAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<BudgetVsActualView>> => {
    const parsed = budgetVsActualSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const view = await budgetVsActual(org.id, { ...parsed.data, actor: { userId: user.id } })
      return { success: true, data: view }
    } catch (error) {
      if (error instanceof BudgetReportError) return { success: false, error: budgetReportMessage(error) }
      throw error
    }
  }
)

/**
 * **Previsualización no sellada** contra un `BORRADOR`: dry-run puro, sin fila
 * en `report_runs`. La banda «borrador, no firmable» la pinta la pantalla a
 * partir de `sealed = false` y `runId = null`.
 */
export const previewBudgetVsActualAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<BudgetVsActualView>> => {
    const parsed = budgetVsActualSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const view = await budgetVsActual(org.id, { ...parsed.data, preview: true, actor: { userId: user.id } })
      return { success: true, data: view }
    } catch (error) {
      if (error instanceof BudgetReportError) return { success: false, error: budgetReportMessage(error) }
      throw error
    }
  }
)

/**
 * Rentabilidad por proyecto **con horas** (§5.2): margen por hora MC2 y MC3,
 * coste-hora medio **con su `basis`** y la desviación de absorción. Sale del
 * MISMO informe, para que la cifra de la ficha del proyecto y la del informe no
 * puedan divergir.
 */
export const projectProfitabilityAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<ProjectProfitabilityPayload>> => {
    const parsed = budgetVsActualSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const view = await budgetVsActual(org.id, { ...parsed.data, actor: { userId: user.id } })
      return {
        success: true,
        data: {
          runId: view.runId,
          sealed: view.sealed,
          budgetHash: view.budgetHash,
          rows: view.result.profitability,
          absorption: view.result.absorption,
          volumePrice: view.result.volumePrice,
        },
      }
    } catch (error) {
      if (error instanceof BudgetReportError) return { success: false, error: budgetReportMessage(error) }
      throw error
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down: la tercera consulta de la procedencia
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las líneas de PRESUPUESTO detrás de una celda de desviación. Las otras dos
 * mitades —diario y reparto— ya las sirven `analyticCellDetailAction` y
 * `allocationCellDetailAction` de `/analytics/actions.ts`, y así el camino
 * celda → desglose → líneas → asiento son tres clics.
 */
export const budgetCellDetailAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<BudgetCellDetail>> => {
    const parsed = budgetCellDetailSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data

    const detail = await tenantTransaction(org.id, user.id, async (tx) => {
      const version = await getBudgetVersion(tx, v.budgetId)
      if (!version) return null
      const config = await getAnalyticsConfig(tx, { periodEnd: version.fiscalYearEnd })
      const rows = version.cells
        .filter((c) => (v.month ? c.month === v.month : true))
        .filter((c) => c.marginLevel === v.level || levelCovers(v.level, c.marginLevel))
        .filter((c) => matchesColumn(c, v.column, config))
        .map((c) => ({
          month: c.month,
          accountCode: c.accountCode,
          dimensionKind: c.dimension.kind,
          dimensionCode: c.dimension.code,
          analyticType: c.analyticType as string,
          marginLevel: c.marginLevel as string,
          amountCents: c.amountCents,
          signException: c.signException,
        }))
        .sort((a, b) => a.month.localeCompare(b.month) || (a.accountCode ?? "").localeCompare(b.accountCode ?? ""))
      return {
        budgetId: version.id,
        budgetCode: version.code,
        level: v.level,
        column: v.column,
        month: v.month ?? null,
        rows,
        totalCents: rows.reduce((a, r) => a + r.amountCents, 0),
        query:
          `budget_lines WHERE budget_id = '${version.id}'` +
          (v.month ? ` AND month = '${v.month}'` : "") +
          ` AND margin_level = '${v.level}' -- columna ${v.column}`,
      }
    })
    if (!detail) return { success: false, error: "La versión de presupuesto no existe en esta organización" }
    return { success: true, data: detail }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La matriz es **acumulativa**: una celda de MC3 contiene lo que aporta MC1 y
 * MC2. El desglose de un nivel enseña, por tanto, todo lo que llega hasta él.
 */
const LEVEL_ORDER = ["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"] as const
const levelCovers = (asked: string, cell: string): boolean => {
  const a = LEVEL_ORDER.indexOf(asked as (typeof LEVEL_ORDER)[number])
  const c = LEVEL_ORDER.indexOf(cell as (typeof LEVEL_ORDER)[number])
  return a >= 0 && c >= 0 && c <= a
}

/** La misma partición de columnas de `lib/analytics/margins.ts`, leída al revés. */
function matchesColumn(
  cell: { dimension: { kind: string; code: string }; analyticType: string },
  column: string,
  config: AnalyticsConfig
): boolean {
  if (column.startsWith("PROJ:")) {
    return cell.dimension.kind === "PROJECT" && cell.dimension.code === column.slice("PROJ:".length)
  }
  if (column.startsWith("CECO:")) {
    const kind = column.slice("CECO:".length)
    const ceco = config.costCenters.find((c) => c.code === cell.dimension.code)
    return cell.dimension.kind === "COST_CENTER" && ceco?.kind === kind
  }
  if (column.startsWith("BL:")) {
    const code = column.slice("BL:".length)
    const project = config.projects.find((p) => p.code === cell.dimension.code)
    const line = config.businessLines.find((b) => b.id === project?.businessLineId)
    return cell.dimension.kind === "PROJECT" && line?.code === code
  }
  // Las cuatro columnas por tipo: `AMORTIZACION_DETERIORO`, `FINANCIERO`,
  // `EXTRAORDINARIO` y `NO_ANALITICO`.
  return cell.analyticType === column
}
