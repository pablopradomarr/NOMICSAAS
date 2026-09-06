/**
 * E3 · T8 — Acceso a datos del libro diario (`docs/design/E3-libro-diario.md` §4).
 *
 * TODO el IO del diario pasa por aquí y TODO ocurre dentro de
 * `tenantTransaction` (RLS estricta, ADR-0009: una consulta de negocio fuera del
 * GUC no falla, devuelve vacío). El cálculo lo hace el motor puro de
 * `lib/ledger/`; este módulo sólo lee, escribe y traduce los errores de la BD.
 *
 * Reglas que este fichero implementa y que la BD REPITE (§2.4):
 *  - N-1…N-4: numeración correlativa sin huecos por ejercicio, bajo
 *    `SELECT … FOR UPDATE` sobre `fiscal_years` (§4.3).
 *  - C-1…C-13: validadas con `checkDraft` ANTES de insertar; los triggers
 *    diferidos vuelven a comprobar el cuadre al COMMIT.
 *  - Trazabilidad: `AuditLog` en la MISMA transacción que el asiento.
 */

import { getPlan, type Actor } from "@/models/accounts"
import { getAccountMapByKey } from "@/models/account-map"
import { writeAuditLog } from "@/models/audit-log"
import { listTaxRates } from "@/models/tax-rates"
// E4 · T8: el bloque analítico de `runInvariants`. Import circular controlado
// (`models/analytics` sólo usa de aquí funciones, dentro de cuerpos).
import { getAnalyticLines, getAnalyticsConfig } from "@/models/analytics"
import {
  TenantClient,
  TenantTransactionClient,
  TenantTransactionOptions,
  tenantTransaction,
} from "@/lib/db"
import type { AccountKey } from "@/lib/accounts/types"
// E5 · auditoría hallazgo 2: la base liquidable de I5.a, reconstruida por un
// camino independiente del que emitió las líneas. Módulo PURO.
import { reconstructBalances } from "@/lib/analytics/allocate"
import { fromUtcDate, resolveReversalDate, toUtcDate } from "@/lib/ledger/dates"
import { entryHash, HashableLine, ledgerHash } from "@/lib/ledger/hash"
import {
  runInvariants as runInvariantsPure,
  seal as sealPure,
  type CheckResult,
  type InvariantInput,
  type Seal,
  type Validacion,
} from "@/lib/ledger/invariants"
import { checkDraft, type CheckDraftOptions } from "@/lib/ledger/post"
import { buildFromTemplate, isTemplateCode, TEMPLATES, type TemplateCode } from "@/lib/ledger/templates"
import { buildReversal, type VoidOptions } from "@/lib/ledger/void"
import type {
  Cents,
  EntryDraft,
  EntryKind,
  FiscalYearRef,
  LedgerContext,
  LedgerError,
  LedgerErrorCode,
  LocalDate,
  PeriodLockRef,
  PostedEntry,
  PostedLine,
} from "@/lib/ledger/types"
import type { ReportLine } from "@/lib/ledger/reports/types"
import type { Prisma, TaxRoundingMode } from "@/prisma/client"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"

export type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Errores del modelo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los códigos del motor puro más los que sólo pueden nacer en la BD o en el
 * flujo de persistencia. Se mantienen separados de `LedgerErrorCode` para no
 * tocar `lib/ledger/` (que es Nivel 2 y ya está auditado).
 */
export type LedgerModelErrorCode =
  | LedgerErrorCode
  | "ENTRY_NOT_FOUND"
  | "FY_HAS_ENTRIES"
  | "FY_OVERLAP"
  | "FY_DUPLICATE_CODE"
  | "FY_DATES"
  | "LOCK_SEQUENCE"
  | "LOCK_NOT_FOUND"
  | "ALREADY_LOCKED"
  | "MONTHS_NOT_LOCKED"
  | "INVARIANTS_FAILED"
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_ALREADY_POSTED"
  | "TEMPLATE_UNKNOWN"
  | "TEMPLATE_SYSTEM_ONLY"
  | "DB_REJECTED"
  | "PERMISSION_DENIED"
  | "POSTED_BY_REQUIRED"
  // E5 — liquidación de CECOs (docs/design/E5-liquidacion.md §3.1 y §4.1).
  | "ALLOCATION_CYCLE"
  | "ALLOCATION_PRIORITY_NOT_TOPOLOGICAL"
  | "CASCADE_PERIOD_MISMATCH"
  | "ALLOCATION_TARGET_NOT_ALLOCATABLE"
  | "SOURCE_SHARE_NOT_100"
  | "FIXED_PERCENT_NOT_100"
  | "MANUAL_AMOUNT_MISMATCH"
  | "DRIVER_UNAVAILABLE"
  | "PERIOD_CROSSES_FISCAL_YEAR"
  | "SOURCE_NOT_ALLOCATABLE"
  // Ronda 1 de corrección (BLOQUEA #1, ADR-0013 D4): el destino exige destinos
  // explícitos, o la regla no puede repartir un céntimo.
  | "TARGETS_REQUIRED"
  | "RULE_INERT"
  | "ALLOCATION_RULE_NOT_FOUND"
  | "ALLOCATION_RUN_NOT_FOUND"
  | "ALLOCATION_RULE_IN_USE"
  | "ALLOCATION_RUN_NOT_SEALED"
  | "LIQUIDACION_DESFASADA"
  | "REASON_TOO_SHORT"

export type LedgerModelError = {
  code: LedgerModelErrorCode
  field: string
  message: string
  lineNo?: number
  check?: string
}

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; errors: LedgerModelError[] }

export const modelOk = <T>(value: T): LedgerResult<T> => ({ ok: true, value })
export const modelFail = <T>(...errors: LedgerModelError[]): LedgerResult<T> => ({ ok: false, errors })

export const modelErr = (
  code: LedgerModelErrorCode,
  field: string,
  message: string,
  opts: { lineNo?: number; check?: string } = {}
): LedgerModelError => ({ code, field, message, ...opts })

const fromEngine = (errors: readonly LedgerError[]): LedgerModelError[] => errors.map((e) => ({ ...e }))

/**
 * Aborto de una transacción de tenant (revisión ronda 1, hallazgo BLOQUEA #1).
 *
 * Devolver `modelFail(...)` desde dentro de `tenantTransaction` **no deshace
 * nada**: la promesa se resuelve y Prisma hace COMMIT, de modo que un lote con
 * el segundo asiento inválido persistía el primero y avanzaba `lastEntryNumber`,
 * y un cierre con un invariante en FAIL confirmaba T-26/T-27/T-28 y los
 * bloqueos. La única forma de abortar es **lanzar**: esta excepción lleva los
 * errores tipados y `runLedgerTransaction` los vuelve a convertir en
 * `LedgerResult` FUERA de la transacción, ya con el ROLLBACK hecho.
 */
export class LedgerAbort extends Error {
  readonly errors: LedgerModelError[]

  constructor(errors: readonly LedgerModelError[]) {
    super(errors.map((e) => `${e.code}: ${e.message}`).join(" · ") || "LedgerAbort")
    this.name = "LedgerAbort"
    this.errors = [...errors]
  }
}

/** Aborta la transacción en curso con errores tipados. Nunca retorna. */
export function abort(...errors: LedgerModelError[]): never {
  throw new LedgerAbort(errors)
}

/** Igual, a partir de los errores del motor puro. */
export function abortWith(errors: readonly LedgerError[]): never {
  throw new LedgerAbort(fromEngine(errors))
}

/**
 * Marca de «hay una mutación del diario en curso en esta cadena async».
 *
 * `tenantTransaction` es REENTRANTE: si se anida, reutiliza la transacción
 * externa. Para una lectura da igual, pero para una mutación es una trampa —
 * `runLedgerTransaction` anidado atraparía su propio `LedgerAbort` y devolvería
 * un `modelFail` mientras la transacción EXTERNA sigue viva y acabaría en
 * COMMIT: exactamente el fallo que #1 vino a cerrar, disfrazado. Se prohíbe.
 */
const ledgerTransactionDepth = new AsyncLocalStorage<{ organizationId: string }>()

/**
 * Error de programación, no de negocio: NO se traduce a `LedgerResult`. Si se
 * tradujera, el `runLedgerTransaction` externo lo convertiría en un `modelFail`
 * y seguiría hacia el COMMIT, que es justo lo que esto viene a impedir.
 */
export class LedgerNestingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LedgerNestingError"
  }
}

