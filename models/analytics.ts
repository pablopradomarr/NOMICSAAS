/**
 * E4 · T10/T11 — Acceso a datos de la capa analítica
 * (`docs/design/E4-analitica.md` §4).
 *
 * Ninguna función de este módulo CALCULA: componen `AnalyticsConfig`, leen las
 * líneas y delegan en `lib/analytics/**`, que es puro. Toda query pasa por
 * `tenantDb` / `tenantTransaction` (barrera 1) y por RLS (barrera 2).
 */

import { randomUUID } from "node:crypto"

import { marginConfigHash } from "@/lib/analytics/hash"
import {
  checkReclassify,
  isNoop,
  type CurrentLine,
  type ReclassifyRequest,
  type ResolvedReclassification,
} from "@/lib/analytics/reclassify"
import {
  DEFAULT_BUSINESS_LINE_CODE,
  defaultBusinessLine,
  defaultCostCenters,
  defaultMarginLevels,
  UNASSIGNED_COST_CENTER_CODE,
  validateMarginLevels,
} from "@/lib/analytics/seed"
import type {
  AnalyticLine,
  AnalyticsConfig,
  AnalyticType,
  BusinessLineRef,
  CostCenterMarginLevel,
  CostCenterRef,
  LocalDate,
  MarginLevelRow,
  NonAnalyticLevel,
  ProjectRef,
} from "@/lib/analytics/types"
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import { getPlan } from "@/models/accounts"
import { writeAuditLog, writeAuditLogs } from "@/models/audit-log"
import {
  abort,
  abortWith,
  AnyClient,
  listFiscalYearRefs,
  listPeriodLockRefs,
  modelErr,
  runLedgerTransaction,
  type LedgerResult,
} from "@/models/ledger"
import { entryHash, type HashableLine } from "@/lib/ledger/hash"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import type { CostCenterKind, MarginLevel, ProjectStatus, Role } from "@/prisma/client"

export type Actor = { userId: string | null }

const PAGE_SIZE = 2000

// ─────────────────────────────────────────────────────────────────────────────
// Configuración analítica vigente para el periodo
// ─────────────────────────────────────────────────────────────────────────────

type OrgAnalyticsRow = { analytics_required: boolean; non_analytic_level: NonAnalyticLevel }

/**
 * `AnalyticsConfig` de la organización para el periodo del informe.
 *
 * La versión de `MarginLevelConfig` se elige por **la fecha del periodo**, no
 * por la de ejecución (§8.4): un ejercicio cerrado reimprime su PyG analítica
 * con la configuración que tenía.
 *
 * **Hallazgo #14 — una versión por informe, no por línea.** La configuración se
 * resuelve con `periodEnd`, así que un informe cuyo periodo cruzase el corte de
 * dos versiones usaría la segunda para todo el periodo. Es deliberado y no una
 * omisión: (a) la matriz es una sola tabla y mezclar dos repartos de niveles
 * dentro de ella daría una columna cuyo total no se puede explicar con ninguna
 * configuración concreta; (b) `MLC-4` abre las versiones en el borde de un
 * periodo, que es cuando tiene sentido cambiar de criterio; y (c) el
 * `marginConfigHash` que sella el informe identifica UNA versión, de modo que
 * la reproducibilidad (P7) exige que sea una sola. Si algún día hiciera falta
 * el corte intra-periodo, la vía es emitir dos informes y sumarlos, no partir
 * la matriz por dentro.
 */
