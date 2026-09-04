"use server"

import { invitationIdSchema, inviteMemberFormSchema } from "@/forms/invitations"
import { changeMemberRoleFormSchema, removeMemberFormSchema } from "@/forms/memberships"
import { ActionState } from "@/lib/actions"
import { clearActiveOrg, withOrg } from "@/lib/authz"
import config from "@/lib/config"
import { sendOrganizationInviteEmail } from "@/lib/email"
import { ROLE_LABELS } from "@/lib/organization-options"
import {
  INVITATION_TTL_DAYS,
  buildInvitationUrl,
  createInvitation,
  getInvitationById,
  normalizeInvitationEmail,
  resendInvitation,
  revokeInvitation,
} from "@/models/invitations"
import { recordAuditLog } from "@/models/audit-log"
import {
  countAdmins,
  getMembership,
  removeMembership,
  updateMembershipRole,
} from "@/models/memberships"
import { getUserByEmail } from "@/models/users"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const MEMBERS_PATH = "/settings/members"

export type InviteResult = {
  /** Enlace de aceptación; sólo se devuelve cuando no hay proveedor de email. */
  inviteUrl?: string
  emailSent: boolean
}

/** T14 — invitar a un miembro. Sólo ADMIN. */
export async function inviteMemberAction(
  _prevState: ActionState<InviteResult> | null,
  formData: FormData
): Promise<ActionState<InviteResult>> {
  return await withOrg(Role.ADMIN, async ({ db, org, user }) => {
  const validated = inviteMemberFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  const email = normalizeInvitationEmail(validated.data.email)

  // ¿Ya es miembro? No se invita dos veces a la misma persona.
  const invitedUser = await getUserByEmail(email)
  if (invitedUser && (await getMembership(org.id, invitedUser.id))) {
    return { success: false, error: "Esa persona ya es miembro de la organización" }
  }

  // Sólo puede haber una invitación PENDING viva por (organización, email):
  // se revoca la anterior antes de crear la nueva (índice parcial único).
  const pending = await db.invitation.findFirst({ where: { email, status: "PENDING" } })
  if (pending) {
    await revokeInvitation(db, pending.id, new Date())
  }

  const { invitation, token } = await createInvitation(db, {
    email,
    role: validated.data.role,
    invitedById: user.id,
    now: new Date(),
  })

  const inviteUrl = buildInvitationUrl(config.app.baseURL, token)
  let emailSent = false
  try {
    emailSent = await sendOrganizationInviteEmail({
      email,
      organizationName: org.name,
      inviterName: user.name || user.email,
      roleLabel: ROLE_LABELS[invitation.role] ?? invitation.role,
      inviteUrl,
      expiresInDays: INVITATION_TTL_DAYS,
    })
  } catch {
    emailSent = false
  }

  // E2 · T11 — el registro de auditoría existe desde E2: se cierra el TODO.
  await recordAuditLog(org.id, {
    entity: "Invitation",
    entityId: invitation.id,
    action: "invite",
    before: null,
    after: { email, role: invitation.role, emailSent },
    userId: user.id,
  })
  revalidatePath(MEMBERS_PATH)
  return { success: true, data: { emailSent, inviteUrl: emailSent ? undefined : inviteUrl } }
  })()
}

/** Rota el token y reinicia la caducidad. Sólo ADMIN. */
export async function resendInvitationAction(
  _prevState: ActionState<InviteResult> | null,
  formData: FormData
): Promise<ActionState<InviteResult>> {
  return await withOrg(Role.ADMIN, async ({ db, org, user }) => {
  const validated = invitationIdSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: "Invitación no encontrada" }
  }

  const existing = await getInvitationById(db, validated.data.invitationId)
  if (!existing || existing.status === "ACCEPTED") {
    return { success: false, error: "Esa invitación ya no se puede reenviar" }
  }

  const { invitation, token } = await resendInvitation(db, existing.id, new Date())
  const inviteUrl = buildInvitationUrl(config.app.baseURL, token)

  let emailSent = false
  try {
    emailSent = await sendOrganizationInviteEmail({
      email: invitation.email,
      organizationName: org.name,
      inviterName: user.name || user.email,
      roleLabel: ROLE_LABELS[invitation.role] ?? invitation.role,
      inviteUrl,
      expiresInDays: INVITATION_TTL_DAYS,
    })
  } catch {
    emailSent = false
  }

  revalidatePath(MEMBERS_PATH)
  return { success: true, data: { emailSent, inviteUrl: emailSent ? undefined : inviteUrl } }
  })()
}

