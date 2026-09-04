"use client"

import { changeMemberRoleAction, removeMemberAction } from "@/app/(app)/settings/members/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { ROLE_LABELS, ROLE_OPTIONS } from "@/lib/organization-options"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useState, useTransition } from "react"
import { toast } from "sonner"

export type MemberRow = {
  userId: string
  name: string
  email: string
  role: string
  memberSince: string
  isLastAdmin: boolean
  isCurrentUser: boolean
}

const LAST_ADMIN_HINT = "La organización debe conservar al menos un administrador"

export function MembersTable({ members, canManage }: { members: MemberRow[]; canManage: boolean }) {
  return (
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nombre</TableHead>
            <TableHead>Correo</TableHead>
            <TableHead className="w-52">Perfil</TableHead>
            <TableHead className="w-40">Miembro desde</TableHead>
            {canManage && <TableHead className="w-28 text-right">Acciones</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 && (
            <TableRow>
              <TableCell colSpan={canManage ? 5 : 4} className="text-muted-foreground">
                Todavía no hay miembros.
              </TableCell>
            </TableRow>
          )}
          {members.map((member) => (
            <MemberTableRow key={member.userId} member={member} canManage={canManage} />
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  )
}

function MemberTableRow({ member, canManage }: { member: MemberRow; canManage: boolean }) {
  const [pending, startTransition] = useTransition()
  const [role, setRole] = useState(member.role)
  const locked = member.isLastAdmin

  const onRoleChange = (nextRole: string) => {
    const previous = role
    setRole(nextRole)
    startTransition(async () => {
      const formData = new FormData()
      formData.set("userId", member.userId)
      formData.set("role", nextRole)
      const result = await changeMemberRoleAction(null, formData)
      if (!result.success) {
        setRole(previous)
        toast.error(result.error ?? "No se ha podido cambiar el perfil")
      } else {
        toast.success("Perfil actualizado")
      }
    })
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        {member.name || "—"}
        {member.isCurrentUser && <span className="ml-2 text-xs text-muted-foreground">(tú)</span>}
      </TableCell>
      <TableCell className="text-muted-foreground">{member.email}</TableCell>
      <TableCell>
        {canManage ? (
          locked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block">
                  <Select value={role} disabled>
                    <SelectTrigger className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLE_OPTIONS.map((option) => (
                        <SelectItem key={option.code} value={option.code}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </span>
              </TooltipTrigger>
              <TooltipContent>{LAST_ADMIN_HINT}</TooltipContent>
            </Tooltip>
          ) : (
            <Select value={role} onValueChange={onRoleChange} disabled={pending}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.code} value={option.code}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        ) : (
          <span className="text-sm">{ROLE_LABELS[member.role] ?? member.role}</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">{member.memberSince}</TableCell>
      {canManage && (
        <TableCell className="text-right">
          {locked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-block">
                  <Button variant="outline" size="sm" disabled>
                    Quitar
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{LAST_ADMIN_HINT}</TooltipContent>
            </Tooltip>
          ) : (
            <RemoveMemberDialog member={member} />
          )}
        </TableCell>
      )}
    </TableRow>
  )
}

function RemoveMemberDialog({ member }: { member: MemberRow }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  const onSubmit = (formData: FormData) => {
    formData.set("userId", member.userId)
    startTransition(async () => {
      const result = await removeMemberAction(null, formData)
      if (!result.success) {
        toast.error(result.error ?? "No se ha podido quitar al miembro")
      } else {
        setOpen(false)
        toast.success("Miembro dado de baja")
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Quitar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action={onSubmit}>
          <DialogHeader>
            <DialogTitle>Quitar a {member.name || member.email}</DialogTitle>
            <DialogDescription>
              Perderá el acceso a la organización. Indica el motivo: queda registrado junto a la acción.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-1">
            <label htmlFor={`reason-${member.userId}`} className="text-sm font-medium">
              Motivo
            </label>
            <Textarea id={`reason-${member.userId}`} name="reason" required minLength={3} maxLength={280} rows={3} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Quitando…" : "Quitar miembro"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