export async function getAnalyticsConfig(
  tx: TenantTransactionClient,
  opts: { periodEnd: LocalDate }
): Promise<AnalyticsConfig> {
  const organizationId = tx.$organizationId
  const at = toUtcDate(opts.periodEnd)

  // El `$queryRaw` va solo: comparte conexión con las consultas de Prisma
  // dentro de la transacción y en paralelo dispara el aviso del adaptador `pg`.
  const orgRows = await tx.$queryRaw<OrgAnalyticsRow[]>`
    SELECT analytics_required, non_analytic_level FROM organizations WHERE id = ${organizationId}::uuid`

  const [businessLines, projects, costCenters, levels, plan] = await Promise.all([
    tx.businessLine.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    tx.project.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    tx.costCenter.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    tx.marginLevelConfig.findMany({
      where: { validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gte: at } }] },
      orderBy: { sortOrder: "asc" },
    }),
    getPlan(tx),
  ])

  const org = orgRows[0]
  if (!org) throw new Error(`getAnalyticsConfig: la organización ${organizationId} no es visible en esta transacción`)

  const analyticTypeByAccount = new Map<string, AnalyticType | null>(
    [...plan.byCode.entries()].map(([code, account]) => [code, account.analyticType])
  )

  return {
    organizationId,
    levels: levels.map(
      (l): MarginLevelRow => ({
        level: l.level,
        label: l.label,
        analyticTypes: l.analyticTypes,
        sortOrder: l.sortOrder,
        isVisible: l.isVisible,
        validFrom: fromUtcDate(l.validFrom),
        validTo: l.validTo ? fromUtcDate(l.validTo) : null,
      })
    ),
    businessLines: businessLines.map(
      (b): BusinessLineRef => ({ id: b.id, code: b.code, name: b.name, sortOrder: b.sortOrder, isActive: b.isActive })
    ),
    projects: projects.map(
      (p): ProjectRef => ({
        id: p.id,
        code: p.code,
        name: p.name,
        businessLineId: p.businessLineId,
        status: p.status,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
        closedAt: p.closedAt ? fromUtcDate(p.closedAt) : null,
      })
    ),
    costCenters: costCenters.map(
      (c): CostCenterRef => ({
        id: c.id,
        code: c.code,
        name: c.name,
        kind: c.kind,
        marginLevel: c.marginLevel as CostCenterMarginLevel,
        allocatable: c.allocatable,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        isSystem: c.isSystem,
      })
    ),
    unassignedCostCenterId: costCenters.find((c) => c.code === UNASSIGNED_COST_CENTER_CODE)?.id ?? null,
    analyticTypeByAccount,
    incomeTaxPrefixes: INCOME_TAX_PREFIXES,
    nonAnalyticLevel: org.non_analytic_level,
    analyticsRequired: org.analytics_required,
  }
}

/** Hash de la configuración vigente (entra en `analyticsHash`, E4-D2). */
export const configHashOf = (config: AnalyticsConfig): string => marginConfigHash(config)

// ─────────────────────────────────────────────────────────────────────────────
// Listados con recuento de líneas
// ─────────────────────────────────────────────────────────────────────────────

export type DimensionFilter = {
  includeArchived?: boolean
  /**
   * Hallazgo #15: `imputedCents` se acotaba a nada — sumaba TODO el histórico,
   * asientos de regularización y cierre incluidos, así que el importe imputado
   * de un proyecto salía duplicado (el gasto y su regularización) y mezclaba
   * ejercicios. Ahora el periodo es explícito y los `kind` de sistema quedan
   * fuera, exactamente igual que en I3/I4.
   */
  from?: LocalDate
  to?: LocalDate
}

/** Los `kind` que I3/I4 excluyen: también quedan fuera del importe imputado. */
const NON_PNL_KINDS = ["REGULARIZATION", "CLOSING", "OPENING"] as const

const imputedWhere = (filter: DimensionFilter) => ({
  entryKind: { notIn: [...NON_PNL_KINDS] },
  ...(filter.from || filter.to
    ? {
        entryDate: {
          ...(filter.from ? { gte: toUtcDate(filter.from) } : {}),
          ...(filter.to ? { lte: toUtcDate(filter.to) } : {}),
        },
      }
    : {}),
})

export type BusinessLineListItem = BusinessLineRef & { name: string; color: string; isSystem: boolean; projectCount: number; lineCount: number }
export type ProjectListItem = ProjectRef & { businessLineCode: string | null; lineCount: number; imputedCents: number }
export type CostCenterListItem = CostCenterRef & { lineCount: number; imputedCents: number }

export async function listBusinessLines(db: AnyClient, filter: DimensionFilter = {}): Promise<BusinessLineListItem[]> {
  const rows = await db.businessLine.findMany({
    where: filter.includeArchived ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { _count: { select: { projects: true, lines: true } } },
  })
  return rows.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    color: b.color,
    isSystem: b.isSystem,
    sortOrder: b.sortOrder,
    isActive: b.isActive,
    projectCount: b._count.projects,
    lineCount: b._count.lines,
  }))
}

export async function listProjects(db: AnyClient, filter: DimensionFilter = {}): Promise<ProjectListItem[]> {
  // En SERIE, no en paralelo: con `tenantDb` cada operación abre su propia
  // transacción, y si el llamante ya tiene una abierta las dos se despachan
  // sobre la MISMA conexión — el adaptador `pg` avisa entonces de «client is
  // already executing a query», y Next reenvía ese aviso a la consola del
  // navegador, donde los e2e lo tratan (con razón) como un error de servidor.
  const rows = await db.project.findMany({
    where: filter.includeArchived ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { businessLine: { select: { code: true } }, _count: { select: { lines: true } } },
  })
  const lines = await db.journalLine.groupBy({
    by: ["projectId"],
    where: { projectId: { not: null }, ...imputedWhere(filter) },
    _sum: { debitCents: true, creditCents: true },
  })
  const imputed = new Map(
    lines.map((l) => [l.projectId, (l._sum.creditCents ?? 0) - (l._sum.debitCents ?? 0)] as const)
  )
  return rows.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    businessLineId: p.businessLineId,
    businessLineCode: p.businessLine?.code ?? null,
    status: p.status,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    closedAt: p.closedAt ? fromUtcDate(p.closedAt) : null,
    lineCount: p._count.lines,
    imputedCents: imputed.get(p.id) ?? 0,
  }))
}

