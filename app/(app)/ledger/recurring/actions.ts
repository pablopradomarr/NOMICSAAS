"use server"

/**
 * E9 · T15 — Server actions de las reglas recurrentes y las periodificaciones
 * (`docs/design/E9-cierre-recurrentes.md` §5.2).
 *
 * Tres reglas gobiernan este fichero:
 *
 * · **Matriz de roles de §10**: crear, editar, pausar y **generar** son EDITOR;
 *   revertir una ocurrencia es **ADMIN**, porque es un contra-asiento.
 * · **`dryRun` con el MISMO código que el real** (§5.2): la vista previa recorre
 *   exactamente `duePeriods → buildOccurrenceDraft`; lo único que cambia es que
 *   no se abre transacción de escritura. Una ruta de simulación aparte diverge
 *   de la real el día que alguien toca una de las dos.
 * · **Idempotencia** (R-REC-3): la ocurrencia se inserta ANTES del asiento y el
 *   índice único `(regla, periodo)` es la barrera. Dos generaciones simultáneas
 *   hasta el mismo periodo dejan 6 ocurrencias y 6 asientos, no 12.
 *
 * `refDate` («hoy») se decide **aquí**, en el borde. `lib/recurring/` no tiene reloj.
 */

import {
  createAccrualSchema,
  createRecurringSchema,
  generateOccurrencesSchema,
  listOccurrencesSchema,
  pauseRecurringSchema,
  revertOccurrenceSchema,
  setAccrualStatusSchema,
  updateRecurringSchema,
} from "@/forms/recurring"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { accrualSchedule, accrualScheduleHashOf } from "@/lib/closing/accrual"
import { depreciationSchedule } from "@/lib/closing/depreciation"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { EntryDraft, LocalDate, ResolvedLine } from "@/lib/ledger/types"
import {
  buildOccurrenceDraft,
  duePeriods,
  isSkip,
  occurrenceInputHash,
  postingDateOf,
  type PeriodKey,
  type RecurringRuleRef,
  type ScheduleRowRef,
} from "@/lib/recurring/schedule"
import { readAccruals, createAccrualTx, setAccrualStatusTx, type AccrualRow } from "@/models/accruals"
import { readAssetsWithRevisions } from "@/models/assets"
import {
  formatLedgerErrors,
  getLedgerContext,
  runLedgerTransaction,
  todayLocalDate,
  voidEntry,
  type LedgerResult,
} from "@/models/ledger"
import {
  createRecurringTx,
  listOccurrences,
  noteOccurrenceReversalTx,
  readRecurringDue,
  recordOccurrenceTx,
  setRecurringStatusTx,
  type OccurrenceOutcome,
  type RecurringDueRow,
  type RecurringOccurrenceRow,
  type RecurringRuleRow,
} from "@/models/recurring"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const RECURRING_PATH = "/ledger/recurring"

const today = (): LocalDate => todayLocalDate()

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos que la interfaz (C2/C3) consume
// ─────────────────────────────────────────────────────────────────────────────

/** Una celda del calendario de 12 columnas × N reglas (§7). */
export type OccurrenceCell = {
  period: PeriodKey
  status: "GENERADA" | "OMITIDA" | "FALLIDA" | "PENDIENTE"
  reason: string | null
  entryId: string | null
}

export type RecurringRuleSummary = {
  id: string
  code: string
  name: string
  kind: RecurringRuleRow["kind"]
  frequency: RecurringRuleRow["frequency"]
  status: RecurringRuleRow["status"]
  templateCode: string
  startPeriod: PeriodKey
  endPeriod: PeriodKey | null
  amountCents: number | null
  generatedPeriods: PeriodKey[]
  pendingPeriods: PeriodKey[]
}

/** Lo que devuelve una generación, en seco o de verdad. */
export type GeneratedOccurrence = {
  ruleCode: string
  period: PeriodKey
  status: "GENERADA" | "OMITIDA" | "FALLIDA"
  reason: string | null
  entryId: string | null
  entryNumber: number | null
  amountCents: number | null
}

