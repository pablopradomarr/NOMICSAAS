"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/**
 * E10 · T15 — Estado de error del editor de presupuesto y de su diff.
 *
 * Enseña el `digest` porque es lo que permite encontrar la traza en el
 * servidor. Y dice lo único que importa saber al usuario en ese momento: nada
 * ha quedado a medias — el guardado de celdas y el sellado son transaccionales,
 * y una versión sellada no se reescribe nunca.
 */
export default function BudgetError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en el presupuesto:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se ha podido cargar el presupuesto</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Ningún cambio ha quedado a medias: el guardado por lotes y el sellado son transaccionales, y una versión sellada
        es inmutable. Vuelva a intentarlo y, si persiste, indique el identificador del error.
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
          <Link href="/analytics/budget">Volver al presupuesto</Link>
        </Button>
      </div>
    </div>
  )
}
