/**
 * E5 · T9 — Acceso a datos de la liquidación de CECOs
 * (`docs/design/E5-liquidacion.md` §4.1).
 *
 * **Ninguna función calcula**: componen el contexto, delegan en
 * `lib/analytics/allocate.ts` —que es puro— y escriben. Todo acceso pasa por
 * `tenantDb` / `tenantTransaction`; toda escritura lleva su `AuditLog` **en la
 * misma transacción**, y todo aborto es un `throw` (lección BLOQUEA-1 de E3: un
 * `return` dentro de `tenantTransaction` NO deshace nada, Prisma hace COMMIT).
 */

import { randomUUID } from "node:crypto"

import { allocationRunSetHash, dimensionsHash, marginConfigHash } from "@/lib/analytics/hash"
import {
  allocate,
  canonicalRun,
  effectiveRules,
  periodBounds,
  periodLabel,
  rulesHash as computeRulesHash,
  type AllocationError,
  type AllocationPeriodRef,
  type AllocationResult,
  type AllocationRuleSpec,
  type AppliedAllocation,
  type PriorAllocation,
  type TargetFilter,
} from "@/lib/analytics/allocate"
import type { AnalyticLine, Cents, CostCenterMarginLevel, LocalDate } from "@/lib/analytics/types"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { getAnalyticLines, getAnalyticsConfig, type Actor } from "@/models/analytics"
import { writeAuditLog } from "@/models/audit-log"
import { LedgerAbort, computeLedgerHash, modelErr, type LedgerModelError } from "@/models/ledger"
import type { AllocationRunStatus, AllocPeriod, Driver, Prisma, TargetKind, ZeroBaseFallback } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// Traducción de errores del motor al español contable
// ─────────────────────────────────────────────────────────────────────────────

/** El código del motor ES el código del error de modelo: no se pierde nada. */
export const allocationError = (error: AllocationError): LedgerModelError =>
  modelErr(error.code, "reglas", error.message)

/**
 * Abortar es **lanzar**, nunca `return`: dentro de `tenantTransaction` un
 * `return` resuelve la promesa y Prisma hace COMMIT (lección BLOQUEA-1 de E3).
 */
function abortWith(errors: readonly LedgerModelError[]): never {
  throw new LedgerAbort(errors)
}

function abortAllocation(error: AllocationError): never {
  abortWith([allocationError(error)])
}

// ─────────────────────────────────────────────────────────────────────────────
// Reglas
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationRuleListItem = {
  id: string
  code: string
  name: string
  sourceCostCenterId: string
  sourceCostCenterCode: string
  targetKind: TargetKind
  driver: Driver
  period: AllocPeriod
  priority: number
  sourceShareBps: number
  zeroBaseFallback: ZeroBaseFallback
  targetFilter: TargetFilter | null
  validFrom: LocalDate
  validTo: LocalDate | null
  isActive: boolean
  /** Con líneas emitidas la regla ya no se edita: se versiona (trigger en BD). */
  lineCount: number
  targets: {
    id: string
    projectId: string | null
    businessLineId: string | null
    costCenterId: string | null
    percentBps: number | null
    amountCents: number | null
    sortOrder: number
  }[]
}

type RuleRow = Prisma.AllocationRuleGetPayload<{ include: { targets: true; _count: { select: { lines: true } } } }>

const toSpec = (row: RuleRow): AllocationRuleSpec => ({
  id: row.id,
  code: row.code,
  name: row.name,
  sourceCostCenterId: row.sourceCostCenterId,
  targetKind: row.targetKind,
  driver: row.driver,
  period: row.period,
  priority: row.priority,
  sourceShareBps: row.sourceShareBps,
  zeroBaseFallback: row.zeroBaseFallback,
  targetFilter: (row.targetFilter as TargetFilter | null) ?? null,
  validFrom: fromUtcDate(row.validFrom),
  validTo: row.validTo ? fromUtcDate(row.validTo) : null,
  isActive: row.isActive,
  targets: [...row.targets]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({
      projectId: t.projectId,
      businessLineId: t.businessLineId,
      costCenterId: t.costCenterId,
      percentBps: t.percentBps,
      amountCents: t.amountCents,
      sortOrder: t.sortOrder,
    })),
})

const RULE_INCLUDE = { targets: true, _count: { select: { lines: true } } } as const

export async function listAllocationRules(
  db: TenantClient | TenantTransactionClient,
  filter: { includeClosed?: boolean; period?: AllocPeriod } = {}
): Promise<AllocationRuleListItem[]> {
  const rows = await db.allocationRule.findMany({
    where: {
      ...(filter.includeClosed === true ? {} : { isActive: true }),
      ...(filter.period ? { period: filter.period } : {}),
    },
    include: RULE_INCLUDE,
    orderBy: [{ period: "asc" }, { priority: "asc" }, { code: "asc" }, { validFrom: "asc" }],
  })
  const cecos = await db.costCenter.findMany({ select: { id: true, code: true } })
  const codeById = new Map(cecos.map((c) => [c.id, c.code]))
  return rows.map((row) => {
    const spec = toSpec(row)
    return {
      ...spec,
      sourceCostCenterCode: codeById.get(row.sourceCostCenterId) ?? row.sourceCostCenterId,
      lineCount: row._count.lines,
      targets: [...row.targets]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((t) => ({
          id: t.id,
          projectId: t.projectId,
          businessLineId: t.businessLineId,
          costCenterId: t.costCenterId,
          percentBps: t.percentBps,
          amountCents: t.amountCents,
          sortOrder: t.sortOrder,
        })),
    }
  })
}