export type GenerateOccurrencesResult = {
  dryRun: boolean
  upToPeriod: PeriodKey
  refDate: LocalDate
  generated: number
  omitted: number
  failed: number
  occurrences: GeneratedOccurrence[]
}

export type AccrualSummary = AccrualRow & { pendingCents: number; warnings: string[] }

// ─────────────────────────────────────────────────────────────────────────────
// Lectura (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const listRecurringAction = withOrg(
  Role.VIEWER,
  async (ctx): Promise<ActionState<RecurringRuleSummary[]>> => {
    const refDate = today()
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      readRecurringDue(tx, { includeInactive: true })
    )
    return { success: true, data: rows.map((r) => toSummary(r, refDate)) }
  }
)

export const listOccurrencesAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<RecurringOccurrenceRow[]>> => {
    const parsed = listOccurrencesSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      listOccurrences(tx, {
        recurringEntryId: parsed.data.recurringEntryId ?? undefined,
        from: parsed.data.fromPeriod ?? undefined,
        to: parsed.data.toPeriod ?? undefined,
      })
    )
    return { success: true, data: rows }
  }
)

export const listAccrualsAction = withOrg(
  Role.VIEWER,
  async (ctx): Promise<ActionState<AccrualSummary[]>> => {
    const refDate = today()
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => readAccruals(tx, {}))
    const data = rows.map((accrual) => {
      const { rows: cuadro, warnings } = accrualSchedule(accrual, "MENSUAL")
      const pending = cuadro.filter((r) => r.to > refDate).reduce((a, r) => a + r.quotaCents, 0)
      return { ...accrual, pendingCents: pending, warnings: warnings.map((w) => w.message) }
    })
    return { success: true, data }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Escritura de la regla (EDITOR)
// ─────────────────────────────────────────────────────────────────────────────

export const createRecurringAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<RecurringRuleSummary>> => {
    const parsed = createRecurringSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const refDate = today()
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const row = await createRecurringTx(
        tx,
        {
          code: v.code,
          name: v.name,
          kind: v.kind,
          templateCode: v.templateCode,
          templateInput: v.templateInput,
          amountCents: v.amountCents ?? null,
          frequency: v.freq,
          anchor: v.anchor,
          dayOfMonth: v.anchorDay ?? null,
          startPeriod: v.startPeriod,
          endPeriod: v.endPeriod ?? null,
          fixedAssetId: v.fixedAssetId ?? null,
          accrualId: v.accrualId ?? null,
        },
        { userId: ctx.user.id }
      )
      return toSummary({ ...row, generatedPeriods: [], lastPeriod: null, occurrenceCount: 0 }, refDate)
    })
    if (result.ok) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

export const updateRecurringAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = updateRecurringSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const before = await tx.recurringEntry.findFirst({ where: { id: v.id } })
      if (!before) throw new Error("La regla recurrente no existe en esta organización")
      await tx.recurringEntry.update({
        where: { id: v.id },
        data: {
          ...(v.name ? { name: v.name } : {}),
          ...(v.templateInput ? { templateInput: v.templateInput as never } : {}),
          ...(v.amountCents !== undefined ? { amountCents: v.amountCents === null ? null : BigInt(v.amountCents) } : {}),
          ...(v.endPeriod !== undefined ? { endPeriod: v.endPeriod } : {}),
        },
      })
      return { id: v.id }
    })
    if (result.ok) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

export const pauseRecurringAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = pauseRecurringSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await setRecurringStatusTx(tx, { id: v.id, status: v.status, reason: v.reason }, { userId: ctx.user.id })
      return { id: v.id }
    })
    if (result.ok) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Generación de ocurrencias (EDITOR) — `dryRun` con el MISMO código
// ─────────────────────────────────────────────────────────────────────────────

