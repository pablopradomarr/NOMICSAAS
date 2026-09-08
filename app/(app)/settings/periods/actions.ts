"use server"

/**
 * E9 · T15 — Server actions del bloqueo de periodos (§5.3: B-6, B-7 y B-8).
 *
 * La rejilla de `/settings/periods` es ejercicio × mes, y cada celda dice tres
 * cosas: si el mes está bloqueado, **en qué periodo de IVA cae** y **si ese
 * periodo está liquidado**. Son datos distintos y por eso hay tres barreras:
 *
 * · **B-6** un `iva_period` liquidado no admite asientos nuevos con 472/477/
 *   4728/4778 (la server action del IVA y el trigger de M5, a propósito doble:
 *   el `iva_period` **no** coincide con `entryDate` —una factura de junio
 *   recibida en octubre entra en el periodo de octubre— y `PeriodLock` no lo ve).
 * · **B-7** ejercicio `CLOSED` ⇒ ningún asiento; lo tardío entra por T-22.
 * · **B-8** desbloquear un mes de un periodo de IVA **liquidado** exige revertir
 *   antes la liquidación, con motivo. Desbloquear arrastra los posteriores (B-3).
 */

import { lockMonthSchema, unlockMonthSchema } from "@/forms/vat"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { vatPeriodOf, vatRegimeAt, type VatPeriodKind } from "@/lib/closing/vat"
import { fromUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { getFiscalYear, listFiscalYears, lockPeriod, unlockPeriod } from "@/models/fiscal-years"
import { formatLedgerErrors, type LedgerResult } from "@/models/ledger"
import { listPeriodLocks, monthsBetween } from "@/models/period-locks"
import { listVatSettlements, readVatRegimePeriods } from "@/models/vat"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const PERIODS_PATH = "/settings/periods"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos
// ─────────────────────────────────────────────────────────────────────────────

/** Una celda de la rejilla: el mes, su bloqueo y su periodo de IVA. */
export type PeriodCell = {
  month: number
  locked: boolean
  lockedAt: Date | null
  lockedById: string | null
  reason: string | null
  /** El periodo de IVA en el que cae el mes, según el régimen VIGENTE ese día. */
  ivaPeriod: string
  ivaPeriodKind: VatPeriodKind
  ivaSettled: boolean
}

export type FiscalYearGrid = {
  fiscalYearId: string
  code: string
  status: string
  accountsApprovalStatus: string
  taxFilingStatus: string
  startDate: LocalDate
  endDate: LocalDate
  months: PeriodCell[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const listPeriodGridAction = withOrg(
  Role.VIEWER,
  async (ctx): Promise<ActionState<FiscalYearGrid[]>> => {
    const data = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const years = await listFiscalYears(tx)
      const locks = await listPeriodLocks(tx)
      const regimes = await readVatRegimePeriods(tx)
      const settlements = await listVatSettlements(tx, { liveOnly: true })
      const settled = new Set(settlements.map((s) => s.period))

      return years.map((fy) => {
        const start = fromUtcDate(fy.startDate)
        const end = fromUtcDate(fy.endDate)
        const year = start.slice(0, 4)
        const months = monthsBetween(start, end).map((month) => {
          const lock = locks.find((l) => l.fiscalYearId === fy.id && l.month === month) ?? null
          const day: LocalDate = `${year}-${String(month).padStart(2, "0")}-01`
          const regime = vatRegimeAt(regimes, day)
          const kind: VatPeriodKind = regime?.periodKind ?? "TRIMESTRAL"
          const ivaPeriod = vatPeriodOf(day, kind)
          return {
            month,
            locked: lock !== null,
            lockedAt: lock?.lockedAt ?? null,
            lockedById: lock?.lockedById ?? null,
            reason: lock?.reason ?? null,
            ivaPeriod,
            ivaPeriodKind: kind,
            ivaSettled: settled.has(ivaPeriod),
          }
        })
        return {
          fiscalYearId: fy.id,
          code: fy.code,
          status: fy.status,
          accountsApprovalStatus: fy.accountsApprovalStatus,
          taxFilingStatus: fy.taxFilingStatus,
          startDate: start,
          endDate: end,
          months,
        }
      })
    })
    return { success: true, data }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Bloqueo y desbloqueo (ADMIN, siempre con motivo)
// ─────────────────────────────────────────────────────────────────────────────

export const lockPeriodAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ fiscalYearId: string; month: number }>> => {
    const parsed = lockMonthSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await lockPeriod(ctx.org.id, parsed.data, { userId: ctx.user.id })
    if (result.ok) revalidatePath(PERIODS_PATH)
    return toActionState(
      result.ok
        ? { ok: true, value: { fiscalYearId: parsed.data.fiscalYearId, month: parsed.data.month } }
        : result
    )
  }
)

/**
 * **B-8.** Antes de desbloquear se comprueba que el periodo de IVA del mes no
 * esté liquidado: si lo está, el mensaje dice **cuál es la salida** (revertir la
 * liquidación con motivo) en vez de un «no se puede».
 */
export const unlockPeriodAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ fiscalYearId: string; month: number; unlockedMonths: number[] }>> => {
    const parsed = unlockMonthSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data

    const guard = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const fy = await getFiscalYear(tx, v.fiscalYearId)
      if (!fy) return "El ejercicio no existe en esta organización"
      const year = fromUtcDate(fy.startDate).slice(0, 4)
      const day: LocalDate = `${year}-${String(v.month).padStart(2, "0")}-01`
      const regimes = await readVatRegimePeriods(tx)
      const kind: VatPeriodKind = vatRegimeAt(regimes, day)?.periodKind ?? "TRIMESTRAL"
      const period = vatPeriodOf(day, kind)
      const live = await listVatSettlements(tx, { period, liveOnly: true })
      return live.length > 0
        ? `El periodo de IVA ${period} está liquidado (B-8): revierta antes la liquidación con su motivo y vuelva a intentarlo`
        : null
    })
    if (typeof guard === "string") return { success: false, error: guard }

    const result = await unlockPeriod(ctx.org.id, v, { userId: ctx.user.id })
    if (result.ok) revalidatePath(PERIODS_PATH)
    return toActionState(
      result.ok
        ? {
            ok: true,
            value: {
              fiscalYearId: v.fiscalYearId,
              month: v.month,
              unlockedMonths: result.value.unlocked,
            },
          }
        : result
    )
  }
)
