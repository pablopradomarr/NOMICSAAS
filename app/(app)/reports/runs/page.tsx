import { listReviewFlagsAction, listRunsAction } from "@/app/(app)/reports/actions"
import { firstOf, sealViewOf } from "@/app/(app)/reports/shared"
import { formatLocalDate } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { ExportLinks } from "@/components/reports/export-links"
import { ClearReviewDialog, ForceReviewDialog } from "@/components/reports/manual-review"
import { SealBadge } from "@/components/ui/seal-badge"
import { todayLocalDate } from "@/models/ledger"
import { ReportType, Role, Seal } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Histórico de informes" }

/**
 * E6 · T17 — Histórico de `ReportRun` (§6 del diseño).
 *
 * Cada fila es un informe **emitido**: tipo, periodo, sello con sus motivos
 * etiquetados por código, `gitSha` del motor y `ledgerHash` del diario con el
 * que se calculó. La tabla es append-only en la base: un run no se edita ni se
 * borra, así que esta lista es la traza de qué se afirmó y cuándo.
 *
 * Los avisos de revisión manual (`ManualReviewFlag`) van arriba, con «Forzar
 * revisión» y «Levantar» sólo para ADMIN.
 */

const TYPE_LABELS: Partial<Record<ReportType, string>> = {
  BALANCE: "Balance de situación",
  PYG: "Pérdidas y ganancias",
  PYG_ANALITICA: "PyG analítica",
  // E7 · ADR-0015 D4: un solo tipo; el método va en `params`. Los dos viejos se
  // conservan en la tabla de etiquetas para que un run histórico siga teniendo
  // nombre en la lista.
  CASHFLOW: "Cashflow",
  CASHFLOW_DIRECTO: "Cashflow directo (histórico)",
  CASHFLOW_INDIRECTO: "Cashflow indirecto (histórico)",
  DASHBOARD: "Panel",
  DIARIO: "Libro diario",
  MAYOR: "Mayor",
  SUMAS_SALDOS: "Sumas y saldos",
  PRESUPUESTO_REAL: "Presupuesto vs real",
}

export default tenantPage<SearchParamsProps>(async ({ role, searchParams }) => {
  const isAdmin = role === Role.ADMIN
  const params = await searchParams
  const typeFilter = firstOf(params, "tipo")
  const sealFilter = firstOf(params, "sello")

  // En SERIE: la transacción de la petición tiene UNA conexión (lib/page-tenant.ts).
  const runsState = await listRunsAction({
    ...(typeFilter && typeFilter in ReportType ? { type: typeFilter as ReportType } : {}),
    ...(sealFilter === Seal.REQUIERE_REVISION || sealFilter === Seal.VALIDADO_AUTOMATICAMENTE
      ? { seal: sealFilter as Seal }
      : {}),
    take: 100,
  })
  const flagsState = await listReviewFlagsAction(false)

  const runs = runsState.success ? (runsState.data ?? []) : []
  const flags = flagsState.success ? (flagsState.data ?? []) : []
  const today = todayLocalDate()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Histórico de informes</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Todos los informes emitidos por esta organización, con su sello, los motivos del sello y los hashes con los
            que se calcularon. La tabla es inmutable: un informe emitido no se edita ni se borra.
          </p>
        </div>
        {isAdmin && (
          <ForceReviewDialog
            defaultPeriodStart={`${today.slice(0, 4)}-01-01`}
            defaultPeriodEnd={`${today.slice(0, 4)}-12-31`}
          />
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Avisos de revisión manual</h2>
        {flags.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            Ningún periodo bajo revisión forzada.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="review-flags">
              <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Periodo</th>
                  <th className="px-3 py-2 text-left font-medium">Alcance</th>
                  <th className="px-3 py-2 text-left font-medium">Motivo</th>
                  <th className="px-3 py-2 text-left font-medium">Estado</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {flags.map((flag) => {
                  const periodLabel = `${flag.periodStart.toISOString().slice(0, 10)} – ${flag.periodEnd
                    .toISOString()
                    .slice(0, 10)}`
                  return (
                    <tr key={flag.id} className="h-9" data-flag-id={flag.id}>
                      <td className="px-3 py-1">{periodLabel}</td>
                      <td className="px-3 py-1 text-muted-foreground">
                        {flag.scope ? (TYPE_LABELS[flag.scope] ?? flag.scope) : "Todos los informes"}
                      </td>
                      <td className="max-w-md truncate px-3 py-1">{flag.reason}</td>
                      <td className="px-3 py-1">
                        {flag.clearedAt ? (
                          <span className="text-xs text-muted-foreground">
                            levantado el {formatLocalDate(flag.clearedAt.toISOString().slice(0, 10))}
                          </span>
                        ) : (
                          <span className="text-xs font-medium text-[#1A202C]">activo</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right">
                        {isAdmin && !flag.clearedAt && <ClearReviewDialog flagId={flag.id} periodLabel={periodLabel} />}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Informes emitidos</h2>
        {runs.length === 0 ? (
          <p className="rounded-md border p-6 text-sm text-muted-foreground">
            Todavía no se ha emitido ningún informe. Abre el balance, la cuenta de pérdidas y ganancias o el cashflow y
            aparecerán aquí.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="runs-table">
              <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Emitido</th>
                  <th className="px-3 py-2 text-left font-medium">Informe</th>
                  <th className="px-3 py-2 text-left font-medium">Periodo</th>
                  <th className="px-3 py-2 text-left font-medium">Sello</th>
                  <th className="px-3 py-2 text-left font-medium">Hashes</th>
                  <th className="px-3 py-2 text-left font-medium">Exportar</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {runs.map((run) => (
                  <tr key={run.id} className="h-9 align-top" data-run-id={run.id} data-run-type={run.type}>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {run.createdAt.toLocaleString("es-ES")}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/reports/runs/${run.id}`} className="underline-offset-2 hover:underline">
                        {TYPE_LABELS[run.type] ?? run.type}
                      </Link>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatLocalDate(run.periodStart)} – {formatLocalDate(run.periodEnd)}
                    </td>
                    <td className="px-3 py-2">
                      <SealBadge seal={sealViewOf(run)} />
                      {run.sealReasons.length > 0 && (
                        <ul className="pt-1 text-[11px] text-muted-foreground">
                          {run.sealReasons.map((reason, index) => (
                            <li key={`${reason.code}-${index}`} data-seal-code={reason.code}>
                              <span className="font-code">{reason.code}</span> · {reason.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="font-code px-3 py-2 text-[11px] whitespace-nowrap text-muted-foreground">
                      ledger {shortHash(run.ledgerHash, 12)}
                      <br />
                      motor {shortHash(run.gitSha, 8)}
                    </td>
                    <td className="px-3 py-2">
                      <ExportLinks type={run.type} runId={run.id} />
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
