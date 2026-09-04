/**
 * E2 · T6/T7 — Acceso a datos del plan de cuentas (§4.1).
 *
 * TODA mutación pasa por `tenantTransaction(orgId, userId, …)` y escribe su
 * entrada en `AuditLog` DENTRO de la misma transacción. La validación de reglas
 * vive en `lib/accounts/` (puro); aquí sólo hay IO.
 */

import { buildPlan, computeIsPostable } from "@/lib/accounts/codes"
import { filterByVariant, planDiff, seedRowsToPlanAccounts } from "@/lib/accounts/csv"
import { checkAnalyticCoherence as checkCoherencePure } from "@/lib/accounts/epigraphs"
import {
  ACCOUNT_KEY_DEFAULT_CODE,
  defaultAccountMap,
  extraAccountsToCreate,
  REQUIRED_ACCOUNT_KEYS,
  validateAccountMap,
} from "@/lib/accounts/map"
import {
  AccountUsage,
  AccountWarning,
  AccountKey,
  err,
  fail,
  ok,
  Result,
  PgcVariant,
  Plan,
  PlanAccount,
  SeedAccount,
} from "@/lib/accounts/types"
import {
  applyNewAccount,
  canDeactivateAccount,
  canDeleteAccount,
  NewAccountInput,
  validateNewAccount,
} from "@/lib/accounts/validate"
import { TenantClient, TenantTransactionClient, tenantDb, tenantTransaction } from "@/lib/db"
import { seedTaxRates, VIGENCIA_IVA_2025 } from "@/lib/taxes/rates"
import { writeAuditLog } from "@/models/audit-log"
import { loadNpgcSeed, NPGC_SEED_SHA_SETTING } from "@/models/npgc-seed"
import type { LedgerAccount, Prisma } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/** Columnas que el plan puro necesita: no se traen `id` ni timestamps. */
const PLAN_SELECT = {
  code: true,
  name: true,
  level: true,
  parentCode: true,
  nature: true,
  statement: true,
  epigraph: true,
  epigraphPymes: true,
  bidirectional: true,
  isContra: true,
  analyticType: true,
  cashflowCategory: true,
  isPostable: true,
  isActive: true,
  isSystem: true,
  origin: true,
} as const

/** Índice inmutable del plan de la organización (una consulta). */
export async function getPlan(db: AnyClient): Promise<Plan> {
  const rows = await db.ledgerAccount.findMany({ select: PLAN_SELECT, orderBy: { code: "asc" } })
  return buildPlan(rows as PlanAccount[])
}

export async function listAccounts(db: AnyClient): Promise<LedgerAccount[]> {
  return await db.ledgerAccount.findMany({ orderBy: { code: "asc" } })
}

export async function getAccount(db: AnyClient, code: string): Promise<LedgerAccount | null> {
  return await db.ledgerAccount.findFirst({ where: { code } })
}

/**
 * Uso de una cuenta.
 *
 * TODO(E3): `movementCount` está fijado a 0 porque `journal_lines` no existe
 * todavía. Al crear la tabla en E3 hay que cablearlo aquí — es lo único que
 * separa a `canDeleteAccount` de permitir borrar una cuenta con asientos
 * (riesgo R6 del diseño). Hay un test que fija este contrato hoy.
 */
export async function getAccountUsage(db: AnyClient, code: string): Promise<AccountUsage> {
  const [childCount, maps, taxRates, taxRatesCounter] = await Promise.all([
    db.ledgerAccount.count({ where: { parentCode: code } }),
    db.organizationAccountMap.findMany({ where: { accountCode: code }, select: { key: true } }),
    db.taxRate.findMany({ where: { accountCode: code }, select: { code: true } }),
    db.taxRate.findMany({ where: { counterAccountCode: code }, select: { code: true } }),
  ])
  return {
    movementCount: 0,
    childCount,
    mappedKeys: maps.map((m) => m.key),
    taxRateCodes: [...new Set([...taxRates, ...taxRatesCounter].map((t) => t.code))].sort(),
  }
}

