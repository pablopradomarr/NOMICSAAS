/**
 * E9 · T12 — El cierre como acto: lecturas compuestas y `ClosingRun` sellado
 * (`docs/design/E9-cierre-recurrentes.md` §4.6, §4.8 y §5.1).
 *
 * Tres cosas viven aquí y ninguna calcula nada contable:
 *
 *  1. **`readFxPositions`** — la generalización de `readFxCloses` de E7,
 *     **acotada por `LedgerAccount.isMonetary`** (O-4). NRV 11ª.2.2: sólo las
 *     partidas **monetarias** se convierten a tipo de cierre. Sin el atributo,
 *     `original_currency IS NOT NULL` arrastraba `407` y `438` —anticipos, que
 *     **no** son monetarios— e **inventaba resultado**. `readFxCloses` sigue
 *     donde estaba, alimentando I-E7-12 por cuenta bancaria.
 *  2. **`readMaturityPositions`** — saldo vivo por `(cuenta, contraparte,
 *     divisa)` con sus vencimientos, más **las posiciones de `17x`/`52x` sin
 *     desglose** (O-6), que son un **FAIL bloqueante** y no una nota.
 *  3. **`readClosingInput`** — todo lo que los 41 pasos necesitan, en **UNA**
 *     transacción y con las lecturas **en serie** (§9: techo de 2 000 ms). Y el
 *     `ClosingRun`, que es append-only salvo las columnas que el `GRANT UPDATE`
 *     de M4 deja tocar.
 */

import { createHash } from "node:crypto"