/** REVOKED es terminal. Sólo ADMIN. */
export async function revokeInvitationAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.ADMIN, async ({ db, org, user }): Promise<ActionState<null>> => {
  const validated = invitationIdSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: "Invitación no encontrada" }
  }

  const existing = await getInvitationById(db, validated.data.invitationId)
  if (!existing) {
    return { success: false, error: "Invitación no encontrada" }
  }
  if (existing.status === "ACCEPTED") {
    return { success: false, error: "Esa invitación ya se ha aceptado" }
  }

  await revokeInvitation(db, existing.id, new Date())
  await recordAuditLog(org.id, {
    entity: "Invitation",
    entityId: existing.id,
    action: "revoke",
    before: { email: existing.email, role: existing.role, status: existing.status },
    after: { status: "REVOKED" },
    userId: user.id,
  })
  revalidatePath(MEMBERS_PATH)
  return { success: true }
  })()
}

/** Invariante: la organización debe conservar al menos un ADMIN. */
export async function changeMemberRoleAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.ADMIN, async ({ org, user: actor }): Promise<ActionState<null>> => {
  const validated = changeMemberRoleFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  const membership = await getMembership(org.id, validated.data.userId)
  if (!membership) {
    return { success: false, error: "Esa persona no es miembro de la organización" }
  }
  if (membership.role === validated.data.role) {
    return { success: true }
  }
  if (membership.role === Role.ADMIN && validated.data.role !== Role.ADMIN && (await countAdmins(org.id)) <= 1) {
    return { success: false, error: "La organización debe conservar al menos un administrador" }
  }

  await updateMembershipRole(org.id, validated.data.userId, validated.data.role)
  await recordAuditLog(org.id, {
    entity: "Membership",
    entityId: validated.data.userId,
    action: "update",
    before: { role: membership.role },
    after: { role: validated.data.role },
    userId: actor.id,
  })
  revalidatePath(MEMBERS_PATH)
  revalidatePath("/", "layout")
  return { success: true }
  })()
}

/** Baja de un miembro. Exige motivo (queda en AuditLog en E2). */
export async function removeMemberAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.ADMIN, async ({ org, user: actor }): Promise<ActionState<null>> => {
  const validated = removeMemberFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  const membership = await getMembership(org.id, validated.data.userId)
  if (!membership) {
    return { success: false, error: "Esa persona no es miembro de la organización" }
  }
  if (membership.role === Role.ADMIN && (await countAdmins(org.id)) <= 1) {
    return { success: false, error: "La organización debe conservar al menos un administrador" }
  }

  await removeMembership(org.id, validated.data.userId)
  await recordAuditLog(org.id, {
    entity: "Membership",
    entityId: validated.data.userId,
    action: "delete",
    before: { role: membership.role },
    after: null,
    reason: validated.data.reason,
    userId: actor.id,
  })
  revalidatePath(MEMBERS_PATH)
  revalidatePath("/", "layout")
  return { success: true }
  })()
}

/**
 * Baja voluntaria de la organización activa (E1-fix, hallazgo #26).
 *
 * Cualquier miembro puede irse (VIEWER incluido), pero se mantiene el invariante
 * "toda organización conserva al menos un ADMIN": el último administrador debe
 * nombrar a otro antes de salir. Al salir se limpia la cookie de organización
 * activa; `requireOrg` recalculará la siguiente membresía en el próximo request,
 * o mandará a `/organizations/new` si ya no queda ninguna (#9).
 *
 * DESVIACIÓN respecto al diseño (§6.7): el contrato es "salgo YO de la
 * organización activa", sin parámetros — no admite `membershipId` de terceros,
 * para eso está `removeMemberAction` (ADMIN). Anotado en
 * docs/design/E1-organizaciones-roles.md §"Desviaciones aceptadas".
 */
export async function leaveOrganizationAction(): Promise<ActionState<null>> {
  return await withOrg(Role.VIEWER, async ({ org, user, role }): Promise<ActionState<null>> => {
    if (role === Role.ADMIN && (await countAdmins(org.id)) <= 1) {
      return {
        success: false,
        error: "Eres el único administrador: nombra a otro antes de salir de la organización",
      }
    }

    await removeMembership(org.id, user.id)
    // El log se escribe ANTES de soltar la organización activa: después, la
    // cookie ya no apunta a ella.
    await recordAuditLog(org.id, {
      entity: "Membership",
      entityId: user.id,
      action: "leave",
      before: { role },
      after: null,
      userId: user.id,
    })
    await clearActiveOrg()

    revalidatePath(MEMBERS_PATH)
    revalidatePath("/", "layout")
    return { success: true }
  })()
}