/** I-E2-6 (aviso): divergencias `analyticType` ↔ bloque de PyG del epígrafe. */
export async function checkAnalyticCoherence(db: AnyClient, variant: PgcVariant): Promise<AccountWarning[]> {
  const plan = await getPlan(db)
  return checkCoherencePure([...plan.byCode.values()], variant)
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutaciones (todas por tenantTransaction + AuditLog)
// ─────────────────────────────────────────────────────────────────────────────

export type Actor = { userId: string | null }

/**
 * Datos de creación. El `organizationId` va explícito porque el tipo de Prisma
 * lo exige; si fuera de otra organización, `tenantDb` lanzaría `TenantError`
 * antes de tocar la base (barrera 1) y RLS lo cortaría después (barrera 2).
 */
function accountCreateData(organizationId: string, account: PlanAccount): Prisma.LedgerAccountCreateManyInput {
  return {
    organizationId,
    code: account.code,
    name: account.name,
    level: account.level,
    parentCode: account.parentCode,
    nature: account.nature,
    statement: account.statement,
    epigraph: account.epigraph,
    epigraphPymes: account.epigraphPymes,
    bidirectional: account.bidirectional,
    isContra: account.isContra,
    analyticType: account.analyticType,
    cashflowCategory: account.cashflowCategory,
    isPostable: account.isPostable,
    isActive: account.isActive,
    isSystem: account.isSystem,
    origin: account.origin,
  }
}

/**
 * Alta de subcuenta. R-04: el padre pierde `isPostable` EN LA MISMA
 * transacción que nace el hijo (I-E2-2), o quedaría un instante con dos
 * cuentas postables en la misma rama.
 */
export async function createAccount(
  organizationId: string,
  input: NewAccountInput,
  actor: Actor,
  reason?: string | null
): Promise<{ ok: true; account: LedgerAccount } | { ok: false; errors: ReturnType<typeof validateNewAccount> }> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const plan = await getPlan(tx)
    const parentCode = input.code.length > 1 ? findParent(plan, input.code) : null
    const parentUsage = parentCode
      ? await getAccountUsage(tx, parentCode)
      : { movementCount: 0, childCount: 0, mappedKeys: [], taxRateCodes: [] }

    const validated = validateNewAccount(input, plan, parentUsage)
    if (!validated.ok) return { ok: false as const, errors: validated }

    const { parentDemoted } = applyNewAccount(plan, validated.value)
    const created = await tx.ledgerAccount.create({ data: accountCreateData(organizationId, validated.value) })
    if (parentDemoted) {
      await tx.ledgerAccount.updateMany({ where: { code: parentDemoted }, data: { isPostable: false } })
    }
    await writeAuditLog(tx, {
      entity: "LedgerAccount",
      entityId: created.id,
      action: "create",
      before: null,
      after: { ...validated.value, parentDemoted },
      reason: reason ?? null,
      userId: actor.userId,
    })
    return { ok: true as const, account: created }
  })
}

function findParent(plan: Plan, code: string): string | null {
  for (let n = code.length - 1; n >= 1; n--) {
    const candidate = code.slice(0, n)
    if (plan.byCode.has(candidate)) return candidate
  }
  return null
}

/** Actualización parcial ya VALIDADA por `validateAccountUpdate`. */
export async function updateAccount(
  organizationId: string,
  code: string,
  patch: Partial<Pick<LedgerAccount, "name" | "statement" | "epigraph" | "analyticType" | "cashflowCategory">>,
  actor: Actor,
  reason?: string | null
): Promise<LedgerAccount> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await tx.ledgerAccount.findFirst({ where: { code } })
    if (!before) throw new Error(`La cuenta ${code} no existe en esta organización`)
    const after = await tx.ledgerAccount.update({
      where: { organizationId_code: { organizationId, code } },
      data: patch,
    })
    await writeAuditLog(tx, {
      entity: "LedgerAccount",
      entityId: after.id,
      action: "update",
      before: pick(before, Object.keys(patch) as (keyof LedgerAccount)[]),
      after: pick(after, Object.keys(patch) as (keyof LedgerAccount)[]),
      reason: reason ?? null,
      userId: actor.userId,
    })
    return after
  })
}

