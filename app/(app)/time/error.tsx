"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/** E10 · T17 — Estado de error de «Partes de horas». */
export default function TimeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en Partes de horas:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se han podido cargar los partes</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Los partes de horas no generan asientos: nada ha quedado a medias en el libro diario. Vuelva a intentarlo y, si
        persiste, indique el identificador del error.
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
          <Link href="/time">Volver</Link>
        </Button>
      </div>
    </div>
  )
}
