"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/**
 * E9 · T16 — Estado de error del asistente de cierre.
 *
 * Lo primero que dice es lo que más tranquiliza a quien está cerrando: **nada ha
 * quedado a medias**. El cierre es una transacción única —los doce asientos
 * entran todos o no entra ninguno— y un `ClosingRun` sellado no se reescribe. El
 * `digest` va a la vista porque es lo que permite encontrar la traza.
 */
export default function ClosingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en el asistente de cierre:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se ha podido cargar el asistente de cierre</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Ningún asiento del cierre ha quedado a medias: los doce se postean en una sola transacción y un
        <span className="font-code"> ClosingRun</span> sellado no se reescribe. Vuelva a intentarlo y, si persiste,
        indique el identificador del error.
      </p>
      {error.digest && (
        <p className="font-code mt-2 text-xs">
          Identificador del error: <span className="break-all">{error.digest}</span>
        </p>
      )}
      <div className="mt-6 flex gap-2">
        <Button type="button" onClick={reset}>
          Reintentar
        </Button>
        <Button asChild variant="outline">
          <Link href="/ledger">Volver al libro diario</Link>
        </Button>
      </div>
    </div>
  )
}
