import { DocumentViewer } from "@/components/unsorted/document-viewer"
import type { DocumentFileView, RunOptionView } from "@/components/unsorted/types"
import Link from "next/link"

/**
 * E8 · T16 — Pestaña **Documento** del asiento (§6, §7).
 *
 * Es el tercer clic del drill-down: celda del informe → *(1)* detalle de líneas
 * → *(2)* asiento → *(3)* aquí, el papel con su `sha256`, la extracción que lo
 * respalda y la cadena entera a la vista.
 *
 * La cadena es la del diseño y cada eslabón tiene FK real:
 * `journal_lines → journal_entries.extraction_run_id → extraction_runs.parent_run_id
 * → extraction_runs (LLM) → files.sha256 → bytes`. Que se pueda recorrer con el
 * dedo por la pantalla es la diferencia entre decir que hay trazabilidad y
 * tenerla.
 */
export function EntryDocumentTab({
  file,
  runs,
  supportingRunId,
}: {
  file: DocumentFileView | null
  runs: readonly RunOptionView[]
  supportingRunId: string | null
}) {
  if (!file) {
    return (
      <div className="rounded-md border border-dashed px-6 py-12 text-center" data-testid="entry-document-empty">
        <p className="text-sm font-medium">Este asiento no tiene documento origen.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Los asientos manuales, los de cierre y los de liquidación analítica no nacen de un papel: su trazabilidad es
          la de quien los contabilizó y la plantilla que se usó.
        </p>
      </div>
    )
  }

  const supporting = runs.find((run) => run.id === supportingRunId) ?? null

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]" data-testid="entry-document-tab">
      <DocumentViewer file={file} pagesSent={supporting?.pagesSent ?? 0} pagesTotal={supporting?.pagesTotal ?? 1} />

      <div className="space-y-4">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold tracking-tight">Extracción que respalda el asiento</h2>
          {supporting ? (
            <dl className="grid gap-x-6 gap-y-2 rounded-md border p-3 text-sm sm:grid-cols-2">
              <Item label="Tipo de extracción" value={supporting.kind} mono />
              <Item label="Proveedor y modelo" value={`${supporting.provider} / ${supporting.model}`} />
              <Item label="Fecha" value={new Date(supporting.createdAt).toLocaleString("es-ES")} />
              <Item label="Prompt" value={supporting.promptShaShort} mono />
              <Item label="Esquema" value={supporting.schemaVersion} mono />
              <Item label="Páginas vistas" value={`${supporting.pagesSent} de ${supporting.pagesTotal}`} />
              <Item label="Veredicto" value={supporting.reconcileStatus ?? "—"} mono />
              <Item label="Identificador" value={supporting.id} mono />
            </dl>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              El asiento no referencia ninguna extracción: se contabilizó a mano o antes de E8.
            </p>
          )}
        </section>

        {runs.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold tracking-tight">Cadena de extracciones del documento</h2>
            <ol className="divide-y rounded-md border text-sm">
              {[...runs]
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((run) => (
                  <li
                    key={run.id}
                    className={run.id === supportingRunId ? "bg-muted/60 px-3 py-2" : "px-3 py-2"}
                    data-run-id={run.id}
                  >
                    <span className="font-code text-xs text-muted-foreground">#{run.ordinal}</span>{" "}
                    <span className="font-medium">{run.kind}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {run.provider}/{run.model} · {new Date(run.createdAt).toLocaleString("es-ES")}
                      {run.parentRunId ? " · revisión" : " · extracción original"}
                    </span>
                    {run.id === supportingRunId && (
                      <span className="ml-2 rounded-md bg-[#0A0A0A] px-1.5 py-0.5 text-[11px] leading-none text-white">
                        respalda el asiento
                      </span>
                    )}
                  </li>
                ))}
            </ol>
          </section>
        )}

        <Link
          href={`/unsorted/${file.id}${supportingRunId ? `?run=${supportingRunId}` : ""}`}
          className="inline-block text-sm underline underline-offset-2"
          data-testid="go-to-document-review"
        >
          Abrir la revisión de este documento →
        </Link>
      </div>
    </div>
  )
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-code text-xs break-all" : ""}>{value}</dd>
    </div>
  )
}