/** Las reglas VIGENTES a `periodEnd`, tal y como el motor puro las consume. */
export async function getAllocationRuleSpecs(
  db: TenantClient | TenantTransactionClient,
  opts: { periodEnd: LocalDate; period?: AllocPeriod }
): Promise<AllocationRuleSpec[]> {
  const at = toUtcDate(opts.periodEnd)
  const rows = await db.allocationRule.findMany({
    where: {
      isActive: true,
      ...(opts.period ? { period: opts.period } : {}),
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gte: at } }],
    },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { code: "asc" }],
  })
  return rows.map(toSpec)
}

export type AllocationRuleInput = {
  code: string
  name: string
  sourceCostCenterId: string
  targetKind: TargetKind
  driver: Driver
  period: AllocPeriod
  priority: number
  sourceShareBps: number
  zeroBaseFallback: ZeroBaseFallback
  targetFilter: TargetFilter | null
  validFrom: LocalDate
  validTo: LocalDate | null
  targets: {
    projectId?: string | null
    businessLineId?: string | null
    costCenterId?: string | null
    percentBps?: number | null
    amountCents?: number | null
  }[]
}

/**
 * Alta de regla. La coherencia del grafo la comprueban DOS barreras: aquí, con
 * el mensaje que el usuario necesita (los CECOs del ciclo por su nombre), y el
 * constraint trigger diferido al confirmar, que es lo que impide que un camino
 * que se salte la acción lo cuele. Mismo patrón «código + trigger» que
 * `Σdebe = Σhaber` en E3.
 */
export async function createAllocationRuleTx(
  tx: TenantTransactionClient,
  input: AllocationRuleInput,
  actor: Actor,
  /**
   * `skipSetCheck` sólo lo usa `createAllocationRulesTx`: un reparto 30/70 se
   * declara con DOS reglas, y comprobar `Σ sourceShareBps = 10000` tras la
   * primera rechazaría un conjunto que va a ser correcto. El conjunto se
   * comprueba una vez, al final de la misma transacción.
   */
  opts: { skipSetCheck?: boolean } = {}
): Promise<AllocationRuleListItem> {
  if (input.driver === "HOURS" || input.driver === "HEADCOUNT") {
    abortAllocation({
      code: "DRIVER_UNAVAILABLE",
      message: `el driver ${input.driver === "HOURS" ? "HORAS" : "PLANTILLA"} necesita partes de horas, que llegan en E10. Elige otro driver o deja el CECO sin liquidar`,
    })
  }

  const created = await tx.allocationRule.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      sourceCostCenterId: input.sourceCostCenterId,
      targetKind: input.targetKind,
      driver: input.driver,
      period: input.period,
      priority: input.priority,
      sourceShareBps: input.sourceShareBps,
      zeroBaseFallback: input.zeroBaseFallback,
      targetFilter: (input.targetFilter ?? undefined) as Prisma.InputJsonValue | undefined,
      validFrom: toUtcDate(input.validFrom),
      validTo: input.validTo ? toUtcDate(input.validTo) : null,
      createdById: actor.userId,
      targets: {
        // `organizationId` NO se pasa: es columna de dos relaciones compuestas
        // (`rule` y `organization`), así que Prisma la gestiona desde el padre.
        create: input.targets.map((t, index) => ({
          projectId: t.projectId ?? null,
          businessLineId: t.businessLineId ?? null,
          costCenterId: t.costCenterId ?? null,
          percentBps: t.percentBps ?? null,
          amountCents: t.amountCents ?? null,
          sortOrder: index,
        })),
      },
    },
    include: RULE_INCLUDE,
  })

  if (opts.skipSetCheck !== true) {
    await assertRuleSetCoherent(tx, input.period, fromUtcDate(created.validFrom))
  }

  await writeAuditLog(tx, {
    entity: "AllocationRule",
    entityId: created.id,
    action: "create",
    after: toSpec(created),
    userId: actor.userId,
  })
  return { ...toSpec(created), sourceCostCenterCode: "", lineCount: 0, targets: created.targets.map((t) => ({ ...t })) }
}

/**
 * Alta de un CONJUNTO de reglas en una sola transacción.
 *
 * Es la vía correcta para declarar un reparto fraccionado (30 % a un sitio,
 * 70 % a otro): `Σ sourceShareBps = 10000` se comprueba **una vez, al final**,
 * porque un conjunto se juzga entero. Guardarlas de una en una haría que la
 * primera —correcta como parte del conjunto— fuese rechazada por sí sola.
 */