/**
 * Envoltura de toda mutación del diario: abre la `tenantTransaction`, y fuera
 * de ella traduce `LedgerAbort` (rollback ya hecho) y los errores de Postgres.
 *
 * Prohíbe el anidamiento (ronda 2): dentro de una mutación se usan las
 * funciones `…Tx(tx, …)`, que abortan lanzando y no atrapan nada.
 */
export async function runLedgerTransaction<T>(
  organizationId: string,
  userId: string | null | undefined,
  fn: (tx: TenantTransactionClient) => Promise<T>,
  options?: TenantTransactionOptions
): Promise<LedgerResult<T>> {
  const outer = ledgerTransactionDepth.getStore()
  if (outer) {
    throw new LedgerNestingError(
      "runLedgerTransaction anidado: una mutación del diario no puede abrir otra " +
        `(organización externa ${outer.organizationId}, interna ${organizationId}). ` +
        "Dentro de una transacción usa postEntryTx / lockPeriodTx / unlockPeriodTx, que abortan lanzando."
    )
  }
  try {
    const value = await ledgerTransactionDepth.run({ organizationId }, async () =>
      tenantTransaction(organizationId, userId ?? undefined, fn, options)
    )
    return modelOk(value)
  } catch (error) {
    // El anidamiento se propaga tal cual: es un bug del llamante, no un fallo
    // de negocio que la UI deba enseñar.
    if (error instanceof LedgerNestingError) throw error
    if (error instanceof LedgerAbort) return modelFail<T>(...error.errors)
    return modelFail<T>(translateDbError(error))
  }
}

/** La mayor de dos fechas locales (comparación lexicográfica: son ISO). */
const maxDate = (a: LocalDate, b: LocalDate): LocalDate => (a > b ? a : b)

/** Errores del motor → texto legible en español, anclado a su línea. */
export function formatLedgerErrors(errors: readonly LedgerModelError[]): string {
  return errors.map((e) => (e.lineNo !== undefined ? `[línea ${e.lineNo}] ${e.message}` : e.message)).join(" · ")
}

/**
 * «Hoy» en la zona de la organización, en el BORDE de la aplicación: el motor
 * puro no puede construir fechas (`lib/ledger/` no ve `new Date()`).
 */
export function todayLocalDate(timeZone = "Europe/Madrid"): LocalDate {
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date())
}

/**
 * Errores de Postgres → error legible. La UI NUNCA enseña el texto crudo de
 * Postgres (§6): se traduce por nombre de constraint y, en su defecto, por el
 * mensaje en español que emiten los triggers de la migración.
 */
