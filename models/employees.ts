/**
 * E10 · T12 — Acceso a datos de empleados, tarifas y plantilla
 * (`docs/design/E10-presupuesto-horas.md` §4.1).
 *
 * **Ninguna función calcula**: leen, escriben y delegan en `lib/time/cost.ts`,
 * que es puro. Todo acceso pasa por `tenantDb` / `tenantTransaction`; toda
 * escritura lleva su `AuditLog` **en la misma transacción**, y todo aborto es un
 * `throw` (lección BLOQUEA-1 de E3: un `return` dentro de `tenantTransaction` NO
 * deshace nada, Prisma hace COMMIT).
 *
 * Tres cosas que este módulo hace y conviene no perder de vista:
 *
 *  1. **La vigencia anterior se cierra en la MISMA transacción** que abre la
 *     nueva. El `EXCLUDE USING gist` de `employee_rates` impide el solape, no el
 *     hueco: sin cerrar, el alta de una tarifa nueva fallaría con `23P01` o
 *     dejaría un día sin tarifa vigente, y un día sin tarifa es un coste **no
 *     evaluable** (I-E10-5), no un cero.
 *  2. **`COSTE_TOTAL_CON_ESTRUCTURA` es excluyente** con las reglas de actividad
 *     vigentes (O-E10-14): las dos juntas cargan la estructura dos veces.
 *  3. **La derivación desde la nómina es una PROPUESTA** (D3) y declara su
 *     **cobertura** (O-E10-12): con `scope = "EMPLOYEE"` y ocho líneas `64x` de
 *     treinta y cuatro con `counterpartyId`, extrapolar en silencio sería
 *     inventarse el 22 % de la nómina.
 */

import {
  DEFAULT_DERIVATION_MIN_COVERAGE_BPS,
  DEFAULT_RATE_BASIS,
  EXCLUDED_PAYROLL_PREFIXES,
  PAYROLL_PREFIXES_BY_BASIS,
  checkRateBasisConflict,
  deriveHourlyCost,
  type Cents,
  type DerivationScope,
  type DerivationTerms,
  type EmployeeRateBasisCode,
  type EmployeeRateRow,
} from "@/lib/time/cost"
import type { LocalDate } from "@/lib/analytics/types"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { centsFromDb } from "@/lib/money"
import type { Actor } from "@/models/analytics"
import { writeAuditLog } from "@/models/audit-log"
import { e10Abort } from "@/models/e10-errors"
import { Prisma, type EmployeeRateSource, type HeadcountSource } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Empleados
// ─────────────────────────────────────────────────────────────────────────────

export type EmployeeListItem = {
  id: string
  code: string
  name: string
  counterpartyId: string | null
  userId: string | null
  defaultCostCenterId: string | null
  defaultCostCenterCode: string | null
  fteMilli: number
  hireDate: LocalDate | null
  endDate: LocalDate | null
  isActive: boolean
  /** Tarifa vigente **hoy** (la fecha entra por parámetro: nada de reloj aquí). */
  currentRateCents: Cents | null
  currentRateBasis: EmployeeRateBasisCode | null
}

export type EmployeeFilter = {
  includeArchived?: boolean
  costCenterId?: string
  /** Fecha con la que se resuelve la tarifa vigente. La decide el BORDE. */
  rateAt?: LocalDate
}

