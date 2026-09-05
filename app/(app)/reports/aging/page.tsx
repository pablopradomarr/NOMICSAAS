import { dashboardAction } from "@/app/(app)/dashboard/actions"
import { fiscalYearContext, firstOf, runHeader } from "@/app/(app)/reports/shared"
import { AmountPlain } from "@/components/ledger/amount"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportToolbar, type ToolbarField } from "@/components/reports/report-toolbar"
import type { AgingReport } from "@/lib/ledger/reports/aging"
import type { DashboardReport } from "@/lib/ledger/reports/dashboard"
import { todayLocalDate } from "@/models/ledger"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Antigüedad de saldos" }

/**
 * E6 · T16 — Antigüedad de la cartera de clientes y proveedores (§3.5, §8.8).
 *
 * Los tramos se miden **desde el vencimiento** de la línea (`dueDate`), no
 * desde la fecha del asiento, y la fecha de referencia es un **parámetro** que
 * entra en `paramsHash`: dos ejecuciones con el mismo diario y la misma fecha
 * dan exactamente el mismo aging.
 *
 * `SIN VENCIMIENTO` es un tramo **visible y el primero**: esconder las líneas
 * sin fecha de vencimiento las convertiría en cartera al día. Los cobros a
 * aplicar y los abonos van a `A APLICAR` y **no se compensan** con lo vencido.
 * El cuadre `Σ tramos = saldo de la cuenta a la fecha` (I-E6-14) va al pie.
 */
export default tenantPage<SearchParamsProps>(async ({ db, org, searchParams }) => {
  const params = await searchParams
  const first = (key: string) => firstOf(params, key)

  const { fiscalYears, selected } = await fiscalYearContext(db, first("fiscalYearId"))
  const today = todayLocalDate()
  const from = selected?.startDate ?? `${today.slice(0, 4)}-01-01`
  const to = selected?.endDate ?? `${today.slice(0, 4)}-12-31`
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
    {
      kind: "date",
      name: "refDate",
      label: "Fecha de referencia",
      value: refDate,
      hint: "Decide los tramos y entra en la clave del informe",
    },
  ]

  const state = await dashboardAction({
    periodStart: from,
    periodEnd: to,
    ...(selected ? { fiscalYearId: selected.id } : {}),
    refDate,
  })

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6">
        <div className="space-y-1 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Antigüedad de saldos</h1>
        </div>
        <ReportToolbar basePath="/reports/aging" fields={toolbar} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
          No se ha podido calcular la antigüedad: {state.error ?? "error desconocido"}.
        </p>
      </div>
    )
  }

  const run = state.data
  const report = run.result as unknown as DashboardReport
  const mayorHref = `/ledger/mayor?from=${from}&to=${to}`

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Antigüedad de saldos"
        description={`Cartera de clientes (43x) y de proveedores y acreedores (40x/41x) a ${refDate
          .split("-")
          .reverse()
          .join("/")}, por tramos desde el vencimiento.`}
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación de la antigüedad"
        checksDescription="I-E6-14 (Σ tramos = saldo de la cuenta a la fecha de referencia, tolerancia 0) e I-E6-15 (ninguna línea en dos tramos), más los invariantes del diario."
        actions={<ExportLinks type="dashboard" runId={run.id} />}
      />

      <ReportToolbar basePath="/reports/aging" fields={toolbar} />

      <div className="grid gap-6 xl:grid-cols-2">
        <AgingTable
          title="Clientes y deudores"
          testId="aging-clientes"
          report={report.aging.clientes}
          mayorHref={mayorHref}
        />
        <AgingTable
          title="Proveedores y acreedores"
          testId="aging-proveedores"
          report={report.aging.proveedores}
          mayorHref={mayorHref}
        />
      </div>

      <p className="max-w-4xl border-l-2 pl-3 text-xs text-muted-foreground" data-testid="aging-nota">
        {report.aging.clientes.groupingNote}
      </p>
    </div>
  )
}, { readOnly: false })

function AgingTable({
  title,
  testId,
  report,
  mayorHref,
}: {
  title: string
  testId: string
  report: AgingReport
  mayorHref: string
}) {
  const accounts = Object.entries(report.byAccountCents).sort(([a], [b]) => (a < b ? -1 : 1))
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid={testId}>
          <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Tramo</th>
              <th className="px-3 py-2 text-right font-medium">Líneas</th>
              <th className="px-3 py-2 text-right font-medium">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.rows.map((row) => (
              <tr key={row.bucket} className="h-8" data-bucket={row.bucket}>
                <td className="px-3 py-1">{row.label}</td>
                <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{row.lineCount}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={row.cents} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9">
              <td className="px-3 py-1" colSpan={2}>
                Total pendiente
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={report.totalCents} zeroAsDash={false} />
              </td>
            </tr>
            <tr className="h-9 border-t text-xs">
              <td className="px-3 py-1" colSpan={2}>
                <span className="text-muted-foreground">I-E6-14 · Σ tramos − saldo de las cuentas = </span>
                <span className="font-code" data-balance-difference={report.totalCents - report.checkTotalCents}>
                  {new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" })
                    .format((report.totalCents - report.checkTotalCents) / 100)
                    .replace("-", "−")}
                </span>
              </td>
              <td className="px-3 py-1 text-right">
                {report.totalCents === report.checkTotalCents ? (
                  <span aria-label="cuadra">✓</span>
                ) : (
                  <span className="text-[#F5A623]" aria-label="no cuadra">
                    ⚠
                  </span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {report.linesWithoutDueDate > 0 && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs">
          {report.linesWithoutDueDate} línea(s) sin fecha de vencimiento: aparecen en el tramo «sin vencimiento» y no se
          pueden clasificar por antigüedad hasta que se les ponga vencimiento.
        </p>
      )}
      {accounts.length > 0 && (
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer font-medium">Saldo por cuenta ({accounts.length})</summary>
          <ul className="grid gap-1 pt-2 sm:grid-cols-2">
            {accounts.map(([code, cents]) => (
              <li key={code} className="flex items-center justify-between gap-3">
                <Link href={`${mayorHref}&account=${code}`} className="font-code underline-offset-2 hover:underline">
                  {code}
                </Link>
                <AmountPlain cents={cents} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