export async function listCostCenters(db: AnyClient, filter: DimensionFilter = {}): Promise<CostCenterListItem[]> {
  const rows = await db.costCenter.findMany({
    where: filter.includeArchived ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { _count: { select: { lines: true } } },
  })
  const lines = await db.journalLine.groupBy({
    by: ["costCenterId"],
    where: { costCenterId: { not: null }, ...imputedWhere(filter) },
    _sum: { debitCents: true, creditCents: true },
  })
  const imputed = new Map(
    lines.map((l) => [l.costCenterId, (l._sum.creditCents ?? 0) - (l._sum.debitCents ?? 0)] as const)
  )
  return rows.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    kind: c.kind,
    marginLevel: c.marginLevel as CostCenterMarginLevel,
    allocatable: c.allocatable,
    sortOrder: c.sortOrder,
    isActive: c.isActive,
    isSystem: c.isSystem,
    lineCount: c._count.lines,
    imputedCents: imputed.get(c.id) ?? 0,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Siembra (createOrganizationWithOwner / createOrganizationDefaults)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CECOs por defecto + los ocho niveles de margen + la línea de negocio
 * `GENERAL`. Idempotente: repetir el alta no crea nada nuevo y no pisa lo que
 * el ADMIN haya editado.
 */
export async function seedAnalyticsDefaults(
  tx: TenantTransactionClient,
  opts: { validFrom?: LocalDate; userId?: string | null } = {}
): Promise<{ businessLineId: string; costCenterIds: Record<string, string> }> {
  const organizationId = tx.$organizationId

  const bl = defaultBusinessLine()
  const businessLine = await tx.businessLine.upsert({
    where: { organizationId_code: { organizationId, code: bl.code } },
    update: {},
    create: { organizationId, code: bl.code, name: bl.name, sortOrder: bl.sortOrder, isSystem: bl.isSystem },
  })

  const costCenterIds: Record<string, string> = {}
  for (const cc of defaultCostCenters()) {
    const row = await tx.costCenter.upsert({
      where: { organizationId_code: { organizationId, code: cc.code } },
      update: {},
      create: {
        organizationId,
        code: cc.code,
        name: cc.name,
        kind: cc.kind,
        marginLevel: cc.marginLevel,
        allocatable: cc.allocatable,
        sortOrder: cc.sortOrder,
        isSystem: cc.isSystem,
        origin: "SEED",
      },
    })
    costCenterIds[cc.code] = row.id
  }

  // `validFrom` = inicio del ejercicio más antiguo, o 1970-01-01 si no hay.
  const oldest = await tx.fiscalYear.findFirst({ orderBy: { startDate: "asc" }, select: { startDate: true } })
  const validFrom = toUtcDate(opts.validFrom ?? (oldest ? fromUtcDate(oldest.startDate) : "1970-01-01"))

  for (const level of defaultMarginLevels()) {
    const existing = await tx.marginLevelConfig.findFirst({ where: { level: level.level } })
    if (existing) continue
    await tx.marginLevelConfig.create({
      data: {
        organizationId,
        level: level.level,
        label: level.label,
        analyticTypes: level.analyticTypes,
        sortOrder: level.sortOrder,
        validFrom,
      },
    })
  }

  await writeAuditLog(tx, {
    entity: "CostCenter",
    entityId: organizationId,
    action: "seed",
    after: { costCenters: Object.keys(costCenterIds), businessLine: bl.code, levels: 8 },
    userId: opts.userId ?? null,
  })

  return { businessLineId: businessLine.id, costCenterIds }
}

/** Id de la línea de negocio por defecto, sembrándola si hiciera falta. */
export async function defaultBusinessLineId(db: AnyClient): Promise<string> {
  const organizationId = db.$organizationId
  const existing = await db.businessLine.findUnique({
    where: { organizationId_code: { organizationId, code: DEFAULT_BUSINESS_LINE_CODE } },
  })
  if (existing) return existing.id
  const bl = defaultBusinessLine()
  const created = await db.businessLine.create({
    data: { organizationId, code: bl.code, name: bl.name, sortOrder: bl.sortOrder, isSystem: bl.isSystem },
  })
  return created.id
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD de dimensiones
// ─────────────────────────────────────────────────────────────────────────────

export type BusinessLineInput = { code: string; name: string; color?: string; sortOrder?: number }

export async function createBusinessLine(tx: TenantTransactionClient, input: BusinessLineInput, actor: Actor) {
  const row = await tx.businessLine.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      ...(input.color ? { color: input.color } : {}),
      sortOrder: input.sortOrder ?? 0,
    },
  })
  await writeAuditLog(tx, { entity: "BusinessLine", entityId: row.id, action: "create", after: row, userId: actor.userId })
  return row
}

