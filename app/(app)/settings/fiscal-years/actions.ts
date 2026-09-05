"use server"

/**
 * E3 · T9 — Server actions de ejercicios y bloqueo de periodos (§4.2).
 *
 * Todas son **ADMIN** salvo la lectura. No existe `reopenFiscalYearAction`:
 * reabrir un ejercicio cerrado equivale a reformular cuentas anuales ya rendidas
 * (arts. 253, 272 y 279 LSC). Lo que llega tarde se registra con T-22.
 */

import {
  closeFiscalYearSchema,
  createFiscalYearSchema,
  lockPeriodSchema,
  unlockPeriodSchema,
} from "@/forms/fiscal-years"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import type { Cents } from "@/lib/ledger/types"
import {
  closeFiscalYear,
  CloseFiscalYearResult,
  getFiscalYearBalances,
  listFiscalYears,
  openFiscalYear,
} from "@/models/fiscal-years"
import { formatLedgerErrors } from "@/models/ledger"
import { listPeriodLocks, lockPeriod, unlockPeriod } from "@/models/period-locks"
import { FiscalYear, PeriodLock, Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const FISCAL_YEARS_PATH = "/settings/fiscal-years"

function invalid(error: z.ZodError): ActionState<never> {
  return { success: false, error: error.issues[0]?.message ?? "Datos inválidos" }
}

export type FiscalYearsView = { fiscalYears: FiscalYear[]; locks: PeriodLock[] }

/** Ejercicios y su rejilla de meses. VIEWER (el diario es de lectura pública). */
export async function listFiscalYearsAction(): Promise<ActionState<FiscalYearsView>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const data = await tenantTransaction(org.id, user.id, async (tx) => ({
      fiscalYears: await listFiscalYears(tx),
      locks: await listPeriodLocks(tx),
    }))
    return { success: true, data }
  })()
}

/** Alta de ejercicio (se admite el irregular; sin solapes). ADMIN. */
export async function createFiscalYearAction(input: unknown): Promise<ActionState<FiscalYear>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createFiscalYearSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await openFiscalYear(org.id, validated.data, { userId: user.id })
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(FISCAL_YEARS_PATH)
    return { success: true, data: result.value }
  })()
}

/**
 * Cierre del ejercicio (B-4): regularización T-26, cierre T-27, apertura T-28
 * del siguiente, los doce meses bloqueados y los invariantes en PASS, todo en
 * una transacción. **No hay reapertura**: la UI debe avisarlo antes.
 */
export async function closeFiscalYearAction(input: unknown): Promise<ActionState<CloseFiscalYearResult>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = closeFiscalYearSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await closeFiscalYear(
      org.id,
      validated.data.fiscalYearId,
      { userId: user.id },
      validated.data.reason
    )
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(FISCAL_YEARS_PATH)
    revalidatePath("/ledger")
    return { success: true, data: result.value }
  })()
}

/** B-2 · bloqueo secuencial de un mes. ADMIN. */
export async function lockPeriodAction(input: unknown): Promise<ActionState<PeriodLock>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = lockPeriodSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await lockPeriod(
      org.id,
      {
        fiscalYearId: validated.data.fiscalYearId,
        month: validated.data.month,
        reason: validated.data.reason ?? null,
      },
      { userId: user.id }
    )
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(FISCAL_YEARS_PATH)
    return { success: true, data: result.value }
  })()
}

/** B-3 · desbloquear el mes *n* arrastra *n+1…12*. ADMIN, motivo obligatorio. */
export async function unlockPeriodAction(input: unknown): Promise<ActionState<{ unlocked: number[] }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = unlockPeriodSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await unlockPeriod(org.id, validated.data, { userId: user.id })
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(FISCAL_YEARS_PATH)
    return { success: true, data: result.value }
  })()
}

/** Vista previa de los saldos que cerrará T-26/T-27. VIEWER. */
export async function getFiscalYearBalancesAction(
  fiscalYearId: string
): Promise<ActionState<{ accountCode: string; balanceCents: Cents }[]>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const balances = await getFiscalYearBalances(org.id, fiscalYearId, { userId: user.id })
    return {
      success: true,
      data: [...balances.entries()]
        .map(([accountCode, balanceCents]) => ({ accountCode, balanceCents }))
        .sort((a, b) => (a.accountCode < b.accountCode ? -1 : 1)),
    }
  })()
}
