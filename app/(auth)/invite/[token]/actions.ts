"use server"

import { invitationTokenSchema } from "@/forms/invitations"
import { isPasswordTooObvious, setInvitedPasswordFormSchema } from "@/forms/auth"
import { ActionState } from "@/lib/actions"
import { getSession } from "@/lib/auth"
import { hasPassword, setUserPassword } from "@/lib/auth-password"
import { setActiveOrg } from "@/lib/authz"
import {
  INVITE_ATTEMPT_LIMIT,
  INVITE_ATTEMPT_WINDOW_MS,
  consumeRateLimit,
  pruneRateLimitBuckets,
} from "@/lib/rate-limit"
import { tenantDb } from "@/lib/db"
import { recordAuditLog } from "@/models/audit-log"
import {
  acceptInvitation,
  getInvitationByToken,
  hashInvitationToken,
  isInvitationExpired,
  isInvitationLocked,
  markInvitationExpired,
  registerFailedInvitationAttempt,
} from "@/models/invitations"
import { getOrCreateInvitedUser, updateUser } from "@/models/users"
import { InvitationStatus } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

/** Mensaje único para todos los fallos de enlace: no revela si el token existe. */
const GENERIC_INVITE_ERROR = "Este enlace de invitación no es válido o ya no está disponible"

/**
 * E1-fix (#14): rate limit por IP + token. El token nunca se usa en claro como
 * clave del cubo (acabaría en un volcado de memoria); se usa su sha256, que es
 * lo mismo que ya guarda la base de datos.
 */
async function checkInviteRateLimit(token: string): Promise<boolean> {
  const headerList = await headers()
  const forwarded = headerList.get("x-forwarded-for") ?? ""
  const ip = forwarded.split(",")[0]?.trim() || headerList.get("x-real-ip") || "unknown"
  const now = Date.now()
  pruneRateLimitBuckets(now)
  const byIp = consumeRateLimit(`invite:ip:${ip}`, INVITE_ATTEMPT_LIMIT, INVITE_ATTEMPT_WINDOW_MS, now)
  const byToken = consumeRateLimit(
    `invite:token:${hashInvitationToken(token)}`,
    INVITE_ATTEMPT_LIMIT,
    INVITE_ATTEMPT_WINDOW_MS,
    now
  )
  return byIp.allowed && byToken.allowed
}

/**
 * D-3 — La invitación ES la autorización de alta: da de alta la cuenta del email
 * invitado aunque `DISABLE_SIGNUP=true`, para que el OTP de better-auth (que exige
 * usuario existente) pueda enviarse. Sólo actúa con una invitación PENDING viva.
 *
 * La cuenta nace con `emailVerified = false` y NO se le crea membresía: sólo es
 * utilizable después de verificar el OTP y aceptar la invitación (#14).
 */
export async function prepareInvitedAccountAction(token: string): Promise<ActionState<{ email: string }>> {
  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }

  if (!(await checkInviteRateLimit(validated.data))) {
    return { success: false, error: "Demasiados intentos. Vuelve a probar dentro de unos minutos." }
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation || invitation.status !== InvitationStatus.PENDING) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }
  if (isInvitationLocked(invitation)) {
    return { success: false, error: "Esta invitación se ha bloqueado por intentos fallidos. Pide una nueva." }
  }
  if (isInvitationExpired(invitation, new Date())) {
    return { success: false, error: "Esta invitación ha caducado" }
  }

  await getOrCreateInvitedUser(invitation.email)
  return { success: true, data: { email: invitation.email } }
}

/**
 * E13 · T8 — Fija la contraseña de un invitado (§4.2). Reutiliza el guardado de
 * E1 (token, `attempts`, rate limit por IP y por hash del token) y termina con
 * `getOrCreateInvitedUser` + `setUserPassword`; el cliente hace después
 * `signIn.email` y `acceptInvitationAction(token)` — este action NO inicia
 * sesión ni acepta la invitación, sólo prepara la cuenta con contraseña.
 *
 * D-3: la invitación autoriza el alta aunque `DISABLE_SIGNUP=true` — el
 * endpoint público de alta sigue cerrado en todos los modos.
 */
