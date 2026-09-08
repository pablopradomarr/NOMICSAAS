/**
 * E9 · T12 — IVA: libro registro por periodo, prorrata y liquidación
 * (`docs/design/E9-cierre-recurrentes.md` §4.4 y §5.1).
 *
 * **El libro registro no se almacena** (§3.6): se deriva en E8 y E9 lo **agrupa
 * por periodo**. Aquí está esa agrupación, y está hecha con el índice que M3
 * creó: `journal_entries (organization_id, iva_period)`. Sin él, el puente
 * agrupaba en memoria —O(n) sobre el ejercicio entero— y el techo de 800 ms de
 * `/reports/vat` con 2 000 documentos era inalcanzable (§9).
 *
 * ## Las columnas «EnPeriodo» (O-14 / O-15)
 *
 * Bajo RECC el devengo va **al cobro** (art. 163 *terdecies* LIVA), así que una
 * factura tiene dos cifras distintas y las dos son ciertas:
 *
 *  · la **íntegra** (`cuotaRepercutidaCents`), que es lo que el libro anota en la
 *    expedición y lo que declaran las casillas informativas 62/63 y 74/75;
 *  · la **efectivamente devengada en el periodo**
 *    (`cuotaDevengadaEnPeriodoCents`), proporcional a lo cobrado, que es lo que
 *    declaran las casillas 01-09 y lo que el asiento mueve.
 *
 * Confundirlas es lo que rompía I-E8-15a/c e I-E9-8a: los puentes van contra
 * `Σ477 + Σ4778` y `Σ472 + Σ4728`, no contra `Σ477` a secas. El reparto
 * proporcional lo hace `reccAccrualOnCollection` (motor puro, O-15), **nunca
 * este módulo**: aquí sólo se leen los cobros del art. 61 *decies* RIVA.
 */

