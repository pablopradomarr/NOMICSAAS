import { cashflowAction } from "@/app/(app)/reports/actions"
import { fiscalYearContext, firstOf, runHeader } from "@/app/(app)/reports/shared"
import { AmountPlain } from "@/components/ledger/amount"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportToolbar, type ToolbarField } from "@/components/reports/report-toolbar"
import type {
  CashflowDirectReport,
  CashflowIndirectReport,
  EfeReport,
  IndirectBlock,
} from "@/lib/ledger/reports/cashflow"
import type { CashflowBucket } from "@/lib/ledger/reports/types"
import { cn } from "@/lib/utils"
import { todayLocalDate } from "@/models/ledger"
import type { ReportRunView } from "@/models/reports"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Cashflow" }

/**
 * E6 · T16 — Estado de flujos de efectivo (§6 del diseño).
 *
 * Tres vistas del MISMO run —el motor devuelve las tres a la vez para que no
 * puedan divergir—:
 *
 *  1. **Directo mensual** (por defecto): siete buckets × doce meses, con saldo
 *     inicial y final de 57x y la fila de conciliación **I6** a 0,00 €. Es la
 *     vista que un gerente entiende.
 *  2. **Indirecto**: partición mecánica y exhaustiva por bloques; `Σ bloques =
 *     Δ57x` por álgebra, sin partida de cuadre.
 *  3. **EFE oficial A–E**: la estructura de las cuentas anuales, marcada como
 *     **informe de gestión** — el EFE no es exigible en PYMES ni en abreviado.
 */

const BUCKET_LABELS: Record<CashflowBucket, string> = {
  COBROS_CLIENTES: "Cobros de clientes",
  PAGOS_PROVEEDORES: "Pagos a proveedores",
  PAGOS_PERSONAL: "Pagos de personal",
  PAGOS_IMPUESTOS: "Pagos de impuestos",
  OTROS_EXPLOTACION: "Otros de explotación",
  INVERSION: "Inversión",
  FINANCIACION: "Financiación",
}

const CATEGORY_LABELS: Record<string, string> = {
  OPERATING: "explotación",
  INVESTING: "inversión",
  FINANCING: "financiación",
}

const BLOCK_LABELS: Record<IndirectBlock, string> = {
  RESULTADO: "Resultado del periodo",
  AJUSTES_NO_MONETARIOS: "Ajustes que no suponen movimiento de efectivo",
  VAR_CIRCULANTE_EXISTENCIAS: "Variación de existencias",
  VAR_CIRCULANTE_DEUDORES: "Variación de deudores comerciales",
  VAR_CIRCULANTE_ACREEDORES: "Variación de acreedores comerciales",
  VAR_CIRCULANTE_ADMIN_PUBLICAS: "Variación con administraciones públicas",
  VAR_CIRCULANTE_PERIODIFICACIONES: "Variación de periodificaciones",
  VAR_CIRCULANTE_OTROS: "Otras variaciones del circulante",
  INVERSION: "Flujos de inversión",
  FINANCIACION: "Flujos de financiación",
}

const VIEWS = [
  { value: "directo", label: "Directo mensual" },
  { value: "indirecto", label: "Indirecto" },
  { value: "efe", label: "EFE oficial A–E" },
] as const

const MONTH_LABEL = (month: string): string => month.slice(5)

