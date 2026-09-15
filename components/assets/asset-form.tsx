"use client"

import { createAssetAction } from "@/app/(app)/settings/assets/actions"
import { LIS_COEFFICIENTS, suggestedLifeMonths } from "@/components/assets/lis-coefficients"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Alta de un activo (**EDITOR**, ADR-0016 D2).
 *
 * Dos cosas que la pantalla dice y que no son adorno:
 *
 * · La fecha que manda es la de **puesta en condiciones de funcionamiento**
 *   (NRV 2ª.1 y 3ª), no la de la factura: es la que arranca el cuadro.
 * · La **sugerencia del art. 12.1 LIS** rellena la vida útil, con la nota de
 *   que la amortización **fiscal no se contabiliza** (O-23): si difiere de la
 *   económica, la diferencia es un ajuste extracontable del modelo 200 y nunca
 *   una segunda dotación en el diario.
 *
 * **E10 · T17 (deuda §0-bis #7).** El formulario gana el **destino analítico**
 * —proyecto *xor* centro de coste—, que el schema admitía desde E9 y la pantalla
 * no ofrecía: en una organización con destino analítico obligatorio, un activo
 * dado de alta por pantalla no se podía vender hasta que alguien le declarara el
 * destino por SQL. La dotación de `68x` y el resultado de la baja (`671`/`771`)
 * heredan ese destino.
 */
export type AssetDimensionOption = { id: string; code: string; name: string }

export function AssetForm({
  projects = [],
  costCenters = [],
  analyticsRequired = false,
}: {
  projects?: readonly AssetDimensionOption[]
  costCenters?: readonly AssetDimensionOption[]
  /** `true` = las cuentas 6/7 exigen destino (C-9): sin él, el alta se bloquea. */
  analyticsRequired?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [life, setLife] = useState("")
  const [suggestion, setSuggestion] = useState<string>("")

  const submit = (form: FormData): void => {
    const cost = parseCents(String(form.get("cost") ?? ""))
    const residual = parseCents(String(form.get("residual") ?? "")) ?? 0
    if (cost === null) {
      toast.error("El coste de adquisición no se entiende como importe")
      return
    }
    // Destino analítico: UN proyecto o UN centro de coste, nunca los dos.
    const [targetKind, targetId] = String(form.get("analyticTarget") ?? "").split(":")
    if (analyticsRequired && !targetId) {
      toast.error(
        "Esta organización exige destino analítico en las cuentas 6/7: elige el proyecto o el centro de coste que soporta la amortización"
      )
      return
    }
    start(async () => {
      const state = await createAssetAction({
        code: String(form.get("code") ?? "").trim(),
        name: String(form.get("name") ?? "").trim(),
        assetAccountCode: String(form.get("assetAccountCode") ?? "").trim(),
        accumulatedAccountCode: String(form.get("accumulatedAccountCode") ?? "").trim(),
        expenseAccountCode: String(form.get("expenseAccountCode") ?? "").trim(),
        acquisitionDate: String(form.get("acquisitionDate") ?? ""),
        inServiceDate: String(form.get("inServiceDate") ?? ""),
        acquisitionCostCents: cost,
        residualValueCents: residual,
        method: "LINEAL",
        usefulLifeMonths: Number(form.get("usefulLifeMonths") ?? 0),
        isCapitalGood: form.get("isCapitalGood") === "on",
        ...(targetId && targetKind === "PROJ" ? { projectId: targetId } : {}),
        ...(targetId && targetKind === "CECO" ? { costCenterId: targetId } : {}),
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido dar de alta el activo")
        return
      }
      toast.success("Activo dado de alta con su cuadro sellado")
      setOpen(false)
      router.refresh()
    })
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-asset-form">
        Nuevo activo
      </Button>
    )
  }

  return (
    <form action={submit} className="space-y-4 rounded-md border p-4" data-testid="asset-form">
      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="asset-code">Código</Label>
          <Input id="asset-code" name="code" required maxLength={32} data-testid="asset-code" />
        </div>
        <div className="space-y-1 md:col-span-3">
          <Label htmlFor="asset-name">Denominación</Label>
          <Input id="asset-name" name="name" required maxLength={160} data-testid="asset-name" />
        </div>

        <div className="space-y-1">
          <Label htmlFor="asset-account">Cuenta del inmovilizado</Label>
          <Input id="asset-account" name="assetAccountCode" required placeholder="213" data-testid="asset-account" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-accumulated">Amortización acumulada</Label>
          <Input
            id="asset-accumulated"
            name="accumulatedAccountCode"
            required
            placeholder="2813"
            data-testid="asset-accumulated"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-expense">Dotación del ejercicio</Label>
          <Input id="asset-expense" name="expenseAccountCode" required placeholder="681" data-testid="asset-expense" />
        </div>
        <div className="flex items-end gap-2 pb-2">
          <input id="asset-capital-good" name="isCapitalGood" type="checkbox" data-testid="asset-capital-good" />
          <Label htmlFor="asset-capital-good" className="text-sm">
            Bien de inversión (art. 108 LIVA)
          </Label>
        </div>

        <div className="space-y-1">
          <Label htmlFor="asset-acquisition">Fecha de adquisición</Label>
          <Input id="asset-acquisition" name="acquisitionDate" type="date" required data-testid="asset-acquisition" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-in-service">Puesta en funcionamiento</Label>
          <Input id="asset-in-service" name="inServiceDate" type="date" required data-testid="asset-in-service" />
          <p className="text-xs text-muted-foreground">NRV 2ª.1 y 3ª: es la que arranca el cuadro.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-cost">Coste de adquisición</Label>
          <Input id="asset-cost" name="cost" inputMode="decimal" placeholder="10.000,00" required data-testid="asset-cost" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="asset-residual">Valor residual</Label>
          <Input id="asset-residual" name="residual" inputMode="decimal" placeholder="0,00" data-testid="asset-residual" />
        </div>

        <div className="space-y-1">
          <Label htmlFor="asset-life">Vida útil (meses)</Label>
          <Input
            id="asset-life"
            name="usefulLifeMonths"
            type="number"
            min={1}
            max={1200}
            required
            value={life}
            onChange={(event) => setLife(event.target.value)}
            data-testid="asset-life"
          />
        </div>
        <div className="space-y-1 md:col-span-3">
          <Label htmlFor="asset-lis">Sugerencia del art. 12.1 LIS</Label>
          <select
            id="asset-lis"
            data-testid="asset-lis"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={suggestion}
            onChange={(event) => {
              setSuggestion(event.target.value)
              const found = LIS_COEFFICIENTS.find((c) => c.element === event.target.value)
              if (found) setLife(String(suggestedLifeMonths(found)))
            }}
          >
            <option value="">Sin sugerencia — la vida útil es la económica</option>
            {LIS_COEFFICIENTS.map((c) => (
              <option key={c.element} value={c.element}>
                {c.element} — coeficiente máximo {c.maxRatePct} %, periodo máximo {c.maxYears} años
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1 md:col-span-4">
          <Label htmlFor="asset-analytic-target">
            Destino analítico de la amortización {analyticsRequired ? "(obligatorio)" : "(opcional)"}
          </Label>
          <select
            id="asset-analytic-target"
            name="analyticTarget"
            required={analyticsRequired}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            data-testid="asset-analytic-target"
          >
            <option value="">Sin destino — la dotación quedará sin dimensión</option>
            <optgroup label="Proyectos">
              {projects.map((p) => (
                <option key={p.id} value={`PROJ:${p.id}`}>
                  {p.code} · {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Centros de coste">
              {costCenters.map((c) => (
                <option key={c.id} value={`CECO:${c.id}`}>
                  {c.code} · {c.name}
                </option>
              ))}
            </optgroup>
          </select>
          <p
            className={
              analyticsRequired
                ? "rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-2 py-1 text-xs"
                : "text-xs text-muted-foreground"
            }
            data-testid="asset-analytics-required"
          >
            {analyticsRequired ? (
              <>
                <strong>Esta organización exige destino analítico</strong> en las cuentas de los grupos 6 y 7 (C-9). Un
                activo sin destino no podrá amortizarse ni venderse: la dotación de <span className="font-code">68x</span>{" "}
                y el resultado de la baja (<span className="font-code">671</span> / <span className="font-code">771</span>)
                lo heredan de aquí.
              </>
            ) : (
              <>
                Un proyecto <strong>o</strong> un centro de coste, nunca los dos. La dotación de{" "}
                <span className="font-code">68x</span> y el resultado de la baja lo heredan.
              </>
            )}
          </p>
        </div>
      </div>

      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="asset-lis-note">
        La tabla del art. 12.1 LIS es una <strong>sugerencia</strong>: lo que se contabiliza es la vida útil
        <strong> económica</strong> del elemento (NRV 2ª.2.1). La <strong>amortización fiscal no se contabiliza</strong>:
        si difiere de la contable, la diferencia es un ajuste extracontable del modelo 200 y nunca una segunda dotación
        en el diario (art. 10.3 LIS).
      </p>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending} data-testid="asset-submit">
          {pending ? "Dando de alta…" : "Dar de alta"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
