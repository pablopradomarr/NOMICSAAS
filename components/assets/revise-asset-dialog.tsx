"use client"

import { reviseAssetAction } from "@/app/(app)/settings/assets/actions"
import type { AssetView } from "@/components/assets/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Revisión **prospectiva** del activo (**EDITOR**, NRV 22ª, R-AM-5).
 *
 * Una revisión es un **cambio de estimación**: no toca el pasado, no genera
 * asiento de ajuste y no recalcula las cuotas ya dotadas. Lo que cambia es el
 * cuadro **desde** `effectiveFrom`, y con él el `scheduleHash` del activo.
 *
 * La vida útil que se pide es la **total revisada contada desde la puesta en
 * funcionamiento**, no los meses que quedan: es la misma lectura que tiene el
 * campo del activo, y confundirlas es de donde salen los cuadros imposibles.
 */
export function ReviseAssetDialog({ detail }: { detail: AssetView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [reason, setReason] = useState("")

  const submit = (form: FormData): void => {
    const life = String(form.get("life") ?? "").trim()
    const residual = String(form.get("residual") ?? "").trim()
    const added = String(form.get("added") ?? "").trim()
    start(async () => {
      const state = await reviseAssetAction({
        fixedAssetId: detail.asset.id,
        effectiveFrom: String(form.get("effectiveFrom") ?? ""),
        newUsefulLifeMonths: life === "" ? null : Number(life),
        newResidualValueCents: residual === "" ? null : parseCents(residual),
        addedCostCents: added === "" ? null : parseCents(added),
        reason,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido revisar el activo")
        return
      }
      toast.success("Revisión registrada: el cuadro cambia desde la fecha indicada")
      setOpen(false)
      setReason("")
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-revise-asset">
        Revisar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revisar {detail.asset.code}</DialogTitle>
            <DialogDescription>
              Cambio de estimación <strong>prospectivo</strong> (NRV 22ª): no se rehacen las cuotas ya dotadas ni se
              postea ningún ajuste. La fecha ha de ser el día 1 de un mes y no puede ser anterior al último periodo
              contabilizado.
            </DialogDescription>
          </DialogHeader>
          <form action={submit} className="space-y-3" data-testid="revise-form">
            <div className="space-y-1">
              <Label htmlFor="revise-from">Efectos desde</Label>
              <Input id="revise-from" name="effectiveFrom" type="date" required data-testid="revise-from" />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="revise-life">Vida útil total (meses)</Label>
                <Input id="revise-life" name="life" type="number" min={1} max={1200} data-testid="revise-life" />
                <p className="text-xs text-muted-foreground">Desde la puesta en funcionamiento.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="revise-residual">Nuevo valor residual</Label>
                <Input id="revise-residual" name="residual" inputMode="decimal" data-testid="revise-residual" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="revise-added">Mejora capitalizada</Label>
                <Input id="revise-added" name="added" inputMode="decimal" data-testid="revise-added" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="revise-reason">Motivo (mínimo 10 caracteres)</Label>
              <Textarea
                id="revise-reason"
                data-testid="revise-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={pending || reason.trim().length < 10} data-testid="revise-submit">
                {pending ? "Guardando…" : "Registrar revisión"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