export default tenantPage<SearchParamsProps>(async ({ db, org, searchParams }) => {
  const params = await searchParams
  const first = (key: string) => firstOf(params, key)

  const { fiscalYears, selected } = await fiscalYearContext(db, first("fiscalYearId"))
  const today = todayLocalDate()
  const from = first("desde") ?? selected?.startDate ?? `${today.slice(0, 4)}-01-01`
  const to = first("hasta") ?? selected?.endDate ?? `${today.slice(0, 4)}-12-31`
  const view = (VIEWS.find((v) => v.value === first("vista"))?.value ?? "directo") as (typeof VIEWS)[number]["value"]

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
    { kind: "date", name: "desde", label: "Desde", value: from },
    { kind: "date", name: "hasta", label: "Hasta", value: to },
    { kind: "select", name: "vista", label: "Vista", value: view, options: [...VIEWS] },
  ]

  const state = await cashflowAction({
    periodStart: from,
    periodEnd: to,
    ...(selected ? { fiscalYearId: selected.id } : {}),
    method: "DIRECTO",
    granularity: "MENSUAL",
    view: view === "efe" ? "EFE_OFICIAL" : "GESTION",
  })

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6">
        <div className="space-y-1 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Cashflow</h1>
        </div>
        <ReportToolbar basePath="/reports/cashflow" fields={toolbar} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
          No se ha podido emitir el estado de flujos de efectivo: {state.error ?? "error desconocido"}.
        </p>
      </div>
    )
  }

  const run: ReportRunView = state.data
  const result = run.result as unknown as {
    directo: CashflowDirectReport
    indirecto: CashflowIndirectReport
    efe: EfeReport
  }
  const direct = result.directo
  const months = Object.keys(direct.monthlyCents).sort()

  const query = (vista: string) => {
    const search = new URLSearchParams()
    if (selected) search.set("fiscalYearId", selected.id)
    search.set("desde", from)
    search.set("hasta", to)
    search.set("vista", vista)
    return `/reports/cashflow?${search.toString()}`
  }

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Cashflow"
        description={direct.header}
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación del estado de flujos de efectivo"
        checksDescription="Invariantes del diario más I6: saldo inicial de 57x + flujos = saldo final, directo = indirecto y acumulado mensual = saldo de tesorería a fin de mes."
        actions={<ExportLinks type="cashflow" runId={run.id} />}
      />

      <ReportToolbar basePath="/reports/cashflow" fields={toolbar} />

      <nav className="flex gap-1 border-b" aria-label="Vistas del cashflow">
        {VIEWS.map((tab) => (
          <Link
            key={tab.value}
            href={query(tab.value)}
            data-testid={`cashflow-tab-${tab.value}`}
            aria-current={view === tab.value ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              view === tab.value
                ? "border-[#0A0A0A] font-medium text-[#0A0A0A]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {view === "directo" && <DirectView report={direct} months={months} />}
      {view === "indirecto" && <IndirectView report={result.indirecto} />}
      {view === "efe" && <EfeView report={result.efe} />}

      <p className="max-w-4xl border-l-2 pl-3 text-xs text-muted-foreground" data-testid="cashflow-nota">
        {direct.header}
      </p>
    </div>
  )
}, { readOnly: false })

function DirectView({ report, months }: { report: CashflowDirectReport; months: readonly string[] }) {
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="cashflow-directo">
          <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              {months.map((month) => (
                <th key={month} className="px-2 py-2 text-right font-medium">
                  {MONTH_LABEL(month)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Ejercicio</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="h-8 bg-muted/20 font-medium">
              <td className="px-3 py-1">Saldo inicial de tesorería (57x)</td>
              <td className="px-2 py-1 text-right" colSpan={months.length}>
                <span className="text-xs text-muted-foreground">al inicio del periodo</span>
              </td>
              <td className="px-3 py-1 text-right" data-testid="cashflow-opening">
                <AmountPlain cents={report.openingCashCents} zeroAsDash={false} />
              </td>
            </tr>
            {report.buckets.map((bucket) => (
              <tr key={bucket} className="h-8" data-bucket={bucket}>
                <td className="px-3 py-1">
                  {BUCKET_LABELS[bucket]}
                  <span className="pl-2 text-[11px] text-muted-foreground">
                    {CATEGORY_LABELS[report.bucketCategory[bucket]] ?? report.bucketCategory[bucket]}
                  </span>
                </td>
                {months.map((month) => (
                  <td key={month} className="px-2 py-1 text-right">
                    <AmountPlain cents={report.monthlyCents[month]?.[bucket] ?? 0} />
                  </td>
                ))}
                <td className="px-3 py-1 text-right font-medium">
                  <AmountPlain cents={report.annualCents[bucket] ?? 0} />
                </td>
              </tr>
            ))}
            <tr className="h-8 border-t-2 font-medium">
              <td className="px-3 py-1">Flujo neto del mes</td>
              {months.map((month) => (
                <td key={month} className="px-2 py-1 text-right">
                  <AmountPlain cents={report.monthlyTotalCents[month] ?? 0} />
                </td>
              ))}
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={report.totalFlowsCents} zeroAsDash={false} />
              </td>
            </tr>
            <tr className="h-8">
              <td className="px-3 py-1 text-muted-foreground">Tesorería acumulada a fin de mes</td>
              {months.map((month) => (
                <td key={month} className="px-2 py-1 text-right">
                  <AmountPlain cents={report.monthlyRunningCashCents[month] ?? 0} zeroAsDash={false} />
                </td>
              ))}
              <td className="px-3 py-1 text-right font-medium" data-testid="cashflow-closing">
                <AmountPlain cents={report.closingCashCents} zeroAsDash={false} />
              </td>
            </tr>
          </tbody>
          <tfoot className="border-t-2 bg-muted/30">
            <tr className="h-9" data-testid="cashflow-i6">
              <td className="px-3 py-1" colSpan={months.length + 1}>
                <span className="text-muted-foreground">
                  I6 · saldo inicial + Σ flujos − saldo final ={" "}
                </span>
                <span className="font-code" data-balance-difference={report.checkI6DirectCents}>
                  {new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" })
                    .format(report.checkI6DirectCents / 100)
                    .replace("-", "−")}
                </span>
              </td>
              <td className="px-3 py-1 text-right">
                {report.checkI6DirectCents === 0 ? (
                  <span className="text-[#0A0A0A]" aria-label="cuadra">
                    ✓
                  </span>
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

      {report.internalTransfers.length > 0 && (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer text-sm font-medium">
            Traspasos internos entre cuentas de tesorería ({report.internalTransfers.length})
          </summary>
          <p className="pt-2 text-xs text-muted-foreground">
            Excluidos del cuadro **porque las dos cuentas son 57x** (R-CF-4), no porque su neto sea cero. Asientos:{" "}
            <span className="font-code break-all">{report.internalTransfers.join(", ")}</span>
          </p>
        </details>
      )}

      {report.unbucketedAccounts.length > 0 && (
        <p className="max-w-4xl rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs">
          Cuentas con movimiento contra tesorería y sin bucket asignado en el plan:{" "}
          <span className="font-code">{report.unbucketedAccounts.map((a) => a.code).join(", ")}</span>.
        </p>
      )}
    </div>
  )
}

function IndirectView({ report }: { report: CashflowIndirectReport }) {
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="cashflow-indirecto">
          <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Bloque</th>
              <th className="px-3 py-2 text-right font-medium">Importe</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.blocks.map((block) => (
              <tr key={block} className="h-8" data-block={block}>
                <td className="px-3 py-1">{BLOCK_LABELS[block] ?? block}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={report.blockCents[block] ?? 0} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9">
              <td className="px-3 py-1">Σ bloques</td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={report.totalCents} zeroAsDash={false} />
              </td>
            </tr>
            <tr className="h-9 border-t">
              <td className="px-3 py-1">
                <span className="text-muted-foreground">Conciliación Δ57x · Σ bloques − (final − inicial) = </span>
                <span className="font-code" data-balance-difference={report.checkI6IndirectCents}>
                  {new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" })
                    .format(report.checkI6IndirectCents / 100)
                    .replace("-", "−")}
                </span>
              </td>
              <td className="px-3 py-1 text-right">
                {report.checkI6IndirectCents === 0 ? <span>✓</span> : <span className="text-[#F5A623]">⚠</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {report.nonCashEntries.length > 0 && (
        <details className="rounded-md border p-3 text-sm" data-testid="cashflow-non-cash">
          <summary className="cursor-pointer text-sm font-medium">
            Operaciones sin flujo de efectivo ({report.nonCashEntries.length})
          </summary>
          <p className="pt-2 text-xs text-muted-foreground">
            Asientos de inversión o financiación que no han pasado por el banco (R-CF-6). Sin esta nota, el lector ve
            una inversión que no cuadra con nada de lo que ha visto en tesorería. Asientos:{" "}
            <span className="font-code break-all">{report.nonCashEntries.join(", ")}</span>
          </p>
        </details>
      )}
    </div>
  )
}

function EfeView({ report }: { report: EfeReport }) {
  const rows: { label: string; cents: number; strong?: boolean; detail?: boolean }[] = [
    { label: "A) Flujos de efectivo de las actividades de explotación", cents: report.explotacionCents, strong: true },
    { label: "1. Resultado del ejercicio antes de impuestos", cents: report.explotacionDetalle.resultado, detail: true },
    { label: "2. Ajustes del resultado", cents: report.explotacionDetalle.ajustes, detail: true },
    { label: "3. Cambios en el capital corriente", cents: report.explotacionDetalle.capitalCorriente, detail: true },
    { label: "B) Flujos de efectivo de las actividades de inversión", cents: report.inversionCents, strong: true },
    { label: "C) Flujos de efectivo de las actividades de financiación", cents: report.financiacionCents, strong: true },
    { label: "D) Efecto de las variaciones de los tipos de cambio", cents: report.tipoCambioCents, strong: true },
    { label: "E) Aumento/disminución neta del efectivo", cents: report.deltaCashCents, strong: true },
    { label: "Efectivo al comienzo del ejercicio", cents: report.openingCashCents },
    { label: "Efectivo al final del ejercicio", cents: report.closingCashCents },
  ]
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid="cashflow-efe">
        <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Estado de flujos de efectivo</th>
            <th className="px-3 py-2 text-right font-medium">Importe</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.label} className={cn("h-8", row.strong && "bg-muted/20 font-medium")}>
              <td className={cn("px-3 py-1", row.detail && "pl-8 text-muted-foreground")}>{row.label}</td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={row.cents} zeroAsDash={false} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 bg-muted/30">
          <tr className="h-9">
            <td className="px-3 py-1">
              <span className="text-muted-foreground">A + B + C − E = </span>
              <span className="font-code" data-balance-difference={report.checkCents}>
                {new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", useGrouping: "always" })
                  .format(report.checkCents / 100)
                  .replace("-", "−")}
              </span>
            </td>
            <td className="px-3 py-1 text-right">
              {report.checkCents === 0 ? <span>✓</span> : <span className="text-[#F5A623]">⚠</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
