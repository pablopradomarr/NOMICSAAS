import { Role } from "@/prisma/client"
import { createHmac, timingSafeEqual } from "node:crypto"

/**
 * Lógica pura de autorización (sin BD, sin next/headers): testeable en unitarios.
 * `lib/authz.ts` la reexporta junto a `requireOrg`.
 */

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
}

/** Jerarquía VIEWER < EDITOR < ADMIN. Reflexiva: un rol siempre se satisface a sí mismo. */
export function roleSatisfies(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole]
}

/** Alias con el nombre del diseño (§4.1). */
export const hasRole = roleSatisfies

export type AuthzErrorCode = "UNAUTHENTICATED" | "NO_ORGANIZATION" | "ORGANIZATION_INACTIVE" | "FORBIDDEN"

export class AuthzError extends Error {
  readonly code: AuthzErrorCode

  constructor(code: AuthzErrorCode, message?: string) {
    super(message ?? code)
    this.name = "AuthzError"
    this.code = code
  }
}

/** Cookie de organización activa: HttpOnly, firmada, alineada con advanced.cookiePrefix. */
export const ACTIVE_ORG_COOKIE = "taxhacker.active_org"

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

/**
 * Valor de la cookie: `<orgId>.<hmac(orgId:userId)>`. La cookie es un HINT, no una
 * credencial: `requireOrg` comprueba siempre la Membership. La firma evita que un
 * orgId manipulado llegue a la BD.
 */
export function signActiveOrgCookie(organizationId: string, userId: string, secret: string): string {
  return `${organizationId}.${sign(`${organizationId}:${userId}`, secret)}`
}

/** Devuelve el organizationId si la firma es válida para ese usuario; null si no. */
export function parseActiveOrgCookie(value: string | undefined, userId: string, secret: string): string | null {
  if (!value) return null
  const separator = value.lastIndexOf(".")
  if (separator <= 0) return null
  const organizationId = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = sign(`${organizationId}:${userId}`, secret)
  const given = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (given.length !== wanted.length) return null
  return timingSafeEqual(given, wanted) ? organizationId : null
}
