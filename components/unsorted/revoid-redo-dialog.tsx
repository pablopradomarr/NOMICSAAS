"use client"

import { revoidAndRedoAction } from "@/app/(app)/unsorted/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { MOTIVO_MIN } from "@/forms/extraction"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T16 — **Anular y rehacer** (ADR-0014 D1, O-9).
 *
 * Anular no borra: se emite el contra-asiento espejo, el asiento anulado se
 * traslada a `voided_entry_id` y se apila en `voided_entry_ids`, que es
 * append-only, y la operación vuelve a `PROPOSED`. Rehacerla **no exige volver a
 * subir el fichero** —el documento es el mismo y su `sha256` también, así que
 * resubirlo sería fabricar un duplicado de manual— y por eso tampoco dispara
 * RC-12.
 *
 * Motivo obligatorio: es una acción destructiva sobre el diario y queda en
 * `AuditLog` con el antes y el después.
 */
export function RevoidRedoDialog({
  transactionId,
  status,
  entryNumber,
}: {
  transactionId: string
  status: string
  entryNumber: number | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Sólo tiene sentido sobre una operación contabilizada o ya anulada: en
  // `DRAFT`/`PROPOSED` no hay asiento que anular y la acción lo rechaza.
  if (status !== "POSTED" && status !== "VOID") return null

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await revoidAndRedoAction({ transactionId, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido anular la operación")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="revoid-and-redo">
        Anular y rehacer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anular y rehacer</DialogTitle>
            <DialogDescription>
              {status === "POSTED"
                ? `Se emitirá el contra-asiento del asiento nº ${entryNumber ?? "—"} y la operación volverá a estar propuesta, con el mismo documento y sin volver a subirlo. El asiento anulado no desaparece: queda en el histórico de la operación.`
                : "La operación ya está anulada: volverá a estar propuesta para contabilizarla de nuevo desde el mismo documento."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={`Motivo (mínimo ${MOTIVO_MIN} caracteres)`}
            rows={3}
            data-testid="revoid-reason"
          />
          {error && (
            <p className="text-sm" role="alert" data-testid="revoid-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || reason.trim().length < MOTIVO_MIN}
              data-testid="revoid-confirm"
            >
              {pending ? "Anulando…" : "Anular y rehacer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
