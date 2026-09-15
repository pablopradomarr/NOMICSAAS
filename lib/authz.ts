import { getCurrentUser } from "@/lib/auth"
import {
  ACTIVE_ORG_COOKIE,
  AuthzError,
  parseActiveOrgCookie,
  roleSatisfies,
  signActiveOrgCookie,
} from "@/lib/authz-core"
import config from "@/lib/config"
import { TenantClient, tenantDb } from "@/lib/db"
import { getMembership, getMembershipWithOrganization, getUserMemberships } from "@/models/memberships"
import { accessLevelOf, canWrite } from "@/lib/platform/subscription"
import { limitsOf } from "@/lib/platform/plan"
import { READ_ONLY_MESSAGE_ES } from "@/lib/platform/limits"
import type { AccessLevel, PlanRow, WriteKind } from "@/lib/platform/types"
import { Organization, Role, User } from "@/prisma/client"
import { ActionState } from "@/lib/actions"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

export { ACTIVE_ORG_COOKIE, AuthzError, ROLE_RANK, hasRole, roleSatisfies } from "@/lib/authz-core"
export type { AuthzErrorCode } from "@/lib/authz-core"

export type OrgContext = {
  org: Organization
  user: User
  role: Role
  db: TenantClient
  /**
   * **E11 · T11 (§3.2, §8.2; ADR-0019 D6).** Nivel efectivo de acceso según el
   * estado de la suscripción. `READ_ONLY` **no** es «sólo lectura» en el sentido
   * literal: es *mora*, y en mora siguen permitidas cuatro clases de escritura
   * (§3.2) porque la llevanza sigue siendo del cliente y nosotros no podemos
   * suspenderla por no haber cobrado.
   *
   * **Nunca `BLOCKED` por impago**: eso sólo lo produce la desactivación que
   * decide el propio ADMIN de la organización.
   */
  access: AccessLevel
  /** Motivo en español, listo para la cabecera. `null` con acceso pleno. */
  accessReason: string | null
}

/**
 * Resuelve la organización activa del usuario de la sesión.
 * La cookie NUNCA es autoridad: siempre se valida contra Membership; si no hay
 * membresía para ese par, se ignora y se cae a la primera membresía del usuario.
 * Memoizado por request.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const user = await getCurrentUser()

  const cookieStore = await cookies()
  const cookieOrgId = parseActiveOrgCookie(cookieStore.get(ACTIVE_ORG_COOKIE)?.value, user.id, config.auth.secret)

  if (cookieOrgId) {
    // E3-T2 (deuda 3 de docs/ESTADO.md): membresía + organización en UNA sola
    // transacción con GUC. Antes eran dos, cada una con su BEGIN + dos
    // set_config + COMMIT, en CADA petición.
    const membership = await getMembershipWithOrganization(cookieOrgId, user.id)
    if (membership && membership.organization.isActive) {
      const { access, reason } = await accessOf(membership.organizationId, membership.organization.isActive)
      return {
        org: membership.organization,
        user,
        role: membership.role,
        db: tenantDb(membership.organizationId),
        access,
        accessReason: reason,
      }
    }
  }

  const memberships = await getUserMemberships(user.id)
  const fallback = memberships[0]
  if (!fallback) return null

  const { access, reason } = await accessOf(fallback.organizationId, fallback.organization.isActive)
  return {
    org: fallback.organization,
    user,
    role: fallback.role,
    db: tenantDb(fallback.organizationId),
    access,
    accessReason: reason,
  }
})

/**
 * **E11 · T11** — error de mora. Se distingue de `AuthzError` a propósito: no es
 * un problema de permisos del usuario, es un problema de la suscripción, y el
 * mensaje que ve el cliente tiene que decirlo sin eufemismo.
 */
export class SubscriptionReadOnlyError extends Error {
  constructor(
    readonly op: WriteKind,
    readonly reason: string | null
  ) {
    super(reason ?? READ_ONLY_MESSAGE_ES)
    this.name = "SubscriptionReadOnlyError"
  }
}

/**
 * Guard de toda server action / RSC de negocio.
 *
 * **`READ_ONLY` se aplica en UN SOLO SITIO: aquí** (§8.2). No se reparte por
 * treinta ficheros, porque repartido es como se olvida. Cada acción declara qué
 * CLASE de escritura hace (`writeKind`) y `canWrite` decide; por omisión,
 * `ORDINARIA`, que es lo que la mora detiene.
 *
 * La asimetría de **O-16** sale de aquí sin una sola línea de caso especial:
 * `uploadFileAction` declara `REGISTRO_DOCUMENTAL` y pasa —el justificante es
 * del cliente y su conservación es su obligación (art. 30 CCom, 165 LIVA)—;
 * `analyzeFileAction` declara `CONSUMO_IA` y no pasa, porque el OCR es coste
 * variable nuestro y el asiento se puede teclear.
 *
 * @throws AuthzError NO_ORGANIZATION si el usuario no pertenece a ninguna organización activa.
 * @throws AuthzError FORBIDDEN si su rol no alcanza `minRole`.
 * @throws SubscriptionReadOnlyError si la suscripción no permite esta escritura.
 */
