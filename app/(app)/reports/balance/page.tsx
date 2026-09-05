import { balanceAction } from "@/app/(app)/reports/actions"
import {
  accountsByEpigraph,
  centsByAccount,
  centsByPath,
  comparativeCutoff,
  fiscalYearContext,
  firstOf,
  runHeader,
  statementNodes,
} from "@/app/(app)/reports/shared"
import { ExportLinks } from "@/components/reports/export-links"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportToolbar, type ToolbarField } from "@/components/reports/report-toolbar"
import { StatementTable, type StatementColumn } from "@/components/reports/statement-table"
import { requireOrg } from "@/lib/authz"
import type { BalanceReport } from "@/lib/ledger/reports/balance"
import type { BalanceSnapshot } from "@/lib/ledger/reports/types"
import { todayLocalDate } from "@/models/ledger"
import type { ReportRunView } from "@/models/reports"
import { PgcVariant, Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Balance de situación" }

/**
 * E6 · T16 — Balance de situación (`docs/design/E6-informes.md` §6).
 *
 * Selector de ejercicio y **fecha de corte**, de modelo (NORMAL / PYMES) y de
 * **foto** (antes de la regularización, regularizado, después del cierre);
 * árbol de epígrafes colapsable hasta la cuenta, con la marca `(−)` en las
 * correctoras (R-B3: la contra-cuenta NO se resta dos veces, sólo se señala);
 * columna comparativa a la misma fecha del ejercicio anterior —vacía con
 * leyenda si no hay ejercicio anterior, jamás a cero (§8.7)—; fila de cuadre
 * `Activo − (Pasivo + PN) = 0,00 €` (I2, tolerancia 0) y **nota al pie de no
 * compensación** de `473`/`4752`, que viaja dentro del propio informe.
 *
 * Ninguna cifra se calcula aquí: todas salen del `ReportRun` sellado que emite
 * `balanceAction`. La única resta de la pantalla es la columna Δ, que compara
 * dos informes sellados y se etiqueta como tal.
 */

const SNAPSHOTS: { value: BalanceSnapshot; label: string }[] = [
  { value: "PRE_REGULARIZACION", label: "Antes de la regularización" },
  { value: "POST_REGULARIZACION", label: "Regularizado (balance formulado)" },
  { value: "POST_CIERRE", label: "Después del cierre" },
]

export default async function BalancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org } = await requireOrg(Role.VIEWER)
  const params = await searchParams
  const first = (key: string) => firstOf(params, key)

  const { fiscalYears, selected, previous } = await fiscalYearContext(db, first("fiscalYearId"))
  const today = todayLocalDate()
  const from = selected?.startDate ?? `${today.slice(0, 4)}-01-01`
  const defaultCutoff = selected?.endDate ?? `${today.slice(0, 4)}-12-31`
  const cutoff = first("corte") ?? defaultCutoff
  const snapshot = (SNAPSHOTS.find((s) => s.value === first("foto"))?.value ?? "PRE_REGULARIZACION") as BalanceSnapshot
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
    { kind: "date", name: "corte", label: "Fecha de corte", value: cutoff },
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
    {
      kind: "select",
      name: "foto",
      label: "Foto",
      value: snapshot,
      options: SNAPSHOTS,
      hint: "La foto entra en la clave del informe (paramsHash)",
    },
  ]

  const state = await balanceAction({
    periodStart: from,
    periodEnd: cutoff,
    ...(selected ? { fiscalYearId: selected.id } : {}),
    snapshot,
    variant,
  })

  if (!state.success || !state.data) {
    return (
      <div className="space-y-6">
        <Title />
        <ReportToolbar basePath="/reports/balance" fields={toolbar} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert">
          No se ha podido emitir el balance: {state.error ?? "error desconocido"}. Un balance no se pinta a medias.
        </p>
      </div>
    )
  }

  const run: ReportRunView = state.data
  const report = run.result as unknown as BalanceReport

  // Comparativo: el MISMO informe (misma foto, mismo modelo) a la misma fecha
  // del ejercicio anterior. Se pide como run propio —y queda sellado— en vez de
  // reinterpretar cifras de otro sitio.
  let comparative: BalanceReport | null = null
  let comparativeLabel: string | null = null
  if (previous) {
    const previousCutoff = comparativeCutoff(cutoff, previous)
    const previousState = await balanceAction({
      periodStart: previous.startDate,
      periodEnd: previousCutoff,
      fiscalYearId: previous.id,
      snapshot,
      variant,
    })
    if (previousState.success && previousState.data) {
      comparative = previousState.data.result as unknown as BalanceReport
      comparativeLabel = `${previous.code} a ${previousCutoff.split("-").reverse().join("/")}`
    }
  }

  const columns: StatementColumn[] = [
    { key: "actual", header: `A ${cutoff.split("-").reverse().join("/")}` },
    { key: "anterior", header: comparativeLabel ?? "Ejercicio anterior" },
    { key: "delta", header: "Δ", emptyLabel: "—" },
  ]

  const previousPaths = comparative
    ? centsByPath(comparative.activo, comparative.patrimonioNeto, comparative.pasivo)
    : undefined
  const previousAccounts = comparative ? centsByAccount(comparative) : undefined

  const nodesFor = (rows: BalanceReport["activo"], prefix: string, sides: ("BALANCE_ACTIVO" | "BALANCE_PASIVO" | "BALANCE_PN")[]) =>
    statementNodes(rows, {
      prefix,
      accountsByEpigraph: accountsByEpigraph(report, sides),
      ...(previousPaths ? { previousByPath: previousPaths } : {}),
      ...(previousAccounts ? { previousByAccount: previousAccounts } : {}),
    })

  const total = (current: number, previousTotal: number | undefined) => ({
    actual: current,
    anterior: previousTotal ?? null,
    delta: previousTotal === undefined ? null : current - previousTotal,
  })

  const mayorHref = `/ledger/mayor?from=${from}&to=${cutoff}`
  const runInfo = {
    runId: run.id,
    ledgerHash: run.ledgerHash,
    gitSha: run.gitSha,
    module: "lib/ledger/reports/balance.ts",
  }

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance de situación"
        description={`Modelo ${variant === PgcVariant.PYMES ? "PYMES" : "normal"} · ${
          SNAPSHOTS.find((s) => s.value === snapshot)?.label
        }. Saldos de las cuentas de balance a la fecha de corte, agrupados por epígrafe oficial.`}
        header={runHeader(run, org.baseCurrency)}
        checksTitle="Validación del balance"
        checksDescription="Invariantes del libro diario e I2 / I-E6-* del balance: cuadre patrimonial, epígrafes sin cuenta, contra-cuentas, cuentas bidireccionales y regularización desfasada."
        actions={<ExportLinks type="balance" runId={run.id} />}
      />

      <ReportToolbar basePath="/reports/balance" fields={toolbar} />

      {run.origen === "cache" && (
        <p className="text-xs text-muted-foreground">
          Informe reutilizado del run emitido el {run.createdAt.toLocaleString("es-ES")}: el libro diario del periodo no
          ha cambiado desde entonces.
        </p>
      )}

      <StatementTable
        caption="Activo"
        testId="balance-activo"
        columns={columns}
        nodes={nodesFor(report.activo, "activo", ["BALANCE_ACTIVO"])}
        totalLabel="TOTAL ACTIVO"
        totalValues={total(
          report.totalActivoCents,
          comparative ? comparative.totalActivoCents : undefined
        )}
        mayorHref={mayorHref}
        runInfo={runInfo}
      />

      <StatementTable
        caption="Patrimonio neto"
        testId="balance-pn"
        columns={columns}
        nodes={nodesFor(report.patrimonioNeto, "pn", ["BALANCE_PN"])}
        totalLabel="TOTAL PATRIMONIO NETO"
        totalValues={total(
          report.totalPatrimonioNetoCents,
          comparative ? comparative.totalPatrimonioNetoCents : undefined
        )}
        mayorHref={mayorHref}
        runInfo={runInfo}
      />

      <StatementTable
        caption="Pasivo"
        testId="balance-pasivo"
        columns={columns}
        nodes={nodesFor(report.pasivo, "pasivo", ["BALANCE_PASIVO"])}
        totalLabel="TOTAL PASIVO"
        totalValues={total(report.totalPasivoCents, comparative ? comparative.totalPasivoCents : undefined)}
        check={{
          label: "Activo − (Pasivo + Patrimonio neto)",
          differenceCents: report.i2DiffCents,
          balanced: report.i2DiffCents === 0,
        }}
        mayorHref={mayorHref}
        runInfo={runInfo}
      />

      <section className="space-y-2 text-xs text-muted-foreground">
        <p data-testid="balance-resultado">
          Resultado del ejercicio:{" "}
          {report.resultado.source === "INYECTADO_I3"
            ? "inyectado desde el resultado del periodo (I3), porque la cuenta 129 está a cero (R-B5)."
            : report.resultado.source === "LEIDO_129"
              ? "leído de la cuenta 129, ya regularizada (R-B5)."
              : "no procede en esta foto."}
        </p>
        {report.reclasificacionesBidireccionales.length > 0 && (
          <p>
            Cuentas bidireccionales reclasificadas a su epígrafe espejo por el signo de su saldo (R-B4):{" "}
            <span className="font-code">
              {report.reclasificacionesBidireccionales.map((r) => r.code).join(", ")}
            </span>
            .
          </p>
        )}
        {report.notes.map((note) => (
          <p key={note} data-testid="balance-nota" className="max-w-4xl border-l-2 pl-3">
            {note}
          </p>
        ))}
      </section>
    </div>
  )
}

function Title() {
  return (
    <div className="space-y-1 border-b pb-4">
      <h1 className="text-2xl font-semibold tracking-tight">Balance de situación</h1>
    </div>
  )
}
