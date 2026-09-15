/**
 * E11 · ola A · T15 — acceso al catálogo de planes.
 *
 * `plans` es **catálogo GLOBAL** (§9.5): `ENABLE` + `FORCE` con `SELECT` abierto
 * y `RESTRICTIVE … USING (false)` en escritura para `app_runtime`. **Lo cambia
 * una migración**, así que aquí no hay ni un `INSERT` ni un `UPDATE`: si esta
 * capa pudiera escribirlo, el catálogo dejaría de ser versionado y auditable.
 *
 * Se lee con `$queryRaw` sobre el cliente de tenant: la tabla no tiene
 * `organization_id`, de modo que un delegado acotado le inyectaría un filtro por
 * una columna inexistente (el aviso de ADR-0014 D7). El SQL crudo no pasa por la
 * extensión, y la política de `SELECT` abierto es la que autoriza la lectura.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { limitsOf, resolvePlanAt } from "@/lib/platform/plan"
import type { PlanLimits, PlanRow } from "@/lib/platform/types"

type PlanDbRow = {
  id: string
  code: string
  name: string
  description: string
  list_price_cents: number
  currency: string
  interval: "MONTH" | "YEAR"
  stripe_price_id: string | null
  max_members: number
  max_ocr_docs_month: number
  max_storage_bytes: bigint
  max_exports_month: number
  max_backups_month: number
  max_organizations: number
  soft_max_entries_month: number
  grace_days: number
  backup_retention_days: number
  is_public: boolean
  valid_from: Date
  valid_to: Date | null
}

function toPlanRow(r: PlanDbRow): PlanRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    listPriceCents: r.list_price_cents,
    currency: r.currency,
    interval: r.interval,
    stripePriceId: r.stripe_price_id,
    isPublic: r.is_public,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    maxMembers: r.max_members,
    maxOcrDocsMonth: r.max_ocr_docs_month,
    maxStorageBytes: r.max_storage_bytes,
    maxExportsMonth: r.max_exports_month,
    maxBackupsMonth: r.max_backups_month,
    maxOrganizations: r.max_organizations,
    softMaxEntriesMonth: r.soft_max_entries_month,
    graceDays: r.grace_days,
    backupRetentionDays: r.backup_retention_days,
  }
}

type AnyTenantClient = TenantClient | TenantTransactionClient

/** El catálogo entero, para `resolvePlanAt` y `planCatalogHash`. */
export async function listPlans(db: AnyTenantClient): Promise<PlanRow[]> {
  const rows = await db.$queryRaw<PlanDbRow[]>`
    SELECT "id", "code", "name", "description", "list_price_cents", "currency", "interval",
           "stripe_price_id", "max_members", "max_ocr_docs_month", "max_storage_bytes",
           "max_exports_month", "max_backups_month", "max_organizations",
           "soft_max_entries_month", "grace_days", "backup_retention_days",
           "is_public", "valid_from", "valid_to"
      FROM "plans"
     ORDER BY "code" ASC, "valid_from" ASC
  `
  return rows.map(toPlanRow)
}

/**
 * La versión de un plan vigente en `refDate`. Delega en la función PURA, que es
 * quien lanza si hay dos vigentes: la decisión no se toma dos veces.
 */
export async function getPlanAt(db: AnyTenantClient, code: string, refDate: Date): Promise<PlanRow> {
  return resolvePlanAt(await listPlans(db), code, refDate)
}

/** La versión concreta que una suscripción tiene contratada, por id. */
export async function getPlanById(db: AnyTenantClient, planId: string): Promise<PlanRow | null> {
  const rows = await db.$queryRaw<PlanDbRow[]>`
    SELECT "id", "code", "name", "description", "list_price_cents", "currency", "interval",
           "stripe_price_id", "max_members", "max_ocr_docs_month", "max_storage_bytes",
           "max_exports_month", "max_backups_month", "max_organizations",
           "soft_max_entries_month", "grace_days", "backup_retention_days",
           "is_public", "valid_from", "valid_to"
      FROM "plans" WHERE "id" = ${planId}::uuid
  `
  return rows[0] ? toPlanRow(rows[0]) : null
}

/** La versión que corresponde a un `price` de Stripe. */
export async function getPlanByStripePriceId(db: AnyTenantClient, stripePriceId: string): Promise<PlanRow | null> {
  const rows = await db.$queryRaw<PlanDbRow[]>`
    SELECT "id", "code", "name", "description", "list_price_cents", "currency", "interval",
           "stripe_price_id", "max_members", "max_ocr_docs_month", "max_storage_bytes",
           "max_exports_month", "max_backups_month", "max_organizations",
           "soft_max_entries_month", "grace_days", "backup_retention_days",
           "is_public", "valid_from", "valid_to"
      FROM "plans" WHERE "stripe_price_id" = ${stripePriceId}
  `
  return rows[0] ? toPlanRow(rows[0]) : null
}

export { limitsOf }
export type { PlanLimits, PlanRow }