export async function listEmployees(db: AnyClient, filter: EmployeeFilter = {}): Promise<EmployeeListItem[]> {
  const rows = await db.employee.findMany({
    where: {
      ...(filter.includeArchived === true ? {} : { isActive: true }),
      ...(filter.costCenterId ? { defaultCostCenterId: filter.costCenterId } : {}),
    },
    include: {
      defaultCostCenter: { select: { code: true } },
      rates: filter.rateAt
        ? {
            where: {
              validFrom: { lte: toUtcDate(filter.rateAt) },
              OR: [{ validTo: null }, { validTo: { gte: toUtcDate(filter.rateAt) } }],
            },
          }
        : false,
    },
    orderBy: [{ code: "asc" }],
  })
  return rows.map((r) => {
    // Con el `EXCLUDE` de la migración nunca hay dos: si las hubiera, se declara
    // «no evaluable» en vez de elegir una (I-E10-5).
    const rates = "rates" in r && Array.isArray(r.rates) ? r.rates : []
    const rate = rates.length === 1 ? rates[0] : null
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      counterpartyId: r.counterpartyId,
      userId: r.userId,
      defaultCostCenterId: r.defaultCostCenterId,
      defaultCostCenterCode: r.defaultCostCenter?.code ?? null,
      fteMilli: r.fteMilli,
      hireDate: r.hireDate ? fromUtcDate(r.hireDate) : null,
      endDate: r.endDate ? fromUtcDate(r.endDate) : null,
      isActive: r.isActive,
      currentRateCents: rate ? rate.hourlyCostCents : null,
      currentRateBasis: rate ? (rate.basis as EmployeeRateBasisCode) : null,
    }
  })
}

export async function getEmployee(db: AnyClient, employeeId: string): Promise<EmployeeListItem | null> {
  const [found] = await listEmployees(db, { includeArchived: true }).then((all) =>
    all.filter((e) => e.id === employeeId)
  )
  return found ?? null
}

export type EmployeeInput = {
  code: string
  name: string
  counterpartyId?: string | null
  userId?: string | null
  defaultCostCenterId?: string | null
  fteMilli?: number
  hireDate?: LocalDate | null
  endDate?: LocalDate | null
}

export async function createEmployeeTx(
  tx: TenantTransactionClient,
  input: EmployeeInput,
  actor: Actor
): Promise<{ id: string; code: string }> {
  const existing = await tx.employee.findFirst({ where: { code: input.code }, select: { id: true } })
  if (existing) {
    e10Abort("EMPLOYEE_CODE_EXISTS", "code", `ya existe un empleado con el código ${input.code} en la organización`)
  }
  const row = await tx.employee.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      counterpartyId: input.counterpartyId ?? null,
      userId: input.userId ?? null,
      defaultCostCenterId: input.defaultCostCenterId ?? null,
      fteMilli: input.fteMilli ?? 1000,
      hireDate: input.hireDate ? toUtcDate(input.hireDate) : null,
      endDate: input.endDate ? toUtcDate(input.endDate) : null,
    },
    select: { id: true, code: true },
  })
  await writeAuditLog(tx, {
    entity: "Employee",
    entityId: row.id,
    action: "create",
    after: { code: input.code, name: input.name, fteMilli: input.fteMilli ?? 1000 },
    userId: actor.userId,
  })
  return row
}

export async function updateEmployeeTx(
  tx: TenantTransactionClient,
  input: { employeeId: string } & Partial<Omit<EmployeeInput, "code">>,
  actor: Actor
): Promise<void> {
  const before = await tx.employee.findFirst({ where: { id: input.employeeId } })
  if (!before) e10Abort("EMPLOYEE_NOT_FOUND", "employeeId", "el empleado no existe en esta organización")
  await tx.employee.update({
    where: { id: before.id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.counterpartyId === undefined ? {} : { counterpartyId: input.counterpartyId }),
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      ...(input.defaultCostCenterId === undefined ? {} : { defaultCostCenterId: input.defaultCostCenterId }),
      ...(input.fteMilli === undefined ? {} : { fteMilli: input.fteMilli }),
      ...(input.hireDate === undefined ? {} : { hireDate: input.hireDate ? toUtcDate(input.hireDate) : null }),
      ...(input.endDate === undefined ? {} : { endDate: input.endDate ? toUtcDate(input.endDate) : null }),
    },
  })
  await writeAuditLog(tx, {
    entity: "Employee",
    entityId: before.id,
    action: "update",
    before: { name: before.name, fteMilli: before.fteMilli },
    after: { name: input.name ?? before.name, fteMilli: input.fteMilli ?? before.fteMilli },
    userId: actor.userId,
  })
}

