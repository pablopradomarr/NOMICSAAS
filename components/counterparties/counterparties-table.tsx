"use client"

import {
  createCounterpartyAction,
  updateCounterpartyAction,
} from "@/app/(app)/settings/counterparties/actions"
import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useActionState, useEffect, useState } from "react"

export type CounterpartyView = {
  id: string
  code: string
  name: string
  taxId: string | null
  countryCode: string | null
  vatNumber: string | null
  viesValid: boolean | null
  viesCheckedAt: string | null
  withholdingRegime: string
  withholdingRateCode: string | null
  surchargeRegime: boolean
  isEmployee: boolean
  isActive: boolean
  notes: string | null
}

/**
 * E8 · T23 — Los seis regímenes con su tipo «de libro». El porcentaje se muestra
 * para que el usuario reconozca el suyo, pero **el tipo que se aplica sale del
 * `TaxRate` vigente**, no de esta etiqueta: los tipos cambian por norma y una
 * cifra escrita en un `<option>` acabaría contradiciendo al motor.
 */
const REGIMENES: readonly { value: string; label: string }[] = [
  { value: "NINGUNO", label: "Sin retención" },
  { value: "PROFESIONAL", label: "Profesional (15 %)" },
  { value: "PROFESIONAL_INICIO", label: "Profesional en inicio de actividad (7 %)" },
  { value: "ARRENDADOR", label: "Arrendador de inmuebles urbanos (19 %)" },
  { value: "AGRICOLA", label: "Actividad agrícola o ganadera" },
  { value: "MODULOS", label: "Módulos / estimación objetiva (1 %)" },
]

const regimenLabel = (value: string) => REGIMENES.find((r) => r.value === value)?.label ?? value

function rama(countryCode: string | null): string {
  if (!countryCode || countryCode === "ES") return "España"
  const UE = new Set([
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "FI", "FR", "GR", "HR", "HU", "IE", "IT",
    "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
  ])
  return UE.has(countryCode) ? "UE" : "Tercer país"
}