export async function updateBusinessLine(
  tx: TenantTransactionClient,
  id: string,
  input: Partial<BusinessLineInput>,
  actor: Actor
) {
  const before = await tx.businessLine.findUnique({ where: { id } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "La línea de negocio no existe en esta organización"))
  const row = await tx.businessLine.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  })
  await writeAuditLog(tx, { entity: "BusinessLine", entityId: id, action: "update", before, after: row, userId: actor.userId })
  return row
}

export type ProjectInput = {
  code: string
  name: string
  businessLineId: string
  status?: ProjectStatus
  counterpartyId?: string | null
  startDate?: LocalDate | null
  endDate?: LocalDate | null
  budgetRevenueCents?: number | null
  budgetCostCents?: number | null
  color?: string
  sortOrder?: number
}

export async function createAnalyticProject(tx: TenantTransactionClient, input: ProjectInput, actor: Actor) {
  const row = await tx.project.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      businessLineId: input.businessLineId,
      status: input.status ?? "ACTIVE",
      counterpartyId: input.counterpartyId ?? null,
      startDate: input.startDate ? toUtcDate(input.startDate) : null,
      endDate: input.endDate ? toUtcDate(input.endDate) : null,
      budgetRevenueCents: input.budgetRevenueCents ?? null,
      budgetCostCents: input.budgetCostCents ?? null,
      ...(input.color ? { color: input.color } : {}),
      sortOrder: input.sortOrder ?? 0,
    },
  })
  await writeAuditLog(tx, { entity: "Project", entityId: row.id, action: "create", after: row, userId: actor.userId })
  return row
}

export async function updateAnalyticProject(
  tx: TenantTransactionClient,
  id: string,
  input: Partial<ProjectInput>,
  actor: Actor
) {
  const before = await tx.project.findUnique({ where: { id }, include: { _count: { select: { lines: true } } } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El proyecto no existe en esta organización"))
  // R-A9: mover un proyecto de línea de negocio NO recalcula las líneas ya
  // escritas, así que sólo se admite mientras no tenga ninguna.
  if (input.businessLineId !== undefined && input.businessLineId !== before.businessLineId && before._count.lines > 0) {
    abort(
      modelErr(
        "PERMISSION_DENIED",
        "businessLineId",
        `El proyecto ${before.code} ya tiene ${before._count.lines} línea(s) de diario: cambiar su línea de negocio ` +
          "es una reclasificación en masa (ADR-0010), no una edición de la ficha (R-A9)"
      )
    )
  }
  const row = await tx.project.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.businessLineId !== undefined ? { businessLineId: input.businessLineId } : {}),
      ...(input.counterpartyId !== undefined ? { counterpartyId: input.counterpartyId } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate ? toUtcDate(input.startDate) : null } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate ? toUtcDate(input.endDate) : null } : {}),
      ...(input.budgetRevenueCents !== undefined ? { budgetRevenueCents: input.budgetRevenueCents } : {}),
      ...(input.budgetCostCents !== undefined ? { budgetCostCents: input.budgetCostCents } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  })
  await writeAuditLog(tx, { entity: "Project", entityId: id, action: "update", before, after: row, userId: actor.userId })
  return row
}

