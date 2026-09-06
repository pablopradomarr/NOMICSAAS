"use client"

import { analyzeFileAction } from "@/app/(app)/unsorted/actions"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T15 — Analizar (o reanalizar) el documento desde su ficha.
 *
 * Reanalizar **no pisa nada**: escribe una extracción nueva y la anterior sigue
 * ahí, en el selector, con su proveedor, su prompt y su veredicto. Es la misma
 * regla que hace que corregir a mano cree una revisión en vez de editar el run.
 */
export function AnalyzeDocumentButton({ fileId, hasRuns }: { fileId: string; hasRuns: boolean }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const analyze = () =>
    startTransition(async () => {
      setError(null)
      const state = await analyzeFileAction({ fileId })
      if (!state.success) {
        setError(state.error ?? "No se ha podido analizar el documento")
        return
      }
      if (state.data?.runId) router.push(`/unsorted/${fileId}?run=${state.data.runId}`)
      router.refresh()
    })

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" onClick={analyze} disabled={pending} data-testid="analyze-document">
        {pending ? "Analizando…" : hasRuns ? "Volver a analizar" : "Analizar documento"}
      </Button>
      {error && (
        <p className="max-w-xs text-right text-xs" role="alert" data-testid="analyze-error">
          {error}
        </p>
      )}
    </div>
  )
}
