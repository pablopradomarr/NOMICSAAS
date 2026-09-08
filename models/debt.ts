/**
 * E9 · T12 — Cuadros de deuda y **desglose de vencimientos**
 * (`docs/design/E9-cierre-recurrentes.md` §3.2, §4.5 y **O-6**).
 *
 * `debt_schedules` / `debt_installments` son la **excepción declarada** a «nada
 * derivable se almacena» (§3.6): el cuadro de un préstamo no se deriva de la
 * deuda, es un dato del contrato que el banco entrega. Y es precisamente su
 * ausencia lo que O-6 identifica como el defecto que deja el balance mal
 * clasificado: un `170` sin `dueDate` presenta **cero** en «Deudas con entidades
 * de crédito a corto plazo» teniendo préstamos vivos.
 *
 * De ahí las dos funciones que importan:
 *
 *  · `readMaturities` — los vencimientos de principal por deuda, agregados en
 *    SQL, que es lo que alimenta la reclasificación (T-32) y el devengo por tipo
 *    efectivo de un `Accrual` (R-PE-6).
 *  · `readPositionsWithoutSchedule` — las posiciones vivas de `17x`/`52x` **sin
 *    desglose**. No es una lista informativa: con una sola,
 *    `RECLASIFICACION_VENCIMIENTOS` sale **FAIL bloqueante** y el cierre no
 *    avanza (**I-E9-25**).
 */

import { createHash } from "node:crypto"

import type { DebtInstallmentRef } from "@/lib/closing/accrual"
import type { TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { centsFromDb, centsToDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { e9Abort } from "@/models/e9-errors"

export type DebtScheduleRow = {
  id: string
  code: string
  name: string
  longAccountCode: string
  shortAccountCode: string
  counterpartyId: string | null
  principalCents: number
  currency: string
  monthlyRateMicroBps: number | null
  startDate: LocalDate
  entryId: string | null
  scheduleHash: string
  installments: DebtInstallmentRef[]
}

/**
 * sha256 canónico del cuadro **sellado**: `seq|dueDate|principal|interest` por
 * línea, en orden de `seq`. Es lo que permite decir que el cuadro de hoy es el
 * que el banco entregó, y no uno reescrito después.
 */
export function debtScheduleHashOf(installments: readonly DebtInstallmentRef[]): string {
  const canonical = [...installments]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => `${i.seq}|${i.dueDate}|${i.principalCents}|${i.interestCents}`)
    .join("\n")
  return createHash("sha256").update(canonical).digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

type ScheduleSqlRow = {
  id: string
  code: string
  name: string
  long_account_code: string
  short_account_code: string
  counterparty_id: string | null
  principal_cents: bigint
  currency: string
  monthly_rate_micro_bps: number | null
  start_date: Date
  entry_id: string | null
  schedule_hash: string
  installments: { seq: number; due_date: string; principal_cents: string; interest_cents: string }[] | null
}

/**
 * Cuadros + vencimientos en **una** consulta (`LEFT JOIN LATERAL` con
 * `json_agg`). Con cuatro préstamos y 240 vencimientos, una consulta; nunca una
 * por préstamo.
 */
export async function readDebtSchedules(
  tx: TenantTransactionClient,
  opts: { debtScheduleId?: string; accountCodes?: readonly string[] } = {}
): Promise<DebtScheduleRow[]> {
  const codes = opts.accountCodes ? [...opts.accountCodes] : null
  const rows = await tx.$queryRaw<ScheduleSqlRow[]>`
    SELECT d.id, d.code, d.name, d.long_account_code, d.short_account_code, d.counterparty_id,
           d.principal_cents, d.currency, d.monthly_rate_micro_bps, d.start_date, d.entry_id,
           d.schedule_hash, i.installments
      FROM debt_schedules d
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'seq', x.seq, 'due_date', to_char(x.due_date, 'YYYY-MM-DD'),
                 'principal_cents', x.principal_cents::text, 'interest_cents', x.interest_cents::text
               ) ORDER BY x.seq) AS installments
          FROM debt_installments x
         WHERE x.organization_id = d.organization_id AND x.debt_schedule_id = d.id
      ) i ON TRUE
     WHERE d.organization_id = ${tx.$organizationId}::uuid
       AND (${opts.debtScheduleId ?? null}::uuid IS NULL OR d.id = ${opts.debtScheduleId ?? null}::uuid)
       AND (${codes}::text[] IS NULL
            OR d.long_account_code = ANY(${codes}::text[])
            OR d.short_account_code = ANY(${codes}::text[]))
     ORDER BY d.code`
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    longAccountCode: r.long_account_code,
    shortAccountCode: r.short_account_code,
    counterpartyId: r.counterparty_id,
    principalCents: centsFromDb(r.principal_cents, "principal del préstamo"),
    currency: r.currency,
    monthlyRateMicroBps: r.monthly_rate_micro_bps,
    startDate: fromUtcDate(r.start_date),
    entryId: r.entry_id,
    scheduleHash: r.schedule_hash,
    installments: (r.installments ?? []).map((i) => ({
      seq: i.seq,
      dueDate: i.due_date,
      principalCents: centsFromDb(BigInt(i.principal_cents), "principal del vencimiento"),
      interestCents: centsFromDb(BigInt(i.interest_cents), "interés del vencimiento"),
    })),
  }))
}