/** Cierre de proyecto: fija `closedAt` (I-E4-10 no es comprobable sin fecha). */
export async function closeProject(tx: TenantTransactionClient, id: string, closedAt: LocalDate, actor: Actor) {
  const before = await tx.project.findUnique({ where: { id } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El proyecto no existe en esta organización"))
  const row = await tx.project.update({
    where: { id },
    data: { status: "CLOSED", closedAt: toUtcDate(closedAt), closedById: actor.userId },
  })
  await writeAuditLog(tx, { entity: "Project", entityId: id, action: "close", before, after: row, userId: actor.userId })
  return row
}

export async function reopenProject(tx: TenantTransactionClient, id: string, actor: Actor) {
  const before = await tx.project.findUnique({ where: { id } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El proyecto no existe en esta organización"))
  const row = await tx.project.update({ where: { id }, data: { status: "ACTIVE", closedAt: null, closedById: null } })
  await writeAuditLog(tx, { entity: "Project", entityId: id, action: "open", before, after: row, userId: actor.userId })
  return row
}

export type CostCenterInput = {
  code: string
  name: string
  kind: CostCenterKind
  marginLevel: CostCenterMarginLevel
  allocatable?: boolean
  sortOrder?: number
}

export async function createCostCenter(tx: TenantTransactionClient, input: CostCenterInput, actor: Actor) {
  if (input.kind === "SIN_ASIGNAR") {
    abort(modelErr("PERMISSION_DENIED", "kind", "El kind SIN_ASIGNAR es de sistema: solo lo crea la semilla"))
  }
  const row = await tx.costCenter.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      marginLevel: input.marginLevel,
      allocatable: input.allocatable ?? true,
      sortOrder: input.sortOrder ?? 0,
      origin: "MANUAL",
    },
  })
  await writeAuditLog(tx, { entity: "CostCenter", entityId: row.id, action: "create", after: row, userId: actor.userId })
  return row
}

export async function updateCostCenter(
  tx: TenantTransactionClient,
  id: string,
  input: Partial<CostCenterInput>,
  actor: Actor
) {
  const before = await tx.costCenter.findUnique({ where: { id } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El centro de coste no existe en esta organización"))
  if (before.isSystem && (input.kind !== undefined || input.marginLevel !== undefined || input.allocatable !== undefined)) {
    abort(modelErr("PERMISSION_DENIED", "kind", `${before.code} es de sistema: su kind, nivel e imputabilidad no cambian`))
  }
  const row = await tx.costCenter.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.marginLevel !== undefined ? { marginLevel: input.marginLevel } : {}),
      ...(input.allocatable !== undefined ? { allocatable: input.allocatable } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    },
  })
  await writeAuditLog(tx, { entity: "CostCenter", entityId: id, action: "update", before, after: row, userId: actor.userId })
  return row
}

/** Nada se borra: se archiva. `CC-NA` y la LN de sistema no se archivan. */
export async function archiveDimension(
  tx: TenantTransactionClient,
  kind: "BusinessLine" | "Project" | "CostCenter",
  id: string,
  reason: string,
  actor: Actor,
  now: Date
) {
  if (kind === "CostCenter") {
    const before = await tx.costCenter.findUnique({ where: { id } })
    if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El centro de coste no existe"))
    if (before.isSystem) abort(modelErr("PERMISSION_DENIED", "id", `${before.code} es de sistema y no se archiva`))
    const row = await tx.costCenter.update({ where: { id }, data: { isActive: false, archivedAt: now } })
    await writeAuditLog(tx, { entity: "CostCenter", entityId: id, action: "archive", before, after: row, reason, userId: actor.userId })
    return row
  }
  if (kind === "BusinessLine") {
    const before = await tx.businessLine.findUnique({ where: { id } })
    if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "La línea de negocio no existe"))
    if (before.isSystem) abort(modelErr("PERMISSION_DENIED", "id", `${before.code} es de sistema y no se archiva`))
    const row = await tx.businessLine.update({ where: { id }, data: { isActive: false, archivedAt: now } })
    await writeAuditLog(tx, { entity: "BusinessLine", entityId: id, action: "archive", before, after: row, reason, userId: actor.userId })
    return row
  }
  const before = await tx.project.findUnique({ where: { id } })
  if (!before) abort(modelErr("ENTRY_NOT_FOUND", "id", "El proyecto no existe"))
  const row = await tx.project.update({ where: { id }, data: { isActive: false, archivedAt: now } })
  await writeAuditLog(tx, { entity: "Project", entityId: id, action: "archive", before, after: row, reason, userId: actor.userId })
  return row
}

// ─────────────────────────────────────────────────────────────────────────────
// MarginLevelConfig (MLC-4: cerrar versión y abrir otra)
// ─────────────────────────────────────────────────────────────────────────────

export type MarginLevelInput = { level: MarginLevel; label: string; analyticTypes: AnalyticType[]; isVisible?: boolean }

/**
 * MLC-4: cambiar la configuración **abre una versión nueva** (`validFrom`) y
 * cierra la anterior (`validTo` = el día anterior). Nunca se reescribe un
 * histórico en silencio; el `analyticsHash` cambia y caduca los `ReportRun`
 * analíticos del periodo.
 */
