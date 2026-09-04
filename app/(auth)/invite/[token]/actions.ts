"use server"

import { invitationTokenSchema } from "@/forms/invitations"
import { ActionState } from "@/lib/actions"
import { getSession } from "@/lib/auth"
import { setActiveOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import {
  getInvitationByToken,
  isInvitationExpired,
  markInvitationAccepted,
  markInvitationExpired,
} from "@/models/invitations"
import { createMembership, getMembership } from "@/models/memberships"
import { getOrCreateInvitedUser } from "@/models/users"
import { InvitationStatus } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

/**
 * D-3 — La invitación ES la autorización de alta: da de alta la cuenta del email
 * invitado aunque `DISABLE_SIGNUP=true`, para que el OTP de better-auth (que exige
 * usuario existente) pueda enviarse. Sólo actúa con una invitación PENDING viva.
 */
export async function prepareInvitedAccountAction(token: string): Promise<ActionState<{ email: string }>> {
  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return { success: false, error: "El enlace de invitación no es válido" }
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation || invitation.status !== InvitationStatus.PENDING) {
    return { success: false, error: "Esta invitación ya no está disponible" }
  }
  if (isInvitationExpired(invitation, new Date())) {
    return { success: false, error: "Esta invitación ha caducado" }
  }

  await getOrCreateInvitedUser(invitation.email)
  return { success: true, data: { email: invitation.email } }
}

/**
 * Acepta la invitación: crea la Membership y deja activa la organización.
 * Idempotente: si la membresía ya existe sólo marca la invitación.
 */
export async function acceptInvitationAction(token: string): Promise<ActionState<null>> {
  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return { success: false, error: "El enlace de invitación no es válido" }
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation) {
    return { success: false, error: "Esta invitación no existe" }
  }

  const now = new Date()
  const db = tenantDb(invitation.organizationId)

  if (invitation.status === InvitationStatus.ACCEPTED) {
    return { success: false, error: "Esta invitación ya se ha utilizado" }
  }
  if (invitation.status === InvitationStatus.REVOKED) {
    return { success: false, error: "Esta invitación ha sido revocada" }
  }
  if (invitation.status === InvitationStatus.EXPIRED || isInvitationExpired(invitation, now)) {
    if (invitation.status !== InvitationStatus.EXPIRED) {
      await markInvitationExpired(db, invitation.id)
    }
    return { success: false, error: "Esta invitación ha caducado" }
  }

  const session = await getSession()
  if (!session?.user) {
    return { success: false, error: "Inicia sesión con el correo invitado para aceptar la invitación" }
  }
  if (session.user.email.toLowerCase() !== invitation.email) {
    return {
      success: false,
      error: "Esta invitación es para otra dirección de correo. Entra con la dirección a la que se envió.",
    }
  }

  const existing = await getMembership(invitation.organizationId, session.user.id)
  if (!existing) {
    await createMembership({
      organizationId: invitation.organizationId,
      userId: session.user.id,
      role: invitation.role,
      invitedById: invitation.invitedById,
      now,
    })
  }
  await markInvitationAccepted(db, invitation.id, session.user.id, now)
  await setActiveOrg(invitation.organizationId, session.user.id)

  revalidatePath("/", "layout")
  redirect("/dashboard")
}
