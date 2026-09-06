import { analyticsHeader, buildMatrixView } from "@/app/(app)/analytics/shared"
import { accountNames, defaultPeriod } from "@/app/(app)/ledger/shared"
import { analyticPnlAction } from "@/app/(app)/analytics/actions"
import { AmountPlain } from "@/components/ledger/amount"
import { MarginMatrix } from "@/components/analytics/margin-matrix"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportPeriodPicker } from "@/components/reports/report-period-picker"
import { Button } from "@/components/ui/button"
import { listFiscalYears } from "@/models/fiscal-years"
import { todayLocalDate } from "@/models/ledger"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"

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
export default tenantPage<SearchParamsProps>(async ({ db, org, searchParams }) => {
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
  /** E5 · T13 — el toggle vive en la URL: es compartible y entra en el paramsHash. */
  const withAllocations = first("imputaciones") === "si"

  // Con y sin imputaciones son el MISMO informe con un parámetro más: una sola
  // acción, un solo camino de composición del `analyticsHash`.
  const state = await analyticPnlAction({
    from,
    to,
    ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}),
    withAllocations,
  })

  const queryFor = (overrides: { vista?: string; imputaciones?: string }) => {
    const search = new URLSearchParams()
    if (selectedFy) search.set("fiscalYearId", selectedFy.id)
    search.set("from", from)
    search.set("to", to)
    const vista = overrides.vista ?? (transposed ? "transpuesta" : "")
    if (vista) search.set("vista", vista)
    const imputaciones = overrides.imputaciones ?? (withAllocations ? "si" : "")
    if (imputaciones) search.set("imputaciones", imputaciones)
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
  const allocationRunSetHash =
    "allocationRunSetHash" in state.data ? (state.data.allocationRunSetHash as string) : null

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

  const view = buildMatrixView({ pnl, config, accountNames: await accountNames(db), transposed, withAllocations })
  const hasProjects = config.projects.length > 0
  const pending = pnl.costCenterSettlement.filter((row) => row.pendingCents !== 0)
  const pendingTotal = pending.reduce((acc, row) => acc + row.pendingCents, 0)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Pérdidas y ganancias analítica"
        description={
          withAllocations
            ? "Resultado del periodo con las liquidaciones de centros de coste vigentes ya imputadas: los centros imputables quedan a cero y su estructura baja al MC3 y al EBITDA de cada proyecto y línea de negocio. La suma de las columnas sigue igualando la PyG contable al céntimo (I4): imputar es un traspaso de suma cero en cada nivel."
            : "Resultado del periodo abierto por proyecto, por línea de negocio y por centro de coste, sin imputaciones: el MC3 de un proyecto no incluye estructura. La suma de las columnas iguala la PyG contable al céntimo: es el invariante I4."
        }
        header={header}
        extraHashes={[
          { label: "analyticsHash", value: analyticsHash },
          { label: "marginConfigHash", value: marginConfigHash },
          ...(allocationRunSetHash
            ? [{ label: "allocationRunSetHash", value: allocationRunSetHash }]
            : []),
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
          <>
            <Button asChild variant={withAllocations ? "default" : "outline"} size="sm">
              <Link
                href={queryFor({ imputaciones: withAllocations ? "" : "si" })}
                data-testid="toggle-allocations"
                data-allocations={withAllocations ? "si" : "no"}
              >
                {withAllocations ? "Ver sin imputaciones" : "Ver con imputaciones"}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={queryFor({ vista: transposed ? "" : "transpuesta" })} data-testid="toggle-transpose">
                {transposed ? "Ver niveles en filas" : "Ver proyectos en filas"}
              </Link>
            </Button>
          </>
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
        withAllocations={withAllocations}
      />

      {withAllocations && (
        <section className="space-y-2 rounded-md border p-3" data-testid="pending-settlement">
          <h2 className="text-sm font-semibold tracking-tight">
            Pendiente de liquidar: <AmountPlain cents={pendingTotal} zeroAsDash={false} /> {org.baseCurrency}
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todos los centros de coste imputables han absorbido su saldo en este periodo: sus columnas quedan a cero.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {pending.map((row) => (
                <li key={`${row.costCenterCode}|${row.marginLevel}`} data-pending-ceco={row.costCenterCode}>
                  <span className="font-code text-xs">{row.costCenterCode}</span> · {row.marginLevel} ·{" "}
                  <AmountPlain cents={row.pendingCents} zeroAsDash={false} /> ·{" "}
                  <span className="text-muted-foreground">
                    {row.reason === "ANNUAL_RULE_NOT_DUE"
                      ? "la regla que lo reparte es de periodicidad mayor que este informe: se liquidará al cierre de su periodo"
                      : row.reason === "ZERO_BASE_SKIP"
                        ? "la base del driver fue cero y la regla está configurada para no repartir"
                        : "ninguna regla vigente reparte este saldo"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Este importe <strong>no se prorratea</strong>: repartir una regla anual entre los meses del informe
            inventaría un devengo que la regla no declara.{" "}
            <Link href="/analytics/allocations/runs" className="underline underline-offset-2" data-testid="pending-runs-link">
              Ver las liquidaciones del periodo
            </Link>
            .
          </p>
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Las columnas de <strong>línea de negocio</strong> son agregados de presentación y no entran en el total. En una
        columna de proyecto, EBIT, el resultado antes de impuestos y el resultado del ejercicio se pintan en texto
        secundario: son lectura de compañía, no margen de proyecto. Pulsa cualquier cifra para ver su procedencia y las
        líneas del diario que la aportan.
      </p>
    </div>
  )
}, { readOnly: false })