export async function updateMarginLevelConfig(
  tx: TenantTransactionClient,
  input: { rows: readonly MarginLevelInput[]; validFrom: LocalDate },
  actor: Actor
) {
  const issues = validateMarginLevels(input.rows)
  if (issues.length > 0) {
    abort(...issues.map((i) => modelErr("TEMPLATE_INPUT", "analyticTypes", i.message, { check: i.code })))
  }
  const organizationId = tx.$organizationId
  const from = toUtcDate(input.validFrom)
  const dayBefore = new Date(from.getTime() - 24 * 3600 * 1000)

  const current = await tx.marginLevelConfig.findMany({
    where: { OR: [{ validTo: null }, { validTo: { gte: from } }] },
  })
  for (const row of current) {
    if (row.validFrom >= from) {
      abort(modelErr("TEMPLATE_INPUT", "validFrom", `Ya existe una versión de ${row.level} desde ${fromUtcDate(row.validFrom)}`))
    }
    await tx.marginLevelConfig.update({ where: { id: row.id }, data: { validTo: dayBefore } })
  }
  const created = []
  for (const row of input.rows) {
    created.push(
      await tx.marginLevelConfig.create({
        data: {
          organizationId,
          level: row.level,
          label: row.label,
          analyticTypes: row.analyticTypes,
          sortOrder: defaultMarginLevels().find((d) => d.level === row.level)?.sortOrder ?? 0,
          isVisible: row.isVisible ?? true,
          validFrom: from,
        },
      })
    )
  }
  await writeAuditLog(tx, {
    entity: "MarginLevelConfig",
    entityId: organizationId,
    action: "update",
    before: current,
    after: created,
    userId: actor.userId,
  })
  return created
}

