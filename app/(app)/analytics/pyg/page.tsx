import { analyticsHeader, buildMatrixView } from "@/app/(app)/analytics/shared"
import { accountNames, defaultPeriod } from "@/app/(app)/ledger/shared"
import { analyticPnlAction } from "@/app/(app)/analytics/actions"
import { MarginMatrix } from "@/components/analytics/margin-matrix"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportPeriodPicker } from "@/components/reports/report-period-picker"
import { Button } from "@/components/ui/button"
import { requireOrg } from "@/lib/authz"
import { listFiscalYears } from "@/models/fiscal-years"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "PyG analítica" }

/**
 * E4 · T14 — PyG analítica (`docs/design/E4-analitica.md` §6).
 *
 * Matriz `nivel de margen × columna`: proyectos agrupados bajo su línea de
 * negocio (con el subtotal de la línea marcado como **agregado que no suma al
 * total**), CECOs por `kind`, amortización/deterioro, financiero,
 * extraordinario, no analítico y TOTAL. Filas de % de margen en puntos básicos
 * enteros, marcadas `calculado`, y fila de cuadre
 * `Σ columnas (RESULTADO) − PyG contable = 0,00 €` (I4, tolerancia 0).
 *
 * Todas las cifras vienen de `analyticPnlAction` → `models/margins.ts` →
 * `lib/analytics/margins.ts` (puro), con su provenance por celda y los tres
 * sellos de E4-D2: `ledgerHash` (financiero, que la reclasificación NO mueve),
 * `analyticsHash` y `marginConfigHash`.
 */
export default async function AnalyticPnlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org } = await requireOrg(Role.VIEWER)
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
  const transposed = first("vista") === "transpuesta"

  const state = await analyticPnlAction({
    from,
    to,
    ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}),
  })

  const queryFor = (vista: string) => {
    const search = new URLSearchParams()
    if (selectedFy) search.set("fiscalYearId", selectedFy.id)
    search.set("from", from)
    search.set("to", to)
    if (vista) search.set("vista", vista)
    return `/analytics/pyg?${search.toString()}`
  }

  const picker = (
    <ReportPeriodPicker
      basePath="/analytics/pyg"
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

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6">
        <div className="space-y-1 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Pérdidas y ganancias analítica</h1>
        </div>
        {picker}
        <p
          className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
          role="alert"
          data-testid="analytics-error"
        >
          No se ha podido calcular la matriz: {state.error ?? "error desconocido"}. La matriz no se pinta a medias.
        </p>
      </div>
    )
  }

  const { pnl, config, ledgerHash, analyticsHash, marginConfigHash, checks, runId, gitSha } = state.data

  const header = analyticsHeader({
    from,
    to,
    baseCurrency: org.baseCurrency,
    runId,
    gitSha,
    ledgerHash,
    analyticsHash,
    marginConfigHash,
    checks,
    refDate,
    organizationId: org.id,
  })

  const view = buildMatrixView({ pnl, config, accountNames: await accountNames(db), transposed })
  const hasProjects = config.projects.length > 0

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Pérdidas y ganancias analítica"
        description="Resultado del periodo abierto por proyecto, por línea de negocio y por centro de coste, sin imputaciones (la liquidación de CECOs llega en E5). La suma de las columnas iguala la PyG contable al céntimo: es el invariante I4."
        header={header}
        extraHashes={[
          { label: "analyticsHash", value: analyticsHash },
          { label: "marginConfigHash", value: marginConfigHash },
        ]}
        checksTitle="Validación de la PyG analítica"
        checksDescription={
          <>
            I4 (Σ matriz = PyG contable, tolerancia 0) y los invariantes propios de la épica I-E4-1…12: cobertura de
            destino, exclusividad proyecto / centro de coste, denormalización de la línea de negocio, `NO_ANALITICO`
            sin dimensión y contra-asiento con dimensión espejo.
          </>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={queryFor(transposed ? "" : "transpuesta")} data-testid="toggle-transpose">
              {transposed ? "Ver niveles en filas" : "Ver proyectos en filas"}
            </Link>
          </Button>
        }
      />

      {picker}

      {!hasProjects && (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="analytics-empty">
          Aún no hay proyectos:{" "}
          <Link href="/analytics/projects" className="underline underline-offset-2">
            crea el primero
          </Link>{" "}
          para que la PyG analítica tenga columnas de proyecto. Mientras tanto la matriz sólo muestra los centros de
          coste y las columnas de compañía.
        </p>
      )}

      <MarginMatrix
        view={view}
        currency={org.baseCurrency}
        period={{ from, to, ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}) }}
      />

      <p className="text-xs text-muted-foreground">
        Las columnas de <strong>línea de negocio</strong> son agregados de presentación y no entran en el total. En una
        columna de proyecto, EBIT, el resultado antes de impuestos y el resultado del ejercicio se pintan en texto
        secundario: son lectura de compañía, no margen de proyecto. Pulsa cualquier cifra para ver su procedencia y las
        líneas del diario que la aportan.
      </p>
    </div>
  )
}
