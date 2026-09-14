"use client"

import { createDebtScheduleAction } from "@/app/(app)/settings/debt/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17/T18 — Alta del **cuadro de vencimientos** de una deuda (**EDITOR**,
 * ADR-0016 D5, O-6).
 *
 * El cuadro no es documentación: **sin él la parte corriente de la deuda no se
 * puede presentar**, la reclasificación del cierre sale FAIL bloqueante e
 * I-E9-25 nombra la posición. Por eso el alta pide los vencimientos uno a uno.
 *
 * El navegador **parte el texto**; quien comprueba que Σ principal coincide con
 * el principal declarado y que la secuencia no tiene huecos (G-17) es el
 * servidor, y después la base.
 */
export function DebtScheduleForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [rows, setRows] = useState("2026-03-31;5.000,00;120,00\n2026-06-30;5.000,00;90,00")

  const submit = (form: FormData): void => {
    const principal = parseCents(String(form.get("principal") ?? ""))
    if (principal === null) {
      toast.error("El principal no se entiende como importe")
      return
    }
    const installments: { seq: number; dueDate: string; principalCents: number; interestCents: number }[] = []
    const lines = rows
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    for (const [index, line] of lines.entries()) {
      const [dueDate, principalText, interestText] = line.split(";").map((part) => (part ?? "").trim())
      const principalCents = parseCents(principalText)
      if (!dueDate || principalCents === null) {
        toast.error(`El vencimiento nº ${index + 1} no se entiende: use «AAAA-MM-DD;principal;interés»`)
        return
      }
      installments.push({
        seq: index + 1,
        dueDate,
        principalCents,
        interestCents: parseCents(interestText) ?? 0,
      })
    }

    start(async () => {
      const state = await createDebtScheduleAction({
        code: String(form.get("code") ?? "").trim(),
        name: String(form.get("name") ?? "").trim(),
        longAccountCode: String(form.get("longAccountCode") ?? "").trim(),
        shortAccountCode: String(form.get("shortAccountCode") ?? "").trim(),
        principalCents: principal,
        currency: String(form.get("currency") ?? "EUR").trim().toUpperCase(),
        startDate: String(form.get("startDate") ?? ""),
        installments,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido crear el cuadro")
        return
      }
      toast.success("Cuadro de vencimientos creado y sellado")
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-debt-form">
        Nuevo cuadro de deuda
      </Button>
    )
  }

  return (
    <form action={submit} className="space-y-4 rounded-md border p-4" data-testid="debt-form">
      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="debt-code">Código</Label>
          <Input id="debt-code" name="code" required maxLength={32} data-testid="debt-code" />
        </div>
        <div className="space-y-1 md:col-span-3">
          <Label htmlFor="debt-name">Denominación</Label>
          <Input id="debt-name" name="name" required maxLength={160} data-testid="debt-name" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="debt-long">Cuenta a largo plazo</Label>
          <Input id="debt-long" name="longAccountCode" required placeholder="170" data-testid="debt-long" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="debt-short">Cuenta a corto plazo</Label>
          <Input id="debt-short" name="shortAccountCode" required placeholder="520" data-testid="debt-short" />
          <p className="text-xs text-muted-foreground">Uno de los 23 pares de reclasificación (D5).</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="debt-principal">Principal</Label>
          <Input id="debt-principal" name="principal" inputMode="decimal" required data-testid="debt-principal" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="debt-start">Fecha de formalización</Label>
          <Input id="debt-start" name="startDate" type="date" required data-testid="debt-start" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="debt-currency">Divisa</Label>
          <Input id="debt-currency" name="currency" defaultValue="EUR" maxLength={3} data-testid="debt-currency" />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="debt-installments">Vencimientos, uno por línea</Label>
        <Textarea
          id="debt-installments"
          data-testid="debt-installments"
          rows={6}
          className="font-code text-xs"
          value={rows}
          onChange={(event) => setRows(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Formato <span className="font-code">AAAA-MM-DD;principal;interés</span>, en orden de fecha. La suma de los
          principales tiene que ser exactamente el principal declarado (G-17).
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="debt-submit">
          {pending ? "Creando…" : "Crear cuadro"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
