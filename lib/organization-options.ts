/**
 * Opciones de configuración de la organización que se pintan en los selects.
 * Lista corta y explícita: la validación real vive en `forms/organizations.ts`
 * (ISO-4217 / IANA), esto es sólo la ayuda de la UI.
 */

export const BASE_CURRENCY_OPTIONS = [
  { code: "EUR", name: "EUR — Euro" },
  { code: "USD", name: "USD — Dólar estadounidense" },
  { code: "GBP", name: "GBP — Libra esterlina" },
  { code: "CHF", name: "CHF — Franco suizo" },
  { code: "MXN", name: "MXN — Peso mexicano" },
  { code: "ARS", name: "ARS — Peso argentino" },
  { code: "COP", name: "COP — Peso colombiano" },
  { code: "BRL", name: "BRL — Real brasileño" },
] as const

export const TIMEZONE_OPTIONS = [
  { code: "Europe/Madrid", name: "Europe/Madrid (peninsular)" },
  { code: "Atlantic/Canary", name: "Atlantic/Canary (Canarias)" },
  { code: "Europe/Lisbon", name: "Europe/Lisbon" },
  { code: "Europe/London", name: "Europe/London" },
  { code: "Europe/Paris", name: "Europe/Paris" },
  { code: "America/Mexico_City", name: "America/Mexico_City" },
  { code: "America/Bogota", name: "America/Bogota" },
  { code: "America/Argentina/Buenos_Aires", name: "America/Argentina/Buenos_Aires" },
  { code: "UTC", name: "UTC" },
] as const

export const PGC_VARIANT_OPTIONS = [
  { code: "PYMES", name: "PYMES — plan general abreviado" },
  { code: "GENERAL", name: "GENERAL — incluye los grupos 8 y 9" },
] as const

export const ROLE_OPTIONS = [
  { code: "VIEWER", name: "Consulta" },
  { code: "EDITOR", name: "Edición" },
  { code: "ADMIN", name: "Administración" },
] as const

export const ROLE_LABELS: Record<string, string> = {
  VIEWER: "Consulta",
  EDITOR: "Edición",
  ADMIN: "Administración",
}

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  VIEWER: "Ve toda la información sin poder modificarla.",
  EDITOR: "Registra y edita documentos y operaciones.",
  ADMIN: "Además gestiona la configuración y los usuarios.",
}
