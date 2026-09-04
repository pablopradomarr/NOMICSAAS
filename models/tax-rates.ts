/**
 * E2 · T6 — Tipos impositivos (§4.1). Todo por `tenantTransaction` + `AuditLog`.
 * La vigencia se CIERRA, nunca se borra.
 */

import type { Result } from "@/lib/accounts/types"
import { closeTaxRateValidity, selectTaxRate, validateTaxRate } from "@/lib/taxes/rates"
import type { TaxRateInput, TaxRateRow } from "@/lib/taxes/types"
import { TenantClient, TenantTransactionClient, tenantTransaction } from "@/lib/db"
import { getPlan, type Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import type { Organization, TaxKind, TaxRate, TaxRoundingMode } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/** Fila de Prisma → fila pura. Mismos campos, sin timestamps. */
export function toTaxRateRow(row: TaxRate): TaxRateRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    rateBps: row.rateBps,
    appliesTo: row.appliesTo,
    accountCode: row.accountCode,
    counterAccountCode: row.counterAccountCode,
    linkedTaxRateId: row.linkedTaxRateId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    isActive: row.isActive,
    isSystem: row.isSystem,
  }
}

export async function listTaxRates(
  db: AnyClient,
  filter: { kind?: TaxKind; refDate?: Date } = {}
): Promise<TaxRateRow[]> {
  const rows = await db.taxRate.findMany({
    where: filter.kind ? { kind: filter.kind } : {},
    orderBy: [{ code: "asc" }, { validFrom: "asc" }],
  })
  const all = rows.map(toTaxRateRow)
  if (!filter.refDate) return all
  const refDate = filter.refDate
  const codes = [...new Set(all.map((r) => r.code))]
  return codes
    .map((code) => selectTaxRate(all, code, refDate))
    .filter((r): r is TaxRateRow => r !== null)
    .sort((a, b) => (a.code < b.code ? -1 : 1))
}

/** El tipo vigente a una fecha (C-7). Lo consumirá `lib/ledger/templates` en E3. */
export async function getTaxRateInForce(db: AnyClient, code: string, refDate: Date): Promise<TaxRateRow | null> {
  const rows = await db.taxRate.findMany({ where: { code } })
  return selectTaxRate(rows.map(toTaxRateRow), code, refDate)
}

export async function createTaxRate(
  organizationId: string,
  input: TaxRateInput,
  actor: Actor,
  reason?: string | null
): Promise<Result<TaxRate>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const [plan, existing] = await Promise.all([getPlan(tx), tx.taxRate.findMany()])
    const validated = validateTaxRate(input, existing.map(toTaxRateRow), plan, input.validFrom)
    if (!validated.ok) return validated as Result<TaxRate>

    const value = validated.value
    const created = await tx.taxRate.create({
      data: {
        organizationId,
        code: value.code,
        name: value.name,
        kind: value.kind,
        rateBps: value.rateBps,
        appliesTo: value.appliesTo,
        accountCode: value.accountCode,
        counterAccountCode: value.counterAccountCode,
        linkedTaxRateId: value.linkedTaxRateId,
        validFrom: value.validFrom,
        validTo: value.validTo,
        isActive: value.isActive,
        isSystem: value.isSystem,
      },
    })
    // Las cuentas que usa un tipo impositivo son de sistema (R-06).
    const codes = [created.accountCode, created.counterAccountCode].filter((c): c is string => c !== null)
    await tx.ledgerAccount.updateMany({ where: { code: { in: codes } }, data: { isSystem: true } })

    await writeAuditLog(tx, {
      entity: "TaxRate",
      entityId: created.id,
      action: "create",
      before: null,
      after: created,
      reason: reason ?? null,
      userId: actor.userId,
    })
    return { ok: true as const, value: created }
  })
}

export async function updateTaxRate(
  organizationId: string,
  id: string,
  patch: Partial<Pick<TaxRate, "name" | "rateBps" | "appliesTo" | "accountCode" | "counterAccountCode" | "validFrom" | "validTo" | "isActive">>,
  actor: Actor,
  reason?: string | null
): Promise<Result<TaxRate>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await tx.taxRate.findFirst({ where: { id } })
    if (!before) {
      return {
        ok: false as const,
        errors: [{ code: "CSV_ROW" as const, field: "id", message: `El tipo impositivo ${id} no existe` }],
      }
    }
    const [plan, existing] = await Promise.all([getPlan(tx), tx.taxRate.findMany()])
    const candidate: TaxRateInput = { ...toTaxRateRow(before), ...patch }
    const validated = validateTaxRate(candidate, existing.map(toTaxRateRow), plan, candidate.validFrom)
    if (!validated.ok) return validated as Result<TaxRate>

    const after = await tx.taxRate.update({ where: { id }, data: patch })
    await writeAuditLog(tx, {
      entity: "TaxRate",
      entityId: after.id,
      action: "update",
      before,
      after,
      reason: reason ?? null,
      userId: actor.userId,
    })
    return { ok: true as const, value: after }
  })
}

/**
 * Política fiscal de la organización (D2-8): prorrata, método de redondeo y
 * tolerancia. Cambia cómo el motor calculará las cuotas de TODO documento
 * posterior, así que el motivo es obligatorio y queda en `AuditLog` (§7).
 */
export type TaxPolicyPatch = {
  prorrataPermille: number | null
  taxRoundingMode: TaxRoundingMode
  redondeoToleranciaCents: number
}

export async function updateTaxPolicy(
  organizationId: string,
  patch: TaxPolicyPatch,
  actor: Actor,
  reason: string
): Promise<Organization> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await tx.organization.findFirst({ where: { id: organizationId } })
    if (!before) throw new Error("La organización no existe")
    const after = await tx.organization.update({ where: { id: organizationId }, data: patch })
    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "update",
      before: {
        prorrataPermille: before.prorrataPermille,
        taxRoundingMode: before.taxRoundingMode,
        redondeoToleranciaCents: before.redondeoToleranciaCents,
      },
      after: {
        prorrataPermille: after.prorrataPermille,
        taxRoundingMode: after.taxRoundingMode,
        redondeoToleranciaCents: after.redondeoToleranciaCents,
      },
      reason,
      userId: actor.userId,
    })
    return after
  })
}

/** Cierre de vigencia (nunca borrado). El motivo es obligatorio (§7). */
export async function closeTaxRate(
  organizationId: string,
  id: string,
  validTo: Date,
  actor: Actor,
  reason: string
): Promise<Result<TaxRate>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await tx.taxRate.findFirst({ where: { id } })
    if (!before) {
      return {
        ok: false as const,
        errors: [{ code: "CSV_ROW" as const, field: "id", message: `El tipo impositivo ${id} no existe` }],
      }
    }
    const check = closeTaxRateValidity(toTaxRateRow(before), validTo)
    if (!check.ok) return check as Result<TaxRate>

    const after = await tx.taxRate.update({ where: { id }, data: { validTo } })
    await writeAuditLog(tx, {
      entity: "TaxRate",
      entityId: after.id,
      action: "close",
      before: { validTo: before.validTo },
      after: { validTo: after.validTo },
      reason,
      userId: actor.userId,
    })
    return { ok: true as const, value: after }
  })
}
