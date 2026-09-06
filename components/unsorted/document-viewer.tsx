"use client"

import { Button } from "@/components/ui/button"
import type { DocumentFileView } from "@/components/unsorted/types"
import { DOCUMENT_STATUS_HEADER, DOCUMENT_UNAVAILABLE } from "@/lib/previews/unavailable"
import { formatBytes } from "@/lib/utils"
import Link from "next/link"
import { useEffect, useState } from "react"

/**
 * E8 · T15 — Visor del documento (panel izquierdo de `/unsorted/[fileId]`).
 *
 * Enseña **el papel**, que es la fuente contra la que se contrasta todo lo
 * demás, con su `sha256` a la vista: la cadena `journal_lines →
 * journal_entries.extraction_run_id → extraction_runs → files.sha256 → bytes`
 * sólo sirve si quien revisa puede ver el último eslabón.
 *
 * Las páginas se piden a `/files/preview/<id>?page=N`, que las genera en el
 * servidor. El contador dice cuántas vio el modelo de cuántas tiene el
 * documento: cuatro de nueve es una extracción parcial y eso cambia lo que se
 * puede hacer con ella.
 */
export function DocumentViewer({
  file,
  pagesSent,
  pagesTotal,
}: {
  file: DocumentFileView
  pagesSent: number
  pagesTotal: number
}) {
  const total = Math.max(pagesTotal, 1)
  const [page, setPage] = useState(1)
  const [failed, setFailed] = useState(false)
  /**
   * **BUG-E8-2.** «La ficha existe y los bytes no» es un estado propio, y la
   * pantalla tiene que decirlo: antes la ruta devolvía un 404 silencioso, el
   * `onError` del `<img>` pintaba «no se ha podido componer la vista previa» y
   * ofrecía descargar un documento que tampoco estaba. Se pregunta a la ruta
   * —una `HEAD`, sin traerse la imagen— y se distingue el caso.
   */
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetch(`/files/preview/${file.id}?page=${page}`, { method: "HEAD" })
      .then((response) => {
        if (cancelled) return
        setUnavailable(response.headers.get(DOCUMENT_STATUS_HEADER) === DOCUMENT_UNAVAILABLE)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [file.id, page])

  return (
    <div className="space-y-3" data-testid="document-viewer">
      <div className="flex min-h-[420px] items-center justify-center overflow-hidden rounded-md border bg-muted/20 p-2">
        {unavailable ? (
          <div
            className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-6 text-center text-sm text-amber-900"
            data-testid="document-unavailable"
            data-notice="DOCUMENTO_NO_DISPONIBLE"
          >
            <p className="font-medium">El documento no está disponible en el almacén.</p>
            <p>
              La ficha de <span className="font-code">{file.filename}</span> existe —con su{" "}
              <span className="font-code">sha256</span> registrado— pero sus bytes no están en la ruta registrada.
              Vuelva a subirlo: hasta entonces el invariante <span className="font-code">I-E8-2</span> marca en FAIL el
              asiento que se apoye en él, y la vista previa no se puede componer.
            </p>
          </div>
        ) : failed ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            <p>No se ha podido componer la vista previa de esta página.</p>
            <p>
              El documento sigue estando:{" "}
              <Link href={`/files/download/${file.id}`} className="underline underline-offset-2">
                descargarlo
              </Link>
              .
            </p>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- la vista previa
             la sirve una ruta propia que genera la página bajo demanda; el
             optimizador de `next/image` no puede cachearla por página. */
          <img
            key={page}
            src={`/files/preview/${file.id}?page=${page}`}
            alt={`${file.filename}, página ${page} de ${total}`}
            className="max-h-[70vh] w-full object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => {
              setFailed(false)
              setPage((current) => Math.max(1, current - 1))
            }}
          >
            ← Anterior
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="viewer-page">
            Página {page} de {total}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page >= total}
            onClick={() => {
              setFailed(false)
              setPage((current) => Math.min(total, current + 1))
            }}
          >
            Siguiente →
          </Button>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link href={`/files/download/${file.id}`}>Descargar original</Link>
        </Button>
      </div>

      <dl className="grid gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Fichero</dt>
          <dd className="truncate text-right" title={file.filename}>
            {file.filename}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Tipo</dt>
          <dd>{file.mimetype}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Tamaño</dt>
          <dd>{file.sizeBytes ? formatBytes(file.sizeBytes) : "—"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Páginas analizadas</dt>
          <dd data-testid="pages-analyzed">
            {pagesSent} de {pagesTotal}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">sha256 del documento</dt>
          <dd className="font-code break-all" data-testid="file-sha256">
            {file.sha256 ?? "sin calcular"}
          </dd>
        </div>
      </dl>
    </div>
  )
}
