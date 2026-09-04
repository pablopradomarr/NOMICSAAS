"use client"

import { switchOrganizationAction } from "@/app/(app)/organizations/actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { ROLE_LABELS } from "@/lib/organization-options"
import { cn } from "@/lib/utils"
import { Building2, Check, ChevronsUpDown, Loader2, Plus, Users } from "lucide-react"
import Link from "next/link"
import { useTransition } from "react"
import { toast } from "sonner"

export type OrganizationOption = {
  id: string
  name: string
  subtitle: string
  role: string
}

export function OrgSwitcher({
  organizations,
  activeOrganizationId,
  canManageMembers,
}: {
  organizations: OrganizationOption[]
  activeOrganizationId: string
  canManageMembers: boolean
}) {
  const [pending, startTransition] = useTransition()
  const active = organizations.find((organization) => organization.id === activeOrganizationId)
  const initial = (active?.name ?? "?").trim().charAt(0).toUpperCase()

  const onSelect = (organizationId: string) => {
    if (organizationId === activeOrganizationId || pending) return
    startTransition(async () => {
      // La acción redirige al dashboard cuando tiene éxito; sólo vuelve si falla.
      const result = await switchOrganizationAction(organizationId)
      if (result && !result.success) {
        toast.error(result.error ?? "No se ha podido cambiar de organización")
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          aria-label="Cambiar de organización"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background text-sm font-semibold">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : initial}
          </span>
          <div className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate font-semibold text-sm">{active?.name ?? "Sin organización"}</span>
            <span className="truncate text-xs text-muted-foreground">{active?.subtitle ?? ""}</span>
          </div>
          <ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-lg"
        side="bottom"
        align="start"
        sideOffset={4}
      >
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Organizaciones</DropdownMenuLabel>
        {organizations.map((organization) => {
          const isActive = organization.id === activeOrganizationId
          return (
            <DropdownMenuItem
              key={organization.id}
              disabled={pending}
              onSelect={() => onSelect(organization.id)}
              className="gap-2"
            >
              <Building2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className={cn("truncate text-sm", isActive && "font-semibold")}>{organization.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {ROLE_LABELS[organization.role] ?? organization.role}
                </span>
              </div>
              {isActive && <Check className="size-4 shrink-0" aria-label="Organización activa" />}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        {canManageMembers && (
          <DropdownMenuItem asChild>
            <Link href="/settings/members" className="flex items-center gap-2">
              <Users className="size-4" />
              Miembros
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href="/organizations/new" className="flex items-center gap-2">
            <Plus className="size-4" />
            Nueva organización
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
