/**
 * E3 · T8 — Bloqueo mensual de periodos (`PeriodLock`), reglas B-1…B-5 de
 * `docs/design/E3-asientos-tipo.md` §2.4.
 *
 * La existencia de la fila ES el bloqueo: desbloquear es borrarla, y el
 * `AuditLog` guarda ambas cosas. La barrera de verdad es el trigger
 * `journal_entries_period_open` (B-5): esto es la barrera 1, la que da el
 * mensaje que la UI enseña.
 */

import { TenantClient, TenantTransactionClient, tenantTransaction } from "@/lib/db"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { LedgerResult, modelErr, modelFail, modelOk } from "@/models/ledger"
import type { PeriodLock } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

export async function listPeriodLocks(db: AnyClient, fiscalYearId?: string): Promise<PeriodLock[]> {
  return await db.periodLock.findMany({
    where: fiscalYearId ? { fiscalYearId } : {},
    orderBy: [{ fiscalYearId: "asc" }, { month: "asc" }],
  })
}

export async function lockedMonths(db: AnyClient, fiscalYearId: string): Promise<number[]> {
  const rows = await db.periodLock.findMany({ where: { fiscalYearId }, select: { month: true } })
  return rows.map((r) => r.month).sort((a, b) => a - b)
}

export type LockInput = { fiscalYearId: string; month: number; reason?: string | null }

/**
 * B-2 — bloqueo SECUENCIAL: no se bloquea el mes *n* con el *n−1* abierto, para
 * que no queden agujeros de periodo. Sólo sobre ejercicios `OPEN`.
 */
export async function lockPeriodTx(
  tx: TenantTransactionClient,
  input: LockInput,
  actor: Actor
): Promise<LedgerResult<PeriodLock>> {
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    return modelFail(modelErr("LOCK_SEQUENCE", "month", "El mes debe estar entre 1 y 12"))
  }

  const fy = await tx.fiscalYear.findFirst({ where: { id: input.fiscalYearId } })
  if (!fy) return modelFail(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
  if (fy.status === "CLOSED") {
    return modelFail(modelErr("FY_CLOSED", "fiscalYearId", `El ejercicio ${fy.code} está cerrado`))
  }

  const already = await lockedMonths(tx, input.fiscalYearId)
  if (already.includes(input.month)) {
    return modelFail(modelErr("ALREADY_LOCKED", "month", `El mes ${input.month} ya está bloqueado`))
  }
  const missing = Array.from({ length: input.month - 1 }, (_, i) => i + 1).filter((m) => !already.includes(m))
  if (missing.length > 0) {
    return modelFail(
      modelErr(
        "LOCK_SEQUENCE",
        "month",
        `El bloqueo es secuencial (B-2): antes del mes ${input.month} hay que bloquear ${missing.join(", ")}`
      )
    )
  }

  const lock = await tx.periodLock.create({
    data: {
      organizationId: tx.$organizationId,
      fiscalYearId: input.fiscalYearId,
      month: input.month,
      lockedById: actor.userId ?? null,
      reason: input.reason ?? null,
    },
  })

  await writeAuditLog(tx, {
    entity: "PeriodLock",
    entityId: lock.id,
    action: "lock",
    after: { fiscalYearId: input.fiscalYearId, fiscalYearCode: fy.code, month: input.month },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })

  return modelOk(lock)
}

export async function lockPeriod(
  organizationId: string,
  input: LockInput,
  actor: Actor
): Promise<LedgerResult<PeriodLock>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) =>
    lockPeriodTx(tx, input, actor)
  )
}

/**
 * B-3 — desbloquear el mes *n* desbloquea también *n+1…12*: no puede quedar un
 * mes abierto entre dos bloqueados. Sólo si el ejercicio sigue `OPEN` y con
 * motivo, que va al `AuditLog`.
 */
export async function unlockPeriodTx(
  tx: TenantTransactionClient,
  input: { fiscalYearId: string; month: number; reason: string },
  actor: Actor
): Promise<LedgerResult<{ unlocked: number[] }>> {
  const fy = await tx.fiscalYear.findFirst({ where: { id: input.fiscalYearId } })
  if (!fy) return modelFail(modelErr("FY_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización"))
  if (fy.status === "CLOSED") {
    return modelFail(
      modelErr(
        "FY_CLOSED",
        "fiscalYearId",
        `El ejercicio ${fy.code} está cerrado y no hay reapertura: registra el documento con T-22 en el ejercicio abierto`
      )
    )
  }

  const rows = await tx.periodLock.findMany({
    where: { fiscalYearId: input.fiscalYearId, month: { gte: input.month } },
    orderBy: { month: "asc" },
  })
  if (rows.length === 0 || !rows.some((r) => r.month === input.month)) {
    return modelFail(modelErr("LOCK_NOT_FOUND", "month", `El mes ${input.month} no está bloqueado`))
  }

  await tx.periodLock.deleteMany({ where: { fiscalYearId: input.fiscalYearId, month: { gte: input.month } } })

  const unlocked = rows.map((r) => r.month)
  await writeAuditLog(tx, {
    entity: "PeriodLock",
    entityId: input.fiscalYearId,
    action: "unlock",
    before: { fiscalYearId: input.fiscalYearId, fiscalYearCode: fy.code, lockedMonths: unlocked },
    after: { fiscalYearId: input.fiscalYearId, unlockedMonths: unlocked },
    reason: input.reason,
    userId: actor.userId ?? null,
  })

  return modelOk({ unlocked })
}

export async function unlockPeriod(
  organizationId: string,
  input: { fiscalYearId: string; month: number; reason: string },
  actor: Actor
): Promise<LedgerResult<{ unlocked: number[] }>> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) =>
    unlockPeriodTx(tx, input, actor)
  )
}
