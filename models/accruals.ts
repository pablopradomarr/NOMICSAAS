/**
 * E9 · T12 — Periodificaciones 480 / 485 / 567 / 568
 * (`docs/design/E9-cierre-recurrentes.md` §4.3 y §5.1).
 *
 * El cuadro **no se almacena**: es `accrualSchedule` (T7). Aquí se guarda su
 * `scheduleHash` y se leen los datos que el motor necesita — incluido, cuando
 * `basis = TIPO_EFECTIVO`, **el cuadro del préstamo** (O-25/R-PE-6): el devengo
 * de los intereses de una deuda con principal decreciente lo aporta su cuadro,
 * no un reparto lineal.
 *
 * `I-E9-7` compara `Σ saldos de 480/485/567/568` con `Σ pendiente de devengo de
 * los Accrual vivos`; `readAccrualBalances` le da el primer término **agregado
 * en SQL**, que es la única forma de que la comparación sea barata sobre un
 * ejercicio completo.
 */

import type { AccrualBasis, AccrualKind, AccrualRef, AccrualStatus } from "@/lib/closing/accrual"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { centsFromDb, centsToDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { readDebtSchedules } from "@/models/debt"
import { e9Abort } from "@/models/e9-errors"

type AnyClient = TenantClient | TenantTransactionClient

export type AccrualRow = AccrualRef & {
  status: AccrualStatus
  debtScheduleId: string | null
  sourceEntryId: string | null
  scheduleHash: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Periodificaciones + **el cuadro de la deuda de las que lo necesitan**, sin
 * N+1: una consulta para los `Accrual` y **una** para todos los cuadros
 * implicados (no una por periodificación).
 */
export async function readAccruals(
  tx: TenantTransactionClient,
  opts: { status?: AccrualStatus; accrualId?: string; liveAt?: LocalDate } = {}
): Promise<AccrualRow[]> {
  const rows = await tx.accrual.findMany({
    where: {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.accrualId ? { id: opts.accrualId } : {}),
      ...(opts.liveAt ? { periodStart: { lte: toUtcDate(opts.liveAt) } } : {}),
    },
    orderBy: { code: "asc" },
  })
  if (rows.length === 0) return []

  const scheduleIds = [...new Set(rows.map((r) => r.debtScheduleId).filter((id): id is string => id !== null))]
  const schedules = new Map<string, Awaited<ReturnType<typeof readDebtSchedules>>[number]>()
  for (const id of scheduleIds) {
    // Lecturas EN SERIE dentro de la transacción (regla de E6-perf): dentro de
    // una transacción se comparte una sola conexión y `Promise.all` sólo emite
    // el aviso de «client is already executing a query» sin ganar nada.
    const [schedule] = await readDebtSchedules(tx, { debtScheduleId: id })
    if (schedule) schedules.set(id, schedule)
  }

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind as AccrualKind,
    accrualAccountCode: r.accrualAccountCode,
    pnlAccountCode: r.pnlAccountCode,
    totalCents: centsFromDb(r.totalCents, "total de la periodificación"),
    periodStart: fromUtcDate(r.periodStart),
    periodEnd: fromUtcDate(r.periodEnd),
    basis: r.basis as AccrualBasis,
    debtInstallments: r.debtScheduleId ? (schedules.get(r.debtScheduleId)?.installments ?? []) : undefined,
    projectId: r.projectId,
    costCenterId: r.costCenterId,
    status: r.status as AccrualStatus,
    debtScheduleId: r.debtScheduleId,
    sourceEntryId: r.sourceEntryId,
    scheduleHash: r.scheduleHash,
  }))
}

/**
 * **I-E9-7 · el primer término.** Saldos del diario de las cuentas de
 * periodificación al corte, agregados en SQL por cuenta. `480`/`567` son
 * **deudoras** (debe − haber) y `485`/`568` **acreedoras** (haber − debe): el
 * signo lo pone la consulta, no el llamante.
 */
export type AccrualBalanceRow = { accountCode: string; balanceCents: number }

