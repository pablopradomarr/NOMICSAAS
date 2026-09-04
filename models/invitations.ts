import { TenantClient } from "@/lib/db"
// NOTA: la búsqueda por tokenHash ocurre ANTES de conocer la organización, por eso
// usa el cliente sin tenant. Excepción legítima a no-restricted-imports (T10).
import { prisma, withTenantGucs } from "@/lib/db"
import { INVITATION_MAX_ATTEMPTS } from "@/lib/rate-limit"
import { Invitation, InvitationStatus, Membership, Prisma, Role } from "@/prisma/client"
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

/** El token viaja por PATH, nunca por query: no debe acabar en `Referer` ni en logs. */
export function buildInvitationUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/invite/${token}`
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

/**
 * Invitaciones PENDING todavía vivas a fecha `now`.
 *
 * E1-fix (#8): la pantalla de miembros es un Server Component y NO puede
 * escribir en la base de datos, así que la caducidad se aplica FILTRANDO en la
 * lectura. Marcar `EXPIRED` es responsabilidad de las server actions
 * (`revokeInvitationAction`, `acceptInvitationAction`) y de la limpieza
 * periódica.
 */
export async function listLiveInvitations(db: TenantClient, now: Date): Promise<Invitation[]> {
  return await db.invitation.findMany({
    where: { status: InvitationStatus.PENDING, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  })
}

/** Una invitación bloqueada por intentos fallidos ya no se puede aceptar (#14). */
export function isInvitationLocked(invitation: Pick<Invitation, "attempts">): boolean {
  return invitation.attempts >= INVITATION_MAX_ATTEMPTS
}

/**
 * Suma un intento fallido de aceptación. Se hace con el cliente sin tenant
 * porque en el momento del fallo puede que aún no haya organización activa.
 */
export async function registerFailedInvitationAttempt(invitationId: string): Promise<void> {
  await prisma.invitation.update({
    where: { id: invitationId },
    data: { attempts: { increment: 1 } },
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

/**
 * Aceptación ATÓMICA de una invitación (E1-fix #15): membresía + marca de
 * aceptada en la MISMA transacción, con `app.current_user` fijado para que RLS
 * autorice ambas escrituras.
 *
 * Antes eran tres pasos sueltos: un fallo entre medias dejaba al usuario dentro
 * de la organización con la invitación aún PENDING (reutilizable). La condición
 * de carrera de dos aceptaciones simultáneas la resuelve el unique
 * `(organization_id, user_id)` de `memberships`: la segunda choca, se captura
 * P2002 y se trata como idempotente.
 */
export async function acceptInvitation(
  invitation: Invitation,
  userId: string,
  now: Date
): Promise<{ membership: Membership; invitation: Invitation }> {
  return await withTenantGucs(invitation.organizationId, userId, async (tx) => {
    let membership: Membership
    try {
      membership = await tx.membership.create({
        data: {
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          invitedById: invitation.invitedById,
          acceptedAt: now,
        },
      })
    } catch (error) {
      // P2002 = violación del unique compuesto: ya era miembro. Idempotente.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        membership = await tx.membership.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
        })
      } else {
        throw error
      }
    }

    const updated = await tx.invitation.update({
      where: { id: invitation.id, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.ACCEPTED, acceptedAt: now, acceptedById: userId },
    })

    return { membership, invitation: updated }
  })
}
