import { accountNames, defaultPeriod, reportHeader } from "@/app/(app)/ledger/shared"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportPeriodPicker } from "@/components/reports/report-period-picker"
import { ReportTable, type ReportColumn, type ReportNode } from "@/components/reports/report-table"
import { requireOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { buildSumasSaldos, type SumasSaldosRow } from "@/lib/ledger/reports/sumas-saldos"
import type { ReportAccount } from "@/lib/ledger/reports/types"
import { computeLedgerHash, getLinesForPeriod, todayLocalDate } from "@/models/ledger"
import { listFiscalYears } from "@/models/fiscal-years"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Sumas y saldos" }

const COLUMNS: ReportColumn[] = [
  { key: "sumDebit", header: "Sumas Debe" },
  { key: "sumCredit", header: "Sumas Haber" },
  { key: "debitBalance", header: "Saldo deudor" },
  { key: "creditBalance", header: "Saldo acreedor" },
]

/**
 * E3 · T12 — Balance de sumas y saldos (diseño §6).
 *
 * Jerárquico por prefijo (grupo → subgrupo → cuenta), con la fila de cuadre
 * `Σdeudor − Σacreedor = 0,00 €` y la cabecera con el **sello** que sale de
 * `runInvariants` + `sealFor`. Todas las cifras vienen de
 * `lib/ledger/reports/sumas-saldos.ts` con su provenance por celda.
 */
export default async function SumasSaldosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org, user } = await requireOrg(Role.VIEWER)
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

  const names = await accountNames(db)
  const reportAccounts: ReportAccount[] = [...names.entries()].map(([code, name]) => ({ code, name }))

  const { lines, ledgerHash } = await tenantTransaction(org.id, user.id, async (tx) => ({
    lines: await getLinesForPeriod(tx, { from, to, ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}) }),
    ledgerHash: await computeLedgerHash(tx, { from, to, ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}) }),
  }))

  const header = await reportHeader(org.id, user.id, {
    from,
    to,
    baseCurrency: org.baseCurrency,
    refDate,
    ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}),
  })

  const report = buildSumasSaldos(
    lines,
    reportAccounts,
    {
      organizationId: org.id,
      from,
      to,
      baseCurrency: org.baseCurrency,
      // #10: el informe está acotado al ejercicio, así que la provenance de cada
      // celda también: `registros_origen` tiene que devolver EXACTAMENTE las
      // líneas que suman la cifra, no todas las del rango de fechas.
      ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}),
    },
    {
      runId: header.runId,
      ledgerHash,
      gitSha: header.gitSha,
      baseCurrency: org.baseCurrency,
      module: "lib/ledger/reports/sumas-saldos.ts",
    }
  )

  const nodes = toTree(report.rows)

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Balance de sumas y saldos"
        description="Sumas del Debe y del Haber y saldo de cada cuenta del plan en el periodo, agrupadas por grupo y subgrupo del PGC. Los asientos anulados y sus contra-asientos están incluidos y se compensan."
        header={header}
      />

      <ReportPeriodPicker
        basePath="/ledger/sumas-saldos"
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

      <ReportTable
        columns={COLUMNS}
        nodes={nodes}
        mayorHref={`/ledger/mayor?from=${from}&to=${to}`}
        footer={{
          label: `Totales (${org.baseCurrency})`,
          values: {
            sumDebit: report.totals.totalDebitCents,
            sumCredit: report.totals.totalCreditCents,
            debitBalance: report.balanceTotals.totalDebitCents,
            creditBalance: report.balanceTotals.totalCreditCents,
          },
          check: {
            label: "Σ saldo deudor − Σ saldo acreedor",
            differenceCents: report.balanceTotals.differenceCents,
            balanced: report.balanceTotals.balanced,
          },
        }}
      />
    </div>
  )
}

/**
 * Filas planas de `buildSumasSaldos` → árbol por prefijo de código.
 *
 * El informe puro ya calcula los agregados de 1, 2 y 3 dígitos; aquí sólo se
 * anidan para que la tabla los pueda colapsar. No se suma nada.
 */
function toTree(rows: readonly SumasSaldosRow[]): ReportNode[] {
  const toNode = (row: SumasSaldosRow, depth: number): ReportNode => {
    const node: ReportNode = {
      id: `${row.isAggregate ? "g" : "c"}-${row.accountCode}`,
      code: row.accountCode,
      label: row.accountName,
      depth,
      isAggregate: row.isAggregate,
      values: {
        sumDebit: row.sumDebitCents,
        sumCredit: row.sumCreditCents,
        debitBalance: row.debitBalanceCents,
        creditBalance: row.creditBalanceCents,
      },
    }
    if (row.provenance) {
      node.provenance = {
        debitBalance: row.provenance,
        creditBalance: row.provenance,
        sumDebit: row.provenance,
        sumCredit: row.provenance,
      }
    }
    return node
  }

  const aggregates = rows.filter((r) => r.isAggregate).sort((a, b) => a.accountCode.localeCompare(b.accountCode))
  const leaves = rows.filter((r) => !r.isAggregate)

  const byCode = new Map<string, ReportNode>()
  const roots: ReportNode[] = []

  for (const aggregate of aggregates) {
    const parentCode = aggregate.accountCode.slice(0, -1)
    const parent = parentCode.length > 0 ? byCode.get(parentCode) : undefined
    const node = toNode(aggregate, parent ? parent.depth + 1 : 0)
    node.children = []
    byCode.set(aggregate.accountCode, node)
    if (parent) parent.children?.push(node)
    else roots.push(node)
  }

  for (const leaf of leaves) {
    // Cuelga de su agregado más específico existente (3, 2 y luego 1 dígito).
    let parent: ReportNode | undefined
    for (let length = leaf.accountCode.length - 1; length >= 1; length -= 1) {
      parent = byCode.get(leaf.accountCode.slice(0, length))
      if (parent) break
    }
    const node = toNode(leaf, parent ? parent.depth + 1 : 0)
    if (parent) parent.children?.push(node)
    else roots.push(node)
  }

  return roots
}