export const generateOccurrencesAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<GenerateOccurrencesResult>> => {
    const parsed = generateOccurrencesSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { upToPeriod, recurringEntryId, dryRun } = parsed.data
    const refDate = today()

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const reglas = (await readRecurringDue(tx, {})).filter((r) => !recurringEntryId || r.id === recurringEntryId)
      const out: GeneratedOccurrence[] = []

      for (const regla of reglas) {
        const source = await scheduleRowsFor(tx, regla, refDate)
        for (const period of duePeriods(regla, regla.generatedPeriods, refDate)) {
          if (period.key > upToPeriod) continue

          // El contexto se compone POR PERIODO: la fecha de referencia decide el
          // ejercicio, el bloqueo del mes y el plan vigente (E3 §2.2).
          const lctx = await getLedgerContext(tx, refDate)
          const built = buildOccurrenceDraft(regla, period, buildSource(regla, source, lctx), lctx)

          let outcome: OccurrenceOutcome
          let amountCents: number | null = null
          if (isSkip(built)) {
            outcome = {
              status: "OMITIDA",
              reason: built.skip === "CUOTA_CERO" ? "CUOTA_CERO" : "SIN_FILA_EN_CUADRO",
            }
          } else if (!built.ok) {
            outcome = { status: "FALLIDA", reason: formatLedgerErrors(built.errors as never) }
          } else {
            outcome = { status: "GENERADA", draft: built.value }
            amountCents = built.value.lines.reduce((a, l) => a + (l.debitCents ?? 0), 0)
          }

          if (dryRun) {
            out.push({
              ruleCode: regla.code,
              period: period.key,
              status: outcome.status,
              reason: outcome.status === "GENERADA" ? null : outcome.reason,
              entryId: null,
              entryNumber: null,
              amountCents,
            })
            continue
          }

          const recorded = await recordOccurrenceTx(
            tx,
            {
              rule: regla,
              period: period.key,
              postingDate: postingDateOf(period.key, regla.frequency, regla.anchor, regla.dayOfMonth),
              inputHash: occurrenceInputHash(regla, period, regla.templateInput),
              outcome,
            },
            { userId: ctx.user.id }
          )
          out.push({
            ruleCode: regla.code,
            period: period.key,
            status: recorded.status,
            reason: recorded.reason,
            entryId: recorded.entry?.id ?? null,
            entryNumber: recorded.entry?.entryNumber ?? null,
            amountCents,
          })
        }
      }

      return {
        dryRun,
        upToPeriod,
        refDate,
        generated: out.filter((o) => o.status === "GENERADA").length,
        omitted: out.filter((o) => o.status === "OMITIDA").length,
        failed: out.filter((o) => o.status === "FALLIDA").length,
        occurrences: out,
      }
    })

    if (result.ok && !dryRun) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

/**
 * **R-REC-7 · ADMIN.** Revertir es contra-asiento y motivo: la ocurrencia sigue
 * `GENERADA` apuntando al asiento anulado y el par se neutraliza solo en los
 * informes. **Nunca** se borra la fila (art. 29.1 CCom).
 */
export const revertOccurrenceAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ occurrenceId: string; reversalEntryId: string }>> => {
    const parsed = revertOccurrenceSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data

    const occurrence = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const rows = await listOccurrences(tx, {})
      return rows.find((o) => o.id === v.occurrenceId) ?? null
    })
    if (!occurrence) return { success: false, error: "La ocurrencia no existe en esta organización" }
    if (!occurrence.entryId) return { success: false, error: "La ocurrencia no generó asiento: no hay nada que anular" }

    const voided = await voidEntry(ctx.org.id, occurrence.entryId, v.reason, { userId: ctx.user.id }, {
      requestedDate: v.entryDate ?? null,
    })
    if (!voided.ok) return { success: false, error: formatLedgerErrors(voided.errors) }

    const reversalEntryId = voided.value.reversal.id
    const noted = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await noteOccurrenceReversalTx(
        tx,
        { occurrenceId: v.occurrenceId, reversalEntryId, reason: v.reason },
        { userId: ctx.user.id }
      )
      return { occurrenceId: v.occurrenceId, reversalEntryId }
    })
    if (noted.ok) revalidatePath(RECURRING_PATH)
    return toActionState(noted)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Periodificaciones (EDITOR)
