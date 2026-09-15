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
  linesHash as computeLinesHash,
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
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import type { AnalyticLine, Cents, CostCenterMarginLevel, LocalDate } from "@/lib/analytics/types"
import {
  fteMonthsByCostCenter,
  timeHash as computeTimeHash,
  timeWindowOf,
  type DateWindow,
  type HeadcountRow,
  type HeadcountWeight,
  type TimeEntryRow,
} from "@/lib/time/aggregate"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { formatBps } from "@/lib/money"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { getAnalyticLines, getAnalyticsConfig, type Actor } from "@/models/analytics"
import { listHeadcount } from "@/models/employees"
import { getTimeRowsForWindow } from "@/models/time"
import { writeAuditLog } from "@/models/audit-log"
import { LedgerAbort, computeLedgerHash, modelErr, type LedgerModelError } from "@/models/ledger"
import { Prisma } from "@/prisma/client"
import type { AllocationRunStatus, AllocPeriod, Driver, TargetKind, ZeroBaseFallback } from "@/prisma/client"

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
  // **E10 · T14** — aquí vivía el rechazo en seco de `HOURS` y `HEADCOUNT`
  // («llegan en E10»). E10 los ha traído: el `CHECK
  // allocation_rules_driver_available` se retiró en la migración
  // `20260924120000_e10_drivers_horas` y `lib/analytics/allocate.ts` sabe
  // ponderar por minutos aprobados y por FTE·mes (ADR-0018 D1).
  //
  // La garantía de ADR-0013 D4 —«ninguna regla inerte»— NO desaparece con el
  // rechazo: se traslada a los tres puntos de §3.6, cada uno con su test.
  //  1. Al guardar, en `createAllocationRuleAction`: módulo de horas encendido y
  //     al menos un dato de la clase que el driver consume en el ejercicio, con
  //     un mensaje que dice qué falta y dónde darlo de alta.
  //  2. Al sellar el run: una base 0 en todos los receptores deja el saldo
  //     visible en «pendiente de liquidar» y emite su aviso.
  //  3. Con base PARCIAL: `W-E10-UNAPPROVED-HOURS` y el motivo de sello
  //     `HORAS_SIN_APROBAR`.
  // Y el motor sigue rechazando aquí mismo lo que no tiene sentido: una regla
  // `HEADCOUNT` que no reparte a centros de coste (D1).

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
  // BUG-E5-1 (QA) — I-E5-2 «CHECK diferido + validación al guardar». `Σ
  // percentBps = 10000` se comprobaba en el zod y en el motor, pero NO aquí: una
  // regla `FIXED_PERCENT` al 60 % creada por un camino que no pasa por el
  // formulario se guardaba, se listaba y sólo reventaba al simular. Es la misma
  // «regla inerte» que ADR-0013 D4 prohíbe, con fallo diferido. Ahora se rechaza
  // al guardar (aquí) y la base lo repite con un constraint trigger diferido
  // (`allocation_rules_fixed_percent_100`, migración 20260910110000_e5_fixes).
  for (const rule of specs) {
    if (rule.driver !== "FIXED_PERCENT") continue
    const sum = rule.targets.reduce((a, t) => a + (t.percentBps ?? 0), 0)
    if (sum === 10000) continue
    abortAllocation({
      code: "FIXED_PERCENT_NOT_100",
      message: `la regla ${rule.code} reparte ${formatBps(sum)} % entre sus destinos: Σ de porcentajes debe ser exactamente 100 %`,
      ruleCodes: [rule.code],
    })
  }
  // BLOQUEA #1 — el contrato `targetKind` × `driver`, también al guardar: los
  // drivers calculados ponderan POR PROYECTO leyendo el diario.
  for (const rule of specs) {
    const needsTargets = rule.targetKind === "COST_CENTERS" || rule.targetKind === "BUSINESS_LINES"
    // **E10 · T14 (ADR-0018 D1)** — la excepción acotada que `lib/analytics/
    // allocate.ts` ya contempla: `HOURS` y `HEADCOUNT` SÍ saben ponderar un CECO
    // o una línea de negocio, porque el parte lleva su receptor y su LN, y el
    // snapshot su centro. Siguen exigiendo destinos declarados, y eso lo
    // comprueba la comprobación siguiente.
    const activityDriver = rule.driver === "HOURS" || rule.driver === "HEADCOUNT"
    if (needsTargets && !activityDriver && rule.driver !== "FIXED_PERCENT" && rule.driver !== "MANUAL") {
      abortAllocation({
        code: "TARGETS_REQUIRED",
        message: `la regla ${rule.code} reparte a ${rule.targetKind === "COST_CENTERS" ? "centros de coste" : "líneas de negocio"} con el driver ${rule.driver}, que calcula sus pesos por proyecto desde el diario: declara los destinos con porcentaje fijo (FIXED_PERCENT) o con importes (MANUAL)`,
        ruleCodes: [rule.code],
      })
    }
    if ((needsTargets || rule.driver === "FIXED_PERCENT" || rule.driver === "MANUAL") && rule.targets.length === 0) {
      abortAllocation({
        code: "TARGETS_REQUIRED",
        message: `la regla ${rule.code} reparte entre destinos explícitos y no declara ninguno: no repartiría un céntimo`,
        ruleCodes: [rule.code],
      })
    }
  }

  const cecos = await tx.costCenter.findMany({ select: { id: true, code: true } })
  const codeById = new Map(cecos.map((c) => [c.id, c.code]))
  for (const [cecoId, entry] of bySource) {
    if (entry.sum === 10000) continue
    abortAllocation({
      code: "SOURCE_SHARE_NOT_100",
      message: `las reglas de ${codeById.get(cecoId) ?? cecoId} (${period}) reparten el ${formatBps(entry.sum)} % de su saldo: falta declarar qué pasa con el ${formatBps(10000 - entry.sum)} % restante`,
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

type FiscalYearContext = { config: Awaited<ReturnType<typeof getAnalyticsConfig>>; lines: AnalyticLine[] }

const fiscalYearContextCache = new WeakMap<object, Map<string, FiscalYearContext>>()

/**
 * Revisión ronda 1, #9 — memoización POR TRANSACCIÓN de lo que `loadRunContext`
 * relee por cada run al derivar el `STALE` de `/analytics/allocations/runs`.
 *
 * Con los 17 runs del fixture eran ~68 consultas por render: un `computeLedgerHash`
 * y un `getAllocationRuleSpecs` por run, más el ejercicio. Ahora hay **un
 * `ledgerHash` por (periodo, ejercicio)** y **un juego de reglas por
 * (periodicidad, fin de periodo)**, que es exactamente la granularidad con la
 * que esos dos valores pueden cambiar. La clave es la identidad del cliente
 * transaccional, así que la memoria muere con la transacción y nunca sirve datos
 * de otra petición ni de otra organización.
 */
const perTxCache = <T>(store: WeakMap<object, Map<string, T>>, tx: object): Map<string, T> => {
  const found = store.get(tx)
  if (found) return found
  const fresh = new Map<string, T>()
  store.set(tx, fresh)
  return fresh
}

async function memoized<T>(
  store: WeakMap<object, Map<string, T>>,
  tx: object,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const map = perTxCache(store, tx)
  const hit = map.get(key)
  if (hit !== undefined) return hit
  const value = await load()
  map.set(key, value)
  return value
}

const ledgerHashCache = new WeakMap<object, Map<string, string>>()
const rulesCache = new WeakMap<object, Map<string, AllocationRuleSpec[]>>()
const fiscalYearCache = new WeakMap<object, Map<string, { id: string; startDate: Date; endDate: Date } | null>>()

async function fiscalYearContext(
  tx: TenantTransactionClient,
  fiscalYearId: string,
  from: LocalDate,
  to: LocalDate,
  configAt: LocalDate
): Promise<FiscalYearContext> {
  const perTx = fiscalYearContextCache.get(tx) ?? new Map<string, FiscalYearContext>()
  fiscalYearContextCache.set(tx, perTx)
  // La configuración depende de la fecha con la que se elige la vigencia, así
  // que forma parte de la clave: dos periodos del mismo ejercicio con distinta
  // `MarginLevelConfig` vigente no pueden compartir contexto.
  const key = `${fiscalYearId}|${configAt}`
  const cached = perTx.get(key)
  if (cached) return cached
  // En SERIE: una sola conexión dentro de la transacción.
  const config = await getAnalyticsConfig(tx, { periodEnd: configAt })
  const lines = await getAnalyticLines(tx, { from, to, fiscalYearId })
  const value: FiscalYearContext = { config, lines }
  perTx.set(key, value)
  return value
}

export type AllocationPeriodRequest = { periodKind: AllocPeriod; periodStart: LocalDate; periodEnd: LocalDate }

type RunContext = {
  period: AllocationPeriodRef
  config: FiscalYearContext["config"]
  lines: AnalyticLine[]
  rules: AllocationRuleSpec[]
  priorAllocations: PriorAllocation[]
  seals: AllocationSeals
  /** E10 · D1 — la base de los drivers de actividad y su CUARTO sello. */
  activity: ActivityBase
}

/**
 * **E10 · D1 + O-E10-1 — la base de `HOURS` / `HEADCOUNT`, con su ventana.**
 *
 * La base de un driver de actividad **no está en el diario**: no entra ni en
 * `ledgerHash`, ni en `analyticsHash`, ni en `rulesHash`. Por eso el run sella
 * un cuarto hash **y la ventana sobre la que lo tomó**: con
 * `zeroBaseFallback = YTD` el reparto de marzo consume partes de enero, y sin la
 * ventana persistida aprobar en mayo un parte de enero no movía el sello de
 * marzo — el run lucía vigente con un reparto irreproducible.
 *
 * `window === null` ⇔ ninguna regla del run usa un driver de actividad ⇔
 * `timeHash = "∅"` y las dos columnas de ventana a `NULL`.
 */
export type ActivityBase = {
  window: DateWindow | null
  timeRows: readonly TimeEntryRow[]
  headcount: readonly HeadcountRow[]
  headcountWeights: readonly HeadcountWeight[]
  timeHash: string
}

/**
 * Todo lo que el motor necesita, leído **en serie** dentro de la transacción: el
 * adaptador `pg` comparte una sola conexión y en paralelo avisa de «client is
 * already executing a query» (hallazgo #6 de E4).
 */
/**
 * Lee la base de actividad del run —partes de horas (**aprobados y sin
 * aprobar**, O-E10-2) y snapshots de plantilla en FTE·mes (Q-7)— y sella el
 * `timeHash` sobre la **ventana efectiva** que las reglas del run consumen
 * (`timeWindowOf`, O-E10-1).
 *
 * Lecturas en SERIE: dentro de una transacción hay UNA conexión.
 */
export async function loadActivityBase(
  tx: TenantTransactionClient,
  rules: readonly AllocationRuleSpec[],
  period: AllocationPeriodRef
): Promise<ActivityBase> {
  const window = timeWindowOf(
    rules.map((r) => ({ driver: r.driver, zeroBaseFallback: r.zeroBaseFallback })),
    {
      kind: period.kind,
      label: period.label,
      start: period.start,
      end: period.end,
      fiscalYearStart: period.fiscalYearStart,
    }
  )
  if (window === null) {
    // Sin reglas de actividad no hay base que leer ni sello que tomar: `"∅"` y
    // ventana NULL, que es lo que el CHECK de M4 espera ver.
    return { window: null, timeRows: [], headcount: [], headcountWeights: [], timeHash: computeTimeHash([], null) }
  }

  const timeRows = await getTimeRowsForWindow(tx, window)
  const headcountRows = await listHeadcount(tx, { from: window.from, to: window.to })
  const headcount: HeadcountRow[] = headcountRows.map((h) => ({
    costCenterId: h.costCenterId,
    costCenterCode: h.costCenterCode,
    periodEnd: h.periodEnd,
    fteMilli: h.fteMilli,
  }))

  return {
    window,
    timeRows,
    headcount,
    // La base del driver es Σ `fteMilli` de los snapshots del periodo — FTE·mes,
    // no una media (Q-7): un CECO vivo de febrero a noviembre tenía peso 0 en el
    // run anual y sus diez meses de estructura se trasladaban a los demás.
    headcountWeights: fteMonthsByCostCenter(headcount, window),
    timeHash: computeTimeHash(timeRows, window),
  }
}

async function loadRunContext(tx: TenantTransactionClient, request: AllocationPeriodRequest): Promise<RunContext> {
  const fiscalYear = await memoized(fiscalYearCache, tx, `${request.periodStart}|${request.periodEnd}`, async () =>
    tx.fiscalYear.findFirst({
      where: { startDate: { lte: toUtcDate(request.periodStart) }, endDate: { gte: toUtcDate(request.periodEnd) } },
      select: { id: true, startDate: true, endDate: true },
    })
  )
  if (!fiscalYear) {
    abortAllocation({
      code: "PERIOD_CROSSES_FISCAL_YEAR",
      message: `el periodo ${request.periodStart} … ${request.periodEnd} no cabe en ningún ejercicio: un run pertenece a UN ejercicio`,
    })
  }
  const fiscalYearStart = fromUtcDate(fiscalYear.startDate)
  const fiscalYearEnd = fromUtcDate(fiscalYear.endDate)

  // Las líneas del EJERCICIO entero (`YTD` y `PRIOR_PERIOD` las necesitan, §1.2)
  // y la configuración se memoizan POR TRANSACCIÓN: `/analytics/allocations/runs`
  // deriva el `STALE` de cada run y con doce runs mensuales serían doce lecturas
  // del mismo ejercicio. La clave es la identidad del cliente transaccional, así
  // que la memoria muere con la transacción y nunca sirve datos de otra
  // petición ni de otra organización.
  const { config, lines } = await fiscalYearContext(tx, fiscalYear.id, fiscalYearStart, fiscalYearEnd, request.periodEnd)
  const ledgerHash = await memoized(
    ledgerHashCache,
    tx,
    `${fiscalYear.id}|${request.periodStart}|${request.periodEnd}`,
    async () =>
      computeLedgerHash(tx, {
        from: request.periodStart,
        to: request.periodEnd,
        fiscalYearId: fiscalYear.id,
      })
  )
  const rules = await memoized(rulesCache, tx, `${request.periodKind}|${request.periodEnd}`, async () =>
    getAllocationRuleSpecs(tx, { periodEnd: request.periodEnd, period: request.periodKind })
  )

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

  const periodRef: AllocationPeriodRef = {
    kind: request.periodKind,
    label: periodLabel(request.periodKind, request.periodStart),
    start: request.periodStart,
    end: request.periodEnd,
    fiscalYearId: fiscalYear.id,
    fiscalYearStart,
    fiscalYearEnd,
  }
  const activity = await loadActivityBase(tx, rules, periodRef)

  return {
    config,
    activity,
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
      amountCents: Number(r.amountCents),
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
  const computed = allocate({
    lines: ctx.lines,
    config: ctx.config,
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
  /** Auditoría E5, hallazgo 1: sha256 de las líneas del run en forma canónica. */
  linesHash: string | null
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

  const computed = allocate({
    lines: ctx.lines,
    config: ctx.config,
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
      // E10 · D1 + O-E10-1 — el CUARTO sello y la ventana que lo produjo. Sin la
      // ventana, la staleness tendría que releer las reglas vigentes para saber
      // qué base consumió el run, y entonces dependería de una tercera cosa que
      // también cambia.
      timeHash: ctx.activity.timeHash,
      timeHashWindowStart: ctx.activity.window ? toUtcDate(ctx.activity.window.from) : null,
      timeHashWindowEnd: ctx.activity.window ? toUtcDate(ctx.activity.window.to) : null,
      gitSha: input.gitSha,
      lineCount: result.lines.length,
      totalAllocatedCents: BigInt(result.totalAllocatedCents),
      // Auditoría E5, hallazgo 1: el sello de la SALIDA. Sin él, mover el
      // céntimo de remanente entre dos receptores por `UPDATE` directo mantenía
      // Σ, cierre, cota de I-E5-4 y total, y todos los invariantes daban PASS.
      linesHash: computeLinesHash(result.lines),
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
        // `bigint` en BD (hallazgo 4): la conversión vive AQUÍ, en el borde;
        // el motor y la UI siguen en `number` (2^53 c = 90 000 M€).
        amountCents: BigInt(line.amountCents),
        driverBase: BigInt(line.driverBase),
        driverBaseTotal: BigInt(line.driverBaseTotal),
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
    linesHash: run.linesHash,
    gitSha: run.gitSha,
    lineCount: run.lineCount,
    totalAllocatedCents: Number(run.totalAllocatedCents),
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
  fiscalYearId: string
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
  /** E10 · O-E10-1 — el CUARTO sello y la ventana sobre la que se tomó. */
  timeHash: string
  timeHashWindowStart: LocalDate | null
  timeHashWindowEnd: LocalDate | null
  /** **DERIVADO**, nunca almacenado (§3.5): los CUATRO sellos contra los de hoy. */
  isStale: boolean
  staleReasons: string[]
}

/**
 * E10 · T12 — con `deriveStaleness: true` la lista **rellena de verdad** el
 * `isStale` de los runs sellados, en **tres** consultas para todos ellos
 * (§3.9). Antes devolvía `false` de relleno y cada llamante lo derivaba run a
 * run: es la deuda §0-bis #6, y con doce runs mensuales eran ~68 consultas por
 * render. Exige un cliente transaccional porque el agregado va en SQL.
 */
export async function listAllocationRuns(
  db: TenantClient | TenantTransactionClient,
  filter: { fiscalYearId?: string; periodKind?: AllocPeriod; deriveStaleness?: boolean } = {}
): Promise<AllocationRunListItem[]> {
  const rows = await db.allocationRun.findMany({
    where: {
      ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
      ...(filter.periodKind ? { periodKind: filter.periodKind } : {}),
    },
    orderBy: [{ periodStart: "asc" }, { periodEnd: "asc" }, { runAt: "asc" }],
  })
  const items: AllocationRunListItem[] = rows.map((r) => ({
    id: r.id,
    fiscalYearId: r.fiscalYearId,
    periodKind: r.periodKind,
    periodStart: fromUtcDate(r.periodStart),
    periodEnd: fromUtcDate(r.periodEnd),
    status: r.status,
    lineCount: r.lineCount,
    totalAllocatedCents: Number(r.totalAllocatedCents),
    ledgerHash: r.ledgerHash,
    analyticsHash: r.analyticsHash,
    rulesHash: r.rulesHash,
    gitSha: r.gitSha,
    runAt: r.runAt.toISOString(),
    supersededById: r.supersededById,
    reversedAt: r.reversedAt ? r.reversedAt.toISOString() : null,
    timeHash: r.timeHash,
    timeHashWindowStart: r.timeHashWindowStart ? fromUtcDate(r.timeHashWindowStart) : null,
    timeHashWindowEnd: r.timeHashWindowEnd ? fromUtcDate(r.timeHashWindowEnd) : null,
    isStale: false,
    staleReasons: [],
  }))

  if (filter.deriveStaleness !== true) return items
  const sealed = items.filter((r) => r.status === "SEALED")
  if (sealed.length === 0) return items
  const staleness = await allocationRunStalenessBatch(db as TenantTransactionClient, sealed)
  return items.map((r) => {
    const found = staleness.get(r.id)
    return found ? { ...r, isStale: found.isStale, staleReasons: found.reasons } : r
  })
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
  run: Omit<StalenessRunRef, "id"> & { id?: string }
): Promise<{ isStale: boolean; reasons: string[] }> {
  // E10 · §3.9 — envoltorio de UN elemento sobre la versión en lote. Se conserva
  // para no duplicar reglas: la definición de «caducado» vive en un solo sitio.
  const id = run.id ?? "single"
  const batch = await allocationRunStalenessBatch(tx, [{ ...run, id }])
  return batch.get(id) ?? { isStale: false, reasons: [] }
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
    linesHash: run.linesHash,
    gitSha: run.gitSha,
    lineCount: run.lineCount,
    totalAllocatedCents: Number(run.totalAllocatedCents),
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
  // Revisión ronda 1, #8 — sólo las dimensiones REFERENCIADAS. Antes se traían
  // las tres tablas enteras (proyectos, líneas de negocio y centros de coste) en
  // cada llamada para traducir tres ids a tres códigos.
  const idsOf = (pick: (r: (typeof rows)[number]) => string | null): string[] => [
    ...new Set(rows.map(pick).filter((v): v is string => v !== null)),
  ]
  const projectIds = idsOf((r) => r.targetProjectId)
  const blIds = idsOf((r) => r.targetBusinessLineId)
  const cecoIds = idsOf((r) => r.targetCostCenterId)
  const projects = projectIds.length === 0 ? [] : await db.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, code: true } })
  const bls = blIds.length === 0 ? [] : await db.businessLine.findMany({ where: { id: { in: blIds } }, select: { id: true, code: true } })
  const cecos = cecoIds.length === 0 ? [] : await db.costCenter.findMany({ where: { id: { in: cecoIds } }, select: { id: true, code: true } })
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
    amountCents: Number(r.amountCents),
    driverBase: Number(r.driverBase),
    driverBaseTotal: Number(r.driverBaseTotal),
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
  /**
   * Los runs vigentes con su periodo, su total y su `linesHash`. Es lo que I5.a
   * (base reconstruida por run), I-E5-9 e I-E5-12 necesitan y lo que evitaba que
   * el barrido tuviera que releer `allocation_runs` por su cuenta.
   */
  runs: AppliedRunRef[]
}

export type AppliedRunRef = {
  id: string
  periodStart: LocalDate
  periodEnd: LocalDate
  status: AllocationRunStatus
  totalAllocatedCents: Cents
  linesHash: string | null
}

/**
 * Revisión ronda 1, #8 — **Σ por (fuente, columna, nivel) EN SQL**.
 *
 * `GROUP BY source_cost_center_id, target_project_id, target_business_line_id,
 * target_cost_center_id, margin_level` con `SUM(amount_cents)`: la base devuelve
 * una fila por celda del reparto en vez de las 40 000 líneas que el diseño
 * contempla. Lo usan el total exacto del drill-down —que se pinta truncado a 500
 * filas y antes sumaba sólo las que cabían— y el test de rendimiento.
 */
export async function getAllocationTotals(
  db: TenantClient | TenantTransactionClient,
  filter: { runIds: readonly string[] }
): Promise<
  {
    sourceCostCenterId: string
    targetProjectId: string | null
    targetBusinessLineId: string | null
    targetCostCenterId: string | null
    marginLevel: CostCenterMarginLevel
    amountCents: Cents
  }[]
> {
  if (filter.runIds.length === 0) return []
  const rows = await db.allocationLine.groupBy({
    by: ["sourceCostCenterId", "targetProjectId", "targetBusinessLineId", "targetCostCenterId", "marginLevel"],
    where: { runId: { in: [...filter.runIds] } },
    _sum: { amountCents: true },
  })
  return rows
    .map((r) => ({
      sourceCostCenterId: r.sourceCostCenterId,
      targetProjectId: r.targetProjectId,
      targetBusinessLineId: r.targetBusinessLineId,
      targetCostCenterId: r.targetCostCenterId,
      marginLevel: r.marginLevel as CostCenterMarginLevel,
      amountCents: Number(r._sum.amountCents ?? 0),
    }))
    .sort((a, b) =>
      `${a.sourceCostCenterId}|${a.targetProjectId}|${a.targetBusinessLineId}|${a.targetCostCenterId}|${a.marginLevel}` <
      `${b.sourceCostCenterId}|${b.targetProjectId}|${b.targetBusinessLineId}|${b.targetCostCenterId}|${b.marginLevel}`
        ? -1
        : 1
    )
}

/**
 * Los runs VIGENTES de un periodo de informe, sin leer una sola línea.
 *
 * Revisión ronda 1, #8: `getAllocationCellDetail` llamaba a
 * `getAppliedAllocations` —lectura completa del reparto— **sólo para obtener los
 * `runIds`** con los que filtrar su propia consulta.
 */
export async function getSealedRunRefs(
  db: TenantClient | TenantTransactionClient,
  request: { from: LocalDate; to: LocalDate }
): Promise<AppliedRunRef[]> {
  const runs = await db.allocationRun.findMany({
    where: {
      status: "SEALED",
      periodStart: { gte: toUtcDate(request.from) },
      periodEnd: { lte: toUtcDate(request.to) },
    },
    select: { id: true, periodStart: true, periodEnd: true, status: true, totalAllocatedCents: true, linesHash: true },
    orderBy: { id: "asc" },
  })
  return runs.map((r) => ({
    id: r.id,
    periodStart: fromUtcDate(r.periodStart),
    periodEnd: fromUtcDate(r.periodEnd),
    status: r.status,
    totalAllocatedCents: Number(r.totalAllocatedCents),
    linesHash: r.linesHash,
  }))
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
  const runs = await getSealedRunRefs(db, request)
  const runIds = runs.map((r) => r.id)
  const lines = await readAllocationLines(db, { runIds })
  return { lines, runIds, runSetHash: allocationRunSetHash(runIds), runs }
}

/** Utilidad de la UI y de los seeds: los límites canónicos de un periodo. */
export const allocationPeriodBounds = periodBounds

/**
 * E7 · T9 — los `AllocationRun` sellados con su `linesHash` **sellado** y el
 * **recomputado hoy** sobre sus líneas (I-E7-9 e I-E7-10).
 *
 * El recomputo usa `linesHash()` de `lib/analytics/allocate` —la MISMA función
 * que firmó el run—, nunca una segunda implementación en SQL: ésa es la deriva
 * que ADR-0011 corrigió. Un run con `lines_hash` NULL sale con
 * `linesHashExpected` relleno para que la pantalla pueda enseñar qué firma
 * tendría si se re-liquidara, pero **el script no lo escribe jamás** (§2.5): una
 * firma sobre lo que haya hoy no es un sello.
 *
 * Una sola lectura de líneas para todos los runs: nada de N+1.
 */
export async function listAllocationRunsWithLinesHash(
  db: TenantClient | TenantTransactionClient,
  filter: { from?: LocalDate; to?: LocalDate; runIds?: readonly string[] } = {}
): Promise<
  {
    id: string
    status: string
    periodStart: LocalDate
    periodEnd: LocalDate
    sealedAt: string | null
    linesHash: string | null
    linesHashExpected: string | null
  }[]
> {
  const runs = await db.allocationRun.findMany({
    where: {
      status: "SEALED",
      ...(filter.runIds ? { id: { in: [...filter.runIds] } } : {}),
      ...(filter.from ? { periodStart: { gte: toUtcDate(filter.from) } } : {}),
      ...(filter.to ? { periodEnd: { lte: toUtcDate(filter.to) } } : {}),
    },
    select: { id: true, status: true, periodStart: true, periodEnd: true, runAt: true, linesHash: true },
    orderBy: { periodStart: "asc" },
  })
  if (runs.length === 0) return []

  const lines = await readAllocationLines(db, { runIds: runs.map((r) => r.id) })
  const byRun = new Map<string, AppliedAllocation[]>()
  for (const line of lines) {
    const list = byRun.get(line.runId) ?? []
    list.push(line)
    byRun.set(line.runId, list)
  }

  return runs.map((r) => ({
    id: r.id,
    status: r.status,
    periodStart: fromUtcDate(r.periodStart),
    periodEnd: fromUtcDate(r.periodEnd),
    sealedAt: r.runAt.toISOString(),
    linesHash: r.linesHash,
    linesHashExpected: computeLinesHash(byRun.get(r.id) ?? []),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// E10 · T12 — la staleness en LOTE (§3.9, deuda §0-bis #6)
//
// Hoy `allocationRunStaleness` llama a `loadRunContext` **por run**; la
// memoización por transacción de E5 lo dejó en «una consulta por periodo
// distinto», que con doce runs mensuales sellados siguen siendo doce. La forma
// correcta es agregar por periodo en SQL: **tres consultas, sea cual sea N**.
//
//   1. `ledgerHash` y `dimensionsHash` por periodo, con la lista de periodos en
//      un `VALUES` y los dos `digest(string_agg(forma canónica ORDER BY …))`
//      calculados en la base. Son EXACTAMENTE las formas canónicas de
//      `lib/ledger/hash.ts` y de `lib/analytics/hash.ts` escritas en SQL, y hay
//      un test espejo que compara los dos caminos fila a fila (mismo patrón que
//      el trigger de `report_runs_analytics_key`).
//   2. Las reglas activas, UNA consulta; `effectiveRules` + `canonicalRulesForm`
//      componen el `rulesHash` de cada (periodicidad, fin de periodo) en TS, que
//      es donde vive la definición.
//   3. El `timeHash` **por ventana**, UNA consulta agregada sobre las entradas
//      APROBADAS, usando las ventanas `[time_hash_window_start,
//      time_hash_window_end]` que **los propios runs persisten** (O-E10-1): no
//      hay que releer las reglas para saber qué ventana consumió cada uno.
//
// El orden `COLLATE "C"` no es cosmético: JavaScript ordena por unidad de
// código y la colación por defecto de la base ignora la puntuación, así que sin
// él las dos formas canónicas divergirían en cuanto un código llevara un guión.
// ─────────────────────────────────────────────────────────────────────────────

/** Los cuatro sellos derivados de un periodo, tal y como están HOY. */
export type PeriodSeals = {
  periodStart: LocalDate
  periodEnd: LocalDate
  ledgerHash: string
  dimensionsHash: string
  marginConfigHash: string
  /**
   * Instante del último cambio registrado en la configuración de márgenes
   * (`margin_level_configs`) o en los CECOs. **No decide** la staleness —eso lo
   * deciden los hashes—: sólo ATRIBUYE la causa cuando el `dimensionsHash`
   * difiere, para no anunciar una reclasificación que no ha ocurrido. En
   * milisegundos desde época, para no depender de la zona horaria del proceso.
   */
  configChangedAtMs: number | null
}

type PeriodRef = { periodStart: LocalDate; periodEnd: LocalDate }

/**
 * Consulta 1 de las tres: `ledgerHash`, `marginConfigHash` y `dimensionsHash` de
 * N periodos **en una sola pasada**, sin materializar una línea del diario.
 *
 * El periodo se identifica por `[periodStart, periodEnd]` y por nada más: los
 * tres sellos se derivan de las líneas del diario que caen en esa ventana y de
 * la configuración de márgenes vigente a su fin, ninguna de las dos cosas mira
 * el ejercicio. Pasarlo aquí era arrastrar una columna que la consulta no usa
 * —y, con los llamantes que no lo traen, un `''::uuid` que la rompía (22P02)—.
 */
export async function periodSealsBatch(
  tx: TenantTransactionClient,
  periods: readonly PeriodRef[]
): Promise<Map<string, PeriodSeals>> {
  const out = new Map<string, PeriodSeals>()
  if (periods.length === 0) return out

  const starts = periods.map((p) => toUtcDate(p.periodStart))
  const ends = periods.map((p) => toUtcDate(p.periodEnd))

  const organizationId = tx.$organizationId
  const rows = await tx.$queryRaw<
    {
      period_start: Date
      period_end: Date
      ledger_hash: string
      dimensions_hash: string
      margin_config_hash: string
      config_changed_at_ms: number | null
    }[]
  >(Prisma.sql`
    WITH periodos AS (
      SELECT * FROM unnest(${starts}::date[], ${ends}::date[]) AS t(period_start, period_end)
    ),
    cfg AS (
      SELECT p.period_start, p.period_end,
             ${marginConfigFormSql(organizationId)} AS margin_config_form
        FROM periodos p
        JOIN organizations o ON o.id = ${organizationId}::uuid
    )
    SELECT cfg.period_start,
           cfg.period_end,
           -- ledgerHash: la forma canónica v1 de lib/ledger/hash.ts, la misma
           -- que computeLedgerHash escribe para UN periodo.
           COALESCE((
             SELECT encode(sha256(convert_to(
                      COALESCE(string_agg(f.fila, E'\\n' ORDER BY f.entry_date, f.entry_number, f.line_no), ''),
                      'UTF8')), 'hex')
               FROM (
                 SELECT l.entry_date, e.entry_number, l.line_no,
                        concat_ws(E'\\t',
                          to_char(l.entry_date, 'YYYY-MM-DD'), e.entry_number::text, l.line_no::text,
                          l.account_code, l.debit_cents::text, l.credit_cents::text, l.entry_kind::text
                        ) AS fila
                   FROM journal_lines l
                   JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
                  WHERE l.organization_id = ${organizationId}::uuid
                    AND l.entry_date BETWEEN cfg.period_start AND cfg.period_end
               ) f), ${EMPTY_SHA256}) AS ledger_hash,
           -- dimensionsHash: canonicalAnalyticsForm ‖ marginConfigHash,
           -- con el allocationRunSetHash a ∅ — un run no se sella con un hash
           -- que se incluya a sí mismo (§3.5).
           encode(sha256(convert_to(
             concat_ws(E'\\n',
               COALESCE((
                 SELECT string_agg(g.fila, E'\\n' ORDER BY g.entry_id COLLATE "C", g.line_no)
                   FROM (
                     SELECT l.entry_id::text AS entry_id, l.line_no,
                            concat_ws(E'\\t',
                              l.entry_id::text, l.line_no::text,
                              COALESCE(l.project_id::text, '∅'),
                              COALESCE(l.cost_center_id::text, '∅'),
                              COALESCE(l.business_line_id::text, '∅'),
                              COALESCE(l.analytic_type::text, '∅')
                            ) AS fila
                       FROM journal_lines l
                      WHERE l.organization_id = ${organizationId}::uuid
                        AND l.entry_date BETWEEN cfg.period_start AND cfg.period_end
                   ) g), ''),
               'marginConfigHash' || E'\\t' ||
                 encode(sha256(convert_to(cfg.margin_config_form, 'UTF8')), 'hex')
             ), 'UTF8')), 'hex') AS dimensions_hash,
           encode(sha256(convert_to(cfg.margin_config_form, 'UTF8')), 'hex') AS margin_config_hash,
           -- Cuándo se tocó por última vez la configuración que ese sello
           -- resume. NO decide la staleness —eso lo deciden los hashes—, sólo
           -- ATRIBUYE la causa: sin él, cambiar un MarginLevelConfig se anuncia
           -- como «se ha reclasificado alguna línea», que es falso.
           -- En EPOCH y con el 'UTC' explícito: las columnas son timestamp sin
           -- zona con valores UTC (los escribe Prisma), y compararlas con runAt
           -- a través de un Date del driver ataría el resultado a la zona
           -- horaria del proceso.
           (SELECT extract(epoch FROM max(t) AT TIME ZONE 'UTC') * 1000 FROM (
              SELECT max(mlc.updated_at) AS t
                FROM margin_level_configs mlc WHERE mlc.organization_id = ${organizationId}::uuid
              UNION ALL
              SELECT max(c.updated_at) FROM cost_centers c WHERE c.organization_id = ${organizationId}::uuid
            ) u(t))::float8 AS config_changed_at_ms
      FROM cfg`)

  for (const r of rows) {
    const key = `${fromUtcDate(r.period_start)}|${fromUtcDate(r.period_end)}`
    out.set(key, {
      periodStart: fromUtcDate(r.period_start),
      periodEnd: fromUtcDate(r.period_end),
      ledgerHash: r.ledger_hash,
      dimensionsHash: r.dimensions_hash,
      marginConfigHash: r.margin_config_hash,
      configChangedAtMs: r.config_changed_at_ms,
    })
  }
  return out
}

/**
 * **El espejo, en crudo.** Devuelve la FORMA canónica (no su sello) que el SQL
 * construye para cada periodo, que es lo que el test espejo TS ↔ SQL compara
 * contra `canonicalMarginConfigForm` de `lib/analytics/hash.ts`.
 *
 * Comparar hashes dice QUE divergen; comparar formas dice DÓNDE. El hallazgo de
 * C1 —todo run sellado salía `STALE`— vivió porque nadie comparaba ninguna de
 * las dos cosas.
 */
export async function marginConfigFormsBatch(
  tx: TenantTransactionClient,
  periods: readonly PeriodRef[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (periods.length === 0) return out
  const starts = periods.map((p) => toUtcDate(p.periodStart))
  const ends = periods.map((p) => toUtcDate(p.periodEnd))
  const organizationId = tx.$organizationId
  const rows = await tx.$queryRaw<{ period_start: Date; period_end: Date; margin_config_form: string }[]>(Prisma.sql`
    WITH periodos AS (
      SELECT * FROM unnest(${starts}::date[], ${ends}::date[]) AS t(period_start, period_end)
    )
    SELECT p.period_start, p.period_end, ${marginConfigFormSql(organizationId)} AS margin_config_form
      FROM periodos p
      JOIN organizations o ON o.id = ${organizationId}::uuid`)
  for (const r of rows) out.set(`${fromUtcDate(r.period_start)}|${fromUtcDate(r.period_end)}`, r.margin_config_form)
  return out
}

/** `sha256("")`: lo que devuelve `ledgerHash([])` con el periodo vacío. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/** R-A11, la misma constante que `lib/analytics/types.ts` expone al motor. */
const INCOME_TAX_PREFIXES_CSV = INCOME_TAX_PREFIXES.join(",")

/**
 * **El espejo SQL de `canonicalMarginConfigForm`** (`lib/analytics/hash.ts`), la
 * configuración de márgenes vigente AL FIN DEL PERIODO (`p.period_end`, del
 * `SELECT` que lo envuelve): los niveles vigentes con su reparto de tipos, el
 * desdoblamiento de `NO_ANALITICO` (R-A11) y el `marginLevel` de cada CECO —sin
 * los CECOs, mover `CC-OPS` de MC3 a EBITDA no cambiaría ningún hash (R-A7)—.
 *
 * Reproduce la forma **byte a byte**. El defecto que arreglaba el lote C4 —y que
 * dejaba `STALE` a TODO run sellado (hallazgo de C1)— era exactamente uno:
 * `concat_ws` **omite los argumentos NULL**, y el campo de tipos de un nivel con
 * `analytic_types = '{}'` —`MC3` y `EBITDA` lo son en la configuración por
 * defecto— llegaba NULL desde el `string_agg` sobre el `unnest` vacío. La fila
 * salía con CUATRO campos donde TS escribe CINCO con el tercero vacío, y de ahí
 * en adelante divergían `marginConfigHash`, `dimensionsHash` y el veredicto. De
 * ahí el `COALESCE(m.tipos, '')`.
 *
 * Los DOS agregados de fuera (niveles y CECOs) se dejan a propósito sin
 * `COALESCE`: sin niveles o sin CECOs, TS no escribe línea alguna y el NULL que
 * `concat_ws` omite reproduce justo eso.
 *
 * El `COLLATE "C"` no es cosmético: JavaScript ordena por unidad de código y la
 * colación por defecto de la base ignora la puntuación, así que sin él las dos
 * formas divergen en cuanto un código lleva un guión (`CC-GA` vs `CCGA`).
 */
const marginConfigFormSql = (organizationId: string): Prisma.Sql => Prisma.sql`
  concat_ws(E'\\n',
    'nonAnalyticLevel'  || E'\\t' || o.non_analytic_level::text,
    'incomeTaxPrefixes' || E'\\t' || ${INCOME_TAX_PREFIXES_CSV},
    (SELECT string_agg(
              concat_ws(E'\\t', m.level::text, m.sort_order::text, COALESCE(m.tipos, ''),
                        to_char(m.valid_from, 'YYYY-MM-DD'),
                        COALESCE(to_char(m.valid_to, 'YYYY-MM-DD'), '∅')),
              E'\\n' ORDER BY m.sort_order, m.level::text COLLATE "C")
       FROM (
         SELECT mlc.level, mlc.sort_order, mlc.valid_from, mlc.valid_to,
                (SELECT string_agg(x::text, ',' ORDER BY x::text COLLATE "C")
                   FROM unnest(mlc.analytic_types) x) AS tipos
           FROM margin_level_configs mlc
          WHERE mlc.organization_id = ${organizationId}::uuid
            AND mlc.valid_from <= p.period_end
            AND (mlc.valid_to IS NULL OR mlc.valid_to >= p.period_end)
       ) m),
    (SELECT string_agg(
              concat_ws(E'\\t', c.code, c.kind::text, c.margin_level::text,
                        CASE WHEN c.allocatable THEN '1' ELSE '0' END),
              E'\\n' ORDER BY c.code COLLATE "C")
       FROM cost_centers c WHERE c.organization_id = ${organizationId}::uuid)
  )`

/**
 * Consulta 3 de las tres: el `timeHash` de N ventanas **en una sola pasada**,
 * con la MISMA forma canónica que `canonicalTimeForm` de `lib/time/aggregate.ts`
 * (`fecha|códigoEmpleado|códigoReceptor|minutos|productiva`, sólo APROBADAS,
 * ordenada por esa tupla y desempatada por `id`).
 */
export async function timeHashBatch(
  tx: TenantTransactionClient,
  windows: readonly { from: LocalDate; to: LocalDate }[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (windows.length === 0) return out
  const froms = windows.map((w) => toUtcDate(w.from))
  const tos = windows.map((w) => toUtcDate(w.to))

  const rows = await tx.$queryRaw<{ w_from: Date; w_to: Date; time_hash: string }[]>`
    WITH ventanas AS (
      SELECT * FROM unnest(${froms}::date[], ${tos}::date[]) AS t(w_from, w_to)
    )
    SELECT v.w_from, v.w_to,
           COALESCE((
             SELECT encode(sha256(convert_to(
                      COALESCE(string_agg(f.fila, E'\n' ORDER BY f.fila COLLATE "C", f.id COLLATE "C"), ''),
                      'UTF8')), 'hex')
               FROM (
                 SELECT t.id::text AS id,
                        concat_ws('|',
                          to_char(t.date, 'YYYY-MM-DD'),
                          e.code,
                          COALESCE(p.code, c.code),
                          t.minutes::text,
                          CASE WHEN t.productive THEN '1' ELSE '0' END
                        ) AS fila
                   FROM time_entries t
                   JOIN employees e ON e.id = t.employee_id AND e.organization_id = t.organization_id
                   LEFT JOIN projects p     ON p.id = t.project_id     AND p.organization_id = t.organization_id
                   LEFT JOIN cost_centers c ON c.id = t.cost_center_id AND c.organization_id = t.organization_id
                  WHERE t.organization_id = ${tx.$organizationId}::uuid
                    AND t.status = 'APROBADO'
                    AND t.date BETWEEN v.w_from AND v.w_to
               ) f), ${EMPTY_SHA256}) AS time_hash
      FROM ventanas v`

  for (const r of rows) out.set(`${fromUtcDate(r.w_from)}|${fromUtcDate(r.w_to)}`, r.time_hash)
  return out
}

/** Lo que `allocationRunStalenessBatch` necesita de cada run. */
export type StalenessRunRef = Pick<
  AllocationRunListItem,
  "id" | "periodKind" | "periodStart" | "periodEnd" | "ledgerHash" | "analyticsHash" | "rulesHash"
> & {
  fiscalYearId?: string
  /**
   * Instante del sellado (ISO). **Opcional y sólo para ATRIBUIR la causa** de un
   * `dimensionsHash` distinto: con él se distingue «han tocado la configuración»
   * de «han reclasificado una línea». Sin él, el run sigue saliendo `STALE`; lo
   * que se pierde es la precisión del motivo, nunca el veredicto.
   */
  runAt?: string
  /** O-E10-1: el CUARTO sello y la ventana que lo produjo. */
  timeHash?: string
  timeHashWindowStart?: LocalDate | null
  timeHashWindowEnd?: LocalDate | null
}

/**
 * **Staleness de N runs en TRES consultas**, sea cual sea N (§3.9, criterio 21).
 *
 * Un `AllocationRun` está `STALE` —derivado, nunca almacenado— si difiere
 * (a) el `ledgerHash` del periodo, (b) el `dimensionsHash`, (c) el `rulesHash`, o
 * (d) el `timeHash` recomputado **sobre la ventana que el propio run persiste**.
 *
 * (d) es el cuarto sello de D1 y es indispensable: aprobar un parte de diciembre
 * en enero cambia la base del reparto de diciembre, y sin él el run seguiría
 * luciendo vigente con un reparto que ya no se puede reproducir. **Y la ventana
 * no es cosmética** (O-E10-1): un run de marzo con `zeroBaseFallback = YTD`
 * reparte con partes de enero, así que su sello se tomó sobre `[01-01, 31-03]` y
 * es ahí donde hay que recomputarlo.
 */
export async function allocationRunStalenessBatch(
  tx: TenantTransactionClient,
  runs: readonly StalenessRunRef[]
): Promise<Map<string, { isStale: boolean; reasons: string[] }>> {
  const out = new Map<string, { isStale: boolean; reasons: string[] }>()
  if (runs.length === 0) return out

  // Los periodos DISTINTOS: doce runs mensuales del mismo ejercicio son doce
  // periodos, pero dos reruns del mismo periodo son uno.
  const periodByKey = new Map<string, PeriodRef>()
  for (const run of runs) {
    const key = `${run.periodStart}|${run.periodEnd}`
    if (!periodByKey.has(key)) {
      periodByKey.set(key, { periodStart: run.periodStart, periodEnd: run.periodEnd })
    }
  }

  // ── Consulta 1 ────────────────────────────────────────────────────────────
  const seals = await periodSealsBatch(tx, [...periodByKey.values()])

  // ── Consulta 2 ────────────────────────────────────────────────────────────
  // TODAS las reglas activas de una vez; `effectiveRules` las acota por
  // (periodicidad, fin de periodo) en TS, que es donde vive la definición.
  const allRules = await tx.allocationRule.findMany({
    where: { isActive: true },
    include: RULE_INCLUDE,
    orderBy: [{ priority: "asc" }, { code: "asc" }],
  })
  const specs = allRules.map(toSpec)

  // ── Consulta 3 ────────────────────────────────────────────────────────────
  // Las ventanas que los PROPIOS runs persisten (O-E10-1). Un run sin driver de
  // actividad selló `timeHash = '∅'` y ventana NULL: no hay nada que recomputar.
  const windowByKey = new Map<string, { from: LocalDate; to: LocalDate }>()
  for (const run of runs) {
    if (!run.timeHashWindowStart || !run.timeHashWindowEnd) continue
    windowByKey.set(`${run.timeHashWindowStart}|${run.timeHashWindowEnd}`, {
      from: run.timeHashWindowStart,
      to: run.timeHashWindowEnd,
    })
  }
  const timeHashes = await timeHashBatch(tx, [...windowByKey.values()])

  for (const run of runs) {
    const reasons: string[] = []
    const seal = seals.get(`${run.periodStart}|${run.periodEnd}`)
    if (!seal) {
      // Nunca se afirma «vigente» sobre lo que no se ha podido comprobar.
      out.set(run.id, {
        isStale: true,
        reasons: ["no se han podido recomputar los sellos del periodo: el run no se puede acreditar"],
      })
      continue
    }
    if (seal.ledgerHash !== run.ledgerHash) reasons.push("el diario del periodo ha cambiado")
    if (seal.dimensionsHash !== run.analyticsHash) {
      // El `dimensionsHash` resume DOS cosas —las dimensiones de las líneas y la
      // configuración de márgenes— y el run guarda un solo sello, así que el
      // veredicto (hay diferencia) es exacto y la causa se ATRIBUYE: si la
      // configuración se tocó después del sellado, decir «se ha reclasificado
      // alguna línea» es sencillamente falso.
      const sealedAt = run.runAt ? new Date(run.runAt) : null
      const configTouched =
        seal.configChangedAtMs !== null && sealedAt !== null && seal.configChangedAtMs > sealedAt.getTime()
      reasons.push(
        configTouched
          ? "ha cambiado la configuración analítica del periodo (niveles de margen o CECOs)"
          : "se ha reclasificado alguna línea del periodo"
      )
    }

    const effective = effectiveRules(specs, {
      kind: run.periodKind,
      label: periodLabel(run.periodKind, run.periodStart),
      start: run.periodStart,
      end: run.periodEnd,
      fiscalYearId: run.fiscalYearId ?? "",
      fiscalYearStart: run.periodStart,
      fiscalYearEnd: run.periodEnd,
    })
    if (computeRulesHash(effective) !== run.rulesHash) reasons.push("las reglas vigentes han cambiado")

    if (run.timeHashWindowStart && run.timeHashWindowEnd) {
      const current = timeHashes.get(`${run.timeHashWindowStart}|${run.timeHashWindowEnd}`)
      if (current !== undefined && current !== run.timeHash) {
        reasons.push(
          `los partes de horas del periodo han cambiado (ventana ${run.timeHashWindowStart} … ${run.timeHashWindowEnd})`
        )
      }
    }

    out.set(run.id, { isStale: reasons.length > 0, reasons })
  }
  return out
}
