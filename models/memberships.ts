// NOTA: resuelve QUÉ organización tiene el usuario, así que no puede pasar por
// `tenantDb(orgId)`. Desde E3-T2 TODA operación va dentro de `withTenantGucs`
// con los GUC correctos: la política de `memberships` (ADR-0009 §2.5) autoriza
// `user_id = app.current_user()` para el switcher y `organization_id =
// app.current_org()` para la pantalla de miembros. Sin GUC no se ve nada.
// Este fichero ya no importa el cliente sin tenant.
import { withTenantGucs } from "@/lib/db"
import { Membership, Organization, Role } from "@/prisma/client"

export type MembershipWithOrganization = Membership & { organization: Organization }

export async function getMembership(organizationId: string, userId: string): Promise<Membership | null> {
  return await withTenantGucs(organizationId, userId, async (tx) =>
    tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
  )
}

/**
 * Membresía + organización en UNA sola transacción con GUC (deuda 3 de
 * `docs/ESTADO.md`): `getOrgContext` hacía dos viajes a la base por petición,
 * cada uno con su `BEGIN` + dos `set_config` + `COMMIT`.
 *
 * Devuelve `null` si el usuario no es miembro o si la organización no existe;
 * el llamante decide qué hacer con una organización inactiva.
 */
export async function getMembershipWithOrganization(
  organizationId: string,
  userId: string
): Promise<MembershipWithOrganization | null> {
  return await withTenantGucs(organizationId, userId, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: true },
    })
    return membership
  })
}

/** Membresías del usuario, la más recientemente aceptada primero. */
export async function getUserMemberships(userId: string): Promise<MembershipWithOrganization[]> {
  return await withTenantGucs(null, userId, async (tx) =>
    tx.membership.findMany({
      where: { userId, organization: { isActive: true } },
      include: { organization: true },
      orderBy: [{ acceptedAt: "desc" }, { createdAt: "desc" }],
    })
  )
}

export type MembershipWithUser = Membership & {
  user: { id: string; email: string; name: string; avatar: string | null }
}

/** Miembros con su identidad, para la tabla de `/settings/members`. */
export async function listOrganizationMembersWithUsers(organizationId: string): Promise<MembershipWithUser[]> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true, name: true, avatar: true } } },
      orderBy: [{ createdAt: "asc" }],
    })
  )
}

export async function listOrganizationMembers(organizationId: string): Promise<Membership[]> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "asc" }],
    })
  )
}

/**
 * Alta de membresía con `app.current_user` fijado: la política RLS de
 * `memberships` admite la fila porque es del propio usuario (aceptación de
 * invitación) o porque la organización es la activa.
 */
export async function createMembership(input: {
  organizationId: string
  userId: string
  role: Role
  invitedById?: string | null
  now: Date
}): Promise<Membership> {
  return await withTenantGucs(input.organizationId, input.userId, async (tx) =>
    tx.membership.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
        invitedById: input.invitedById ?? null,
        acceptedAt: input.now,
      },
    })
  )
}

export async function countAdmins(organizationId: string): Promise<number> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.count({ where: { organizationId, role: Role.ADMIN } })
  )
}

/**
 * Invariante: la organización debe conservar al menos un ADMIN.
 *
 * E3-T2: membresía y recuento comparten UNA transacción con GUC en lugar de dos.
 */
export async function isLastAdmin(organizationId: string, userId: string): Promise<boolean> {
  return await withTenantGucs(organizationId, userId, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    })
    if (!membership || membership.role !== Role.ADMIN) return false
    return (await tx.membership.count({ where: { organizationId, role: Role.ADMIN } })) <= 1
  })
}

export async function updateMembershipRole(
  organizationId: string,
  userId: string,
  role: Role
): Promise<Membership> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    })
  )
}

export async function removeMembership(organizationId: string, userId: string): Promise<Membership> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.delete({
      where: { organizationId_userId: { organizationId, userId } },
    })
  )
}

/** Emails de los miembros: los necesita el cálculo de cuota de disco (T11). */
export async function listOrganizationMemberEmails(organizationId: string): Promise<string[]> {
  const rows = await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.membership.findMany({
      where: { organizationId },
      select: { user: { select: { email: true } } },
    })
  )
  return rows.map((row) => row.user.email)
}
