// NOTA: usa el cliente sin tenant a propósito (resuelve QUÉ organización tiene
// el usuario). Excepción legítima a la futura regla no-restricted-imports (T10).
import { prisma, withTenantGucs } from "@/lib/db"
import { Membership, Organization, Role } from "@/prisma/client"

export type MembershipWithOrganization = Membership & { organization: Organization }

export async function getMembership(organizationId: string, userId: string): Promise<Membership | null> {
  return await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
}

/** Membresías del usuario, la más recientemente aceptada primero. */
export async function getUserMemberships(userId: string): Promise<MembershipWithOrganization[]> {
  return await prisma.membership.findMany({
    where: { userId, organization: { isActive: true } },
    include: { organization: true },
    orderBy: [{ acceptedAt: "desc" }, { createdAt: "desc" }],
  })
}

export type MembershipWithUser = Membership & {
  user: { id: string; email: string; name: string; avatar: string | null }
}

/** Miembros con su identidad, para la tabla de `/settings/members`. */
export async function listOrganizationMembersWithUsers(organizationId: string): Promise<MembershipWithUser[]> {
  return await prisma.membership.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, email: true, name: true, avatar: true } } },
    orderBy: [{ createdAt: "asc" }],
  })
}

export async function listOrganizationMembers(organizationId: string): Promise<Membership[]> {
  return await prisma.membership.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: "asc" }],
  })
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
  return await prisma.membership.count({ where: { organizationId, role: Role.ADMIN } })
}

/** Invariante: la organización debe conservar al menos un ADMIN. */
export async function isLastAdmin(organizationId: string, userId: string): Promise<boolean> {
  const membership = await getMembership(organizationId, userId)
  if (!membership || membership.role !== Role.ADMIN) return false
  return (await countAdmins(organizationId)) <= 1
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
  const rows = await prisma.membership.findMany({
    where: { organizationId },
    select: { user: { select: { email: true } } },
  })
  return rows.map((row) => row.user.email)
}