export function translateDbError(error: unknown): LedgerModelError {
  const message = error instanceof Error ? error.message : String(error)
  const has = (needle: string) => message.includes(needle)

  /**
   * #13: el trigger ya dice el asiento y la diferencia exacta («asiento X
   * descuadrado: debe 121000 <> haber 100000 (diferencia 21000)»). Tirar ese
   * detalle dejaba a quien depura sin la cifra, así que se conserva la línea
   * del `RAISE` —sólo la primera, sin el CONTEXT ni el stack de Postgres—
   * detrás del mensaje en español.
   */
  const detail = (): string => {
    const first = message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("Invalid") && !l.startsWith("Raw query"))
    return first ? ` (${first})` : ""
  }

  if (has("journal_entry_balanced") || has("descuadrado")) {
    return modelErr("UNBALANCED", "lines", `El asiento está descuadrado: Σdebe ≠ Σhaber${detail()}`, { check: "C-1" })
  }
  if (has("journal_entry_both_sides") || has("sin contrapartida")) {
    return modelErr(
      "ONE_SIDED_ENTRY",
      "lines",
      `El asiento necesita al menos una línea al debe y una al haber${detail()}`,
      { check: "C-4" }
    )
  }
  if (has("journal_entry_min_lines") || has("sin líneas")) {
    return modelErr("TOO_FEW_LINES", "lines", "Un asiento tiene al menos dos líneas", { check: "C-4" })
  }
  if (has("journal_entry_no_double_reversal") || has("no puede anular otro contra-asiento")) {
    return modelErr("REVERSAL_OF_REVERSAL", "entryId", "Un contra-asiento no se anula con otro contra-asiento (I-E3-4)")
  }
  if (has("journal_entry_reversal_target_kind") || has("no se anulan con contra-asiento")) {
    return modelErr("REVERSAL_TARGET_KIND", "entryId", "Los asientos de apertura, cierre y regularización no se anulan")
  }
  if (has("journal_entries_idempotency_key")) {
    // Dos envíos EN PARALELO del mismo formulario: el primero gana, el segundo
    // choca con el índice único parcial. No es un error del usuario.
    return modelErr(
      "DB_REJECTED",
      "idempotencyKey",
      "Ese formulario ya se está contabilizando: recarga la página para ver el asiento"
    )
  }
  if (has("journal_entries_one_reversal")) {
    return modelErr("ALREADY_REVERSED", "entryId", "El asiento ya tiene un contra-asiento (I-E3-2)")
  }
  if (has("está cerrado")) {
    return modelErr("FY_CLOSED", "entryDate", "El ejercicio está cerrado: usa un ajuste de ejercicio cerrado (T-22)")
  }
  if (has("está bloqueado")) {
    return modelErr("MONTH_LOCKED", "entryDate", "El mes de la fecha contable está bloqueado")
  }
  if (has("cae fuera del ejercicio")) {
    return modelErr("DATE_OUT_OF_FY", "entryDate", "La fecha contable cae fuera del ejercicio")
  }
  if (has("no admite apuntes")) {
    return modelErr("ACCOUNT_NOT_POSTABLE", "accountCode", "La cuenta no admite apuntes (no es postable o está inactiva)")
  }
  if (has("journal_lines_analytics_e4")) {
    return modelErr("ANALYTIC_DIM_UNAVAILABLE", "lines", "Las dimensiones analíticas no existen hasta E4")
  }
  if (has("permission denied") || has("42501")) {
    return modelErr("PERMISSION_DENIED", "db", "La base de datos no autoriza esa operación sobre el diario")
  }
  return modelErr("DB_REJECTED", "db", `La base de datos rechazó el asiento: ${message.split("\n")[0]}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura: contexto del motor
// ─────────────────────────────────────────────────────────────────────────────

type OrganizationPolicyRow = {
  base_currency: string
  tax_rounding_mode: TaxRoundingMode
  prorrata_bps: number | null
  redondeo_tolerancia_cents: number
  analytics_required: boolean
}

type FiscalYearRow = {
  id: string
  code: string
  start_date: Date
  end_date: Date
  status: "OPEN" | "CLOSED"
  last_entry_number: number
}

/**
 * Compone el `LedgerContext` de §3.1 en UNA transacción.
 *
 * `organizations` no está en `TENANT_MODELS` (es quien decide QUÉ organización),
 * así que la extensión de tenant la deja pasar al cliente base y la consulta
 * saldría de la transacción sin GUC — con RLS estricta, vacía. Por eso se lee
 * con `$queryRaw`, que el facade de `tenantTransaction` envía a la transacción.
 */
export async function getLedgerContext(
  tx: TenantTransactionClient,
  refDate: LocalDate,
  opts: { balances?: ReadonlyMap<string, Cents> } = {}
): Promise<LedgerContext> {
  const organizationId = tx.$organizationId

  // Todo va EN SERIE: dentro de una transacción hay una ÚNICA conexión, así que
  // no hay paralelismo que ganar, y solaparlas hace que el adaptador `pg` avise
  // de «client is already executing a query» (E6-perf).
  const orgRows = await tx.$queryRaw<OrganizationPolicyRow[]>`
    SELECT base_currency, tax_rounding_mode, prorrata_bps, redondeo_tolerancia_cents, analytics_required
      FROM organizations WHERE id = ${organizationId}::uuid`

  const plan = await getPlan(tx)
  const mapByKey = await getAccountMapByKey(tx)
  const rates = await listTaxRates(tx)
  const fiscalYears = await listFiscalYearRefs(tx)
  const periodLocks = await listPeriodLockRefs(tx)
  // E4 · T6: las tres dimensiones. C-9 valida contra ESTOS catálogos.
  const projects = await tx.project.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] })
  const costCenters = await tx.costCenter.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] })
  const businessLines = await tx.businessLine.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] })

  const org = orgRows[0]
  if (!org) {
    throw new Error(`getLedgerContext: la organización ${organizationId} no es visible en esta transacción`)
  }

  return {
    organizationId,
    refDate,
    plan,
    map: (key: AccountKey) => mapByKey.get(key) ?? null,
    rates,
    fiscalYears,
    periodLocks,
    policy: {
      taxRoundingMode: org.tax_rounding_mode,
      prorrataBps: org.prorrata_bps,
      redondeoToleranciaCents: org.redondeo_tolerancia_cents,
      analyticsRequired: org.analytics_required,
    },
    // E4 · T6: C-9 deja de ser inerte (§3.3).
    dimensions: {
      available: true,
      projects: projects.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        businessLineId: p.businessLineId,
        status: p.status,
        sortOrder: p.sortOrder,
        isActive: p.isActive,
        closedAt: p.closedAt ? fromUtcDate(p.closedAt) : null,
      })),
      costCenters: costCenters.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        kind: c.kind,
        marginLevel: c.marginLevel as "MC3" | "EBITDA",
        allocatable: c.allocatable,
        sortOrder: c.sortOrder,
        isActive: c.isActive,
        isSystem: c.isSystem,
      })),
      businessLines: businessLines.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        sortOrder: b.sortOrder,
        isActive: b.isActive,
      })),
      unassignedCostCenterId: costCenters.find((c) => c.kind === "SIN_ASIGNAR")?.id ?? null,
    },
    baseCurrency: org.base_currency,
    ...(opts.balances ? { balances: opts.balances } : {}),
  }
}

/** Igual, abriendo la transacción. Para lecturas sueltas (previsualización). */
export async function getLedgerContextFor(
  organizationId: string,
  refDate: LocalDate,
  actor: Actor = { userId: null },
  opts: { balances?: ReadonlyMap<string, Cents> } = {}
): Promise<LedgerContext> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) =>
    getLedgerContext(tx, refDate, opts)
  )
}

export async function listFiscalYearRefs(db: AnyClient): Promise<FiscalYearRef[]> {
  const rows = await db.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
  return rows.map((fy) => ({
    id: fy.id,
    code: fy.code,
    startDate: fromUtcDate(fy.startDate),
    endDate: fromUtcDate(fy.endDate),
    status: fy.status,
  }))
}

export async function listPeriodLockRefs(db: AnyClient): Promise<PeriodLockRef[]> {
  const rows = await db.periodLock.findMany({ select: { fiscalYearId: true, month: true } })
  return rows.map((l) => ({ fiscalYearId: l.fiscalYearId, month: l.month }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura: asientos, líneas y saldos
// ─────────────────────────────────────────────────────────────────────────────

type EntryWithLines = Prisma.JournalEntryGetPayload<{ include: { lines: true } }>

export function toPostedEntry(row: EntryWithLines): PostedEntry {
  const lines: PostedLine[] = row.lines
    .slice()
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description,
      taxRateId: l.taxRateId,
      taxBaseCents: l.taxBaseCents,
      counterpartyId: l.counterpartyId,
      dueDate: l.dueDate ? fromUtcDate(l.dueDate) : null,
      analyticType: l.analyticType,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
      businessLineId: l.businessLineId,
      entryDate: fromUtcDate(l.entryDate),
      fiscalYearId: l.fiscalYearId,
      entryKind: l.entryKind,
    }))

  return {
    id: row.id,
    organizationId: row.organizationId,
    fiscalYearId: row.fiscalYearId,
    entryNumber: row.entryNumber,
    documentDate: row.documentDate ? fromUtcDate(row.documentDate) : null,
    accrualDate: row.accrualDate ? fromUtcDate(row.accrualDate) : null,
    entryDate: fromUtcDate(row.entryDate),
    description: row.description,
    kind: row.kind,
    taxRoundingMode: row.taxRoundingMode,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    templateCode: row.templateCode,
    reversesEntryId: row.reversesEntryId,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    entryHash: row.entryHash,
    lines,
  }
}

export type EntryFilter = {
  fiscalYearId?: string
  from?: LocalDate
  to?: LocalDate
  kind?: EntryKind
  accountCode?: string
  templateCode?: string
  transactionId?: string
  /** Texto libre sobre la descripción del asiento. */
  search?: string
  /** `true` = sólo anulados; `false` = sólo NO anulados. Informativo (I-E3-3). */
  voided?: boolean
  onlyReversals?: boolean
}

export type Page = { skip?: number; take?: number }

/**
 * Diario paginado, ordenado por `(entryDate, entryNumber)` (N-5).
 *
 * I-E3-3: `voided*` es informativo. El filtro existe para la UI («solo
 * anulados»), pero NINGÚN informe lo aplica: `getLinesForPeriod`,
 * `getAccountBalances` y `computeLedgerHash` no lo miran siquiera.
 */
export async function getEntries(
  db: AnyClient,
  filter: EntryFilter = {},
  page: Page = {}
): Promise<{ entries: PostedEntry[]; total: number }> {
  const where = entryWhere(filter)
  // En SERIE (E6-perf): el `include` ya dispara por su cuenta la consulta
  // hermana de `lines`; lanzar además el `count` en paralelo sobre la misma
  // conexión de la transacción provocaba el DeprecationWarning de `pg`.
  const rows = await db.journalEntry.findMany({
    where,
    include: { lines: true },
    orderBy: [{ entryDate: "asc" }, { entryNumber: "asc" }],
    skip: page.skip ?? 0,
    take: page.take ?? 50,
  })
  const total = await db.journalEntry.count({ where })
  return { entries: rows.map(toPostedEntry), total }
}

/** Alias del diseño (§4.1). */
export const listEntries = getEntries

function entryWhere(filter: EntryFilter): Prisma.JournalEntryWhereInput {
  return {
    ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.templateCode ? { templateCode: filter.templateCode } : {}),
    ...(filter.transactionId ? { transactionId: filter.transactionId } : {}),
    ...(filter.from || filter.to
      ? {
          entryDate: {
            ...(filter.from ? { gte: toUtcDate(filter.from) } : {}),
            ...(filter.to ? { lte: toUtcDate(filter.to) } : {}),
          },
        }
      : {}),
    ...(filter.search ? { description: { contains: filter.search, mode: "insensitive" as const } } : {}),
    ...(filter.voided === undefined ? {} : filter.voided ? { voidedAt: { not: null } } : { voidedAt: null }),
    ...(filter.onlyReversals ? { reversesEntryId: { not: null } } : {}),
    ...(filter.accountCode ? { lines: { some: { accountCode: filter.accountCode } } } : {}),
  }
}

export async function getEntry(db: AnyClient, id: string): Promise<PostedEntry | null> {
  const row = await db.journalEntry.findFirst({ where: { id }, include: { lines: true } })
  return row ? toPostedEntry(row) : null
}

export async function getEntryByNumber(
  db: AnyClient,
  fiscalYearId: string,
  entryNumber: number
): Promise<PostedEntry | null> {
  const row = await db.journalEntry.findFirst({ where: { fiscalYearId, entryNumber }, include: { lines: true } })
  return row ? toPostedEntry(row) : null
}

export type PeriodFilter = {
  from: LocalDate
  to: LocalDate
  accountCodes?: readonly string[]
  fiscalYearId?: string
  kinds?: readonly EntryKind[]
}

type LineRow = {
  entry_id: string
  entry_number: number
  entry_date: Date
  entry_kind: EntryKind
  fiscal_year_id: string
  line_no: number
  account_code: string
  debit_cents: number
  credit_cents: number
  description: string | null
  due_date: Date | null
  tax_rate_id: string | null
}

/**
 * Líneas de un periodo, ya en la forma que consumen los informes puros.
 *
 * SQL crudo porque la extensión de tenant no acota `$queryRaw`: el filtro por
 * `organization_id` va explícito (barrera 1) y la RLS lo repite (barrera 2).
 */
export async function getLinesForPeriod(tx: TenantTransactionClient, filter: PeriodFilter): Promise<ReportLine[]> {
  const organizationId = tx.$organizationId
  const codes = filter.accountCodes ? [...filter.accountCodes] : null
  const kinds = filter.kinds ? [...filter.kinds] : null

  const rows = await tx.$queryRaw<LineRow[]>`
    SELECT l.entry_id, e.entry_number, l.entry_date, l.entry_kind, l.fiscal_year_id,
           l.line_no, l.account_code, l.debit_cents, l.credit_cents, l.description, l.due_date, l.tax_rate_id
      FROM journal_lines l
      JOIN journal_entries e
        ON e.id = l.entry_id AND e.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId}::uuid
       AND l.entry_date BETWEEN ${toUtcDate(filter.from)}::date AND ${toUtcDate(filter.to)}::date
       AND (${filter.fiscalYearId ?? null}::uuid IS NULL OR l.fiscal_year_id = ${filter.fiscalYearId ?? null}::uuid)
       AND (${codes}::text[] IS NULL OR l.account_code = ANY(${codes}::text[]))
       AND (${kinds}::text[] IS NULL OR l.entry_kind::text = ANY(${kinds}::text[]))
     ORDER BY l.entry_date, e.entry_number, l.line_no`

  return rows.map((r) => ({
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    entryDate: fromUtcDate(r.entry_date),
    entryKind: r.entry_kind,
    fiscalYearId: r.fiscal_year_id,
    lineNo: r.line_no,
    accountCode: r.account_code,
    debitCents: r.debit_cents,
    creditCents: r.credit_cents,
    description: r.description,
    dueDate: r.due_date ? fromUtcDate(r.due_date) : null,
    taxRateId: r.tax_rate_id,
  }))
}

export type BalanceRow = { accountCode: string; debitCents: Cents; creditCents: Cents; balanceCents: Cents }

/**
 * Saldos por cuenta (`Σdebe − Σhaber`, negativo = acreedor). Entrada de T-23 y
 * del bloque C de plantillas (T-26/T-27/T-28) y del cierre de ejercicio.
 *
 * Los agregados se hacen con `BIGINT`: `Int` en céntimos aguanta 21 M € por
 * línea, pero la SUMA de un ejercicio entero puede desbordar el `int4` de
 * Postgres. Se convierten a `number` al salir (seguro: 2^53 céntimos son
 * 90 billones de euros).
 */
export async function getAccountBalances(
  tx: TenantTransactionClient,
  filter: { upTo: LocalDate; from?: LocalDate; fiscalYearId?: string; excludeKinds?: readonly EntryKind[] }
): Promise<Map<string, Cents>> {
  const rows = await getAccountBalanceRows(tx, filter)
  return new Map(rows.map((r) => [r.accountCode, r.balanceCents]))
}

export async function getAccountBalanceRows(
  tx: TenantTransactionClient,
  filter: { upTo: LocalDate; from?: LocalDate; fiscalYearId?: string; excludeKinds?: readonly EntryKind[] }
): Promise<BalanceRow[]> {
  const organizationId = tx.$organizationId
  const excluded = filter.excludeKinds ? [...filter.excludeKinds] : null

  const rows = await tx.$queryRaw<{ account_code: string; d: bigint; c: bigint }[]>`
    SELECT l.account_code,
           COALESCE(SUM(l.debit_cents)::bigint, 0)  AS d,
           COALESCE(SUM(l.credit_cents)::bigint, 0) AS c
      FROM journal_lines l
     WHERE l.organization_id = ${organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(filter.upTo)}::date
       AND (${filter.from ? toUtcDate(filter.from) : null}::date IS NULL
            OR l.entry_date >= ${filter.from ? toUtcDate(filter.from) : null}::date)
       AND (${filter.fiscalYearId ?? null}::uuid IS NULL OR l.fiscal_year_id = ${filter.fiscalYearId ?? null}::uuid)
       AND (${excluded}::text[] IS NULL OR NOT (l.entry_kind::text = ANY(${excluded}::text[])))
     GROUP BY l.account_code
     ORDER BY l.account_code`

  return rows.map((r) => ({
    accountCode: r.account_code,
    debitCents: Number(r.d),
    creditCents: Number(r.c),
    balanceCents: Number(r.d) - Number(r.c),
  }))
}

/**
 * Saldo vivo de una cuenta de deuda (`PAYMENT_EXCEEDS_LIABILITY` de T-11…T-13 y
 * T-24): saldo acreedor en positivo.
 */
export async function getOpenLiability(
  tx: TenantTransactionClient,
  accountCode: string,
  upTo: LocalDate
): Promise<Cents> {
  const rows = await getAccountBalanceRows(tx, { upTo })
  const row = rows.find((r) => r.accountCode === accountCode)
  return row ? -row.balanceCents : 0
}

/** Cierra el `TODO(E3)` de `getAccountUsage` (riesgo R6). */
export async function countLinesByAccount(db: AnyClient, accountCode: string): Promise<number> {
  return await db.journalLine.count({ where: { accountCode } })
}

/**
 * `ledgerHash` del ejercicio (o del periodo): sha256 de la forma canónica v1 de
 * TODAS sus líneas. Sella el contenido del diario para el sello de validación y
 * para la provenance de los informes.
 */
export async function computeLedgerHash(
  tx: TenantTransactionClient,
  filter: { fiscalYearId?: string; from?: LocalDate; to?: LocalDate } = {}
): Promise<string> {
  const organizationId = tx.$organizationId

  // Revisión ronda 1 (#9): el hash se calcula EN LA BASE, sobre las líneas ya
  // ordenadas, sin traerse el diario entero a memoria (un ejercicio grande son
  // cientos de miles de líneas). La forma canónica es la MISMA v1 de
  // `lib/ledger/hash.ts` — TSV con `∅` para nulos, `\n` entre filas, ordenada
  // por (entry_date, entry_number, line_no) — y hay un test de integración que
  // compara ambos caminos sobre el fixture completo, que es lo que impide que
  // diverjan.
  const rows = await tx.$queryRaw<{ hash: string }[]>`
    SELECT encode(
             sha256(convert_to(COALESCE(string_agg(fila, E'\n' ORDER BY entry_date, entry_number, line_no), ''), 'UTF8')),
             'hex'
           ) AS hash
      FROM (
        SELECT l.entry_date, e.entry_number, l.line_no,
               concat_ws(E'\t',
                 to_char(l.entry_date, 'YYYY-MM-DD'),
                 e.entry_number::text,
                 l.line_no::text,
                 l.account_code,
                 l.debit_cents::text,
                 l.credit_cents::text,
                 l.entry_kind::text
               ) AS fila
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
         WHERE l.organization_id = ${organizationId}::uuid
           AND (${filter.fiscalYearId ?? null}::uuid IS NULL OR l.fiscal_year_id = ${filter.fiscalYearId ?? null}::uuid)
           AND (${filter.from ? toUtcDate(filter.from) : null}::date IS NULL
                OR l.entry_date >= ${filter.from ? toUtcDate(filter.from) : null}::date)
           AND (${filter.to ? toUtcDate(filter.to) : null}::date IS NULL
                OR l.entry_date <= ${filter.to ? toUtcDate(filter.to) : null}::date)
      ) AS canonico`

  return rows[0]?.hash ?? ledgerHash([])
}

/**
 * El mismo hash calculado en TypeScript, materializando las líneas. Sólo para
 * los tests que comprueban que el SQL y el motor puro no han divergido.
 */
export async function computeLedgerHashInMemory(
  tx: TenantTransactionClient,
  filter: { fiscalYearId?: string; from?: LocalDate; to?: LocalDate } = {}
): Promise<string> {
  const lines = await getLinesForPeriod(tx, {
    from: filter.from ?? "0001-01-01",
    to: filter.to ?? "9999-12-31",
    ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
  })
  const hashable: HashableLine[] = lines.map((l) => ({
    entryId: l.entryId,
    entryDate: l.entryDate,
    entryNumber: l.entryNumber,
    lineNo: l.lineNo,
    accountCode: l.accountCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    entryKind: l.entryKind,
    fiscalYearId: l.fiscalYearId,
    taxRateId: l.taxRateId ?? null,
  }))
  return ledgerHash(hashable)
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariantes por agregado SQL (#9): lo que se puede comprobar sin traerse el
// diario a memoria. Son los dos que más cuestan y los que más importan.
// ─────────────────────────────────────────────────────────────────────────────

/** I1 por SQL: Σdebe = Σhaber POR ASIENTO, con `HAVING`. */
export async function checkI1Sql(tx: TenantTransactionClient, fiscalYearId?: string): Promise<CheckResult> {
  const organizationId = tx.$organizationId
  const rows = await tx.$queryRaw<{ entry_number: number; entry_date: Date; d: bigint; c: bigint }[]>`
    SELECT e.entry_number, e.entry_date,
           COALESCE(SUM(l.debit_cents), 0)::bigint AS d,
           COALESCE(SUM(l.credit_cents), 0)::bigint AS c
      FROM journal_entries e
      LEFT JOIN journal_lines l ON l.entry_id = e.id AND l.organization_id = e.organization_id
     WHERE e.organization_id = ${organizationId}::uuid
       AND (${fiscalYearId ?? null}::uuid IS NULL OR e.fiscal_year_id = ${fiscalYearId ?? null}::uuid)
     GROUP BY e.id, e.entry_number, e.entry_date
    HAVING COALESCE(SUM(l.debit_cents), 0) <> COALESCE(SUM(l.credit_cents), 0)
        OR count(l.id) < 2
     ORDER BY e.entry_number
     LIMIT 20`

  const query =
    "SELECT e.entry_number, SUM(l.debit_cents), SUM(l.credit_cents) FROM journal_entries e " +
    "JOIN journal_lines l ON l.entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)"

  if (rows.length === 0) {
    return { id: "I1", status: "PASS", evidencia: "Ningún asiento descuadrado (agregado en SQL, por asiento)", query }
  }
  return {
    id: "I1",
    status: "FAIL",
    evidencia: rows
      .map((r) => `nº ${r.entry_number} (${fromUtcDate(r.entry_date)}): debe ${r.d} ≠ haber ${r.c}`)
      .join(" · "),
    query,
  }
}

/** I7 por SQL: numeración `1..max` sin huecos ni duplicados, por ejercicio. */
export async function checkI7Sql(tx: TenantTransactionClient, fiscalYearId?: string): Promise<CheckResult> {
  const organizationId = tx.$organizationId
  const rows = await tx.$queryRaw<
    { code: string; total: bigint; distintos: bigint; minimo: number | null; maximo: number | null; last: number }[]
  >`
    SELECT fy.code,
           count(e.id)::bigint AS total,
           count(DISTINCT e.entry_number)::bigint AS distintos,
           min(e.entry_number) AS minimo,
           max(e.entry_number) AS maximo,
           fy.last_entry_number AS last
      FROM fiscal_years fy
      LEFT JOIN journal_entries e ON e.fiscal_year_id = fy.id AND e.organization_id = fy.organization_id
     WHERE fy.organization_id = ${organizationId}::uuid
       AND (${fiscalYearId ?? null}::uuid IS NULL OR fy.id = ${fiscalYearId ?? null}::uuid)
     GROUP BY fy.id, fy.code, fy.last_entry_number
     ORDER BY fy.code`

  const query =
    "SELECT fy.code, count(e.id), count(DISTINCT e.entry_number), min(e.entry_number), max(e.entry_number), " +
    "fy.last_entry_number FROM fiscal_years fy LEFT JOIN journal_entries e ON e.fiscal_year_id = fy.id GROUP BY fy.id"

  const failures: string[] = []
  for (const row of rows) {
    const total = Number(row.total)
    if (total === 0) continue
    if (Number(row.distintos) !== total) failures.push(`${row.code}: números repetidos`)
    if (row.minimo !== 1) failures.push(`${row.code}: empieza en ${row.minimo}, no en 1`)
    if (row.maximo !== total) failures.push(`${row.code}: ${total} asientos y el máximo es ${row.maximo} (hay huecos)`)
    if (row.last !== row.maximo) {
      failures.push(`${row.code}: last_entry_number ${row.last} ≠ máximo ${row.maximo}`)
    }
  }

  return failures.length === 0
    ? {
        id: "I7",
        status: "PASS",
        evidencia: `Numeración contigua 1..n en ${rows.length} ejercicio(s) (agregado en SQL)`,
        query,
      }
    : { id: "I7", status: "FAIL", evidencia: failures.join(" · "), query }
}

/** Nº de asientos, para decidir si se materializa el diario (#9). */
export async function countEntries(tx: TenantTransactionClient, fiscalYearId?: string): Promise<number> {
  return await tx.journalEntry.count({ where: fiscalYearId ? { fiscalYearId } : {} })
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura: postEntry (§4.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * E4-D2: `entryHash` cubre TODAS las columnas de la línea. `entryId` sólo se
 * conoce después del INSERT, así que se pasa aparte y el hash se calcula con él.
 */
function hashableOf(draft: EntryDraft, entryNumber: number, entryId: string | null = null): HashableLine[] {
  return draft.lines.map((l) => ({
    entryId,
    entryDate: draft.entryDate,
    entryNumber,
    lineNo: l.lineNo,
    accountCode: l.accountCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    entryKind: draft.kind,
    fiscalYearId: draft.fiscalYearId,
    taxRateId: l.taxRateId ?? null,
    taxBaseCents: l.taxBaseCents ?? null,
    counterpartyId: l.counterpartyId ?? null,
    dueDate: l.dueDate ?? null,
    description: l.description ?? null,
    analyticType: l.analyticType ?? null,
    projectId: l.projectId ?? null,
    costCenterId: l.costCenterId ?? null,
    businessLineId: l.businessLineId ?? null,
  }))
}

/**
 * Inserta un asiento YA VALIDADO dentro de una transacción de tenant abierta.
 *
 * 1. `FOR UPDATE` sobre la fila del ejercicio: serializa a los posteadores
 *    concurrentes de ESE ejercicio y de ninguno más (N-2).
 * 2. Asiento + líneas + contador, en la misma transacción.
 * 3. `AuditLog`.
 * 4. Al COMMIT, los constraint triggers diferidos comprueban el cuadre: si
 *    fallan, no hay asiento NI número.
 */
export async function postEntryTx(
  tx: TenantTransactionClient,
  draft: EntryDraft,
  actor: Actor,
  opts: {
    idempotencyKey?: string | null
    /** I-E4-10: excepción ADMIN para postear a un proyecto cerrado. Va al log. */
    closedProjectOverride?: { role: string; reason: string } | undefined
  } = {}
): Promise<PostedEntry> {
  const organizationId = tx.$organizationId
  if (draft.organizationId !== organizationId) {
    abort(modelErr("TENANT_MISMATCH", "organizationId", "El borrador es de otra organización", { check: "C-13" }))
  }
  // Revisión #2: el asiento SIEMPRE lleva quién lo contabilizó. Sin usuario no
  // se postea (la FK a `users` lo repite en la base de datos).
  if (!actor.userId) {
    abort(modelErr("POSTED_BY_REQUIRED", "postedById", "Un asiento necesita el usuario que lo contabiliza"))
  }

  // Revisión #8: idempotencia de formulario. Si el mismo envío llega dos veces
  // (doble clic, reintento del navegador), se devuelve el asiento que ya
  // existe en vez de duplicarlo; el índice único parcial lo repite en la BD.
  const idempotencyKey = opts.idempotencyKey ?? null
  if (idempotencyKey) {
    const existing = await tx.journalEntry.findFirst({ where: { idempotencyKey }, include: { lines: true } })
    if (existing) return toPostedEntry(existing)
  }

  const [fy] = await tx.$queryRaw<FiscalYearRow[]>`
    SELECT id, code, start_date, end_date, status, last_entry_number
      FROM fiscal_years
     WHERE id = ${draft.fiscalYearId}::uuid AND organization_id = ${organizationId}::uuid
     FOR UPDATE`

  if (!fy) {
    abort(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
  }
  if (fy.status === "CLOSED") {
    abort(modelErr("FY_CLOSED", "entryDate", `El ejercicio ${fy.code} está cerrado: registra el documento con T-22`))
  }

  const entryNumber = fy.last_entry_number + 1
  // El id se genera AQUÍ para que entre en la forma canónica v2 del sello: el
  // hash se calcula ANTES del INSERT y describe exactamente lo que se inserta.
  const entryId = randomUUID()
  const hash = entryHash(hashableOf(draft, entryNumber, entryId))

  {
    const entry = await tx.journalEntry.create({
      data: {
        id: entryId,
        organizationId,
        fiscalYearId: draft.fiscalYearId,
        entryNumber,
        documentDate: draft.documentDate ? toUtcDate(draft.documentDate) : null,
        accrualDate: draft.accrualDate ? toUtcDate(draft.accrualDate) : null,
        entryDate: toUtcDate(draft.entryDate),
        description: draft.description,
        kind: draft.kind,
        taxRoundingMode: draft.taxRoundingMode,
        sourceType: draft.sourceType,
        sourceId: draft.sourceId ?? null,
        transactionId: draft.transactionId ?? null,
        fileId: draft.fileId ?? null,
        templateCode: draft.templateCode ?? null,
        reversesEntryId: draft.reversesEntryId ?? null,
        postedById: actor.userId,
        idempotencyKey,
        entryHash: hash,
      },
    })

    await tx.journalLine.createMany({
      data: draft.lines.map((l, index) => ({
        organizationId,
        entryId: entry.id,
        lineNo: index + 1,
        accountCode: l.accountCode,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        description: l.description ?? null,
        taxRateId: l.taxRateId ?? null,
        taxBaseCents: l.taxBaseCents ?? null,
        counterpartyId: l.counterpartyId ?? null,
        dueDate: l.dueDate ? toUtcDate(l.dueDate) : null,
        // E4: el tipo EFECTIVO y las tres dimensiones ya resueltas por
        // `resolveAnalytics` (R-A2/R-A3/R-A4/R-A9) se persisten tal cual.
        analyticType: l.analyticType ?? null,
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
        businessLineId: l.businessLineId ?? null,
        entryDate: toUtcDate(draft.entryDate),
        fiscalYearId: draft.fiscalYearId,
        entryKind: draft.kind,
      })),
    })

    await tx.fiscalYear.update({ where: { id: fy.id }, data: { lastEntryNumber: entryNumber } })

    const posted = await getEntry(tx, entry.id)
    if (!posted) {
      abort(modelErr("ENTRY_NOT_FOUND", "id", "El asiento recién creado no es legible en esta transacción"))
    }

    await writeAuditLog(tx, {
      entity: "JournalEntry",
      entityId: entry.id,
      action: "post",
      after: {
        entryNumber,
        entryDate: draft.entryDate,
        description: draft.description,
        kind: draft.kind,
        templateCode: draft.templateCode ?? null,
        entryHash: hash,
        // I-E4-10: si el asiento entra en un proyecto cerrado por excepción de
        // ADMIN, el motivo queda aquí. Sin esto la excepción sería invisible.
        ...(opts.closedProjectOverride
          ? { closedProjectOverride: { role: opts.closedProjectOverride.role, reason: opts.closedProjectOverride.reason } }
          : {}),
        lines: draft.lines.map((l) => ({
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          analyticType: l.analyticType ?? null,
          projectId: l.projectId ?? null,
          costCenterId: l.costCenterId ?? null,
        })),
      },
      reason: opts.closedProjectOverride?.reason ?? null,
      userId: actor.userId ?? null,
    })

    // Las violaciones NO diferidas (periodo, cuenta, anulación) saltan como
    // excepción desde aquí; las diferidas, al COMMIT. Ambas las traduce el
    // llamante público (`runLedgerTransaction`) con `translateDbError`.
    return posted
  }
}

/**
 * Postea un borrador: valida con el motor puro (C-1…C-13) y, si pasa, inserta.
 *
 * La validación es previa al `FOR UPDATE`, de modo que un asiento inválido no
 * consume número (N-3).
 */
export async function postEntry(
  organizationId: string,
  draft: EntryDraft,
  actor: Actor,
  /**
   * Revisión #12: `refDate` es OBLIGATORIA. Con el default anterior
   * (`draft.entryDate`) un asiento con fecha futura se validaba contra sí mismo
   * y C-11 nunca podía dar `FUTURE_DATE`. Quien postea decide qué día es hoy.
   * `skipCheck` es la única excepción: sirve para ejercer la barrera 2 (la BD).
   */
  opts:
    | { refDate: LocalDate; check?: CheckDraftOptions; skipCheck?: false; idempotencyKey?: string | null }
    | { skipCheck: true; refDate?: LocalDate; check?: CheckDraftOptions; idempotencyKey?: string | null }
): Promise<LedgerResult<PostedEntry>> {
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    if (!opts.skipCheck) {
      const ctx = await getLedgerContext(tx, opts.refDate)
      const checked = checkDraft(draft, ctx, opts.check ?? {})
      if (!checked.ok) abortWith(checked.errors)
    }
    return await postEntryTx(tx, draft, actor, {
      idempotencyKey: opts.idempotencyKey ?? null,
      ...(opts.check?.closedProjectOverride ? { closedProjectOverride: opts.check.closedProjectOverride } : {}),
    })
  })
}

/**
 * Lote de asientos en UNA transacción (I7, riesgo R3): el `FOR UPDATE` sobre el
 * ejercicio se toma en el primero y se conserva hasta el COMMIT, de modo que el
 * lote entero reserva un rango contiguo de números sin que nadie se cuele.
 */
export async function postEntries(
  organizationId: string,
  drafts: readonly EntryDraft[],
  actor: Actor,
  opts: { refDate: LocalDate; skipCheck?: boolean; transaction?: TenantTransactionOptions }
): Promise<LedgerResult<PostedEntry[]>> {
  return await runLedgerTransaction(
    organizationId,
    actor.userId,
    async (tx) => {
      const ctx = opts.skipCheck ? null : await getLedgerContext(tx, opts.refDate)
      const out: PostedEntry[] = []
      for (const draft of drafts) {
        if (ctx) {
          const checked = checkDraft(draft, ctx, {})
          // Abortar, no devolver: si el segundo asiento del lote es inválido, el
          // primero NO puede quedar confirmado (BLOQUEA #1).
          if (!checked.ok) abortWith(checked.errors)
        }
        out.push(await postEntryTx(tx, draft, actor))
      }
      return out
    },
    opts.transaction ?? { timeout: 120_000, maxWait: 15_000 }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Anulación (T-21)
// ─────────────────────────────────────────────────────────────────────────────

export type VoidResult = { reversal: PostedEntry; voided: PostedEntry; voidedTransactionId: string | null }

/**
 * Anulación = contra-asiento exacto. La fecha la decide el motor (§2.5 del
 * experto): la del original si su mes sigue abierto, si no el primer día del
 * primer mes abierto ≥ `entryDate`; `requestedDate` sólo puede retrasarla.
 *
 * El asiento anulado recibe `voided_at`/`voided_by_id`/`void_reason`, que es la
 * ÚNICA mutación que la BD autoriza sobre `journal_entries` (GRANT de columna).
 */
export async function voidEntry(
  organizationId: string,
  entryId: string,
  reason: string,
  actor: Actor,
  opts: { requestedDate?: LocalDate | null; refDate?: LocalDate } = {}
): Promise<LedgerResult<VoidResult>> {
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const original = await getEntry(tx, entryId)
    if (!original) {
      abort(modelErr("ENTRY_NOT_FOUND", "entryId", "El asiento no existe en esta organización"))
    }

    const existingReversals = await tx.journalEntry.findMany({
      where: { reversesEntryId: entryId },
      select: { id: true },
    })
    const row = await tx.journalEntry.findFirst({ where: { id: entryId }, select: { transactionId: true } })

    /**
     * #11 · la `refDate` por defecto es **la fecha resuelta del contra-asiento**,
     * no la del original. Si el mes del original está bloqueado, el espejo nace
     * el primer día del primer mes abierto ≥ esa fecha, que es POSTERIOR: con la
     * del original como «hoy», C-11 lo rechazaba por `FUTURE_DATE` y no se podía
     * anular nada de un mes cerrado. Se resuelve primero la fecha con un
     * contexto permisivo y se vuelve a componer con ella.
     */
    const probe = await getLedgerContext(tx, "9999-12-31")
    const resolved = resolveReversalDate(original.entryDate, probe, opts.requestedDate ?? null)
    if (!resolved.ok) abortWith(resolved.errors)
    const refDate = opts.refDate ?? maxDate(resolved.value.entryDate, todayLocalDate())

    const ctx = await getLedgerContext(tx, refDate)
    const voidOptions: VoidOptions = {
      reason,
      requestedDate: opts.requestedDate ?? null,
      existingReversals,
    }
    const built = buildReversal(original, voidOptions, ctx)
    if (!built.ok) abortWith(built.errors)

    const reversal = await postEntryTx(tx, built.value, actor)

    await tx.journalEntry.update({
      where: { id: entryId },
      data: { voidedAt: new Date(), voidedById: actor.userId ?? null, voidReason: reason },
    })

    // QA · criterio 10: si el asiento contabilizaba una operación heredada, la
    // operación vuelve a VOID **en la misma transacción**. Antes hacía falta
    // llamar aparte a `voidTransactionPosting`, que ninguna action usaba, y la
    // `Transaction` se quedaba en POSTED apuntando a un asiento anulado.
    let voidedTransactionId: string | null = null
    if (row?.transactionId) {
      await tx.transaction.update({ where: { id: row.transactionId }, data: { status: "VOID" } })
      voidedTransactionId = row.transactionId
    }

    await writeAuditLog(tx, {
      entity: "JournalEntry",
      entityId: entryId,
      action: "void",
      before: { entryNumber: original.entryNumber, voidedAt: null, transactionId: row?.transactionId ?? null },
      after: {
        reversalEntryId: reversal.id,
        reversalEntryNumber: reversal.entryNumber,
        transactionStatus: voidedTransactionId ? "VOID" : null,
      },
      reason,
      userId: actor.userId ?? null,
    })

    const voided = await getEntry(tx, entryId)
    return { reversal, voided: voided ?? original, voidedTransactionId }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas
// ─────────────────────────────────────────────────────────────────────────────

export type TemplateSummary = {
  code: TemplateCode
  label: string
  block: "A" | "B" | "C"
  kind: EntryKind
  systemOnly: boolean
}

export const listTemplates = (opts: { includeSystem?: boolean } = {}): TemplateSummary[] =>
  Object.values(TEMPLATES)
    .filter((t) => opts.includeSystem || !t.systemOnly)
    .map((t) => ({ code: t.code, label: t.label, block: t.block, kind: t.kind, systemOnly: t.systemOnly }))

/**
 * Construye el borrador de una plantilla SIN persistir nada (vista previa de
 * §6). Lee el contexto real de la organización, así que ve el plan, los tipos
 * vigentes, los ejercicios y los bloqueos de verdad.
 */
export async function previewTemplate(
  organizationId: string,
  templateCode: string,
  input: unknown,
  actor: Actor,
  opts: { refDate: LocalDate; withBalances?: boolean }
): Promise<LedgerResult<EntryDraft>> {
  if (!isTemplateCode(templateCode)) {
    return modelFail(modelErr("TEMPLATE_UNKNOWN", "templateCode", `Plantilla desconocida: ${templateCode}`))
  }
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const balances = opts.withBalances ? await getAccountBalances(tx, { upTo: opts.refDate }) : undefined
    const ctx = await getLedgerContext(tx, opts.refDate, balances ? { balances } : {})
    const built = buildFromTemplate(templateCode, input, ctx)
    if (!built.ok) abortWith(built.errors)
    return built.value
  })
}

/** Postea directamente desde una plantilla de operativa (T-01…T-24). */
export async function postFromTemplate(
  organizationId: string,
  templateCode: string,
  input: unknown,
  actor: Actor,
  opts: {
    refDate: LocalDate
    allowSystem?: boolean
    link?: { transactionId?: string; fileId?: string }
    idempotencyKey?: string | null
  }
): Promise<LedgerResult<PostedEntry>> {
  if (!isTemplateCode(templateCode)) {
    return modelFail(modelErr("TEMPLATE_UNKNOWN", "templateCode", `Plantilla desconocida: ${templateCode}`))
  }
  if (TEMPLATES[templateCode].systemOnly && !opts.allowSystem) {
    return modelFail(
      modelErr(
        "TEMPLATE_SYSTEM_ONLY",
        "templateCode",
        `La plantilla ${templateCode} no tiene acción de usuario en E3: la orquesta el cierre de ejercicio`
      )
    )
  }
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const needsBalances = TEMPLATES[templateCode].block === "C"
    const balances = needsBalances ? await getAccountBalances(tx, { upTo: opts.refDate }) : undefined
    const ctx = await getLedgerContext(tx, opts.refDate, balances ? { balances } : {})
    const built = buildFromTemplate(templateCode, input, ctx)
    if (!built.ok) abortWith(built.errors)
    const draft: EntryDraft = {
      ...built.value,
      transactionId: opts.link?.transactionId ?? built.value.transactionId ?? null,
      fileId: opts.link?.fileId ?? built.value.fileId ?? null,
    }
    return await postEntryTx(tx, draft, actor, { idempotencyKey: opts.idempotencyKey ?? null })
  })
}

export type PostedTransaction = { entry: PostedEntry; transactionId: string }

/**
 * «Contabilizar» una operación heredada (criterio 10): crea el asiento con
 * `transactionId` + `fileId` y deja la `Transaction` en `POSTED` con
 * `journalEntryId`.
 */
export async function postTransactionWithTemplate(
  organizationId: string,
  transactionId: string,
  templateCode: string,
  input: unknown,
  actor: Actor,
  opts: { refDate: LocalDate; idempotencyKey?: string | null }
): Promise<LedgerResult<PostedTransaction>> {
  if (!isTemplateCode(templateCode)) {
    return modelFail(modelErr("TEMPLATE_UNKNOWN", "templateCode", `Plantilla desconocida: ${templateCode}`))
  }
  if (TEMPLATES[templateCode].systemOnly) {
    return modelFail(
      modelErr("TEMPLATE_SYSTEM_ONLY", "templateCode", "Las plantillas de cierre no contabilizan operaciones")
    )
  }
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const transaction = await tx.transaction.findFirst({ where: { id: transactionId } })
    if (!transaction) {
      abort(modelErr("TRANSACTION_NOT_FOUND", "transactionId", "La operación no existe en esta organización"))
    }
    if (transaction.status === "POSTED" || transaction.journalEntryId) {
      abort(modelErr("TRANSACTION_ALREADY_POSTED", "transactionId", "La operación ya está contabilizada"))
    }

    const ctx = await getLedgerContext(tx, opts.refDate)
    const built = buildFromTemplate(templateCode, input, ctx)
    if (!built.ok) abortWith(built.errors)

    const draft: EntryDraft = { ...built.value, transactionId, fileId: built.value.fileId ?? null }
    const entry = await postEntryTx(tx, draft, actor, { idempotencyKey: opts.idempotencyKey ?? null })

    await tx.transaction.update({
      where: { id: transactionId },
      data: { status: "POSTED", journalEntryId: entry.id },
    })

    return { entry, transactionId }
  })
}

/**
 * Anula el asiento de una operación heredada por su `transactionId`.
 *
 * Es un atajo: `voidEntry` ya deja la `Transaction` en `VOID` dentro de la misma
 * transacción del contra-asiento (QA, criterio 10); esto sólo resuelve el id del
 * asiento a partir de la operación.
 */
export async function voidTransactionPosting(
  organizationId: string,
  transactionId: string,
  reason: string,
  actor: Actor,
  opts: { refDate?: LocalDate } = {}
): Promise<LedgerResult<VoidResult>> {
  const entryId = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const transaction = await tx.transaction.findFirst({ where: { id: transactionId } })
    return transaction?.journalEntryId ?? null
  })
  if (!entryId) {
    return modelFail(modelErr("TRANSACTION_NOT_FOUND", "transactionId", "La operación no tiene asiento que anular"))
  }
  return await voidEntry(organizationId, entryId, reason, actor, opts)
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariantes (§5)
// ─────────────────────────────────────────────────────────────────────────────

export type InvariantRun = {
  validacion: Validacion
  sello: Seal
  /** De dónde salió: `sql` (agregados), `full` (motor puro) o `cache`. */
  origen: "full" | "sql" | "cache"
}

/**
 * Por encima de este número de asientos NO se materializa el diario: los
 * invariantes que se pueden comprobar por agregado (I1, I7) siguen corriendo en
 * SQL y el resto se marca INFO en vez de mentir con un PASS. Es el compromiso
 * del hallazgo #9: nunca `include: { lines: true }` sobre 100.000 asientos.
 */
export const MAX_MATERIALIZED_ENTRIES = 20_000

/** Página de lectura del diario cuando sí se materializa. */
const ENTRY_PAGE_SIZE = 2_000

/**
 * Caché de invariantes por `ledgerHash` (#9).
 *
 * La clave incluye el hash del periodo, así que cualquier cambio en el diario la
 * invalida por construcción: no hace falta purgarla al postear. Vive en memoria
 * del proceso y está acotada; en la práctica sirve para que una misma petición
 * que pinta cabecera de informe + pestaña de auditoría no ejecute dos veces la
 * misma comprobación.
 */
const invariantCache = new Map<string, InvariantRun>()
const INVARIANT_CACHE_MAX = 32

export const clearInvariantCache = (): void => invariantCache.clear()

function cacheGet(key: string): InvariantRun | undefined {
  return invariantCache.get(key)
}

function cachePut(key: string, run: InvariantRun): void {
  if (invariantCache.size >= INVARIANT_CACHE_MAX) {
    const oldest = invariantCache.keys().next().value
    if (oldest !== undefined) invariantCache.delete(oldest)
  }
  invariantCache.set(key, run)
}

/** Lee el diario por páginas, sin un `include` gigante (#9). */
async function readEntriesPaged(
  tx: TenantTransactionClient,
  fiscalYearId: string | undefined,
  total: number
): Promise<PostedEntry[]> {
  const out: PostedEntry[] = []
  for (let skip = 0; skip < total; skip += ENTRY_PAGE_SIZE) {
    const page = await getEntries(tx, fiscalYearId ? { fiscalYearId } : {}, { skip, take: ENTRY_PAGE_SIZE })
    out.push(...page.entries)
    if (page.entries.length === 0) break
  }
  return out
}

/**
 * Ejecuta I1, I7–I10 e I-E3-1…7 sobre los datos REALES de la organización y
 * devuelve `validacion.json` + su sello.
 *
 * I1 e I7 se comprueban SIEMPRE por agregado SQL (baratos y exactos). El resto
 * necesita las líneas: se leen por páginas y sólo hasta
 * `MAX_MATERIALIZED_ENTRIES`; por encima se declaran INFO, que es lo honesto.
 *
 * **No se persiste** (§5 y §8.2-T6): E3 no tiene `ReportRun` —llega en E6— y el
 * sello se recalcula mientras tanto, con la caché por `ledgerHash` de arriba.
 * Quien quiera el fichero lo escribe: `scripts/run-invariants.ts` y
 * `scripts/load-fixture.ts`.
 *
 * I10 se comprueba aquí acotado al tenant (barrera 1); el barrido cross-org que
 * DELATA un cruce sólo puede hacerlo `scripts/run-invariants.ts` como
 * `app_maintenance` (ADR-0009 §6).
 */
export async function runLedgerInvariants(
  organizationId: string,
  opts: {
    refDate: LocalDate
    fiscalYearId?: string
    gitSha?: string
    lastGitSha?: string | null
    runId?: string
    requiredTemplateCoverage?: number
    actor?: Actor
    /** Ignora la caché por `ledgerHash` (los tests de corrupción la necesitan). */
    noCache?: boolean
  }
): Promise<InvariantRun> {
  return await tenantTransaction(organizationId, opts.actor?.userId ?? undefined, async (tx) => {
    const gitSha = opts.gitSha ?? process.env.GIT_SHA ?? "desconocido"
    const hash = await computeLedgerHash(tx, opts.fiscalYearId ? { fiscalYearId: opts.fiscalYearId } : {})
    const cacheKey = `${organizationId}|${opts.fiscalYearId ?? "*"}|${opts.refDate}|${gitSha}|${hash}`

    if (!opts.noCache) {
      const cached = cacheGet(cacheKey)
      if (cached) return { ...cached, origen: "cache" as const }
    }

    // En SERIE, no en paralelo: los tres son `$queryRaw` y dentro de una
    // transacción comparten la ÚNICA conexión. Lanzarlos a la vez hace que el
    // adaptador `pg` avise de «client is already executing a query», aviso que
    // Next reenvía a la consola del navegador y que los e2e tratan —con razón—
    // como un error de servidor.
    const i1 = await checkI1Sql(tx, opts.fiscalYearId)
    const i7 = await checkI7Sql(tx, opts.fiscalYearId)
    const total = await countEntries(tx, opts.fiscalYearId)

    let validacion: Validacion
    let origen: "full" | "sql"

    if (total > MAX_MATERIALIZED_ENTRIES) {
      origen = "sql"
      const skipped = (id: string): CheckResult => ({
        id,
        status: "INFO",
        evidencia: `No evaluado en línea: ${total} asientos superan el límite de ${MAX_MATERIALIZED_ENTRIES}. ` +
          "Ejecuta scripts/run-invariants.ts para el barrido completo",
      })
      validacion = {
        run_id: opts.runId ?? randomUUID(),
        ledgerHash: hash,
        gitSha,
        refDate: opts.refDate,
        organizationId,
        checks: [
          i1,
          i7,
          ...[
            "N-5", "I8", "I9", "I10",
            "I-E3-1", "I-E3-2", "I-E3-3", "I-E3-4", "I-E3-5", "I-E3-6", "I-E3-7",
            // E4: el barrido analítico también materializa las líneas.
            "I4", "I-E4-1", "I-E4-2", "I-E4-3", "I-E4-4", "I-E4-5", "I-E4-6",
            "I-E4-7", "I-E4-8", "I-E4-9", "I-E4-10", "I-E4-11", "I-E4-12",
          ].map(skipped),
        ],
      }
    } else {
      origen = "full"
      const entries = await readEntriesPaged(tx, opts.fiscalYearId, total)
      const fiscalYearRows = await tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
      const periodLocks = await listPeriodLockRefs(tx)
      const accounts = await tx.ledgerAccount.findMany({ select: { code: true, isPostable: true, isActive: true } })

      // E4 · T8: bloque analítico (I4 + los doce `I-E4-*`). El periodo es el
      // del ejercicio pedido o el rango completo, y la configuración se elige
      // por la fecha de fin del periodo (§8.4).
      const analyticFy = opts.fiscalYearId ? fiscalYearRows.find((fy) => fy.id === opts.fiscalYearId) : undefined
      const analyticPeriod = {
        from: analyticFy ? fromUtcDate(analyticFy.startDate) : "0001-01-01",
        to: analyticFy ? fromUtcDate(analyticFy.endDate) : opts.refDate,
        ...(opts.fiscalYearId ? { fiscalYearId: opts.fiscalYearId } : {}),
      }
      const analyticsConfig = await getAnalyticsConfig(tx, { periodEnd: analyticPeriod.to })
      const analyticLines = await getAnalyticLines(tx, analyticPeriod)

      // E5 · T8: las imputaciones VIGENTES del mismo periodo y las reglas con
      // las que se emitieron. En SERIE, como todo lo demás dentro de la
      // transacción (una sola conexión).
      //
      // Importación DINÁMICA a propósito: `models/allocations.ts` importa de
      // este módulo (`LedgerAbort`, `modelErr`, `computeLedgerHash`), y una
      // importación estática cerraría un ciclo cuyo orden de inicialización
      // depende de quién cargue primero. Con el `import()` dentro de la función
      // el ciclo no existe en tiempo de carga.
      const { getAllocationRuleSpecs, getAppliedAllocations, listAllocationRuns } = await import("@/models/allocations")
      const applied = await getAppliedAllocations(tx, { from: analyticPeriod.from, to: analyticPeriod.to })
      // Ronda 2, R2-1: las reglas se leen aunque el periodo no tenga ninguna
      // línea de reparto. Un run revertido deja exactamente ese estado, y su
      // residuo tiene que seguir siendo FAIL.
      const allocationRules = await getAllocationRuleSpecs(tx, { periodEnd: analyticPeriod.to })
      const allocationRuns =
        applied.runIds.length === 0
          ? []
          : (await listAllocationRuns(tx, {})).map((r) => ({
              id: r.id,
              status: r.status as string,
              totalAllocatedCents: r.totalAllocatedCents,
            }))
      // Auditoría E5, hallazgo 2: sin `balances`, `checkI5` recorría un array
      // vacío y la evidencia del PASS lo declaraba («0 combinación(es)»): I5.a
      // no se evaluaba NUNCA en producción. La base liquidable se reconstruye
      // desde el diario y las líneas persistidas —camino independiente del que
      // las produjo—, así que un `UPDATE` sobre `allocation_lines` mueve el
      // repartido y no la base, y la diferencia aparece.
      const allocationContext =
        applied.lines.length === 0 && allocationRules.length === 0
          ? null
          : {
              allocations: applied.lines,
              rules: allocationRules,
              runs: allocationRuns,
              balances: reconstructBalances({
                lines: analyticLines,
                config: analyticsConfig,
                runs: applied.runs,
                allocations: applied.lines,
              }),
              // Auditoría E5, hallazgo 1: I-E5-12 verificable sobre datos.
              runLinesHashes: applied.runs.map((r) => ({ id: r.id, linesHash: r.linesHash })),
            }

      const input: InvariantInput = {
        runId: opts.runId ?? randomUUID(),
        gitSha,
        organizationId,
        ledgerHash: hash,
        entries,
        fiscalYears: fiscalYearRows.map((fy) => ({
          id: fy.id,
          code: fy.code,
          startDate: fromUtcDate(fy.startDate),
          endDate: fromUtcDate(fy.endDate),
          status: fy.status,
          lastEntryNumber: fy.lastEntryNumber,
        })),
        periodLocks,
        accounts: accounts.map((a) => ({ ...a, organizationId })),
        knownTemplateCodes: Object.keys(TEMPLATES),
        ...(opts.requiredTemplateCoverage !== undefined
          ? { requiredTemplateCoverage: opts.requiredTemplateCoverage }
          : {}),
        analytics: { lines: analyticLines, config: analyticsConfig, period: analyticPeriod },
        // E5 · T8: I5 y los doce `I-E5-*`. Se OMITEN sin fallar cuando la
        // organización no ha liquidado nada: no tener imputaciones no es un
        // descuadre, y devolver FAIL por ello sería ruido permanente.
        ...(allocationContext ? { allocations: allocationContext } : {}),
      }
      validacion = runInvariantsPure(input, opts.refDate)

      // I1 e I7 los manda el agregado SQL: ve las MISMAS filas que la BD, no una
      // copia en memoria, y es lo que delata una corrupción por SQL directo.
      validacion.checks = validacion.checks.map((c) => (c.id === "I1" ? i1 : c.id === "I7" ? i7 : c))
    }

    const sello = sealPure(validacion, {
      gitSha,
      ...(opts.lastGitSha !== undefined ? { lastGitSha: opts.lastGitSha } : {}),
    })
    const run: InvariantRun = { validacion, sello, origen }
    if (!opts.noCache) cachePut(cacheKey, run)
    return run
  })
}
