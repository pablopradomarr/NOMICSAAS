import { SettingsPageHeader } from "@/components/settings/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listAuditLog, type AuditAction, type AuditEntity } from "@/models/audit-log"
import { listOrganizationMembersWithUsers } from "@/models/memberships"
import { Role } from "@/prisma/client"
import { Metadata } from "next"
import { notFound } from "next/navigation"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = {
  title: "Auditoría de cambios",
}

const ENTITIES: { value: AuditEntity; label: string }[] = [
  { value: "LedgerAccount", label: "Cuenta contable" },
  { value: "OrganizationAccountMap", label: "Mapa de cuentas" },
  { value: "TaxRate", label: "Tipo impositivo" },
  { value: "Organization", label: "Organización" },
  { value: "Membership", label: "Miembro" },
  { value: "Invitation", label: "Invitación" },
]

const ACTIONS: { value: AuditAction; label: string }[] = [
  { value: "create", label: "Alta" },
  { value: "update", label: "Modificación" },
  { value: "deactivate", label: "Desactivación" },
  { value: "activate", label: "Reactivación" },
  { value: "delete", label: "Borrado" },
  { value: "seed", label: "Siembra del plan" },
  { value: "import", label: "Importación" },
  { value: "remap", label: "Remapeo de clave" },
  { value: "close", label: "Cierre de vigencia" },
  { value: "invite", label: "Invitación" },
  { value: "revoke", label: "Revocación" },
  { value: "leave", label: "Baja voluntaria" },
]

const timestamp = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

/** Resumen legible de un `before`/`after` sin volcar el JSON entero. */
function summarize(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value !== "object") return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null && item !== undefined && typeof item !== "object")
    .slice(0, 4)
  if (entries.length === 0) return "—"
  return entries.map(([field, item]) => `${field}: ${String(item)}`).join(" · ")
}

/**
 * E2 · T11 — Registro de auditoría de configuración (§7). Sólo ADMIN.
 *
 * Es de sólo lectura, pero no es información inocua: el registro contiene los
 * `before`/`after` completos de la configuración fiscal y contable, los motivos
 * que escribió cada administrador y quién hizo cada cambio. Enseñárselo a un
 * VIEWER o a un EDITOR es una fuga de información de gobierno, no una función
 * de consulta (revisión, hallazgo 5). Se responde `notFound()` en vez de 403
 * para no confirmar siquiera que la página existe.
 */
export default tenantPage<{ searchParams: Promise<{ entity?: string; action?: string; userId?: string }> }>(async ({ db, org, role, searchParams }) => {
  if (role !== Role.ADMIN) notFound()
  const filters = await searchParams

  const entity = ENTITIES.find((option) => option.value === filters.entity)?.value
  const action = ACTIONS.find((option) => option.value === filters.action)?.value
  const members = await listOrganizationMembersWithUsers(org.id)
  const userId = members.some((membership) => membership.userId === filters.userId) ? filters.userId : undefined

  const logs = await listAuditLog(db, { entity, action, userId, take: 200 })
  const nameByUserId = new Map(members.map((m) => [m.userId, m.user.name || m.user.email]))

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Auditoría de cambios"
        description="Toda mutación de configuración deja rastro: quién, cuándo, qué cambió y por qué. El registro no se puede modificar ni borrar."
      />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Entidad</span>
          <select
            name="entity"
            defaultValue={entity ?? ""}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Todas</option>
            {ENTITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Acción</span>
          <select
            name="action"
            defaultValue={action ?? ""}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Todas</option>
            {ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Autor</span>
          <select
            name="userId"
            defaultValue={userId ?? ""}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Cualquiera</option>
            {members.map((membership) => (
              <option key={membership.userId} value={membership.userId}>
                {membership.user.name || membership.user.email}
              </option>
            ))}
          </select>
        </label>

        <Button type="submit" variant="outline" size="sm">
          Filtrar
        </Button>
      </form>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Fecha</TableHead>
              <TableHead>Entidad</TableHead>
              <TableHead>Acción</TableHead>
              <TableHead>Autor</TableHead>
              <TableHead>Antes</TableHead>
              <TableHead>Después</TableHead>
              <TableHead>Motivo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No hay cambios registrados con esos filtros.
                </TableCell>
              </TableRow>
            )}
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell className="font-code text-xs">{timestamp.format(log.ts)}</TableCell>
                <TableCell>
                  {ENTITIES.find((option) => option.value === log.entity)?.label ?? log.entity}
                  <span className="ml-2 font-code text-xs text-muted-foreground">{log.entityId.slice(0, 8)}</span>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {ACTIONS.find((option) => option.value === log.action)?.label ?? log.action}
                  </Badge>
                </TableCell>
                <TableCell>{log.userId ? (nameByUserId.get(log.userId) ?? "—") : "Sistema"}</TableCell>
                <TableCell className="max-w-64 truncate text-xs" title={JSON.stringify(log.before)}>
                  {summarize(log.before)}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs" title={JSON.stringify(log.after)}>
                  {summarize(log.after)}
                </TableCell>
                <TableCell className="max-w-64 truncate text-sm">{log.reason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-sm text-muted-foreground">Se muestran los 200 cambios más recientes.</p>
    </div>
  )
})