/**
 * **Los vencimientos de principal por deuda**, agregados en SQL y partidos por
 * el corte: lo que vence **dentro** del umbral es corriente y lo que vence
 * después, no corriente. Es la materia prima de T-32 y de I-E9-16.
 */
export type MaturityRow = {
  debtScheduleId: string
  code: string
  longAccountCode: string
  shortAccountCode: string
  counterpartyId: string | null
  currency: string
  /** Principal que vence en `(cutoff, cutoff + thresholdMonths]` — corriente. */
  shortTermCents: number
  /** Principal que vence más allá del umbral — no corriente. */
  longTermCents: number
  /** Principal ya vencido a la fecha de corte y todavía en el cuadro. */
  overdueCents: number
  /** El primer vencimiento pendiente, para enseñarlo en la evidencia. */
  nextDueDate: LocalDate | null
}

export async function readMaturities(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; thresholdMonths?: number }
): Promise<MaturityRow[]> {
  const months = opts.thresholdMonths ?? 12
  const rows = await tx.$queryRaw<
    {
      debt_schedule_id: string
      code: string
      long_account_code: string
      short_account_code: string
      counterparty_id: string | null
      currency: string
      short_term_cents: bigint
      long_term_cents: bigint
      overdue_cents: bigint
      next_due_date: Date | null
    }[]
  >`
    SELECT d.id                                  AS debt_schedule_id,
           d.code, d.long_account_code, d.short_account_code, d.counterparty_id, d.currency,
           COALESCE(SUM(i.principal_cents) FILTER (
             WHERE i.due_date >  ${toUtcDate(opts.cutoff)}::date
               AND i.due_date <= (${toUtcDate(opts.cutoff)}::date + make_interval(months => ${months}))
           ), 0)::bigint                          AS short_term_cents,
           COALESCE(SUM(i.principal_cents) FILTER (
             WHERE i.due_date > (${toUtcDate(opts.cutoff)}::date + make_interval(months => ${months}))
           ), 0)::bigint                          AS long_term_cents,
           COALESCE(SUM(i.principal_cents) FILTER (WHERE i.due_date <= ${toUtcDate(opts.cutoff)}::date), 0)::bigint
                                                  AS overdue_cents,
           MIN(i.due_date) FILTER (WHERE i.due_date > ${toUtcDate(opts.cutoff)}::date) AS next_due_date
      FROM debt_schedules d
      LEFT JOIN debt_installments i
        ON i.organization_id = d.organization_id AND i.debt_schedule_id = d.id
     WHERE d.organization_id = ${tx.$organizationId}::uuid
     GROUP BY d.id, d.code, d.long_account_code, d.short_account_code, d.counterparty_id, d.currency
     ORDER BY d.code`
  return rows.map((r) => ({
    debtScheduleId: r.debt_schedule_id,
    code: r.code,
    longAccountCode: r.long_account_code,
    shortAccountCode: r.short_account_code,
    counterpartyId: r.counterparty_id,
    currency: r.currency,
    shortTermCents: centsFromDb(r.short_term_cents, "principal a corto plazo"),
    longTermCents: centsFromDb(r.long_term_cents, "principal a largo plazo"),
    overdueCents: centsFromDb(r.overdue_cents, "principal vencido"),
    nextDueDate: r.next_due_date ? fromUtcDate(r.next_due_date) : null,
  }))
}

/**
 * **O-6 · I-E9-25 · el FAIL bloqueante.** Posiciones vivas de `17x`/`52x` —o de
 * las cuentas que se le pasen— **sin `DebtSchedule` que las explique**.
 *
 * Se compara por cuenta y contraparte: un préstamo dado de alta por T-37 deja su
 * `long_account_code` / `short_account_code` en el cuadro, así que una posición
 * cuya cuenta no aparece en ningún cuadro es exactamente la que nadie ha
 * desglosado. Con una sola, el cierre **no avanza**.
 */
export type PositionWithoutScheduleRow = {
  accountCode: string
  counterpartyId: string | null
  balanceCents: number
}

