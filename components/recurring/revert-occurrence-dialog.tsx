"use client"

import { revertOccurrenceAction } from "@/app/(app)/ledger/recurring/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Revertir una ocurrencia (**ADMIN**, R-REC-7).
 *
 * No borra nada: postea un **contra-asiento** con su motivo (art. 29.1 CCom).
 * La ocurrencia sigue en el calendario como generada, apuntando al asiento
 * anulado, y el par se neutraliza en los informes.
 */
export function RevertOccurrenceDialog({ occurrenceId, period }: { occurrenceId: string; period: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state = await revertOccurrenceAction({ occurrenceId, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido revertir la ocurrencia")
        return
      }
      toast.success(`Contra-asiento posteado para el periodo ${period}`)
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
        data-testid="open-revert-occurrence"
      >
        Revertir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revertir la ocurrencia de {period}</DialogTitle>
            <DialogDescription>
              Se postea un <strong>contra-asiento</strong>: el asiento original no se borra ni se oculta. El motivo
              queda en el registro de auditoría junto al par de asientos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="revert-reason">Motivo (mínimo 10 caracteres)</Label>
            <Textarea
              id="revert-reason"
              data-testid="revert-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || reason.trim().length < 10}
              data-testid="revert-submit"
            >
              {pending ? "Revirtiendo…" : "Revertir con contra-asiento"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
