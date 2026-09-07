import { cn } from "@/lib/utils"
import { InputHTMLAttributes } from "react"

type LineInputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Texto del label; siempre visible, MAYÚSCULAS por CSS, nunca sólo `placeholder` (§6.3). */
  label: string
  /** Id del `<span role="alert">` de `AuthError` asociado, si lo hay — se enlaza vía `aria-describedby`. */
  errorId?: string
}

/**
 * E13 · T5 — Input minimalista de las pantallas de acceso.
 *
 * Sin borde, sólo línea inferior 1px `--nomic-black`; en foco pasa a 2px. Fondo transparente, placeholder
 * gris. Server Component: no lleva estado propio, cualquier `onChange`/`value` los da el formulario cliente
 * que lo use.
 */
export function LineInput({ label, errorId, id, name, className, ...props }: LineInputProps) {
  const inputId = id || name

  return (
    <label htmlFor={inputId} className="flex flex-col gap-2">
      <span className="font-[family-name:var(--font-open-sans)] text-[11px] font-semibold uppercase tracking-[1px] text-[var(--nomic-carbon)]">
        {label}
      </span>
      <input
        id={inputId}
        name={name}
        aria-describedby={errorId}
        aria-invalid={errorId ? true : undefined}
        className={cn(
          "border-0 border-b border-[var(--nomic-gray)] bg-transparent px-0 py-2",
          "font-[family-name:var(--font-open-sans)] text-base text-[var(--nomic-carbon)]",
          "placeholder:text-[var(--nomic-gray)]",
          "outline-none transition-[border-color,border-width] duration-150",
          "focus-visible:border-b-2 focus-visible:border-[var(--nomic-black)]",
          className
        )}
        {...props}
      />
    </label>
  )
}
