/**
 * E2 · T6 — Registro de auditoría de configuración (§7).
 *
 * `writeAuditLog` RECIBE el `tx` de `tenantTransaction`: nunca abre transacción
 * propia. El log y la mutación viven o mueren juntos — si el log pudiera fallar
 * aparte, habría mutaciones sin rastro, que es exactamente lo que E2 existe para
 * impedir. `audit_logs` es append-only en la barrera 2 (ADR-0008).
 */

import { TenantClient, TenantTransactionClient } from "@/lib/db"
import type { AuditLog, Prisma } from "@/prisma/client"

/** Modelos auditables. Cadena porque `AuditLog.entity` es texto, no enum. */
export type AuditEntity =
  | "LedgerAccount"
  | "OrganizationAccountMap"
  | "TaxRate"
  | "Organization"
  | "Membership"
  | "Invitation"

export type AuditAction =
  | "create"
  | "update"
  | "deactivate"
  | "activate"
  | "delete"
  | "seed"
  | "import"
  | "remap"
  | "close"

export type AuditLogInput = {
  entity: AuditEntity
  entityId: string
  action: AuditAction
  before?: unknown
  after?: unknown
  reason?: string | null
  userId?: string | null
}

/** Cliente mínimo que necesita el escritor: el de `tenantTransaction` lo cumple. */
type AuditWriter = Pick<TenantTransactionClient, "auditLog" | "$organizationId">

/**
 * Serializa a JSON almacenable: `Date` → ISO, `undefined` → ausente. Sin esto,
 * Prisma rechaza un `Date` dentro de un `Json` y el log se pierde por un detalle
 * de tipos.
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (v instanceof Date ? v.toISOString() : v))
  ) as Prisma.InputJsonValue
}

export async function writeAuditLog(tx: AuditWriter, input: AuditLogInput): Promise<AuditLog> {
  return await tx.auditLog.create({
    data: {
      // `tenantDb` lo inyectaría igualmente; explícito porque el tipo de Prisma
      // lo exige y porque un valor ajeno haría saltar `TenantError` (barrera 1).
      organizationId: tx.$organizationId,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      before: toAuditJson(input.before),
      after: toAuditJson(input.after),
      reason: input.reason ?? null,
      userId: input.userId ?? null,
    },
  })
}

export type AuditLogFilter = {
  entity?: AuditEntity
  entityId?: string
  action?: AuditAction
  userId?: string
  since?: Date
  until?: Date
  take?: number
}

/** Consulta del registro (la consume la pestaña Auditoría en E7). */
export async function listAuditLog(db: TenantClient, filter: AuditLogFilter = {}): Promise<AuditLog[]> {
  return await db.auditLog.findMany({
    where: {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.since || filter.until
        ? { ts: { ...(filter.since ? { gte: filter.since } : {}), ...(filter.until ? { lte: filter.until } : {}) } }
        : {}),
    },
    orderBy: { ts: "desc" },
    take: filter.take ?? 200,
  })
}