function pick<T extends object>(row: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const key of keys) out[key] = row[key]
  return out
}

/**
 * R-09: desactivar, nunca borrar. El motivo es obligatorio al desactivar.
 *
 * R-06 se comprueba TAMBIÉN aquí, no sólo en la server action: desactivar una
 * cuenta de sistema deja el mapa apuntando a una cuenta inactiva y rompe
 * I-plan-1 en la siguiente siembra. Que el modelo lo permitiera dejaba el
 * invariante a merced de quien llamase.
 */
export async function setAccountActive(
  organizationId: string,
  code: string,
  isActive: boolean,
  actor: Actor,
  reason: string | null
): Promise<Result<LedgerAccount>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const plan = await getPlan(tx)
    const account = plan.byCode.get(code)
    if (!account) {
      return fail<LedgerAccount>(err("ACCOUNT_NOT_FOUND", "code", `La cuenta ${code} no existe en esta organización`))
    }
    if (!isActive) {
      const check = canDeactivateAccount(account, plan)
      if (!check.ok) return check as Result<LedgerAccount>
    }
    const before = await tx.ledgerAccount.findFirst({ where: { code } })
    if (!before) {
      return fail<LedgerAccount>(err("ACCOUNT_NOT_FOUND", "code", `La cuenta ${code} no existe en esta organización`))
    }
    const after = await tx.ledgerAccount.update({
      where: { organizationId_code: { organizationId, code } },
      data: { isActive },
    })
    await writeAuditLog(tx, {
      entity: "LedgerAccount",
      entityId: after.id,
      action: isActive ? "activate" : "deactivate",
      before: { isActive: before.isActive },
      after: { isActive: after.isActive },
      reason,
      userId: actor.userId,
    })
    return ok(after)
  })
}

/** R-08: borrado sólo si `canDeleteAccount` lo permite. Motivo obligatorio. */
export async function deleteAccount(
  organizationId: string,
  code: string,
  actor: Actor,
  reason: string
): Promise<{ ok: true } | { ok: false; errors: { code: string; message: string }[] }> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const plan = await getPlan(tx)
    const account = plan.byCode.get(code)
    if (!account) return { ok: false as const, errors: [{ code: "ACCOUNT_NOT_FOUND", message: `La cuenta ${code} no existe` }] }
    const usage = await getAccountUsage(tx, code)
    const check = canDeleteAccount(account, plan, usage)
    if (!check.ok) return { ok: false as const, errors: check.errors }

    const row = await tx.ledgerAccount.findFirst({ where: { code } })
    await tx.ledgerAccount.delete({ where: { organizationId_code: { organizationId, code } } })
    // El padre puede volver a ser hoja (I-E2-2).
    if (account.parentCode) {
      const remaining = new Set([...plan.codes].filter((c) => c !== code))
      if (computeIsPostable(account.parentCode, remaining)) {
        await tx.ledgerAccount.updateMany({ where: { code: account.parentCode }, data: { isPostable: true } })
      }
    }
    await writeAuditLog(tx, {
      entity: "LedgerAccount",
      entityId: row?.id ?? code,
      action: "delete",
      before: row,
      after: null,
      reason,
      userId: actor.userId,
    })
    return { ok: true as const }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// importNpgc — siembra idempotente (§2.4, T7)
// ─────────────────────────────────────────────────────────────────────────────

