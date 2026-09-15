import {
  budgetVsActualAction,
  previewBudgetVsActualAction,
} from "@/app/(app)/analytics/budget-vs-actual/actions"
import { columnLabel, compositionSummary, monthShort, sortColumns } from "@/app/(app)/analytics/budget-vs-actual/shared"
import { VarianceMatrix, type VarianceRow } from "@/app/(app)/analytics/budget-vs-actual/variance-matrix"
import { defaultPeriod } from "@/app/(app)/ledger/shared"
import { sealViewOf } from "@/app/(app)/reports/shared"
import { MARGIN_LEVEL_LABELS } from "@/components/analytics/types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { ReportPeriodPicker } from "@/components/reports/report-period-picker"
import { Button } from "@/components/ui/button"
import { SealBlock } from "@/components/ui/seal-badge"
import type { VarianceCell } from "@/lib/budget/variance"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { listBudgets } from "@/models/budget"
import { listFiscalYears } from "@/models/fiscal-years"
import { todayLocalDate } from "@/models/ledger"
import type { BudgetGranularity, BudgetVsActualView } from "@/models/reports"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Presupuesto vs real" }

const GRANULARITIES: { key: BudgetGranularity; label: string }[] = [
  { key: "MONTH", label: "Mes" },
  { key: "QUARTER", label: "Trimestre" },
  { key: "YEAR", label: "Año" },
  { key: "YTD", label: "Acumulado del año" },
]

/**
 * E10 · T16 — `/analytics/budget-vs-actual` (`docs/design/E10-presupuesto-horas.md`
 * §5.1 y §7).
 *
 * Es **la matriz de E4 con cinco columnas por celda**, no un informe nuevo:
 * presupuesto, real, desviación absoluta, desviación en puntos básicos y
 * forecast, con la misma retícula `nivel de margen × columna`, la misma
 * provenance y el mismo drill-down.
 *
 * Lo que esta pantalla tiene que decir en voz alta:
 *
 *  · **La procedencia del presupuesto mes a mes** (O-E10-9). Un año compuesto a
 *    medias sin decirlo es un año mal sumado.
 *  · **El toggle de imputaciones se bloquea con su motivo** cuando el
 *    presupuesto no puede seguir al real (O-E10-4): antes que una matriz mixta,
 *    ninguna.
 *  · **Un borrador no firma un informe** (O-E10-5). Se ve en previsualización,
 *    con la banda «borrador, no firmable», y **no se escribe ningún `ReportRun`**.
 *  · **Cinco avisos de método** (§7): el presupuesto es una decisión, no un
 *    cálculo; las bases de coste-hora no son comparables entre sí; las horas sin
 *    aprobar no reparten dinero; la tarifa ya absorbe las horas no productivas; y
 *    presupuesto y real se comparan en el mismo estado de imputación.
 *
 * Ni un céntimo se suma aquí: todo viene de `budgetVsActualAction`.
 */
