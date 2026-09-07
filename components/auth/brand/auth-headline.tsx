/**
 * E13 · T5 — Titular de las pantallas de acceso.
 *
 * League Spartan 900 (`letter-spacing: -2%`), con UNA palabra de acento en Playfair Display italic y el
 * punto final en lima. Ej.: *"Entra en tu **contabilidad**."* con "contabilidad" en itálica y el punto en
 * lima (§6.2). Server Component: es texto estático, sin interacción.
 */
export function AuthHeadline({
  children,
  accent,
  className,
}: {
  /** Texto antes de la palabra de acento (sin el punto final, que añade el propio componente). */
  children: React.ReactNode
  /** La única palabra en Playfair Display italic. */
  accent: string
  className?: string
}) {
  return (
    <h1
      className={
        "font-[family-name:var(--font-league-spartan)] text-3xl font-black leading-tight tracking-[-0.02em] text-[var(--nomic-carbon)] sm:text-4xl" +
        (className ? ` ${className}` : "")
      }
    >
      {children}{" "}
      <em className="font-[family-name:var(--font-playfair)] italic font-normal">{accent}</em>
      <span aria-hidden="true" className="text-[var(--nomic-lime)]">
        .
      </span>
    </h1>
  )
}
