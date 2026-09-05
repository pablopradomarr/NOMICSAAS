import { runDetailAction, runDiffAction } from "@/app/(app)/reports/actions"
import { runHeader } from "@/app/(app)/reports/shared"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { requireOrg } from "@/lib/authz"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Informe emitido" }

/**
 * E6 · T17 — Detalle de un `ReportRun` (§6).
 *
 * Las cifras **congeladas** del run, sus checks, el sello con sus motivos por
 * código y el **diff contra el run comparado** (`comparativeRunId`, O-6): sin
 * poder reconstruir contra qué se midió la variación, el motivo del sello sería
 * una afirmación sin respaldo.
 */
export default async function ReportRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { org } = await requireOrg(Role.VIEWER)
  const { id } = await params

  const state = await runDetailAction(id)
  if (!state.success || !state.data) notFound()
  const run = state.data

  const diffState = await runDiffAction(id)
  const diff = diffState.success ? diffState.data : null

  const params_ = Object.entries(run.params ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))

  return (
    <div className="space-y-6">
      <ReportHeader
        title={`Informe ${run.type}`}
        description={`Emitido el ${run.createdAt.toLocaleString("es-ES")} en ${run.durationMs} ms. Las cifras de esta página son las que se congelaron en ese momento; el diario puede haber cambiado desde entonces.`}
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación congelada en el informe"
        actions={<ExportLinks type={run.type} runId={run.id} />}
      />

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-semibold tracking-tight">Parámetros</h2>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Periodo</dt>
            <dd>
              {formatLocalDate(run.periodStart)} – {formatLocalDate(run.periodEnd)}
            </dd>
            {params_.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="font-code text-xs break-all">{String(value)}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">paramsHash</dt>
            <dd className="font-code text-xs break-all">{run.paramsHash}</dd>
            <dt className="text-muted-foreground">ledgerHash</dt>
            <dd className="font-code text-xs break-all">{run.ledgerHash}</dd>
            {run.analyticsHash && (
              <>
                <dt className="text-muted-foreground">analyticsHash</dt>
                <dd className="font-code text-xs break-all">{run.analyticsHash}</dd>
              </>
            )}
            <dt className="text-muted-foreground">gitSha del motor</dt>
            <dd className="font-code text-xs break-all">{run.gitSha}</dd>
          </dl>
        </div>

        <div className="space-y-2 rounded-md border p-4">
          <h2 className="text-sm font-semibold tracking-tight">Motivos del sello</h2>
          {run.sealReasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ninguno: el informe pasó todos sus checks y ninguna variación superó los umbrales.
            </p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="run-seal-reasons">
              {run.sealReasons.map((reason, index) => (
                <li key={`${reason.code}-${index}`} data-seal-code={reason.code}>
                  <span className="font-code text-xs">{reason.code}</span>{" "}
                  <span className="text-xs text-muted-foreground">({reason.kind})</span>
                  <p className="text-muted-foreground">{reason.message}</p>
                  {reason.kpi && (
                    <p className="text-xs text-muted-foreground">
                      KPI {reason.kpi} · Δ {reason.deltaBps ?? "—"} pb sobre un límite de {reason.limitBps ?? "—"} pb
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">
          Comparativa con el informe anterior
          {run.comparativeBasis ? ` · base ${run.comparativeBasis}` : ""}
        </h2>
        {!diff || !diff.comparativeRunId ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            Sin comparativo: no hay un informe anterior del mismo tipo y los mismos parámetros con el que medir la
            variación. La columna se deja vacía, nunca a cero.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Comparado contra el run{" "}
              <Link href={`/reports/runs/${diff.comparativeRunId}`} className="font-code underline underline-offset-2">
                {diff.comparativeRunId.slice(0, 8)}
              </Link>
              .
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm" data-testid="run-diff">
                <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Línea</th>
                    <th className="px-3 py-2 text-right font-medium">Este informe</th>
                    <th className="px-3 py-2 text-right font-medium">Anterior</th>
                    <th className="px-3 py-2 text-right font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {diff.rows
                    .filter((row) => row.deltaCents !== 0)
                    .slice(0, 200)
                    .map((row) => (
                      <tr key={row.path} className="h-8">
                        <td className="px-3 py-1">{row.path}</td>
                        <td className="px-3 py-1 text-right">
                          <AmountPlain cents={row.currentCents} />
                        </td>
                        <td className="px-3 py-1 text-right">
                          <AmountPlain cents={row.previousCents} />
                        </td>
                        <td className="px-3 py-1 text-right">
                          <AmountPlain cents={row.deltaCents} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        <Link href="/reports/runs" className="underline underline-offset-2">
          Volver al histórico
        </Link>
      </p>
    </div>
  )
}