export type ImportNpgcOptions = {
  /** Crea 5720 / 47510-12 y apunta el mapa a las hojas (§3.4). Default TRUE. */
  useSubaccounts?: boolean
  /** 4720/4730/4760/4770 (convención de software, §2.5). Default FALSE. */
  createSoftwareAccounts?: boolean
  /** Filas del seed ya parseadas; por defecto `seeds/npgc.csv`. */
  rows?: readonly SeedAccount[]
  seedSha256?: string
  actor?: Actor
  /** Fecha de referencia (alta de la organización). El módulo puro no la inventa. */
  now?: Date
  /** No escribe nada: devuelve el recuento que se HABRÍA aplicado. */
  dryRun?: boolean
  reason?: string | null
}

export type ImportNpgcResult = {
  created: number
  updated: number
  skipped: number
  mapKeys: number
  taxRates: number
  unresolvedKeys: AccountKey[]
  dryRun: boolean
}

/**
 * Siembra el plan NPGC de una organización. IDEMPOTENTE: `planDiff(…, "seed")`
 * no crea lo que ya está y no pisa lo que el usuario editó (`origin ≠ SEED`).
 * Al final REVALIDA I-plan-1; si falla, la transacción entera se revierte.
 */
export async function importNpgc(
  organizationId: string,
  variant: PgcVariant,
  opts: ImportNpgcOptions = {}
): Promise<ImportNpgcResult> {
  const useSubaccounts = opts.useSubaccounts ?? true
  const createSoftwareAccounts = opts.createSoftwareAccounts ?? false
  const actor = opts.actor ?? { userId: null }
  const seed = opts.rows ? { rows: opts.rows, sha256: opts.seedSha256 ?? "" } : loadNpgcSeed()

  const filtered = filterByVariant(seed.rows, variant)
  if (!filtered.ok) {
    throw new Error(`El seed no supera el filtro ${variant}: ${filtered.errors.map((e) => e.message).join("; ")}`)
  }
  const incoming = seedRowsToPlanAccounts(filtered.value, "SEED")

  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await getPlan(tx)
    const diff = planDiff(before, incoming, "seed")

    if (opts.dryRun) {
      return {
        created: diff.create.length,
        updated: diff.update.length,
        skipped: diff.skip.length,
        mapKeys: 0,
        taxRates: 0,
        unresolvedKeys: [],
        dryRun: true,
      }
    }

    // Orden ascendente por código: el padre existe antes que el hijo (FK compuesta).
    const ordered = [...diff.create].sort((a, b) => (a.code < b.code ? -1 : 1))
    for (const account of ordered) {
      await tx.ledgerAccount.create({ data: accountCreateData(organizationId, account) })
    }
    for (const change of diff.postableChanges) {
      await tx.ledgerAccount.updateMany({ where: { code: change.code }, data: { isPostable: change.isPostable } })
    }

    // Subcuentas operativas y, si se piden, las de convención de software.
    let plan = await getPlan(tx)
    const extras = extraAccountsToCreate(plan, { useSubaccounts, createSoftwareAccounts })
    for (const extra of extras.sort((a, b) => (a.code < b.code ? -1 : 1))) {
      const parentCode = findParent(plan, extra.code)
      const parent = parentCode ? plan.byCode.get(parentCode) : undefined
      if (!parent) continue
      await tx.ledgerAccount.create({
        data: accountCreateData(organizationId, {
          code: extra.code,
          name: extra.name,
          level: extra.code.length,
          parentCode: parent.code,
          nature: parent.nature,
          statement: parent.statement,
          epigraph: parent.epigraph,
          epigraphPymes: parent.epigraphPymes,
          bidirectional: parent.bidirectional,
          isContra: parent.isContra,
          analyticType: parent.analyticType,
          cashflowCategory: parent.cashflowCategory,
          isPostable: true,
          isActive: true,
          isSystem: false,
          origin: "SEED",
        }),
      })
      await tx.ledgerAccount.updateMany({ where: { code: parent.code }, data: { isPostable: false } })
      plan = await getPlan(tx)
    }

    // Mapa de cuentas de sistema.
    const { entries, unresolved } = defaultAccountMap(plan, { useSubaccounts, createSoftwareAccounts })
    for (const entry of entries) {
      await tx.organizationAccountMap.upsert({
        where: { organizationId_key: { organizationId, key: entry.key } },
        update: {},
        create: { organizationId, key: entry.key, accountCode: entry.accountCode },
      })
    }
    const mapped = await tx.organizationAccountMap.findMany({ select: { key: true, accountCode: true } })
    const systemCodes = [...new Set(mapped.map((m) => m.accountCode))]
    if (systemCodes.length > 0) {
      await tx.ledgerAccount.updateMany({ where: { code: { in: systemCodes } }, data: { isSystem: true } })
    }

    // I-plan-1: si el mapa no resuelve, se revierte TODO.
    plan = await getPlan(tx)
    const mapCheck = validateAccountMap(mapped, plan, REQUIRED_ACCOUNT_KEYS)
    if (!mapCheck.ok) {
      throw new Error(
        `I-plan-1: el mapa de cuentas de sistema no resuelve tras sembrar ${variant}:\n  ` +
          mapCheck.errors.map((e) => e.message).join("\n  ")
      )
    }

    // Tipos impositivos de sistema (§3.1).
    const byKey = new Map(mapped.map((m) => [m.key, m.accountCode]))
    const taxSeeds = seedTaxRates((key) => byKey.get(key) ?? ACCOUNT_KEY_DEFAULT_CODE[key] ?? null, {
      ivaValidFrom: VIGENCIA_IVA_2025,
      orgValidFrom: opts.now ?? VIGENCIA_IVA_2025,
    })
    const existingTaxCodes = new Set((await tx.taxRate.findMany({ select: { code: true } })).map((t) => t.code))
    const idByCode = new Map<string, string>()
    // Dos pasadas: los recargos enlazan por id al IVA que acompañan.
    for (const pass of [0, 1]) {
      for (const row of taxSeeds) {
        const isRecargo = row.kind === "RECARGO"
        if ((pass === 0) === isRecargo) continue
        if (existingTaxCodes.has(row.code)) continue
        const created = await tx.taxRate.create({
          data: {
            organizationId,
            code: row.code,
            name: row.name,
            kind: row.kind,
            rateBps: row.rateBps,
            appliesTo: row.appliesTo,
            accountCode: row.accountCode,
            counterAccountCode: row.counterAccountCode,
            linkedTaxRateId: row.linkedCode ? (idByCode.get(row.linkedCode) ?? null) : null,
            validFrom: row.validFrom,
            validTo: row.validTo,
            isActive: true,
            isSystem: true,
          },
        })
        idByCode.set(created.code, created.id)
      }
    }
    const taxRateCount = await tx.taxRate.count()

    // sha256 del seed con el que se sembró (R7): E7 detecta planes con seed viejo.
    if (seed.sha256) {
      await tx.setting.upsert({
        where: { organizationId_code: { organizationId, code: NPGC_SEED_SHA_SETTING } },
        update: { value: seed.sha256 },
        create: {
          organizationId,
          code: NPGC_SEED_SHA_SETTING,
          name: "SHA-256 del seed NPGC con el que se sembró el plan",
          value: seed.sha256,
        },
      })
    }

    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "seed",
      before: null,
      after: {
        variant,
        seedSha256: seed.sha256,
        created: diff.create.length + extras.length,
        skipped: diff.skip.length,
        useSubaccounts,
        createSoftwareAccounts,
        unresolvedKeys: unresolved,
      },
      reason: opts.reason ?? null,
      userId: actor.userId,
    })

    return {
      created: diff.create.length + extras.length,
      updated: diff.update.length,
      skipped: diff.skip.length,
      mapKeys: mapped.length,
      taxRates: taxRateCount,
      unresolvedKeys: unresolved,
      dryRun: false,
    }
  })
}

/** Atajo para código de aplicación que ya tiene el `orgId`. */
export const accountsDb = (organizationId: string) => tenantDb(organizationId)
