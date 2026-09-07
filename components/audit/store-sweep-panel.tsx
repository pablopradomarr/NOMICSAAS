"use client"

import { cancelStoreSweepAction, runStoreSweepAction, sweepStatusAction } from "@/app/(app)/audit/actions"
import { Button } from "@/components/ui/button"
import { fechaHoraUtc } from "@/lib/dates-ui"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import type { SweepView } from "./types"

/**
 * E7 · T12 — §Almacén: barrido de integridad del almacén de ficheros (ADMIN).
 *
 * El progreso llega por **SSE** desde `/api/progress/<id>` —el canal ES el id
 * del barrido, porque `progress.id` es un `uuid` y no admite prefijo textual—.
 * Cuando el canal se cierra se relee el estado con `sweepStatusAction`, que es
 * quien tiene los hallazgos: el progreso dice «por dónde va», el barrido dice
 * «qué ha encontrado», y ninguno de los dos se deduce del otro.
 *
 * `filesTotal`, `filesOk`, `filesMissing` y `filesAltered` los cuenta el
 * trabajador en servidor. Aquí no se suma nada.
 */

const STATUS_LABEL: Record<SweepView["status"], string> = {
  RUNNING: "En marcha",
  DONE: "Terminado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
}

const FINDING_LABEL: Record<string, string> = {
  MISSING: "El fichero no está en el almacén",
  ALTERED: "Los bytes no coinciden con el sha256 registrado",
  UNREADABLE: "No se ha podido leer",
  NO_SHA: "La ficha no tiene sha256",
}

const megas = (bytes: number): string => `${(bytes / 1024 / 1024).toLocaleString("es-ES", { maximumFractionDigits: 1 })} MB`

export function StoreSweepPanel({ initial, canSweep }: { initial: SweepView | null; canSweep: boolean }) {
  const router = useRouter()
  const [sweep, setSweep] = useState<SweepView | null>(initial)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const [pending, start] = useTransition()
  const sourceRef = useRef<EventSource | null>(null)

  const refresh = async (id: string): Promise<void> => {
    const state = await sweepStatusAction({ id })
    if (state.success && state.data) setSweep(state.data as unknown as SweepView)
  }

  const listen = (id: string): void => {
    sourceRef.current?.close()
    const source = new EventSource(`/api/progress/${id}?type=store-sweep`)
    sourceRef.current = source
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { current: number; total: number }
        setProgress({ current: data.current, total: data.total })
        if (data.total > 0 && data.current >= data.total) {
          source.close()
          void refresh(id)
        }
      } catch {
        source.close()
      }
    }
    source.onerror = () => {
      source.close()
      void refresh(id)
    }
  }

  useEffect(() => {
    if (initial?.status === "RUNNING") listen(initial.id)
    return () => sourceRef.current?.close()
    // Sólo al montar: reengancharse en cada render abriría un canal por render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sweepNow = (): void => {
    start(async () => {
      const state = await runStoreSweepAction()
      if (!state.success || !state.data) {
        toast.error(state.success ? "El barrido no ha arrancado" : state.error)
        return
      }
      setProgress({ current: 0, total: 0 })
      await refresh(state.data.sweepId)
      listen(state.data.progressId)
      toast.success("Barrido del almacén en marcha")
      router.refresh()
    })
  }

  const cancel = (): void => {
    if (!sweep) return
    start(async () => {
      const state = await cancelStoreSweepAction({ id: sweep.id })
      if (!state.success || !state.data) {
        toast.error(state.success ? "No se ha podido cancelar" : state.error)
        return
      }
      setSweep(state.data as unknown as SweepView)
      toast.success("Cancelación pedida: el barrido para entre lote y lote")
    })
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : sweep && sweep.filesTotal > 0
        ? Math.round(((sweep.filesOk + sweep.filesMissing + sweep.filesAltered) / sweep.filesTotal) * 100)
        : 0

  return (
    <section className="space-y-3" data-testid="store-sweep">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Almacén de documentos</h2>
        {canSweep && (
          <div className="flex gap-2">
            {sweep?.status === "RUNNING" && (
              <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={pending} data-testid="cancel-sweep">
                Cancelar
              </Button>
            )}
            <Button type="button" size="sm" onClick={sweepNow} disabled={pending} data-testid="run-store-sweep">
              {pending ? "…" : "Barrer el almacén"}
            </Button>
          </div>
        )}
      </div>

      {sweep === null ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="sweep-empty">
          El almacén no se ha barrido nunca. Hasta que se barra, I-E7-8 no puede dar PASS: nadie ha comprobado que los
          bytes de cada documento sigan siendo los que su ficha dice.
        </p>
      ) : (
        <div className="rounded-md border p-3">
          <p className="text-sm">
            <span data-testid="sweep-status">{STATUS_LABEL[sweep.status]}</span> · {sweep.filesTotal} fichero(s) ·{" "}
            {sweep.filesOk} correcto(s) · {sweep.filesMissing} ausente(s) · {sweep.filesAltered} alterado(s) ·{" "}
            {megas(sweep.bytesRead)} leídos
          </p>
          <p className="text-xs text-muted-foreground">
            Comenzado {fechaHoraUtc(sweep.startedAt)}
            {sweep.finishedAt ? ` · terminado ${fechaHoraUtc(sweep.finishedAt)}` : ""}
          </p>

          {sweep.status === "RUNNING" && (
            <div className="mt-2" data-testid="sweep-progress">
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                <div className="h-full bg-[#0A0A0A]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {progress ? `${progress.current} de ${progress.total}` : "preparando"} · {percent}%
              </p>
            </div>
          )}

          {sweep.findings.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Sin hallazgos.</p>
          ) : (
            <div className="mt-2 max-h-64 overflow-y-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left font-medium">Hallazgo</th>
                    <th className="p-2 text-left font-medium">Fichero</th>
                    <th className="p-2 text-left font-medium">sha256 registrado</th>
                  </tr>
                </thead>
                <tbody>
                  {sweep.findings.map((finding) => (
                    <tr key={`${finding.fileId}-${finding.kind}`} className="border-t">
                      <td className="p-2">{FINDING_LABEL[finding.kind] ?? finding.kind}</td>
                      <td className="p-2">
                        <a href={`/unsorted/${finding.fileId}`} className="underline underline-offset-2">
                          {finding.path}
                        </a>
                      </td>
                      <td className="font-code p-2 text-muted-foreground">{(finding.expected ?? "—").slice(0, 12)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sweep.findingsOverflow > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Y {sweep.findingsOverflow} hallazgo(s) más, por encima de la cota de mil que guarda el barrido.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
