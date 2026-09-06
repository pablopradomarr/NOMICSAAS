import { cn } from "@/lib/utils"

/**
 * E3 · T12 — Badges de confianza (`.claude/skills/ui-erp` §Badges).
 *
 * Toda cifra que la pantalla enseña lleva de dónde sale. Los cinco niveles son
 * los de `Confidence` en `lib/ledger/provenance.ts`, sin inventar ninguno:
 *
 * - `calculado` — la ha calculado el motor sobre el diario.
 * - `comprobado` — además ha pasado sus invariantes.
 * - `validado` — contrastada contra la fuente (documento, extracto).
 * - `interpretacion_ia` — propuesta de un modelo, sin confirmar.
 * - `no_verificado` — feedback de pantalla, no cifra contable.
 *
 * **E8 · T15 (O-20.1)** añade el cuarto nivel del camino documental,
 * `verificado`: «leído del documento y coincidente con el recálculo
 * determinista». Es la distinción que un auditor busca primero y la que
 * `lib/extraction/types.ts` sella en `Confidence`; no sustituye a `comprobado`
 * (invariantes del diario) ni a `validado` (contraste con la fuente), que son
 * los del motor contable de E3 y siguen significando lo mismo.
 *
 * Sin rojo/verde semáforo: la marca es negro, gris, hielo y lima.
 */

export type ConfidenceLevel =
  | "calculado"
  | "comprobado"
  | "validado"
  | "verificado"
  | "interpretacion_ia"
  | "no_verificado"

const LEVELS: Record<ConfidenceLevel, { label: string; className: string; dot?: boolean }> = {
  calculado: {
    label: "calculado",
    className: "border-transparent bg-muted text-muted-foreground",
  },
  comprobado: {
    label: "✓ comprobado automáticamente",
    className: "border-transparent bg-[#0A0A0A] text-white",
  },
  validado: {
    label: "✓ validado contra fuente",
    className: "border-transparent bg-[#0A0A0A] text-white",
    dot: true,
  },
  verificado: {
    label: "✓ verificado",
    className: "border-transparent bg-[#0A0A0A] text-white",
  },
  interpretacion_ia: {
    label: "interpretación IA",
    className: "border-transparent bg-[#EDF2F7] text-[#1A202C] italic",
  },
  no_verificado: {
    label: "no verificado",
    className: "border-dashed border-muted-foreground/60 text-muted-foreground",
  },
}

export function ConfidenceBadge({
  level,
  label,
  title,
  className,
}: {
  level: ConfidenceLevel
  /** Sustituye al texto por defecto (p. ej. "vista previa"). */
  label?: string
  title?: string
  className?: string
}) {
  const spec = LEVELS[level]
  return (
    <span
      data-confidence={level}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        spec.className,
        className
      )}
    >
      {spec.dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#EAFF69]" />}
      {label ?? spec.label}
    </span>
  )
}
