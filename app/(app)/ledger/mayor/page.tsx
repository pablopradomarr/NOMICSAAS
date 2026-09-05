import { accountNames, defaultPeriod, postableAccounts, reportHeader } from "@/app/(app)/ledger/shared"
import { MayorTable, type MayorAccountView } from "@/components/ledger/mayor-table"
import { ReportHeader } from "@/components/reports/report-header"
import { ReportPeriodPicker } from "@/components/reports/report-period-picker"
import { requireOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { buildMayor } from "@/lib/ledger/reports/mayor"
import type { ReportAccount } from "@/lib/ledger/reports/types"
import { getLinesForPeriod, todayLocalDate } from "@/models/ledger"
import { listFiscalYears } from "@/models/fiscal-years"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Mayor" }

/**
 * E3 · T12 — Libro mayor por cuenta y periodo (diseño §6).
 *
 * Saldo inicial, movimientos y saldo final los calcula `buildMayor`, una
 * función pura sobre las líneas que `getLinesForPeriod` lee dentro del tenant.
 * El saldo inicial exige leer también lo anterior al periodo, así que la
 * consulta arranca en el origen de los tiempos y el informe corta por `from`.
 */
export default async function MayorPage({
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
      ? { startDate: selectedFy.startDate.toISOString().slice(0, 10), endDate: selectedFy.endDate.toISOString().slice(0, 10) }
      : null,
    refDate
  )
  const from = first("from") ?? period.from
  const to = first("to") ?? period.to
  const account = first("account") ?? ""

  const names = await accountNames(db)
  const accounts = await postableAccounts(db)
  const reportAccounts: ReportAccount[] = [...names.entries()].map(([code, name]) => ({ code, name }))

  // El saldo inicial es Σ de todo lo anterior a `from`: hay que leer desde el
  // principio, no sólo el periodo. `buildMayor` separa una cosa de la otra.
  const lines = await tenantTransaction(org.id, user.id, async (tx) =>
    getLinesForPeriod(tx, {
      from: "0001-01-01",
      to,
      ...(account ? { accountCodes: [account] } : {}),
    })
  )

  const report = buildMayor(lines, reportAccounts, {
    organizationId: org.id,
    from,
    to,
    baseCurrency: org.baseCurrency,
    ...(account ? { accountCodes: [account] } : {}),
  })

  const header = await reportHeader(org.id, user.id, {
    from,
    to,
    baseCurrency: org.baseCurrency,
    refDate,
    ...(selectedFy ? { fiscalYearId: selectedFy.id } : {}),
  })

  const views: MayorAccountView[] = report.accounts.map((a) => ({
    accountCode: a.accountCode,
    accountName: a.accountName,
    openingBalanceCents: a.openingBalanceCents,
    totalDebitCents: a.totalDebitCents,
    totalCreditCents: a.totalCreditCents,
    closingBalanceCents: a.closingBalanceCents,
    movements: a.movements.map((m) => ({
      entryId: m.entryId,
      entryNumber: m.entryNumber,
      entryDate: m.entryDate,
      lineNo: m.lineNo,
      description: m.description ?? null,
      debitCents: m.debitCents,
      creditCents: m.creditCents,
      runningBalanceCents: m.runningBalanceCents,
    })),
  }))

  return (
    <div className="space-y-6">
      <ReportHeader
        title="Libro mayor"
        description="Movimientos de cada cuenta con su saldo inicial, acumulado y final. El saldo se expresa como Σdebe − Σhaber: negativo es acreedor."
        header={header}
      />

      <ReportPeriodPicker
        basePath="/ledger/mayor"
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
        accounts={accounts}
        account={account}
      />

      {views.length === 0 ? (
        <p className="rounded-md border p-6 text-sm text-muted-foreground">
          No hay movimientos en el periodo para esa selección.
        </p>
      ) : (
        <div className="space-y-6">
          {views.slice(0, 40).map((view) => (
            <MayorTable key={view.accountCode} account={view} />
          ))}
          {views.length > 40 && (
            <p className="text-sm text-muted-foreground">
              Se muestran las 40 primeras cuentas de {views.length}. Filtra por cuenta para ver el resto.
            </p>
          )}
        </div>
      )}

      <p className="rounded-md border bg-muted/20 p-3 text-sm" data-testid="mayor-cuadre">
        Σ de los saldos finales del periodo:{" "}
        <span className="font-code tabular-nums" data-cents={report.closingBalanceSumCents}>
          {new Intl.NumberFormat("es-ES", { style: "currency", currency: org.baseCurrency, useGrouping: "always" })
            .format(report.closingBalanceSumCents / 100)
            .replace("-", "−")}
        </span>{" "}
        {report.closingBalanceSumCents === 0 || account !== "" ? "" : "⚠"}
        <span className="ml-2 text-muted-foreground">
          En un diario cuadrado y sin filtro de cuenta, la suma de todos los saldos finales es 0,00 €.
        </span>
      </p>
    </div>
  )
}
