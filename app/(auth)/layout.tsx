import { X } from "lucide-react"
import Link from "next/link"
import { League_Spartan, Open_Sans, Playfair_Display } from "next/font/google"

/**
 * E13 · T5 — Fuentes de la identidad CFOnomic, sólo para el grupo `app/(auth)/`.
 *
 * El root layout (`app/layout.tsx`) ya carga JetBrains Mono como variable global; aquí no se toca. Estas
 * tres se exponen como variables CSS en el `div` raíz de este layout, así que nada fuera de `(auth)` cambia
 * (§6.2). `display: "swap"` y sólo los pesos/estilos que usa el kit de marca, para no penalizar el LCP (R7).
 */
const leagueSpartan = League_Spartan({
  subsets: ["latin"],
  weight: ["900"],
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

/**
 * Tokens de color de marca (§6.2), sólo estos cinco + el borde sutil que usa `ChipLabel`. Se declaran como
 * variables CSS inline en este mismo `div`, así que quedan fuera del alcance de `app/globals.css` y no
 * afectan a ninguna otra ruta.
 */
const nomicTokens = {
  "--nomic-white": "#FFFFFF",
  "--nomic-carbon": "#1A202C",
  "--nomic-black": "#0A0A0A",
  "--nomic-lime": "#EAFF69",
  "--nomic-gray": "#737373",
  "--nomic-border": "rgba(10,10,10,0.10)",
} as React.CSSProperties

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`min-h-screen bg-gray-900 flex flex-col relative ${leagueSpartan.variable} ${playfairDisplay.variable} ${openSans.variable}`}
      style={nomicTokens}
    >
      <Link
        href="/"
        className="absolute top-4 right-4 flex items-center justify-center w-10 h-10 rounded-full bg-gray-800 hover:bg-gray-700 transition-colors"
      >
        <span className="text-gray-300 font-bold text-xl">
          <X />
        </span>
      </Link>
      <div className="flex-grow flex flex-col justify-center items-center py-12 px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  )
}

export const dynamic = "force-dynamic"
