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
import { isInternalBilling } from "@/lib/platform/billing"
import type { User } from "@/prisma/client"
import { notFound } from "next/navigation"
import { cache } from "react"

/**
 * ¿Es esta persona operador de plataforma?
 *
 * Con `PLATFORM_ADMIN_EMAILS` puesta, manda la lista —y es lo que se espera de
 * una instalación de verdad—. Vacía:
 *
 *  · en modo **INTERNO**, lo es cualquier usuario autenticado de la instalación:
 *    quien opera y quien administra son la misma persona, y exigir una variable
 *    de entorno para poder desbloquear un `PeriodLock` sería un candado sin
 *    cerradura en el único escenario en el que la llave y la puerta son de la
 *    misma mano;
 *  · en modo **`stripe`**, **nadie**. Ahí hay clientes de verdad, y un panel de
 *    operador abierto por omisión sería el fallo más caro de esta épica.
 */
export function isPlatformAdminEmail(email: string): boolean {
  if (config.billing.adminEmails.length > 0) {
    return config.billing.adminEmails.includes(email.trim().toLowerCase())
  }
  return isInternalBilling(config.billing.provider)
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
