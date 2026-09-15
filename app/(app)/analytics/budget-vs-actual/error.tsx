"use client"

import { Button } from "@/components/ui/button"
import Link from "next/link"
import { useEffect } from "react"

/** E10 · T16 — Estado de error de «Presupuesto vs real». */
export default function BudgetVsActualError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Error en Presupuesto vs real:", error)
  }, [error])

  return (
    <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-10" role="alert">
      <h1 className="text-lg font-semibold">No se ha podido componer el informe</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        La matriz no se pinta a medias: o se publica entera con su sello, o no se publica. Nada ha quedado escrito —
        presupuesto y horas no generan asientos.
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
          <Link href="/analytics/pyg">Ir a la PyG analítica</Link>
        </Button>
      </div>
    </div>
  )
}
