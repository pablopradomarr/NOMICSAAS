import { exportHref } from "@/app/(app)/reports/shared"

/**
 * E6 · T15/T16 — Botón "Exportar" de la cabecera de informe.
 *
 * Tres enlaces al route handler `/reports/<tipo>/export`, que sirve el binario
 * de un run **ya emitido**: no recalcula nada, exporta la foto congelada, que
 * es lo único que el sello acredita. Los tres formatos arrastran las hojas de
 * «Procedencia» y «Validación» y las notas al pie del informe.
 */
export function ExportLinks({ type, runId }: { type: string; runId: string }) {
  const formats = ["csv", "xlsx", "pdf"] as const
  return (
    <div className="flex items-center gap-1" data-testid="export-links">
      <span className="pr-1 text-xs text-muted-foreground">Exportar</span>
      {formats.map((format) => (
        <a
          key={format}
          href={exportHref(type, runId, format)}
          data-testid={`export-${format}`}
          className="rounded-md border px-2 py-1 text-xs font-medium uppercase hover:bg-muted"
        >
          {format}
        </a>
      ))}
    </div>
  )
}