/**
 * Archivar, nunca borrar: los partes de horas y los snapshots del histórico
 * apuntan al empleado con `onDelete: Restrict`, y un ejercicio ya rendido no
 * puede perder el nombre de quien imputó las horas.
 */
export async function archiveEmployeeTx(
  tx: TenantTransactionClient,
  input: { employeeId: string; archivedAt: Date },
  actor: Actor
): Promise<void> {
  const before = await tx.employee.findFirst({ where: { id: input.employeeId } })
  if (!before) e10Abort("EMPLOYEE_NOT_FOUND", "employeeId", "el empleado no existe en esta organización")
  await tx.employee.update({
    where: { id: before.id },
    data: { isActive: false, archivedAt: input.archivedAt },
  })
  await writeAuditLog(tx, {
    entity: "Employee",
    entityId: before.id,
    action: "archive",
    before: { isActive: before.isActive },
    after: { isActive: false },
    userId: actor.userId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tarifas
// ─────────────────────────────────────────────────────────────────────────────

export type EmployeeRateListItem = EmployeeRateRow & {
  source: EmployeeRateSource
  derivation: unknown
  note: string | null
  createdAt: string
}

export async function listEmployeeRates(
  db: AnyClient,
  filter: { employeeId?: string; from?: LocalDate; to?: LocalDate } = {}
): Promise<EmployeeRateListItem[]> {
  const rows = await db.employeeRate.findMany({
    where: {
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.to ? { validFrom: { lte: toUtcDate(filter.to) } } : {}),
      ...(filter.from ? { OR: [{ validTo: null }, { validTo: { gte: toUtcDate(filter.from) } }] } : {}),
    },
    include: { employee: { select: { code: true } } },
    orderBy: [{ employeeId: "asc" }, { validFrom: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeCode: r.employee.code,
    hourlyCostCents: r.hourlyCostCents,
    basis: r.basis as EmployeeRateBasisCode,
    validFrom: fromUtcDate(r.validFrom),
    validTo: r.validTo ? fromUtcDate(r.validTo) : null,
    source: r.source,
    derivation: r.derivation,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** Las filas que `lib/time/cost.ts` necesita, y nada más: es lo que come el motor. */
export async function getEmployeeRateRows(
  tx: TenantTransactionClient,
  window: { from: LocalDate; to: LocalDate }
): Promise<EmployeeRateRow[]> {
  const rows = await listEmployeeRates(tx, { from: window.from, to: window.to })
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeCode: r.employeeCode,
    hourlyCostCents: r.hourlyCostCents,
    basis: r.basis,
    validFrom: r.validFrom,
    validTo: r.validTo,
  }))
}

export type EmployeeRateInput = {
  employeeId: string
  hourlyCostCents: Cents
  basis: EmployeeRateBasisCode
  validFrom: LocalDate
  validTo?: LocalDate | null
  source?: EmployeeRateSource
  derivation?: DerivationTerms | null
  note?: string | null
}

/** Día anterior, aritmética de calendario pura (gemela de `previousDay` de E5). */
export function previousDay(date: LocalDate): LocalDate {
  const [y, m, d] = date.split("-").map(Number)
  if (d > 1) return `${y}-${pad(m)}-${pad(d - 1)}`
  if (m > 1) return `${y}-${pad(m - 1)}-${pad(lastDayOfMonth(y, m - 1))}`
  return `${y - 1}-12-31`
}
const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
const lastDayOfMonth = (y: number, m: number): number =>
  m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

/**
 * Alta de tarifa. **Cierra la vigencia anterior en la misma transacción**
 * (`validTo = validFrom − 1 día`) y rechaza `COSTE_TOTAL_CON_ESTRUCTURA` con
 * reglas de actividad vigentes (`RATE_BASIS_CONFLICT`, O-E10-14).
 */
export async function createEmployeeRateTx(
  tx: TenantTransactionClient,
  input: EmployeeRateInput,
  actor: Actor
): Promise<{ id: string; closedPreviousId: string | null }> {
  const employee = await tx.employee.findFirst({ where: { id: input.employeeId }, select: { id: true, code: true } })
  if (!employee) e10Abort("EMPLOYEE_NOT_FOUND", "employeeId", "el empleado no existe en esta organización")
  if (!Number.isInteger(input.hourlyCostCents) || input.hourlyCostCents <= 0) {
    e10Abort(
      "RATE_NOT_EVALUABLE",
      "hourlyCostCents",
      `el coste-hora de ${employee.code} debe ser un entero de céntimos > 0; recibido ${input.hourlyCostCents}`
    )
  }

  // O-E10-14: la exclusión se comprueba contra las reglas VIGENTES el día en que
  // la tarifa empieza a regir, no contra el catálogo entero.
  const activeRules = await tx.allocationRule.findMany({
    where: {
      isActive: true,
      validFrom: { lte: toUtcDate(input.validFrom) },
      OR: [{ validTo: null }, { validTo: { gte: toUtcDate(input.validFrom) } }],
    },
    select: { code: true, driver: true },
  })
  const conflict = checkRateBasisConflict(
    input.basis,
    activeRules.map((r) => ({ driver: r.driver, code: r.code }))
  )
  if (!conflict.ok) e10Abort("RATE_BASIS_CONFLICT", "basis", conflict.message)

  // O-E10-8 aplicado a las tarifas: la anterior se cierra ANTES de abrir la
  // nueva, o el `EXCLUDE USING gist` rechaza el INSERT con `23P01`.
  const previous = await tx.employeeRate.findFirst({
    where: {
      employeeId: employee.id,
      validFrom: { lt: toUtcDate(input.validFrom) },
      OR: [{ validTo: null }, { validTo: { gte: toUtcDate(input.validFrom) } }],
    },
    orderBy: { validFrom: "desc" },
  })
  if (previous) {
    await tx.employeeRate.update({
      where: { id: previous.id },
      data: { validTo: toUtcDate(previousDay(input.validFrom)) },
    })
  }

  const row = await tx.employeeRate.create({
    data: {
      organizationId: tx.$organizationId,
      employeeId: employee.id,
      hourlyCostCents: input.hourlyCostCents,
      basis: input.basis,
      source: input.source ?? "DECLARADO",
      // El CHECK `employee_rates_derivation` exige la equivalencia: derivada ⇔
      // con términos. Un número derivado sin sus términos no se puede rehacer.
      derivation:
        (input.source ?? "DECLARADO") === "DERIVADO_NOMINA"
          ? ((input.derivation ?? null) as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      validFrom: toUtcDate(input.validFrom),
      validTo: input.validTo ? toUtcDate(input.validTo) : null,
      note: input.note ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  })

  await writeAuditLog(tx, {
    entity: "EmployeeRate",
    entityId: row.id,
    action: "SET_RATE",
    ...(previous ? { before: { rateId: previous.id, validTo: previous.validTo } } : {}),
    after: {
      employeeCode: employee.code,
      hourlyCostCents: input.hourlyCostCents,
      basis: input.basis,
      validFrom: input.validFrom,
      source: input.source ?? "DECLARADO",
      closedPreviousTo: previous ? previousDay(input.validFrom) : null,
    },
    userId: actor.userId,
  })
  return { id: row.id, closedPreviousId: previous?.id ?? null }
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-12 — la propuesta de coste-hora derivada de la nómina
// ─────────────────────────────────────────────────────────────────────────────

export type HourlyCostProposalInput = {
  scope: DerivationScope
  costCenterId?: string
  employeeId?: string
  periodStart: LocalDate
  periodEnd: LocalDate
  basis?: EmployeeRateBasisCode
  /** Por defecto, `Organization.derivationMinCoverageBps`. */
  minCoverageBps?: number
}

export type HourlyCostProposal =
  | { ok: true; hourlyCostCents: Cents; derivation: DerivationTerms }
  | { ok: false; error: string; message: string; coverageBps: number | null }

/**
 * **Propuesta**, nunca aplicación (patrón `deriveHourlyCost`): devuelve la cifra
 * y **sus términos**, y aplicarla es un acto de un ADMIN con `AuditLog`.
 *
 * Los dos ámbitos leen la MISMA nómina y difieren en el numerador:
 *
 *  · `COST_CENTER` — tarifa **media** del CECO. Numerador = toda la nómina del
 *    CECO; no exige `counterpartyId` y es lo honesto cuando la nómina se
 *    contabiliza por centro, que es lo normal.
 *  · `EMPLOYEE`    — sólo las líneas `64x` con el `counterpartyId` del empleado.
 *    La **cobertura** viaja en los términos y por debajo del mínimo la propuesta
 *    sale **no evaluable** (`COVERAGE_TOO_LOW`) en vez de extrapolar.
 */
export async function proposeHourlyCost(
  tx: TenantTransactionClient,
  input: HourlyCostProposalInput
): Promise<HourlyCostProposal> {
  const basis = input.basis ?? DEFAULT_RATE_BASIS
  const prefixes = PAYROLL_PREFIXES_BY_BASIS[basis]

  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: tx.$organizationId },
    select: { derivationMinCoverageBps: true },
  })
  const minCoverageBps =
    input.minCoverageBps ?? organization.derivationMinCoverageBps ?? DEFAULT_DERIVATION_MIN_COVERAGE_BPS

  const costCenter = input.costCenterId
    ? await tx.costCenter.findFirst({ where: { id: input.costCenterId }, select: { id: true, code: true } })
    : null
  const employee = input.employeeId
    ? await tx.employee.findFirst({
        where: { id: input.employeeId },
        select: { id: true, code: true, counterpartyId: true, defaultCostCenterId: true },
      })
    : null
  if (input.scope === "EMPLOYEE" && !employee) {
    e10Abort("EMPLOYEE_NOT_FOUND", "employeeId", "la derivación individual necesita un empleado de la organización")
  }

  // El ámbito acota el CECO: en `EMPLOYEE`, el suyo por defecto si no se pasa.
  const scopeCostCenterId = costCenter?.id ?? employee?.defaultCostCenterId ?? null

  // Agregado EN SQL: la nómina del periodo por prefijo de cuenta, con la
  // cobertura del `counterpartyId` en la misma pasada. `−aporte` = debe − haber,
  // que es lo que un gasto aporta en positivo a la nómina.
  const [payroll] = await tx.$queryRaw<
    { payroll_cents: bigint; matched_cents: bigint; lines_total: bigint; lines_matched: bigint }[]
  >`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint                      AS payroll_cents,
           COALESCE(SUM(CASE WHEN ${employee?.counterpartyId ?? null}::uuid IS NOT NULL
                              AND l.counterparty_id = ${employee?.counterpartyId ?? null}::uuid
                             THEN l.debit_cents - l.credit_cents ELSE 0 END), 0)::bigint AS matched_cents,
           COUNT(*)::bigint                                                              AS lines_total,
           COUNT(*) FILTER (WHERE ${employee?.counterpartyId ?? null}::uuid IS NOT NULL
                              AND l.counterparty_id = ${employee?.counterpartyId ?? null}::uuid)::bigint
                                                                                         AS lines_matched
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date BETWEEN ${toUtcDate(input.periodStart)}::date AND ${toUtcDate(input.periodEnd)}::date
       AND (${scopeCostCenterId}::uuid IS NULL OR l.cost_center_id = ${scopeCostCenterId}::uuid)
       AND EXISTS (SELECT 1 FROM unnest(${[...prefixes]}::text[]) p WHERE l.account_code LIKE p || '%')
       AND NOT EXISTS (SELECT 1 FROM unnest(${[...EXCLUDED_PAYROLL_PREFIXES]}::text[]) x
                        WHERE l.account_code LIKE x || '%')`

  // Minutos PRODUCTIVOS y APROBADOS del ámbito (Q-3, modelo A). También agregado.
  const [minutes] = await tx.$queryRaw<{ minutes: bigint }[]>`
    SELECT COALESCE(SUM(t.minutes), 0)::bigint AS minutes
      FROM time_entries t
     WHERE t.organization_id = ${tx.$organizationId}::uuid
       AND t.status = 'APROBADO' AND t.productive
       AND t.date BETWEEN ${toUtcDate(input.periodStart)}::date AND ${toUtcDate(input.periodEnd)}::date
       AND (${input.scope === "EMPLOYEE" ? (employee?.id ?? null) : null}::uuid IS NULL
            OR t.employee_id = ${input.scope === "EMPLOYEE" ? (employee?.id ?? null) : null}::uuid)
       AND (${input.scope === "COST_CENTER" ? scopeCostCenterId : null}::uuid IS NULL
            OR t.cost_center_id = ${input.scope === "COST_CENTER" ? scopeCostCenterId : null}::uuid
            OR EXISTS (SELECT 1 FROM employees e
                        WHERE e.id = t.employee_id AND e.organization_id = t.organization_id
                          AND e.default_cost_center_id = ${input.scope === "COST_CENTER" ? scopeCostCenterId : null}::uuid))`

  const result = deriveHourlyCost({
    scope: input.scope,
    payrollCents: centsFromDb(payroll?.payroll_cents ?? BigInt(0), "nómina del periodo"),
    matchedAmountCents: centsFromDb(payroll?.matched_cents ?? BigInt(0), "nómina atribuida al empleado"),
    linesTotal: Number(payroll?.lines_total ?? BigInt(0)),
    linesMatched: Number(payroll?.lines_matched ?? BigInt(0)),
    productiveMinutes: Number(minutes?.minutes ?? BigInt(0)),
    accountPrefixes: prefixes,
    basis,
    minCoverageBps,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ...(costCenter ? { costCenterCode: costCenter.code } : {}),
    ...(employee ? { employeeCode: employee.code } : {}),
  })

  if (result.ok) return { ok: true, hourlyCostCents: result.value.hourlyCostCents, derivation: result.value.derivation }
  return { ok: false, error: result.error, message: result.message, coverageBps: result.coverageBps ?? null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantilla (`HeadcountSnapshot`) — la base del driver `HEADCOUNT`
// ─────────────────────────────────────────────────────────────────────────────

export type HeadcountRowItem = {
  id: string
  costCenterId: string
  costCenterCode: string
  periodEnd: LocalDate
  fteMilli: number
  headcount: number
  source: HeadcountSource
  note: string | null
}

export async function listHeadcount(
  db: AnyClient,
  filter: { from?: LocalDate; to?: LocalDate; costCenterId?: string } = {}
): Promise<HeadcountRowItem[]> {
  const rows = await db.headcountSnapshot.findMany({
    where: {
      ...(filter.costCenterId ? { costCenterId: filter.costCenterId } : {}),
      ...(filter.from || filter.to
        ? {
            periodEnd: {
              ...(filter.from ? { gte: toUtcDate(filter.from) } : {}),
              ...(filter.to ? { lte: toUtcDate(filter.to) } : {}),
            },
          }
        : {}),
    },
    include: { costCenter: { select: { code: true } } },
    orderBy: [{ periodEnd: "asc" }, { costCenterId: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    costCenterId: r.costCenterId,
    costCenterCode: r.costCenter.code,
    periodEnd: fromUtcDate(r.periodEnd),
    fteMilli: r.fteMilli,
    headcount: r.headcount,
    source: r.source,
    note: r.note,
  }))
}

/** Último día del mes de una fecha. El CHECK `headcount_last_day` lo exige. */
export function lastDayOfMonthOf(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number)
  return `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`
}

export async function upsertHeadcountSnapshotTx(
  tx: TenantTransactionClient,
  input: { costCenterId: string; periodEnd: LocalDate; fteMilli: number; headcount: number; source?: HeadcountSource; note?: string | null },
  actor: Actor
): Promise<{ id: string; created: boolean }> {
  if (input.periodEnd !== lastDayOfMonthOf(input.periodEnd)) {
    e10Abort(
      "HEADCOUNT_NOT_LAST_DAY",
      "periodEnd",
      `el snapshot de plantilla es a FIN de mes: ${input.periodEnd} no lo es (usa ${lastDayOfMonthOf(input.periodEnd)})`
    )
  }
  const existing = await tx.headcountSnapshot.findFirst({
    where: { costCenterId: input.costCenterId, periodEnd: toUtcDate(input.periodEnd) },
  })
  if (existing) {
    await tx.headcountSnapshot.update({
      where: { id: existing.id },
      data: {
        fteMilli: input.fteMilli,
        headcount: input.headcount,
        source: input.source ?? existing.source,
        note: input.note ?? existing.note,
      },
    })
    await writeAuditLog(tx, {
      entity: "HeadcountSnapshot",
      entityId: existing.id,
      action: "update",
      before: { fteMilli: existing.fteMilli, headcount: existing.headcount },
      after: { fteMilli: input.fteMilli, headcount: input.headcount },
      userId: actor.userId,
    })
    return { id: existing.id, created: false }
  }
  const row = await tx.headcountSnapshot.create({
    data: {
      organizationId: tx.$organizationId,
      costCenterId: input.costCenterId,
      periodEnd: toUtcDate(input.periodEnd),
      fteMilli: input.fteMilli,
      headcount: input.headcount,
      source: input.source ?? "MANUAL",
      note: input.note ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  })
  await writeAuditLog(tx, {
    entity: "HeadcountSnapshot",
    entityId: row.id,
    action: "create",
    after: { costCenterId: input.costCenterId, periodEnd: input.periodEnd, fteMilli: input.fteMilli },
    userId: actor.userId,
  })
  return { id: row.id, created: true }
}

/**
 * Deriva la plantilla a fin de mes desde `Employee`: Σ `fteMilli` de los
 * empleados **vivos** ese día en cada CECO por defecto. Es una **propuesta
 * escrita** (`DERIVADO_EMPLEADOS`), no un cálculo del driver: el driver lee
 * `headcount_snapshots` y sólo esa tabla, de modo que el reparto de un periodo
 * cerrado no cambia porque alguien edite una ficha de personal años después.
 */
export async function deriveHeadcountFromEmployeesTx(
  tx: TenantTransactionClient,
  input: { periodEnd: LocalDate },
  actor: Actor
): Promise<{ written: number }> {
  if (input.periodEnd !== lastDayOfMonthOf(input.periodEnd)) {
    e10Abort("HEADCOUNT_NOT_LAST_DAY", "periodEnd", `la derivación es a FIN de mes: ${input.periodEnd} no lo es`)
  }
  const rows = await tx.$queryRaw<{ cost_center_id: string; fte_milli: bigint; headcount: bigint }[]>`
    SELECT e.default_cost_center_id AS cost_center_id,
           COALESCE(SUM(e.fte_milli), 0)::bigint AS fte_milli,
           COUNT(*)::bigint                      AS headcount
      FROM employees e
     WHERE e.organization_id = ${tx.$organizationId}::uuid
       AND e.default_cost_center_id IS NOT NULL
       AND e.is_active
       AND (e.hire_date IS NULL OR e.hire_date <= ${toUtcDate(input.periodEnd)}::date)
       AND (e.end_date  IS NULL OR e.end_date  >= ${toUtcDate(input.periodEnd)}::date)
     GROUP BY e.default_cost_center_id
     ORDER BY e.default_cost_center_id`

  let written = 0
  // En SERIE: dentro de una transacción hay UNA conexión (regla de E6-perf).
  for (const row of rows) {
    await upsertHeadcountSnapshotTx(
      tx,
      {
        costCenterId: row.cost_center_id,
        periodEnd: input.periodEnd,
        fteMilli: Number(row.fte_milli),
        headcount: Number(row.headcount),
        source: "DERIVADO_EMPLEADOS",
      },
      actor
    )
    written += 1
  }
  return { written }
}
