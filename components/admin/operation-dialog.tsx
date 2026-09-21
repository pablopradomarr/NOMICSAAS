"use client"

/**
 * E12 · T13 — **el diálogo de una escritura de operador** (ADR-0020 D3/D4, §5.5).
 *
 * Tres cosas que esta pantalla hace y que no son decoración:
 *
 *  1. **Enumera antes de hacer.** Al abrirla se llama a la acción de
 *     *planificación*, que devuelve lo que va a pasar —recuento por tabla, plan
 *     de antes y de después, objetos a purgar— y un **token** que sella esa
 *     enumeración. Hasta que la enumeración no está en pantalla no hay botón.
 *  2. **Si la operación está bloqueada, se enseña la negativa y su porqué**, y
 *     no se ofrece forma de seguir. `reset-org` sobre una organización con un
 *     asiento se queda aquí: no hay «--force», ni casilla, ni atajo.
 *  3. **La confirmación la comprueba el servidor.** Este componente deshabilita
 *     el botón hasta que el nombre coincide y el motivo llega a 20 caracteres,
 *     pero eso es **comodidad**: quien decide es la acción, que recibe el nombre
 *     tecleado, el motivo y el token, y vuelve a enumerar antes de escribir.
 *     Si el navegador mintiera, no cambiaría nada.
 */

import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

export type PlanStepView = { label: string; rows?: number; note?: string }

export type OperationPlanView = {
  action: string
  organizationId: string
  organizationName: string
  steps: PlanStepView[]
  affectedCounts: Record<string, number>
  before: Record<string, string | number | null>
  after: Record<string, string | number | null>
  blocked: string | null
}

export type PreparedView = { plan: OperationPlanView; token: string }

export const MIN_REASON = 20

type Props = {
  /** Identificador estable para los tests e2e. */
  testId: string
  title: string
  description: string
  /** Texto del botón que ejecuta. En imperativo y sin eufemismos. */
  confirmLabel: string
  organizationId: string
  organizationName: string
  /** Campos extra que viajan en el `FormData` (plan destino, guardia…). */
  extra?: Record<string, string>
  /** Primera mitad: enumerar y firmar. */
  onPlan: () => Promise<{ success: boolean; error?: string | null; data?: PreparedView | null }>
  /** Segunda mitad: ejecutar con token + nombre + motivo. */
  onRun: (formData: FormData) => Promise<{ success: boolean; error?: string | null }>
}

export function OperationDialog({
  testId,
  title,
  description,
  confirmLabel,
  organizationId,
  organizationName,
  extra,
  onPlan,
  onRun,
}: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [prepared, setPrepared] = useState<PreparedView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [typedName, setTypedName] = useState("")

  const abrir = () =>
    start(async () => {
      setError(null)
      setDone(null)
      const result = await onPlan()
      if (!result.success || !result.data) {
        setError(result.error ?? "No se ha podido enumerar la operación.")
        return
      }
      setPrepared(result.data)
    })

  const cerrar = () => {
    setPrepared(null)
    setReason("")
    setTypedName("")
    setError(null)
  }

  const ejecutar = () =>
    start(async () => {
      if (!prepared) return
      setError(null)
      const formData = new FormData()
      formData.set("organizationId", organizationId)
      formData.set("token", prepared.token)
      formData.set("reason", reason)
      formData.set("confirmedName", typedName)
      for (const [k, v] of Object.entries(extra ?? {})) formData.set(k, v)
      const result = await onRun(formData)
      if (!result.success) {
        setError(result.error ?? "La operación se ha denegado.")
        return
      }
      setDone("Hecho. Queda registrado en el registro de plataforma y en el de la organización.")
      cerrar()
      router.refresh()
    })

  const nombreOk = typedName.trim() === organizationName.trim()
  const motivoOk = reason.trim().length >= MIN_REASON
  const listo = prepared !== null && prepared.plan.blocked === null && nombreOk && motivoOk && !pending

  return (
    <section className="rounded-lg border p-4 space-y-3" data-testid={testId}>
      <div className="space-y-1">
        <h3 className="font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-3xl">{description}</p>
      </div>

      {done && (
        <p className="text-sm text-emerald-700" data-testid={`${testId}-done`}>
          {done}
        </p>
      )}
      {error && <FormError>{error}</FormError>}

      {prepared === null ? (
        <Button type="button" variant="outline" disabled={pending} onClick={abrir} data-testid={`${testId}-plan`}>
          {pending ? "Enumerando…" : "Ver qué va a pasar"}
        </Button>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md bg-muted/50 p-3 space-y-2" data-testid={`${testId}-enumeracion`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Lo que va a pasar, antes de que pase
            </p>
            <ul className="space-y-1 text-sm">
              {prepared.plan.steps.map((step, i) => (
                <li key={i}>
                  <span className="font-medium">{step.label}</span>
                  {step.rows !== undefined && <span className="tabular-nums"> · {step.rows} fila(s)</span>}
                  {step.note && <p className="text-xs text-muted-foreground">{step.note}</p>}
                </li>
              ))}
            </ul>
          </div>

          {prepared.plan.blocked ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid={`${testId}-blocked`}>
              <p className="text-sm font-medium text-destructive">Esta operación no se puede hacer</p>
              <p className="mt-1 text-sm">{prepared.plan.blocked}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Motivo (mínimo {MIN_REASON} caracteres, y de verdad)</span>
                <textarea
                  name="reason"
                  rows={3}
                  className="rounded-md border px-3 py-2 text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Qué ha pasado y por qué esto lo resuelve"
                  data-testid={`${testId}-reason`}
                />
                <span className="text-xs text-muted-foreground">
                  Se escribe en el registro de plataforma y en el registro de la organización: el cliente tiene
                  derecho a ver que alguien de la plataforma tocó algo suyo. «arreglo» y «test» no valen.
                </span>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                  Para confirmar, teclea el nombre exacto: <code>{organizationName}</code>
                </span>
                <input
                  name="confirmedName"
                  className="rounded-md border px-3 py-2 text-sm"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  autoComplete="off"
                  data-testid={`${testId}-name`}
                />
                <span className="text-xs text-muted-foreground">
                  La comparación se hace en el servidor, no aquí.
                </span>
              </label>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={!listo}
              onClick={ejecutar}
              data-testid={`${testId}-run`}
            >
              {pending ? "Ejecutando…" : confirmLabel}
            </Button>
            <Button type="button" variant="ghost" onClick={cerrar} disabled={pending}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
