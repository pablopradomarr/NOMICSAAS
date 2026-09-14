"use client"

import { reverseVatSettlementAction } from "@/app/(app)/reports/vat/actions"
import { Amount } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fechaHoraUtc } from "@/lib/dates-ui"
import type { VatSettlementRow } from "@/models/vat"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T18 — Pestaña **Liquidaciones** (§7).
 *
 * Cada liquidación con su **sello**: el `ledgerHash` del diario y el `bookHash`
 * del libro registro sobre los que se declaró, más la versión del motor. Es lo
 * que permite decir, meses después, que la cifra presentada salió de ese diario
 * y no de otro.
 *
 * Revertir es **contra-asiento** (ADMIN, con motivo): libera el periodo, que
 * vuelve a admitir asientos con cuentas de IVA (B-6). Nada se borra.
 */
export function SettlementsPanel({ settlements, isAdmin }: { settlements: VatSettlementRow[]; isAdmin: boolean }) {
  if (settlements.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="settlements-empty">
        Todavía no se ha liquidado ningún periodo.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid="settlements">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Periodo</th>
            <th className="px-3 py-2 text-left font-medium">Régimen</th>
            <th className="px-3 py-2 text-right font-medium">Repercutido</th>
            <th className="px-3 py-2 text-right font-medium">Soportado</th>
            <th className="px-3 py-2 text-right font-medium">Resultado</th>
            <th className="px-3 py-2 text-left font-medium">Estado</th>
            <th className="px-3 py-2 text-left font-medium">Sello</th>
            <th className="px-3 py-2 text-right font-medium">Acciones</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {settlements.map((settlement) => (
            <tr key={settlement.id} className="h-8" data-settlement-period={settlement.period}>
              <td className="px-3 py-1 font-code text-xs">{settlement.period}</td>
              <td className="px-3 py-1 text-xs">
                {settlement.regime}
                {settlement.importDeferral && <span className="ml-1 rounded bg-muted px-1 text-[10px]">diferido</span>}
              </td>
              <td className="px-3 py-1 text-right">
                <Amount cents={settlement.outputCents} />
              </td>
              <td className="px-3 py-1 text-right">
                <Amount cents={settlement.inputCents} />
              </td>
              <td className="px-3 py-1 text-right">
                <Amount cents={settlement.resultCents} />
              </td>
              <td className="px-3 py-1 text-xs">{settlement.status}</td>
              <td className="px-3 py-1 font-code text-[11px] text-muted-foreground" title={settlement.ledgerHash}>
                ledger {shortHash(settlement.ledgerHash, 12)} · libro {shortHash(settlement.bookHash, 8)} ·{" "}
                {fechaHoraUtc(settlement.settledAt)}
              </td>
              <td className="px-3 py-1 text-right">
                <div className="flex justify-end gap-2">
                  <Link
                    href={`/ledger/${settlement.entryId}`}
                    className="text-xs underline underline-offset-4"
                    data-testid={`settlement-entry-${settlement.period}`}
                  >
                    ver asiento
                  </Link>
                  {isAdmin && settlement.reversedByEntryId === null && (
                    <ReverseDialog period={settlement.period} />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReverseDialog({ period }: { period: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state = await reverseVatSettlementAction({ period, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido revertir la liquidación")
        return
      }
      toast.success(`Liquidación de ${period} revertida con contra-asiento`)
      setOpen(false)
      setReason("")
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-[#F5A623] text-[#1A202C]"
        onClick={() => setOpen(true)}
        data-testid={`open-reverse-${period}`}
      >
        Revertir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revertir la liquidación de {period}</DialogTitle>
            <DialogDescription>
              Se postea un <strong>contra-asiento</strong> y el periodo vuelve a admitir asientos con cuentas de IVA
              (B-6). La liquidación revertida sigue en el historial con su sello.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="reverse-reason">Motivo (mínimo 10 caracteres)</Label>
            <Textarea
              id="reverse-reason"
              data-testid="reverse-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10} data-testid="reverse-submit">
              {pending ? "Revirtiendo…" : "Revertir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
