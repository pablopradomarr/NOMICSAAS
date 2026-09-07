/**
 * E13 · T5 — Chip de etiqueta en JetBrains Mono, para estados como `INVITACIÓN · EDITOR` o
 * `ENLACE CADUCADO` (§6.2). Server Component.
 */
export function ChipLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-[4px] border border-[var(--nomic-border)] px-3 py-[6px] font-[family-name:var(--font-jetbrains-mono)] text-[11px] uppercase tracking-[1px] text-[var(--nomic-carbon)]">
      {children}
    </span>
  )
}
