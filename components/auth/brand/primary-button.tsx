import { cn } from "@/lib/utils"
import { ButtonHTMLAttributes } from "react"

type BrandButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Texto del botón en MAYÚSCULAS por convención de marca; se muestra tal cual, en español ya en mayúsculas. */
  children: React.ReactNode
  /** Oculta la flecha `→` (p. ej. mientras el formulario está enviando). */
  hideArrow?: boolean
}

const baseButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-[6px] px-6 py-[14px] " +
  "font-[family-name:var(--font-open-sans)] text-xs font-semibold uppercase tracking-[1px] " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50"

/**
 * E13 · T5 — Botón primario CFOnomic: fondo negro, texto blanco MAYÚSCULAS, flecha `→` que se desplaza
 * 2px en `:hover`. Server Component salvo que el formulario que lo use añada `type="submit"` con estado de
 * cliente alrededor.
 */
export function PrimaryButton({ children, hideArrow, className, ...props }: BrandButtonProps) {
  return (
    <button
      className={cn(
        baseButtonClass,
        "group bg-[var(--nomic-black)] text-[var(--nomic-white)] hover:opacity-90",
        className
      )}
      {...props}
    >
      {children}
      {!hideArrow && (
        <span aria-hidden="true" className="inline-block transition-transform duration-150 group-hover:translate-x-0.5">
          →
        </span>
      )}
    </button>
  )
}

/**
 * Botón ghost: borde negro, transparente, se invierte (fondo negro, texto blanco) en `:hover`. Usado como
 * alternativa secundaria junto al `PrimaryButton` (p. ej. "Volver a entrar").
 */
export function GhostButton({ children, hideArrow, className, ...props }: BrandButtonProps) {
  return (
    <button
      className={cn(
        baseButtonClass,
        "border border-[var(--nomic-black)] bg-transparent text-[var(--nomic-black)]",
        "hover:bg-[var(--nomic-black)] hover:text-[var(--nomic-white)]",
        className
      )}
      {...props}
    >
      {children}
      {!hideArrow && (
        <span aria-hidden="true">→</span>
      )}
    </button>
  )
}
