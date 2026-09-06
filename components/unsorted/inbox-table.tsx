"use client"

import { analyzeBatchAction, analyzeFileAction } from "@/app/(app)/unsorted/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DOC_KIND_LABEL,
  INBOX_STATUS_LABEL,
  type InboxRowView,
  type InboxStatus,
} from "@/components/unsorted/types"
import { formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T15 — Bandeja de documentos (§6, `/unsorted`).
 *
 * Una fila por fichero con el estado del **último** run, que la consulta de
 * `listInboxWithLatestRun` resuelve con un `DISTINCT ON` y sin N+1: 2.000
 * ficheros y 6.000 extracciones en una sola ida y vuelta (§9).
 *
 * La selección múltiple lleva a `/unsorted/batch`, no confirma desde aquí: el
 * lote enseña primero qué entra y qué no entra **con su porqué**, que es la
 * diferencia entre una herramienta contable y un botón de contabilizar cincuenta
 * facturas a ciegas.
 */

const STATUS_STYLE: Readonly<Record<InboxStatus, string>> = {
  SIN_ANALIZAR: "border-dashed text-muted-foreground",
  PASS: "border-transparent bg-[#0A0A0A] text-white",
  WARN: "border-[#F5A623] bg-[#F5A623]/15",
  FAIL: "border-[#F5A623] bg-[#F5A623]/25",
  PARCIAL: "border-[#F5A623] bg-[#F5A623]/10",
  IMPORTADO: "border-dashed text-muted-foreground",
}

export function InboxTable({ rows, canEdit }: { rows: readonly InboxRowView[]; canEdit: boolean }) {
  const router = useRouter()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selectable = rows.filter((row) => row.runId !== null && row.elegibleParaLote)
  const selectedRuns = rows.filter((row) => row.runId && selected.includes(row.fileId))

  const toggle = (fileId: string) =>
    setSelected((current) =>
      current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId]
    )

  const analyzeOne = (fileId: string) =>
    startTransition(async () => {
      setError(null)
      const state = await analyzeFileAction({ fileId })
      if (!state.success) setError(state.error ?? "No se ha podido analizar el documento")
      router.refresh()
    })

  const analyzePending = () =>
    startTransition(async () => {
      setError(null)
      const fileIds = rows.filter((row) => row.runId === null).map((row) => row.fileId)
      if (fileIds.length === 0) return
      const state = await analyzeBatchAction({ fileIds })
      if (!state.success) setError(state.error ?? "No se ha podido encolar el análisis")
      router.refresh()
    })

  const goToBatch = () => {
    const runIds = selectedRuns.map((row) => row.runId).filter((id): id is string => Boolean(id))
    router.push(`/unsorted/batch?runIds=${runIds.join(",")}`)
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="inbox-error">
          {error}
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={analyzePending}
            disabled={pending || rows.every((row) => row.runId !== null)}
            data-testid="analyze-all"
          >
            Analizar los pendientes
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={goToBatch}
            disabled={selectedRuns.length === 0}
            data-testid="go-to-batch"
          >
            Confirmar por lote ({selectedRuns.length})
          </Button>
          <span className="text-xs text-muted-foreground">
            Sólo entran en el lote los documentos conformes, completos y sin comprobaciones que bloqueen.{" "}
            {selectable.length} de {rows.length} lo son.
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="inbox-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {canEdit && <th className="w-8 px-2 py-2" />}
              <th className="px-3 py-2 text-left font-medium">Documento</th>
              <th className="px-3 py-2 text-left font-medium">Tipo</th>
              <th className="px-3 py-2 text-left font-medium">Nº</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-left font-medium">Extracciones</th>
              <th className="px-3 py-2 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.fileId} className="h-8" data-file-id={row.fileId} data-status={row.status}>
                {canEdit && (
                  <td className="px-2 py-1">
                    <Checkbox
                      checked={selected.includes(row.fileId)}
                      disabled={!row.elegibleParaLote || !row.runId}
                      onCheckedChange={() => toggle(row.fileId)}
                      aria-label={`Seleccionar ${row.filename}`}
                    />
                  </td>
                )}
                <td className="max-w-[22rem] px-3 py-1">
                  <Link href={`/unsorted/${row.fileId}`} className="underline-offset-2 hover:underline">
                    <span className="block truncate" title={row.filename}>
                      {row.filename}
                    </span>
                  </Link>
                  <span className="text-[11px] text-muted-foreground">
                    subido el {new Date(row.uploadedAt).toLocaleDateString("es-ES")}
                    {row.sha256 ? "" : " · sin sha256"}
                  </span>
                </td>
                <td className="px-3 py-1 text-xs">{row.docKind ? (DOC_KIND_LABEL[row.docKind] ?? row.docKind) : "—"}</td>
                <td className="px-3 py-1 font-code text-xs">{row.documentNumber ?? "—"}</td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {row.totalCents === null ? "—" : formatCents(row.totalCents, { currency: row.currency ?? "EUR" })}
                </td>
                <td className="px-3 py-1">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none",
                      STATUS_STYLE[row.status]
                    )}
                    data-testid={`status-${row.fileId}`}
                  >
                    {INBOX_STATUS_LABEL[row.status]}
                  </span>
                  {row.motivoNoElegible && (
                    <span className="ml-1 block text-[11px] text-muted-foreground">{row.motivoNoElegible}</span>
                  )}
                </td>
                <td className="px-3 py-1 text-xs text-muted-foreground">
                  {row.runCount === 0 ? "—" : `${row.runCount} · ${new Date(row.runCreatedAt ?? row.uploadedAt).toLocaleDateString("es-ES")}`}
                </td>
                <td className="px-3 py-1 text-right">
                  <div className="flex justify-end gap-1">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/unsorted/${row.fileId}`} data-testid={`review-${row.fileId}`}>
                        Revisar
                      </Link>
                    </Button>
                    {canEdit && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => analyzeOne(row.fileId)}
                        data-testid={`analyze-${row.fileId}`}
                      >
                        {row.runId ? "Reanalizar" : "Analizar"}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
