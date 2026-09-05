"use client"

import { voidEntryAction } from "@/app/(app)/ledger/actions"
import type { EntryView } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T11 — Anulación de un asiento (T-21, CA-1…CA-6).
 *
 * Anular NO borra: crea un **contra-asiento** espejo con `reversesEntryId`. El
 * motivo es obligatorio (mín. 10 caracteres, CA-6) y queda en `voidReason` y en
 * el `AuditLog`. La fecha del contra-asiento la decide el motor (la del
 * original si su mes sigue abierto; si no, el primer día del primer mes
 * abierto); `requestedDate` sólo puede retrasarla, nunca adelantarla.
 */
export function VoidDialog({ entry, canVoid }: { entry: EntryView; canVoid: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [requestedDate, setRequestedDate] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!canVoid || entry.voidedAt || entry.kind === "REVERSAL") return null

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await voidEntryAction({
        entryId: entry.id,
        reason: reason.trim(),
        requestedDate: requestedDate || undefined,
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido anular el asiento")
        return
      }
      setOpen(false)
      router.refresh()
      if (state.data?.entryId) router.push(`/ledger/${state.data.entryId}`)
    })

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} data-testid="void-entry">
        Anular
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anular el asiento nº {entry.entryNumber}</DialogTitle>
            <DialogDescription>
              No se borra nada: se registra un <strong>contra-asiento</strong> espejo con las mismas cuentas y el lado
              invertido. Los dos seguirán apareciendo en el diario y en sumas y saldos, y sus saldos se compensarán.
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Motivo de la anulación *</span>
            <Textarea
              aria-label="Motivo de la anulación"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={512}
              placeholder="Factura duplicada del proveedor"
            />
            <span className="text-[11px] text-muted-foreground">
              Mínimo 10 caracteres. Queda en el asiento anulado y en la auditoría.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Fecha contable solicitada (opcional)</span>
            <Input
              aria-label="Fecha contable solicitada"
              type="date"
              value={requestedDate}
              onChange={(event) => setRequestedDate(event.target.value)}
            />
            <span className="text-[11px] text-muted-foreground">
              Sólo puede retrasar la fecha que calcula el motor, nunca adelantarla.
            </span>
          </label>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || reason.trim().length < 10}
              data-testid="confirm-void"
            >
              {pending ? "Anulando…" : "Anular con contra-asiento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