export async function createAllocationRulesTx(
  tx: TenantTransactionClient,
  inputs: readonly AllocationRuleInput[],
  actor: Actor
): Promise<AllocationRuleListItem[]> {
  const created: AllocationRuleListItem[] = []
  for (const input of inputs) {
    created.push(await createAllocationRuleTx(tx, input, actor, { skipSetCheck: true }))
  }
  const seen = new Map<string, string>()
  for (const input of inputs) seen.set(`${input.period}|${input.validFrom}`, input.period)
  for (const [key, period] of seen) {
    await assertRuleSetCoherent(tx, period as AllocPeriod, key.split("|")[1])
  }
  return created
}

/**
 * Versionado. **NUNCA edita una regla con líneas**: cierra la vigente con
 * `validTo = validFrom − 1` y crea la sucesora con el MISMO `code` y otro `id`.
 * El coste es una fila más; el beneficio es que el pasado no cambia y cualquier
 * informe histórico sigue siendo reproducible.
 */
export async function supersedeAllocationRuleTx(
  tx: TenantTransactionClient,
  input: { ruleId: string; validFrom: LocalDate; changes: Partial<AllocationRuleInput>; reason: string },
  actor: Actor
): Promise<AllocationRuleListItem> {
  const current = await tx.allocationRule.findFirst({ where: { id: input.ruleId }, include: RULE_INCLUDE })
  if (!current) abortWith([modelErr("ALLOCATION_RULE_NOT_FOUND", "ruleId", "la regla no existe en esta organización")])
  const before = toSpec(current)
  if (input.validFrom <= before.validFrom) {
    abortWith([
      modelErr(
        "FY_DATES",
        "validFrom",
        `la nueva versión empieza el ${input.validFrom} y la vigente el ${before.validFrom}: la sucesora tiene que empezar después`
      ),
    ])
  }

  await tx.allocationRule.update({
    where: { id: current.id },
    data: { validTo: toUtcDate(previousDay(input.validFrom)), closedById: actor.userId },
  })

  const next = await createAllocationRuleTx(
    tx,
    {
      code: before.code,
      name: input.changes.name ?? before.name,
      sourceCostCenterId: input.changes.sourceCostCenterId ?? before.sourceCostCenterId,
      targetKind: input.changes.targetKind ?? before.targetKind,
      driver: input.changes.driver ?? before.driver,
      period: input.changes.period ?? before.period,
      priority: input.changes.priority ?? before.priority,
      sourceShareBps: input.changes.sourceShareBps ?? before.sourceShareBps,
      zeroBaseFallback: input.changes.zeroBaseFallback ?? before.zeroBaseFallback,
      targetFilter: input.changes.targetFilter ?? before.targetFilter,
      validFrom: input.validFrom,
      validTo: input.changes.validTo ?? null,
      targets: input.changes.targets ?? before.targets.map((t) => ({ ...t })),
    },
    actor
  )

  await writeAuditLog(tx, {
    entity: "AllocationRule",
    entityId: current.id,
    action: "supersede",
    before,
    after: { supersededBy: next.id, validTo: previousDay(input.validFrom) },
    reason: input.reason,
    userId: actor.userId,
  })
  return next
}

/** Apaga una regla sin sustituirla: se cierra con `validTo`, nunca se borra. */
export async function closeAllocationRuleTx(
  tx: TenantTransactionClient,
  input: { ruleId: string; validTo: LocalDate; reason: string },
  actor: Actor
): Promise<void> {
  const current = await tx.allocationRule.findFirst({ where: { id: input.ruleId }, include: RULE_INCLUDE })
  if (!current) abortWith([modelErr("ALLOCATION_RULE_NOT_FOUND", "ruleId", "la regla no existe en esta organización")])
  await tx.allocationRule.update({
    where: { id: current.id },
    data: { validTo: toUtcDate(input.validTo), isActive: false, closedById: actor.userId },
  })
  await writeAuditLog(tx, {
    entity: "AllocationRule",
    entityId: current.id,
    action: "close",
    before: toSpec(current),
    after: { validTo: input.validTo, isActive: false },
    reason: input.reason,
    userId: actor.userId,
  })
}

/**
 * I-E5-3 en la app: `Σ sourceShareBps = 10000` por `(fuente, period)` vigente.
 * La BD no lo puede expresar con un CHECK —exige agregar sobre otras filas— y
 * dejarlo sólo al motor haría que la regla se guardara y el run fallara después,
 * que es justo el fallo diferido que la capa de fiabilidad prohíbe.
 */
