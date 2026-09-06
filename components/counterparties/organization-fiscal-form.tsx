"use client"

import { updateOrganizationFiscalAction } from "@/app/(app)/settings/counterparties/actions"
import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CircleCheckBig } from "lucide-react"
import { useActionState, useState } from "react"

/**
 * E8 · T23 — Régimen de IVA y ROI de la organización (ADR-0014 D11, O-4 y O-21).
 *
 * Los dos campos que aquí se guardan **bloquean o habilitan circuitos enteros**,
 * y por eso la pantalla lo dice en vez de dejarlo en la letra pequeña:
 *
 *  · **ROI** es la precondición (4) para que una operación pueda calificarse de
 *    inversión del sujeto pasivo o de adquisición intracomunitaria.
 *  · **Régimen ≠ general** (RECC, REDEME, otro) **bloquea la contabilización
 *    automática** (RC-24): con criterio de caja el devengo y la deducción siguen
 *    al cobro y al pago, así que todo el circuito de E8 daría asientos con la
 *    fecha equivocada. El soporte llega en E9. Un producto que no dice qué no
 *    soporta es peor que uno que no lo soporta.
 */
export function OrganizationFiscalForm({
  roiRegistered,
  ivaRegime,
  canEdit,
}: {
  roiRegistered: boolean
  ivaRegime: string
  canEdit: boolean
}) {
  const [state, action, pending] = useActionState(updateOrganizationFiscalAction, null)
  const [regime, setRegime] = useState(ivaRegime)

  return (
    <form action={action} className="max-w-3xl space-y-4">
      <h3 className="text-lg font-semibold">Régimen fiscal de la organización</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Régimen de IVA</span>
          <Select name="ivaRegime" defaultValue={ivaRegime} onValueChange={setRegime} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GENERAL">General</SelectItem>
              <SelectItem value="RECC">Criterio de caja (RECC)</SelectItem>
              <SelectItem value="REDEME">Devolución mensual (REDEME)</SelectItem>
              <SelectItem value="OTRO">Otro régimen especial</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="roiRegistered" defaultChecked={roiRegistered} disabled={!canEdit} />
          Inscrita en el Registro de Operadores Intracomunitarios (ROI)
        </label>
      </div>

      {regime !== "GENERAL" && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Con este régimen la <strong>contabilización automática de documentos queda bloqueada</strong>: en el
          criterio de caja el IVA se devenga y se deduce con el cobro y el pago, no con la factura, y los asientos
          saldrían en el trimestre equivocado. Los documentos se pueden seguir subiendo y extrayendo; contabilizarlos
          exige asiento manual hasta que E9 dé soporte al régimen.
        </p>
      )}

      {state?.error && <FormError>{state.error}</FormError>}
      {state?.success && (
        <p className="inline-flex items-center gap-2 text-sm text-emerald-700">
          <CircleCheckBig className="h-4 w-4" /> Guardado
        </p>
      )}

      {canEdit && (
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar régimen"}
        </Button>
      )}
    </form>
  )
}