export async function readAccrualBalances(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; accountPrefixes?: readonly string[] }
): Promise<AccrualBalanceRow[]> {
  const prefixes = [...(opts.accountPrefixes ?? ["480", "485", "567", "568"])]
  const rows = await tx.$queryRaw<{ account_code: string; balance_cents: bigint }[]>`
    SELECT l.account_code,
           SUM(CASE WHEN left(l.account_code, 3) IN ('480', '567')
                    THEN l.debit_cents - l.credit_cents
                    ELSE l.credit_cents - l.debit_cents END)::bigint AS balance_cents
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
       AND l.entry_kind <> 'CLOSING'
       AND left(l.account_code, 3) = ANY(${prefixes}::text[])
     GROUP BY l.account_code
     ORDER BY l.account_code`
  return rows.map((r) => ({
    accountCode: r.account_code,
    balanceCents: centsFromDb(r.balance_cents, "saldo de periodificación"),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────────────────────

export type AccrualInput = {
  code: string
  name: string
  kind: AccrualKind
  accrualAccountCode: string
  pnlAccountCode: string
  totalCents: number
  periodStart: LocalDate
  periodEnd: LocalDate
  basis?: AccrualBasis
  debtScheduleId?: string | null
  projectId?: string | null
  costCenterId?: string | null
  sourceEntryId?: string | null
  /** El hash del cuadro vigente, calculado por `accrualScheduleHashOf` (T7). */
  scheduleHash: string
}

export async function createAccrualTx(tx: TenantTransactionClient, input: AccrualInput, actor: Actor): Promise<AccrualRow> {
  if ((input.basis ?? "MESES") === "TIPO_EFECTIVO" && !input.debtScheduleId) {
    e9Abort(
      "DEBT_SCHEDULE_NOT_FOUND",
      "debtScheduleId",
      "Con `basis = TIPO_EFECTIVO` el devengo lo aporta el cuadro del préstamo: falta el `DebtSchedule` (G-7, R-PE-6)"
    )
  }
  const row = await tx.accrual.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      accrualAccountCode: input.accrualAccountCode,
      pnlAccountCode: input.pnlAccountCode,
      totalCents: centsToDb(input.totalCents, "total de la periodificación"),
      periodStart: toUtcDate(input.periodStart),
      periodEnd: toUtcDate(input.periodEnd),
      basis: input.basis ?? "MESES",
      debtScheduleId: input.debtScheduleId ?? null,
      projectId: input.projectId ?? null,
      costCenterId: input.costCenterId ?? null,
      sourceEntryId: input.sourceEntryId ?? null,
      scheduleHash: input.scheduleHash,
    },
  })
  await writeAuditLog(tx, {
    entity: "Accrual",
    entityId: row.id,
    action: "create",
    after: {
      code: input.code,
      kind: input.kind,
      totalCents: input.totalCents,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      basis: input.basis ?? "MESES",
      scheduleHash: input.scheduleHash,
    },
    userId: actor.userId ?? null,
  })
  const [created] = await readAccruals(tx, { accrualId: row.id })
  if (!created) e9Abort("ACCRUAL_NOT_FOUND", "id", "La periodificación recién creada no es legible en esta transacción")
  return created
}

/**
 * `AGOTADA` cuando el cuadro ha devengado todo (I-E9-6: saldo imputable **0**) y
 * `CANCELADA` con motivo. **No hay borrado**: una periodificación que desaparece
 * deja el saldo de `480`/`485` sin explicación.
 */
export async function setAccrualStatusTx(
  tx: TenantTransactionClient,
  input: { id: string; status: AccrualStatus; reason?: string | null },
  actor: Actor
): Promise<void> {
  const before = await tx.accrual.findFirst({ where: { id: input.id }, select: { status: true, code: true } })
  if (!before) e9Abort("ACCRUAL_NOT_FOUND", "id", "La periodificación no existe en esta organización")
  await tx.accrual.update({ where: { id: input.id }, data: { status: input.status } })
  await writeAuditLog(tx, {
    entity: "Accrual",
    entityId: input.id,
    action: "SET_STATUS",
    before: { status: before.status },
    after: { status: input.status },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })
}

/** Lectura simple por id, para las acciones que sólo necesitan la ficha. */
export async function getAccrual(db: AnyClient, id: string) {
  return await db.accrual.findFirst({ where: { id } })
}
