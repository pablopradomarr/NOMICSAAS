import { AcceptInvitationButton, InviteForm } from "@/components/auth/invite-form"
import { AuthError, AuthHeadline, AuthShell } from "@/components/auth/brand"
import { invitationTokenSchema } from "@/forms/invitations"
import { getSession } from "@/lib/auth"
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/organization-options"
import { getInvitationByToken, isInvitationExpired } from "@/models/invitations"
import { getOrganizationById } from "@/models/organizations"
import { InvitationStatus } from "@/prisma/client"
import { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Invitación",
}

function InviteMessage({ title, description }: { title: string; description: string }) {
  return (
    <AuthShell>
      <AuthHeadline accent="invitación">{title}</AuthHeadline>
      <AuthError>{description}</AuthError>
      <Link
        href="/"
        className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)] underline-offset-4 hover:text-[var(--nomic-carbon)] hover:underline"
      >
        Volver al inicio
      </Link>
    </AuthShell>
  )
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return <InviteMessage title="Este enlace no es válido" description="Este enlace de invitación no tiene un formato válido." />
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation) {
    return (
      <InviteMessage
        title="No encontramos tu"
        description="El enlace no corresponde a ninguna invitación. Pide a quien te invitó que te envíe uno nuevo."
      />
    )
  }

  if (invitation.status === InvitationStatus.ACCEPTED) {
    return (
      <InviteMessage
        title="Ya usaste esta"
        description="Esta invitación ya se aceptó. Inicia sesión con normalidad para acceder a la organización."
      />
    )
  }

  if (invitation.status === InvitationStatus.REVOKED) {
    return (
      <InviteMessage
        title="Anularon tu"
        description="Quien te invitó ha anulado esta invitación. Pídele una nueva si sigues necesitando acceso."
      />
    )
  }

  if (invitation.status === InvitationStatus.EXPIRED || isInvitationExpired(invitation, new Date())) {
    return (
      <InviteMessage
        title="Caducó tu"
        description="Este enlace ha caducado. Pide a quien te invitó que vuelva a enviarlo desde Configuración → Miembros."
      />
    )
  }

  const organization = await getOrganizationById(invitation.organizationId)
  if (!organization || !organization.isActive) {
    return (
      <InviteMessage
        title="Organización no disponible"
        description="La organización que te invitó ya no está activa."
      />
    )
  }

  const session = await getSession()
  const sessionEmail = session?.user?.email?.toLowerCase()
  const roleLabel = ROLE_LABELS[invitation.role] ?? invitation.role

  return (
    <AuthShell>
      <div className="flex flex-col gap-2">
        <AuthHeadline accent={organization.name}>Te han invitado a</AuthHeadline>
        <p className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)]">
          Perfil de acceso: <strong className="text-[var(--nomic-carbon)]">{roleLabel}</strong>.{" "}
          {ROLE_DESCRIPTIONS[invitation.role]}
        </p>
      </div>

      {!sessionEmail && <InviteForm token={validated.data} email={invitation.email} roleLabel={roleLabel} />}

      {sessionEmail === invitation.email && <AcceptInvitationButton token={validated.data} />}

      {sessionEmail && sessionEmail !== invitation.email && (
        <p className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)]">
          Esta invitación es para otra dirección de correo. Has iniciado sesión como{" "}
          <strong className="text-[var(--nomic-carbon)]">{sessionEmail}</strong>: cierra sesión y entra con la
          dirección a la que se envió la invitación.
        </p>
      )}
    </AuthShell>
  )
}

export const dynamic = "force-dynamic"
