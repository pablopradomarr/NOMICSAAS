import { ConfidenceBadge, type ConfidenceLevel } from "@/components/ui/confidence-badge"
import type { FieldOriginView } from "@/components/unsorted/types"
import { cn } from "@/lib/utils"

/**
 * E8 · T15 — **Los cuatro badges de confianza** por campo (§6, O-20.1).
 *
 * `reconcile()` clasifica cada campo de la propuesta en uno de cuatro niveles y
 * los sella en `ExtractionRun.fieldOrigins`. Aquí sólo se traducen a la chapa
 * que ya usa el resto del producto:
 *
 * | Nivel del motor     | Badge                    | Qué significa |
 * |---------------------|--------------------------|---------------|
 * | `calculado`         | `calculado` (gris)       | Lo derivó el código, no el documento (p. ej. la base de un ticket con IVA incluido) |
 * | `verificado`        | `✓ verificado` (negro)   | Leído del documento **y** coincidente con el recálculo determinista |
 * | `interpretacion_ia` | `interpretación IA`      | Lo leyó el modelo y nadie lo ha contrastado |
 * | `no_verificado`     | `no verificado` (raya)   | Ni comprobado ni asumido por nadie: no respalda un asiento sin motivo |
 *
 * Un nivel desconocido cae a `no_verificado` a propósito: si el motor añadiera
 * uno, la pantalla debe pecar de prudente y no de optimista.
 */

const LEVEL_BY_CONFIDENCE: Readonly<Record<string, ConfidenceLevel>> = {
  calculado: "calculado",
  verificado: "verificado",
  comprobado: "comprobado",
  validado: "validado",
  interpretacion_ia: "interpretacion_ia",
  no_verificado: "no_verificado",
}

const ORIGIN_LABEL: Readonly<Record<string, string>> = {
  llm: "modelo",
  usuario: "usuario",
  calculado: "motor",
  catalogo: "catálogo",
  importado: "importado",
}

export function confidenceLevelOf(confidence: string | undefined | null): ConfidenceLevel {
  return LEVEL_BY_CONFIDENCE[confidence ?? ""] ?? "no_verificado"
}

/**
 * Chip de origen + badge de confianza de un campo. El `title` lleva la
 * comprobación que lo respalda y el texto crudo que el modelo leyó, que es lo
 * que un auditor pide a continuación.
 */
export function FieldConfidence({
  origin,
  className,
}: {
  origin: FieldOriginView | undefined
  className?: string
}) {
  if (!origin) {
    return (
      <span className={cn("inline-flex items-center gap-1", className)} data-field-confidence="sin-sellar">
        <ConfidenceBadge level="no_verificado" label="sin sellar" title="El motor no ha sellado la procedencia de este campo." />
      </span>
    )
  }

  const level = confidenceLevelOf(origin.confidence)
  const detail = [
    origin.check ? `Comprobación ${origin.check}` : null,
    origin.rawText ? `Leído: «${origin.rawText}»` : null,
    origin.page ? `Página ${origin.page}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}
      data-field-confidence={origin.confidence}
      data-field-origin={origin.origin}
    >
      <span className="rounded border border-dashed px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {ORIGIN_LABEL[origin.origin] ?? origin.origin}
      </span>
      <ConfidenceBadge level={level} title={detail || undefined} />
    </span>
  )
}

/** Etiqueta + badge, la unidad que el formulario repite en cada campo. */
export function FieldLabel({
  label,
  htmlFor,
  origin,
  help,
}: {
  label: string
  htmlFor?: string
  origin?: FieldOriginView | undefined
  help?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </label>
        <FieldConfidence origin={origin} />
      </div>
      {help && <p className="text-[11px] leading-snug text-muted-foreground">{help}</p>}
    </div>
  )
}
