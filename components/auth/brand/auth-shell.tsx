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
 * Logo tipográfico del producto: "CFO" en carbón + "nomic" en negro, sin icono. Debajo, "de CFOnomic" en
 * gris (§6.2, "en las pantallas de auth el producto se llama NOMIC, de CFOnomic").
 */
export function AuthWordmark() {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-[family-name:var(--font-league-spartan)] text-2xl font-black tracking-[-0.02em]">
        <span className="text-[var(--nomic-carbon)]">CFO</span>
        <span className="text-[var(--nomic-black)]">nomic</span>
      </span>
      <span className="font-[family-name:var(--font-open-sans)] text-xs text-[var(--nomic-gray)]">
        de {BRAND.company}
      </span>
    </div>
  )
}