export default tenantPage<SearchParamsProps>(
  async ({ db, org, searchParams }) => {
    const params = await searchParams
    const first = (key: string): string | undefined => {
      const value = params[key]
      return Array.isArray(value) ? value[0] : value
    }

    const refDate = todayLocalDate()
    const fiscalYearRows = await listFiscalYears(db)
    const selectedFy =
      fiscalYearRows.find((fy) => fy.id === first("fiscalYearId")) ??
      fiscalYearRows.find((fy) => fy.status === "OPEN") ??
      fiscalYearRows[0] ??
      null

    const period = defaultPeriod(
      selectedFy
        ? {
            startDate: selectedFy.startDate.toISOString().slice(0, 10),
            endDate: selectedFy.endDate.toISOString().slice(0, 10),
          }
        : null,
      refDate
    )
    const from = first("from") ?? period.from
    const to = first("to") ?? period.to
    const withAllocations = first("imputaciones") === "si"
    const granularity = (GRANULARITIES.find((g) => g.key === first("granularidad"))?.key ??
      "YEAR") as BudgetGranularity
    const budgetId = first("presupuesto")

    const picker = (
      <ReportPeriodPicker
        basePath="/analytics/budget-vs-actual"
        fiscalYears={fiscalYearRows.map((fy) => ({
          id: fy.id,
          code: fy.code,
          startDate: fy.startDate.toISOString().slice(0, 10),
          endDate: fy.endDate.toISOString().slice(0, 10),
          status: fy.status,
        }))}
        selectedFiscalYearId={selectedFy?.id ?? ""}
        from={from}
        to={to}
      />
    )

    if (!selectedFy) {
      return (
        <Shell picker={null}>
          <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="budget-vs-actual-empty">
            Todavía no hay ningún ejercicio abierto. Créalo en{" "}
            <Link href="/settings/fiscal-years" className="underline underline-offset-2">
              Configuración → Ejercicios
            </Link>{" "}
            y carga después el presupuesto: sin ejercicio no hay periodo que comparar.
          </p>
        </Shell>
      )
    }

    const budgets = await listBudgets(db, { fiscalYearId: selectedFy.id })
    const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: to }))

    const request = {
      fiscalYearId: selectedFy.id,
      periodStart: from,
      periodEnd: to,
      granularity,
      withAllocations,
      ...(budgetId ? { budgetId } : {}),
    }

    // Informe SELLADO primero. Si la versión elegida (o la efectiva) es un
    // BORRADOR, el modelo responde `BUDGET_NOT_SEALED` y **no escribe ninguna
    // fila**: se cae a la previsualización, que es un dry-run puro (O-E10-5).
    const sealedState = await budgetVsActualAction(request)
    const previewState = sealedState.success ? null : await previewBudgetVsActualAction(request)
    const view: BudgetVsActualView | null = sealedState.success
      ? (sealedState.data ?? null)
      : previewState?.success
        ? (previewState.data ?? null)
        : null

    if (!view) {
      return (
        <Shell picker={picker}>
          <p
            className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
            role="alert"
            data-testid="budget-vs-actual-error"
          >
            No se ha podido componer el informe: {previewState?.error ?? sealedState.error ?? "error desconocido"}. La
            matriz no se pinta a medias.
          </p>
          <VersionPicker budgets={budgets} selected={budgetId ?? null} query={{ from, to, fiscalYearId: selectedFy.id }} />
        </Shell>
      )
    }

    const result = view.result
    const cells = result.variance as readonly VarianceCell[]
    const rows: VarianceRow[] = cells.map((c) => ({
      level: c.level,
      column: c.column,
      actualCents: c.actualCents,
      budgetCents: c.budgetCents,
      varianceCents: c.varianceCents,
      varianceBps: c.varianceBps,
      forecastCents: c.forecastCents,
      notComparable: c.notComparable,
    }))
    const columns = [...new Set(rows.map((r) => r.column))]
      .map((key) => columnLabel(key, config))
      .sort(sortColumns)

    const composition = compositionSummary(result.budgetComposition)
    const effectiveBudgetId =
      budgetId ??
      budgets.find((b) => b.budgetHash !== null && b.status === "VIGENTE")?.id ??
      budgets.at(-1)?.id ??
      null

    const forecast = result.forecast as
      | { levelTotalsCents?: Record<string, number>; provenanceByMonth?: Record<string, string> }
      | null

    const query = (overrides: Record<string, string>): string => {
      const search = new URLSearchParams()
      search.set("fiscalYearId", selectedFy.id)
      search.set("from", from)
      search.set("to", to)
      if (granularity !== "YEAR") search.set("granularidad", granularity)
      if (withAllocations) search.set("imputaciones", "si")
      if (budgetId) search.set("presupuesto", budgetId)
      for (const [key, value] of Object.entries(overrides)) {
        if (value === "") search.delete(key)
        else search.set(key, value)
      }
      return `/analytics/budget-vs-actual?${search.toString()}`
    }

    // El toggle se BLOQUEA, con el motivo, en vez de producir una matriz mixta.
    const toggleBlocked = withAllocations && result.notSettleableReason !== null

    return (
      <Shell picker={picker}>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Periodo {formatLocalDate(from)} – {formatLocalDate(to)} · moneda base {org.baseCurrency} ·{" "}
              {GRANULARITIES.find((g) => g.key === result.granularity)?.label ?? result.granularity}
            </p>
            <p className="font-code text-xs text-muted-foreground" data-testid="budget-vs-actual-hashes">
              run_id {view.runId ? shortHash(view.runId, 12) : "sin sellar"} · budgetHash{" "}
              {shortHash(view.budgetHash, 16)}
              {view.budgetRulesHash && <> · budgetRulesHash {shortHash(view.budgetRulesHash, 16)}</>} · origen{" "}
              {view.origen}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="budget-composition">
              Procedencia del presupuesto:{" "}
              {composition.length === 0
                ? "sin versión efectiva en el periodo"
                : composition
                    .map((g) => `${monthShort(g.months[0])}–${monthShort(g.months[g.months.length - 1])}: ${g.code}`)
                    .join(" · ")}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <SealBlock seal={sealViewOf({ seal: view.seal, sealReasons: [...view.sealReasons] })} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button asChild variant={withAllocations ? "default" : "outline"} size="sm">
                <Link
                  href={query({ imputaciones: withAllocations ? "" : "si" })}
                  data-testid="toggle-allocations"
                  data-allocations={withAllocations ? "si" : "no"}
                >
                  {withAllocations ? "Ver sin imputaciones" : "Ver con imputaciones"}
                </Link>
              </Button>
              {view.runId && (
                <>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/analytics/budget-vs-actual/export?runId=${view.runId}&format=csv`}
                      data-testid="export-csv"
                      prefetch={false}
                    >
                      CSV
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/analytics/budget-vs-actual/export?runId=${view.runId}&format=xlsx`}
                      data-testid="export-xlsx"
                      prefetch={false}
                    >
                      XLSX
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`/analytics/budget-vs-actual/export?runId=${view.runId}&format=pdf`}
                      data-testid="export-pdf"
                      prefetch={false}
                    >
                      PDF
                    </Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {!view.sealed && (
          <p
            className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm"
            role="status"
            data-testid="preview-banner"
          >
            <strong>Borrador, no firmable.</strong> Esta comparación es una previsualización contra una versión en
            borrador: no se ha emitido ningún informe y no hay nada que exportar. Un presupuesto sin sellar no puede
            firmar un informe.
          </p>
        )}

        {toggleBlocked && (
          <p
            className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm"
            role="alert"
            data-testid="toggle-blocked"
          >
            <strong>Comparación con imputaciones bloqueada:</strong> {result.notSettleableReason}. Las celdas por
            dimensión de MC3 en adelante salen <em>no publicadas</em> en vez de calculadas: nunca se compara una
            magnitud imputada con otra que no lo está.{" "}
            <Link href={query({ imputaciones: "" })} className="underline underline-offset-2">
              Ver sin imputaciones
            </Link>
            .
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Granularidad:</span>
          {GRANULARITIES.map((g) => (
            <Button key={g.key} asChild variant={granularity === g.key ? "default" : "outline"} size="sm">
              <Link href={query({ granularidad: g.key })} data-testid={`granularity-${g.key}`}>
                {g.label}
              </Link>
            </Button>
          ))}
        </div>

        <VersionPicker budgets={budgets} selected={budgetId ?? null} query={{ from, to, fiscalYearId: selectedFy.id }} />

        {result.monthsWithoutBudget.length > 0 && (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="months-without-budget">
            Sin versión vigente en {result.monthsWithoutBudget.join(", ")}: esos meses no aportan presupuesto y sus
            columnas derivadas salen vacías, nunca a cero.
          </p>
        )}
        {result.openMonths.length > 0 && (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="open-months">
            Meses no cerrados en el periodo: {result.openMonths.join(", ")}. La desviación es <strong>parcial por
            construcción</strong>; lo que informa ahí es el forecast.
          </p>
        )}

        <VarianceMatrix
          rows={rows}
          columns={columns}
          period={{ from, to, fiscalYearId: selectedFy.id }}
          budgetId={effectiveBudgetId}
          withAllocations={withAllocations}
          notSettleableReason={result.notSettleableReason}
          currency={org.baseCurrency}
        />

        {forecast?.levelTotalsCents && (
          <section className="space-y-2" data-testid="forecast-block">
            <h2 className="text-sm font-semibold tracking-tight">
              Reproyección del ejercicio · corte en {view.forecastCutoff ?? "sin mes cerrado"}
            </h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Nivel</th>
                    <th className="px-3 py-2 text-right font-medium">Forecast del ejercicio</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(forecast.levelTotalsCents).map(([level, cents]) => (
                    <tr key={level} className="h-8" data-forecast-level={level}>
                      <td className="px-3 py-1">{MARGIN_LEVEL_LABELS[level] ?? level}</td>
                      <td className="px-3 py-1 text-right">
                        <AmountPlain cents={cents} zeroAsDash={false} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Cada mes aparece exactamente una vez y con una sola procedencia (I-E10-7): real hasta el corte,
              presupuesto desde el corte.{" "}
              {forecast.provenanceByMonth
                ? Object.entries(forecast.provenanceByMonth)
                    .map(([month, source]) => `${monthShort(month)} ${source === "REAL_CERRADO" ? "real" : "ppto"}`)
                    .join(" · ")
                : null}
            </p>
          </section>
        )}

        <MethodNotes />
      </Shell>
    )
  },
  // El informe sellado emite un `ReportRun`: la transacción de la página no
  // puede ser de sólo lectura (mismo caso que los informes de E6).
  { readOnly: false }
)

function Shell({ picker, children }: { picker: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Presupuesto vs real</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          La matriz analítica con cinco columnas por celda: presupuesto, real, desviación absoluta, desviación en
          porcentaje y reproyección. Mismas funciones que la PyG analítica, misma provenance y mismo drill-down hasta el
          asiento.
        </p>
      </div>
      {picker}
      {children}
    </div>
  )
}

function VersionPicker({
  budgets,
  selected,
  query,
}: {
  budgets: readonly { id: string; label: string; status: string; validFrom: string; validTo: string | null; partialFrom: string | null; budgetHash: string | null }[]
  selected: string | null
  query: { from: string; to: string; fiscalYearId: string }
}) {
  if (budgets.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="no-budget-versions">
        El ejercicio no tiene ninguna versión de presupuesto.{" "}
        <Link href="/analytics/budget" className="underline underline-offset-2">
          Crear la BASE del ejercicio
        </Link>
        .
      </p>
    )
  }
  const href = (id: string): string => {
    const search = new URLSearchParams({ fiscalYearId: query.fiscalYearId, from: query.from, to: query.to })
    if (id) search.set("presupuesto", id)
    return `/analytics/budget-vs-actual?${search.toString()}`
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="budget-versions">
      <span className="text-muted-foreground">Versión:</span>
      <Button asChild variant={selected === null ? "default" : "outline"} size="sm">
        <Link href={href("")}>Efectiva (compuesta)</Link>
      </Button>
      {budgets.map((b) => (
        <Button key={b.id} asChild variant={selected === b.id ? "default" : "outline"} size="sm">
          <Link href={href(b.id)} data-budget-status={b.status} data-testid={`budget-version-${b.label}`}>
            <span className="font-code">{b.label}</span>
            <span className="ml-1 text-[11px] text-muted-foreground">
              {b.status === "BORRADOR" ? "borrador" : b.budgetHash ? "sellada" : b.status.toLowerCase()}
              {b.partialFrom ? ` · parcial desde ${b.partialFrom.slice(0, 7)}` : ""}
            </span>
          </Link>
        </Button>
      ))}
    </div>
  )
}

/** Los cinco avisos de método de §7, impresos en pantalla y no en un manual. */
function MethodNotes() {
  return (
    <ul className="space-y-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="method-notes">
      <li>
        <strong>El presupuesto es una decisión, no un cálculo:</strong> una desviación mide el plan tanto como la
        ejecución.
      </li>
      <li>
        <strong>Un coste-hora «con SS» y otro «sin SS» no son comparables</strong> (≈ 31,9 % de diferencia): la base
        viaja con la cifra y se enseña siempre a su lado.
      </li>
      <li>
        <strong>Las horas sin aprobar no reparten dinero</strong> y no aparecen en ningún margen; su recuento y su peso
        están en <Link href="/time" className="underline underline-offset-2">Horas</Link>.
      </li>
      <li>
        <strong>La tarifa ya absorbe las horas no productivas</strong>, así que ese coste no se reparte otra vez.
      </li>
      <li>
        <strong>Presupuesto y real se comparan en el mismo estado de imputación</strong>; cuando no puede ser, la celda
        se deja en blanco con su motivo.
      </li>
      <li>
        Las filas EBIT, resultado antes de impuestos y resultado del ejercicio de una columna de proyecto{" "}
        <strong>no son márgenes de proyecto</strong>: son lectura de compañía.
      </li>
    </ul>
  )
}