async function assertRuleSetCoherent(
  tx: TenantTransactionClient,
  period: AllocPeriod,
  at: LocalDate
): Promise<void> {
  const specs = await getAllocationRuleSpecs(tx, { periodEnd: at, period })
  const bySource = new Map<string, { sum: number; codes: string[] }>()
  for (const rule of specs) {
    const entry = bySource.get(rule.sourceCostCenterId) ?? { sum: 0, codes: [] }
    entry.sum += rule.sourceShareBps
    entry.codes.push(rule.code)
    bySource.set(rule.sourceCostCenterId, entry)
  }
  const cecos = await tx.costCenter.findMany({ select: { id: true, code: true } })
  const codeById = new Map(cecos.map((c) => [c.id, c.code]))
  for (const [cecoId, entry] of bySource) {
    if (entry.sum === 10000) continue
    abortAllocation({
      code: "SOURCE_SHARE_NOT_100",
      message: `las reglas de ${codeById.get(cecoId) ?? cecoId} (${period}) reparten el ${(entry.sum / 100).toFixed(2)} % de su saldo: falta declarar qué pasa con el ${((10000 - entry.sum) / 100).toFixed(2)} % restante`,
      ruleCodes: entry.codes,
    })
  }
}

/** Día anterior, sin `Date` implícito: es aritmética de calendario, no reloj. */
export function previousDay(date: LocalDate): LocalDate {
  const [y, m, d] = date.split("-").map(Number)
  if (d > 1) return `${y}-${pad(m)}-${pad(d - 1)}`
  if (m > 1) return `${y}-${pad(m - 1)}-${pad(lastDay(y, m - 1))}`
  return `${y - 1}-12-31`
}
const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
const lastDay = (y: number, m: number): number =>
  m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

// ─────────────────────────────────────────────────────────────────────────────
// Contexto de un run: sellos, líneas y reglas
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationSeals = { ledgerHash: string; dimensionsHash: string; rulesHash: string }

export type AllocationPeriodRequest = { periodKind: AllocPeriod; periodStart: LocalDate; periodEnd: LocalDate }

type RunContext = {
  period: AllocationPeriodRef
  lines: AnalyticLine[]
  rules: AllocationRuleSpec[]
  priorAllocations: PriorAllocation[]
  seals: AllocationSeals
}

/**
 * Todo lo que el motor necesita, leído **en serie** dentro de la transacción: el
 * adaptador `pg` comparte una sola conexión y en paralelo avisa de «client is
 * already executing a query» (hallazgo #6 de E4).
 */
async function loadRunContext(tx: TenantTransactionClient, request: AllocationPeriodRequest): Promise<RunContext> {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { startDate: { lte: toUtcDate(request.periodStart) }, endDate: { gte: toUtcDate(request.periodEnd) } },
  })
  if (!fiscalYear) {
    abortAllocation({
      code: "PERIOD_CROSSES_FISCAL_YEAR",
      message: `el periodo ${request.periodStart} … ${request.periodEnd} no cabe en ningún ejercicio: un run pertenece a UN ejercicio`,
    })
  }
  const fiscalYearStart = fromUtcDate(fiscalYear.startDate)
  const fiscalYearEnd = fromUtcDate(fiscalYear.endDate)

  const config = await getAnalyticsConfig(tx, { periodEnd: request.periodEnd })
  // Líneas del EJERCICIO entero: `YTD` y `PRIOR_PERIOD` las necesitan (§1.2).
  const lines = await getAnalyticLines(tx, { from: fiscalYearStart, to: fiscalYearEnd, fiscalYearId: fiscalYear.id })
  const ledgerHash = await computeLedgerHash(tx, {
    from: request.periodStart,
    to: request.periodEnd,
    fiscalYearId: fiscalYear.id,
  })
  const rules = await getAllocationRuleSpecs(tx, { periodEnd: request.periodEnd, period: request.periodKind })

  // `yaRepartido`: runs VIGENTES de periodo ESTRICTAMENTE más fino contenidos en
  // P. El `NOT` del mismo periodo no es cosmético: sin él, un rerun del mismo
  // periodo se contaría a sí mismo como «ya repartido» y la segunda liquidación
  // saldría a cero (o negativa en cascada), que es precisamente lo que I5.a
  // detecta y lo que este filtro impide.
  const priorRows = await tx.allocationLine.findMany({
    where: {
      run: {
        status: "SEALED",
        periodStart: { gte: toUtcDate(request.periodStart) },
        periodEnd: { lte: toUtcDate(request.periodEnd) },
        NOT: { periodStart: toUtcDate(request.periodStart), periodEnd: toUtcDate(request.periodEnd) },
      },
    },
    select: {
      amountCents: true,
      marginLevel: true,
      sourceCostCenterId: true,
      run: { select: { periodStart: true, periodEnd: true } },
    },
  })

  const periodLines = lines.filter((l) => l.entryDate >= request.periodStart && l.entryDate <= request.periodEnd)
  const configHash = marginConfigHash(config)

  return {
    period: {
      kind: request.periodKind,
      label: periodLabel(request.periodKind, request.periodStart),
      start: request.periodStart,
      end: request.periodEnd,
      fiscalYearId: fiscalYear.id,
      fiscalYearStart,
      fiscalYearEnd,
    },
    lines,
    rules,
    priorAllocations: priorRows.map((r) => ({
      runPeriodStart: fromUtcDate(r.run.periodStart),
      runPeriodEnd: fromUtcDate(r.run.periodEnd),
      sourceCostCenterId: r.sourceCostCenterId,
      marginLevel: r.marginLevel as CostCenterMarginLevel,
      amountCents: r.amountCents,
    })),
    seals: {
      ledgerHash,
      // NO circular: el sello que un run guarda es el de DIMENSIONES, calculado
      // con `allocationRunSetHash = ∅` (§3.5). Un run no puede sellarse con un
      // hash que lo incluya a sí mismo.
      dimensionsHash: dimensionsHash(
        periodLines.map((l) => ({
          entryId: l.entryId,
          lineNo: l.lineNo,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
          analyticType: l.analyticType,
        })),
        configHash
      ),
      rulesHash: computeRulesHash(effectiveRules(rules, {
        kind: request.periodKind,
        label: periodLabel(request.periodKind, request.periodStart),
        start: request.periodStart,
        end: request.periodEnd,
        fiscalYearId: fiscalYear.id,
        fiscalYearStart,
        fiscalYearEnd,
      })),
    },
  }
}