/** O-A9: cambiar `analyticType` de una cuenta mueve importe entre niveles. */
export async function updateAccountAnalyticType(
  tx: TenantTransactionClient,
  accountCode: string,
  analyticType: AnalyticType | null,
  reason: string,
  actor: Actor
) {
  const organizationId = tx.$organizationId
  const before = await tx.ledgerAccount.findUnique({ where: { organizationId_code: { organizationId, code: accountCode } } })
  if (!before) abort(modelErr("ACCOUNT_UNKNOWN", "accountCode", `La cuenta ${accountCode} no existe en el plan`))
  const closedRows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n
      FROM journal_lines l
      JOIN fiscal_years fy ON fy.id = l.fiscal_year_id
     WHERE l.organization_id = ${organizationId}::uuid AND l.account_code = ${accountCode} AND fy.status = 'CLOSED'`
  const closedLines = Number(closedRows[0]?.n ?? 0)
  if (closedLines > 0) {
    abort(
      modelErr(
        "FY_CLOSED",
        "accountCode",
        `La cuenta ${accountCode} tiene ${closedLines} línea(s) en un ejercicio cerrado: su tipo analítico no se cambia (O-A9)`
      )
    )
  }
  const row = await tx.ledgerAccount.update({
    where: { organizationId_code: { organizationId, code: accountCode } },
    data: { analyticType },
  })
  await writeAuditLog(tx, {
    entity: "LedgerAccount",
    entityId: row.id,
    action: "update",
    before: { analyticType: before.analyticType },
    after: { analyticType },
    reason,
    userId: actor.userId,
  })
  return row
}

export async function setOrganizationAnalyticsPolicy(
  tx: TenantTransactionClient,
  input: { analyticsRequired?: boolean; nonAnalyticLevel?: NonAnalyticLevel },
  actor: Actor
) {
  const organizationId = tx.$organizationId
  const before = await tx.$queryRaw<OrgAnalyticsRow[]>`
    SELECT analytics_required, non_analytic_level FROM organizations WHERE id = ${organizationId}::uuid`
  if (input.analyticsRequired !== undefined) {
    await tx.$executeRaw`UPDATE organizations SET analytics_required = ${input.analyticsRequired}
                          WHERE id = ${organizationId}::uuid`
  }
  if (input.nonAnalyticLevel !== undefined) {
    // El CHECK `organizations_non_analytic_level` es la segunda barrera: aquí el
    // valor viaja PARAMETRIZADO y el enum lo valida Postgres.
    await tx.$executeRaw`UPDATE organizations SET non_analytic_level = ${input.nonAnalyticLevel}::margin_level
                          WHERE id = ${organizationId}::uuid`
  }
  await writeAuditLog(tx, {
    entity: "Organization",
    entityId: organizationId,
    action: "update",
    before: before[0],
    after: input,
    userId: actor.userId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura de líneas para la matriz
// ─────────────────────────────────────────────────────────────────────────────

export type AnalyticLineFilter = {
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string
  projectId?: string
  costCenterId?: string
}

type AnalyticLineRow = {
  id: string
  entry_id: string
  entry_number: number
  entry_date: Date
  entry_kind: AnalyticLine["entryKind"]
  fiscal_year_id: string
  line_no: number
  account_code: string
  debit_cents: number
  credit_cents: number
  analytic_type: AnalyticType | null
  project_id: string | null
  cost_center_id: string | null
  business_line_id: string | null
}

/** Lectura paginada (2.000, patrón #9 de E3). El motor puro agrega después. */
export async function getAnalyticLines(
  tx: TenantTransactionClient,
  filter: AnalyticLineFilter
): Promise<AnalyticLine[]> {
  const organizationId = tx.$organizationId
  const out: AnalyticLine[] = []
  let cursor: { date: Date; number: number; lineNo: number } | null = null

  for (;;) {
    const rows: AnalyticLineRow[] = await tx.$queryRaw<AnalyticLineRow[]>`
      SELECT l.id, l.entry_id, e.entry_number, l.entry_date, l.entry_kind, l.fiscal_year_id, l.line_no,
             l.account_code, l.debit_cents, l.credit_cents, l.analytic_type,
             l.project_id, l.cost_center_id, l.business_line_id
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId}::uuid
         AND l.entry_date BETWEEN ${toUtcDate(filter.from)}::date AND ${toUtcDate(filter.to)}::date
         AND (${filter.fiscalYearId ?? null}::uuid IS NULL OR l.fiscal_year_id = ${filter.fiscalYearId ?? null}::uuid)
         AND (${filter.projectId ?? null}::uuid IS NULL OR l.project_id = ${filter.projectId ?? null}::uuid)
         AND (${filter.costCenterId ?? null}::uuid IS NULL OR l.cost_center_id = ${filter.costCenterId ?? null}::uuid)
         AND (${cursor === null}::boolean
              OR (l.entry_date, e.entry_number, l.line_no) >
                 (${cursor?.date ?? new Date(0)}::date, ${cursor?.number ?? 0}::int, ${cursor?.lineNo ?? 0}::int))
       ORDER BY l.entry_date, e.entry_number, l.line_no
       LIMIT ${PAGE_SIZE}`
    if (rows.length === 0) break
    for (const r of rows) {
      out.push({
        id: r.id,
        entryId: r.entry_id,
        entryNumber: r.entry_number,
        entryDate: fromUtcDate(r.entry_date),
        entryKind: r.entry_kind,
        fiscalYearId: r.fiscal_year_id,
        lineNo: r.line_no,
        accountCode: r.account_code,
        debitCents: r.debit_cents,
        creditCents: r.credit_cents,
        analyticType: r.analytic_type,
        projectId: r.project_id,
        costCenterId: r.cost_center_id,
        businessLineId: r.business_line_id,
      })
    }
    const last = rows[rows.length - 1]
    cursor = { date: last.entry_date, number: last.entry_number, lineNo: last.line_no }
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Reclasificación analítica (ADR-0010, §2.6)
// ─────────────────────────────────────────────────────────────────────────────

export type ReclassifyResult = {
  applied: ResolvedReclassification[]
  /** `entryHash` antes y después de cada asiento afectado (salvaguarda 2). */
  entryHashes: { entryId: string; before: string; after: string }[]
}

/**
 * Única función que ESCRIBE sobre `journal_lines`. Valida con `checkReclassify`,
 * aplica el `UPDATE` de las cuatro columnas, **recalcula `entry_hash`** de cada
 * asiento afectado y escribe el `AuditLog` — todo dentro de una sola
 * transacción, con `abort()` en cualquier fallo (lección BLOQUEA-1 de E3: un
 * `return` no aborta).
 *
 * Lo que NO cambia: `ledgerHash` del periodo (E4-D2), y por tanto el balance, la
 * PyG contable, el cashflow y el diario ya sellados.
 */
export async function reclassifyLines(
  organizationId: string,
  request: ReclassifyRequest,
  actor: Actor & { role: Role },
  opts: { refDate: LocalDate }
): Promise<LedgerResult<ReclassifyResult>> {
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const config = await getAnalyticsConfig(tx, { periodEnd: opts.refDate })
    const [fiscalYears, periodLocks] = await Promise.all([listFiscalYearRefs(tx), listPeriodLockRefs(tx)])

    const rows = await tx.journalLine.findMany({
      where: { id: { in: request.targets.map((t) => t.lineId) } },
      include: {
        entry: {
          // `voidedAt` y `reversedBy` deciden si el asiento está anulado:
          // reclasificar una línea con contra-asiento vivo rompería I-E4-11.
          select: { entryNumber: true, voidedAt: true, _count: { select: { reversedBy: true } } },
        },
      },
    })
    const current: CurrentLine[] = rows.map((l) => ({
      id: l.id,
      entryId: l.entryId,
      entryNumber: l.entry.entryNumber,
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      entryDate: fromUtcDate(l.entryDate),
      fiscalYearId: l.fiscalYearId,
      entryKind: l.entryKind,
      isVoided: l.entry.voidedAt !== null || l.entry._count.reversedBy > 0,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
      businessLineId: l.businessLineId,
      analyticType: l.analyticType,
    }))

    const checked = checkReclassify(request, current, {
      config,
      role: actor.role,
      fiscalYears: fiscalYears.map((f) => ({ id: f.id, code: f.code, status: f.status })),
      periodLocks,
    })
    if (!checked.ok) abortWith(checked.errors)

    const applied = checked.value.filter((r) => !isNoop(r))
    if (applied.length === 0) return { applied: [], entryHashes: [] }

    for (const r of applied) {
      await tx.journalLine.update({
        where: { id: r.lineId },
        data: {
          projectId: r.after.projectId,
          costCenterId: r.after.costCenterId,
          businessLineId: r.after.businessLineId,
          analyticType: r.after.analyticType,
        },
      })
    }

    // Salvaguarda 2: el sello de fila se REHACE, no se rompe. I-E3-7 sigue PASS.
    const entryHashes: ReclassifyResult["entryHashes"] = []
    for (const entryId of [...new Set(applied.map((r) => r.entryId))]) {
      const entry = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } })
      if (!entry) abort(modelErr("ENTRY_NOT_FOUND", "entryId", `El asiento ${entryId} no es legible en esta transacción`))
      const hashable: HashableLine[] = entry.lines.map((l) => ({
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        entryDate: fromUtcDate(l.entryDate),
        fiscalYearId: l.fiscalYearId,
        entryKind: l.entryKind,
        taxRateId: l.taxRateId,
        taxBaseCents: l.taxBaseCents,
        counterpartyId: l.counterpartyId,
        dueDate: l.dueDate ? fromUtcDate(l.dueDate) : null,
        description: l.description,
        analyticType: l.analyticType,
        projectId: l.projectId,
        costCenterId: l.costCenterId,
        businessLineId: l.businessLineId,
      }))
      const after = entryHash(hashable)
      entryHashes.push({ entryId, before: entry.entryHash, after })
      await tx.journalEntry.update({ where: { id: entryId }, data: { entryHash: after } })
    }

    // E4-UI-1.c — Auditoría: **una fila por línea reclasificada** más una de
    // resumen. Antes se escribía una sola fila con `entityId` = los ids de todas
    // las líneas concatenados por comas; `audit_logs.entity_id` es VARCHAR(64),
    // así que a partir de la segunda línea (36 caracteres por UUID) el INSERT
    // fallaba con «value too long» y se perdía la transacción entera. `before` y
    // `after` sí son JSONB y nunca fueron el problema.
    const reason = request.reason.trim()
    const batchId = randomUUID()
    const hashBefore = new Map(entryHashes.map((h) => [h.entryId, h.before]))
    const hashAfter = new Map(entryHashes.map((h) => [h.entryId, h.after]))

    await writeAuditLogs(tx, [
      {
        // Resumen de la operación, direccionable por su propio id de lote.
        entity: "JournalLine",
        entityId: batchId,
        action: "RECLASSIFY_ANALYTICS",
        before: {
          batchId,
          lineCount: applied.length,
          entryHashes: entryHashes.map((h) => ({ entryId: h.entryId, entryHash: h.before })),
        },
        after: {
          batchId,
          lineCount: applied.length,
          lineIds: applied.map((r) => r.lineId),
          entryHashes: entryHashes.map((h) => ({ entryId: h.entryId, entryHash: h.after })),
        },
        reason,
        userId: actor.userId,
      },
      ...applied.map((r) => ({
        entity: "JournalLine" as const,
        entityId: r.lineId,
        action: "RECLASSIFY_ANALYTICS" as const,
        before: { batchId, lineId: r.lineId, entryId: r.entryId, ...r.before, entryHash: hashBefore.get(r.entryId) ?? null },
        after: { batchId, lineId: r.lineId, entryId: r.entryId, ...r.after, entryHash: hashAfter.get(r.entryId) ?? null },
        reason,
        userId: actor.userId,
      })),
    ])

    return { applied, entryHashes }
  })
}

export type { ReclassifyRequest, ResolvedReclassification }
export type { TenantClient }
