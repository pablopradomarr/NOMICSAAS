/**
 * E2 · T6/T7 — Acceso a datos del plan de cuentas (§4.1).
 *
 * TODA mutación pasa por `tenantTransaction(orgId, userId, …)` y escribe su
 * entrada en `AuditLog` DENTRO de la misma transacción. La validación de reglas
 * vive en `lib/accounts/` (puro); aquí sólo hay IO.
 */

import { buildPlan, computeIsPostable } from "@/lib/accounts/codes"
import {
  ColumnMapping,
  filterByVariant,
  ImportDefaults,
  parseCustomPlanCsv,
  planDiff,
  resolveImportedParents,
  rowNumbersByCode,
  seedRowsToPlanAccounts,
} from "@/lib/accounts/csv"
import { checkAnalyticCoherence as checkCoherencePure } from "@/lib/accounts/epigraphs"
import {
  defaultAccountMap,
  extraAccountsToCreate,
  REQUIRED_ACCOUNT_KEYS,
  validateAccountMap,
} from "@/lib/accounts/map"
import {
  AccountError,
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
import {
  SEED_TRANSACTION_OPTIONS,
  TenantClient,
  TenantTransactionClient,
  TenantTransactionOptions,
  tenantDb,
  tenantTransaction,
} from "@/lib/db"
import { seedTaxRates, VIGENCIA_IVA_2025 } from "@/lib/taxes/rates"
import { writeAuditLog } from "@/models/audit-log"
import { loadNpgcSeed, NPGC_SEED_SHA_SETTING } from "@/models/npgc-seed"
import type { LedgerAccount, Prisma } from "@/prisma/client"
import { createHash, randomUUID } from "node:crypto"

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
  cashflowBucket: true,
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
 * E3 · T8: `movementCount` cuenta ya las líneas reales de `journal_lines`, que
 * es lo que separa a `canDeleteAccount` de permitir borrar una cuenta con
 * asientos (riesgo R6). El `TODO(E3)` que dejó E2 queda cerrado; la FK
 * `ON DELETE RESTRICT` de la línea lo repite en la base de datos.
 */
export async function getAccountUsage(db: AnyClient, code: string): Promise<AccountUsage> {
  const [movementCount, childCount, maps, taxRates, taxRatesCounter] = await Promise.all([
    db.journalLine.count({ where: { accountCode: code } }),
    db.ledgerAccount.count({ where: { parentCode: code } }),
    db.organizationAccountMap.findMany({ where: { accountCode: code }, select: { key: true } }),
    db.taxRate.findMany({ where: { accountCode: code }, select: { code: true } }),
    db.taxRate.findMany({ where: { counterAccountCode: code }, select: { code: true } }),
  ])
  return {
    movementCount,
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

export type Actor = {
  userId: string | null
  /**
   * E4 (gap de QA): rol del actor en la organización. Lo necesitan las
   * operaciones cuya ventana depende del rol —reclasificación analítica y
   * excepción de proyecto cerrado (I-E4-10)—. Opcional: quien no lo aporta se
   * trata como el rol mínimo que la operación admita.
   */
  role?: "ADMIN" | "EDITOR" | "VIEWER"
}

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
    cashflowBucket: account.cashflowBucket,
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
  reason?: string | null,
  /** R-15: catálogo cerrado de la variante. Sin él, el epígrafe no se comprueba. */
  opts: { epigraphCatalog?: ReadonlySet<string> } = {}
): Promise<{ ok: true; account: LedgerAccount } | { ok: false; errors: AccountError[] }> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const plan = await getPlan(tx)
    const parentCode = input.code.length > 1 ? findParent(plan, input.code) : null
    const parentUsage = parentCode
      ? await getAccountUsage(tx, parentCode)
      : { movementCount: 0, childCount: 0, mappedKeys: [], taxRateCodes: [] }

    const validated = validateNewAccount(input, plan, parentUsage, { epigraphCatalog: opts.epigraphCatalog })
    if (!validated.ok) return { ok: false as const, errors: validated.errors }

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
  patch: Partial<Pick<LedgerAccount, "name" | "statement" | "epigraph" | "analyticType" | "cashflowBucket">>,
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
      // El uso REAL (mapa + tipos impositivos), no sólo el flag `isSystem`:
      // un `isSystem` desincronizado dejaría desactivar una cuenta que el mapa
      // sigue necesitando (revisión, hallazgo 4).
      const usage = await getAccountUsage(tx, code)
      const check = canDeactivateAccount(account, plan, usage)
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
  /** Límites de la transacción; por defecto `SEED_TRANSACTION_OPTIONS` (60 s). */
  transaction?: TenantTransactionOptions
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

  return await tenantTransaction(
    organizationId,
    actor.userId ?? undefined,
    async (tx) => {
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

    // ── Alta del plan: un `createMany` POR NIVEL ────────────────────────────
    // El bucle fila a fila eran ~800 INSERT en una sola transacción (≈1,1 s de
    // ida y vuelta). Agrupar por longitud de código respeta la FK compuesta
    // `(organization_id, parent_code)`: el padre siempre tiene menos dígitos que
    // el hijo, así que el nivel N-1 está confirmado antes de insertar el nivel N.
    const byLevel = new Map<number, PlanAccount[]>()
    for (const account of diff.create) {
      const bucket = byLevel.get(account.level)
      if (bucket) bucket.push(account)
      else byLevel.set(account.level, [account])
    }
    for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
      const rows = byLevel.get(level) ?? []
      await tx.ledgerAccount.createMany({ data: rows.map((a) => accountCreateData(organizationId, a)) })
    }
    // Los cambios de `isPostable` van en dos updateMany (uno por valor), no en uno por cuenta.
    for (const value of [true, false]) {
      const codes = diff.postableChanges.filter((c) => c.isPostable === value).map((c) => c.code)
      if (codes.length > 0) {
        await tx.ledgerAccount.updateMany({ where: { code: { in: codes } }, data: { isPostable: value } })
      }
    }

    // El plan resultante se compone EN MEMORIA a partir del que ya se leyó: cada
    // `getPlan(tx)` intermedio era una consulta de 900 filas para saber algo que
    // esta misma función acaba de escribir.
    const postableByCode = new Map(diff.postableChanges.map((c) => [c.code, c.isPostable]))
    const working: PlanAccount[] = [
      ...[...before.byCode.values()].map((a) => {
        const change = postableByCode.get(a.code)
        return change === undefined ? a : { ...a, isPostable: change }
      }),
      ...diff.create,
    ]
    let plan = buildPlan(working)

    // ── Subcuentas operativas y, si se piden, las de convención de software ──
    const extras = extraAccountsToCreate(plan, { useSubaccounts, createSoftwareAccounts })
    const extraAccounts: PlanAccount[] = []
    const demoted = new Set<string>()
    for (const extra of [...extras].sort((a, b) => (a.code < b.code ? -1 : 1))) {
      const parentCode = findParent(plan, extra.code)
      const parent = parentCode ? plan.byCode.get(parentCode) : undefined
      if (!parent) continue
      const account: PlanAccount = {
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
        cashflowBucket: parent.cashflowBucket,
        isPostable: true,
        isActive: true,
        isSystem: false,
        origin: "SEED",
      }
      extraAccounts.push(account)
      demoted.add(parent.code)
      // El plan en memoria incluye ya la subcuenta: la siguiente del lote
      // (47511 tras 47510) resuelve su padre contra el estado correcto.
      plan = buildPlan([
        ...[...plan.byCode.values()].map((a) => (a.code === parent.code ? { ...a, isPostable: false } : a)),
        account,
      ])
    }
    if (extraAccounts.length > 0) {
      const extrasByLevel = new Map<number, PlanAccount[]>()
      for (const account of extraAccounts) {
        const bucket = extrasByLevel.get(account.level)
        if (bucket) bucket.push(account)
        else extrasByLevel.set(account.level, [account])
      }
      for (const level of [...extrasByLevel.keys()].sort((a, b) => a - b)) {
        const rows = extrasByLevel.get(level) ?? []
        await tx.ledgerAccount.createMany({ data: rows.map((a) => accountCreateData(organizationId, a)) })
      }
      await tx.ledgerAccount.updateMany({ where: { code: { in: [...demoted] } }, data: { isPostable: false } })
    }

    // ── Mapa de cuentas de sistema ──────────────────────────────────────────
    const { entries, unresolved } = defaultAccountMap(plan, { useSubaccounts, createSoftwareAccounts })
    const existingMap = await tx.organizationAccountMap.findMany({ select: { key: true, accountCode: true } })
    const existingKeys = new Set(existingMap.map((m) => m.key))
    // Idempotencia: una clave ya mapeada NO se toca (el ADMIN pudo remapearla).
    const nuevas = entries.filter((entry) => !existingKeys.has(entry.key))
    if (nuevas.length > 0) {
      await tx.organizationAccountMap.createMany({
        data: nuevas.map((entry) => ({ organizationId, key: entry.key, accountCode: entry.accountCode })),
      })
    }
    const mapped = [...existingMap, ...nuevas.map((e) => ({ key: e.key, accountCode: e.accountCode }))]
    const systemCodes = [...new Set(mapped.map((m) => m.accountCode))]
    if (systemCodes.length > 0) {
      await tx.ledgerAccount.updateMany({ where: { code: { in: systemCodes } }, data: { isSystem: true } })
    }
    plan = buildPlan(
      [...plan.byCode.values()].map((a) => (systemCodes.includes(a.code) ? { ...a, isSystem: true } : a))
    )

    // I-plan-1: si el mapa no resuelve, se revierte TODO.
    const mapCheck = validateAccountMap(mapped, plan, REQUIRED_ACCOUNT_KEYS)
    if (!mapCheck.ok) {
      throw new Error(
        `I-plan-1: el mapa de cuentas de sistema no resuelve tras sembrar ${variant}:\n  ` +
          mapCheck.errors.map((e) => e.message).join("\n  ")
      )
    }

    // ── Tipos impositivos de sistema (§3.1) ─────────────────────────────────
    // Sin fallback a `ACCOUNT_KEY_DEFAULT_CODE`: si una clave no está mapeada, su
    // código "de libro" puede no existir o no ser postable en esta organización,
    // y el tipo apuntaría a una cuenta que la FK rechazaría. No se siembra.
    const byKey = new Map(mapped.map((m) => [m.key, m.accountCode]))
    const taxSeeds = seedTaxRates((key) => byKey.get(key) ?? null, {
      ivaValidFrom: VIGENCIA_IVA_2025,
      orgValidFrom: opts.now ?? VIGENCIA_IVA_2025,
    })
    const existingTaxCodes = new Set((await tx.taxRate.findMany({ select: { code: true } })).map((t) => t.code))
    const pendientes = taxSeeds.filter((row) => !existingTaxCodes.has(row.code))
    // Los ids se generan aquí para poder resolver `linkedTaxRateId` (recargo →
    // IVA) sin dos pasadas de INSERT: un solo `createMany` para todo el catálogo.
    const idByCode = new Map(pendientes.map((row) => [row.code, randomUUID()]))
    if (pendientes.length > 0) {
      await tx.taxRate.createMany({
        data: pendientes.map((row) => ({
          id: idByCode.get(row.code) as string,
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
        })),
      })
    }
    const taxRateCount = existingTaxCodes.size + pendientes.length

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
    },
    // Una siembra son ~900 cuentas + 57 claves + 28 tipos en UNA transacción: el
    // presupuesto por defecto de Prisma (5 s) la aborta a mitad.
    opts.transaction ?? SEED_TRANSACTION_OPTIONS
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// importCustomPlan — import de un plan ajeno desde CSV (§4.2, T11)
// ─────────────────────────────────────────────────────────────────────────────

export type ImportCustomPlanResult = {
  created: number
  updated: number
  skipped: number
  dryRun: boolean
  /** Muestra para la previsualización del wizard (máximo 20 filas). */
  preview: { code: string; name: string; action: "create" | "update" }[]
}

/**
 * Import de plan propio. TODO O NADA (riesgo R4): cualquier fila inválida
 * rechaza el fichero entero con su nº de fila. El cliente NO calcula el diff:
 * `dryRun: true` devuelve el `PlanDiff` desde el servidor y no escribe nada.
 */
export async function importCustomPlan(
  organizationId: string,
  csvText: string,
  mapping: ColumnMapping,
  opts: {
    variant: PgcVariant
    defaults: Omit<ImportDefaults, "epigraphCatalog">
    epigraphCatalog: ReadonlySet<string>
    actor: Actor
    dryRun: boolean
    fileName?: string
    reason?: string | null
    /** Límites de la transacción; por defecto `SEED_TRANSACTION_OPTIONS` (60 s). */
    transaction?: TenantTransactionOptions
  }
): Promise<Result<ImportCustomPlanResult>> {
  const parsed = parseCustomPlanCsv(csvText, mapping, { ...opts.defaults, epigraphCatalog: opts.epigraphCatalog })
  if (!parsed.ok) return parsed as Result<ImportCustomPlanResult>
  // Nº de fila original de cada código: los errores de jerarquía apuntan a la
  // línea del fichero del usuario, no a un código suelto (hallazgo 9).
  const rowNumbers = rowNumbersByCode(csvText, mapping, opts.defaults.delimiter ?? ",")

  return await tenantTransaction(
    organizationId,
    opts.actor.userId ?? undefined,
    async (tx) => {
    const plan = await getPlan(tx)
    const resolved = resolveImportedParents(parsed.value, plan, rowNumbers)
    if (!resolved.ok) return resolved as Result<ImportCustomPlanResult>

    const incoming = seedRowsToPlanAccounts(resolved.value, "CSV_IMPORT")
    const diff = planDiff(plan, incoming, "import")
    const preview = [
      ...diff.create.map((a) => ({ code: a.code, name: a.name, action: "create" as const })),
      ...diff.update.map((u) => ({
        code: u.code,
        name: plan.byCode.get(u.code)?.name ?? "",
        action: "update" as const,
      })),
    ]
      .sort((a, b) => (a.code < b.code ? -1 : 1))
      .slice(0, 20)

    const summary: ImportCustomPlanResult = {
      created: diff.create.length,
      updated: diff.update.length,
      skipped: diff.skip.length,
      dryRun: opts.dryRun,
      preview,
    }
    if (opts.dryRun) return ok(summary)

    // E3-T10: alta por `createMany` AGRUPADO POR NIVEL, igual que `importNpgc`.
    // El bucle fila a fila eran hasta `MAX_IMPORT_ROWS` INSERT sueltos en una
    // sola transacción. Agrupar por nivel (longitud del código) respeta la FK
    // compuesta `(organization_id, parent_code)`: el padre siempre tiene menos
    // dígitos que el hijo, así que el nivel N-1 está confirmado antes de
    // insertar el N.
    const byLevel = new Map<number, PlanAccount[]>()
    for (const account of diff.create) {
      const bucket = byLevel.get(account.level)
      if (bucket) bucket.push(account)
      else byLevel.set(account.level, [account])
    }
    for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
      const rows = (byLevel.get(level) ?? []).sort((a, b) => (a.code < b.code ? -1 : 1))
      await tx.ledgerAccount.createMany({ data: rows.map((a) => accountCreateData(organizationId, a)) })
    }
    for (const change of diff.update) {
      await tx.ledgerAccount.updateMany({ where: { code: change.code }, data: change.patch })
    }
    // Los cambios de `isPostable` van en dos `updateMany` (uno por valor), no en
    // uno por cuenta.
    for (const value of [true, false]) {
      const codes = diff.postableChanges.filter((c) => c.isPostable === value).map((c) => c.code)
      if (codes.length > 0) {
        await tx.ledgerAccount.updateMany({ where: { code: { in: codes } }, data: { isPostable: value } })
      }
    }

    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "import",
      before: null,
      after: {
        fileName: opts.fileName ?? null,
        fileSha256: createHash("sha256").update(csvText).digest("hex"),
        mapping,
        variant: opts.variant,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
      },
      reason: opts.reason ?? null,
      userId: opts.actor.userId,
    })
    return ok(summary)
    },
    // E3-T10: un import puede traer hasta `MAX_IMPORT_ROWS` cuentas; el
    // presupuesto por defecto de Prisma (5 s) aborta la transacción a mitad y
    // deja al usuario sin plan y sin mensaje. Mismo presupuesto que la siembra.
    opts.transaction ?? SEED_TRANSACTION_OPTIONS
  )
}

/** Atajo para código de aplicación que ya tiene el `orgId`. */
export const accountsDb = (organizationId: string) => tenantDb(organizationId)
