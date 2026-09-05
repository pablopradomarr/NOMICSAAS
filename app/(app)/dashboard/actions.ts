"use server"

/**
 * E6 · T18 — Server actions del panel, **reescrito sobre el libro diario**.
 *
 * Cierra **G-05** (porcentajes `NaN` y totales que no cuadraban con el balance:
 * el panel heredado sumaba `Transaction.total` por moneda) y **G-06** (los
 * documentos sin contabilizar se contaban como 0 en silencio; ahora se declaran
 * y no se suman a nada).
 *
 * Ninguna cifra del panel se calcula aquí: todas salen del mismo `ReportRun`
 * que los informes, con `buildDashboard`, y el invariante I-E6-19 comprueba que
 * ingresos, resultado, tesorería y EBITDA coinciden con la PyG, el balance y la
 * matriz de E4. Un panel con su propia aritmética es cómo nacen los dos EBITDA
 * que no cuadran.
 *
 * «Hoy» se decide AQUÍ, en el borde: `refDate` viaja en `params` y entra en
 * `paramsHash`, de modo que dos ejecuciones con el mismo diario dan el mismo
 * aging.
 */


import type { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import { dashboardParamsSchema } from "@/forms/reports"
import { todayLocalDate } from "@/models/ledger"
import { getDashboard, type ReportRunView } from "@/models/reports"
import { countUnpostedTransactions } from "@/models/transactions"
import { Role } from "@/prisma/client"

export type DashboardView = ReportRunView & {
  /** G-06: se declara, nunca se suma como cero. */
  unpostedDocumentCount: number
}

/**
 * Panel del periodo. `VIEWER`: emitir el panel escribe un `ReportRun`, que es un
 * hecho fechado, no una mutación de negocio.
 */
export const dashboardAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<DashboardView>> => {
    const parsed = dashboardParamsSchema.safeParse(input)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { success: false, error: issue?.message ?? "Datos inválidos" }
    }
    const { periodStart, periodEnd, fiscalYearId, ...params } = parsed.data
    try {
      // El recuento entra por parámetro para que el motor siga siendo puro, y
      // entra en `params` para que el panel cacheado no mienta sobre él.
      const unpostedDocumentCount = await countUnpostedTransactions(tenantDb(org.id))
      const run = await getDashboard(org.id, {
        periodStart,
        periodEnd,
        ...(fiscalYearId ? { fiscalYearId } : {}),
        params: { ...params, variant: params.variant ?? org.pgcVariant, unpostedDocumentCount },
        actor: { userId: user.id },
      })
      return { success: true, data: { ...run, unpostedDocumentCount } }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "No se ha podido componer el panel",
      }
    }
  }
)

/** Periodo por defecto: el ejercicio en curso hasta hoy. */
export const defaultDashboardPeriodAction = withOrg(
  Role.VIEWER,
  async (): Promise<ActionState<{ periodStart: string; periodEnd: string; refDate: string }>> => {
    const today = todayLocalDate()
    return {
      success: true,
      data: { periodStart: `${today.slice(0, 4)}-01-01`, periodEnd: today, refDate: today },
    }
  }
)
