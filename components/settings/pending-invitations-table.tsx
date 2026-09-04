"use client"

import { resendInvitationAction, revokeInvitationAction } from "@/app/(app)/settings/members/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ROLE_LABELS } from "@/lib/organization-options"
import { useState, useTransition } from "react"
import { toast } from "sonner"

export type InvitationRow = {
  id: string
  email: string
  role: string
  invitedBy: string
  expiresAt: string
}

export function PendingInvitationsTable({
  invitations,
  canManage,
}: {
  invitations: InvitationRow[]
  canManage: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)

  const onResend = (invitationId: string) => {
    startTransition(async () => {
      const formData = new FormData()
      formData.set("invitationId", invitationId)
      const result = await resendInvitationAction(null, formData)
      if (!result.success) {
        toast.error(result.error ?? "No se ha podido reenviar la invitación")
        return
      }
      if (result.data?.emailSent) {
        setInviteUrl(null)
        toast.success("Invitación reenviada por correo")
      } else {
        setInviteUrl(result.data?.inviteUrl ?? null)
        toast.success("Enlace regenerado: cópialo abajo")
      }
    })
  }

  const onRevoke = (invitationId: string) => {
    startTransition(async () => {
      const formData = new FormData()
      formData.set("invitationId", invitationId)
      const result = await revokeInvitationAction(null, formData)
      if (!result.success) {
        toast.error(result.error ?? "No se ha podido revocar la invitación")
      } else {
        setInviteUrl(null)
        toast.success("Invitación revocada")
      }
    })
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Correo</TableHead>
            <TableHead className="w-40">Perfil</TableHead>
            <TableHead className="w-56">Invitada por</TableHead>
            <TableHead className="w-40">Caduca</TableHead>
            {canManage && <TableHead className="w-52 text-right">Acciones</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.length === 0 && (
            <TableRow>
              <TableCell colSpan={canManage ? 5 : 4} className="text-muted-foreground">
                No hay invitaciones pendientes.
              </TableCell>
            </TableRow>
          )}
          {invitations.map((invitation) => (
            <TableRow key={invitation.id}>
              <TableCell className="font-medium">{invitation.email}</TableCell>
              <TableCell>{ROLE_LABELS[invitation.role] ?? invitation.role}</TableCell>
              <TableCell className="text-muted-foreground">{invitation.invitedBy}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{invitation.expiresAt}</TableCell>
              {canManage && (
                <TableCell className="space-x-2 text-right">
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => onResend(invitation.id)}>
                    Reenviar
                  </Button>
                  <Button variant="outline" size="sm" disabled={pending} onClick={() => onRevoke(invitation.id)}>
                    Revocar
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {inviteUrl && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3">
          <p className="text-sm">Sin proveedor de correo: copia el enlace y hazlo llegar a la persona invitada.</p>
          <Input
            readOnly
            value={inviteUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="font-mono text-xs"
          />
        </div>
      )}
    </div>
  )
}
