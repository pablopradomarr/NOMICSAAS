"use client"

import type { DebtOverview } from "@/app/(app)/settings/debt/actions"
import { PostLoanDialog } from "@/components/debt/post-loan-dialog"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { shortHash } from "@/components/ledger/types"
import Link from "next/link"
import { useState } from "react"

/**
 * E9 · T18 — `/settings/debt`: préstamos, aplazamientos y su cuadro (§7, O-6).
 *
 * Lo primero que se ve no son los préstamos: son las **deudas sin desglose**.
 * Un balance con «Deudas a corto plazo» en cero teniendo préstamos vivos es lo
 * primero que mira un auditor, y por eso esas posiciones se enseñan nombradas y
 * arriba — están bloqueando el cierre, no informando de nada.
 */
export function DebtPanel({
  overview,
  canEdit,
  isAdmin,
}: {
  overview: DebtOverview
  canEdit: boolean
  isAdmin: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-medium">Deudas sin cuadro de vencimientos</h2>
        {overview.withoutSchedule.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="debt-without-schedule-empty">
            Todas las posiciones de deuda vivas a {overview.cutoff} tienen su cuadro. La reclasificación del cierre
            puede calcular la parte corriente.
          </p>
        ) : (
          <div className="space-y-2 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-4" data-testid="debt-without-schedule">
            <p className="text-sm">
              ⚠ Estas posiciones no tienen cuadro y <strong>bloquean el cierre</strong>: sin desglose de vencimientos
              no hay parte corriente que presentar (I-E9-25, art. 35.6 CCom — sin compensar saldos).
            </p>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Cuenta</th>
                  <th className="px-2 py-1 text-left font-medium">Tercero</th>
                  <th className="px-2 py-1 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5A623]/40">
                {overview.withoutSchedule.map((position) => (
                  <tr key={`${position.accountCode}-${position.counterpartyId ?? "sin"}`} className="h-7">
                    <td className="px-2 py-1 font-code text-xs">{position.accountCode}</td>
                    <td className="px-2 py-1 text-xs text-muted-foreground">
                      {position.counterpartyId ?? "sin tercero"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Amount cents={position.balanceCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Vencimientos a {overview.cutoff}</h2>
        {overview.maturities.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="debt-maturities-empty">
            No hay vencimientos pendientes a la fecha de corte.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="debt-maturities">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Deuda</th>
                  <th className="px-3 py-2 text-left font-medium">Par de cuentas</th>
                  <th className="px-3 py-2 text-left font-medium">Próximo vencimiento</th>
                  <th className="px-3 py-2 text-right font-medium">Vencido</th>
                  <th className="px-3 py-2 text-right font-medium">Corriente (≤ 12 m)</th>
                  <th className="px-3 py-2 text-right font-medium">No corriente</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overview.maturities.map((maturity) => (
                  <tr key={maturity.debtScheduleId} className="h-8" data-debt-code={maturity.code}>
                    <td className="px-3 py-1 font-code text-xs">{maturity.code}</td>
                    <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                      {maturity.longAccountCode} / {maturity.shortAccountCode}
                    </td>
                    <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                      {maturity.nextDueDate ?? "—"}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <Amount cents={maturity.overdueCents} />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <Amount cents={maturity.shortTermCents} />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <Amount cents={maturity.longTermCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Cuadros de deuda</h2>
        {overview.schedules.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="debt-empty">
            Todavía no hay ningún cuadro de deuda. {canEdit ? "Da de alta el primero arriba." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="debt-schedules">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Cuadro</th>
                  <th className="px-3 py-2 text-left font-medium">Formalización</th>
                  <th className="px-3 py-2 text-right font-medium">Principal</th>
                  <th className="px-3 py-2 text-right font-medium">Vencimientos</th>
                  <th className="px-3 py-2 text-left font-medium">Asiento de alta</th>
                  <th className="px-3 py-2 text-right font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overview.schedules.map((schedule) => (
                  <tr key={schedule.id} className="h-8" data-schedule-code={schedule.code}>
                    <td className="px-3 py-1">
                      <span className="font-code text-xs">{schedule.code}</span> {schedule.name}
                    </td>
                    <td className="px-3 py-1 font-code text-xs text-muted-foreground">{schedule.startDate}</td>
                    <td className="px-3 py-1 text-right">
                      <Amount cents={schedule.principalCents} currency={schedule.currency} />
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">{schedule.installments.length}</td>
                    <td className="px-3 py-1 text-xs">
                      {schedule.entryId ? (
                        <Link href={`/ledger/${schedule.entryId}`} className="underline underline-offset-4">
                          ver asiento
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">sin contabilizar</span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid={`open-schedule-${schedule.code}`}
                          onClick={() => setOpenId(openId === schedule.id ? null : schedule.id)}
                        >
                          {openId === schedule.id ? "Ocultar" : "Ver cuadro"}
                        </Button>
                        {isAdmin && schedule.entryId === null && (
                          <PostLoanDialog debtScheduleId={schedule.id} code={schedule.code} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {overview.schedules
        .filter((schedule) => schedule.id === openId)
        .map((schedule) => (
          <div key={schedule.id} className="space-y-2 rounded-md border p-4" data-testid={`schedule-${schedule.code}`}>
            <p className="text-sm font-medium">
              Vencimientos de <span className="font-code">{schedule.code}</span>
            </p>
            <p className="font-code text-xs text-muted-foreground">scheduleHash {shortHash(schedule.scheduleHash, 16)}</p>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Nº</th>
                    <th className="px-3 py-2 text-left font-medium">Vencimiento</th>
                    <th className="px-3 py-2 text-right font-medium">Principal</th>
                    <th className="px-3 py-2 text-right font-medium">Interés</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {schedule.installments.map((installment) => (
                    <tr key={installment.seq} className="h-8">
                      <td className="px-3 py-1 tabular-nums">{installment.seq}</td>
                      <td className="px-3 py-1 font-code text-xs">{installment.dueDate}</td>
                      <td className="px-3 py-1 text-right">
                        <Amount cents={installment.principalCents} currency={schedule.currency} />
                      </td>
                      <td className="px-3 py-1 text-right">
                        <Amount cents={installment.interestCents ?? 0} currency={schedule.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  )
}
