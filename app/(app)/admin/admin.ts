import "server-only"

/**
 * E12 · T13 — **quién es operador de plataforma**, y el candado de `/admin`.
 *
 * `docs/design/E12-fiabilidad-dod.md` §5.5 · ADR-0020.
 *
 * Una sola definición de `PLATFORM_ADMIN`, y vive aquí. Hasta E12 la había
 * dentro de `app/(app)/settings/subscription/actions.ts`, escondida en el
 * fichero que cambia el plan; con cuatro escrituras de operador, un predicado de
 * autorización duplicado es la forma más barata de que una de las cuatro se
 * quede sin él.
 *
 * **`404`, no `403`** (§5.5). Un `VIEWER`, `EDITOR` o `ADMIN` de organización no
 * debe poder deducir de la respuesta que la ruta existe: `403` confirma que hay
 * un panel de operador y a quién hay que atacar; `404` no dice nada. Es la misma
 * regla con la que GitHub sirve los repositorios privados.
 */

import { getCurrentUser } from "@/lib/auth"
import config from "@/lib/config"
import type { User } from "@/prisma/client"
import { notFound } from "next/navigation"
import { cache } from "react"

/**
 * ¿Es esta persona operador de plataforma?
 *
 * **Con `PLATFORM_ADMIN_EMAILS` puesta manda la lista; vacía, no lo es NADIE.**
 *
 * **DEBE #8 de la ronda 1 de E12.** Hasta aquí, con la lista vacía y facturación
 * interna, lo era *cualquier usuario autenticado*. Era una decisión escrita y
 * defendible para un self-hosted de una sola persona —quien opera y quien
 * administra son la misma—, pero el preview declaraba la variable «Opcional» y
 * allí conviven varias organizaciones: en esa instalación, cualquiera que se
 * registrara podía enumerar la plataforma entera y pedir un `reset-org`.
 *
 * El criterio pasa a ser el mismo en los dos modos, y es el que un candado debe
 * tener: **cerrado por defecto**. Quien quiera `/admin` declara quién lo abre.
 * El runbook del preview lo pide como obligatoria y el arranque avisa
 * (`warnIfNoPlatformAdmins`) si hay más de una organización no personal y nadie
 * declarado.
 */
export function isPlatformAdminEmail(email: string): boolean {
  if (config.billing.adminEmails.length === 0) return false
  return config.billing.adminEmails.includes(email.trim().toLowerCase())
}

export type PlatformAdminContext = {
  user: User
  /** Lo que se escribe en `PlatformAuditLog.actor`. Correo, no uuid: un registro
   * de operador se lee seis meses después y un uuid no dice quién fue. */
  actor: string
}

/**
 * Guard de **toda** página y **toda** server action de `/admin`.
 *
 * Memoizado por petición: la cabecera, la tabla y cada acción lo llaman, y no
 * tiene sentido resolver la sesión cuatro veces.
 *
 * @throws el `notFound()` de Next — que en una server action se traduce a la
 *   pantalla 404, no a un error de permisos con pistas dentro.
 */
export const requirePlatformAdmin = cache(async (): Promise<PlatformAdminContext> => {
  const user = await getCurrentUser()
  if (!isPlatformAdminEmail(user.email)) notFound()
  return { user, actor: user.email.trim().toLowerCase().slice(0, 64) }
})

/**
 * Variante que NO lanza, para los sitios que necesitan decidir sin abortar (el
 * enlace de la barra lateral, por ejemplo: si no eres operador, no existe).
 */
export async function platformAdminOrNull(): Promise<PlatformAdminContext | null> {
  try {
    const user = await getCurrentUser()
    if (!isPlatformAdminEmail(user.email)) return null
    return { user, actor: user.email.trim().toLowerCase().slice(0, 64) }
  } catch {
    return null
  }
}

/**
 * Aviso de arranque: **más de una organización no personal y nadie declarado
 * operador**. No falla —una instalación recién creada no tiene por qué
 * declarar nada todavía—, pero deja dicho en el log que `/admin` está cerrado y
 * por qué, que es lo contrario de descubrirlo con un 404 inexplicable.
 *
 * Se llama desde `instrumentation.ts`, una vez por arranque.
 */
export async function warnIfNoPlatformAdmins(
  contarOrganizaciones: () => Promise<number>
): Promise<string | null> {
  if (config.billing.adminEmails.length > 0) return null
  const n = await contarOrganizaciones().catch(() => 0)
  if (n <= 1) return null
  const aviso =
    `PLATFORM_ADMIN_EMAILS está vacía y hay ${n} organizaciones no personales: /admin queda CERRADO para todos ` +
    "(ADR-0020, ronda 1 de E12). Declare los correos de los operadores de plataforma para poder usarlo."
  console.warn(`[admin] ${aviso}`)
  return aviso
}
