import { cn } from "@/lib/utils"

/**
 * Texto destacado de marca. Hasta el rebranding de 2026-09-22 era el degradado
 * naranja de TaxHacker; la paleta de CFOnomic no tiene degradados ni naranjas
 * (brand book §2: blanco + carbón + un único acento lima, y el lima NUNCA lleva
 * texto encima sobre blanco), así que es carbón sólido.
 */
export function ColoredText({
  children,
  className,
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("text-[#1A202C] font-bold tracking-[-0.01em]", className)}>
      {children}
    </span>
  )
}
