"use client"

import { createRecurringAction } from "@/app/(app)/ledger/recurring/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseCents } from "@/lib/money"
import { OPERATIONAL_TEMPLATE_CODES } from "@/lib/ledger/templates/types"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Alta de una regla recurrente (**EDITOR**).
 *
 * La periodicidad y la vigencia son los dos datos que definen la regla: qué
 * frecuencia, con qué anclaje del día y entre qué periodos. El importe **sólo**
 * se teclea en `IMPORTE_FIJO` (G-2): en amortización y periodificación la cuota
 * la aporta el cuadro, y una cifra escrita a mano sería una segunda fuente de
 * verdad (ADR-0003). El formulario lo refleja deshabilitando el campo.
 *
 * `templateInput` viaja como JSON porque la forma fina la valida el schema de
 * **la plantilla** dentro de `buildFromTemplate` (fuente única): duplicarla aquí
 * en campos sueltos crearía una segunda definición que envejecería sola.
 */
export function RecurringRuleForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [kind, setKind] = useState<"AMORTIZACION" | "PERIODIFICACION" | "IMPORTE_FIJO">("IMPORTE_FIJO")
  const [anchor, setAnchor] = useState<"PRIMER_DIA" | "ULTIMO_DIA" | "DIA_DEL_MES">("ULTIMO_DIA")
  const [templateInput, setTemplateInput] = useState('{\n  "documentDate": "2026-01-31"\n}')

  const submit = (form: FormData): void => {
    let parsedInput: Record<string, unknown>
    try {
      parsedInput = JSON.parse(templateInput) as Record<string, unknown>
    } catch {
      toast.error("Los datos de la plantilla no son un JSON válido")
      return
    }
    const amount = String(form.get("amount") ?? "").trim()
    const anchorDay = String(form.get("anchorDay") ?? "").trim()
    const endPeriod = String(form.get("endPeriod") ?? "").trim()

    start(async () => {
      const state = await createRecurringAction({
        code: String(form.get("code") ?? "").trim(),
        name: String(form.get("name") ?? "").trim(),
        kind,
        templateCode: String(form.get("templateCode") ?? ""),
        templateInput: parsedInput,
        // El navegador NO decide céntimos: `parseCents` es la misma función pura
        // que usa el servidor y la acción vuelve a validar el entero.
        amountCents: kind === "IMPORTE_FIJO" ? parseCents(amount) : null,
        freq: String(form.get("freq") ?? "MENSUAL"),
        anchor,
        anchorDay: anchor === "DIA_DEL_MES" && anchorDay ? Number(anchorDay) : null,
        startPeriod: String(form.get("startPeriod") ?? "").trim(),
        endPeriod: endPeriod === "" ? null : endPeriod,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido crear la regla")
        return
      }
      toast.success("Regla recurrente creada")
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-rule-form">
        Nueva regla
      </Button>
    )
  }

  return (
    <form action={submit} className="space-y-4 rounded-md border p-4" data-testid="rule-form">
      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="rule-code">Código</Label>
          <Input id="rule-code" name="code" required maxLength={32} data-testid="rule-code" />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="rule-name">Nombre</Label>
          <Input id="rule-name" name="name" required maxLength={160} data-testid="rule-name" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-kind">Tipo</Label>
          <select
            id="rule-kind"
            data-testid="rule-kind"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="IMPORTE_FIJO">Importe fijo</option>
            <option value="AMORTIZACION">Amortización (del cuadro)</option>
            <option value="PERIODIFICACION">Periodificación (del cuadro)</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="rule-freq">Periodicidad</Label>
          <select
            id="rule-freq"
            name="freq"
            data-testid="rule-freq"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            defaultValue="MENSUAL"
          >
            <option value="MENSUAL">Mensual</option>
            <option value="TRIMESTRAL">Trimestral</option>
            <option value="SEMESTRAL">Semestral</option>
            <option value="ANUAL">Anual</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-anchor">Anclaje del día</Label>
          <select
            id="rule-anchor"
            data-testid="rule-anchor"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={anchor}
            onChange={(event) => setAnchor(event.target.value as typeof anchor)}
          >
            <option value="ULTIMO_DIA">Último día del periodo</option>
            <option value="PRIMER_DIA">Primer día del periodo</option>
            <option value="DIA_DEL_MES">Día fijo del mes</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-anchor-day">Día del mes</Label>
          <Input
            id="rule-anchor-day"
            name="anchorDay"
            type="number"
            min={1}
            max={31}
            disabled={anchor !== "DIA_DEL_MES"}
            data-testid="rule-anchor-day"
          />
          <p className="text-xs text-muted-foreground">Se satura al último día de los meses cortos.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-amount">Importe de la cuota</Label>
          <Input
            id="rule-amount"
            name="amount"
            inputMode="decimal"
            placeholder="1.234,56"
            disabled={kind !== "IMPORTE_FIJO"}
            data-testid="rule-amount"
          />
          <p className="text-xs text-muted-foreground">
            {kind === "IMPORTE_FIJO" ? "En euros; el servidor lo convierte a céntimos." : "Lo aporta el cuadro (G-2)."}
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="rule-start">Vigencia desde (periodo)</Label>
          <Input id="rule-start" name="startPeriod" placeholder="2026-01" required data-testid="rule-start" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-end">Vigencia hasta (periodo)</Label>
          <Input id="rule-end" name="endPeriod" placeholder="2026-12" data-testid="rule-end" />
          <p className="text-xs text-muted-foreground">En blanco, sin fecha de fin.</p>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="rule-template">Plantilla</Label>
          <select
            id="rule-template"
            name="templateCode"
            data-testid="rule-template"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            defaultValue="TRASPASO_TESORERIA"
          >
            {OPERATIONAL_TEMPLATE_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="rule-input">Datos de la plantilla (JSON)</Label>
        <Textarea
          id="rule-input"
          data-testid="rule-template-input"
          rows={5}
          className="font-code text-xs"
          value={templateInput}
          onChange={(event) => setTemplateInput(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          El importe de cada ocurrencia lo pone la regla; las fechas del asiento las pone el periodo. Lo que va aquí es
          el resto de la entrada que la plantilla necesita, y su forma la valida la propia plantilla.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="rule-submit">
          {pending ? "Creando…" : "Crear regla"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
