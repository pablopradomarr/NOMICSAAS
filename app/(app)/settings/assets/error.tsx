"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/**
 * E9 · T17/T18 — Estado de error de «Inmovilizado».
 *
 * Enseña el `digest` porque es lo que permite encontrar la traza en el
 * servidor: un mensaje genérico sin identificador convierte una incidencia
 * reproducible en una anécdota.
 */
export default function AssetsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en Inmovilizado:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se ha podido cargar esta pantalla</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        El cuadro de amortización no se almacena: se deriva del activo y de sus revisiones, así que nada ha quedado a medias. Vuelva a intentarlo y, si persiste, indique el identificador del error.
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
          <Link href="/settings/assets">Volver</Link>
        </Button>
      </div>
    </div>
  )
}
