/**
 * E2 · T6 — Mapa de cuentas de sistema (§4.1). Todo por `tenantTransaction`
 * + `AuditLog`.
 */

import { REQUIRED_ACCOUNT_KEYS, validateAccountMap } from "@/lib/accounts/map"
import type { AccountKey, Result } from "@/lib/accounts/types"
import { TenantClient, TenantTransactionClient, tenantTransaction } from "@/lib/db"
import { getPlan, type Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import type { OrganizationAccountMap } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

export async function getAccountMap(db: AnyClient): Promise<OrganizationAccountMap[]> {
  return await db.organizationAccountMap.findMany({ orderBy: { key: "asc" } })
}

/** `AccountKey` → código, listo para el motor contable. */
export async function getAccountMapByKey(db: AnyClient): Promise<Map<AccountKey, string>> {
  const rows = await db.organizationAccountMap.findMany({ select: { key: true, accountCode: true } })
  return new Map(rows.map((r) => [r.key, r.accountCode]))
}

/** I-plan-1 sobre el estado real de la organización (lo consume la Auditoría). */
export async function validateOrganizationAccountMap(db: AnyClient): Promise<Result<void>> {
  const [plan, entries] = await Promise.all([
    getPlan(db),
    db.organizationAccountMap.findMany({ select: { key: true, accountCode: true } }),
  ])
  return validateAccountMap(entries, plan, REQUIRED_ACCOUNT_KEYS)
}

/**
 * Remapeo de una clave. Marca la cuenta destino como `isSystem` y DESMARCA la
 * anterior si ya no la usa ni el mapa ni ningún tipo impositivo — si no, una
 * cuenta quedaría bloqueada para siempre por un mapeo que ya no existe.
 * El motivo es obligatorio (§7).
 */
export async function setAccountMapEntry(
  organizationId: string,
  key: AccountKey,
  accountCode: string,
  actor: Actor,
  reason: string
): Promise<Result<OrganizationAccountMap>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const plan = await getPlan(tx)
    const check = validateAccountMap([{ key, accountCode }], plan, [])
    if (!check.ok) return check as Result<OrganizationAccountMap>

    const before = await tx.organizationAccountMap.findFirst({ where: { key } })
    const after = await tx.organizationAccountMap.upsert({
      where: { organizationId_key: { organizationId, key } },
      update: { accountCode },
      create: { organizationId, key, accountCode },
    })

    await tx.ledgerAccount.updateMany({ where: { code: accountCode }, data: { isSystem: true } })
    if (before && before.accountCode !== accountCode) {
      const [stillMapped, usedByTax, usedByCounter] = await Promise.all([
        tx.organizationAccountMap.count({ where: { accountCode: before.accountCode } }),
        tx.taxRate.count({ where: { accountCode: before.accountCode } }),
        tx.taxRate.count({ where: { counterAccountCode: before.accountCode } }),
      ])
      if (stillMapped === 0 && usedByTax === 0 && usedByCounter === 0) {
        await tx.ledgerAccount.updateMany({ where: { code: before.accountCode }, data: { isSystem: false } })
      }
    }

    await writeAuditLog(tx, {
      entity: "OrganizationAccountMap",
      entityId: after.id,
      action: "remap",
      before: before ? { key: before.key, accountCode: before.accountCode } : null,
      after: { key: after.key, accountCode: after.accountCode },
      reason,
      userId: actor.userId,
    })
    return { ok: true as const, value: after }
  })
}
