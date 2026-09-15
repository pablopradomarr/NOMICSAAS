"use client"

/**
 * E11 · integración — **cambiar el plan de esta organización** (ADR-0019 D9).
 *
 * Sólo se pinta en modo INTERNO y sólo para el administrador de plataforma. No
 * es un escaparate comercial: es la herramienta con la que se **ejercitan los
 * límites**, y por eso la lista incluye los planes no vendibles. El texto lo
 * dice, para que nadie lo confunda con contratar.
 */

import { changePlanAction } from "@/app/(app)/settings/subscription/actions"
import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

export function PlanSwitcher({ planCodes, currentCode }: { planCodes: string[]; currentCode: string | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = (formData: FormData) =>
    start(async () => {
      setError(null)
      setDone(null)
      const result = await changePlanAction(formData)
      if (!result.success) setError(result.error ?? "No se ha podido cambiar el plan")
      else {
        setDone(`Plan asignado: ${result.data?.planCode}. Queda en el registro de auditoría de plataforma.`)
        router.refresh()
      }
    })

  return (
    <section className="space-y-3" data-testid="plan-switcher">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Cambiar el plan (administración de plataforma)</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          En modo interno no se cobra, así que esto no es contratar nada: sirve para <strong>probar los límites</strong>
          . Asignar un plan con cuotas reales hace que las cuotas de recurso bloqueen y que la cuota de asientos avise
          sin bloquear nunca. El cambio queda registrado con el plan de antes y el de después.
        </p>
      </div>
      <form action={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Plan</span>
          <select
            name="planCode"
            defaultValue={currentCode ?? planCodes[0]}
            className="rounded-md border bg-background p-2 text-sm"
            data-testid="plan-switcher-select"
          >
            {planCodes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={pending} data-testid="plan-switcher-submit">
          {pending ? "Asignando…" : "Asignar este plan"}
        </Button>
      </form>
      {done && (
        <p className="text-sm text-green-700" data-testid="plan-switcher-done">
          {done}
        </p>
      )}
      {error && <FormError>{error}</FormError>}
    </section>
  )
}