export async function setInvitedPasswordAction(
  token: string,
  formData: FormData
): Promise<ActionState<{ email: string }>> {
  const validatedToken = invitationTokenSchema.safeParse(token)
  if (!validatedToken.success) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }

  if (!(await checkInviteRateLimit(validatedToken.data))) {
    return { success: false, error: "Demasiados intentos. Vuelve a probar dentro de unos minutos." }
  }

  const validatedForm = setInvitedPasswordFormSchema.safeParse(Object.fromEntries(formData))
  if (!validatedForm.success) {
    return { success: false, error: validatedForm.error.issues[0]?.message ?? "Datos inválidos" }
  }

  const invitation = await getInvitationByToken(validatedToken.data)
  if (!invitation || invitation.status !== InvitationStatus.PENDING) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }
  if (isInvitationLocked(invitation)) {
    return { success: false, error: "Esta invitación se ha bloqueado por intentos fallidos. Pide una nueva." }
  }
  if (isInvitationExpired(invitation, new Date())) {
    return { success: false, error: "Esta invitación ha caducado" }
  }

  if (isPasswordTooObvious(validatedForm.data.password, invitation.email)) {
    return { success: false, error: "Elige una contraseña que no se parezca a tu correo" }
  }

  const user = await getOrCreateInvitedUser(invitation.email, validatedForm.data.name)

  // Nunca se pisa la credencial de quien ya tiene cuenta: el enlace de
  // invitación no es una vía de toma de control (§4.2 punto 2).
  if (await hasPassword(user.id)) {
    return { success: false, error: "Ya tienes una cuenta; entra con tu contraseña" }
  }

  // El enlace llegó al buzón del invitado: eso ya prueba la posesión del correo.
  await updateUser(user.id, { name: validatedForm.data.name, emailVerified: true })
  await setUserPassword(user.id, validatedForm.data.password)

  await recordAuditLog(invitation.organizationId, {
    entity: "User",
    entityId: user.id,
    action: "password_set",
    after: { invitationId: invitation.id },
    userId: user.id,
  })

  return { success: true, data: { email: invitation.email } }
}

/**
 * Acepta la invitación: crea la Membership y marca la invitación en UNA sola
 * transacción (#15), y deja activa la organización. Idempotente gracias al
 * unique `(organization_id, user_id)`.
 */
export async function acceptInvitationAction(token: string): Promise<ActionState<null>> {
  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }

  if (!(await checkInviteRateLimit(validated.data))) {
    return { success: false, error: "Demasiados intentos. Vuelve a probar dentro de unos minutos." }
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation) {
    return { success: false, error: GENERIC_INVITE_ERROR }
  }
  if (isInvitationLocked(invitation)) {
    return { success: false, error: "Esta invitación se ha bloqueado por intentos fallidos. Pide una nueva." }
  }

  const now = new Date()

  if (invitation.status === InvitationStatus.ACCEPTED) {
    return { success: false, error: "Esta invitación ya se ha utilizado" }
  }
  if (invitation.status === InvitationStatus.REVOKED) {
    return { success: false, error: "Esta invitación ha sido revocada" }
  }
  if (invitation.status === InvitationStatus.EXPIRED || isInvitationExpired(invitation, now)) {
    // Marcar EXPIRED es una ESCRITURA: legítima aquí (server action), prohibida
    // en el RSC de la pantalla de miembros (#8).
    if (invitation.status !== InvitationStatus.EXPIRED) {
      await markInvitationExpired(tenantDb(invitation.organizationId), invitation.id)
    }
    return { success: false, error: "Esta invitación ha caducado" }
  }

  const session = await getSession()
  if (!session?.user) {
    await registerFailedInvitationAttempt(invitation.id, invitation.organizationId)
    return { success: false, error: "Inicia sesión con el correo invitado para aceptar la invitación" }
  }
  if (session.user.email.toLowerCase() !== invitation.email) {
    await registerFailedInvitationAttempt(invitation.id, invitation.organizationId)
    return {
      success: false,
      error: "Esta invitación es para otra dirección de correo. Entra con la dirección a la que se envió.",
    }
  }

  await acceptInvitation(invitation, session.user.id, now)
  await setActiveOrg(invitation.organizationId, session.user.id)

  revalidatePath("/", "layout")
  redirect("/dashboard")
}
