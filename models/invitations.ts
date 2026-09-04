import { TenantClient } from "@/lib/db"
// NOTA: la búsqueda por tokenHash ocurre ANTES de conocer la organización, por eso
// usa el cliente sin tenant. Excepción legítima a no-restricted-imports (T10).
import { prisma } from "@/lib/db"
import { Invitation, InvitationStatus, Prisma, Role } from "@/prisma/client"
import { createHash, randomBytes } from "node:crypto"

/** D-4: las invitaciones caducan a los 7 días. */
export const INVITATION_TTL_DAYS = 7

/** Token en claro: sólo viaja por email, nunca se persiste. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Pura: la fecha de referencia entra por parámetro. */
export function invitationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function isInvitationExpired(invitation: Pick<Invitation, "expiresAt">, now: Date): boolean {
  return invitation.expiresAt.getTime() <= now.getTime()
}

export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function listInvitations(db: TenantClient, status?: InvitationStatus): Promise<Invitation[]> {
  return await db.invitation.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
  })
}

export async function getInvitationById(db: TenantClient, id: string): Promise<Invitation | null> {
  return await db.invitation.findUnique({ where: { id } })
}

/**
 * Crea la invitación y devuelve el token EN CLARO junto a la fila (el token
 * sólo existe aquí y en el email; en BD vive únicamente su sha256).
 */
export async function createInvitation(
  db: TenantClient,
  input: { email: string; role: Role; invitedById: string; now: Date }
): Promise<{ invitation: Invitation; token: string }> {
  const token = generateInvitationToken()
  // organizationId lo inyecta tenantDb (barrera 1); el tipo de Prisma no lo sabe.
  const data = {
    email: normalizeInvitationEmail(input.email),
    role: input.role,
    tokenHash: hashInvitationToken(token),
    invitedById: input.invitedById,
    expiresAt: invitationExpiresAt(input.now),
    status: InvitationStatus.PENDING,
  } satisfies Omit<Prisma.InvitationUncheckedCreateInput, "organizationId">
  const invitation = await db.invitation.create({
    data: data as Prisma.InvitationUncheckedCreateInput,
  })
  return { invitation, token }
}

/** Rota el token de una invitación pendiente y reinicia la caducidad. */
export async function resendInvitation(
  db: TenantClient,
  id: string,
  now: Date
): Promise<{ invitation: Invitation; token: string }> {
  const token = generateInvitationToken()
  const invitation = await db.invitation.update({
    where: { id },
    data: {
      tokenHash: hashInvitationToken(token),
      expiresAt: invitationExpiresAt(now),
      status: InvitationStatus.PENDING,
      revokedAt: null,
    },
  })
  return { invitation, token }
}

export async function revokeInvitation(db: TenantClient, id: string, now: Date): Promise<Invitation> {
  return await db.invitation.update({
    where: { id },
    data: { status: InvitationStatus.REVOKED, revokedAt: now },
  })
}

export async function markInvitationExpired(db: TenantClient, id: string): Promise<Invitation> {
  return await db.invitation.update({ where: { id }, data: { status: InvitationStatus.EXPIRED } })
}

/** Búsqueda por token en claro; la organización aún no se conoce. */
export async function getInvitationByToken(token: string): Promise<Invitation | null> {
  return await prisma.invitation.findUnique({ where: { tokenHash: hashInvitationToken(token) } })
}

export async function markInvitationAccepted(
  db: TenantClient,
  id: string,
  acceptedById: string,
  now: Date
): Promise<Invitation> {
  return await db.invitation.update({
    where: { id },
    data: { status: InvitationStatus.ACCEPTED, acceptedAt: now, acceptedById },
  })
}
