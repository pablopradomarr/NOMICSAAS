/**
 * E7 · T9 — El barrido de invariantes, sellado y persistido
 * (`docs/design/E7-auditoria.md` §4.1).
 *
 * Este módulo **no calcula nada**: lee (agregados en SQL, sin N+1, en serie
 * dentro de una única transacción) y escribe la foto que compone el motor puro
 * de `lib/audit/`. Las tres reglas que gobiernan el fichero:
 *
 *  1. **`invariant_runs` es append-only** (M2): se inserta y no se toca jamás.
 *     `checksHash` viaja con la fila para que I-E7-7 pueda recomputarlo y
 *     delatar un `UPDATE` por SQL directo.
 *  2. **`headline` se DERIVA por SQL del mismo estado que sella el run** (O-19,
 *     ADR-0003): no es una cifra de informe almacenada, es la foto del sello.
 *     Se recalcula en cada barrido y nunca se lee de otro sitio.
 *  3. **La configuración entra en `configHash`** (O-20): bajar un umbral tiene
 *     que invalidar la caché del barrido, o el diff concluiría
 *     `cause: "NINGUNA"` con deltas.
 */

import { centsFromDb } from "@/lib/money"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { cellProvenance } from "@/lib/ledger/provenance"
import type { LocalDate } from "@/lib/ledger/types"
import type {
  AuditConfigSnapshot,
  AuditScopeKind,
  AuditTrigger,
  HeadlineFigures,
  InvariantRunDraft,
  InvariantRunRef,
} from "@/lib/audit/types"
import type {
  AllocationRunIntegrityRef,
  BankReconciliationSummary,
  InvariantRunIntegrityRef,
  ReportRunAllocationRef,
} from "@/lib/audit/invariants-e7"
import type { E7SealReason } from "@/lib/audit/run"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { Prisma, Seal } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Escritura: el run es APPEND-ONLY
// ─────────────────────────────────────────────────────────────────────────────

export type InvariantRunRow = {
  id: string
  scopeKind: AuditScopeKind
  fiscalYearId: string | null
  periodStart: LocalDate | null
  periodEnd: LocalDate | null
  trigger: AuditTrigger
  refDate: LocalDate
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  checksHash: string
  checks: readonly CheckResult[]
  counts: unknown
  coverage: unknown
  headline: HeadlineFigures
  seal: Seal
  sealReasons: unknown
  storeSweepId: string | null
  durationMs: number
  runById: string | null
  createdAt: Date
}

const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

const toRow = (row: {
  id: string
  scopeKind: string
  fiscalYearId: string | null
  periodStart: Date | null
  periodEnd: Date | null
  trigger: string
  refDate: Date
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  checksHash: string
  checks: Prisma.JsonValue
  counts: Prisma.JsonValue
  coverage: Prisma.JsonValue
  headline: Prisma.JsonValue
  seal: Seal
  sealReasons: Prisma.JsonValue
  storeSweepId: string | null
  durationMs: number
  runById: string | null
  createdAt: Date
}): InvariantRunRow => ({
  id: row.id,
  scopeKind: row.scopeKind as AuditScopeKind,
  fiscalYearId: row.fiscalYearId,
  periodStart: row.periodStart ? fromUtcDate(row.periodStart) : null,
  periodEnd: row.periodEnd ? fromUtcDate(row.periodEnd) : null,
  trigger: row.trigger as AuditTrigger,
  refDate: fromUtcDate(row.refDate),
  ledgerHash: row.ledgerHash,
  analyticsKey: row.analyticsKey,
  planHash: row.planHash,
  accountMapHash: row.accountMapHash,
  configHash: row.configHash,
  gitSha: row.gitSha,
  checksHash: row.checksHash,
  checks: (row.checks ?? []) as unknown as readonly CheckResult[],
  counts: row.counts,
  coverage: row.coverage,
  headline: (row.headline ?? {}) as unknown as HeadlineFigures,
  seal: row.seal,
  sealReasons: row.sealReasons,
  storeSweepId: row.storeSweepId,
  durationMs: row.durationMs,
  runById: row.runById,
  createdAt: row.createdAt,
})

