"use client"

import { markSimplifiedQualifiedAction } from "@/app/(app)/unsorted/actions"
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
import { documentNotices, type DocumentNotice } from "@/components/unsorted/notices"
import type { ProposalPreview } from "@/components/unsorted/types"
import { MOTIVO_MIN } from "@/forms/extraction"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T16 — Avisos específicos del documento, con el único acto que se ofrece
 * desde ellos: **marcar un ticket como factura simplificada cualificada**.
 *
 * Ese acto no es una casilla. Pasar un ticket de «no deducible» a «deducible»
 * es afirmar que el papel lleva el NIF del destinatario y la cuota repercutida
 * por separado (art. 7.2 RD 1619/2012), y eso lo comprueba una persona mirando
 * el documento, no un modelo. Por eso exige motivo, queda en `AuditLog` y crea
 * un run de revisión: el del modelo sigue diciendo lo que decía.
 */

const TONE_STYLE: Record<DocumentNotice["tone"], string> = {
  bloqueo: "border-[#F5A623] bg-[#F5A623]/15",
  aviso: "border-[#F5A623] bg-[#F5A623]/10",
  informativo: "border-muted bg-muted/40",
}

export function DocumentNotices({
  preview,
  canEdit,
}: {
  preview: ProposalPreview
  canEdit: boolean
}) {
  const notices = documentNotices(preview)
  if (notices.length === 0) return null

  return (
    <section className="space-y-2" data-testid="document-notices">
      <h2 className="text-sm font-semibold tracking-tight">Avisos del documento</h2>
      {notices.map((notice) => (
        <div
          key={notice.code}
          data-notice={notice.code}
          data-notice-tone={notice.tone}
          className={cn("space-y-2 rounded-md border px-3 py-2 text-sm", TONE_STYLE[notice.tone])}
        >
          <p className="font-medium">{notice.title}</p>
          <p className="text-muted-foreground">{notice.body}</p>
          {notice.offerQualify && canEdit && <QualifyTicketDialog runId={preview.runId} />}
        </div>
      ))}
    </section>
  )
}

function QualifyTicketDialog({ runId }: { runId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await markSimplifiedQualifiedAction({ runId, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido marcar el ticket como cualificado")
        return
      }
      setOpen(false)
      // El acto crea un run de REVISIÓN: la pantalla pasa a ese run, que es el
      // que respaldará el asiento.
      if (state.data?.runId) router.push(`?run=${state.data.runId}`)
      router.refresh()
    })

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="qualify-ticket">
        Marcar como factura simplificada cualificada
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar el ticket como cualificado</DialogTitle>
            <DialogDescription>
              Declara que el documento lleva el NIF y el domicilio del destinatario y la cuota repercutida por
              separado (art. 7.2 RD 1619/2012). La cuota pasará a ser deducible. El motivo queda en el registro de
              auditoría y se crea una revisión: la extracción original no se modifica.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={`Motivo (mínimo ${MOTIVO_MIN} caracteres)`}
            rows={3}
            data-testid="qualify-reason"
          />
          {error && (
            <p className="text-sm text-[#1A202C]" role="alert">
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
              data-testid="qualify-confirm"
            >
              {pending ? "Guardando…" : "Marcar como cualificada"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