import type { AccrualRow } from "@/models/accruals"
import { readAccrualBalances, readAccruals } from "@/models/accruals"
import type { AssetWithRevisions } from "@/models/assets"
import { assetsWithoutAttribution, readAssetsWithRevisions, readCapitalGoods, type CapitalGoodRow } from "@/models/assets"
import type { ChecklistInput, InvariantSnapshot, ManualAnswer } from "@/lib/closing/checklist"
import { duePeriods } from "@/lib/recurring/schedule"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import { centsFromDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import type { MaturityRow, PositionWithoutScheduleRow } from "@/models/debt"
import { readMaturities, readPositionsWithoutSchedule } from "@/models/debt"
import { e9Abort } from "@/models/e9-errors"
import { readRecurringDue, type RecurringDueRow } from "@/models/recurring"
import type { ClosingRunStatus, Seal } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// O-4 · diferencias de cambio sobre partidas MONETARIAS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una posición en divisa por `(cuenta, contraparte, divisa)`, con su
 * contravalor histórico en moneda base, su importe en divisa y la **tasa de
 * cierre efectiva**.
 */
export type FxPositionRow = {
  accountCode: string
  counterpartyId: string | null
  currency: string
  /** `S` — Σ contravalores históricos en moneda base (debe − haber). */
  baseBalanceCents: Cents
  /** `D` — Σ importes en la divisa original (debe − haber). */
  originalBalanceCents: Cents
  /** Tasa `divisa → base` × 10⁶ de la mayor `rateDate ≤ corte` dentro de la ventana. */
  rateMicro: bigint | null
  /** **O-5.** La `rateDate` EFECTIVA, que se sella en T-30 y se enseña. */
  rateDate: LocalDate | null
  /** Lo ya reconocido en `668`/`768` por asientos que tocan esta posición. */
  recognizedDifferenceCents: Cents
}

/** Ventana declarada de búsqueda de la tasa de cierre (O-5): siete días. */
export const FX_RATE_WINDOW_DAYS = 7

/**
 * **O-4 + O-5.** Posiciones monetarias en divisa al corte.
 *
 * · El universo lo fija **`accounts.is_monetary`**, un dato del plan sembrado
 *   desde `seeds/npgc.csv` y editable con `AuditLog`, **nunca una lista en el
 *   motor** (I-E9-24).
 * · La tasa es **la de mayor `rate_date ≤ corte`** dentro de una ventana
 *   declarada. Con el 31-12 en sábado no había tasa publicada y el cierre no
 *   avanzaba; ahora se usa la del viernes, **se sella y se enseña**. Sin
 *   ninguna en la ventana, la posición sale con `rateMicro = null` y el paso es
 *   FAIL (criterio 21), no un cero silencioso.
 *
 * Una consulta para todas las posiciones de la organización: nada de una por
 * cuenta.
 */
export async function readFxPositions(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; baseCurrency: string; windowDays?: number }
): Promise<FxPositionRow[]> {
  const base = opts.baseCurrency.toUpperCase()
  const windowDays = opts.windowDays ?? FX_RATE_WINDOW_DAYS
  const rows = await tx.$queryRaw<
    {
      account_code: string
      counterparty_id: string | null
      currency: string
      base_balance_cents: bigint
      original_balance_cents: bigint
      rate_micro: bigint | null
      rate_date: Date | null
      recognized_cents: bigint
    }[]
  >`
    WITH posiciones AS (
      SELECT l.account_code,
             l.counterparty_id,
             upper(l.original_currency) AS currency,
             SUM(l.debit_cents - l.credit_cents)::bigint                   AS base_balance_cents,
             SUM(CASE WHEN l.debit_cents > 0 THEN l.original_amount_cents
                      ELSE -l.original_amount_cents END)::bigint           AS original_balance_cents
        FROM journal_lines l
        JOIN accounts a
          ON a.organization_id = l.organization_id AND a.code = l.account_code
       WHERE l.organization_id = ${tx.$organizationId}::uuid
         AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
         AND l.entry_kind <> 'CLOSING'
         AND l.original_currency IS NOT NULL
         AND upper(l.original_currency) <> ${base}
         -- **O-4 / I-E9-24**: el universo lo fija el PLAN, no el motor.
         AND a.is_monetary = TRUE
       GROUP BY l.account_code, l.counterparty_id, upper(l.original_currency)
      HAVING SUM(l.debit_cents - l.credit_cents) <> 0
          OR SUM(CASE WHEN l.debit_cents > 0 THEN l.original_amount_cents ELSE -l.original_amount_cents END) <> 0
    )
    SELECT p.*,
           t.rate_micro, t.date AS rate_date,
           COALESCE((
             SELECT SUM(d.credit_cents - d.debit_cents)
               FROM journal_lines d
              WHERE d.organization_id = ${tx.$organizationId}::uuid
                AND (left(d.account_code, 3) = '768' OR left(d.account_code, 3) = '668')
                AND d.entry_date <= ${toUtcDate(opts.cutoff)}::date
                AND d.entry_kind <> 'CLOSING'
                AND EXISTS (
                  SELECT 1 FROM journal_lines b
                   WHERE b.organization_id = d.organization_id
                     AND b.entry_id = d.entry_id
                     AND b.account_code = p.account_code
                     AND b.counterparty_id IS NOT DISTINCT FROM p.counterparty_id
                )
           ), 0)::bigint AS recognized_cents
      FROM posiciones p
      LEFT JOIN LATERAL (
        SELECT r.rate_micro, r.date
          FROM exchange_rates r
         WHERE r."from" = p.currency AND r."to" = ${base}
           AND r.date <= ${toUtcDate(opts.cutoff)}::date
           AND r.date >  (${toUtcDate(opts.cutoff)}::date - make_interval(days => ${windowDays}))
         ORDER BY r.date DESC
         LIMIT 1
      ) t ON TRUE
     ORDER BY p.account_code, p.currency`

  return rows.map((r) => ({
    accountCode: r.account_code,
    counterpartyId: r.counterparty_id,
    currency: r.currency,
    baseBalanceCents: centsFromDb(r.base_balance_cents, "contravalor histórico"),
    originalBalanceCents: centsFromDb(r.original_balance_cents, "saldo en divisa"),
    rateMicro: r.rate_micro,
    rateDate: r.rate_date ? fromUtcDate(r.rate_date) : null,
    recognizedDifferenceCents: centsFromDb(r.recognized_cents, "diferencia de cambio reconocida"),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// O-6 · reclasificación: posiciones y vencimientos
// ─────────────────────────────────────────────────────────────────────────────

export type ReclassificationPairRow = {
  longAccountCode: string
  shortAccountCode: string
  thresholdMonths: number
}

export async function readReclassificationPairs(db: AnyClient): Promise<ReclassificationPairRow[]> {
  const rows = await db.reclassificationPair.findMany({ where: { isActive: true }, orderBy: { longAccountCode: "asc" } })
  return rows.map((r) => ({
    longAccountCode: r.longAccountCode,
    shortAccountCode: r.shortAccountCode,
    thresholdMonths: r.thresholdMonths,
  }))
}

/** Saldo vivo por `(cuenta, contraparte, divisa)` con su vencimiento declarado. */
export type MaturityPositionRow = {
  accountCode: string
  counterpartyId: string | null
  currency: string | null
  dueDate: LocalDate | null
  balanceCents: Cents
}

/**
 * **O-6.** Saldos vivos de las cuentas de los pares de reclasificación, por
 * contraparte, divisa **y vencimiento**, agregados en SQL. Con `dueDate = null`
 * la posición **no se reclasifica y se nombra**: I-E9-16 exige que toda posición
 * reclasificada tenga vencimiento, y adivinarlo está prohibido.
 */
export async function readMaturityPositions(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; accountCodes: readonly string[] }
): Promise<MaturityPositionRow[]> {
  const codes = [...opts.accountCodes]
  if (codes.length === 0) return []
  const rows = await tx.$queryRaw<
    { account_code: string; counterparty_id: string | null; currency: string | null; due_date: Date | null; balance_cents: bigint }[]
  >`
    SELECT l.account_code, l.counterparty_id, upper(l.original_currency) AS currency, l.due_date,
           SUM(l.credit_cents - l.debit_cents)::bigint AS balance_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
       AND l.entry_kind <> 'CLOSING'
       AND l.account_code = ANY(${codes}::text[])
     GROUP BY l.account_code, l.counterparty_id, upper(l.original_currency), l.due_date
    HAVING SUM(l.credit_cents - l.debit_cents) <> 0
     ORDER BY l.account_code, l.due_date NULLS FIRST`
  return rows.map((r) => ({
    accountCode: r.account_code,
    counterpartyId: r.counterparty_id,
    currency: r.currency,
    dueDate: r.due_date ? fromUtcDate(r.due_date) : null,
    balanceCents: centsFromDb(r.balance_cents, "posición viva"),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Saldos por cuenta (la materia prima de I-E9-12/13/21 y del capital social)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saldos por cuenta al corte, **agregados en SQL** y con el signo natural que
 * cada llamante pida: `credit − debit` es el de las cuentas de patrimonio y
 * pasivo (y el que `capitalStockOf` espera para `100`).
 */
export async function readAccountBalances(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; prefixes?: readonly string[]; sign?: "DEUDOR" | "ACREEDOR"; includeClosing?: boolean }
): Promise<Map<string, Cents>> {
  const prefixes = opts.prefixes ? [...opts.prefixes] : null
  const acreedor = (opts.sign ?? "ACREEDOR") === "ACREEDOR"
  const rows = await tx.$queryRaw<{ account_code: string; balance_cents: bigint }[]>`
    SELECT l.account_code,
           SUM(CASE WHEN ${acreedor} THEN l.credit_cents - l.debit_cents ELSE l.debit_cents - l.credit_cents END)::bigint
             AS balance_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
       AND (${opts.includeClosing === true} OR l.entry_kind <> 'CLOSING')
       AND (${prefixes}::text[] IS NULL
            OR EXISTS (SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE l.account_code LIKE p || '%'))
     GROUP BY l.account_code
     ORDER BY l.account_code`
  return new Map(rows.map((r) => [r.account_code, centsFromDb(r.balance_cents, `saldo de ${r.account_code}`)]))
}

// ─────────────────────────────────────────────────────────────────────────────
// readClosingInput — TODO lo que los 41 pasos necesitan, en UNA transacción
// ─────────────────────────────────────────────────────────────────────────────

export type ClosingInput = {
  organizationId: string
  fiscalYearId: string
  fiscalYearCode: string
  refDate: LocalDate
  baseCurrency: string
  recurring: RecurringDueRow[]
  assets: AssetWithRevisions[]
  assetsWithoutAttribution: { id: string; code: string }[]
  capitalGoods: CapitalGoodRow[]
  accruals: AccrualRow[]
  accrualBalances: { accountCode: string; balanceCents: Cents }[]
  maturities: MaturityRow[]
  positionsWithoutSchedule: PositionWithoutScheduleRow[]
  reclassificationPairs: ReclassificationPairRow[]
  maturityPositions: MaturityPositionRow[]
  fxPositions: FxPositionRow[]
  /** Saldos acreedores de todas las cuentas al corte: `100`, `112`, `129`… */
  balances: Map<string, Cents>
}

/**
 * **§9 · una transacción, lecturas en serie, sin N+1.**
 *
 * Nada de `Promise.all`: dentro de una transacción todas las lecturas comparten
 * **una** conexión, `pg` las encola igualmente y además emite el aviso «client
 * is already executing a query» (lección de E6). Diez lecturas en serie, cada
 * una con su agregado en SQL, caben de sobra en los 2 000 ms del techo.
 */
export async function readClosingInput(
  tx: TenantTransactionClient,
  opts: { fiscalYearId: string; refDate: LocalDate; baseCurrency: string; capitalGoodsWindowYears?: number }
): Promise<ClosingInput> {
  const fy = await tx.fiscalYear.findFirst({ where: { id: opts.fiscalYearId }, select: { id: true, code: true } })
  if (!fy) e9Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización")

  const recurring = await readRecurringDue(tx, { includeInactive: true })
  const assets = await readAssetsWithRevisions(tx, { cutoff: opts.refDate })
  const sinAtribucion = await assetsWithoutAttribution(tx)
  const windowYears = opts.capitalGoodsWindowYears ?? 9
  const capitalGoods = await readCapitalGoods(tx, {
    from: `${Number(opts.refDate.slice(0, 4)) - windowYears}-01-01`,
    to: opts.refDate,
  })
  const accruals = await readAccruals(tx, { liveAt: opts.refDate })
  const accrualBalances = await readAccrualBalances(tx, { cutoff: opts.refDate })
  const maturities = await readMaturities(tx, { cutoff: opts.refDate })
  const positionsWithoutSchedule = await readPositionsWithoutSchedule(tx, { cutoff: opts.refDate })
  const pairs = await readReclassificationPairs(tx)
  const maturityPositions = await readMaturityPositions(tx, {
    cutoff: opts.refDate,
    accountCodes: [...new Set(pairs.flatMap((p) => [p.longAccountCode, p.shortAccountCode]))],
  })
  const fxPositions = await readFxPositions(tx, { cutoff: opts.refDate, baseCurrency: opts.baseCurrency })
  const balances = await readAccountBalances(tx, { cutoff: opts.refDate })

  return {
    organizationId: tx.$organizationId,
    fiscalYearId: fy.id,
    fiscalYearCode: fy.code,
    refDate: opts.refDate,
    baseCurrency: opts.baseCurrency,
    recurring,
    assets,
    assetsWithoutAttribution: sinAtribucion,
    capitalGoods,
    accruals,
    accrualBalances,
    maturities,
    positionsWithoutSchedule,
    reclassificationPairs: pairs,
    maturityPositions,
    fxPositions,
    balances,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ClosingRun — append-only salvo las columnas del GRANT UPDATE de M4
// ─────────────────────────────────────────────────────────────────────────────

/** Un paso del checklist, tal cual se persiste en `closing_runs.steps` (O-29). */
export type ClosingStepRecord = {
  step: string
  block: string
  status: "PASS" | "WARN" | "FAIL" | "NA" | "PENDIENTE_RECOMPUTO" | "INFO"
  blocking: boolean
  evidencia: string
  query?: string
  entryId?: string | null
  sealReason?: string
  /** Respuesta humana a un paso declarado (arqueo, existencias, diferido…). */
  answer?: ManualAnswer
}

export type ClosingRunRow = {
  id: string
  fiscalYearId: string
  status: ClosingRunStatus
  refDate: LocalDate
  steps: ClosingStepRecord[]
  ledgerHash: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  seal: Seal
  sealReasons: string[]
  durationMs: number
  closedAt: Date | null
  reopenedAt: Date | null
  createdAt: Date
}

/**
 * sha256 canónico de los pasos: **el veredicto es recomputable** (I-E9-20). Se
 * ordena por `step` antes de serializar, para que dos ejecuciones que evalúan lo
 * mismo en distinto orden den el mismo hash.
 */
export function stepsHashOf(steps: readonly ClosingStepRecord[]): string {
  const canonical = [...steps]
    .sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0))
    .map((s) => `${s.step}|${s.status}|${s.blocking ? 1 : 0}|${s.evidencia}`)
    .join("\n")
  return createHash("sha256").update(canonical).digest("hex")
}

const toRunRow = (r: {
  id: string
  fiscalYearId: string
  status: ClosingRunStatus
  refDate: Date
  steps: unknown
  ledgerHash: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  seal: Seal
  sealReasons: unknown
  durationMs: number
  closedAt: Date | null
  reopenedAt: Date | null
  createdAt: Date
}): ClosingRunRow => ({
  id: r.id,
  fiscalYearId: r.fiscalYearId,
  status: r.status,
  refDate: fromUtcDate(r.refDate),
  steps: Array.isArray(r.steps) ? (r.steps as ClosingStepRecord[]) : [],
  ledgerHash: r.ledgerHash,
  planHash: r.planHash,
  accountMapHash: r.accountMapHash,
  configHash: r.configHash,
  gitSha: r.gitSha,
  seal: r.seal,
  sealReasons: Array.isArray(r.sealReasons) ? (r.sealReasons as string[]) : [],
  durationMs: r.durationMs,
  closedAt: r.closedAt,
  reopenedAt: r.reopenedAt,
  createdAt: r.createdAt,
})

export type ClosingRunInput = {
  fiscalYearId: string
  refDate: LocalDate
  steps: readonly ClosingStepRecord[]
  ledgerHash: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
  invariantRunId?: string | null
  seal: Seal
  sealReasons: readonly string[]
  durationMs: number
  status?: ClosingRunStatus
}

/** Crea el run. **Append-only**: nace con su sello y no se reescribe la historia. */
export async function createClosingRunTx(
  tx: TenantTransactionClient,
  input: ClosingRunInput,
  actor: Actor
): Promise<ClosingRunRow> {
  const row = await tx.closingRun.create({
    data: {
      organizationId: tx.$organizationId,
      fiscalYearId: input.fiscalYearId,
      status: input.status ?? "BORRADOR",
      refDate: toUtcDate(input.refDate),
      steps: input.steps as never,
      ledgerHash: input.ledgerHash,
      planHash: input.planHash,
      accountMapHash: input.accountMapHash,
      configHash: input.configHash,
      gitSha: input.gitSha,
      invariantRunId: input.invariantRunId ?? null,
      seal: input.seal,
      sealReasons: [...input.sealReasons] as never,
      durationMs: input.durationMs,
    },
  })
  await writeAuditLog(tx, {
    entity: "ClosingRun",
    entityId: row.id,
    action: "create",
    after: {
      fiscalYearId: input.fiscalYearId,
      refDate: input.refDate,
      status: row.status,
      seal: input.seal,
      sealReasons: [...input.sealReasons],
      stepsHash: stepsHashOf(input.steps),
      ledgerHash: input.ledgerHash,
    },
    userId: actor.userId ?? null,
  })
  return toRunRow(row)
}

/**
 * Actualiza **sólo** lo que el `GRANT UPDATE` de columna permite (`status`,
 * `steps`, `seal`, `sealReasons`, los ids de los doce asientos y las columnas de
 * reapertura), patrón de `journal_entries.voided_*`. Cualquier otra columna se
 * queda como nació: un `ledgerHash` reescrito convertiría el sello en adorno.
 */
export async function updateClosingRunTx(
  tx: TenantTransactionClient,
  input: {
    id: string
    status?: ClosingRunStatus
    steps?: readonly ClosingStepRecord[]
    seal?: Seal
    sealReasons?: readonly string[]
    entryIds?: Partial<{
      reccAccrualEntryId: string
      prorrataEntryId: string
      vatSettlementEntryId: string
      presentValueEntryId: string
      fxEntryId: string
      reclassEntryId: string
      incomeTaxEntryId: string
      regularizacionEntryId: string
      cierreEntryId: string
      aperturaEntryId: string
      reclassReversalEntryId: string
    }>
    recurringEntryIds?: readonly string[]
    closedAt?: Date | null
    closedById?: string | null
    reopen?: { at: Date; byId: string | null; reason: string; entryIds: readonly string[] }
  },
  actor: Actor
): Promise<ClosingRunRow> {
  const before = await tx.closingRun.findFirst({ where: { id: input.id } })
  if (!before) e9Abort("CLOSING_RUN_NOT_FOUND", "id", "El cierre no existe en esta organización")
  if (before.status === "CERRADO" && input.reopen === undefined && input.status !== "REABIERTO") {
    e9Abort(
      "CLOSING_RUN_SEALED",
      "id",
      "Un cierre CERRADO no se edita: reabrir el ejercicio son cuatro contra-asientos (T-28, T-27, T-26 y T-25)"
    )
  }

  const row = await tx.closingRun.update({
    where: { id: input.id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.steps ? { steps: input.steps as never } : {}),
      ...(input.seal ? { seal: input.seal } : {}),
      ...(input.sealReasons ? { sealReasons: [...input.sealReasons] as never } : {}),
      ...(input.recurringEntryIds ? { recurringEntryIds: [...input.recurringEntryIds] as never } : {}),
      ...(input.entryIds ?? {}),
      ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
      ...(input.closedById !== undefined ? { closedById: input.closedById } : {}),
      ...(input.reopen
        ? {
            reopenedAt: input.reopen.at,
            reopenedById: input.reopen.byId,
            reopenReason: input.reopen.reason,
            reopenEntryIds: [...input.reopen.entryIds] as never,
          }
        : {}),
    },
  })

  await writeAuditLog(tx, {
    entity: "ClosingRun",
    entityId: input.id,
    action: input.reopen ? "REOPEN" : input.closedAt ? "close" : "POST_CLOSING_STEP",
    before: { status: before.status, seal: before.seal },
    after: {
      status: row.status,
      seal: row.seal,
      ...(input.steps ? { stepsHash: stepsHashOf(input.steps) } : {}),
      ...(input.entryIds ?? {}),
      ...(input.reopen ? { reopenEntryIds: [...input.reopen.entryIds] } : {}),
    },
    reason: input.reopen?.reason ?? null,
    userId: actor.userId ?? null,
  })
  return toRunRow(row)
}

/** El último run del ejercicio, que es el que la pantalla enseña. */
export async function latestClosingRun(db: AnyClient, fiscalYearId: string): Promise<ClosingRunRow | null> {
  const row = await db.closingRun.findFirst({ where: { fiscalYearId }, orderBy: { createdAt: "desc" } })
  return row ? toRunRow(row) : null
}

/** **G-12.** El cierre `CERRADO` vivo del ejercicio, si lo hay. */
export async function sealedClosingRun(db: AnyClient, fiscalYearId: string): Promise<ClosingRunRow | null> {
  const row = await db.closingRun.findFirst({
    where: { fiscalYearId, status: "CERRADO" as ClosingRunStatus },
    orderBy: { createdAt: "desc" },
  })
  return row ? toRunRow(row) : null
}

// ─────────────────────────────────────────────────────────────────────────────
// E9 · T13 — `ChecklistInput`: lo que los pasos del cierre necesitan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compone el `ChecklistInput` **plano** que `lib/closing/checklist.ts` consume.
 *
 * La frontera es la de siempre: aquí se LEE (agregados en SQL, en serie, una
 * transacción) y allí se DECIDE. Ninguna de estas consultas calcula un veredicto
 * contable; devuelven la evidencia con la que el motor puro lo compone.
 *
 * Lo que no se puede leer viaja como `null` o lista vacía y el paso sale `INFO`
 * **diciendo qué falta** —jamás PASS por vacuidad—, que es la lección de I-E9-5.
 */
export async function readChecklistInput(
  tx: TenantTransactionClient,
  opts: { fiscalYearId: string; refDate: LocalDate; baseCurrency: string; closing?: ClosingInput }
): Promise<ChecklistInput> {
  const fy = await tx.fiscalYear.findFirst({ where: { id: opts.fiscalYearId } })
  if (!fy) e9Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización")
  const start = fromUtcDate(fy.startDate)
  const end = fromUtcDate(fy.endDate)

  const closing = opts.closing ?? (await readClosingInput(tx, { ...opts }))

  // ── Integridad del diario ───────────────────────────────────────────────
  const lastRun = await tx.invariantRun.findFirst({
    where: { fiscalYearId: opts.fiscalYearId },
    orderBy: { createdAt: "desc" },
    select: { id: true, checks: true },
  })
  const checks = Array.isArray(lastRun?.checks) ? (lastRun.checks as { id: string; status: string }[]) : []
  const invariants = checks.map((c) => ({ id: c.id, status: c.status as InvariantSnapshot["status"] }))

  const failedRuns = await tx.invariantRun.findMany({
    where: { fiscalYearId: opts.fiscalYearId, seal: "REQUIERE_REVISION" as Seal },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, checks: true },
  })
  const failedRunIds = failedRuns
    .filter((r) => (Array.isArray(r.checks) ? (r.checks as { status: string }[]) : []).some((c) => c.status === "FAIL"))
    .map((r) => r.id)

  const proposedDocuments = await tx.transaction.count({
    where: { status: "PROPOSED", issuedAt: { gte: toUtcDate(start), lte: toUtcDate(end) } },
  })
  const unsortedFiles = await tx.file.count({ where: { isReviewed: false } })

  // Meses con movimiento y descuadres mensuales, en UNA consulta (I-E7-17).
  const meses = await tx.$queryRaw<{ mes: number; debit: bigint; credit: bigint }[]>`
    SELECT EXTRACT(MONTH FROM l.entry_date)::int AS mes,
           SUM(l.debit_cents)::bigint  AS debit,
           SUM(l.credit_cents)::bigint AS credit
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date BETWEEN ${toUtcDate(start)}::date AND ${toUtcDate(end)}::date
     GROUP BY 1
     ORDER BY 1`
  const monthsWithEntries = meses.map((m) => m.mes)
  const monthlyImbalances = meses
    .map((m) => ({ month: m.mes, deltaCents: centsFromDb(m.debit - m.credit, `descuadre del mes ${m.mes}`) }))
    .filter((m) => m.deltaCents !== 0)

  const bridge = await readAccountBalances(tx, { cutoff: opts.refDate, prefixes: ["555", "551", "4749"], sign: "DEUDOR" })
  const bridgeBalances = [...bridge.entries()].map(([accountCode, balanceCents]) => ({ accountCode, balanceCents }))

  // Saldo contrario a la naturaleza de la cuenta (I-E7-15): el signo lo dice el
  // grupo, y el plan dice qué cuentas son postables.
  const contraNatura = await tx.$queryRaw<{ account_code: string; balance_cents: bigint }[]>`
    SELECT l.account_code, SUM(l.debit_cents - l.credit_cents)::bigint AS balance_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.refDate)}::date
       AND l.entry_kind <> 'CLOSING'
     GROUP BY l.account_code
    HAVING (left(l.account_code, 1) IN ('2','3','6') AND SUM(l.debit_cents - l.credit_cents) < 0)
        OR (left(l.account_code, 1) IN ('1','4','7') AND SUM(l.debit_cents - l.credit_cents) > 0
            AND left(l.account_code, 2) NOT IN ('43','44','47','46'))
     ORDER BY l.account_code`
  const againstNature = contraNatura.map((r) => ({
    accountCode: r.account_code,
    balanceCents: centsFromDb(r.balance_cents, `saldo de ${r.account_code}`),
  }))

  // ── Fiscal: periodos de IVA del ejercicio sin liquidación viva ──────────
  const ivaPeriodos = await tx.$queryRaw<{ iva_period: string }[]>`
    SELECT DISTINCT e.iva_period
      FROM journal_entries e
     WHERE e.organization_id = ${tx.$organizationId}::uuid
       AND e.iva_period IS NOT NULL
       AND e.entry_date BETWEEN ${toUtcDate(start)}::date AND ${toUtcDate(end)}::date
     ORDER BY 1`
  const liquidados = await tx.vatSettlement.findMany({
    where: { status: "LIQUIDADA" },
    select: { period: true },
  })
  const liquidadosSet = new Set(liquidados.map((s) => s.period))
  const unsettledVatPeriods = ivaPeriodos.map((r) => r.iva_period).filter((p) => !liquidadosSet.has(p))

  const balances473 = await readAccountBalances(tx, { cutoff: opts.refDate, prefixes: ["473"], sign: "DEUDOR" })
  const balance473Cents = [...balances473.values()].reduce((a, b) => a + b, 0)
  const balances6300 = await readAccountBalances(tx, { cutoff: opts.refDate, prefixes: ["6300"], sign: "DEUDOR" })
  const balance6300Cents = [...balances6300.values()].reduce((a, b) => a + b, 0)

  // ── Los tres asientos del cierre y el del impuesto, si ya están ────────
  const sistema = await tx.journalEntry.findMany({
    where: { fiscalYearId: opts.fiscalYearId, voidedAt: null, templateCode: { in: [...CLOSING_SYSTEM_TEMPLATES] } },
    select: { id: true, templateCode: true },
  })
  const byTemplate = (code: string) => sistema.find((e) => e.templateCode === code)?.id ?? null

  // ── Societario y analítica ─────────────────────────────────────────────
  const distribution = await tx.profitDistribution.findFirst({
    where: { fiscalYearId: opts.fiscalYearId },
    select: { entryId: true },
  })
  const previo = await tx.fiscalYear.findFirst({
    where: { endDate: { lt: fy.startDate }, accountsApprovalStatus: { in: ["APROBADAS", "DEPOSITADAS"] } },
    orderBy: { endDate: "desc" },
    select: { id: true },
  })
  let previousResultPendingCents = 0
  if (previo) {
    const distPrevio = await tx.profitDistribution.findFirst({ where: { fiscalYearId: previo.id }, select: { id: true } })
    if (!distPrevio) {
      const saldo129 = await readAccountBalances(tx, { cutoff: opts.refDate, prefixes: ["129"] })
      previousResultPendingCents = [...saldo129.values()].reduce((a, b) => a + b, 0)
    }
  }

  const closingRun = await latestClosingRun(tx, opts.fiscalYearId)
  const answers: Record<string, ManualAnswer> = {}
  for (const step of closingRun?.steps ?? []) {
    if (step.answer) answers[step.step] = step.answer
  }

  return {
    fiscalYearCode: fy.code,
    fiscalYearStart: start,
    fiscalYearEnd: end,
    fiscalYearStatus: fy.status === "CLOSED" ? "CLOSED" : "OPEN",
    accountsApprovalStatus: fy.accountsApprovalStatus,
    taxFilingStatus: fy.taxFilingStatus,
    reopened: closingRun?.status === "REABIERTO",

    invariants,
    failedRunIds,
    proposedDocuments,
    unsortedFiles,
    monthsWithEntries,
    monthlyImbalances,
    bridgeBalances,
    againstNature,

    // La conciliación bancaria vive en E7 y se cablea desde la acción: aquí, sin
    // dato, el paso sale INFO diciendo que falta, no PASS.
    unreconciledBankAccounts: [],

    pendingRecurring: closing.recurring.flatMap((r) =>
      duePeriods(r, r.generatedPeriods, opts.refDate).map((p) => ({ code: r.code, period: p.key }))
    ),
    assetsPendingDepreciation: [],
    assetsWithoutAttribution: closing.assetsWithoutAttribution.map((a) => ({ code: a.code })),
    accrualsNotExhausted: closing.accruals
      .filter((a) => a.periodEnd <= opts.refDate && a.status === "VIVA")
      .map((a) => ({ code: a.code, pendingCents: a.totalCents })),

    fxStep: null,
    presentValuePending: [],
    reclassStep: null,
    positionsWithoutDueDate: closing.maturityPositions.filter((p) => p.dueDate === null).length,
    debtWithoutSchedule: closing.positionsWithoutSchedule.map((p) => ({
      accountCode: p.accountCode,
      balanceCents: p.balanceCents,
    })),

    unsettledVatPeriods,
    prorrataStep: null,
    capitalGoodsStep: null,
    reccPendingCents: null,
    withholdingPendingModels: [],
    balance473Cents,

    incomeTaxEntryId: byTemplate("IMPUESTO_BENEFICIOS"),
    balance6300Cents,
    regularizacionEntryId: byTemplate("REGULARIZACION_RESULTADO"),
    cierreEntryId: byTemplate("CIERRE_EJERCICIO"),
    aperturaEntryId: null,

    distributionEntryId: distribution?.entryId ?? null,
    previousResultPendingCents,

    cecosPendientes: [],
    i4i5: invariants.filter((c) => c.id === "I4" || c.id === "I5"),
    answers,
  }
}

/** Las plantillas de los asientos de sistema que el checklist busca en el diario. */
const CLOSING_SYSTEM_TEMPLATES = [
  "IMPUESTO_BENEFICIOS",
  "REGULARIZACION_RESULTADO",
  "CIERRE_EJERCICIO",
  "APERTURA_EJERCICIO",
] as const

/**
 * **O-12.** Los bienes de inversión con la **cuenta** y el **año de alta** que
 * `capitalGoodsGuard` necesita para nombrarlos en la evidencia.
 *
 * Existe aquí y no en `models/assets.ts` porque `CapitalGoodRow` no expone
 * `asset_account_code` —lo consume para derivar `isBuilding`— y la guardia lo
 * enseña literalmente: «AC-0007 (2131, alta 2024, coste …)». Un bien nombrado
 * sin su cuenta obliga a buscarlo a mano, que es justo lo que la guardia evita.
 */
export async function readCapitalGoodRefs(
  tx: TenantTransactionClient,
  opts: { from: LocalDate; to: LocalDate }
): Promise<{ id: string; code: string; accountCode: string; acquisitionYear: number; costCents: Cents; realEstate: boolean }[]> {
  const rows = await tx.$queryRaw<
    { id: string; code: string; asset_account_code: string; year: number; cost_cents: bigint }[]
  >`
    SELECT a.id, a.code, a.asset_account_code,
           EXTRACT(YEAR FROM a.in_service_date)::int AS year,
           a.acquisition_cost_cents AS cost_cents
      FROM fixed_assets a
     WHERE a.organization_id = ${tx.$organizationId}::uuid
       AND a.is_capital_good = TRUE
       AND left(a.asset_account_code, 1) = '2'
       AND a.in_service_date BETWEEN ${toUtcDate(opts.from)}::date AND ${toUtcDate(opts.to)}::date
     ORDER BY a.in_service_date, a.code`
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    accountCode: r.asset_account_code,
    acquisitionYear: r.year,
    costCents: centsFromDb(r.cost_cents, "coste del bien de inversión"),
    // Art. 107.Tres: terrenos (`210`) y construcciones (`211`) regularizan nueve
    // años, no cuatro.
    realEstate: r.asset_account_code.startsWith("210") || r.asset_account_code.startsWith("211"),
  }))
}
