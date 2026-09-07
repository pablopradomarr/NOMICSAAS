import { EditBankAccountDialog, ImportStatementDialog, NewBankAccountDialog } from "@/components/bank/account-dialogs"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { tenantTransaction } from "@/lib/db"
import { tenantPage } from "@/lib/page-tenant"
import { latestInvariantRun } from "@/models/audit"
import { listBankAccounts, pendingItems } from "@/models/bank"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

import { toAccountView, toSummaryView } from "./shared"

export const metadata: Metadata = { title: "Conciliación bancaria" }

/**
 * E7 · T16 — `/audit/bank`: las cuentas bancarias y su cuadre.
 *
 * De un vistazo: subcuenta 57x, **anclaje**, saldo del extracto, saldo contable,
 * diferencia, pendientes y Σ ignorado. Y el aviso que más importa: una cuenta
 * **sin anclaje** o con **hueco en la cadena** no puede dar PASS, y aquí se dice
 * antes de que nadie firme nada.
 *
 * Lecturas en SERIE dentro de la transacción del render: `pendingItems` resuelve
 * el cuadre de TODAS las cuentas con cuatro consultas agregadas, no cuatro por
 * cuenta.
 */
export default tenantPage(async ({ org, user, role }) => {
  const isAdmin = role === Role.ADMIN
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const cutoff = todayLocalDate()

  /**
   * Dentro de `tenantTransaction`, que **reutiliza** la transacción que
   * `tenantPage` ya abrió. No es ceremonia: `pendingItems` lee los apuntes de la
   * 57x con `$queryRaw`, y el SQL crudo sólo ve `app.current_org` si sale por la
   * conexión de la transacción. Fuera de ella, RLS no devolvería filas — o
   * fallaría—, que es exactamente el modo de fallo que ADR-0009 avisa.
   */
  const { accounts, run, summaries } = await tenantTransaction(org.id, user.id, async (tx) => {
    const accounts = await listBankAccounts(tx)
    const run = await latestInvariantRun(tx)
    const summaries = accounts.length > 0 ? await pendingItems(tx, { cutoff, baseCurrency: org.baseCurrency }) : []
    return { accounts, run, summaries }
  })
  const invariantsPass = run !== null && run.checks.every((check) => check.status !== "FAIL")
  const summaryByAccount = new Map(summaries.map((summary) => [summary.bankAccountId, summary]))

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/audit">← Auditoría</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Conciliación bancaria</h1>
          <p className="text-sm text-muted-foreground">
            Corte a {cutoff}, siempre por <strong>fecha de operación</strong>: la fecha valor se enseña pero no corta
            periodos. Moneda base de la organización: <span className="font-code">{org.baseCurrency}</span>.
          </p>
        </div>
        {isAdmin && <NewBankAccountDialog />}
      </header>

      {accounts.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-12 text-center" data-testid="bank-empty">
          <p className="text-sm font-medium">No hay ninguna cuenta bancaria dada de alta.</p>
          <p className="mx-auto mt-1 max-w-2xl text-sm text-muted-foreground">
            Se concilian las cuentas 572, 573, 574 y 575 (y sus subcuentas). La caja (570/571) no tiene extracto y no
            entra: por eso una organización con caja nunca verá el sello «validado contra fuente» en la tesorería total
            del balance, y sí en el detalle por cuenta bancaria.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-left font-medium">Cuenta</th>
                <th className="p-2 text-left font-medium">Subcuenta</th>
                <th className="p-2 text-left font-medium">Anclaje</th>
                <th className="p-2 text-right font-medium">E · extracto</th>
                <th className="p-2 text-right font-medium">B · contable</th>
                <th className="p-2 text-right font-medium">Diferencia</th>
                <th className="p-2 text-right font-medium">Pendientes</th>
                <th className="p-2 text-right font-medium">Σ ignorado</th>
                <th className="p-2 text-left font-medium">Sello</th>
                <th className="p-2 text-left font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const raw = summaryByAccount.get(account.id)
                const view = raw ? toSummaryView(raw, account, { invariantsPass }) : null
                const accountView = toAccountView(account)
                return (
                  <tr key={account.id} className="border-t align-top" data-testid={`bank-account-${account.id}`}>
                    <td className="p-2">
                      <Link href={`/audit/bank/${account.id}`} className="underline underline-offset-2">
                        {account.name}
                      </Link>
                      <p className="font-code text-xs text-muted-foreground">
                        {account.code} · {account.currency}
                        {account.iban ? ` · ${account.iban}` : ""}
                      </p>
                    </td>
                    <td className="font-code p-2">{account.accountCode}</td>
                    <td className="p-2">
                      {account.reconciledFromDate ? (
                        <>
                          <span className="tabular-nums">{account.reconciledFromDate}</span>
                          <br />
                          <Amount
                            cents={account.reconciledOpeningBalanceCents ?? 0}
                            currency={account.currency}
                            zeroAsDash={false}
                            className="text-xs"
                          />
                        </>
                      ) : (
                        <span className="text-[#8a6100]" data-testid={`sin-anclaje-${account.id}`}>
                          sin anclaje
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      {view?.saldoExtractoCents === null || view === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Amount cents={view.saldoExtractoCents} currency={account.currency} zeroAsDash={false} />
                      )}
                    </td>
                    <td className="p-2 text-right">
                      {view ? (
                        <Amount cents={view.saldoContableCents} currency={account.currency} zeroAsDash={false} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-right" data-testid={`diferencia-${account.id}`}>
                      {view === null || view.diferenciaCents === null ? (
                        <span className="text-muted-foreground">no evaluable</span>
                      ) : (
                        <Amount cents={view.diferenciaCents} currency={account.currency} zeroAsDash={false} />
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {view ? `${view.pendientesBanco.length} / ${view.pendientesLibros.length}` : "—"}
                    </td>
                    <td className="p-2 text-right">
                      {view ? (
                        <Amount cents={view.ignoradosCents} currency={account.currency} zeroAsDash={false} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2">
                      <ConfidenceBadge
                        level={view?.badge === "validado" ? "validado" : view?.badge === "comprobado" ? "comprobado" : "calculado"}
                      />
                      {view && !view.chainCovered && view.anchored && (
                        <p className="mt-1 text-xs text-[#8a6100]" data-testid={`hueco-${account.id}`}>
                          hueco en la cadena de extractos
                        </p>
                      )}
                    </td>
                    <td className="p-2">
                      <div className="flex flex-col items-start gap-1">
                        {canEdit && <ImportStatementDialog account={accountView} />}
                        {isAdmin && <EditBankAccountDialog account={accountView} />}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
})
