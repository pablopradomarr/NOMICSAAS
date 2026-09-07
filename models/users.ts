// NOTA: `users` es pre-tenant a propósito (auth y perfil). Excepción legítima a
// la regla ESLint no-restricted-imports.
//
// **E7 · T14 (ADR-0015 D5).** Desde que `users` lleva RLS con políticas POR ROL,
// este modelo escribe con el cliente del camino de autenticación (`app_auth`),
// no con el de runtime: `app_runtime` ya no tiene INSERT ni DELETE sobre `users`
// y su SELECT está acotado a uno mismo y a quien comparte la organización
// activa. Las LECTURAS por identidad (`getUserById`, `getUserByEmail`) también
// van por ahí porque ocurren ANTES de haber sesión y organización.
import { tenantDb } from "@/lib/db"
import { authPrisma } from "@/lib/auth-db"
import { Prisma } from "@/prisma/client"
import { cache } from "react"
import { createOrganizationDefaults, isDatabaseEmpty } from "./defaults"
import { ensurePersonalOrganization, updateOrganization } from "./organizations"

export const SELF_HOSTED_USER = {
  email: "taxhacker@localhost",
  name: "TaxHacker",
}

/** Plan de la organización local en self-hosted (ya no vive en `users`). */
export const SELF_HOSTED_MEMBERSHIP_PLAN = "unlimited"

export const getSelfHostedUser = cache(async () => {
  if (!process.env.DATABASE_URL) {
    return null // fix for CI, do not remove
  }

  return await authPrisma.user.findFirst({
    where: { email: SELF_HOSTED_USER.email },
  })
})

export const getOrCreateSelfHostedUser = cache(async () => {
  const user = await authPrisma.user.upsert({
    where: { email: SELF_HOSTED_USER.email },
    update: SELF_HOSTED_USER,
    create: SELF_HOSTED_USER,
  })

  // E1: todo usuario necesita su organización personal (y su membresía ADMIN)
  // antes de que se creen datos de negocio.
  const organization = await ensurePersonalOrganization(user, new Date())
  if (organization.membershipPlan !== SELF_HOSTED_MEMBERSHIP_PLAN) {
    await updateOrganization(organization.id, { membershipPlan: SELF_HOSTED_MEMBERSHIP_PLAN })
  }

  return user
})

export async function getOrCreateCloudUser(
  email: string,
  data: Prisma.UserCreateInput,
  organizationData: Prisma.OrganizationUpdateInput = {}
) {
  const user = await authPrisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: data,
    create: data,
  })

  const organization = await ensurePersonalOrganization(user, new Date())
  if (Object.keys(organizationData).length > 0) {
    await updateOrganization(organization.id, organizationData)
  }

  const db = tenantDb(organization.id)
  if (await isDatabaseEmpty(db)) {
    await createOrganizationDefaults(db)
  }

  return user
}

/**
 * D-3: la invitación ES la autorización de alta, por eso este es el único punto
 * que puede crear una cuenta con `DISABLE_SIGNUP=true`. Sólo debe invocarse
 * cuando existe una invitación PENDING y no caducada para ese email.
 * A diferencia del alta cloud, NO crea organización personal: el usuario entra
 * en la organización que le invita.
 */
export async function getOrCreateInvitedUser(email: string, name?: string) {
  const normalizedEmail = email.toLowerCase()
  const existing = await authPrisma.user.findUnique({ where: { email: normalizedEmail } })
  if (existing) return existing

  // E1-fix (#14): la cuenta nace SIN verificar. better-auth marcará
  // `emailVerified` al validar el OTP; hasta entonces no es utilizable.
  return await authPrisma.user.create({
    data: { email: normalizedEmail, name: name || normalizedEmail.split("@")[0], emailVerified: false },
  })
}

export const getUserById = cache(async (id: string) => {
  return await authPrisma.user.findUnique({
    where: { id },
  })
})

export const getUserByEmail = cache(async (email: string) => {
  return await authPrisma.user.findUnique({
    where: { email: email.toLowerCase() },
  })
})

/** Sólo auth/perfil: la facturación y las cuotas viven en Organization (T11). */
export function updateUser(userId: string, data: Prisma.UserUpdateInput) {
  return authPrisma.user.update({
    where: { id: userId },
    data,
  })
}

/**
 * E13 · T12 — Cuántas sesiones de este usuario van a caer al cambiar la contraseña
 * (`revokeOtherSessions`), EXCLUYENDO la que hace el cambio. Sólo para el número que
 * queda en `AuditLog User/password_changed` (§7): nunca se borra desde aquí, eso lo
 * hace better-auth con `revokeOtherSessions: true`.
 */
export async function countOtherSessions(userId: string, excludeToken: string): Promise<number> {
  return await prisma.session.count({ where: { userId, token: { not: excludeToken } } })
}
