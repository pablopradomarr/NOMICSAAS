/**
 * E2 · T6 — Mapa de cuentas de sistema (§4.1). Todo por `tenantTransaction`
 * + `AuditLog`.
 */

import {
  defaultAccountMap,
  REQUIRED_ACCOUNT_KEYS,
  SOFTWARE_ACCOUNTS,
  validateAccountMap,
} from "@/lib/accounts/map"
import { err, fail, ok, type AccountKey, type Result } from "@/lib/accounts/types"
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
 * §2.5 — cuentas de convención de software (4720/4730/4760/4770) BAJO DEMANDA.
 * Se crean siempre como subcuentas de 472/473/476/477 (R-20) y las claves que
 * apuntaban al padre bajan a la hoja: al colgarle un hijo, el padre deja de ser
 * postable y I-plan-1 se rompería. Motivo obligatorio (§7).
 */
export async function createSoftwareAccounts(
  organizationId: string,
  codes: readonly string[],
  actor: Actor,
  reason: string
): Promise<Result<{ created: string[]; remapped: { key: AccountKey; accountCode: string }[] }>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const wanted = SOFTWARE_ACCOUNTS.filter((account) => codes.includes(account.code))
    if (wanted.length === 0) {
      return fail<{ created: string[]; remapped: { key: AccountKey; accountCode: string }[] }>(
        err("CSV_ROW", "codes", "Ninguna de las cuentas indicadas es una cuenta de desglose válida")
      )
    }

    let plan = await getPlan(tx)
    const created: string[] = []
    for (const account of wanted.sort((a, b) => (a.code < b.code ? -1 : 1))) {
      if (plan.byCode.has(account.code)) continue
      const parentCode = account.code.slice(0, 3)
      const parent = plan.byCode.get(parentCode)
      if (!parent) {
        return fail<{ created: string[]; remapped: { key: AccountKey; accountCode: string }[] }>(
          err("PARENT_NOT_FOUND", "codes", `La cuenta ${parentCode} no existe en el plan de esta organización`)
        )
      }
      const row = await tx.ledgerAccount.create({
        data: {
          organizationId,
          code: account.code,
          name: account.name,
          level: account.code.length,
          parentCode: parent.code,
          nature: parent.nature,
          statement: parent.statement,
          epigraph: parent.epigraph,
          epigraphPymes: parent.epigraphPymes,
          bidirectional: parent.bidirectional,
          isContra: parent.isContra,
          analyticType: parent.analyticType,
          cashflowBucket: parent.cashflowBucket,
          isPostable: true,
          isActive: true,
          isSystem: false,
          origin: "MANUAL",
        },
      })
      await tx.ledgerAccount.updateMany({ where: { code: parent.code }, data: { isPostable: false } })
      created.push(row.code)
      plan = await getPlan(tx)
    }

    // Las claves que apuntaban al padre ahora no postable bajan a la hoja.
    const remapped: { key: AccountKey; accountCode: string }[] = []
    const entries = await tx.organizationAccountMap.findMany({ select: { key: true, accountCode: true } })
    const { entries: defaults } = defaultAccountMap(plan, { useSubaccounts: true, createSoftwareAccounts: true })
    const defaultByKey = new Map(defaults.map((entry) => [entry.key, entry.accountCode]))
    for (const entry of entries) {
      const account = plan.byCode.get(entry.accountCode)
      if (account && account.isPostable && account.isActive) continue
      const target = defaultByKey.get(entry.key)
      if (!target || target === entry.accountCode) continue
      await tx.organizationAccountMap.update({
        where: { organizationId_key: { organizationId, key: entry.key } },
        data: { accountCode: target },
      })
      remapped.push({ key: entry.key, accountCode: target })
    }

    const systemCodes = [...new Set([...created, ...remapped.map((r) => r.accountCode)])]
    if (systemCodes.length > 0) {
      await tx.ledgerAccount.updateMany({ where: { code: { in: systemCodes } }, data: { isSystem: true } })
    }

    plan = await getPlan(tx)
    const finalEntries = await tx.organizationAccountMap.findMany({ select: { key: true, accountCode: true } })
    const check = validateAccountMap(finalEntries, plan, REQUIRED_ACCOUNT_KEYS)
    if (!check.ok) {
      throw new Error(
        "I-plan-1: crear las cuentas de desglose dejaría el mapa sin resolver:\n  " +
          check.errors.map((e) => e.message).join("\n  ")
      )
    }

    await writeAuditLog(tx, {
      entity: "LedgerAccount",
      entityId: created.join(",") || "—",
      action: "create",
      before: null,
      after: { created, remapped },
      reason,
      userId: actor.userId,
    })
    return ok({ created, remapped })
  })
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