export async function readPositionsWithoutSchedule(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; accountPrefixes?: readonly string[] }
): Promise<PositionWithoutScheduleRow[]> {
  const prefixes = [...(opts.accountPrefixes ?? ["17", "52"])]
  const rows = await tx.$queryRaw<{ account_code: string; counterparty_id: string | null; balance_cents: bigint }[]>`
    SELECT l.account_code, l.counterparty_id,
           SUM(l.credit_cents - l.debit_cents)::bigint AS balance_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
       AND l.entry_kind <> 'CLOSING'
       AND left(l.account_code, 2) = ANY(${prefixes}::text[])
       AND NOT EXISTS (
         SELECT 1 FROM debt_schedules d
          WHERE d.organization_id = l.organization_id
            AND (d.long_account_code = l.account_code OR d.short_account_code = l.account_code)
       )
     GROUP BY l.account_code, l.counterparty_id
    HAVING SUM(l.credit_cents - l.debit_cents) <> 0
     ORDER BY l.account_code`
  return rows.map((r) => ({
    accountCode: r.account_code,
    counterpartyId: r.counterparty_id,
    balanceCents: centsFromDb(r.balance_cents, "posición sin desglose"),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────────────────────

export type DebtScheduleInput = {
  code: string
  name: string
  longAccountCode: string
  shortAccountCode: string
  counterpartyId?: string | null
  principalCents: number
  currency?: string
  monthlyRateMicroBps?: number | null
  startDate: LocalDate
  entryId?: string | null
  installments: readonly DebtInstallmentRef[]
}

/**
 * **G-17.** `Σ principal = principal_cents` y `seq` correlativo **sin huecos**.
 * El CHECK diferido lo repite en la base; esto lo dice antes y con el número.
 */
export async function createDebtScheduleTx(
  tx: TenantTransactionClient,
  input: DebtScheduleInput,
  actor: Actor
): Promise<DebtScheduleRow> {
  const installments = [...input.installments].sort((a, b) => a.seq - b.seq)
  const sumPrincipal = installments.reduce((a, i) => a + i.principalCents, 0)
  if (sumPrincipal !== input.principalCents) {
    e9Abort(
      "DEBT_SCHEDULE_UNBALANCED",
      "installments",
      `Σ principal del cuadro ${sumPrincipal} c ≠ principal declarado ${input.principalCents} c (G-17)`
    )
  }
  for (let i = 0; i < installments.length; i++) {
    if (installments[i].seq !== i + 1) {
      e9Abort("DEBT_SCHEDULE_UNBALANCED", "installments", `La secuencia de vencimientos tiene un hueco en ${i + 1} (G-17)`)
    }
  }

  const scheduleHash = debtScheduleHashOf(installments)
  const row = await tx.debtSchedule.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      longAccountCode: input.longAccountCode,
      shortAccountCode: input.shortAccountCode,
      counterpartyId: input.counterpartyId ?? null,
      principalCents: centsToDb(input.principalCents, "principal del préstamo"),
      currency: input.currency ?? "EUR",
      monthlyRateMicroBps: input.monthlyRateMicroBps ?? null,
      startDate: toUtcDate(input.startDate),
      entryId: input.entryId ?? null,
      scheduleHash,
    },
  })
  await tx.debtInstallment.createMany({
    data: installments.map((i) => ({
      organizationId: tx.$organizationId,
      debtScheduleId: row.id,
      seq: i.seq,
      dueDate: toUtcDate(i.dueDate),
      principalCents: centsToDb(i.principalCents, "principal del vencimiento"),
      interestCents: centsToDb(i.interestCents, "interés del vencimiento"),
    })),
  })

  await writeAuditLog(tx, {
    entity: "DebtSchedule",
    entityId: row.id,
    action: "create",
    after: {
      code: input.code,
      principalCents: input.principalCents,
      installments: installments.length,
      scheduleHash,
    },
    userId: actor.userId ?? null,
  })

  const [created] = await readDebtSchedules(tx, { debtScheduleId: row.id })
  if (!created) e9Abort("DEBT_SCHEDULE_NOT_FOUND", "id", "El cuadro recién creado no es legible en esta transacción")
  return created
}

/** Enlaza el cuadro con su asiento de alta (T-37) una vez posteado. */
export async function linkDebtScheduleEntryTx(
  tx: TenantTransactionClient,
  input: { debtScheduleId: string; entryId: string },
  actor: Actor
): Promise<void> {
  const row = await tx.debtSchedule.findFirst({ where: { id: input.debtScheduleId }, select: { id: true, entryId: true } })
  if (!row) e9Abort("DEBT_SCHEDULE_NOT_FOUND", "debtScheduleId", "El cuadro de deuda no existe en esta organización")
  await tx.debtSchedule.update({ where: { id: input.debtScheduleId }, data: { entryId: input.entryId } })
  await writeAuditLog(tx, {
    entity: "DebtSchedule",
    entityId: input.debtScheduleId,
    action: "update",
    before: { entryId: row.entryId },
    after: { entryId: input.entryId },
    userId: actor.userId ?? null,
  })
}
