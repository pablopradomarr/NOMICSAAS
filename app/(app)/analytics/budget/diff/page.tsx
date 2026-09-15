import { budgetDiffAction, listBudgetsAction } from "@/app/(app)/analytics/budget/actions"
import { toVersionView } from "@/app/(app)/analytics/budget/shared"
import { BudgetDiffPicker, BudgetDiffTable } from "@/components/budget/budget-diff-table"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { listFiscalYears } from "@/models/fiscal-years"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Diff de presupuesto" }

/**
 * E10 · T15 — **Diff entre dos versiones** de presupuesto (§7).
 *
 * La contrapartida visible de «sustituir, no corregir»: las dos versiones
 * siguen enteras, así que se pueden comparar celda a celda. El Δ lo compone
 * `budgetDiffAction` en el servidor; esta pantalla elige el par y lo pinta.
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, searchParams }) => {
    const query = await searchParams
    const first = (key: string): string | null => {
      const value = query[key]
      const raw = Array.isArray(value) ? value[0] : value
      return raw && raw.trim() !== "" ? raw : null
    }

    const fiscalYearRows = await listFiscalYears(db)
    const codeByFiscalYear = new Map(fiscalYearRows.map((year) => [year.id, year.code]))

    const listState = await listBudgetsAction({})
    const versions = (listState.data ?? []).map((item) =>
      toVersionView(item, codeByFiscalYear.get(item.fiscalYearId) ?? "—")
    )

    const fromId = first("from")
    const toId = first("to")
    const diffState = fromId && toId && fromId !== toId ? await budgetDiffAction({ budgetId: toId, againstBudgetId: fromId }) : null

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Diff entre versiones de presupuesto</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Qué cambió la reproyección, celda a celda. Una versión sellada nunca se corrige: se sustituye por otra
              fechada, y las dos siguen consultables. Esto es lo que esa doctrina permite ver.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/analytics/budget">Volver al presupuesto</Link>
          </Button>
        </div>

        <BudgetDiffPicker versions={versions} fromId={fromId} toId={toId} />

        {!listState.success && (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
            No se han podido leer las versiones: {listState.error ?? "error desconocido"}.
          </p>
        )}

        {diffState && !diffState.success && (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert" data-testid="diff-error">
            No se ha podido componer el diff: {diffState.error ?? "error desconocido"}.
          </p>
        )}

        {!diffState && (
          <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="diff-idle">
            Elige dos versiones distintas para compararlas.
          </p>
        )}

        {diffState?.success && diffState.data && (
          <BudgetDiffTable
            rows={diffState.data.rows}
            totalDeltaCents={diffState.data.totalDeltaCents}
            fromLabel={diffState.data.from.label}
            toLabel={diffState.data.to.label}
          />
        )}
      </div>
    )
  }
)