export function CounterpartiesTable({
  counterparties,
  canEdit,
}: {
  counterparties: readonly CounterpartyView[]
  canEdit: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Terceros y su calificación fiscal</h3>
          <p className="text-sm text-muted-foreground">
            La retención, el recargo de equivalencia y el país los decide <strong>este maestro</strong>, no el
            documento: la retención es obligación del pagador (arts. 99 y 101 LIRPF), y si el proveedor no la
            consigna en su factura la sociedad sigue obligada. Lo que se lea del PDF sólo sirve para contrastar.
          </p>
        </div>
        {canEdit && !creating && (
          <Button type="button" variant="outline" onClick={() => setCreating(true)}>
            Nuevo tercero
          </Button>
        )}
      </div>

      {creating && <CounterpartyForm mode="create" onDone={() => setCreating(false)} />}

      {counterparties.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Todavía no hay terceros. Sin su régimen configurado, toda factura de un profesional saldrá con un aviso
          de «retención no practicada» al contabilizarse.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2 font-medium">Código</th>
                <th className="p-2 font-medium">Nombre</th>
                <th className="p-2 font-medium">NIF</th>
                <th className="p-2 font-medium">País</th>
                <th className="p-2 font-medium">NIF-IVA / VIES</th>
                <th className="p-2 font-medium">Retención</th>
                <th className="p-2 font-medium">Marcas</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {counterparties.map((c) =>
                editing === c.id ? (
                  <tr key={c.id}>
                    <td colSpan={8} className="p-2">
                      <CounterpartyForm mode="update" counterparty={c} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className={c.isActive ? "border-t" : "border-t text-muted-foreground line-through"}>
                    <td className="p-2 font-code">{c.code}</td>
                    <td className="p-2">{c.name}</td>
                    <td className="p-2 font-code">{c.taxId ?? "—"}</td>
                    <td className="p-2">
                      {c.countryCode ?? "ES"} <span className="text-xs text-muted-foreground">({rama(c.countryCode)})</span>
                    </td>
                    <td className="p-2 font-code">
                      {c.vatNumber ?? "—"}
                      {c.vatNumber && (
                        <span className="ml-2 font-sans text-xs text-muted-foreground">
                          {c.viesValid === null
                            ? "sin comprobar en VIES"
                            : c.viesValid
                              ? `VIES ✓ ${c.viesCheckedAt ?? ""}`
                              : `VIES ✗ ${c.viesCheckedAt ?? ""}`}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {regimenLabel(c.withholdingRegime)}
                      {c.withholdingRateCode && (
                        <span className="ml-1 font-code text-xs text-muted-foreground">{c.withholdingRateCode}</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {[c.surchargeRegime ? "recargo de equivalencia" : null, c.isEmployee ? "empleado" : null]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="p-2 text-right">
                      {canEdit && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(c.id)}>
                          Editar
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function CounterpartyForm({
  mode,
  counterparty,
  onDone,
}: {
  mode: "create" | "update"
  counterparty?: CounterpartyView
  onDone: () => void
}) {
  const [state, action, pending] = useActionState(
    mode === "create" ? createCounterpartyAction : updateCounterpartyAction,
    null
  )
  // El cierre del formulario se hace al confirmar el servidor, no durante el
  // render (React 19 lo denuncia como efecto en render).
  useEffect(() => {
    if (state?.success) onDone()
  }, [state?.success, onDone])

  return (
    <form action={action} className="space-y-3 rounded-md border bg-muted/20 p-4">
      {mode === "update" && <input type="hidden" name="id" value={counterparty!.id} />}
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Código</span>
            <Input name="code" required maxLength={24} className="font-code" placeholder="PROV-001" />
          </label>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Código</span>
            <p className="font-code text-sm">{counterparty!.code}</p>
            <span className="text-xs text-muted-foreground">
              No se cambia: las propuestas ya confirmadas apuntan aquí.
            </span>
          </div>
        )}

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-sm font-medium">Nombre o razón social</span>
          <Input name="name" required maxLength={255} defaultValue={counterparty?.name ?? ""} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">NIF / CIF</span>
          <Input name="taxId" maxLength={20} className="font-code" defaultValue={counterparty?.taxId ?? ""} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">País (ISO, 2 letras)</span>
          <Input
            name="countryCode"
            maxLength={2}
            className="font-code uppercase"
            placeholder="ES"
            defaultValue={counterparty?.countryCode ?? ""}
          />
          <span className="text-xs text-muted-foreground">
            Decide cómo se comprueba el identificador: dígito de control en España, formato de NIF-IVA y VIES en la
            UE, y sin comprobación en un tercer país.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">NIF-IVA (operaciones intracomunitarias)</span>
          <Input name="vatNumber" maxLength={20} className="font-code" defaultValue={counterparty?.vatNumber ?? ""} />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Régimen de retención</span>
          <Select name="withholdingRegime" defaultValue={counterparty?.withholdingRegime ?? "NINGUNO"}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REGIMENES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Código del tipo de retención</span>
          <Input
            name="withholdingRateCode"
            maxLength={24}
            className="font-code"
            placeholder="IRPF15"
            defaultValue={counterparty?.withholdingRateCode ?? ""}
          />
          <span className="text-xs text-muted-foreground">
            El tipo aplicado sale del `TaxRate` vigente a la fecha de devengo, no de esta etiqueta.
          </span>
        </label>

        <fieldset className="flex flex-col justify-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="surchargeRegime" defaultChecked={counterparty?.surchargeRegime ?? false} />
            Recargo de equivalencia
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="isEmployee" defaultChecked={counterparty?.isEmployee ?? false} />
            Empleado (notas de gasto contra 465, nunca 400/410)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="isActive" defaultChecked={counterparty?.isActive ?? true} />
            Activo
          </label>
        </fieldset>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">Notas</span>
        <Textarea name="notes" maxLength={512} rows={2} defaultValue={counterparty?.notes ?? ""} />
      </label>

      {mode === "update" && (
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Motivo del cambio</span>
          <Input name="reason" placeholder="Por qué cambia el régimen (queda en la auditoría)" />
        </label>
      )}

      {state?.error && <FormError>{state.error}</FormError>}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
