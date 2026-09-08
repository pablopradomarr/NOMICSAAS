"use server"

/**
 * E9 · T15 — Server actions de los cuadros de deuda (§5.2, ADR-0016 D5, O-6).
 *
 * El cuadro no es un adorno documental: **sin él la parte corriente de la deuda
 * no se puede presentar**, `RECLASIFICACION_VENCIMIENTOS` sale FAIL bloqueante
 * e I-E9-25 lo recoge nombrando la posición. Por eso hay dos acciones y no una:
 * `createDebtScheduleAction` declara el cuadro (EDITOR) y `postLoanAction`
 * postea el alta por **T-37**, con una línea de `170`/`520` por vencimiento
 * (ADMIN, porque mueve efectivo).
 */

import { createDebtScheduleSchema, listDebtSchedulesSchema, postLoanSchema } from "@/forms/debt"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { EntryDraft, LocalDate } from "@/lib/ledger/types"
import {
  createDebtScheduleTx,
  linkDebtScheduleEntryTx,
  readDebtSchedules,
  readMaturities,
  readPositionsWithoutSchedule,
  type DebtScheduleRow,
  type MaturityRow,
  type PositionWithoutScheduleRow,
} from "@/models/debt"
import { formatLedgerErrors, getLedgerContext, postEntryTx, runLedgerTransaction, todayLocalDate, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const DEBT_PATH = "/settings/debt"

const today = (): LocalDate => todayLocalDate()

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos
// ─────────────────────────────────────────────────────────────────────────────

export type DebtOverview = {
  cutoff: LocalDate
  schedules: DebtScheduleRow[]
  maturities: MaturityRow[]
  /** **O-6.** Las que están bloqueando el cierre, nombradas. */
  withoutSchedule: PositionWithoutScheduleRow[]
}

export type PostLoanResult = {
  debtScheduleId: string
  entryId: string | null
  entryNumber: number | null
  draft: EntryDraft
  dryRun: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const listDebtSchedulesAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<DebtOverview>> => {
    const parsed = listDebtSchedulesSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const cutoff = parsed.data.cutoff ?? today()
    const data = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const schedules = await readDebtSchedules(tx, {})
      const maturities = await readMaturities(tx, { cutoff })
      const withoutSchedule = await readPositionsWithoutSchedule(tx, { cutoff })
      return { cutoff, schedules, maturities, withoutSchedule }
    })
    return { success: true, data }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────────────────────

export const createDebtScheduleAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string; code: string; scheduleHash: string }>> => {
    const parsed = createDebtScheduleSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const row = await createDebtScheduleTx(
        tx,
        { ...v, counterpartyId: v.counterpartyId ?? null, monthlyRateMicroBps: v.monthlyRateMicroBps ?? null },
        { userId: ctx.user.id }
      )
      return { id: row.id, code: row.code, scheduleHash: row.scheduleHash }
    })
    if (result.ok) revalidatePath(DEBT_PATH)
    return toActionState(result)
  }
)

/** **T-37.** `dryRun` devuelve el borrador con el MISMO código que postea. */
export const postLoanAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<PostLoanResult>> => {
    const parsed = postLoanSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const [schedule] = await readDebtSchedules(tx, { debtScheduleId: v.debtScheduleId })
      if (!schedule) throw new Error("El cuadro de deuda no existe en esta organización")

      const lctx = await getLedgerContext(tx, v.entryDate)
      const built = buildFromTemplate(
        "ALTA_PRESTAMO",
        {
          documentDate: v.entryDate,
          entryDate: v.entryDate,
          scheduleCode: schedule.code,
          counterpartyId: schedule.counterpartyId ?? undefined,
          longAccountCode: schedule.longAccountCode,
          shortAccountCode: schedule.shortAccountCode,
          principalCents: schedule.principalCents,
          bankAccountCode: v.cashAccountCode,
          installments: schedule.installments.map((i) => ({
            seq: i.seq,
            dueDate: i.dueDate,
            principalCents: i.principalCents,
          })),
          description: v.description ?? `Alta del préstamo ${schedule.code}`,
        },
        lctx
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))
      if (v.dryRun) {
        return { debtScheduleId: v.debtScheduleId, entryId: null, entryNumber: null, draft: built.value, dryRun: true }
      }

      const entry = await postEntryTx(tx, built.value, { userId: ctx.user.id })
      await linkDebtScheduleEntryTx(tx, { debtScheduleId: v.debtScheduleId, entryId: entry.id }, { userId: ctx.user.id })
      return {
        debtScheduleId: v.debtScheduleId,
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        draft: built.value,
        dryRun: false,
      }
    })
    if (result.ok && !v.dryRun) revalidatePath(DEBT_PATH)
    return toActionState(result)
  }
)
