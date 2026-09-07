import config from "@/lib/config"

/**
 * E13 · T5/T6 — Constantes del kit de marca CFOnomic para `app/(auth)/`.
 *
 * `lib/config.ts` ya expone `config.brand = { product: "NOMIC", company: "CFOnomic" }` (T1), así que
 * `BRAND` es un simple reexport tipado en vez de duplicar los literales (deuda de T5 cerrada en T6).
 */
export const BRAND = config.brand

/**
 * Tokens de color de marca — sólo estos cinco (§6.2). No añadir colores fuera de esta lista dentro de
 * `app/(auth)/`. Se exponen también como variables CSS (`--nomic-*`) en `app/(auth)/layout.tsx`; estas
 * constantes existen para el caso en que un componente necesite el valor en JS (p. ej. `metadata`).
 */
export const NOMIC_COLORS = {
  white: "#FFFFFF",
  carbon: "#1A202C",
  black: "#0A0A0A",
  lime: "#EAFF69",
  gray: "#737373",
} as const
