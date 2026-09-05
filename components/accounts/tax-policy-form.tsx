"use client"

import { updateTaxPolicyAction } from "@/app/(app)/settings/taxes/actions"
import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { CircleCheckBig } from "lucide-react"
import { useActionState } from "react"

/**
 * Política fiscal de la organización (D2-8): prorrata, método de redondeo de
 * cuotas y tolerancia residual. No es una cifra contable: son los PARÁMETROS con
 * los que el motor calculará las cuotas de todo documento posterior, así que
 * cambiarlos exige motivo y queda en la auditoría.
 */
export function TaxPolicyForm({
  prorrataBps,
  taxRoundingMode,
  redondeoToleranciaCents,
  canEdit,
}: {
  prorrataBps: number | null
  taxRoundingMode: string
  redondeoToleranciaCents: number
  canEdit: boolean
}) {
  const [state, action, pending] = useActionState(updateTaxPolicyAction, null)

  return (
    <form action={action} className="max-w-2xl space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Prorrata (puntos básicos)</span>
          <Input
            name="prorrataBps"
            defaultValue={prorrataBps ?? ""}
            placeholder="10000 = 100 % deducible"
            inputMode="numeric"
            disabled={!canEdit}
            className="font-code"
          />
          <span className="text-xs text-muted-foreground">Vacío = todo el IVA soportado es deducible.</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Redondeo de cuotas</span>
          <Select name="taxRoundingMode" defaultValue={taxRoundingMode} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PER_TIPO">Una cuota por tipo impositivo</SelectItem>
              <SelectItem value="PER_LINEA">Una cuota por línea de factura</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Tolerancia de redondeo (céntimos)</span>
          <Input
            name="redondeoToleranciaCents"
            defaultValue={redondeoToleranciaCents}
            inputMode="numeric"
            disabled={!canEdit}
            className="font-code"
          />
          <span className="text-xs text-muted-foreground">
            Diferencia residual admitida contra 669/769. Por encima, el documento se bloquea.
          </span>
        </label>
      </div>

      {canEdit && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">
              Motivo <span aria-hidden>*</span>
            </span>
            <Textarea name="reason" rows={2} required />
          </label>

          <div className="flex items-center gap-4">
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar política fiscal"}
            </Button>
            {state?.success && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleCheckBig className="h-4 w-4" /> Cambios guardados
              </p>
            )}
          </div>
        </>
      )}

      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          Sólo un administrador puede modificar la política fiscal de la organización.
        </p>
      )}
      {state?.error && <FormError>{state.error}</FormError>}
    </form>
  )
}