export async function requireOrg(
  minRole: Role = Role.VIEWER,
  options: { writeKind?: WriteKind } = {}
): Promise<OrgContext> {
  const context = await getOrgContext()
  if (!context) {
    throw new AuthzError("NO_ORGANIZATION", "El usuario no pertenece a ninguna organización activa")
  }
  if (!roleSatisfies(context.role, minRole)) {
    throw new AuthzError("FORBIDDEN", `Se requiere rol ${minRole} y el usuario tiene ${context.role}`)
  }
  // Una LECTURA nunca se comprueba contra la suscripción: consultar y exportar
  // los propios libros no se suspende jamás (ADR-0019 D6).
  if (options.writeKind && !canWrite(context.access, options.writeKind)) {
    throw new SubscriptionReadOnlyError(options.writeKind, context.accessReason)
  }
  return context
}

/**
 * Nivel de acceso de una organización, leído de su suscripción.
 *
 * Sin `Subscription` el acceso es `FULL`: I-E11-5 exige que no exista ninguna
 * así, pero el guardián no es el sitio donde enterarse. Bloquear una
 * organización por una fila de facturación que falta es exactamente lo que
 * D7 prohíbe.
 */
async function accessOf(
  organizationId: string,
  organizationIsActive: boolean,
  refDate: Date = new Date()
): Promise<{ access: AccessLevel; reason: string | null }> {
  try {
    const db = tenantDb(organizationId)
    const subscription = await db.subscription.findFirst({
      where: { organizationId },
      include: { plan: true },
    })
    if (!subscription) {
      return organizationIsActive
        ? { access: "FULL", reason: null }
        : { access: "BLOCKED", reason: "La organización está desactivada por su administrador." }
    }
    const limits = limitsOf(subscription.plan as unknown as PlanRow)
    const verdict = accessLevelOf(
      {
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        graceUntil: subscription.graceUntil,
      },
      limits,
      refDate,
      { organizationIsActive }
    )
    return { access: verdict.level, reason: verdict.reason }
  } catch {
    // Un fallo leyendo la facturación NO puede dejar a un cliente sin registrar
    // un hecho contable. Se cae del lado del acceso, no del bloqueo.
    return { access: "FULL", reason: null }
  }
}

/**
 * Fija la organización activa. Verifica la membresía ANTES de escribir la cookie.
 * Sólo puede llamarse desde una server action o route handler (escribe cookies).
 */
export async function setActiveOrg(organizationId: string, userId: string): Promise<void> {
  const membership = await getMembership(organizationId, userId)
  if (!membership) {
    throw new AuthzError("FORBIDDEN", "El usuario no pertenece a esa organización")
  }

  const cookieStore = await cookies()
  cookieStore.set(ACTIVE_ORG_COOKIE, signActiveOrgCookie(organizationId, userId, config.auth.secret), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.app.baseURL.startsWith("https://"),
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
  })
}

export async function clearActiveOrg(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(ACTIVE_ORG_COOKIE)
}

// ─────────────────────────────────────────────────────────────────────────────
// withOrg — envoltorio de server actions (E1-fix, hallazgo #24)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envuelve el cuerpo de una server action de mutación con `requireOrg(minRole)`
 * y traduce `AuthzError` a `ActionState`.
 *
 * Sin esto, un `AuthzError` se propaga como excepción no controlada: Next lo
 * convierte en el error genérico de servidor y el formulario del cliente se
 * queda sin mensaje. Con esto, quien no tiene permiso recibe
 * `{ success: false, error: "Sin permiso" }` y quien no tiene organización se va
 * a `/organizations/new`.
 *
 * Las excepciones de control de flujo de Next (`redirect()`, `notFound()`)
 * llevan la propiedad `digest` y se dejan pasar intactas.
 */
export function withOrg<Args extends unknown[], T>(
  minRole: Role,
  fn: (context: OrgContext, ...args: Args) => Promise<ActionState<T>>,
  /**
   * **E11 · T11** — clase de escritura de esta acción (§3.2). Sin declararla, la
   * acción se trata como `ORDINARIA` y la mora la detiene: el valor por defecto
   * es el restrictivo, para que una acción nueva no se cuele permitida por
   * olvido.
   */
  options: { writeKind?: WriteKind } = {}
): (...args: Args) => Promise<ActionState<T>> {
  return async (...args: Args): Promise<ActionState<T>> => {
    let context: OrgContext
    try {
      context = await requireOrg(minRole, options)
    } catch (error) {
      if (error instanceof SubscriptionReadOnlyError) {
        return { success: false, error: error.message }
      }
      if (error instanceof AuthzError) {
        if (error.code === "NO_ORGANIZATION") {
          redirect("/organizations/new")
        }
        return { success: false, error: "Sin permiso" }
      }
      throw error
    }
    return await fn(context, ...args)
  }
}
