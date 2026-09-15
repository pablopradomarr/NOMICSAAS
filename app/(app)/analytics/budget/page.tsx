import { getBudgetAction, listBudgetsAction } from "@/app/(app)/analytics/budget/actions"
import { getAnalyticsConfigAction } from "@/app/(app)/analytics/actions"
import { buildBudgetSheet, toVersionView } from "@/app/(app)/analytics/budget/shared"
import { DepreciationProposalDialog } from "@/components/budget/budget-depreciation"
import { BudgetImportPanel } from "@/components/budget/budget-import"
import { BudgetSheet } from "@/components/budget/budget-sheet"
import { BudgetVersionsTable } from "@/components/budget/budget-versions"
import type { BudgetDimensionOption, FiscalYearOption } from "@/components/budget/types"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { listFiscalYears } from "@/models/fiscal-years"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Presupuesto" }

/**
 * E10 · T15 — **Editor de presupuesto** (`E10-presupuesto-horas.md` §7).
 *
 * Una hoja de cuenta × mes × dimensión con las versiones a la vista. Las tres
 * cosas que esta pantalla se toma en serio:
 *
 * 1. **No se calcula nada en el navegador.** La hoja, sus totales de fila, de
 *    mes, por nivel de margen y el general los compone `buildBudgetSheet` en el
 *    servidor, sobre la misma matriz (`lib/budget/matrix.ts`) que firma el
 *    `budgetHash` y que compara `budget-vs-actual`.
 * 2. **El presupuesto es una decisión, no un cálculo** (aviso de método (a) de
 *    §7): nada lo deriva del real, y una desviación mide el plan tanto como la
 *    ejecución. Se dice en pantalla.
 * 3. **Sellado, vigencias y composición** se ven: qué versión rige, desde
 *    cuándo, si es parcial y qué hash firma.
 *
 * Lecturas en SERIE dentro de la transacción de `tenantPage`.
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, org, role, searchParams }) => {
    const query = await searchParams
    const first = (key: string): string | undefined => {
      const value = query[key]
      return Array.isArray(value) ? value[0] : value
    }

    const isAdmin = role === Role.ADMIN
    const canWrite = role === Role.ADMIN || role === Role.EDITOR

    const fiscalYearRows = await listFiscalYears(db)
    const fiscalYears: FiscalYearOption[] = fiscalYearRows.map((year) => ({
      id: year.id,
      code: year.code,
      startDate: year.startDate.toISOString().slice(0, 10),
      endDate: year.endDate.toISOString().slice(0, 10),
    }))
    const codeByFiscalYear = new Map(fiscalYears.map((year) => [year.id, year.code]))

    const listState = await listBudgetsAction({})
    const versions = (listState.data ?? []).map((item) =>
      toVersionView(item, codeByFiscalYear.get(item.fiscalYearId) ?? "—")
    )

    const requested = first("budgetId")
    const selected =
      versions.find((version) => version.id === requested) ??
      versions.find((version) => version.status === "BORRADOR") ??
      versions.find((version) => version.status === "VIGENTE") ??
      versions[0] ??
      null

    const versionState = selected ? await getBudgetAction({ budgetId: selected.id }) : null
    const configState = selected ? await getAnalyticsConfigAction(selected.validFrom) : null
    const config = configState?.data ?? null
    const version = versionState?.data ?? null

    const sheet = version && config ? buildBudgetSheet(version, config) : null
    const dimensions: readonly BudgetDimensionOption[] = config
      ? [
          ...config.projects.map((p) => ({ id: p.id, code: p.code, name: p.name, kind: "PROJECT" as const })),
          ...config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name, kind: "COST_CENTER" as const })),
        ]
      : []

    const readError = !listState.success
      ? (listState.error ?? "error desconocido")
      : versionState && !versionState.success
        ? (versionState.error ?? "error desconocido")
        : configState && !configState.success
          ? (configState.error ?? "error desconocido")
          : null

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Presupuesto</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              El presupuesto es una <strong>decisión</strong>, no un cálculo: nada lo deriva del real, y una desviación
              mide el plan tanto como la ejecución. Se teclea por cuenta, mes y dimensión, en{" "}
              <strong>aporte</strong> (ingreso +, gasto −); los totales los compone el servidor y el signo lo valida al
              guardar. Una versión sellada no se edita: se revisa, y el diff enseña qué cambió.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/analytics/budget/diff" data-testid="go-to-diff">
                Comparar versiones
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/analytics/budget-vs-actual">Presupuesto vs real</Link>
            </Button>
          </div>
        </div>

        {readError && (
          <p
            className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
            role="alert"
            data-testid="budget-error"
          >
            No se ha podido leer el presupuesto: {readError}.
          </p>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Versiones</h2>
          <BudgetVersionsTable
            versions={versions}
            selectedId={selected?.id ?? null}
            isAdmin={isAdmin}
            fiscalYears={fiscalYears}
          />
        </section>

        {selected && version && sheet && (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
              <h2 className="text-lg font-semibold tracking-tight" data-testid="budget-selected">
                {selected.label} · {selected.name}
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span data-testid="budget-seal">
                  {selected.status === "BORRADOR" ? (
                    <span className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-2 py-0.5">
                      Borrador: no firmable
                    </span>
                  ) : (
                    <span className="rounded-md border bg-[#0A0A0A] px-2 py-0.5 text-white">
                      Sellado el {selected.sealedAt?.slice(0, 10) ?? "—"}
                    </span>
                  )}
                </span>
                <span className="font-code" title={selected.budgetHash ?? "sin sellar"}>
                  budgetHash {selected.budgetHash ? selected.budgetHash.slice(0, 12) : "—"}
                </span>
                <span>
                  Vigencia {selected.validFrom} … {selected.validTo ?? "abierta"}
                  {selected.partialFrom ? ` · parcial desde ${selected.partialFrom}` : ""}
                </span>
                {canWrite && selected.status === "BORRADOR" && (
                  <DepreciationProposalDialog
                    budgetId={selected.id}
                    fiscalYearId={selected.fiscalYearId}
                    canEdit={canWrite}
                  />
                )}
              </div>
            </div>

            <BudgetSheet
              budgetId={selected.id}
              sheet={sheet}
              dimensions={dimensions}
              canEdit={canWrite && selected.status === "BORRADOR"}
              sealed={selected.status !== "BORRADOR"}
              currency={org.baseCurrency}
            />

            {selected.status === "BORRADOR" && (
              <BudgetImportPanel budgetId={selected.id} canEdit={canWrite} />
            )}
          </section>
        )}
      </div>
    )
  }
)