/**
 * Persiste la foto. **Recibe el `tx`**, nunca abre transacción propia: el run se
 * escribe en la misma transacción en la que se calculó, o no se escribe.
 */
export async function createInvariantRun(
  tx: TenantTransactionClient,
  draft: InvariantRunDraft
): Promise<InvariantRunRow> {
  const row = await tx.invariantRun.create({
    data: {
      organizationId: tx.$organizationId,
      scopeKind: draft.scopeKind,
      fiscalYearId: draft.fiscalYearId,
      periodStart: draft.periodStart ? toUtcDate(draft.periodStart) : null,
      periodEnd: draft.periodEnd ? toUtcDate(draft.periodEnd) : null,
      trigger: draft.trigger,
      refDate: toUtcDate(draft.refDate),
      ledgerHash: draft.ledgerHash,
      analyticsKey: draft.analyticsKey,
      planHash: draft.planHash,
      accountMapHash: draft.accountMapHash,
      configHash: draft.configHash,
      gitSha: draft.gitSha,
      checksHash: draft.checksHash,
      checks: asJson(draft.checks),
      counts: asJson(draft.counts),
      coverage: asJson({ ...draft.coverage, unknownCheckIds: draft.unknownIds }),
      headline: asJson(draft.headline),
      // El enum de la base es `VALIDADO_AUTOMATICAMENTE`/`REQUIERE_REVISION`; el
      // sello del motor es la cadena con tildes. La traducción vive aquí, en el
      // borde, y en un solo sitio.
      seal: draft.seal.sello === "VALIDADO AUTOMÁTICAMENTE" ? "VALIDADO_AUTOMATICAMENTE" : "REQUIERE_REVISION",
      sealReasons: asJson(draft.sealReasons),
      storeSweepId: draft.storeSweepId,
      durationMs: draft.durationMs,
      runById: draft.runById,
    },
  })
  return toRow(row)
}

export type InvariantRunFilter = {
  scopeKind?: AuditScopeKind
  fiscalYearId?: string
  take?: number
  cursor?: string
}

