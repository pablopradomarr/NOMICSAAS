/**
 * E13 · T3 — Envoltura de infraestructura sobre el hash de contraseña de better-auth
 * (docs/design/E13-autenticacion.md §3). `setUserPassword` es el ÚNICO punto que escribe un
 * hash, y lo hace con el hasher del propio better-auth resuelto en runtime (`auth.$context`),
 * nunca con una implementación paralela (R6): si better-auth cambia los parámetros de scrypt,
 * el login y el alta siguen coincidiendo.
 *
 * `auth` se importa de forma diferida (dentro de cada función) para romper el ciclo con
 * `lib/auth.ts`, que a su vez importa `revokeAllSessions` de este fichero para sus hooks.
 */

import { prisma } from "@/lib/db"

const CREDENTIAL_PROVIDER_ID = "credential"

async function getAuthContext() {
  const { auth } = await import("@/lib/auth")
  return auth.$context
}

/** Hashea con el hasher configurado en better-auth (scrypt por defecto). Nunca una implementación propia. */
export async function hashPassword(plain: string): Promise<string> {
  const ctx = await getAuthContext()
  return ctx.password.hash(plain)
}

/**
 * Fija la contraseña de un usuario: crea o actualiza la fila `account` con
 * `provider_id = 'credential'`. Único punto de escritura de un hash (§3).
 */
export async function setUserPassword(userId: string, plain: string): Promise<void> {
  const ctx = await getAuthContext()
  const hashed = await ctx.password.hash(plain)

  const existing = await ctx.internalAdapter.findAccountByProviderId(userId, CREDENTIAL_PROVIDER_ID)
  if (existing) {
    await ctx.internalAdapter.updatePassword(userId, hashed)
  } else {
    await ctx.internalAdapter.linkAccount({
      userId,
      accountId: userId,
      providerId: CREDENTIAL_PROVIDER_ID,
      password: hashed,
    })
  }
}

/** ¿Tiene ya el usuario una credencial de email+contraseña? */
export async function hasPassword(userId: string): Promise<boolean> {
  const ctx = await getAuthContext()
  const account = await ctx.internalAdapter.findAccountByProviderId(userId, CREDENTIAL_PROVIDER_ID)
  return Boolean(account?.password)
}

/**
 * Revoca TODAS las sesiones del usuario (S2): borra sus filas de `sessions`. `sessions` es
 * pre-tenant (sin `organization_id`), así que se usa `prisma` directo, como el resto de
 * `models/users.ts`. Devuelve el número de sesiones revocadas.
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { userId } })
  return result.count
}
