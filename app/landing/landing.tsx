import config from "@/lib/config"
import { League_Spartan, Open_Sans, Playfair_Display } from "next/font/google"
import Link from "next/link"

/**
 * Portada pública de CFOnomic (rebranding 2026-09-22).
 *
 * La portada heredada de TaxHacker era marketing del producto ORIGINAL: features,
 * precios, capturas de pantalla, newsletter y enlaces al repositorio de vas3k. Nada
 * de eso describe este producto, así que se ha reducido a lo mínimo honesto —
 * logotipo, propuesta y acceso — siguiendo el brand book de CFOnomic: blanco +
 * carbón + un único acento lima, tipografía como protagonista y espacio en blanco.
 *
 * Nota: en `SELF_HOSTED_MODE=true` esta pantalla no llega a verse (`app/page.tsx`
 * redirige al asistente), pero es la cara pública de la instancia cloud.
 */
const leagueSpartan = League_Spartan({
  subsets: ["latin"],
  weight: ["700", "900"],
  display: "swap",
  variable: "--font-league-spartan",
})

const playfairDisplay = Playfair_Display({
  subsets: ["latin"],
  weight: ["400"],
  style: ["italic"],
  display: "swap",
  variable: "--font-playfair",
})

const openSans = Open_Sans({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--font-open-sans",
})

/** Los cinco tokens del brand book. No añadir colores fuera de esta lista. */
const brandTokens = {
  "--cfo-white": "#FFFFFF",
  "--cfo-carbon": "#1A202C",
  "--cfo-black": "#0A0A0A",
  "--cfo-lime": "#EAFF69",
  "--cfo-gray": "#737373",
  "--cfo-border": "rgba(10,10,10,0.10)",
} as React.CSSProperties

/** «CFO» en sans-serif black + «nomic» en serif italic: el logo ES la tipografía. */
function Wordmark({ onDark = false }: { onDark?: boolean }) {
  const color = onDark ? "text-[#F5F5F5]" : "text-[var(--cfo-carbon)]"
  return (
    <span className="inline-flex items-baseline text-2xl leading-none">
      <span className={`font-[family-name:var(--font-league-spartan)] font-black tracking-[-0.02em] ${color}`}>
        CFO
      </span>
      <span
        className={`font-[family-name:var(--font-playfair)] italic ${onDark ? "text-[var(--cfo-lime)]" : color}`}
      >
        nomic
      </span>
    </span>
  )
}

export default function LandingPage() {
  return (
    <div
      className={`min-h-screen flex flex-col bg-[var(--cfo-white)] text-[var(--cfo-carbon)] ${leagueSpartan.variable} ${playfairDisplay.variable} ${openSans.variable}`}
      style={brandTokens}
    >
      <header className="w-full border-b border-[var(--cfo-border)]">
        <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between px-6 py-6">
          <Link href="/" aria-label={config.app.title}>
            <Wordmark />
          </Link>
          <Link
            href="/enter"
            className="rounded-md bg-[var(--cfo-black)] px-6 py-3.5 font-[family-name:var(--font-open-sans)] text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cfo-white)] transition-opacity hover:opacity-90"
          >
            Acceder →
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col justify-center gap-10 px-6 py-24 md:py-32">
        <span className="w-fit rounded-sm border border-[var(--cfo-border)] px-3.5 py-1.5 font-code text-[11px] uppercase tracking-[0.12em] text-[var(--cfo-gray)]">
          Dirección financiera y control de negocio
        </span>

        <h1 className="max-w-[18ch] font-[family-name:var(--font-league-spartan)] text-5xl font-black leading-[0.95] tracking-[-0.03em] md:text-7xl">
          Ningún viento es{" "}
          <em className="font-[family-name:var(--font-playfair)] font-normal italic">favorable</em> para quien no sabe a{" "}
          <em className="font-[family-name:var(--font-playfair)] font-normal italic">dónde va</em>
          <span className="text-[var(--cfo-lime)]">.</span>
        </h1>

        <p className="max-w-[60ch] font-[family-name:var(--font-open-sans)] text-lg leading-relaxed text-[var(--cfo-gray)]">
          {config.app.description}. Contabilidad de partida doble sobre el PGC, analítica por proyecto, centro de coste
          y línea de negocio, y cierres que cuadran solos. Decisiones con datos, no con intuición.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/enter"
            className="rounded-md bg-[var(--cfo-black)] px-7 py-4 font-[family-name:var(--font-open-sans)] text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cfo-white)] transition-opacity hover:opacity-90"
          >
            Entrar →
          </Link>
          <a
            href={`mailto:${config.app.supportEmail}`}
            className="rounded-md border border-[var(--cfo-black)] px-7 py-4 font-[family-name:var(--font-open-sans)] text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cfo-black)] transition-colors hover:bg-[var(--cfo-black)] hover:text-[var(--cfo-white)]"
          >
            Hablar con nosotros →
          </a>
        </div>
      </main>

      <footer className="w-full bg-[var(--cfo-black)]">
        <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-6 py-16">
          <Wordmark onDark />
          <div className="h-0.5 w-[60px] bg-[#F5F5F5]" />
          <p className="font-[family-name:var(--font-open-sans)] text-sm text-[rgba(245,245,245,0.45)]">
            {config.app.description}.
          </p>
          <p className="font-[family-name:var(--font-open-sans)] text-sm text-[rgba(245,245,245,0.45)]">
            <a href={`mailto:${config.app.supportEmail}`} className="hover:text-[var(--cfo-lime)]">
              {config.app.supportEmail}
            </a>
          </p>
        </div>
      </footer>
    </div>
  )
}