export async function listInvariantRuns(db: AnyClient, filter: InvariantRunFilter = {}): Promise<InvariantRunRow[]> {
  const rows = await db.invariantRun.findMany({
    where: {
      ...(filter.scopeKind ? { scopeKind: filter.scopeKind } : {}),
      ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: filter.take ?? 50,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  })
  return rows.map(toRow)
}

export async function getInvariantRun(db: AnyClient, id: string): Promise<InvariantRunRow | null> {
  const row = await db.invariantRun.findFirst({ where: { id } })
  return row ? toRow(row) : null
}

export async function latestInvariantRun(
  db: AnyClient,
  filter: Omit<InvariantRunFilter, "take" | "cursor"> = {}
): Promise<InvariantRunRow | null> {
  const [row] = await listInvariantRuns(db, { ...filter, take: 1 })
  return row ?? null
}

/** La forma que consume `diffRuns` (§3.3). */
export const toRunRef = (row: InvariantRunRow): InvariantRunRef => ({
  id: row.id,
  createdAt: row.createdAt.toISOString(),
  gitSha: row.gitSha,
  ledgerHash: row.ledgerHash,
  analyticsKey: row.analyticsKey,
  planHash: row.planHash,
  accountMapHash: row.accountMapHash,
  configHash: row.configHash,
  checks: row.checks,
  headline: row.headline,
})

/**
 * Los N últimos runs con lo que I-E7-7 necesita para recomputar su `checksHash`.
 * No lee `counts` ni `headline`: el invariante mira la firma de los checks.
 */
export async function listInvariantRunIntegrityRefs(
  db: AnyClient,
  take = 20
): Promise<InvariantRunIntegrityRef[]> {
  const rows = await db.invariantRun.findMany({
    select: { id: true, checksHash: true, checks: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take,
  })
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    checksHash: r.checksHash,
    checks: (r.checks ?? []) as unknown as readonly CheckResult[],
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// `headline` — las cuatro cifras, por AGREGADO SQL (O-19)
// ─────────────────────────────────────────────────────────────────────────────

const HEADLINE_QUERY =
  "SELECT a.statement, l.entry_kind, l.account_code, SUM(l.debit_cents - l.credit_cents) " +
  "FROM journal_lines l JOIN accounts a ON a.organization_id = l.organization_id AND a.code = l.account_code " +
  "WHERE l.organization_id = $1 AND l.entry_date <= $2 AND l.entry_kind <> 'CLOSING' GROUP BY 1, 2, 3"

type HeadlineRow = { activo: bigint; pn_mas_pasivo: bigint; resultado: bigint; tesoreria: bigint }

/**
 * Las cuatro cifras del cierre, derivadas del MISMO diario que sella el run.
 *
 * · **Activo** y **PN + pasivo**: acumulados hasta la fecha de corte con
 *   `kind ∉ {CLOSING}` — la MISMA foto `PRE_REGULARIZACION` que sella el
 *   balance de E6, no una segunda definición. Es el hallazgo **H-2 (ALTA)** de
 *   la auditoría de E7: incluir el asiento de cierre dejaba las dos cifras en
 *   **0,00 €** justo el 31-12, que es el día en que se firman, y hacía que
 *   `I2` («Activo = PN + Pasivo») se cumpliera trivialmente (0 = 0) y que el
 *   diff de O-19 no moviera nunca dos de sus cuatro cifras. La apertura **sí**
 *   entra: una apertura es saldo; un cierre es su cancelación.
 * · **Resultado**: sólo el periodo, y **excluyendo `CLOSING`, `OPENING` y
 *   `REGULARIZATION`** — es la definición de I3, escrita una vez.
 * · **Tesorería**: las 57x hasta el corte, sin el asiento de cierre.
 *
 * Un agregado, una pasada, sin materializar el diario (§8).
 */
export async function headlineFigures(
  tx: TenantTransactionClient,
  opts: {
    from: LocalDate
    to: LocalDate
    fiscalYearId?: string | null
    ledgerHash: string
    runId: string
    gitSha: string
    baseCurrency: string
  }
): Promise<HeadlineFigures> {
  const organizationId = tx.$organizationId
  const fiscalYearId = opts.fiscalYearId ?? null
  const rows = await tx.$queryRaw<HeadlineRow[]>`
    SELECT
      COALESCE(SUM(CASE WHEN a.statement = 'BALANCE_ACTIVO' AND l.entry_kind <> 'CLOSING'
                        THEN l.debit_cents - l.credit_cents END), 0)::bigint AS activo,
      COALESCE(SUM(CASE WHEN a.statement IN ('BALANCE_PASIVO', 'BALANCE_PN') AND l.entry_kind <> 'CLOSING'
                        THEN l.credit_cents - l.debit_cents END), 0)::bigint AS pn_mas_pasivo,
      COALESCE(SUM(CASE WHEN a.statement = 'PYG'
                         AND l.entry_date >= ${toUtcDate(opts.from)}::date
                         AND l.entry_kind NOT IN ('CLOSING', 'OPENING', 'REGULARIZATION')
                        THEN l.credit_cents - l.debit_cents END), 0)::bigint AS resultado,
      COALESCE(SUM(CASE WHEN left(l.account_code, 2) = '57' AND l.entry_kind <> 'CLOSING'
                        THEN l.debit_cents - l.credit_cents END), 0)::bigint AS tesoreria
      FROM journal_lines l
      JOIN accounts a ON a.organization_id = l.organization_id AND a.code = l.account_code
     WHERE l.organization_id = ${organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.to)}::date
       AND (${fiscalYearId}::uuid IS NULL OR l.fiscal_year_id = ${fiscalYearId}::uuid)`

  const row = rows[0] ?? { activo: BigInt(0), pn_mas_pasivo: BigInt(0), resultado: BigInt(0), tesoreria: BigInt(0) }
  const figure = (metrica: string, cents: number) => ({
    cents,
    provenance: cellProvenance(
      metrica,
      cents,
      {
        organizationId,
        from: opts.from,
        to: opts.to,
        ...(fiscalYearId ? { fiscalYearId } : {}),
        query: HEADLINE_QUERY,
      },
      {
        runId: opts.runId,
        ledgerHash: opts.ledgerHash,
        gitSha: opts.gitSha,
        baseCurrency: opts.baseCurrency,
        module: "models/audit.ts",
      }
    ),
  })

  return {
    ACTIVO: figure("headline.activo", centsFromDb(row.activo, "activo")),
    PN_MAS_PASIVO: figure("headline.pn_mas_pasivo", centsFromDb(row.pn_mas_pasivo, "PN + pasivo")),
    RESULTADO: figure("headline.resultado", centsFromDb(row.resultado, "resultado")),
    TESORERIA: figure("headline.tesoreria", centsFromDb(row.tesoreria, "tesorería")),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `configHash` — TODA la configuración que puede mover un check (O-20)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La foto de la configuración. Incluye, por cuenta bancaria y **no en global**,
 * los tres umbrales de conciliación: son configuración editable y su cambio
 * tiene que invalidar la caché del barrido aunque no mueva un dato (criterio 23).
 */
export async function auditConfigSnapshot(
  tx: TenantTransactionClient,
  opts: { warnThreshold: number; forceReview: boolean; maxMaterializedEntries: number }
): Promise<AuditConfigSnapshot> {
  const organization = await tx.organization.findFirstOrThrow({ select: { pgcVariant: true } })
  const accounts = await tx.bankAccount.findMany({
    select: { code: true, matchToleranceDays: true, transitWarnDays: true },
    orderBy: { code: "asc" },
  })
  return {
    warnThreshold: opts.warnThreshold,
    maxMaterializedEntries: opts.maxMaterializedEntries,
    planVariant: organization.pgcVariant,
    matchToleranceDays: Object.fromEntries(accounts.map((a) => [a.code, a.matchToleranceDays])),
    transitWarnDays: Object.fromEntries(accounts.map((a) => [a.code, a.transitWarnDays])),
    forceReview: opts.forceReview,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deuda de E5: I-E7-9 e I-E7-10
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los `AllocationRun` sellados, con su `linesHash` sellado y el **recomputado
 * hoy** sobre sus líneas. Con los dos, I-E7-9 cuenta los que nacieron sin sello
 * e I-E7-10 delata una `allocation_lines` alterada bajo un `ReportRun` vigente.
 *
 * El recomputo se hace **con la función de la aplicación** (`linesHash` de
 * `lib/analytics/hash`), nunca con una segunda implementación en SQL: ésa es la
 * deriva que ADR-0011 corrigió.
 */
export async function listAllocationRunIntegrityRefs(
  tx: TenantTransactionClient
): Promise<AllocationRunIntegrityRef[]> {
  const { listAllocationRunsWithLinesHash } = await import("@/models/allocations")
  return await listAllocationRunsWithLinesHash(tx)
}

export type { InvariantRunIntegrityRef, ReportRunAllocationRef }

// ─────────────────────────────────────────────────────────────────────────────
// El bloque E7 del barrido: I-E7-1…17 sobre datos reales
// ─────────────────────────────────────────────────────────────────────────────

export type AuditBlockOptions = {
  refDate: LocalDate
  /** Periodo auditado. El cuadre bancario corta por `to` (fecha de operación). */
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string | null
  baseCurrency: string
  /** `to` es cierre de ejercicio: I-E7-16 pasa de WARN a FAIL. */
  isFiscalYearEnd?: boolean
}

export type AuditBlock = {
  checks: CheckResult[]
  /** Los cuatro motivos propios de E7, ya decididos por el borde (§5.3). */
  reasons: E7SealReason[]
  /** Bloques evaluados y bloques declarados INFO, con su motivo. */
  coverage: { evaluated: string[]; skipped: { block: string; reason: string }[] }
  storeSweepId: string | null
  /** El cuadre por cuenta, que la pantalla reutiliza sin recalcular. */
  summaries: BankReconciliationSummary[]
}

/**
 * Corre **I-E7-1…17** sobre los datos de la organización. Lecturas **en serie**
 * (una sola conexión dentro de la transacción) y agregadas: ninguna consulta
 * por cuenta bancaria, ninguna por liquidación.
 *
 * Un sub-bloque que no se puede leer no se inventa: se omite y el motor lo
 * declara `INFO` diciendo qué falta. Nunca un PASS sin comprobar (§3.5).
 */
export async function auditBlock(tx: TenantTransactionClient, opts: AuditBlockOptions): Promise<AuditBlock> {
  const { readBankInvariantInput } = await import("@/models/bank")
  const { readStoreCoverage } = await import("@/models/store-sweep")
  const { listStaleAllocationBackedRuns } = await import("@/models/reports")
  const { getLinesForPeriod, listFiscalYearRefs } = await import("@/models/ledger")
  const { runAuditInvariants, reconciliationSummary, nextDay: nextDayOf } = await import("@/lib/audit/invariants-e7")

  const evaluated: string[] = []
  const skipped: { block: string; reason: string }[] = []

  const bank = await readBankInvariantInput(tx, {
    cutoff: opts.to,
    baseCurrency: opts.baseCurrency,
    ...(opts.isFiscalYearEnd ? { isFiscalYearEnd: true } : {}),
  })
  if (bank === null) skipped.push({ block: "bank", reason: "la organización no tiene cuentas bancarias declaradas" })
  else evaluated.push("bank")

  const store = await readStoreCoverage(tx)
  evaluated.push("store")

  const allocationRuns = await listAllocationRunIntegrityRefs(tx)
  evaluated.push("allocationRuns")

  const reportRuns = await listStaleAllocationBackedRuns(tx)
  evaluated.push("reportRuns")

  const runs = await listInvariantRunIntegrityRefs(tx)
  evaluated.push("invariantRuns")

  const fiscalYears = await listFiscalYearRefs(tx)
  const lines = await getLinesForPeriod(tx, {
    // La continuidad entre ejercicios (I-E7-14) necesita el ejercicio ANTERIOR:
    // acotar a `from` dejaría el saldo de apertura sin contra el que cuadrar.
    from: "0001-01-01",
    to: opts.to,
  })
  /**
   * **H-6 de la auditoría.** I-E7-14 compara el cierre de N con la APERTURA de
   * N+1, y esa apertura está fechada **después** del corte: en el alcance
   * `FISCAL_YEAR` —el alcance con el que se sella un ejercicio, justo cuando la
   * continuidad importa— la lectura anterior no la traía nunca y el invariante
   * salía `INFO · ningún ejercicio con asiento de apertura`. Se añade una
   * segunda lectura **acotada a `OPENING`** posterior al corte: son unas pocas
   * decenas de líneas, no mueve ningún otro check (I-E7-15/16 filtran por
   * `entryDate <= to` e I-E7-17 por `[from, to]`) y hace que I-E7-14 se pueda
   * evaluar de verdad.
   */
  const laterOpenings = await getLinesForPeriod(tx, {
    from: nextDayOf(opts.to),
    to: "9999-12-31",
    kinds: ["OPENING"],
  })
  evaluated.push("closing")

  const checks = runAuditInvariants({
    ...(bank ? { bank } : {}),
    runs,
    store,
    allocationRuns,
    reportRuns,
    closing: {
      lines: [...lines, ...laterOpenings],
      fiscalYears: fiscalYears.map((fy) => ({ id: fy.id, startDate: fy.startDate, endDate: fy.endDate })),
      from: opts.from,
      to: opts.to,
      ...(opts.isFiscalYearEnd ? { isFiscalYearEnd: true } : {}),
      accountsWithCreditFacility: [],
    },
  })

  const summaries = bank === null ? [] : bank.accounts.map((account) => reconciliationSummary(account, bank))
  const reasons: E7SealReason[] = []
  if (summaries.some((s) => s.pendientesBanco.length > 0 || s.pendientesLibros.length > 0)) {
    reasons.push("CONCILIACION_PENDIENTE")
  }
  if (summaries.some((s) => s.pendientesAntiguos.length > 0)) reasons.push("PARTIDA_EN_TRANSITO_ANTIGUA")
  if (checks.some((c) => c.id === "I-E7-12" && c.status === "WARN")) reasons.push("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")
  if (checks.some((c) => c.id === "I-E7-8" && (c.status === "FAIL" || c.status === "WARN"))) {
    reasons.push("ALMACEN_NO_BARRIDO")
  }

  return {
    checks,
    reasons,
    coverage: { evaluated, skipped },
    storeSweepId: store.lastSweep?.id ?? null,
    summaries,
  }
}
