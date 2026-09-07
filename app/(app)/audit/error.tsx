"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/**
 * E7 · T12 — Estado de error de la pestaña Auditoría y de la conciliación.
 *
 * Enseña el `digest` porque es lo que permite encontrar la traza en el
 * servidor: un mensaje genérico sin identificador convierte una incidencia
 * reproducible en una anécdota.
 */
export default function AuditError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en la pestaña Auditoría:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se ha podido cargar esta pantalla</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Ni el barrido ni la conciliación han quedado a medias: las dos son transaccionales y un barrido sellado no se
        reescribe nunca. Vuelva a intentarlo y, si persiste, indique el identificador del error.
      </p>
      {error.digest && (
        <p className="mt-2 font-code text-xs">
          Identificador del error: <span className="break-all">{error.digest}</span>
        </p>
      )}
      <div className="mt-6 flex gap-2">
        <Button type="button" onClick={reset}>
          Reintentar
        </Button>
        <Button asChild variant="outline">
          <Link href="/audit">Volver a Auditoría</Link>
        </Button>
      </div>
    </div>
  )
}
