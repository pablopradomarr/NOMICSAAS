import { NewsletterWelcomeEmail } from "@/components/emails/newsletter-welcome-email"
import { OrganizationInviteEmail } from "@/components/emails/organization-invite-email"
import { OTPEmail } from "@/components/emails/otp-email"
import React from "react"
import { Resend } from "resend"
import config from "./config"

export const resend = new Resend(config.email.apiKey)

/** Sin Resend configurado (self-hosted) el enlace se muestra en pantalla. */
export function isEmailDeliveryEnabled(): boolean {
  return Boolean(config.email.apiKey) && !config.email.apiKey.startsWith("please-set-your")
}

export async function sendOTPCodeEmail({ email, otp }: { email: string; otp: string }) {
  const html = React.createElement(OTPEmail, { otp })

  return await resend.emails.send({
    from: config.email.from,
    to: email,
    subject: "Your TaxHacker verification code",
    react: html,
  })
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