export type AllocationPreview = {
  period: AllocationPeriodRef
  result: AllocationResult
  seals: AllocationSeals
  /** El resumen que la tabla de simulación y la ficha del run comparten. */
  summary: ReturnType<typeof canonicalRun>
}

/** Dry-run. **No escribe NADA**. Es lo que pinta la tabla de simulación. */
export async function previewAllocationRun(
  tx: TenantTransactionClient,
  request: AllocationPeriodRequest
): Promise<AllocationPreview> {
  const ctx = await loadRunContext(tx, request)
  const config = await getAnalyticsConfig(tx, { periodEnd: request.periodEnd })
  const computed = allocate({
    lines: ctx.lines,
    config,
    rules: ctx.rules,
    period: ctx.period,
    priorAllocations: ctx.priorAllocations,
  })
  if (!computed.ok) abortAllocation(computed.error)
  const result = computed.value
  return { period: ctx.period, result, seals: ctx.seals, summary: canonicalRun(result) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellado, sustitución y reversión
// ─────────────────────────────────────────────────────────────────────────────

export type SealAllocationInput = AllocationPeriodRequest & {
  gitSha: string
  /** Los tres sellos que el usuario aprobó en la simulación. */
  expectedHashes?: AllocationSeals | null
  /** Rerun: el run vigente del mismo periodo pasa a `SUPERSEDED`. */
  supersede?: boolean
  reason?: string | null
}

export type AllocationRunDetail = {
  id: string
  fiscalYearId: string
  periodKind: AllocPeriod
  periodStart: LocalDate
  periodEnd: LocalDate
  status: AllocationRunStatus
  ledgerHash: string
  analyticsHash: string
  rulesHash: string
  gitSha: string
  lineCount: number
  totalAllocatedCents: Cents
  warnings: unknown
  runAt: string
  supersededById: string | null
  reversedAt: string | null
  reversalReason: string | null
  lines: AppliedAllocation[]
}

/**
 * Sella el run. Reutiliza el resultado de la simulación **sólo si los tres
 * sellos siguen siendo los mismos**; si algo ha cambiado entre simular y sellar
 * —un asiento tardío, una reclasificación, una regla nueva— responde
 * `LIQUIDACION_DESFASADA` y obliga a resimular, en vez de persistir en silencio
 * algo distinto de lo que el usuario aprobó.
 */
export async function sealAllocationRunTx(
  tx: TenantTransactionClient,
  input: SealAllocationInput,
  actor: Actor
): Promise<AllocationRunDetail> {
  const ctx = await loadRunContext(tx, input)
  if (input.expectedHashes) {
    const e = input.expectedHashes
    if (
      e.ledgerHash !== ctx.seals.ledgerHash ||
      e.dimensionsHash !== ctx.seals.dimensionsHash ||
      e.rulesHash !== ctx.seals.rulesHash
    ) {
      abortWith([
        modelErr(
          "LIQUIDACION_DESFASADA",
          "periodo",
          "el periodo ha cambiado desde la simulación (asiento nuevo, reclasificación o regla modificada): vuelve a simular antes de liquidar"
        ),
      ])
    }
  }

  const config = await getAnalyticsConfig(tx, { periodEnd: input.periodEnd })
  const computed = allocate({
    lines: ctx.lines,
    config,
    rules: ctx.rules,
    period: ctx.period,
    priorAllocations: ctx.priorAllocations,
  })
  if (!computed.ok) abortAllocation(computed.error)
  const result = computed.value

  // Un solo run vigente por periodo: el anterior se sustituye ANTES de insertar
  // el nuevo, o el índice único parcial rechaza el `INSERT` con 23505.
  const previous = await tx.allocationRun.findFirst({
    where: { periodStart: toUtcDate(input.periodStart), periodEnd: toUtcDate(input.periodEnd), status: "SEALED" },
  })
  if (previous && input.supersede !== true) {
    abortWith([
      modelErr(
        "ALLOCATION_RUN_NOT_SEALED",
        "periodo",
        `el periodo ${input.periodStart} … ${input.periodEnd} ya tiene una liquidación vigente: vuelve a liquidar con sustitución para reemplazarla`
      ),
    ])
  }

  // El sustituido se marca ANTES de insertar el nuevo: el índice único parcial
  // `allocation_runs_one_sealed_per_period` no admite dos SEALED del mismo
  // periodo ni un instante, y un índice único no es diferible. La FK
  // `superseded_by_id` SÍ lo es, así que puede apuntar a un run que todavía no
  // existe dentro de la transacción.
  const runId = randomUUID()
  if (previous) {
    await tx.allocationRun.update({
      where: { id: previous.id },
      data: { status: "SUPERSEDED", supersededById: runId },
    })
  }

  const run = await tx.allocationRun.create({
    data: {
      id: runId,
      organizationId: tx.$organizationId,
      fiscalYearId: ctx.period.fiscalYearId,
      periodKind: input.periodKind,
      periodStart: toUtcDate(input.periodStart),
      periodEnd: toUtcDate(input.periodEnd),
      status: "SEALED",
      ledgerHash: ctx.seals.ledgerHash,
      analyticsHash: ctx.seals.dimensionsHash,
      rulesHash: ctx.seals.rulesHash,
      gitSha: input.gitSha,
      lineCount: result.lines.length,
      totalAllocatedCents: result.totalAllocatedCents,
      warnings: result.warnings as unknown as Prisma.InputJsonValue,
      runById: actor.userId,
    },
  })

  if (result.lines.length > 0) {
    await tx.allocationLine.createMany({
      data: result.lines.map((line) => ({
        organizationId: tx.$organizationId,
        runId: run.id,
        ruleId: line.ruleId,
        sourceCostCenterId: line.sourceCostCenterId,
        targetProjectId: line.target.kind === "PROJECT" ? line.target.id : null,
        targetBusinessLineId: line.target.kind === "BUSINESS_LINE" ? line.target.id : null,
        targetCostCenterId: line.target.kind === "COST_CENTER" ? line.target.id : null,
        marginLevel: line.marginLevel,
        amountCents: line.amountCents,
        driverBase: line.driverBase,
        driverBaseTotal: line.driverBaseTotal,
        driverShareBps: line.driverShareBps,
        fallbackApplied: line.fallbackApplied,
        eligibilityReason: line.eligibilityReason,
      })),
    })
  }

  if (previous) {
    await writeAuditLog(tx, {
      entity: "AllocationRun",
      entityId: previous.id,
      action: "supersede",
      before: { status: previous.status },
      after: { status: "SUPERSEDED", supersededById: run.id },
      reason: input.reason ?? null,
      userId: actor.userId,
    })
  }

  await writeAuditLog(tx, {
    entity: "AllocationRun",
    entityId: run.id,
    action: "seal",
    after: {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      lineCount: result.lines.length,
      totalAllocatedCents: result.totalAllocatedCents,
      rulesApplied: result.rulesApplied,
      seals: ctx.seals,
    },
    reason: input.reason ?? null,
    userId: actor.userId,
  })

  return {
    id: run.id,
    fiscalYearId: run.fiscalYearId,
    periodKind: run.periodKind,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: run.status,
    ledgerHash: run.ledgerHash,
    analyticsHash: run.analyticsHash,
    rulesHash: run.rulesHash,
    gitSha: run.gitSha,
    lineCount: run.lineCount,
    totalAllocatedCents: run.totalAllocatedCents,
    warnings: result.warnings,
    runAt: run.runAt.toISOString(),
    supersededById: null,
    reversedAt: null,
    reversalReason: null,
    lines: [...result.lines],
  }
}

/**
 * Apaga un run **sin** sustituirlo. `reason` ≥ 10 caracteres. La reversión NO
 * genera asientos (ADR-0004): se limita a apagar el run, que deja de aportar a
 * cualquier matriz (I-E5-9) y **sigue consultable**.
 */
export async function reverseAllocationRunTx(
  tx: TenantTransactionClient,
  input: { runId: string; reason: string; reversedAt: Date },
  actor: Actor
): Promise<void> {
  if (input.reason.trim().length < 10) {
    abortWith([modelErr("REASON_TOO_SHORT", "reason", "el motivo de la reversión debe tener al menos 10 caracteres")])
  }
  const run = await tx.allocationRun.findFirst({ where: { id: input.runId } })
  if (!run) abortWith([modelErr("ALLOCATION_RUN_NOT_FOUND", "runId", "la liquidación no existe en esta organización")])
  if (run.status !== "SEALED") {
    abortWith([
      modelErr("ALLOCATION_RUN_NOT_SEALED", "runId", `la liquidación está en estado ${run.status}: sólo se revierte una vigente`),
    ])
  }
  await tx.allocationRun.update({
    where: { id: run.id },
    data: {
      status: "REVERSED",
      reversedAt: input.reversedAt,
      reversedById: actor.userId,
      reversalReason: input.reason.trim(),
    },
  })
  await writeAuditLog(tx, {
    entity: "AllocationRun",
    entityId: run.id,
    action: "reverse",
    before: { status: run.status },
    after: { status: "REVERSED" },
    reason: input.reason.trim(),
    userId: actor.userId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationRunListItem = {
  id: string
  periodKind: AllocPeriod
  periodStart: LocalDate
  periodEnd: LocalDate
  status: AllocationRunStatus
  lineCount: number
  totalAllocatedCents: Cents
  ledgerHash: string
  analyticsHash: string
  rulesHash: string
  gitSha: string
  runAt: string
  supersededById: string | null
  reversedAt: string | null
  /** **DERIVADO**, nunca almacenado (§3.5): los tres sellos contra los de hoy. */
  isStale: boolean
  staleReasons: string[]
}

export async function listAllocationRuns(
  db: TenantClient | TenantTransactionClient,
  filter: { fiscalYearId?: string; periodKind?: AllocPeriod } = {}
): Promise<AllocationRunListItem[]> {
  const rows = await db.allocationRun.findMany({
    where: {
      ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
      ...(filter.periodKind ? { periodKind: filter.periodKind } : {}),
    },
    orderBy: [{ periodStart: "asc" }, { periodEnd: "asc" }, { runAt: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    periodKind: r.periodKind,
    periodStart: fromUtcDate(r.periodStart),
    periodEnd: fromUtcDate(r.periodEnd),
    status: r.status,
    lineCount: r.lineCount,
    totalAllocatedCents: r.totalAllocatedCents,
    ledgerHash: r.ledgerHash,
    analyticsHash: r.analyticsHash,
    rulesHash: r.rulesHash,
    gitSha: r.gitSha,
    runAt: r.runAt.toISOString(),
    supersededById: r.supersededById,
    reversedAt: r.reversedAt ? r.reversedAt.toISOString() : null,
    isStale: false,
    staleReasons: [],
  }))
}

/**
 * `STALE` **derivado**: (a) `ledgerHash` distinto —asiento nuevo o contra-asiento
 * del periodo—, (b) `dimensionsHash` distinto —reclasificación analítica—, o
 * (c) `rulesHash` distinto. Un run caducado no se borra ni se corrige: se
 * SUSTITUYE. Guardar el estado obligaría a un `UPDATE` periódico sobre una tabla
 * append-only y a un cron que lo mantuviera; derivarlo es exacto siempre.
 */
export async function allocationRunStaleness(
  tx: TenantTransactionClient,
  run: Pick<AllocationRunListItem, "periodKind" | "periodStart" | "periodEnd" | "ledgerHash" | "analyticsHash" | "rulesHash">
): Promise<{ isStale: boolean; reasons: string[] }> {
  const ctx = await loadRunContext(tx, {
    periodKind: run.periodKind,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
  })
  const reasons: string[] = []
  if (ctx.seals.ledgerHash !== run.ledgerHash) reasons.push("el diario del periodo ha cambiado")
  if (ctx.seals.dimensionsHash !== run.analyticsHash) reasons.push("se ha reclasificado alguna línea del periodo")
  if (ctx.seals.rulesHash !== run.rulesHash) reasons.push("las reglas vigentes han cambiado")
  return { isStale: reasons.length > 0, reasons }
}

export async function getAllocationRun(
  db: TenantClient | TenantTransactionClient,
  runId: string
): Promise<AllocationRunDetail | null> {
  const run = await db.allocationRun.findFirst({ where: { id: runId } })
  if (!run) return null
  const lines = await readAllocationLines(db, { runIds: [run.id] })
  return {
    id: run.id,
    fiscalYearId: run.fiscalYearId,
    periodKind: run.periodKind,
    periodStart: fromUtcDate(run.periodStart),
    periodEnd: fromUtcDate(run.periodEnd),
    status: run.status,
    ledgerHash: run.ledgerHash,
    analyticsHash: run.analyticsHash,
    rulesHash: run.rulesHash,
    gitSha: run.gitSha,
    lineCount: run.lineCount,
    totalAllocatedCents: run.totalAllocatedCents,
    warnings: run.warnings,
    runAt: run.runAt.toISOString(),
    supersededById: run.supersededById,
    reversedAt: run.reversedAt ? run.reversedAt.toISOString() : null,
    reversalReason: run.reversalReason,
    lines,
  }
}

export type AllocationDiffRow = {
  key: string
  ruleCode: string
  sourceCostCenterCode: string
  targetCode: string
  marginLevel: string
  beforeCents: Cents
  afterCents: Cents
  deltaCents: Cents
}

/** Diff celda a celda contra el run anterior del mismo periodo. */
export async function diffAllocationRuns(
  db: TenantClient | TenantTransactionClient,
  input: { runId: string; againstRunId: string }
): Promise<AllocationDiffRow[]> {
  const after = await readAllocationLines(db, { runIds: [input.runId] })
  const before = await readAllocationLines(db, { runIds: [input.againstRunId] })
  const keyOf = (l: AppliedAllocation): string =>
    [l.ruleCode, l.sourceCostCenterCode, l.target.kind, l.target.code, l.marginLevel].join("|")
  const rows = new Map<string, AllocationDiffRow>()
  const upsert = (l: AppliedAllocation, side: "before" | "after"): void => {
    const key = keyOf(l)
    const row = rows.get(key) ?? {
      key,
      ruleCode: l.ruleCode,
      sourceCostCenterCode: l.sourceCostCenterCode,
      targetCode: l.target.code,
      marginLevel: l.marginLevel,
      beforeCents: 0,
      afterCents: 0,
      deltaCents: 0,
    }
    if (side === "before") row.beforeCents += l.amountCents
    else row.afterCents += l.amountCents
    row.deltaCents = row.afterCents - row.beforeCents
    rows.set(key, row)
  }
  for (const l of before) upsert(l, "before")
  for (const l of after) upsert(l, "after")
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que la matriz consume
// ─────────────────────────────────────────────────────────────────────────────

async function readAllocationLines(
  db: TenantClient | TenantTransactionClient,
  filter: { runIds: readonly string[] }
): Promise<AppliedAllocation[]> {
  if (filter.runIds.length === 0) return []
  const rows = await db.allocationLine.findMany({
    where: { runId: { in: [...filter.runIds] } },
    include: {
      rule: { select: { code: true } },
      sourceCostCenter: { select: { code: true } },
    },
    orderBy: [{ runId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })
  const projects = await db.project.findMany({ select: { id: true, code: true } })
  const bls = await db.businessLine.findMany({ select: { id: true, code: true } })
  const cecos = await db.costCenter.findMany({ select: { id: true, code: true } })
  const projectCode = new Map(projects.map((p) => [p.id, p.code]))
  const blCode = new Map(bls.map((b) => [b.id, b.code]))
  const cecoCode = new Map(cecos.map((c) => [c.id, c.code]))

  return rows.map((r) => ({
    runId: r.runId,
    ruleId: r.ruleId,
    ruleCode: r.rule.code,
    sourceCostCenterId: r.sourceCostCenterId,
    sourceCostCenterCode: r.sourceCostCenter.code,
    targetKind: r.targetProjectId ? "PROJECTS" : r.targetBusinessLineId ? "BUSINESS_LINES" : "COST_CENTERS",
    target: r.targetProjectId
      ? { kind: "PROJECT" as const, id: r.targetProjectId, code: projectCode.get(r.targetProjectId) ?? r.targetProjectId }
      : r.targetBusinessLineId
        ? { kind: "BUSINESS_LINE" as const, id: r.targetBusinessLineId, code: blCode.get(r.targetBusinessLineId) ?? r.targetBusinessLineId }
        : {
            kind: "COST_CENTER" as const,
            id: r.targetCostCenterId as string,
            code: cecoCode.get(r.targetCostCenterId as string) ?? (r.targetCostCenterId as string),
          },
    marginLevel: r.marginLevel as CostCenterMarginLevel,
    amountCents: r.amountCents,
    driverBase: r.driverBase,
    driverBaseTotal: r.driverBaseTotal,
    driverShareBps: r.driverShareBps,
    fallbackApplied: r.fallbackApplied,
    eligibilityReason: r.eligibilityReason as "ACTIVITY_IN_PERIOD" | null,
  }))
}

export type AppliedAllocations = {
  lines: AppliedAllocation[]
  runIds: string[]
  /** O-E5-7: el sello del CONJUNTO, no de un run. `sha256("")` si está vacío. */
  runSetHash: string
}

/**
 * Las líneas vigentes que la matriz consume para un periodo de informe.
 *
 * **Nunca se trocea un run**: entra entero (`[periodStart, periodEnd] ⊆ P`) o no
 * entra, y si no entra su importe aparece como pendiente de liquidar. Sólo los
 * `SEALED` cuentan (I-E5-9): un run sustituido o revertido sigue consultable,
 * pero no aporta un céntimo a ninguna matriz.
 */
export async function getAppliedAllocations(
  db: TenantClient | TenantTransactionClient,
  request: { from: LocalDate; to: LocalDate }
): Promise<AppliedAllocations> {
  const runs = await db.allocationRun.findMany({
    where: {
      status: "SEALED",
      periodStart: { gte: toUtcDate(request.from) },
      periodEnd: { lte: toUtcDate(request.to) },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  })
  const runIds = runs.map((r) => r.id)
  const lines = await readAllocationLines(db, { runIds })
  return { lines, runIds, runSetHash: allocationRunSetHash(runIds) }
}

/** Utilidad de la UI y de los seeds: los límites canónicos de un periodo. */
export const allocationPeriodBounds = periodBounds
