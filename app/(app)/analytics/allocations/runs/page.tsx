import { listAllocationRunsAction } from "@/app/(app)/analytics/allocations/actions"
import { AllocationPreviewPanel, type FiscalYearOption } from "@/components/analytics/allocation-preview-table"
import { AllocationRunsTable } from "@/components/analytics/allocation-runs-table"
import { periodLabelOf, type AllocationRunView } from "@/components/analytics/allocation-types"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { listFiscalYears } from "@/models/fiscal-years"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Liquidaciones" }

/**
 * E5 · T12 — Simulación y liquidaciones (`E5-liquidacion.md` §6).
 *
 * Una sola pantalla con las dos mitades del ciclo, porque son el mismo gesto:
 * se simula un periodo, se ve exactamente lo que se va a persistir y se sella.
 * La simulación es obligatoria antes de sellar y los tres sellos que devuelve
 * viajan con el sellado, de modo que un asiento tardío entre una cosa y la otra
 * **no** se cuela en una liquidación ya aprobada.
 *
 * Lecturas en SERIE dentro de la transacción de `tenantPage`.
 */
export default tenantPage(async ({ db, org, role }) => {
  const canSeal = role === Role.EDITOR || role === Role.ADMIN

  const fiscalYearRows = await listFiscalYears(db)
  const state = await listAllocationRunsAction({})

  const fiscalYears: FiscalYearOption[] = fiscalYearRows.map((fy) => ({
    id: fy.id,
    code: fy.code,
    startDate: fy.startDate.toISOString().slice(0, 10),
    endDate: fy.endDate.toISOString().slice(0, 10),
  }))

  const runs: AllocationRunView[] = (state.data ?? []).map((run) => ({
    id: run.id,
    periodKind: run.periodKind,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    periodLabel: periodLabelOf(run.periodKind, run.periodStart),
    status: run.status,
    lineCount: run.lineCount,
    totalAllocatedCents: run.totalAllocatedCents,
    ledgerHash: run.ledgerHash,
    analyticsHash: run.analyticsHash,
    rulesHash: run.rulesHash,
    gitSha: run.gitSha,
    runAt: run.runAt,
    supersededById: run.supersededById,
    reversedAt: run.reversedAt,
    reversalReason: null,
    isStale: run.isStale,
    staleReasons: run.staleReasons,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Liquidaciones de centros de coste</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Simula un periodo, comprueba regla a regla de dónde sale cada importe y séllalo. La liquidación es capa
            analítica: <strong>no toca el libro diario</strong>, es reversible y se puede repetir. Lo que reparte cada
            regla se decide en <Link href="/analytics/allocations" className="underline underline-offset-2">Reglas de liquidación</Link>.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/analytics/pyg?imputaciones=si">Ver la PyG analítica imputada</Link>
        </Button>
      </div>

      <AllocationPreviewPanel fiscalYears={fiscalYears} canSeal={canSeal} currency={org.baseCurrency} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Liquidaciones selladas</h2>
        {!state.success && (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
            No se han podido leer las liquidaciones: {state.error ?? "error desconocido"}.
          </p>
        )}
        <AllocationRunsTable runs={runs} canReverse={canSeal} currency={org.baseCurrency} />
      </section>
    </div>
  )
})
