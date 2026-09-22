import { cn } from "@/lib/utils"
import { BRAND } from "@/components/auth/brand/constants"

/**
 * E13 · T5 — Contenedor de página para el grupo `app/(auth)/`.
 *
 * Fondo blanco, columna centrada, sin card ni sombra (identidad CFOnomic, §6.2). Server Component: no hay
 * interacción aquí, sólo estructura.
 */
export function AuthShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-[var(--nomic-white)] px-6 py-16">
      <div className={cn("flex w-full max-w-[420px] flex-col gap-10", className)}>
        <AuthWordmark />
        {children}
      </div>
    </div>
  )
}

/**
 * Logo tipográfico de las pantallas de acceso, en el tratamiento canónico de la marca (brand book §4):
 * "CFO" en League Spartan Black y "nomic" en Playfair Display italic, pegados y **ambos en carbón**, no
 * en lima: dentro de `(auth)` el lima nunca lleva texto encima (§6.3, contraste AA).
 *
 * Rebranding 2026-09-22: producto y compañía son ya el MISMO nombre, así que desaparece la segunda línea
 * "de CFOnomic" — decía la marca dos veces — y en su lugar va el descriptor del producto.
 */
export function AuthWordmark() {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-baseline text-2xl leading-none">
        <span className="font-[family-name:var(--font-league-spartan)] font-black tracking-[-0.02em] text-[var(--nomic-black)]">
          CFO
        </span>
        <span className="font-[family-name:var(--font-playfair)] italic text-[var(--nomic-carbon)]">nomic</span>
      </span>
      <span className="font-[family-name:var(--font-open-sans)] text-xs text-[var(--nomic-gray)]">
        {BRAND.description}
      </span>
    </div>
  )
}