import { reccAccrualOnCollection, type VatBalanceRowE9, type VatBookRowE9, type VatOperationKey, type VatPeriodKind, type VatRegimePeriodRef } from "@/lib/closing/vat"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { centsFromDb, centsToDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { e9Abort } from "@/models/e9-errors"
import type { IvaRegime, VatSettlementStatus } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/** Un cobro o pago del art. 61 *decies* / *undecies* RIVA, tal cual se anota. */
export type ReccPayment = { date: LocalDate; amountCents: number; means?: string | null }

const parseReccPayments = (value: unknown): ReccPayment[] => {
  if (!Array.isArray(value)) return []
  const out: ReccPayment[] = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue
    const row = raw as { date?: unknown; amountCents?: unknown; means?: unknown }
    if (typeof row.date !== "string" || !Number.isSafeInteger(row.amountCents)) continue
    out.push({
      date: row.date,
      amountCents: row.amountCents as number,
      means: typeof row.means === "string" ? row.means : null,
    })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

// ─────────────────────────────────────────────────────────────────────────────
// Régimen fechado (D8)
// ─────────────────────────────────────────────────────────────────────────────

export async function readVatRegimePeriods(db: AnyClient): Promise<VatRegimePeriodRef[]> {
  const rows = await db.vatRegimePeriod.findMany({ orderBy: { validFrom: "asc" } })
  return rows.map((r) => ({
    regime: r.regime as VatRegimePeriodRef["regime"],
    periodKind: r.periodKind as VatPeriodKind,
    importDeferral: r.importDeferral,
    validFrom: fromUtcDate(r.validFrom),
    validTo: r.validTo ? fromUtcDate(r.validTo) : null,
  }))
}

export async function createVatRegimePeriodTx(
  tx: TenantTransactionClient,
  input: { regime: IvaRegime; periodKind: VatPeriodKind; importDeferral?: boolean; validFrom: LocalDate; validTo?: LocalDate | null; reason?: string | null },
  actor: Actor
): Promise<void> {
  if (input.importDeferral === true && input.periodKind !== "MENSUAL") {
    e9Abort(
      "VAT_REGIME_NOT_DECLARED",
      "importDeferral",
      "El diferimiento del IVA a la importación (art. 167.Dos LIVA) exige periodo MENSUAL y estar en el REDEME"
    )
  }
  const row = await tx.vatRegimePeriod.create({
    data: {
      organizationId: tx.$organizationId,
      regime: input.regime,
      periodKind: input.periodKind,
      importDeferral: input.importDeferral ?? false,
      validFrom: toUtcDate(input.validFrom),
      validTo: input.validTo ? toUtcDate(input.validTo) : null,
      reason: input.reason ?? null,
      createdById: actor.userId ?? null,
    },
  })
  await writeAuditLog(tx, {
    entity: "VatRegimePeriod",
    entityId: row.id,
    action: "SET_REGIME",
    after: { regime: input.regime, periodKind: input.periodKind, importDeferral: input.importDeferral ?? false, validFrom: input.validFrom },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// El libro registro agrupado por periodo (index scan por `iva_period`)
// ─────────────────────────────────────────────────────────────────────────────

type BookSqlRow = {
  entry_id: string
  iva_period: string
  document_date: Date
  deduction_date: Date
  operation_date: Date | null
  purchase: boolean
  doc_kind: string | null
  operation_key: string | null
  base_cents: bigint
  rate_bps: number | null
  cuota472_cents: bigint
  cuota477_cents: bigint
  cuota4728_cents: bigint
  cuota4778_cents: bigint
  investment_good: boolean
  document_total_cents: bigint
  recc_payments: unknown
  counterparty_regime: string | null
  document_number: string | null
}

/**
 * **El libro del periodo, en una consulta.** Un asiento = una anotación: las
 * cuotas salen de sus líneas de `472`/`477`/`4728`/`4778` —moneda base, con la
 * diferencia de la rectificativa ya dentro (lección H-1/H-2 de E8)— y la base,
 * de `tax_base_cents`.
 *
 * `period` acota por la **columna persistida** `journal_entries.iva_period`, que
 * es lo que hace que esto sea un *index scan* y no un barrido del ejercicio.
 */
export async function readVatBook(
  tx: TenantTransactionClient,
  opts: {
    period?: string
    year?: number
    inputVatCode: string
    outputVatCode: string
    inputPendingCode?: string
    outputPendingCode?: string
  }
): Promise<{ book: VatBookRowE9[]; balances: VatBalanceRowE9[] }> {
  const pendingIn = opts.inputPendingCode ?? `${opts.inputVatCode}8`
  const pendingOut = opts.outputPendingCode ?? `${opts.outputVatCode}8`

  const rows = await tx.$queryRaw<BookSqlRow[]>`
    SELECT e.id                                   AS entry_id,
           e.iva_period,
           COALESCE(e.document_date, e.entry_date) AS document_date,
           GREATEST(COALESCE(e.reception_date, e.entry_date), COALESCE(e.document_date, e.entry_date)) AS deduction_date,
           e.operation_date,
           COALESCE(SUM(CASE WHEN l.account_code = ${opts.inputVatCode} OR l.account_code = ${pendingIn}
                             THEN 1 ELSE 0 END), 0) > 0 AS purchase,
           t.name                                  AS doc_kind,
           t.vat_operation_key                     AS operation_key,
           COALESCE(SUM(l.tax_base_cents) FILTER (
             WHERE l.account_code IN (${opts.inputVatCode}, ${opts.outputVatCode})
           ), 0)::bigint                           AS base_cents,
           MAX(r.rate_bps)                         AS rate_bps,
           COALESCE(SUM(CASE WHEN l.account_code = ${opts.inputVatCode}  THEN l.debit_cents  - l.credit_cents ELSE 0 END), 0)::bigint AS cuota472_cents,
           COALESCE(SUM(CASE WHEN l.account_code = ${opts.outputVatCode} THEN l.credit_cents - l.debit_cents  ELSE 0 END), 0)::bigint AS cuota477_cents,
           COALESCE(SUM(CASE WHEN l.account_code = ${pendingIn}          THEN l.debit_cents  - l.credit_cents ELSE 0 END), 0)::bigint AS cuota4728_cents,
           COALESCE(SUM(CASE WHEN l.account_code = ${pendingOut}         THEN l.credit_cents - l.debit_cents  ELSE 0 END), 0)::bigint AS cuota4778_cents,
           COALESCE(bool_or(left(l.account_code, 1) = '2' AND l.account_code !~ '^28'), FALSE) AS investment_good,
           COALESCE(t.total, 0)::bigint            AS document_total_cents,
           COALESCE(t.recc_payments, '[]'::jsonb)  AS recc_payments,
           c.iva_regime::text                      AS counterparty_regime,
           t.name                                  AS document_number
      FROM journal_entries e
      JOIN journal_lines   l ON l.organization_id = e.organization_id AND l.entry_id = e.id
      LEFT JOIN tax_rates    r ON r.organization_id = e.organization_id AND r.id = l.tax_rate_id
      LEFT JOIN transactions t ON t.organization_id = e.organization_id AND t.journal_entry_id = e.id
      LEFT JOIN counterparties c ON c.organization_id = e.organization_id AND c.id = l.counterparty_id
     WHERE e.organization_id = ${tx.$organizationId}::uuid
       AND e.iva_period IS NOT NULL
       AND e.voided_at IS NULL
       AND (${opts.period ?? null}::text IS NULL OR e.iva_period = ${opts.period ?? null})
       AND (${opts.year ?? null}::int IS NULL OR left(e.iva_period, 4) = ${String(opts.year ?? "")})
       AND EXISTS (
         SELECT 1 FROM journal_lines v
          WHERE v.organization_id = e.organization_id AND v.entry_id = e.id
            AND v.account_code IN (${opts.inputVatCode}, ${opts.outputVatCode}, ${pendingIn}, ${pendingOut})
       )
     GROUP BY e.id, e.iva_period, e.document_date, e.entry_date, e.reception_date, e.operation_date,
              t.name, t.vat_operation_key, t.total, t.recc_payments, c.iva_regime
     ORDER BY e.iva_period, deduction_date, e.id`

  const book: VatBookRowE9[] = rows.map((r) => {
    const cuota472 = centsFromDb(r.cuota472_cents, "cuota soportada")
    const cuota477 = centsFromDb(r.cuota477_cents, "cuota repercutida")
    const cuota4728 = centsFromDb(r.cuota4728_cents, "cuota soportada pendiente RECC")
    const cuota4778 = centsFromDb(r.cuota4778_cents, "cuota repercutida pendiente RECC")
    const purchase = r.purchase || cuota472 !== 0 || cuota4728 !== 0
    const documentDate = fromUtcDate(r.document_date)
    const deductionDate = fromUtcDate(r.deduction_date)
    const recc = cuota4728 !== 0 || cuota4778 !== 0 || r.counterparty_regime === "RECC"

    // **O-14 / O-15.** La cuota íntegra de una factura RECC es la devengada más
    // la que sigue pendiente; lo devengado EN EL PERIODO es lo que el asiento
    // movió. Fuera de RECC las dos coinciden, y ahí está toda la diferencia
    // entre I-E8-15c y I-E8-15c′.
    const cuotaRepercutidaIntegra = cuota477 + cuota4778
    const cuotaSoportadaIntegra = cuota472 + cuota4728

    return {
      id: r.entry_id,
      entryId: r.entry_id,
      ivaPeriod: r.iva_period,
      tipo: purchase ? "RECIBIDAS" : "EMITIDAS",
      docKind: "FACTURA",
      operationKey: (r.operation_key as VatOperationKey | null) ?? null,
      rateBps: r.rate_bps,
      baseCents: centsFromDb(r.base_cents, "base imponible"),
      baseEnPeriodoCents: centsFromDb(r.base_cents, "base imputable al periodo"),
      cuotaTotalCents: purchase ? cuotaSoportadaIntegra : cuotaRepercutidaIntegra,
      cuotaDeducibleCents: cuotaSoportadaIntegra,
      cuotaNoDeducibleAlCosteCents: 0,
      cuotaRepercutidaCents: cuotaRepercutidaIntegra,
      cuotaDevengadaIspAibCents: 0,
      cuotaDevengadaEnPeriodoCents: cuota477,
      cuotaDeducibleEnPeriodoCents: cuota472,
      investmentGood: r.investment_good,
      deductibility: null,
      recc,
      importDeferred: false,
      documentDate,
      deductionDate,
    }
  })

  // Los saldos del diario del periodo, la otra orilla de los puentes 15a′/15c′.
  const byPeriod = new Map<string, VatBalanceRowE9>()
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const acc = byPeriod.get(r.iva_period) ?? {
      ivaPeriod: r.iva_period,
      saldo472Cents: 0,
      saldo477Cents: 0,
      saldo4728Cents: 0,
      saldo4778Cents: 0,
      byEntry: [],
    }
    const saldo472 = centsFromDb(r.cuota472_cents, "saldo 472")
    const saldo477 = centsFromDb(r.cuota477_cents, "saldo 477")
    acc.saldo472Cents += saldo472
    acc.saldo477Cents += saldo477
    acc.saldo4728Cents += centsFromDb(r.cuota4728_cents, "saldo 4728")
    acc.saldo4778Cents += centsFromDb(r.cuota4778_cents, "saldo 4778")
    ;(acc.byEntry as { entryId: string; saldo472Cents: number; saldo477Cents: number }[]).push({
      entryId: r.entry_id,
      saldo472Cents: saldo472,
      saldo477Cents: saldo477,
    })
    byPeriod.set(r.iva_period, acc)
  }

  return { book, balances: [...byPeriod.values()].sort((a, b) => (a.ivaPeriod < b.ivaPeriod ? -1 : 1)) }
}

/**
 * **O-15 · lo devengado por cobros parciales.** Los cobros del art. 61 *decies*
 * RIVA de una factura RECC, con la cuota que cada uno devenga según el motor
 * puro. Se lee aquí y se **calcula allí**: este módulo no reparte un céntimo.
 */
export type ReccAccrualRow = {
  transactionId: string
  documentNumber: string
  operationDate: LocalDate
  totalInvoiceCents: number
  totalQuotaCents: number
  payments: ReccPayment[]
  /** Cuota devengada acumulada hasta `cutoff`, según los cobros anotados. */
  accruedCents: number
}

export async function readReccAccruals(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate }
): Promise<ReccAccrualRow[]> {
  const rows = await tx.$queryRaw<
    {
      id: string
      name: string | null
      issued_at: Date | null
      total: bigint | null
      recc_payments: unknown
      quota_cents: bigint
    }[]
  >`
    SELECT t.id, t.name, t.issued_at, t.total, t.recc_payments,
           COALESCE((
             SELECT SUM(l.credit_cents - l.debit_cents + l.debit_cents - l.credit_cents) * 0
                  + SUM(ABS(l.credit_cents - l.debit_cents))
               FROM journal_lines l
              WHERE l.organization_id = t.organization_id
                AND l.entry_id = t.journal_entry_id
                AND (left(l.account_code, 4) = '4778' OR left(l.account_code, 4) = '4728')
           ), 0)::bigint AS quota_cents
      FROM transactions t
     WHERE t.organization_id = ${tx.$organizationId}::uuid
       AND t.journal_entry_id IS NOT NULL
       AND jsonb_array_length(COALESCE(t.recc_payments, '[]'::jsonb)) >= 0
       AND EXISTS (
         SELECT 1 FROM journal_lines l
          WHERE l.organization_id = t.organization_id AND l.entry_id = t.journal_entry_id
            AND (left(l.account_code, 4) = '4778' OR left(l.account_code, 4) = '4728')
       )
     ORDER BY t.issued_at NULLS LAST, t.id`

  return rows.map((r) => {
    const payments = parseReccPayments(r.recc_payments).filter((p) => p.date <= opts.cutoff)
    const totalInvoiceCents = centsFromDb(r.total ?? BigInt(0), "total de la factura")
    const totalQuotaCents = centsFromDb(r.quota_cents, "cuota pendiente RECC")
    let accrued = 0
    for (let i = 0; i < payments.length && totalInvoiceCents > 0; i++) {
      accrued += reccAccrualOnCollection({
        collectedCents: payments[i].amountCents,
        totalInvoiceCents,
        totalQuotaCents,
        alreadyAccruedCents: accrued,
        isFinal: accrued + payments[i].amountCents >= totalInvoiceCents,
      })
    }
    return {
      transactionId: r.id,
      documentNumber: r.name ?? r.id,
      operationDate: r.issued_at ? fromUtcDate(r.issued_at) : opts.cutoff,
      totalInvoiceCents,
      totalQuotaCents,
      payments,
      accruedCents: accrued,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Prorrata (arts. 104 y 105 LIVA)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-10 · numerador y denominador DERIVADOS, con las exclusiones MARCADAS.**
 *
 * El libro de emitidas del año agrupado por **clave de operación**, más el
 * recuento de documentos **sin clasificar**. Con alguno sin clave, el resultado
 * es `INFO` con su lista y **nunca un porcentaje** (el motor lo decide; aquí
 * sólo se cuenta y se nombra).
 */
export type ProrrataTermsRow = {
  operationKey: VatOperationKey | null
  baseCents: number
  documentCount: number
}

export async function readProrrataTerms(
  tx: TenantTransactionClient,
  opts: { year: number; outputVatCode: string }
): Promise<{ terms: ProrrataTermsRow[]; unclassified: { entryId: string; documentDate: LocalDate; baseCents: number }[] }> {
  const rows = await tx.$queryRaw<{ operation_key: string | null; base_cents: bigint; document_count: bigint }[]>`
    SELECT t.vat_operation_key AS operation_key,
           COALESCE(SUM(l.tax_base_cents), 0)::bigint AS base_cents,
           COUNT(DISTINCT e.id)                        AS document_count
      FROM journal_entries e
      JOIN journal_lines   l ON l.organization_id = e.organization_id AND l.entry_id = e.id
      LEFT JOIN transactions t ON t.organization_id = e.organization_id AND t.journal_entry_id = e.id
     WHERE e.organization_id = ${tx.$organizationId}::uuid
       AND e.voided_at IS NULL
       AND left(e.iva_period, 4) = ${String(opts.year)}
       AND l.account_code = ${opts.outputVatCode}
     GROUP BY t.vat_operation_key
     ORDER BY t.vat_operation_key NULLS FIRST`

  const unclassified = await tx.$queryRaw<{ entry_id: string; document_date: Date; base_cents: bigint }[]>`
    SELECT e.id AS entry_id,
           COALESCE(e.document_date, e.entry_date) AS document_date,
           COALESCE(SUM(l.tax_base_cents), 0)::bigint AS base_cents
      FROM journal_entries e
      JOIN journal_lines   l ON l.organization_id = e.organization_id AND l.entry_id = e.id
      LEFT JOIN transactions t ON t.organization_id = e.organization_id AND t.journal_entry_id = e.id
     WHERE e.organization_id = ${tx.$organizationId}::uuid
       AND e.voided_at IS NULL
       AND left(e.iva_period, 4) = ${String(opts.year)}
       AND l.account_code = ${opts.outputVatCode}
       AND t.vat_operation_key IS NULL
     GROUP BY e.id, e.document_date, e.entry_date
     ORDER BY document_date, e.id`

  return {
    terms: rows.map((r) => ({
      operationKey: (r.operation_key as VatOperationKey | null) ?? null,
      baseCents: centsFromDb(r.base_cents, "base de la clave de operación"),
      documentCount: Number(r.document_count),
    })),
    unclassified: unclassified.map((r) => ({
      entryId: r.entry_id,
      documentDate: fromUtcDate(r.document_date),
      baseCents: centsFromDb(r.base_cents, "base sin clasificar"),
    })),
  }
}

export type ProrrataYearRow = {
  id: string
  year: number
  provisionalBps: number
  definitiveBps: number | null
  numeratorCents: number | null
  denominatorCents: number | null
  prorrateableQuotaCents: number | null
  unclassifiedCount: number
  adjustmentCents: number | null
  regularizationEntryId: string | null
  regularizationPeriod: string | null
  closedAt: Date | null
}

export async function getProrrataYear(db: AnyClient, year: number): Promise<ProrrataYearRow | null> {
  const r = await db.prorrataYear.findFirst({ where: { year } })
  if (!r) return null
  return {
    id: r.id,
    year: r.year,
    provisionalBps: r.provisionalBps,
    definitiveBps: r.definitiveBps,
    numeratorCents: r.numeratorCents === null ? null : centsFromDb(r.numeratorCents, "numerador"),
    denominatorCents: r.denominatorCents === null ? null : centsFromDb(r.denominatorCents, "denominador"),
    prorrateableQuotaCents: r.prorrateableQuotaCents === null ? null : centsFromDb(r.prorrateableQuotaCents, "cuota prorrateable"),
    unclassifiedCount: r.unclassifiedCount,
    adjustmentCents: r.adjustmentCents === null ? null : centsFromDb(r.adjustmentCents, "ajuste de prorrata"),
    regularizationEntryId: r.regularizationEntryId,
    regularizationPeriod: r.regularizationPeriod,
    closedAt: r.closedAt,
  }
}

/**
 * **O-11 · I-E9-10b.** Cierra la prorrata del año: sella numerador,
 * denominador, definitiva y ajuste, con **el periodo en el que se practicó** —la
 * última declaración-liquidación del año (art. 105.Uno)— y **fija la provisional
 * de N+1 = definitiva de N** (art. 105.Dos), creando la fila de N+1 si no está.
 *
 * Las cifras vienen **calculadas del motor puro**: aquí no se divide nada.
 */
export async function closeProrrataYearTx(
  tx: TenantTransactionClient,
  input: {
    year: number
    definitiveBps: number
    numeratorCents: number
    denominatorCents: number
    prorrateableQuotaCents: number
    unclassifiedCount: number
    adjustmentCents: number
    regularizationEntryId: string
    regularizationPeriod: string
  },
  actor: Actor
): Promise<void> {
  const existing = await tx.prorrataYear.findFirst({ where: { year: input.year } })
  if (!existing) e9Abort("PRORRATA_YEAR_NOT_FOUND", "year", `No hay prorrata provisional declarada para ${input.year}`)
  if (existing.closedAt !== null) {
    e9Abort("PRORRATA_YEAR_NOT_FOUND", "year", `La prorrata de ${input.year} ya está cerrada: revertir la regularización es un contra-asiento`)
  }

  await tx.prorrataYear.update({
    where: { id: existing.id },
    data: {
      definitiveBps: input.definitiveBps,
      numeratorCents: centsToDb(input.numeratorCents, "numerador"),
      denominatorCents: centsToDb(input.denominatorCents, "denominador"),
      prorrateableQuotaCents: centsToDb(input.prorrateableQuotaCents, "cuota prorrateable"),
      unclassifiedCount: input.unclassifiedCount,
      adjustmentCents: centsToDb(input.adjustmentCents, "ajuste de prorrata"),
      regularizationEntryId: input.regularizationEntryId,
      regularizationPeriod: input.regularizationPeriod,
      closedAt: new Date(),
      closedById: actor.userId ?? null,
    },
  })

  // Art. 105.Dos: la provisional del año siguiente ES la definitiva de éste.
  const next = await tx.prorrataYear.findFirst({ where: { year: input.year + 1 } })
  if (next) {
    if (next.closedAt === null) {
      await tx.prorrataYear.update({ where: { id: next.id }, data: { provisionalBps: input.definitiveBps } })
    }
  } else {
    await tx.prorrataYear.create({
      data: { organizationId: tx.$organizationId, year: input.year + 1, provisionalBps: input.definitiveBps },
    })
  }

  await writeAuditLog(tx, {
    entity: "ProrrataYear",
    entityId: existing.id,
    action: "CLOSE_PRORRATA",
    before: { provisionalBps: existing.provisionalBps, definitiveBps: existing.definitiveBps },
    after: {
      definitiveBps: input.definitiveBps,
      adjustmentCents: input.adjustmentCents,
      regularizationPeriod: input.regularizationPeriod,
      provisionalNextYearBps: input.definitiveBps,
    },
    userId: actor.userId ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// La liquidación (T-23) — el ACTO, no sus cifras
// ─────────────────────────────────────────────────────────────────────────────

export type VatSettlementRow = {
  id: string
  periodKind: VatPeriodKind
  period: string
  periodStart: LocalDate
  periodEnd: LocalDate
  regime: IvaRegime
  prorrataBps: number | null
  importDeferral: boolean
  entryId: string
  outputCents: number
  inputCents: number
  carryForwardCents: number
  resultCents: number
  ledgerHash: string
  bookHash: string
  gitSha: string
  status: VatSettlementStatus
  reversedByEntryId: string | null
  settledAt: Date
}

const toSettlementRow = (r: {
  id: string
  periodKind: string
  period: string
  periodStart: Date
  periodEnd: Date
  regime: string
  prorrataBps: number | null
  importDeferral: boolean
  entryId: string
  outputCents: bigint
  inputCents: bigint
  carryForwardCents: bigint
  resultCents: bigint
  ledgerHash: string
  bookHash: string
  gitSha: string
  status: string
  reversedByEntryId: string | null
  settledAt: Date
}): VatSettlementRow => ({
  id: r.id,
  periodKind: r.periodKind as VatPeriodKind,
  period: r.period,
  periodStart: fromUtcDate(r.periodStart),
  periodEnd: fromUtcDate(r.periodEnd),
  regime: r.regime as IvaRegime,
  prorrataBps: r.prorrataBps,
  importDeferral: r.importDeferral,
  entryId: r.entryId,
  outputCents: centsFromDb(r.outputCents, "IVA repercutido de la liquidación"),
  inputCents: centsFromDb(r.inputCents, "IVA soportado de la liquidación"),
  carryForwardCents: centsFromDb(r.carryForwardCents, "cuota a compensar"),
  resultCents: centsFromDb(r.resultCents, "resultado de la liquidación"),
  ledgerHash: r.ledgerHash,
  bookHash: r.bookHash,
  gitSha: r.gitSha,
  status: r.status as VatSettlementStatus,
  reversedByEntryId: r.reversedByEntryId,
  settledAt: r.settledAt,
})

export async function listVatSettlements(db: AnyClient, opts: { period?: string; liveOnly?: boolean } = {}): Promise<VatSettlementRow[]> {
  const rows = await db.vatSettlement.findMany({
    where: { ...(opts.period ? { period: opts.period } : {}), ...(opts.liveOnly ? { status: "LIQUIDADA" as VatSettlementStatus } : {}) },
    orderBy: [{ period: "asc" }, { settledAt: "asc" }],
  })
  return rows.map(toSettlementRow)
}

/** **B-6, barrera 1.** ¿Este periodo de IVA tiene una liquidación viva? */
export async function isPeriodSettled(db: AnyClient, period: string): Promise<boolean> {
  const count = await db.vatSettlement.count({ where: { period, status: "LIQUIDADA" as VatSettlementStatus } })
  return count > 0
}

export type VatSettlementInput = {
  periodKind: VatPeriodKind
  period: string
  periodStart: LocalDate
  periodEnd: LocalDate
  regime: IvaRegime
  prorrataBps?: number | null
  importDeferral?: boolean
  entryId: string
  outputCents: number
  inputCents: number
  carryForwardCents?: number
  resultCents: number
  ledgerHash: string
  bookHash: string
  gitSha: string
}

/**
 * Sella la liquidación. Las cuatro cifras son **evidencia recomputable**
 * —patrón de `recognizedDifferenceCents` en E7 ronda 2— e **I-E9-9** las
 * recalcula: alterarlas por SQL da FAIL nombrando el periodo (criterio 37).
 *
 * El índice único **parcial** `WHERE status = 'LIQUIDADA'` (G-8) es lo que
 * impide dos liquidaciones vivas del mismo periodo; aquí se dice antes y con el
 * mensaje que la UI enseña.
 */
export async function createVatSettlementTx(
  tx: TenantTransactionClient,
  input: VatSettlementInput,
  actor: Actor
): Promise<VatSettlementRow> {
  if (await isPeriodSettled(tx, input.period)) {
    e9Abort(
      "VAT_PERIOD_ALREADY_SETTLED",
      "period",
      `El periodo ${input.period} ya está liquidado: registre la factura en el periodo corriente o revierta la liquidación`
    )
  }
  const row = await tx.vatSettlement.create({
    data: {
      organizationId: tx.$organizationId,
      periodKind: input.periodKind,
      period: input.period,
      periodStart: toUtcDate(input.periodStart),
      periodEnd: toUtcDate(input.periodEnd),
      regime: input.regime,
      prorrataBps: input.prorrataBps ?? null,
      importDeferral: input.importDeferral ?? false,
      entryId: input.entryId,
      outputCents: centsToDb(input.outputCents, "IVA repercutido"),
      inputCents: centsToDb(input.inputCents, "IVA soportado"),
      carryForwardCents: centsToDb(input.carryForwardCents ?? 0, "cuota a compensar"),
      resultCents: centsToDb(input.resultCents, "resultado de la liquidación"),
      ledgerHash: input.ledgerHash,
      bookHash: input.bookHash,
      gitSha: input.gitSha,
      settledById: actor.userId ?? null,
    },
  })
  await writeAuditLog(tx, {
    entity: "VatSettlement",
    entityId: row.id,
    action: "SETTLE_VAT",
    after: {
      period: input.period,
      regime: input.regime,
      outputCents: input.outputCents,
      inputCents: input.inputCents,
      resultCents: input.resultCents,
      entryId: input.entryId,
      ledgerHash: input.ledgerHash,
    },
    userId: actor.userId ?? null,
  })
  return toSettlementRow(row)
}

/**
 * Revertir es **contra-asiento** (nunca borrado): la fila pasa a `REVERTIDA`,
 * guarda quién y por qué, y **libera B-6** para que el periodo vuelva a admitir
 * asientos de IVA.
 */
export async function reverseVatSettlementTx(
  tx: TenantTransactionClient,
  input: { period: string; reversalEntryId: string; reason: string },
  actor: Actor
): Promise<void> {
  const row = await tx.vatSettlement.findFirst({ where: { period: input.period, status: "LIQUIDADA" as VatSettlementStatus } })
  if (!row) e9Abort("VAT_SETTLEMENT_NOT_FOUND", "period", `No hay liquidación viva del periodo ${input.period}`)
  await tx.vatSettlement.update({
    where: { id: row.id },
    data: { status: "REVERTIDA", reversedByEntryId: input.reversalEntryId, reverseReason: input.reason },
  })
  await writeAuditLog(tx, {
    entity: "VatSettlement",
    entityId: row.id,
    action: "REVERSE_VAT_SETTLEMENT",
    before: { period: row.period, status: "LIQUIDADA", entryId: row.entryId },
    after: { status: "REVERTIDA", reversedByEntryId: input.reversalEntryId },
    reason: input.reason,
    userId: actor.userId ?? null,
  })
}
