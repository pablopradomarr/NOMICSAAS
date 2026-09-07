/**
 * E13 · T5 — Constantes del kit de marca CFOnomic para `app/(auth)/`.
 *
 * `docs/design/E13-autenticacion.md` §4.1 prevé `config.brand = { product: "NOMIC", company: "CFOnomic" }`
 * en `lib/config.ts`, a cargo de `dev-backend` (T1), en paralelo a esta tarea. Como T1 todavía no lo ha
 * añadido, este fichero mantiene las mismas constantes en local para no bloquear T5.
 *
 * DEUDA (anotar en `docs/ESTADO.md` si sigue así al cerrar E13): en cuanto `lib/config.ts` exponga
 * `config.brand`, **T6** (que consume estos componentes en `/enter`) debe importar de ahí y este fichero
 * puede quedar sólo como reexport o eliminarse.
 */

export const BRAND = {
  /** Nombre visible del producto en las pantallas de acceso (nunca `config.app.title`, que no se toca). */
  product: "NOMIC",
  /** Pie bajo el logo: "de CFOnomic". */
  company: "CFOnomic",
} as const

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
