"use client"

import { pauseRecurringAction, type RecurringRuleSummary } from "@/app/(app)/ledger/recurring/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Pausar, reanudar o finalizar una regla (**EDITOR**), con motivo.
 *
 * Cambiar el estado de una regla decide qué asientos se generan a partir de
 * mañana: es una acción con consecuencias contables y por eso pide motivo y
 * queda en `AuditLog`. La regla no se borra nunca.
 */
export function PauseRuleDialog({ rule }: { rule: RecurringRuleSummary }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [status, setStatus] = useState<"ACTIVA" | "PAUSADA" | "FINALIZADA">(
    rule.status === "ACTIVA" ? "PAUSADA" : "ACTIVA"
  )
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state = await pauseRecurringAction({ id: rule.id, status, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido cambiar el estado de la regla")
        return
      }
      toast.success(`La regla ${rule.code} queda ${status.toLowerCase()}`)
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
        onClick={() => setOpen(true)}
        data-testid={`open-pause-${rule.code}`}
      >
        Estado
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Estado de la regla {rule.code}</DialogTitle>
            <DialogDescription>
              Ahora está <strong>{rule.status}</strong>. El cambio queda escrito con su autor y su motivo; la regla no
              se borra y sus ocurrencias generadas siguen ahí.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="pause-status">Nuevo estado</Label>
              <select
                id="pause-status"
                data-testid="pause-status"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="ACTIVA">Activa</option>
                <option value="PAUSADA">Pausada</option>
                <option value="FINALIZADA">Finalizada</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pause-reason">Motivo (mínimo 10 caracteres)</Label>
              <Textarea
                id="pause-reason"
                data-testid="pause-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10} data-testid="pause-submit">
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
