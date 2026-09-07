"use client"

import { clearReviewAction, forceReviewAction } from "@/app/(app)/audit/actions"
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
import { Label } from "@/components/ui/label"
import { CHECK_FAMILIES, FAMILY_LABEL } from "@/lib/audit/families"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E7 · T13 — Forzar revisión desde la foto del barrido (**ADMIN**).
 *
 * Lo que E7 añade al diálogo de E6 son dos datos que convierten un aviso
 * genérico en un aviso accionable: el **barrido** que lo motiva y la **familia**
 * de comprobaciones afectada. El motivo sigue siendo obligatorio (≥ 10
 * caracteres) porque un sello sin motivo no le dice nada a quien tiene que
 * revisar.
 *
 * Está permitido **sobre un ejercicio cerrado** (O-21): descubrir un error
 * después del cierre es justo cuando se fuerza una revisión.
 */
export function ForceReviewFromRunDialog({
  invariantRunId,
  defaultPeriodStart,
  defaultPeriodEnd,
}: {
  invariantRunId: string
  defaultPeriodStart: string
  defaultPeriodEnd: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart)
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd)
  const [checkFamily, setCheckFamily] = useState("")
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state = await forceReviewAction({
        periodStart,
        periodEnd,
        reason,
        invariantRunId,
        ...(checkFamily ? { checkFamily } : {}),
      })
      if (!state.success) {
        toast.error(state.error)
        return
      }
      toast.success("Periodo marcado: todo informe que lo solape saldrá REQUIERE REVISIÓN")
      setOpen(false)
      setReason("")
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-force-review">
        Forzar revisión
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forzar la revisión de un periodo</DialogTitle>
            <DialogDescription>
              Queda escrito con su autor, su motivo y el barrido que lo motiva. A partir de aquí, todo informe que
              solape el periodo sale sellado <strong>REQUIERE REVISIÓN</strong> hasta que un administrador lo levante.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="fr-start">Desde</Label>
                <Input id="fr-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fr-end">Hasta</Label>
                <Input id="fr-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="fr-family">Familia de comprobaciones</Label>
              <select
                id="fr-family"
                value={checkFamily}
                onChange={(event) => setCheckFamily(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="force-review-family"
              >
                <option value="">Todas las familias</option>
                {CHECK_FAMILIES.map((family) => (
                  <option key={family} value={family}>
                    {FAMILY_LABEL[family]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="fr-reason">Motivo (mínimo 10 caracteres)</Label>
              <Input
                id="fr-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Por qué este periodo tiene que revisarse"
                data-testid="force-review-reason"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || reason.trim().length < 10}
              data-testid="confirm-force-review"
            >
              {pending ? "Guardando…" : "Forzar revisión"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Levantar una marca: no la borra, la marca como levantada con motivo. */
export function ClearReviewButton({ flagId }: { flagId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  const submit = (): void => {
    start(async () => {
      const state = await clearReviewAction({ id: flagId, reason })
      if (!state.success) {
        toast.error(state.error)
        return
      }
      toast.success("Marca levantada: el siguiente barrido vuelve a sellar el periodo")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Levantar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Levantar la revisión</DialogTitle>
            <DialogDescription>
              La marca no se borra: queda levantada con su autor y su motivo, y el histórico sigue enseñándola.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="cr-reason">Motivo (mínimo 10 caracteres)</Label>
            <Input id="cr-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10}>
              {pending ? "Guardando…" : "Levantar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
