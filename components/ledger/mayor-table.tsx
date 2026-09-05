import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import Link from "next/link"

/**
 * E3 · T12 — Libro mayor de una cuenta (diseño §6).
 *
 * Saldo inicial (Σ de todo lo anterior al periodo), movimientos con saldo
 * acumulado y saldo final: todo calculado en `lib/ledger/reports/mayor.ts`.
 * Convención de signo del proyecto: `saldo = Σdebe − Σhaber` (negativo =
 * acreedor). El drill-down de cada movimiento va al asiento completo.
 */

export type MayorMovementView = {
  entryId: string
  entryNumber: number
  entryDate: string
  lineNo: number
  description?: string | null
  debitCents: number
  creditCents: number
  runningBalanceCents: number
}

export type MayorAccountView = {
  accountCode: string
  accountName: string
  openingBalanceCents: number
  totalDebitCents: number
  totalCreditCents: number
  closingBalanceCents: number
  movements: MayorMovementView[]
}

export function MayorTable({ account }: { account: MayorAccountView }) {
  return (
    <section className="space-y-2" data-testid="mayor-account" data-account-code={account.accountCode}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-semibold">
          <span className="font-code">{account.accountCode}</span> {account.accountName}
        </h2>
        <ConfidenceBadge level="calculado" />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Fecha</th>
              <th className="px-3 py-2 text-left font-medium">Asiento</th>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              <th className="px-3 py-2 text-right font-medium">Debe</th>
              <th className="px-3 py-2 text-right font-medium">Haber</th>
              <th className="px-3 py-2 text-right font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="h-8 bg-muted/20" data-testid="opening-balance">
              <td className="px-3 py-1 text-muted-foreground" colSpan={5}>
                Saldo inicial
              </td>
              <td className="px-3 py-1 text-right font-medium">
                <AmountPlain cents={account.openingBalanceCents} zeroAsDash={false} />
              </td>
            </tr>
            {account.movements.map((movement) => (
              <tr key={`${movement.entryId}-${movement.lineNo}`} className="h-8">
                <td className="px-3 py-1 tabular-nums whitespace-nowrap">{formatLocalDate(movement.entryDate)}</td>
                <td className="px-3 py-1">
                  <Link href={`/ledger/${movement.entryId}`} className="font-code text-xs underline-offset-2 hover:underline">
                    {movement.entryNumber}
                  </Link>
                </td>
                <td className="px-3 py-1 text-muted-foreground">{movement.description ?? ""}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={movement.debitCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={movement.creditCents} />
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  <AmountPlain cents={movement.runningBalanceCents} zeroAsDash={false} />
                </td>
              </tr>
            ))}
            {account.movements.length === 0 && (
              <tr className="h-8">
                <td className="px-3 py-2 text-muted-foreground" colSpan={6}>
                  Sin movimientos en el periodo.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9" data-testid="closing-balance">
              <td className="px-3 py-1" colSpan={3}>
                Sumas del periodo y saldo final
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={account.totalDebitCents} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={account.totalCreditCents} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1 text-right" data-closing-cents={account.closingBalanceCents}>
                <AmountPlain cents={account.closingBalanceCents} zeroAsDash={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
