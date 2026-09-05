import { pygAction } from "@/app/(app)/reports/actions"
import { fiscalYearContext, firstOf, runHeader, shiftOneYear } from "@/app/(app)/reports/shared"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportToolbar, type ToolbarField } from "@/components/reports/report-toolbar"
import { StatementTable, type StatementColumn, type StatementNode } from "@/components/reports/statement-table"
import { requireOrg } from "@/lib/authz"
import { PYG_SKELETON, type PygReport, type PygSubtotal } from "@/lib/ledger/reports/pyg"
import type { StatementRow } from "@/lib/ledger/reports/types"
import { todayLocalDate } from "@/models/ledger"
import type { ReportRunView } from "@/models/reports"
import { PgcVariant, Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Pérdidas y ganancias" }

/**
 * E6 · T16 — Cuenta de pérdidas y ganancias contable (§6 del diseño).
 *
 * Esqueleto oficial completo (los epígrafes a cero **se imprimen**: su ausencia
 * se leería como que no existen), subtotales **A.1–A.4** destacados y
 * calculados por número de epígrafe —no por rango de cuentas—, comparativo del
 * mismo periodo del ejercicio anterior y columna de peso sobre ingresos.
 *
 * `A.4 = I3` es el cuadre del informe y va al pie con tolerancia 0. El peso
 * sobre ingresos se expresa en puntos básicos ENTEROS calculados en el
 * servidor: sin INCN la celda queda vacía, nunca `0 %` ni `NaN` (G-05).
 */

const SUBTOTALS: readonly { key: PygSubtotal; label: string }[] = [
  { key: "A.1) RESULTADO DE EXPLOTACION", label: "A.1) RESULTADO DE EXPLOTACIÓN" },
  { key: "A.2) RESULTADO FINANCIERO", label: "A.2) RESULTADO FINANCIERO" },
  { key: "A.3) RESULTADO ANTES DE IMPUESTOS", label: "A.3) RESULTADO ANTES DE IMPUESTOS" },
  { key: "A.4) RESULTADO DEL EJERCICIO", label: "A.4) RESULTADO DEL EJERCICIO" },
]

export default async function PygPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org } = await requireOrg(Role.VIEWER)
  const params = await searchParams
  const first = (key: string) => firstOf(params, key)

  const { fiscalYears, selected, previous } = await fiscalYearContext(db, first("fiscalYearId"))
  const today = todayLocalDate()
  const from = first("desde") ?? selected?.startDate ?? `${today.slice(0, 4)}-01-01`
  const to = first("hasta") ?? selected?.endDate ?? `${today.slice(0, 4)}-12-31`
  const variant = first("modelo") === "PYMES" ? PgcVariant.PYMES : PgcVariant.GENERAL

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
    {
      kind: "select",
      name: "modelo",
      label: "Modelo",
      value: variant,
      options: [
        { value: PgcVariant.GENERAL, label: "Normal" },
        { value: PgcVariant.PYMES, label: "PYMES" },
      ],
    },
  ]

  const state = await pygAction({
    periodStart: from,
    periodEnd: to,
    ...(selected ? { fiscalYearId: selected.id } : {}),
    variant,
  })

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6">
        <div className="space-y-1 border-b pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">Pérdidas y ganancias</h1>
        </div>
        <ReportToolbar basePath="/reports/pyg" fields={toolbar} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
          No se ha podido emitir la cuenta de pérdidas y ganancias: {state.error ?? "error desconocido"}.
        </p>
      </div>
    )
  }

  const run: ReportRunView = state.data
  const report = run.result as unknown as PygReport

  // Comparativo: el MISMO periodo del ejercicio anterior (base por defecto,
  // `SAME_PERIOD_PREVIOUS_YEAR`). Sin ejercicio anterior no hay columna: vacía
  // con leyenda, jamás cero.
  let comparative: PygReport | null = null
  let comparativeLabel: string | null = null
  if (previous) {
    const previousState = await pygAction({
      periodStart: shiftOneYear(from),
      periodEnd: shiftOneYear(to),
      fiscalYearId: previous.id,
      variant,
    })
    if (previousState.success && previousState.data) {
      comparative = previousState.data.result as unknown as PygReport
      comparativeLabel = previous.code
    }
  }

  const incn = report.byEpigraphNumberCents["1"] ?? 0
  /** Peso sobre ingresos en puntos básicos enteros. Sin INCN, `null`. */
  const weight = (cents: number): number | null => (incn === 0 ? null : Math.round((cents * 10_000) / Math.abs(incn)))

  const detailByParent = new Map<string, StatementRow[]>()
  for (const row of report.lines) {
    if (row.depth < 2) continue
    const parent = row.path.slice(0, row.path.indexOf(" / "))
    const list = detailByParent.get(parent) ?? []
    list.push(row)
    detailByParent.set(parent, list)
  }
  const topByPath = new Map(report.lines.filter((r) => r.depth === 1).map((r) => [r.path, r]))
  const previousByNumber = comparative ? comparative.byEpigraphNumberCents : null

  const nodes: StatementNode[] = []
  const skeleton = PYG_SKELETON[variant]
  const blocks = SUBTOTALS.map((s) => s.key)
  const lastOfBlock: Record<string, number> = {
    "A.1) RESULTADO DE EXPLOTACION": variant === PgcVariant.PYMES ? 12 : 13,
    "A.2) RESULTADO FINANCIERO": variant === PgcVariant.PYMES ? 18 : 19,
    "A.3) RESULTADO ANTES DE IMPUESTOS": variant === PgcVariant.PYMES ? 18 : 19,
    "A.4) RESULTADO DEL EJERCICIO": variant === PgcVariant.PYMES ? 19 : 20,
  }

  for (const entry of skeleton) {
    const label = `${entry.n}. ${entry.name}`
    const top = topByPath.get(label)
    const cents = report.byEpigraphNumberCents[String(entry.n)] ?? 0
    const previousCents = previousByNumber ? (previousByNumber[String(entry.n)] ?? 0) : null
    nodes.push({
      id: `pyg:${entry.n}`,
      path: label,
      label,
      depth: 0,
      isAccount: false,
      accountCodes: top ? [...top.accountCodes] : [],
      values: {
        actual: cents,
        anterior: previousCents,
        delta: previousCents === null ? null : cents - previousCents,
        peso: weight(cents),
      },
      children: (detailByParent.get(label) ?? []).map((row) => ({
        id: `pyg:${row.path}`,
        path: row.path,
        label: row.label,
        depth: 1,
        isAccount: false,
        isContraCell: row.isContraCell,
        accountCodes: [...row.accountCodes],
        values: { actual: row.cents, anterior: null, delta: null, peso: weight(row.cents) },
      })),
    })

    // Subtotales oficiales, justo detrás del último epígrafe de su bloque.
    for (const subtotal of blocks) {
      if (lastOfBlock[subtotal] !== entry.n) continue
      const value = report.subtotalsCents[subtotal] ?? 0
      const before = comparative ? (comparative.subtotalsCents[subtotal] ?? 0) : null
      nodes.push({
        id: `pyg:${subtotal}`,
        path: subtotal,
        label: SUBTOTALS.find((s) => s.key === subtotal)?.label ?? subtotal,
        depth: 0,
        isAccount: false,
        isSubtotal: true,
        accountCodes: [],
        values: {
          actual: value,
          anterior: before,
          delta: before === null ? null : value - before,
          peso: weight(value),
        },
      })
    }
  }

  const columns: StatementColumn[] = [
    { key: "actual", header: `${from.slice(0, 4)} · ${from.split("-").reverse().join("/")}–${to.split("-").reverse().join("/")}` },
    { key: "anterior", header: comparativeLabel ?? "Ejercicio anterior" },
    { key: "delta", header: "Δ", emptyLabel: "—" },
    { key: "peso", header: "% s/ ingresos", kind: "bps", emptyLabel: "—" },
  ]

  const a4 = report.subtotalsCents["A.4) RESULTADO DEL EJERCICIO"] ?? 0
  const i3 = report.resultadoDelEjercicioCents

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Pérdidas y ganancias"
        description={`Modelo ${variant === PgcVariant.PYMES ? "PYMES" : "normal"}. Cuentas de los grupos 6 y 7 del periodo, excluidos apertura, regularización y cierre (definición única de I3). Ingresos en positivo, gastos en negativo (R-P1).`}
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación de la cuenta de pérdidas y ganancias"
        checksDescription="Invariantes del diario más I3 (A.4 = resultado del periodo), I-E6-3 (A.3 = resultado antes de impuestos) e I-E6-4 (A.1 + A.2 = A.3)."
        actions={<ExportLinks type="pyg" runId={run.id} />}
      />

      <ReportToolbar basePath="/reports/pyg" fields={toolbar} />

      <StatementTable
        testId="pyg-table"
        columns={columns}
        nodes={nodes}
        totalLabel="EBITDA (A.1 revirtiendo los epígrafes 8 y 11)"
        totalValues={{
          actual: report.ebitdaCents,
          anterior: comparative ? comparative.ebitdaCents : null,
          delta: comparative ? report.ebitdaCents - comparative.ebitdaCents : null,
          peso: weight(report.ebitdaCents),
        }}
        check={{
          label: "A.4) Resultado del ejercicio − resultado del periodo (I3)",
          differenceCents: a4 - i3,
          balanced: a4 - i3 === 0,
        }}
        mayorHref={`/ledger/mayor?from=${from}&to=${to}`}
        runInfo={{ runId: run.id, ledgerHash: run.ledgerHash, gitSha: run.gitSha, module: "lib/ledger/reports/pyg.ts" }}
      />

      {report.unmappedAccounts.length > 0 && (
        <p className="max-w-4xl rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs">
          Cuentas de los grupos 6/7 sin epígrafe en el plan y por tanto fuera del modelo:{" "}
          <span className="font-code">{report.unmappedAccounts.map((a) => a.code).join(", ")}</span>. Corrígelo en el
          plan de cuentas: mientras tanto, el modelo no las presenta.
        </p>
      )}
    </div>
  )
}
