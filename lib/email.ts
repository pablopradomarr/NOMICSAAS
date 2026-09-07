import { NewsletterWelcomeEmail } from "@/components/emails/newsletter-welcome-email"
import { OrganizationInviteEmail } from "@/components/emails/organization-invite-email"
import { PasswordResetEmail } from "@/components/emails/password-reset-email"
import React from "react"
import { Resend } from "resend"
import config from "./config"

export const resend = new Resend(config.email.apiKey)

/** Sin Resend configurado (self-hosted) el enlace se muestra en pantalla. */
export function isEmailDeliveryEnabled(): boolean {
  return Boolean(config.email.apiKey) && !config.email.apiKey.startsWith("please-set-your")
}

/**
 * E13 · T4 — Correo de restablecimiento (§4.1). A diferencia de la invitación, el reset NO
 * enseña el enlace en pantalla si no hay Resend configurado (R3 del diseño: sería un bypass
 * de S1/S3). Sin `RESEND_API_KEY` el envío es INERTE: registra y no rompe, porque el preview
 * de hoy todavía no tiene Resend — ADR-0017 lo deja como requisito, no como bloqueo del deploy.
 * Devuelve `false` cuando no se envía nada (para que quien lo llama pueda registrar el evento
 * igualmente en `lib/auth-log.ts`, que es donde vive `reset_requested`).
 */
export async function sendPasswordResetEmail({
  email,
  resetUrl,
}: {
  email: string
  resetUrl: string
}): Promise<boolean> {
  if (!isEmailDeliveryEnabled()) {
    console.log(
      JSON.stringify({
        scope: "auth",
        event: "reset_email_skipped",
        reason: "RESEND_API_KEY no configurado",
      })
    )
    return false
  }

  const html = React.createElement(PasswordResetEmail, { resetUrl })

  await resend.emails.send({
    from: config.email.from,
    to: email,
    subject: `Restablece tu contraseña de ${config.brand.product}`,
    react: html,
  })

  return true
}

/**
 * Invitación a una organización. El token viaja SÓLO aquí y en el path del enlace
 * (nunca en query params: no debe acabar en `Referer` ni en logs de proxy).
 * Devuelve `false` si no hay proveedor de email: la UI enseña el enlace para copiarlo.
 */
export async function sendOrganizationInviteEmail({
  email,
  organizationName,
  inviterName,
  roleLabel,
  inviteUrl,
  expiresInDays,
}: {
  email: string
  organizationName: string
  inviterName: string
  roleLabel: string
  inviteUrl: string
  expiresInDays: number
}): Promise<boolean> {
  if (!isEmailDeliveryEnabled()) {
    return false
  }

  const html = React.createElement(OrganizationInviteEmail, {
    organizationName,
    inviterName,
    roleLabel,
    inviteUrl,
    expiresInDays,
  })

  await resend.emails.send({
    from: config.email.from,
    to: email,
    subject: `${inviterName} te invita a ${organizationName}`,
    react: html,
  })

  return true
}

export async function sendNewsletterWelcomeEmail(email: string) {
  const html = React.createElement(NewsletterWelcomeEmail)

  return await resend.emails.send({
    from: config.email.from,
    to: email,
    subject: "Welcome to TaxHacker Newsletter!",
    react: html,
  })
}
