import { AcceptInvitationButton, InviteLoginForm } from "@/components/auth/invite-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
    <Card className="mx-auto w-full max-w-md p-8">
      <CardHeader className="p-0">
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0 pt-6">
        <Link href="/" className="text-sm text-muted-foreground hover:underline">
          Volver al inicio
        </Link>
      </CardContent>
    </Card>
  )
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const validated = invitationTokenSchema.safeParse(token)
  if (!validated.success) {
    return <InviteMessage title="Enlace no válido" description="Este enlace de invitación no tiene un formato válido." />
  }

  const invitation = await getInvitationByToken(validated.data)
  if (!invitation) {
    return (
      <InviteMessage
        title="Invitación no encontrada"
        description="El enlace no corresponde a ninguna invitación. Pide a quien te invitó que te envíe uno nuevo."
      />
    )
  }

  if (invitation.status === InvitationStatus.ACCEPTED) {
    return (
      <InviteMessage
        title="Invitación ya utilizada"
        description="Esta invitación ya se aceptó. Inicia sesión con normalidad para acceder a la organización."
      />
    )
  }

  if (invitation.status === InvitationStatus.REVOKED) {
    return (
      <InviteMessage
        title="Invitación revocada"
        description="Quien te invitó ha anulado esta invitación. Pídele una nueva si sigues necesitando acceso."
      />
    )
  }

  if (invitation.status === InvitationStatus.EXPIRED || isInvitationExpired(invitation, new Date())) {
    return (
      <InviteMessage
        title="Invitación caducada"
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
    <Card className="mx-auto flex w-full max-w-md flex-col gap-6 p-8">
      <CardHeader className="p-0">
        <CardTitle className="text-xl">
          Te han invitado a {organization.name}
        </CardTitle>
        <CardDescription>
          Perfil de acceso: <strong>{roleLabel}</strong>. {ROLE_DESCRIPTIONS[invitation.role]}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex w-full flex-col items-start gap-4 p-0">
        {!sessionEmail && <InviteLoginForm token={validated.data} email={invitation.email} />}

        {sessionEmail === invitation.email && <AcceptInvitationButton token={validated.data} />}

        {sessionEmail && sessionEmail !== invitation.email && (
          <p className="text-sm text-muted-foreground">
            Esta invitación es para otra dirección de correo. Has iniciado sesión como{" "}
            <strong>{sessionEmail}</strong>: cierra sesión y entra con la dirección a la que se envió la invitación.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export const dynamic = "force-dynamic"
