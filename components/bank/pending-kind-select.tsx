"use client"

import { useState, useTransition } from "react"

import { typePendingAction } from "@/app/(app)/audit/actions"

import { PENDING_KIND_LABEL, type PendingKind } from "./types"

/**
 * E7 · ronda 1 (H-5) — **Tipar una partida en tránsito** (O-8, §3.5).
 *
 * El tipo lo **declara una persona**, no lo deduce el motor de un texto: eso
 * sería auto-punteo por patrón, que es E12 y necesita ADR. Lo que hace el motor
 * con lo declarado es **envejecerlo** —y decidir con ello si el pendiente está
 * explicado (§3.6, criterio 3)—, de modo que tipar un cheque emitido no lo
 * concilia ni lo esconde: lo describe, y pasado `transitWarnDays` vuelve a salir
 * como sospechoso.
 *
 * «Sin tipar» es una opción real y es el estado por defecto: destipar algo mal
 * tipado tiene que ser tan fácil como tiparlo.
 */
export function PendingKindSelect({
  bankAccountId,
  side,
  id,
  value,
  disabled,
}: {
  bankAccountId: string
  side: "BANCO" | "LIBROS"
  id: string
  value: PendingKind | null
  disabled?: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useState<PendingKind | null>(value)
  const [error, setError] = useState<string | null>(null)

  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label="Tipo de partida en tránsito"
        data-testid={`tipar-${id}`}
        className="rounded border bg-background px-1 py-0.5 text-xs"
        disabled={disabled || pending}
        value={current ?? ""}
        onChange={(event) => {
          const next = event.target.value === "" ? null : (event.target.value as PendingKind)
          setError(null)
          startTransition(async () => {
            const result = await typePendingAction({ bankAccountId, side, id, kind: next })
            if (result.success) setCurrent(next)
            else setError(result.error ?? "No se ha podido tipar la partida")
          })
        }}
      >
        <option value="">sin tipar</option>
        {(Object.keys(PENDING_KIND_LABEL) as PendingKind[]).map((kind) => (
          <option key={kind} value={kind}>
            {PENDING_KIND_LABEL[kind]}
          </option>
        ))}
      </select>
      {error !== null && <span className="text-[#8a6100]">{error}</span>}
    </span>
  )
}
