import {
  diffAllocationRunsAction,
  getAllocationRunAction,
  listAllocationRunsAction,
} from "@/app/(app)/analytics/allocations/actions"
import { ReverseRunDialog, RunStatusBadge } from "@/components/analytics/allocation-runs-table"
import {
  FALLBACK_LABELS,
  PERIOD_LABELS,
  WARNING_LABELS,
  formatShareBps,
  periodLabelOf,
  type AllocationRunView,
} from "@/components/analytics/allocation-types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Liquidación" }

type RunWarning = { code?: string; rule?: string; ruleCode?: string; period?: string; detail?: string }

/**
 * E5 · T12 — Detalle de una liquidación (`E5-liquidacion.md` §6).
 *
 * Las líneas emitidas con su **provenance completa**: regla versionada, centro
 * de coste fuente, receptor, nivel de margen, base del driver, base total,
 * cuota en puntos básicos y el fallback realmente aplicado. La celda es
 * auditable **sin recomputar el driver**, que es justo lo que exige el
 * drill-down de la PyG imputada.
 *
 * Debajo, el diff contra la liquidación anterior del mismo periodo, y el botón
 * de revertir con motivo obligatorio.
 */
export default tenantPage<{ params: Promise<{ id: string }> }>(async ({ org, role, params }) => {
  const { id } = await params
  const canReverse = role === Role.EDITOR || role === Role.ADMIN

  const state = await getAllocationRunAction({ runId: id })
  if (!state.success || !state.data) notFound()
  const run = state.data

  const runsState = await listAllocationRunsAction({ periodKind: run.periodKind })
  const siblings = (runsState.data ?? []).filter(
    (r) => r.periodStart === run.periodStart && r.periodEnd === run.periodEnd && r.id !== run.id
  )
  const previous = [...siblings].sort((a, b) => (a.runAt < b.runAt ? 1 : -1))[0] ?? null

  const diffState = previous ? await diffAllocationRunsAction({ runId: run.id, againstRunId: previous.id }) : null
  const diff = diffState?.success ? (diffState.data ?? []) : []

  const listed = (runsState.data ?? []).find((r) => r.id === run.id)
  const view: AllocationRunView = {
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
    reversalReason: run.reversalReason,
    isStale: listed?.isStale ?? false,
    staleReasons: listed?.staleReasons ?? [],
  }

  const warnings: RunWarning[] = Array.isArray(run.warnings) ? (run.warnings as RunWarning[]) : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Liquidación {view.periodLabel}</h1>
          <p className="text-sm text-muted-foreground">
            {PERIOD_LABELS[run.periodKind] ?? run.periodKind} · {formatLocalDate(run.periodStart)} –{" "}
            {formatLocalDate(run.periodEnd)} · moneda base {org.baseCurrency} · sellada el{" "}
            {run.runAt.slice(0, 16).replace("T", " ")}
          </p>
          <p className="font-code text-xs text-muted-foreground" data-testid="run-hashes">
            ledgerHash {shortHash(run.ledgerHash, 16)} · analyticsHash {shortHash(run.analyticsHash, 16)} · rulesHash{" "}
            {shortHash(run.rulesHash, 16)} · motor {shortHash(run.gitSha, 8)}
          </p>
          <div className="pt-1">
            <RunStatusBadge run={view} />
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/analytics/allocations/runs">Volver a liquidaciones</Link>
          </Button>
          {canReverse && run.status === "SEALED" && <ReverseRunDialog run={view} block />}
        </div>
      </div>

      {run.supersededById && (
        <p className="rounded-md border px-3 py-2 text-sm" data-testid="superseded-by">
          Esta liquidación ha sido sustituida por{" "}
          <Link href={`/analytics/allocations/runs/${run.supersededById}`} className="underline underline-offset-2">
            otra posterior del mismo periodo
          </Link>
          . Deja de aportar a la PyG analítica y se conserva íntegra: nada se borra.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">
          Líneas emitidas ({run.lineCount}) · total{" "}
          <AmountPlain cents={run.totalAllocatedCents} zeroAsDash={false} /> {org.baseCurrency}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="allocation-lines-table">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Regla</th>
                <th className="px-3 py-2 text-left font-medium">Fuente</th>
                <th className="px-3 py-2 text-left font-medium">Receptor</th>
                <th className="px-3 py-2 text-left font-medium">Nivel</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 text-right font-medium">Base total</th>
                <th className="px-3 py-2 text-right font-medium">Cuota</th>
                <th className="px-3 py-2 text-right font-medium">Importe</th>
                <th className="px-3 py-2 text-left font-medium">Base cero</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {run.lines.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-sm text-muted-foreground" colSpan={9}>
                    Esta liquidación no emitió ninguna línea.
                  </td>
                </tr>
              )}
              {run.lines.map((line, i) => (
                <tr key={`${line.ruleCode}-${line.target.code}-${i}`} className="h-8">
                  <td className="px-3 py-1 font-code text-xs">{line.ruleCode}</td>
                  <td className="px-3 py-1 font-code text-xs">{line.sourceCostCenterCode}</td>
                  <td className="px-3 py-1 font-code text-xs">{line.target.code}</td>
                  <td className="px-3 py-1 font-code text-xs">{line.marginLevel}</td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={line.driverBase} />
                  </td>
                  <td className="px-3 py-1 text-right text-muted-foreground">
                    <AmountPlain cents={line.driverBaseTotal} />
                  </td>
                  <td className="px-3 py-1 text-right font-code text-xs">{formatShareBps(line.driverShareBps)}</td>
                  <td className="px-3 py-1 text-right font-medium">
                    <AmountPlain cents={line.amountCents} />
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">
                    {line.fallbackApplied ? (FALLBACK_LABELS[line.fallbackApplied] ?? line.fallbackApplied) : "—"}
                    {line.eligibilityReason && (
                      <span className="ml-1" title="El receptor entró pese a estar cerrado porque tuvo actividad en el periodo">
                        · actividad en el periodo
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border p-3" data-testid="run-warnings">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Avisos del cálculo</h2>
        {warnings.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Ninguno.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>
                <span className="font-code text-xs">{w.code}</span> ·{" "}
                <strong>{WARNING_LABELS[w.code ?? ""] ?? w.code}</strong> · regla{" "}
                <span className="font-code text-xs">{w.ruleCode ?? w.rule}</span>: {w.detail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Diferencias con la liquidación anterior</h2>
        {!previous ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="run-diff-empty">
            Es la primera liquidación de este periodo: no hay nada con lo que compararla.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="run-diff-table">
              <caption className="px-3 py-2 text-left text-xs text-muted-foreground">
                Contra la liquidación sellada el {previous.runAt.slice(0, 16).replace("T", " ")}.
              </caption>
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Regla</th>
                  <th className="px-3 py-2 text-left font-medium">Fuente</th>
                  <th className="px-3 py-2 text-left font-medium">Receptor</th>
                  <th className="px-3 py-2 text-left font-medium">Nivel</th>
                  <th className="px-3 py-2 text-right font-medium">Antes</th>
                  <th className="px-3 py-2 text-right font-medium">Ahora</th>
                  <th className="px-3 py-2 text-right font-medium">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {diff.map((row) => (
                  <tr key={row.key} className="h-8" data-diff-key={row.key}>
                    <td className="px-3 py-1 font-code text-xs">{row.ruleCode}</td>
                    <td className="px-3 py-1 font-code text-xs">{row.sourceCostCenterCode}</td>
                    <td className="px-3 py-1 font-code text-xs">{row.targetCode}</td>
                    <td className="px-3 py-1 font-code text-xs">{row.marginLevel}</td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={row.beforeCents} />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={row.afterCents} />
                    </td>
                    <td className="px-3 py-1 text-right font-medium">
                      <AmountPlain cents={row.deltaCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
})
