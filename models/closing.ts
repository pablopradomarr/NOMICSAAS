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
import type { ChecklistInput, InvariantSnapshot, ManualAnswer, StepEvidence } from "@/lib/closing/checklist"
import type { ClosingInvariantInput } from "@/lib/closing/invariants-e9"
import { legalReserveCents } from "@/lib/closing/distribution"
import { duePeriods } from "@/lib/recurring/schedule"
import { periodBounds, type AllocPeriod } from "@/lib/analytics/allocate"
import { badgeForFigure } from "@/lib/audit/confidence"
import { isCashAccount, isUnderAccount } from "@/lib/bank/types"
import { accrualSchedule } from "@/lib/closing/accrual"
import { depreciationSchedule, scheduleHashOf } from "@/lib/closing/depreciation"
import { fxClosingAdjustments, fxStep as fxStepOf, type ClosingRate, type FxPosition } from "@/lib/closing/fx"
import { reclassStep as reclassStepOf, reclassifyMaturities, TEMPLATE_RECLASIFICACION } from "@/lib/closing/reclass"
import { capitalGoodsGuard, withholdingAccountKey, type ClosingStepResult, type WithholdingModel } from "@/lib/closing/vat"
import { getAccountMapByKey } from "@/models/account-map"
import { allocationRunStaleness, listAllocationRules, listAllocationRuns } from "@/models/allocations"
import { listBankAccounts, pendingItems } from "@/models/bank"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import { centsFromDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import type { MaturityRow, PositionWithoutScheduleRow } from "@/models/debt"
import { debtScheduleHashOf, readDebtSchedules, readMaturities, readPositionsWithoutSchedule } from "@/models/debt"
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
  /**
   * **O-4 / I-E9-24.** Lo dice el PLAN (`accounts.is_monetary`), nunca el motor.
   *
   * Las posiciones NO monetarias viajan igualmente —un anticipo de `407` en USD
   * es una de ellas— para que `fxClosingAdjustments` pueda **excluirlas y
   * decirlo**: hasta la ronda 1 de corrección la consulta las filtraba en SQL,
   * `result.excludedNonMonetary` llegaba siempre vacío y el aviso de la NRV
   * 11ª.2.2 no se mostraba jamás (H-5). La exclusión no cambia: la decide el
   * mismo dato, sólo que ahora además se explica.
   */
  isMonetary: boolean
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
      is_monetary: boolean
    }[]
  >`
    WITH posiciones AS (
      SELECT l.account_code,
             l.counterparty_id,
             upper(l.original_currency) AS currency,
             SUM(l.debit_cents - l.credit_cents)::bigint                   AS base_balance_cents,
             SUM(CASE WHEN l.debit_cents > 0 THEN l.original_amount_cents
                      ELSE -l.original_amount_cents END)::bigint           AS original_balance_cents,
             a.is_monetary                                                 AS is_monetary
        FROM journal_lines l
        JOIN accounts a
          ON a.organization_id = l.organization_id AND a.code = l.account_code
       WHERE l.organization_id = ${tx.$organizationId}::uuid
         AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
         AND l.entry_kind <> 'CLOSING'
         AND l.original_currency IS NOT NULL
         AND upper(l.original_currency) <> ${base}
       -- **O-4 / I-E9-24**: el universo lo fija el PLAN, no el motor. Las no
       -- monetarias NO se filtran aquí: viajan con su marca para que el motor
       -- las excluya **y lo explique** (H-5).
       GROUP BY l.account_code, l.counterparty_id, upper(l.original_currency), a.is_monetary
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
    isMonetary: r.is_monetary,
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

/**
 * Saldo vivo por `(cuenta, contraparte, divisa)` con su vencimiento declarado.
 *
 * **La convención del signo, escrita donde se lee (H-1).** `openCents` es
 * **`debe − haber`**, igual que `MaturityPosition.openCents` de
 * `lib/closing/reclass.ts`: **positivo = saldo DEUDOR** (un crédito de `25x`,
 * `54x`, `43x`), **negativo = saldo ACREEDOR** (una deuda de `17x`, `52x`). Es
 * la misma convención que declara la propia evidencia del paso
 * (`sum(l.debit_cents - l.credit_cents) AS abierto`) y la que decide `debtor` y,
 * con él, **la dirección del asiento T-32**.
 *
 * Hasta la ronda 1 de corrección de E9 esta función devolvía `credit − debit` y
 * los dos llamantes lo pasaban tal cual a `reclassifyMaturities`: el motor leía
 * una deuda como un crédito y **posteaba T-32 al revés** (`523 (D) / 173 (H)`
 * en vez de `173 (D) / 523 (H)`), inflando el pasivo no corriente y dejando el
 * corriente en negativo. Silencioso: I-E9-16 (`Σ largo + Σ corto`) seguía
 * cuadrando y el paso salía PASS. El campo se llama `openCents` —y no
 * `balanceCents`— precisamente para que nadie vuelva a asumir un signo.
 */
export type MaturityPositionRow = {
  accountCode: string
  counterpartyId: string | null
  currency: string | null
  dueDate: LocalDate | null
  /** **`debe − haber`**: > 0 deudor, < 0 acreedor. Ver el docblock del tipo. */
  openCents: Cents
  /** Nº del asiento vivo MÁS ANTIGUO del grupo: desempate del FIFO (R-RC-3, P7). */
  entryNumber: number
}

/**
 * **O-6.** Saldos vivos de las cuentas de los pares de reclasificación, por
 * contraparte, divisa **y vencimiento**, agregados en SQL, en la convención
 * `debe − haber` del motor. Con `dueDate = null` la posición **no se reclasifica
 * y se nombra**: I-E9-16 exige que toda posición reclasificada tenga
 * vencimiento, y adivinarlo está prohibido.
 */
export async function readMaturityPositions(
  tx: TenantTransactionClient,
  opts: {
    cutoff: LocalDate
    accountCodes: readonly string[]
    /**
     * Asientos a EXCLUIR del agregado. Lo usa I-E9-16 para reconstruir las
     * posiciones **antes** de T-32 y compararlas con las de después: sin ese
     * «antes» el invariante se recomputaría contra sí mismo y sería tautológico
     * (§6.1).
     */
    excludeEntryIds?: readonly string[]
  }
): Promise<MaturityPositionRow[]> {
  const codes = [...opts.accountCodes]
  if (codes.length === 0) return []
  const excluded = [...(opts.excludeEntryIds ?? [])]
  const rows = await tx.$queryRaw<
    {
      account_code: string
      counterparty_id: string | null
      currency: string | null
      due_date: Date | null
      open_cents: bigint
      first_entry_number: number | null
    }[]
  >`
    SELECT l.account_code, l.counterparty_id, upper(l.original_currency) AS currency, l.due_date,
           SUM(l.debit_cents - l.credit_cents)::bigint AS open_cents,
           MIN(e.entry_number)                         AS first_entry_number
      FROM journal_lines l
      JOIN journal_entries e
        ON e.organization_id = l.organization_id AND e.id = l.entry_id
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
       AND l.entry_kind <> 'CLOSING'
       AND l.account_code = ANY(${codes}::text[])
       AND (cardinality(${excluded}::uuid[]) = 0 OR NOT (l.entry_id = ANY(${excluded}::uuid[])))
     GROUP BY l.account_code, l.counterparty_id, upper(l.original_currency), l.due_date
    HAVING SUM(l.debit_cents - l.credit_cents) <> 0
     ORDER BY l.account_code, l.due_date NULLS FIRST`
  return rows.map((r) => ({
    accountCode: r.account_code,
    counterpartyId: r.counterparty_id,
    currency: r.currency,
    dueDate: r.due_date ? fromUtcDate(r.due_date) : null,
    openCents: centsFromDb(r.open_cents, "posición viva"),
    // **H-4.** El desempate del FIFO que R-RC-3 declara: el asiento vivo más
    // antiguo del grupo. Antes los dos llamantes pasaban `0` para todas las
    // posiciones y la garantía no existía —inocua mientras el eje viniera
    // agregado por `(cuenta, contraparte, divisa, vencimiento)`, pero declarada—.
    entryNumber: Number(r.first_entry_number ?? 0),
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
// H-2 · el bloque `closing` de los invariantes, que nadie rellenaba
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **H-2 (BLOQUEANTE de la auditoría de E9).** §6.3 dice que los veintisiete
 * `I-E9-*` entran en `runLedgerInvariants`, en `InvariantRun`, en
 * `ReportRun.validation` y en `/audit` bajo la familia `CIERRE`.
 * `lib/ledger/invariants.ts` los ejecuta `if (input.closing)` **y nadie
 * rellenaba `closing`**: sobre un ejercicio realmente cerrado, 0 de 215 checks
 * llevaban un id `I-E9-*`. Eran código muerto en producción, con tests
 * unitarios pero sin vigilar un solo dato real — incluida **I-E9-16**, que es
 * justo la que debería haber cazado la reclasificación con el signo invertido.
 *
 * Esta función es el puente. Reutiliza el `ClosingInput` que ya lee el
 * checklist —una transacción, lecturas en serie, sin N+1 (§9)— y añade lo que
 * los invariantes necesitan **y el checklist no**: las ocurrencias regla a
 * regla, las posiciones vivas ANTES del asiento de reclasificación, los
 * `ClosingRun` sellados y la distribución del resultado.
 *
 * Lo que no se puede componer **no se inventa**: el bloque se omite y el
 * invariante sale `INFO` diciendo qué falta, que es el contrato de
 * `lib/closing/invariants-e9.ts`. Un PASS por vacuidad sería peor que el
 * silencio que esto viene a cerrar.
 */
export async function readClosingInvariantInput(
  tx: TenantTransactionClient,
  opts: { fiscalYearId: string; refDate: LocalDate; baseCurrency: string; closing?: ClosingInput }
): Promise<ClosingInvariantInput> {
  const closing = opts.closing ?? (await readClosingInput(tx, { ...opts }))
  const fy = await tx.fiscalYear.findFirst({ where: { id: opts.fiscalYearId } })
  if (!fy) e9Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización")
  const end = fromUtcDate(fy.endDate)

  // ── Recurrentes (I-E9-1a, 1b, 2) ────────────────────────────────────────
  const occurrenceRows = await tx.recurringOccurrence.findMany({
    orderBy: [{ recurringEntryId: "asc" }, { period: "asc" }],
    select: { id: true, recurringEntryId: true, period: true, status: true, entryId: true, reason: true, inputHash: true },
  })
  const ruleById = new Map(closing.recurring.map((r) => [r.id, r]))
  const recurring = {
    rules: closing.recurring.map((r) => ({ id: r.id, code: r.code, kind: r.kind })),
    occurrences: occurrenceRows.map((o) => ({
      ruleId: o.recurringEntryId,
      ruleCode: ruleById.get(o.recurringEntryId)?.code ?? o.recurringEntryId,
      period: o.period,
      status: o.status as "GENERADA" | "OMITIDA" | "FALLIDA",
      entryId: o.entryId,
      reason: o.reason,
      inputHash: o.inputHash,
    })),
  }

  // ── Inmovilizado (I-E9-3, 4, 5) ─────────────────────────────────────────
  const assets = closing.assets.map((a) => {
    const cuadro = depreciationSchedule(a.asset, a.revisions)
    // **Un activo dado de baja o vendido no tiene cuadro vivo que comparar.** El
    // asiento de la enajenación (T-33/T-34) CANCELA su `28x` y su cuadro queda
    // truncado en la fecha de baja, así que `Σ cuotas = base` (I-E9-4) y
    // `Σ 68x = 28x` (I-E9-5) dejan de cumplirse **por construcción**, no por un
    // descuadre. Se omiten las dos magnitudes —no se falsean—: los invariantes
    // los excluyen de `comparables` y siguen vigilando los activos vivos, que
    // es donde el riesgo R14 existe.
    const vivo = a.asset.status === "EN_USO" || a.asset.status === "TOTALMENTE_AMORTIZADO"
    const scheduleTotalCents = cuadro.reduce((acc, row) => acc + row.quotaCents, 0)
    return {
      id: a.asset.id,
      code: a.asset.code,
      scheduleHash: a.asset.scheduleHash,
      recomputedScheduleHash: scheduleHashOf(cuadro),
      ...(vivo
        ? {
            scheduleTotalCents,
            amortizableBaseCents: a.asset.acquisitionCostCents - a.asset.residualValueCents,
            expensePostedCents: a.expenseCents,
            accumulatedCents: a.accumulatedCents,
          }
        : {}),
      hasNegativeQuota: cuadro.some((row) => row.quotaCents < 0),
      fullyAttributed: !closing.assetsWithoutAttribution.some((x) => x.id === a.asset.id),
    }
  })

  // ── Periodificaciones (I-E9-6, 7) ───────────────────────────────────────
  // Lo devengado por periodificación se **deriva del diario** (nunca se
  // almacena): Σ de las líneas de su cuenta de PyG atribuidas a la fila.
  const periodosGenerados = await tx.recurringOccurrence.findMany({
    where: { status: "GENERADA", recurringEntry: { accrualId: { not: null } } },
    select: { period: true, recurringEntry: { select: { accrualId: true } } },
  })
  const generadosPorAccrual = new Map<string, Set<string>>()
  for (const o of periodosGenerados) {
    const id = o.recurringEntry?.accrualId
    if (!id) continue
    const set = generadosPorAccrual.get(id) ?? new Set<string>()
    set.add(o.period)
    generadosPorAccrual.set(id, set)
  }
  const accruals = {
    accruals: closing.accruals.map((a) => {
      // Lo devengado se **deriva del cuadro** (§3.6: el cuadro no se almacena)
      // sumando las cuotas de los periodos con ocurrencia GENERADA.
      const generados = generadosPorAccrual.get(a.id) ?? new Set<string>()
      const cuadro = accrualSchedule(a, "MENSUAL")
      const devengado = cuadro.rows
        .filter((row) => generados.has(row.period))
        .reduce((acc, row) => acc + row.quotaCents, 0)
      return {
        id: a.id,
        code: a.code,
        periodEnd: a.periodEnd,
        totalCents: a.totalCents,
        accruedCents: devengado,
        status: a.status as "VIVA" | "AGOTADA" | "CANCELADA",
        pendingCents: a.totalCents - devengado,
      }
    }),
    accountBalanceCents: closing.accrualBalances.reduce((acc, b) => acc + b.balanceCents, 0),
  }

  // ── Reclasificación (I-E9-16, 25) ───────────────────────────────────────
  //
  // I-E9-16 **no es tautológico**: compara las posiciones ANTES y DESPUÉS del
  // asiento T-32. El «antes» se obtiene excluyendo del agregado las líneas del
  // propio asiento de reclasificación vivo del ejercicio; si no hay ninguno,
  // antes y después coinciden y el invariante comprueba lo que puede —que
  // ninguna posición viva con vencimiento dentro de la frontera esté en una
  // cuenta de largo—, que es justamente lo que caza el signo invertido.
  const reclassEntry = await tx.journalEntry.findFirst({
    where: { fiscalYearId: opts.fiscalYearId, templateCode: TEMPLATE_RECLASIFICACION, voidedAt: null },
    orderBy: { entryNumber: "desc" },
    select: { id: true },
  })
  const reclassCodes = [...new Set(closing.reclassificationPairs.flatMap((p) => [p.longAccountCode, p.shortAccountCode]))]
  const positionsBefore = reclassEntry
    ? await readMaturityPositions(tx, { cutoff: opts.refDate, accountCodes: reclassCodes, excludeEntryIds: [reclassEntry.id] })
    : closing.maturityPositions
  const toMaturity = (p: MaturityPositionRow) => ({
    accountCode: p.accountCode,
    counterpartyId: p.counterpartyId,
    currency: p.currency ?? opts.baseCurrency,
    dueDate: p.dueDate,
    openCents: p.openCents,
    entryNumber: p.entryNumber,
  })
  const reclass = {
    cutoff: opts.refDate,
    pairs: closing.reclassificationPairs.map((p) => ({ longCode: p.longAccountCode, shortCode: p.shortAccountCode })),
    positionsBefore: positionsBefore.map(toMaturity),
    positionsAfter: closing.maturityPositions.map(toMaturity),
    debtsWithoutSchedule: closing.positionsWithoutSchedule.map((p) => ({
      reference: p.accountCode,
      accountCode: p.accountCode,
      openCents: p.balanceCents,
      declaredReason: null,
    })),
    // **H-6.** El sello del cuadro contra sus vencimientos de hoy.
    tamperedSchedules: (await readDebtSchedules(tx, {}))
      .filter((d) => debtScheduleHashOf(d.installments) !== d.scheduleHash)
      .map((d) => ({
        reference: d.code,
        sealedHash: d.scheduleHash,
        recomputedHash: debtScheduleHashOf(d.installments),
      })),
  }

  // ── Diferencias de cambio (I-E9-17, 24) ─────────────────────────────────
  const fx = {
    cutoff: opts.refDate,
    rates: closing.fxPositions
      .filter((p): p is FxPositionRow & { rateMicro: bigint; rateDate: LocalDate } => p.rateMicro !== null && p.rateDate !== null)
      .map((p) => ({ currency: p.currency, rateMicro: p.rateMicro, rateDate: p.rateDate })),
    positionsAfter: closing.fxPositions
      .filter((p) => p.isMonetary)
      .map((p) => ({
        accountCode: p.accountCode,
        counterpartyId: p.counterpartyId,
        currency: p.currency,
        baseBalanceCents: p.baseBalanceCents,
        currencyBalanceCents: p.originalBalanceCents,
        isMonetary: true,
      })),
    // **I-E9-24.** Cuentas NO monetarias que hayan quedado dentro del barrido:
    // se detecta comparando la marca del plan con las líneas de 668/768 del
    // ejercicio, no con una lista escrita en el motor.
    nonMonetaryInSweep: closing.fxPositions
      .filter((p) => !p.isMonetary && p.recognizedDifferenceCents !== 0)
      .map((p) => ({ accountCode: p.accountCode, currency: p.currency })),
  }

  // ── El acto de cerrar (I-E9-12, 13, 14, 15) ─────────────────────────────
  const regularizacion = await tx.journalEntry.findFirst({
    where: { fiscalYearId: opts.fiscalYearId, templateCode: "REGULARIZACION_RESULTADO", voidedAt: null },
    select: { id: true, entryDate: true },
  })
  let balancesAfterRegularization: Record<string, Cents> | null = null
  let balance129Cents: Cents | null = null
  if (regularizacion) {
    const saldos = await readAccountBalances(tx, { cutoff: end, prefixes: ["6", "7", "129"] })
    balancesAfterRegularization = Object.fromEntries(saldos)
    balance129Cents = saldos.get("129") ?? 0
  }
  const siguiente = await tx.fiscalYear.findFirst({
    where: { startDate: { gt: fy.startDate } },
    orderBy: { startDate: "asc" },
    select: { id: true },
  })
  const nextYearEntries = siguiente
    ? (
        await tx.journalEntry.findMany({
          where: { fiscalYearId: siguiente.id },
          orderBy: { entryNumber: "asc" },
          take: 20,
          select: { entryNumber: true, kind: true, templateCode: true, reversesEntryId: true },
        })
      ).map((e) => ({
        entryNumber: e.entryNumber,
        kind: e.kind as string,
        templateCode: e.templateCode,
        reversesEntryId: e.reversesEntryId,
      }))
    : []
  const closingEntries = {
    ...(balancesAfterRegularization ? { balancesAfterRegularization } : {}),
    ...(balance129Cents !== null ? { balance129Cents } : {}),
    nextYearEntries,
  }

  // ── Los `ClosingRun` sellados (I-E9-20) ─────────────────────────────────
  const runs = await tx.closingRun.findMany({
    where: { fiscalYearId: opts.fiscalYearId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, status: true, ledgerHash: true, configHash: true, steps: true },
  })
  const closingRuns = runs.map((r) => ({
    id: r.id,
    fiscalYearCode: fy.code,
    status: r.status as "BORRADOR" | "CERRADO" | "REABIERTO" | "FALLIDO",
    ledgerHash: r.ledgerHash,
    configHash: r.configHash,
    stepsHash: stepsHashOf((Array.isArray(r.steps) ? r.steps : []) as ClosingStepRecord[]),
    recomputedStepsHash: stepsHashOf((Array.isArray(r.steps) ? r.steps : []) as ClosingStepRecord[]),
  }))

  // ── Distribución del resultado (I-E9-23) ────────────────────────────────
  const distribuciones = await tx.profitDistribution.findMany({
    where: { fiscalYearId: opts.fiscalYearId },
    select: {
      resultCents: true,
      legalReserveCents: true,
      voluntaryReserveCents: true,
      carryForwardCents: true,
      dividendCents: true,
      interimDividendCents: true,
      lossCarryForwardCents: true,
    },
  })
  const capital = closing.balances.get("100") ?? 0
  const reservaLegalPrevia = closing.balances.get("112") ?? 0
  const distribution = distribuciones.map((d) => ({
    fiscalYearCode: fy.code,
    approvalStatus: fy.accountsApprovalStatus as "BORRADOR" | "FORMULADAS" | "APROBADAS" | "DEPOSITADAS",
    pending129Cents: closing.balances.get("129") ?? 0,
    profitCents: Number(d.resultCents),
    destinationsCents:
      Number(d.legalReserveCents) +
      Number(d.voluntaryReserveCents) +
      Number(d.carryForwardCents) +
      Number(d.dividendCents) +
      Number(d.lossCarryForwardCents) -
      Number(d.interimDividendCents),
    legalReserveCents: Number(d.legalReserveCents),
    legalReserveRequiredCents: legalReserveCents({
      profitCents: Number(d.resultCents),
      capital: { cents: capital, source: "DIARIO" as const, accountCode: "100" },
      currentReserveCents: reservaLegalPrevia,
    }),
    // El capital se deriva del saldo acreedor de `100` (R2-2); el `DECLARADO`
    // es la contingencia y la registra la propia acción con su WARN.
    capitalSource: "DIARIO" as const,
  }))

  return {
    cutoff: opts.refDate,
    recurring,
    assets,
    accruals,
    reclass,
    fx,
    closing: closingEntries,
    closingRuns,
    ...(distribution.length > 0 ? { distribution } : {}),
    // `vat`, `presentValue` y `reopening` los aporta quien los tiene: la
    // pantalla de IVA, el asistente y la reapertura. Sin ellos, sus invariantes
    // salen INFO diciendo qué falta; jamás PASS por vacuidad.
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
// E9 · T23 — los cuatro bloques que C1 dejó llegando VACÍOS
//
// Conciliación bancaria (E7), dotación pendiente por activo, retenciones por
// modelo (D12/O-27) y liquidación de CECOs (E5). Los cuatro se leen AQUÍ, con
// agregados en SQL y sin N+1, y viajan al checklist con **evidencia y
// provenance**: un paso que sale PASS tiene que decir sobre cuántas cuentas,
// cuántos activos o cuántos periodos lo dice, o es un PASS por vacuidad
// (lección I-E9-5).
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que cada bloque devuelve: los pendientes, la evidencia y el origen del dato. */
export type ChecklistBlockRead = {
  /** Los incumplimientos, ya nombrados con su motivo. Vacío = nada pendiente. */
  pendientes: string[]
  /** Qué se ha mirado y qué ha quedado fuera del alcance, y por qué. */
  evidencia: string
  /** La consulta o la derivación de la que sale, para el drill-down. */
  query: string
}

/**
 * **CONCILIACION_BANCARIA (E7).** Una cuenta de tesorería está conciliada al
 * corte si y sólo si su cifra lleva el badge **`✓ validado contra fuente`**:
 * anclada, sin hueco de extractos (I-E7-6b), con `I-E7-1` cuadrando, sin
 * diferencia de cambio pendiente y **sin un pendiente sin explicar** (O-8/O-17).
 * Es la MISMA derivación que pinta el panel de E7 —`pendingItems` +
 * `badgeForFigure`—, nunca una segunda: un paso evaluado por dos caminos puede
 * decir dos cosas distintas.
 *
 * Tres precisiones que evitan un veredicto falso:
 *
 *  · **La caja queda fuera del alcance y se dice.** `570` no tiene extracto ni
 *    puede tenerlo (O-16): exigirle el badge condenaría a WARN eterno a toda
 *    organización con caja. Su comprobación es `ARQUEO_DE_CAJA`, que es un paso
 *    DECLARADO y ya está en el catálogo.
 *  · **Una `57x` con saldo y sin cuenta bancaria declarada es un pendiente**, no
 *    un silencio: sin fuente no hay nada contra lo que conciliar.
 *  · **`invariantsPass` entra en `true` a propósito.** El badge lo baja a
 *    `calculado` cuando los invariantes no pasan, pero eso ya lo dice
 *    `INVARIANTES_PASS` —bloqueante— en este mismo checklist, y repetirlo aquí
 *    haría que un FAIL del diario se contara dos veces.
 */
export async function readBankReconciliationBlock(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; baseCurrency: string }
): Promise<ChecklistBlockRead> {
  const query = "models/bank.pendingItems + lib/audit/confidence.badgeForFigure (I-E7-1, I-E7-6b, O-8/O-17)"
  const accounts = await listBankAccounts(tx, { activeOnly: true })
  const saldos57 = await readAccountBalances(tx, { cutoff: opts.cutoff, prefixes: ["57"], sign: "DEUDOR" })

  const declaradas = new Set(accounts.map((a) => a.accountCode))
  const pendientes: string[] = []
  const sinFuente: string[] = []
  for (const [code, saldo] of saldos57) {
    if (isCashAccount(code)) {
      sinFuente.push(code)
      continue
    }
    if (saldo === 0) continue
    if (![...declaradas].some((declarada) => isUnderAccount(code, declarada) || isUnderAccount(declarada, code))) {
      pendientes.push(`${code}: con saldo (${saldo} c) y sin cuenta bancaria declarada contra la que conciliar`)
    }
  }

  const bancarias = accounts.filter((a) => !isCashAccount(a.accountCode))
  if (bancarias.length === 0) {
    return {
      pendientes,
      evidencia:
        sinFuente.length > 0
          ? `sin cuentas bancarias declaradas; ${sinFuente.length} cuenta(s) de caja (${sinFuente.join(", ")}) quedan fuera del alcance: no tienen extracto (O-16), las cubre ARQUEO_DE_CAJA`
          : "sin cuentas bancarias declaradas ni saldo en 57x al corte",
      query,
    }
  }

  const summaries = await pendingItems(tx, { cutoff: opts.cutoff, baseCurrency: opts.baseCurrency })
  let antiguos = 0
  for (const account of bancarias) {
    const badge = badgeForFigure({
      accountCodes: [account.accountCode],
      bankAccounts: accounts,
      summaries,
      invariantsPass: true,
    })
    const summary = summaries.find((s) => s.bankAccountId === account.id)
    antiguos += summary?.pendientesAntiguos.length ?? 0
    if (badge.badge !== "validado") {
      pendientes.push(`${account.code} (${account.accountCode}): ${badge.motivos[0] ?? "sin cuadre calculado al corte"}`)
    }
  }

  const partes = [`${bancarias.length} cuenta(s) bancaria(s) miradas al corte ${opts.cutoff}`]
  if (antiguos > 0) partes.push(`${antiguos} pendiente(s) por encima del plazo declarado (O-8)`)
  if (sinFuente.length > 0) {
    partes.push(`caja (${sinFuente.join(", ")}) fuera del alcance: no tiene extracto (O-16), la cubre ARQUEO_DE_CAJA`)
  }
  return { pendientes, evidencia: partes.join("; "), query }
}

/**
 * **AMORTIZACION_AL_DIA.** Cuotas del ejercicio **sin asiento**, activo a
 * activo. El cuadro no se almacena (§3.6): se recalcula con el MISMO
 * `depreciationSchedule` que compone T-31, y los periodos contabilizados salen
 * de `journal_lines.fixed_asset_id` (O-19), que ya trae `readAssetsWithRevisions`
 * en su agregado. **Cero consultas nuevas.**
 *
 * Los activos **sin ninguna línea atribuida** no entran aquí: no se puede decir
 * que les falte una cuota cuando no se puede ver ninguna. Los nombra
 * `assetsWithoutAttribution` y el paso sale `INFO` (I-E9-5, §3.5).
 */
export function pendingDepreciationOf(
  assets: readonly AssetWithRevisions[],
  opts: { fiscalYearStart: LocalDate; fiscalYearEnd: LocalDate; refDate: LocalDate; sinAtribucion: ReadonlySet<string> }
): ChecklistBlockRead & { items: { code: string; periods: string[] }[] } {
  const desde = opts.fiscalYearStart.slice(0, 7)
  const hasta = (opts.refDate < opts.fiscalYearEnd ? opts.refDate : opts.fiscalYearEnd).slice(0, 7)
  const items: { code: string; periods: string[] }[] = []
  const noEvaluables: string[] = []
  let mirados = 0
  let cuotas = 0

  for (const { asset, revisions, postedPeriods } of assets) {
    if (opts.sinAtribucion.has(asset.id)) continue
    // Un activo dado de baja ANTES del ejercicio no dota nada en él.
    if (asset.disposalDate != null && asset.disposalDate < opts.fiscalYearStart) continue
    let rows
    try {
      rows = depreciationSchedule(asset, revisions)
    } catch (error) {
      // D2.1: los métodos no resueltos LANZAN en vez de aproximar. Aquí no se
      // traga la excepción: se nombra el activo y el paso lo enseña.
      noEvaluables.push(`${asset.code} (${error instanceof Error ? error.message : "cuadro no calculable"})`)
      continue
    }
    mirados += 1
    const posted = new Set(postedPeriods)
    const delEjercicio = rows.filter((r) => r.period >= desde && r.period <= hasta && r.quotaCents !== 0)
    cuotas += delEjercicio.length
    const periods = delEjercicio.filter((r) => !posted.has(r.period)).map((r) => r.period)
    if (periods.length > 0) items.push({ code: asset.code, periods })
  }

  const partes = [`${mirados} activo(s) con atribución y ${cuotas} cuota(s) del ejercicio en su cuadro vigente`]
  if (noEvaluables.length > 0) partes.push(`cuadro no calculable en ${noEvaluables.join(", ")}`)
  return {
    items,
    pendientes: items.map((a) => `${a.code}: ${a.periods.join(", ")}`),
    evidencia: partes.join("; "),
    query: "lib/closing/depreciation.depreciationSchedule × journal_lines.fixed_asset_id (O-19)",
  }
}

/** Fecha límite de ingreso de un trimestre de retenciones: día 20 del mes siguiente. */
const withholdingDueDate = (quarter: string): LocalDate => {
  const year = Number(quarter.slice(0, 4))
  const q = Number(quarter.slice(-1))
  const month = 3 * q + 1
  return month > 12 ? `${year + 1}-01-20` : `${year}-${String(month).padStart(2, "0")}-20`
}

/**
 * **RETENCIONES_LIQUIDADAS (D12 · O-27).** `4751` está partida por modelo, y por
 * eso el saldo **sí** se puede repartir: un trimestre está liquidado cuando su
 * subcuenta (`IRPF_A_PAGAR_111` / `_115` / `_123`, resueltas por `AccountKey`,
 * nunca por códigos escritos) queda a cero después del asiento de ingreso.
 *
 * Dos cosas que un saldo a secas diría mal:
 *
 *  · **El trimestre en curso no está «sin liquidar»**: el modelo del 4T se
 *    ingresa hasta el 20 de enero, así que a 31-12 su saldo es un pasivo
 *    correcto. Lo pendiente es el saldo del modelo **menos lo devengado en los
 *    trimestres cuyo plazo aún no ha vencido**. El ingreso se contabiliza en el
 *    trimestre SIGUIENTE al devengo, así que un saldo por trimestre compararía
 *    el cargo de abril contra el abono de marzo y daría un falso pendiente.
 *  · **El histórico anterior a E9 sigue en la `4751` sin partir** (§3.5): no se
 *    puede verificar por modelo, y se dice en la evidencia en vez de repartirlo
 *    a ojo.
 *
 * `checkWithholdingByModel` **no** se usa aquí a propósito: compara lo
 * *practicado* según el documento con lo *abonado* según el diario, y lo
 * practicado vive en la propuesta de extracción (E8, `readAuditInput`), no en el
 * libro mayor. Alimentarlo con el diario por los dos lados sería un PASS por
 * construcción.
 */
export async function readWithholdingBlock(
  tx: TenantTransactionClient,
  opts: { fiscalYearStart: LocalDate; fiscalYearEnd: LocalDate; refDate: LocalDate }
): Promise<ChecklistBlockRead> {
  const query =
    "journal_lines agrupadas por (cuenta 4751 del modelo, trimestre) — saldo acreedor al corte, art. 74 RIRPF (día 20)"
  const map = await getAccountMapByKey(tx)
  const models: WithholdingModel[] = ["111", "115", "123"]
  const byCode = new Map<string, WithholdingModel>()
  const sinMapear: WithholdingModel[] = []
  for (const model of models) {
    const code = map.get(withholdingAccountKey(model))
    if (code) byCode.set(code, model)
    else sinMapear.push(model)
  }
  const codes = [...byCode.keys()]
  if (codes.length === 0) {
    return {
      pendientes: [],
      evidencia: `ninguna subcuenta de 4751 mapeada por AccountKey (modelos ${models.join(", ")}): no es verificable por modelo (O-27)`,
      query,
    }
  }

  const hasta = opts.refDate < opts.fiscalYearEnd ? opts.refDate : opts.fiscalYearEnd
  const rows = await tx.$queryRaw<{ account_code: string; quarter: string; credit_cents: bigint; debit_cents: bigint }[]>`
    SELECT l.account_code,
           EXTRACT(YEAR FROM l.entry_date)::int || '-Q' || EXTRACT(QUARTER FROM l.entry_date)::int AS quarter,
           SUM(l.credit_cents)::bigint AS credit_cents,
           SUM(l.debit_cents)::bigint  AS debit_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date BETWEEN ${toUtcDate(opts.fiscalYearStart)}::date AND ${toUtcDate(hasta)}::date
       AND l.entry_kind <> 'CLOSING'
       AND l.account_code = ANY(${codes}::text[])
     GROUP BY 1, 2
     ORDER BY 1, 2`

  const pendientes: string[] = []
  const noVencidos: string[] = []
  const porModelo = new Map<WithholdingModel, { code: string; saldo: Cents; noVencido: Cents; ultimoVencido: string | null }>()
  for (const row of rows) {
    const model = byCode.get(row.account_code)
    if (!model) continue
    const abonado = centsFromDb(row.credit_cents, `retención devengada en ${row.account_code}`)
    const cargado = centsFromDb(row.debit_cents, `retención ingresada desde ${row.account_code}`)
    const acc = porModelo.get(model) ?? { code: row.account_code, saldo: 0, noVencido: 0, ultimoVencido: null }
    acc.saldo += abonado - cargado
    if (withholdingDueDate(row.quarter) > opts.refDate) {
      acc.noVencido += abonado
      if (abonado !== 0 && !noVencidos.includes(row.quarter)) noVencidos.push(row.quarter)
    } else if (abonado !== 0) {
      acc.ultimoVencido = row.quarter
    }
    porModelo.set(model, acc)
  }
  for (const [model, acc] of porModelo) {
    const pendiente = acc.saldo - acc.noVencido
    if (pendiente <= 0) continue
    pendientes.push(
      `${model}: ${pendiente} c abonados en ${acc.code} sin ingresar` +
        (acc.ultimoVencido ? ` (último trimestre vencido: ${acc.ultimoVencido})` : "")
    )
  }

  // El saldo que sigue en la 4751 madre: histórico anterior a E9 (§3.5).
  const madre = await readAccountBalances(tx, { cutoff: hasta, prefixes: ["4751"] })
  const sinPartir = [...madre.entries()].filter(([code, saldo]) => !byCode.has(code) && saldo !== 0)

  const partes = [`${codes.length} subcuenta(s) de 4751 miradas trimestre a trimestre hasta ${hasta}`]
  if (noVencidos.length > 0) {
    partes.push(`${noVencidos.join(", ")} con plazo aún no vencido al corte (día 20 del mes siguiente, art. 74 RIRPF)`)
  }
  if (sinMapear.length > 0) partes.push(`modelos sin subcuenta mapeada: ${sinMapear.join(", ")}`)
  if (sinPartir.length > 0) {
    partes.push(
      `${sinPartir.map(([code, saldo]) => `${code} ${saldo} c`).join(", ")} sigue(n) sin partir por modelo (histórico anterior a E9, O-27): no verificable por modelo`
    )
  }
  return { pendientes, evidencia: partes.join("; "), query }
}

/** Los periodos completos de tipo `kind` contenidos en `[from, to]`. */
function periodLabelsBetween(kind: AllocPeriod, from: LocalDate, to: LocalDate): string[] {
  const labels: string[] = []
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const candidatos =
      kind === "YEAR"
        ? [String(year)]
        : kind === "QUARTER"
          ? [1, 2, 3, 4].map((q) => `${year}-Q${q}`)
          : Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
    for (const label of candidatos) {
      const bounds = periodBounds(label)
      if (bounds.from >= from && bounds.to <= to) labels.push(label)
    }
  }
  return labels
}

/**
 * **LIQUIDACION_CECOS (E5, ADR-0013).** Un centro de coste está liquidado cuando
 * **cada periodo cerrado** de cada regla vigente tiene su `AllocationRun`
 * **SELLADO** y ese run **no está caducado**.
 *
 * Las dos mitades son necesarias:
 *
 *  · **Regla vigente sin run** — el saldo del CECO sigue donde estaba y la
 *    matriz analítica no lo reparte. Sólo se exigen los periodos **completos**
 *    (`periodEnd ≤ corte`): a un reparto anual no se le reclama en junio.
 *  · **Run SELLADO pero `STALE`** — se liquidó con un diario, unas dimensiones o
 *    unas reglas que ya no son los de hoy (O-E5-6). El sello no se guarda: se
 *    DERIVA, y `allocationRunStaleness` memoiza el contexto del ejercicio por
 *    transacción, de modo que doce runs mensuales no son doce lecturas del
 *    ejercicio (es el mismo camino que la pantalla de runs de E5).
 *
 * I5 (`Σ imputado = saldo del CECO`) no se recalcula aquí: lo trae el invariante
 * y lo enseña `I4_I5_PASS`, su propio paso.
 */
export async function readCostCenterSettlementBlock(
  tx: TenantTransactionClient,
  opts: { fiscalYearId: string; fiscalYearStart: LocalDate; fiscalYearEnd: LocalDate; refDate: LocalDate }
): Promise<ChecklistBlockRead> {
  const query = "allocation_rules vigentes × allocation_runs SELLADOS del ejercicio + staleness derivada (O-E5-6)"
  const hasta = opts.refDate < opts.fiscalYearEnd ? opts.refDate : opts.fiscalYearEnd
  const rules = await listAllocationRules(tx, {})
  const runs = (await listAllocationRuns(tx, { fiscalYearId: opts.fiscalYearId })).filter(
    (r) => r.status === "SEALED" && r.reversedAt === null && r.supersededById === null
  )
  const sellados = new Set(runs.map((r) => `${r.periodKind}|${r.periodStart}|${r.periodEnd}`))

  const pendientes: string[] = []
  let exigidos = 0
  for (const rule of rules) {
    const desde = rule.validFrom > opts.fiscalYearStart ? rule.validFrom : opts.fiscalYearStart
    const fin = rule.validTo !== null && rule.validTo < hasta ? rule.validTo : hasta
    if (desde > fin) continue
    for (const label of periodLabelsBetween(rule.period, desde, fin)) {
      const bounds = periodBounds(label)
      exigidos += 1
      if (!sellados.has(`${rule.period}|${bounds.from}|${bounds.to}`)) {
        pendientes.push(`regla ${rule.code} (CECO ${rule.sourceCostCenterCode}): sin run sellado en ${label}`)
      }
    }
  }

  for (const run of runs) {
    const { isStale, reasons } = await allocationRunStaleness(tx, run)
    if (isStale) pendientes.push(`run ${run.periodStart}…${run.periodEnd}: STALE — ${reasons.join(", ")}`)
  }

  return {
    pendientes,
    evidencia: `${rules.length} regla(s) vigente(s), ${exigidos} periodo(s) exigido(s) hasta ${hasta} y ${runs.length} run(s) sellado(s) del ejercicio`,
    query,
  }
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

  // **DEBE 2 del revisor.** La apertura vive en **N+1**, así que `byTemplate`
  // —que sólo mira el ejercicio N— la daba siempre por ausente y el paso
  // `CIERRE_APERTURA` salía «Cierre incompleto: sólo hay regularización, cierre»
  // **para siempre**; como el WARN mueve el sello, un ejercicio bien cerrado
  // quedaba permanentemente en `REQUIERE_REVISION`. Se busca donde está.
  const ejercicioSiguiente = await tx.fiscalYear.findFirst({
    where: { startDate: { gt: fy.startDate } },
    orderBy: { startDate: "asc" },
    select: { id: true },
  })
  const aperturaEntryId = ejercicioSiguiente
    ? ((
        await tx.journalEntry.findFirst({
          where: { fiscalYearId: ejercicioSiguiente.id, voidedAt: null, templateCode: "APERTURA_EJERCICIO" },
          orderBy: { entryNumber: "asc" },
          select: { id: true },
        })
      )?.id ?? null)
    : null

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

  // ── Los cuatro pasos que resuelven los MOTORES puros ────────────────────
  // El checklist no recalcula nada: los pasos de valoración y presentación los
  // devuelven `fxStep` y `reclassStep`, que son la misma función que postea el
  // asiento. Un paso evaluado por dos caminos distintos es un paso que puede
  // decir dos cosas distintas.
  const fxPositionsPuras: FxPosition[] = closing.fxPositions.map((p) => ({
    accountCode: p.accountCode,
    counterpartyId: p.counterpartyId,
    currency: p.currency,
    baseBalanceCents: p.baseBalanceCents,
    currencyBalanceCents: p.originalBalanceCents,
    // **O-4 / H-5.** Lo dice el plan (`accounts.is_monetary`) y viaja tal cual:
    // el motor excluye las no monetarias **y lo explica** en la evidencia.
    isMonetary: p.isMonetary,
  }))
  const rates: ClosingRate[] = closing.fxPositions
    .filter((p): p is typeof p & { rateMicro: bigint; rateDate: LocalDate } => p.rateMicro !== null && p.rateDate !== null)
    .map((p) => ({ currency: p.currency, rateMicro: p.rateMicro, rateDate: p.rateDate }))
  const fxStep = fxStepOf(fxClosingAdjustments(fxPositionsPuras, rates, opts.refDate), opts.refDate)

  // El eje ya viene agregado por `(cuenta, contraparte, divisa, vencimiento)`,
  // así que el desempate por `entryNumber` del FIFO no tiene nada que desempatar.
  const reclass = reclassStepOf(
    reclassifyMaturities(
      closing.maturityPositions.map((p) => ({
        accountCode: p.accountCode,
        counterpartyId: p.counterpartyId,
        currency: p.currency ?? opts.baseCurrency,
        dueDate: p.dueDate,
        // `debe − haber`, la convención del motor: `readMaturityPositions` ya la
        // devuelve así (H-1). Negar aquí volvería a invertir la dirección.
        openCents: p.openCents,
        entryNumber: p.entryNumber,
      })),
      closing.reclassificationPairs.map((p) => ({ longCode: p.longAccountCode, shortCode: p.shortAccountCode })),
      opts.refDate
    )
  )

  // ── RECC_DEVENGADO_31_12 (art. 163 terdecies) ───────────────────────────
  // El paso es BLOQUEANTE, así que lo que aquí se devuelva decide si el
  // ejercicio se puede cerrar. `null` significa **el régimen de caja no aplica
  // en el ejercicio** —no hay ningún `VatRegimePeriod` con `regime = RECC`
  // vigente en el intervalo del ejercicio— y el checklist lo traduce a PASS con
  // esa evidencia; no a `NA`, que bloquearía a toda organización en régimen
  // general (ronda de integración de E9).
  //
  // Con RECC vigente, lo pendiente es el saldo de las cuentas puente
  // `4778`/`4728` que arrastra el **año inmediato anterior**: el art. 163
  // terdecies obliga a devengarlo el 31/12 de ese año posterior, esté cobrado o
  // no, y es exactamente lo que T-36 barre. Se mide con corte a 31/12 de N−1
  // para no confundirlo con lo devengado durante el propio ejercicio.
  const reccVigente = await tx.vatRegimePeriod.count({
    where: {
      regime: "RECC",
      validFrom: { lte: toUtcDate(end) },
      OR: [{ validTo: null }, { validTo: { gte: toUtcDate(start) } }],
    },
  })
  let reccPendingCents: Cents | null = null
  if (reccVigente > 0) {
    const previoCutoff = `${Number(end.slice(0, 4)) - 1}-12-31` as LocalDate
    const puente = await readAccountBalances(tx, { cutoff: previoCutoff, prefixes: ["4778", "4728"] })
    reccPendingCents = [...puente.values()].reduce((a, b) => a + Math.abs(b), 0)
  }

  const prorrataYear = await tx.prorrataYear.findFirst({ where: { year: Number(opts.refDate.slice(0, 4)) } })
  const prorrataStep: ClosingStepResult =
    prorrataYear === null
      ? {
          step: "PRORRATA_DEFINITIVA",
          block: "Fiscal",
          status: "PASS",
          blocking: true,
          evidencia: "La organización no tiene prorrata declarada en el año: no hay regularización del art. 105 que practicar",
        }
      : prorrataYear.closedAt !== null
        ? {
            step: "PRORRATA_DEFINITIVA",
            block: "Fiscal",
            status: "PASS",
            blocking: true,
            evidencia:
              `Prorrata definitiva ${prorrataYear.definitiveBps ?? 0} bps cerrada el ` +
              `${prorrataYear.closedAt.toISOString().slice(0, 10)} y regularizada en ${prorrataYear.regularizationPeriod ?? "—"}`,
          }
        : {
            step: "PRORRATA_DEFINITIVA",
            block: "Fiscal",
            status: "FAIL",
            blocking: true,
            evidencia: `La prorrata de ${prorrataYear.year} sigue abierta (provisional ${prorrataYear.provisionalBps} bps): ciérrela antes de liquidar el último periodo (O-11)`,
          }

  const year = Number(opts.refDate.slice(0, 4))
  const capitalGoodRefs = await readCapitalGoodRefs(tx, { from: `${year - 9}-01-01`, to: opts.refDate })
  const prorrataYears = await tx.prorrataYear.findMany({
    where: { year: { gte: year - 9, lte: year } },
    select: { year: true, definitiveBps: true, provisionalBps: true },
  })
  const capitalGoodsStep = capitalGoodsGuard({
    year,
    prorrataByYear: prorrataYears.map((p) => ({ year: p.year, bps: p.definitiveBps ?? p.provisionalBps })),
    assets: capitalGoodRefs,
  })

  // ── T23 · los cuatro bloques que exigen leer otros módulos ──────────────
  // En SERIE, como el resto (§9): dentro de la transacción todas comparten
  // conexión. Ninguno recalcula un veredicto: devuelven los pendientes ya
  // nombrados, la evidencia de lo mirado y el origen del dato.
  const bank = await readBankReconciliationBlock(tx, { cutoff: opts.refDate, baseCurrency: opts.baseCurrency })
  const depreciation = pendingDepreciationOf(closing.assets, {
    fiscalYearStart: start,
    fiscalYearEnd: end,
    refDate: opts.refDate,
    sinAtribucion: new Set(closing.assetsWithoutAttribution.map((a) => a.id)),
  })
  const withholding = await readWithholdingBlock(tx, {
    fiscalYearStart: start,
    fiscalYearEnd: end,
    refDate: opts.refDate,
  })
  const cecos = await readCostCenterSettlementBlock(tx, {
    fiscalYearId: opts.fiscalYearId,
    fiscalYearStart: start,
    fiscalYearEnd: end,
    refDate: opts.refDate,
  })
  const stepEvidence: Record<string, StepEvidence> = {
    CONCILIACION_BANCARIA: { evidencia: bank.evidencia, query: bank.query },
    AMORTIZACION_AL_DIA: { evidencia: depreciation.evidencia, query: depreciation.query },
    RETENCIONES_LIQUIDADAS: { evidencia: withholding.evidencia, query: withholding.query },
    LIQUIDACION_CECOS: { evidencia: cecos.evidencia, query: cecos.query },
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

    unreconciledBankAccounts: bank.pendientes,

    pendingRecurring: closing.recurring.flatMap((r) =>
      duePeriods(r, r.generatedPeriods, opts.refDate).map((p) => ({ code: r.code, period: p.key }))
    ),
    assetsPendingDepreciation: depreciation.items,
    assetsWithoutAttribution: closing.assetsWithoutAttribution.map((a) => ({ code: a.code })),
    accrualsNotExhausted: closing.accruals
      .filter((a) => a.periodEnd <= opts.refDate && a.status === "VIVA")
      .map((a) => ({ code: a.code, pendingCents: a.totalCents })),

    fxStep,
    presentValuePending: [],
    reclassStep: reclass,
    positionsWithoutDueDate: closing.maturityPositions.filter((p) => p.dueDate === null).length,
    debtWithoutSchedule: closing.positionsWithoutSchedule.map((p) => ({
      accountCode: p.accountCode,
      balanceCents: p.balanceCents,
    })),

    unsettledVatPeriods,
    prorrataStep,
    capitalGoodsStep,
    reccPendingCents,
    withholdingPendingModels: withholding.pendientes,
    balance473Cents,

    incomeTaxEntryId: byTemplate("IMPUESTO_BENEFICIOS"),
    balance6300Cents,
    regularizacionEntryId: byTemplate("REGULARIZACION_RESULTADO"),
    cierreEntryId: byTemplate("CIERRE_EJERCICIO"),
    aperturaEntryId,

    distributionEntryId: distribution?.entryId ?? null,
    previousResultPendingCents,

    cecosPendientes: cecos.pendientes,
    i4i5: invariants.filter((c) => c.id === "I4" || c.id === "I5"),
    answers,
    stepEvidence,
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
