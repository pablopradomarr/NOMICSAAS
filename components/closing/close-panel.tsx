"use client"

import {
  closeFiscalYearE9Action,
  reopenFiscalYearAction,
  runClosingChecklistAction,
} from "@/app/(app)/ledger/closing/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import type { ClosingRunView, ClosingStepView, FiscalYearView } from "./types"

/**
 * E9 · T16 — Ejecutar el checklist, **cerrar** y **reabrir** (§7, ADR-0016 D1).
 *
 * Tres cosas que esta pantalla hace y conviene leer juntas:
 *
 * 1. **Cerrar exige un `ClosingRun` COMPROBADO con el mismo `ledgerHash`.** El
 *    botón deshabilitado es cortesía; la barrera es `closeFiscalYearE9Action`,
 *    que recomputa antes de cerrar porque entre el checklist y el botón puede
 *    haber entrado un asiento.
 * 2. **Reabrir es doble confirmación**: motivo ≥ 30 caracteres **y** escribir el
 *    código del ejercicio. Una confirmación que se responde con «sí» no obliga a
 *    mirar qué se está reabriendo.
 * 3. **Con las cuentas formuladas, el mensaje ofrece salida.** El servidor
 *    rechaza, sí, pero diciendo el camino —acuerdo de reformulación, NRV 23ª—,
 *    nunca «imposible».
 */

export function RunChecklistButton({ fiscalYearId, label }: { fiscalYearId: string; label?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <Button
      size="sm"
      data-testid="run-checklist"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const state = await runClosingChecklistAction({ fiscalYearId, answers: [] })
          if (!state.success || !state.data) {
            toast.error(state.error ?? "El checklist no ha devuelto resultado")
            return
          }
          const blockers = state.data.blockers.length
          toast.success(
            blockers === 0
              ? "Checklist ejecutado: los nueve pasos bloqueantes en PASS"
              : `Checklist ejecutado: ${blockers} paso(s) bloqueante(s) sin PASS`
          )
          router.refresh()
        })
      }
    >
      {pending ? "Ejecutando…" : (label ?? "Ejecutar checklist")}
    </Button>
  )
}

export function CloseFiscalYearDialog({
  fiscalYear,
  run,
  blockers,
}: {
  fiscalYear: FiscalYearView
  run: ClosingRunView | null
  blockers: readonly ClosingStepView[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  const comprobado = run?.status === "COMPROBADO"
  const bloqueado = blockers.length > 0 || !comprobado

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={bloqueado} data-testid="open-close-dialog">
        Cerrar el ejercicio
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Cerrar el ejercicio {fiscalYear.code}</DialogTitle>
            <DialogDescription>
              Se postean en una sola transacción el impuesto, la regularización del resultado, el cierre y la apertura
              del ejercicio siguiente, en el orden de O-17. El servidor recomprueba antes los nueve bloqueantes y que el
              diario no haya cambiado desde el checklist.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="close-reason">Motivo (mínimo 10 caracteres)</Label>
            <Textarea
              id="close-reason"
              value={reason}
              maxLength={512}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Cierre ordinario del ejercicio tras revisión del checklist."
              data-testid="close-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              disabled={pending || reason.trim().length < 10 || !run}
              data-testid="close-submit"
              onClick={() =>
                start(async () => {
                  if (!run) return
                  const state = await closeFiscalYearE9Action({
                    fiscalYearId: fiscalYear.id,
                    closingRunId: run.id,
                    reason: reason.trim(),
                  })
                  if (!state.success) {
                    toast.error(state.error ?? "No se ha podido cerrar el ejercicio")
                    return
                  }
                  toast.success(`Ejercicio ${fiscalYear.code} cerrado`)
                  setOpen(false)
                  router.refresh()
                })
              }
            >
              {pending ? "Cerrando…" : "Cerrar el ejercicio"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ReopenFiscalYearDialog({ fiscalYear }: { fiscalYear: FiscalYearView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [confirmCode, setConfirmCode] = useState("")
  const [ackTax, setAckTax] = useState(false)
  const [ackNext, setAckNext] = useState(false)
  const [pending, start] = useTransition()

  const puede = reason.trim().length >= 30 && confirmCode.trim() === fiscalYear.code

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="border-[#F5A623] text-[#1A202C]"
        onClick={() => setOpen(true)}
        data-testid="open-reopen-dialog"
      >
        Reabrir el ejercicio
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reabrir el ejercicio {fiscalYear.code}</DialogTitle>
            <DialogDescription>
              La reapertura postea <strong>cuatro contra-asientos</strong> —apertura, cierre, regularización e impuesto,
              en ese orden— y deja el valor actual, las diferencias de cambio y la reclasificación pendientes de
              recomputar. Nada se borra. Sólo es posible con las cuentas en <strong>borrador</strong>: formuladas,
              aprobadas o depositadas exigen un acuerdo de reformulación (NRV 23ª).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reopen-reason">Motivo (mínimo 30 caracteres)</Label>
              <Textarea
                id="reopen-reason"
                value={reason}
                maxLength={512}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Se detecta una factura de proveedor del ejercicio no contabilizada, por importe material."
                data-testid="reopen-reason"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reopen-code">
                Escriba <span className="font-code">{fiscalYear.code}</span> para confirmar
              </Label>
              <Input
                id="reopen-code"
                value={confirmCode}
                onChange={(event) => setConfirmCode(event.target.value)}
                className="font-code"
                data-testid="reopen-code"
              />
            </div>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox checked={ackTax} onCheckedChange={(v) => setAckTax(v === true)} data-testid="reopen-ack-tax" />
              <span>
                Entiendo que si el modelo 200 ya está presentado, reabrir obliga a autoliquidación complementaria o
                rectificativa (art. 122 LGT).
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox checked={ackNext} onCheckedChange={(v) => setAckNext(v === true)} data-testid="reopen-ack-next" />
              <span>Entiendo que el ejercicio siguiente puede tener asientos posteriores a la apertura que habrá que revisar.</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              variant="outline"
              className="border-[#F5A623]"
              disabled={pending || !puede}
              data-testid="reopen-submit"
              onClick={() =>
                start(async () => {
                  const state = await reopenFiscalYearAction({
                    fiscalYearId: fiscalYear.id,
                    reason: reason.trim(),
                    confirmCode: confirmCode.trim(),
                    acknowledgeTaxFiling: ackTax,
                    acknowledgeNextYear: ackNext,
                  })
                  if (!state.success) {
                    toast.error(state.error ?? "No se ha podido reabrir el ejercicio")
                    return
                  }
                  const avisos = state.data?.warnings ?? []
                  toast.success(
                    `Ejercicio ${fiscalYear.code} reabierto con ${state.data?.reversalEntryIds.length ?? 0} contra-asientos` +
                      (avisos.length > 0 ? ` · ${avisos.join(" · ")}` : "")
                  )
                  setOpen(false)
                  router.refresh()
                })
              }
            >
              {pending ? "Reabriendo…" : "Reabrir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
