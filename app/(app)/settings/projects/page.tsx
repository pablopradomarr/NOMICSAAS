/**
 * E4 · D-E4-1 — `/settings/projects` queda sustituido por `/analytics/projects`.
 *
 * El CRUD heredado de TaxHacker (en inglés, sin línea de negocio, sin estado ni
 * presupuesto) no puede crear un proyecto válido desde E4: `businessLineId` es
 * NOT NULL y el proyecto es ahora la dimensión analítica, no una etiqueta. La
 * ruta se conserva como redirección permanente para no romper enlaces guardados
 * ni el histórico del navegador; la pantalla nueva la construye T13.
 */

import { redirect, permanentRedirect } from "next/navigation"

export default function ProjectsSettingsPage(): never {
  permanentRedirect("/analytics/projects")
  // Inalcanzable: `permanentRedirect` lanza. Queda por si el runtime cambia.
  redirect("/analytics/projects")
}
