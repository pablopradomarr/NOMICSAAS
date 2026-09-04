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
import { getMembership, getUserMemberships } from "@/models/memberships"
import { getOrganizationById } from "@/models/organizations"
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
    const membership = await getMembership(cookieOrgId, user.id)
    if (membership) {
      const org = await getOrganizationById(cookieOrgId)
      if (org && org.isActive) {
        return { org, user, role: membership.role, db: tenantDb(org.id) }
      }
    }
  }

  const memberships = await getUserMemberships(user.id)
  const fallback = memberships[0]
  if (!fallback) return null

  return {
    org: fallback.organization,
    user,
    role: fallback.role,
    db: tenantDb(fallback.organizationId),
  }
})

/**
 * Guard de toda server action / RSC de negocio.
 * @throws AuthzError NO_ORGANIZATION si el usuario no pertenece a ninguna organización activa.
 * @throws AuthzError FORBIDDEN si su rol no alcanza `minRole`.
 */
export async function requireOrg(minRole: Role = Role.VIEWER): Promise<OrgContext> {
  const context = await getOrgContext()
  if (!context) {
    throw new AuthzError("NO_ORGANIZATION", "El usuario no pertenece a ninguna organización activa")
  }
  if (!roleSatisfies(context.role, minRole)) {
    throw new AuthzError("FORBIDDEN", `Se requiere rol ${minRole} y el usuario tiene ${context.role}`)
  }
  return context
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
  fn: (context: OrgContext, ...args: Args) => Promise<ActionState<T>>
): (...args: Args) => Promise<ActionState<T>> {
  return async (...args: Args): Promise<ActionState<T>> => {
    let context: OrgContext
    try {
      context = await requireOrg(minRole)
    } catch (error) {
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
