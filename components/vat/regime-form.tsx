"use client"

import { createVatRegimePeriodAction } from "@/app/(app)/reports/vat/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T18 — Declarar el **régimen de IVA con su vigencia** (**ADMIN**, D8.1).
 *
 * El régimen es un dato **fechado**, no una columna de la organización: entrar
 * en REDEME en 2027 con una casilla habría reagrupado los periodos de 2026 ya
 * presentados. Por eso se declara con `validFrom` y, si procede, `validTo`, y
 * cada periodo se liquida con el régimen que estaba vigente **ese día**.
 *
 * El diferimiento del IVA a la importación (art. 167.Dos LIVA) sólo existe con
 * liquidación **mensual** (art. 74.1 RIVA): el formulario lo dice antes de que
 * lo diga el CHECK de la base.
 */
export function VatRegimeForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [periodKind, setPeriodKind] = useState<"MENSUAL" | "TRIMESTRAL">("TRIMESTRAL")

  const submit = (form: FormData): void => {
    const validTo = String(form.get("validTo") ?? "").trim()
    start(async () => {
      const state = await createVatRegimePeriodAction({
        regime: String(form.get("regime") ?? "GENERAL"),
        periodKind,
        importDeferral: form.get("importDeferral") === "on",
        validFrom: String(form.get("validFrom") ?? ""),
        validTo: validTo === "" ? null : validTo,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido declarar el régimen")
        return
      }
      toast.success("Régimen de IVA declarado con su vigencia")
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-regime-form">
        Declarar régimen
      </Button>
    )
  }

  return (
    <form action={submit} className="w-full space-y-3 rounded-md border p-4" data-testid="regime-form">
      <div className="grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="regime-regime">Régimen</Label>
          <select
            id="regime-regime"
            name="regime"
            data-testid="regime-regime"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            defaultValue="GENERAL"
          >
            <option value="GENERAL">General</option>
            <option value="RECC">Criterio de caja (RECC)</option>
            <option value="REDEME">REDEME</option>
            <option value="OTRO">Otro</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="regime-kind">Liquidación</Label>
          <select
            id="regime-kind"
            data-testid="regime-kind"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={periodKind}
            onChange={(event) => setPeriodKind(event.target.value as typeof periodKind)}
          >
            <option value="TRIMESTRAL">Trimestral</option>
            <option value="MENSUAL">Mensual</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="regime-from">Vigente desde</Label>
          <Input id="regime-from" name="validFrom" type="date" required data-testid="regime-from" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="regime-to">Vigente hasta</Label>
          <Input id="regime-to" name="validTo" type="date" data-testid="regime-to" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="regime-deferral"
          name="importDeferral"
          type="checkbox"
          disabled={periodKind !== "MENSUAL"}
          data-testid="regime-deferral"
        />
        <Label htmlFor="regime-deferral" className="text-sm">
          Diferimiento del IVA a la importación (exige liquidación mensual)
        </Label>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="regime-submit">
          {pending ? "Guardando…" : "Declarar"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
