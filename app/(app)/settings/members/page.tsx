import { InviteMemberForm } from "@/components/settings/invite-member-form"
import { MemberRow, MembersTable } from "@/components/settings/members-table"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { InvitationRow, PendingInvitationsTable } from "@/components/settings/pending-invitations-table"
import { Separator } from "@/components/ui/separator"
import { AuthzError, requireOrg } from "@/lib/authz"
import { listLiveInvitations } from "@/models/invitations"
import { listOrganizationMembersWithUsers } from "@/models/memberships"
import { Role } from "@/prisma/client"
import { Metadata } from "next"
import { notFound } from "next/navigation"

export const metadata: Metadata = {
  title: "Miembros",
}

const dateFormatter = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })

function formatDate(date: Date | null): string {
  return date ? dateFormatter.format(date) : "—"
}

export default async function MembersSettingsPage() {
  // E1-fix (#7): la lista de miembros expone nombres, correos y las direcciones
  // invitadas. Es información de administración: un VIEWER no debe verla, y se
  // responde 404 (no 403) para no confirmar siquiera que la pantalla existe.
  let context
  try {
    context = await requireOrg(Role.ADMIN)
  } catch (error) {
    if (error instanceof AuthzError) notFound()
    throw error
  }
  const { db, org, user } = context

  const members = await listOrganizationMembersWithUsers(org.id)
  const adminCount = members.filter((membership) => membership.role === Role.ADMIN).length

  // E1-fix (#8): un Server Component NO escribe en la base de datos. La
  // caducidad se aplica FILTRANDO por `expiresAt` en la lectura; marcar EXPIRED
  // es cosa de las server actions.
  const live = await listLiveInvitations(db, new Date())

  const nameByUserId = new Map(members.map((membership) => [membership.userId, membership.user.name || membership.user.email]))

  const memberRows: MemberRow[] = members.map((membership) => ({
    userId: membership.userId,
    name: membership.user.name,
    email: membership.user.email,
    role: membership.role,
    memberSince: formatDate(membership.acceptedAt ?? membership.createdAt),
    isLastAdmin: membership.role === Role.ADMIN && adminCount <= 1,
    isCurrentUser: membership.userId === user.id,
  }))

  const invitationRows: InvitationRow[] = live.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedBy: nameByUserId.get(invitation.invitedById) ?? "—",
    expiresAt: formatDate(invitation.expiresAt),
  }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Miembros"
        description="Quién tiene acceso a esta organización y con qué perfil. La autorización se comprueba siempre en el servidor."
      />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Miembros de {org.name}</h3>
        <MembersTable members={memberRows} canManage />
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Invitaciones pendientes</h3>
        <PendingInvitationsTable invitations={invitationRows} canManage />
      </section>

      <Separator />
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Invitar a alguien</h3>
        <InviteMemberForm />
      </section>
    </div>
  )
}
