import { cn } from "@/lib/utils"

/**
 * E3 · T12 — Sello de validación (`sealFor` en `lib/ledger/invariants.ts`, §5).
 *
 * `VALIDADO AUTOMÁTICAMENTE` es un chip negro con el punto lima de la marca;
 * `REQUIERE REVISIÓN` es ámbar (#F5A623) y **siempre** enseña sus motivos: un
 * sello sin motivo no dice nada al que tiene que revisar.
 */

export type SealValue = "VALIDADO AUTOMÁTICAMENTE" | "REQUIERE REVISIÓN"

export type SealView = {
  sello: SealValue
  motivos: string[]
}

export function SealBadge({ seal, className }: { seal: SealView; className?: string }) {
  const validated = seal.sello === "VALIDADO AUTOMÁTICAMENTE"
  return (
    <span
      data-seal={validated ? "VALIDADO" : "REVISION"}
      title={seal.motivos.join(" · ")}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] leading-none font-semibold tracking-wide uppercase whitespace-nowrap",
        validated
          ? "bg-[#0A0A0A] text-white"
          : "border border-[#F5A623] bg-[#F5A623]/15 text-[#1A202C]",
        className
      )}
    >
      {validated ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#EAFF69]" /> : <span aria-hidden>⚠</span>}
      {seal.sello}
    </span>
  )
}

/** Sello + motivos, para la cabecera de informe. */
export function SealBlock({ seal }: { seal: SealView }) {
  return (
    <div className="flex flex-col gap-1">
      <SealBadge seal={seal} />
      {seal.motivos.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="seal-reasons">
          {seal.motivos.map((motivo) => (
            <li key={motivo}>{motivo}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
