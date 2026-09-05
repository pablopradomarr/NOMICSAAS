import { dashboardAction } from "@/app/(app)/dashboard/actions"
import { fiscalYearContext, firstOf, runHeader } from "@/app/(app)/reports/shared"
import DashboardDropZoneWidget from "@/components/dashboard/drop-zone-widget"
import DashboardUnsortedWidget from "@/components/dashboard/unsorted-widget"
import { IncomeExpenseChart, SeriesTable, TreasuryChart } from "@/components/dashboard/series-charts"
import { Amount } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportToolbar, type ToolbarField } from "@/components/reports/report-toolbar"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import type { DashboardReport } from "@/lib/ledger/reports/dashboard"
import { getUnsortedFiles } from "@/models/files"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Panel",
  description: config.app.description,
}

/**
 * E6 · T18 — Panel, **reescrito sobre el libro diario** (cierra G-05 y G-06).
 *
 * El panel heredado de TaxHacker sumaba `Transaction.total` por moneda: sus
 * totales no cuadraban con el balance, pintaba `NaN` cuando no había base y
 * contaba como 0 los documentos sin contabilizar. Aquí **todas** las cifras
 * salen del mismo `ReportRun` sellado que los informes (`dashboardAction` →
 * `buildDashboard`), con el invariante I-E6-19 comprobando que ingresos,
 * resultado, tesorería y EBITDA coinciden con la PyG, el balance y la matriz
 * analítica. Los documentos sin asiento **se declaran** y no se suman a nada.
 *
 * Los agregados por moneda de `lib/stats.ts` (`UNPOSTED_TOTALS_NOTE`) NO se
 * usan aquí a propósito: ese módulo prohíbe expresamente su uso en el panel
 * porque son totales de documentos, no cifras contables. El aviso que
 * corresponde a este panel es el del propio informe (`unposted.note`), que
 * cuenta documentos sin decir que valgan cero.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org } = await requireOrg(Role.VIEWER)
  const params = await searchParams
  const first = (key: string) => firstOf(params, key)

  const { fiscalYears, selected } = await fiscalYearContext(db, first("fiscalYearId"))
  const today = todayLocalDate()
  const from = selected?.startDate ?? `${today.slice(0, 4)}-01-01`
  const periodEnd = selected?.endDate ?? `${today.slice(0, 4)}-12-31`
  const to = first("hasta") ?? periodEnd
  const refDate = first("refDate") ?? (to < today ? to : today)

  const toolbar: ToolbarField[] = [
    {
      kind: "select",
      name: "fiscalYearId",
      label: "Ejercicio",
      value: selected?.id ?? "",
      options: fiscalYears.map((fy) => ({
        value: fy.id,
        label: `${fy.code}${fy.status === "CLOSED" ? " (cerrado)" : ""}`,
      })),
    },
    { kind: "date", name: "hasta", label: "Hasta", value: to },
    { kind: "date", name: "refDate", label: "Antigüedad a", value: refDate },
  ]

  const state = await dashboardAction({
    periodStart: from,
    periodEnd: to,
    ...(selected ? { fiscalYearId: selected.id } : {}),
    refDate,
  })

  const unsortedFiles = await getUnsortedFiles(db)

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6 p-5">
        <div className="space-y-1 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Panel</h1>
        </div>
        <ReportToolbar basePath="/dashboard" fields={toolbar} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
          No se ha podido componer el panel: {state.error ?? "error desconocido"}. Antes que una cifra inventada, ninguna.
        </p>
      </div>
    )
  }

  const run = state.data
  const report = run.result as unknown as DashboardReport
  const module_ = "lib/ledger/reports/dashboard.ts"

  const tiles = [
    ...report.kpis.map((kpi) => ({
      key: kpi.key,
      label: kpi.label,
      cents: kpi.cents,
      metric: `dashboard.${kpi.key}`,
      hint:
        kpi.key === "ebitda"
          ? "A.1 revirtiendo los epígrafes 8 y 11"
          : kpi.key === "tesoreria"
            ? "Saldo de las cuentas 57x al cierre del periodo"
            : kpi.key === "ingresos"
              ? "Epígrafe 1 · importe neto de la cifra de negocios"
              : "A.4 de la cuenta de pérdidas y ganancias (= I3)",
      href: kpi.key === "tesoreria" ? "/reports/cashflow" : "/reports/pyg",
    })),
    {
      key: "pendiente-cobro",
      label: "Pendiente de cobro",
      cents: report.aging.clientes.totalCents,
      metric: "dashboard.aging.clientes",
      hint: `Saldo de clientes y deudores a ${refDate.split("-").reverse().join("/")}`,
      href: "/reports/aging",
    },
    {
      key: "pendiente-pago",
      label: "Pendiente de pago",
      cents: report.aging.proveedores.totalCents,
      metric: "dashboard.aging.proveedores",
      hint: `Saldo de proveedores y acreedores a ${refDate.split("-").reverse().join("/")}`,
      href: "/reports/aging",
    },
  ]

  return (
    <div className="flex w-full max-w-7xl flex-col gap-6 self-center p-5">
      <ReportHeader
        title="Panel"
        description="Todas las cifras se derivan del libro diario a través de un informe sellado: son las mismas que las del balance, la cuenta de pérdidas y ganancias y el cashflow del mismo periodo."
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación del panel"
        checksDescription="Invariantes del diario más I-E6-19 (el panel coincide con los informes), I-E6-14 e I-E6-15 (antigüedad de saldos)."
        actions={<ExportLinks type="dashboard" runId={run.id} />}
      />

      <ReportToolbar basePath="/dashboard" fields={toolbar} />

      {report.unposted && (
        <p
          className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm"
          role="status"
          data-testid="unposted-note"
        >
          {report.unposted.note}{" "}
          <Link href="/unsorted" className="underline underline-offset-2">
            Revisar documentos
          </Link>
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="dashboard-kpis">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={tile.href}
            data-kpi={tile.key}
            className="flex flex-col gap-2 rounded-md border p-4 hover:bg-muted/30"
          >
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{tile.label}</span>
            <Amount cents={tile.cents} currency={org.baseCurrency} zeroAsDash={false} className="text-2xl font-semibold" />
            <span className="text-xs text-muted-foreground">{tile.hint}</span>
            <span className="flex flex-wrap items-center gap-2">
              <ConfidenceBadge level="calculado" />
              <span className="font-code text-[10px] text-muted-foreground" title={`${module_} · ${run.ledgerHash}`}>
                {tile.metric} · {module_.split("/").pop()}@{shortHash(run.gitSha, 8)} · ledger{" "}
                {shortHash(run.ledgerHash, 8)}
              </span>
            </span>
          </Link>
        ))}
      </section>

      <section className="space-y-6 rounded-md border p-4">
        <IncomeExpenseChart points={report.monthly} />
        <TreasuryChart points={report.monthly} />
        <SeriesTable points={report.monthly} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <AgingSummary title="Antigüedad de clientes" report={report.aging.clientes} />
        <AgingSummary title="Antigüedad de proveedores" report={report.aging.proveedores} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Documentos</h2>
        <div className="flex h-full flex-col items-stretch gap-5 sm:flex-row">
          <DashboardDropZoneWidget />
          <DashboardUnsortedWidget files={unsortedFiles} />
        </div>
      </section>

      {report.notes.map((note) => (
        <p key={note} className="max-w-4xl border-l-2 pl-3 text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  )
}

function AgingSummary({ title, report }: { title: string; report: DashboardReport["aging"]["clientes"] }) {
  return (
    <div className="space-y-2 rounded-md border p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <Link href="/reports/aging" className="text-xs underline underline-offset-2">
          Ver detalle
        </Link>
      </div>
      <ul className="divide-y text-sm">
        {report.rows.map((row) => (
          <li key={row.bucket} className="flex items-center justify-between py-1" data-bucket={row.bucket}>
            <span className="text-muted-foreground">{row.label}</span>
            <Amount cents={row.cents} />
          </li>
        ))}
      </ul>
    </div>
  )
}