// ─────────────────────────────────────────────────────────────────────────────

export const createAccrualAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string; code: string }>> => {
    const parsed = createAccrualSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const row = await createAccrualTx(
        tx,
        {
          ...v,
          debtScheduleId: v.debtScheduleId ?? null,
          // El hash del cuadro se calcula SIEMPRE aquí: heredarlo sería sellar
          // un cuadro que nadie ha derivado (I-E9-6).
          scheduleHash: accrualScheduleHashOf(accrualSchedule({ ...v, id: "pendiente" }, "MENSUAL").rows),
        },
        { userId: ctx.user.id }
      )
      return { id: row.id, code: row.code }
    })
    if (result.ok) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

export const setAccrualStatusAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = setAccrualStatusSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await setAccrualStatusTx(tx, v, { userId: ctx.user.id })
      return { id: v.id }
    })
    if (result.ok) revalidatePath(RECURRING_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

function toSummary(row: RecurringDueRow, refDate: LocalDate): RecurringRuleSummary {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    frequency: row.frequency,
    status: row.status,
    templateCode: row.templateCode,
    startPeriod: row.startPeriod,
    endPeriod: row.endPeriod ?? null,
    amountCents: row.amountCents ?? null,
    generatedPeriods: row.generatedPeriods,
    pendingPeriods: duePeriods(row, row.generatedPeriods, refDate).map((p) => p.key),
  }
}

/**
 * El cuadro del que sale la cuota: el de amortización si la regla apunta a un
 * activo, el de la periodificación si apunta a un `Accrual`. **Ninguna cifra la
 * teclea nadie** salvo en `IMPORTE_FIJO` (G-2).
 */
async function scheduleRowsFor(
  tx: Parameters<typeof readAssetsWithRevisions>[0],
  rule: RecurringRuleRow,
  refDate: LocalDate
): Promise<ScheduleRowRef[] | undefined> {
  if (rule.kind === "AMORTIZACION" && rule.fixedAssetId) {
    const [asset] = await readAssetsWithRevisions(tx, { assetId: rule.fixedAssetId, cutoff: refDate })
    if (!asset) return undefined
    return depreciationSchedule(asset.asset, asset.revisions).map((r) => ({ period: r.period, quotaCents: r.quotaCents }))
  }
  if (rule.kind === "PERIODIFICACION" && rule.accrualId) {
    const [accrual] = await readAccruals(tx, { accrualId: rule.accrualId })
    if (!accrual) return undefined
    return accrualSchedule(accrual, rule.frequency).rows.map((r) => ({ period: r.period, quotaCents: r.quotaCents }))
  }
  return undefined
}

/**
 * El puente entre la regla y su plantilla: `buildLines` compone las líneas
 * llamando a **la plantilla**, que es donde viven las cuentas. Este módulo no
 * conoce ni una.
 */
function buildSource(
  rule: RecurringRuleRow,
  rows: ScheduleRowRef[] | undefined,
  lctx: Parameters<typeof buildFromTemplate>[2]
) {
  return {
    rows,
    amountCents: rule.amountCents ?? null,
    buildLines: (amountCents: number) => {
      const built = buildFromTemplate(
        rule.templateCode as Parameters<typeof buildFromTemplate>[0],
        { ...(rule.templateInput as Record<string, unknown>), amountCents },
        lctx
      )
      return built.ok
        ? ({ ok: true as const, value: built.value.lines as ResolvedLine[] })
        : ({ ok: false as const, errors: built.errors })
    },
    description: `${rule.name}`,
  }
}

export type { EntryDraft, RecurringRuleRef }
