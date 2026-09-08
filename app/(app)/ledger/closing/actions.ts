"use server"

/**
 * E9 · T15 — Server actions del asistente de cierre (§5.2, ADR-0016 D1, D9, D10).
 *
 * Lo que este fichero garantiza, y que la pantalla no puede garantizar sola:
 *
 * · **Los nueve bloqueantes se comprueban EN SERVIDOR** (D1.1, criterio 31). Que
 *   el botón esté deshabilitado es cortesía; que `closeFiscalYearE9Action`
 *   rechace es la barrera.
 * · **Recomputo antes de cerrar**: el `ClosingRun` tiene que ser `COMPROBADO` y
 *   llevar **el mismo `ledgerHash`** que el diario de ahora. Entre el checklist y
 *   el botón puede haber entrado un asiento.
 * · **Reabrir es ADMIN, motivo ≥ 30 caracteres y escribir el código** del
 *   ejercicio; con las cuentas formuladas se rechaza **ofreciendo la salida**
 *   (acuerdo de reformulación, NRV 23ª), nunca diciendo «imposible».
 * · **Al aprobar las cuentas se abre la distribución** (O-18): sin ella, `129` se
 *   arrastra y el patrimonio neto es incorrecto desde el segundo ejercicio.
 */

import {
  answerClosingStepSchema,
  closeFiscalYearE9Schema,
  distributeProfitSchema,
  getClosingRunSchema,
  postClosingStepSchema,
  reopenFiscalYearSchema,
  runClosingChecklistSchema,
  setAccountsApprovalSchema,
  setTaxFilingStatusSchema,
} from "@/forms/closing"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import {
  CLOSING_BLOCK_TEXT,
  CLOSING_ENTRY_ORDER,
  CLOSING_STEPS,
  blockingFailures,
  canCloseFiscalYear,
  type ClosingStepResult,
  type ManualAnswer,
} from "@/lib/closing/checklist"
import { distributionPlan } from "@/lib/closing/distribution"
import { buildFromTemplate } from "@/lib/ledger/templates"
import { fromUtcDate } from "@/lib/ledger/dates"
import type { AccountKey, EntryDraft, LocalDate } from "@/lib/ledger/types"
import {
  latestClosingRun,
  readAccountBalances,
  updateClosingRunTx,
  type ClosingRunRow,
  type ClosingStepRecord,
} from "@/models/closing"
import { capitalStockFor, createProfitDistributionTx, legalReserveBalance, setAccountsApprovalStatusTx, setTaxFilingStatusTx, type ApprovalResult } from "@/models/distribution"
import {
  closeFiscalYearE9,
  getFiscalYear,
  reopenFiscalYear,
  runClosingChecklist,
  type CloseFiscalYearE9Result,
  type ReopenFiscalYearResult,
} from "@/models/fiscal-years"
import { formatLedgerErrors, getLedgerContext, postEntryTx, runLedgerTransaction, todayLocalDate, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const CLOSING_PATH = "/ledger/closing"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos que la interfaz (C2) consume
// ─────────────────────────────────────────────────────────────────────────────

/** El catálogo de pasos, para que la pantalla pinte los nueve bloques vacíos. */
export type ClosingCatalog = {
  blocks: { block: string; label: string; steps: { step: string; titulo: string; norma: string | null; blocking: boolean; nature: string }[] }[]
  blockingStepCodes: string[]
  entryOrder: typeof CLOSING_ENTRY_ORDER
}

export type ClosingRunView = {
  run: ClosingRunRow | null
  catalog: ClosingCatalog
  canClose: boolean
  blockers: ClosingStepResult[]
}

export type PostClosingStepResult = {
  step: string
  dryRun: boolean
  draft: EntryDraft | null
  entryId: string | null
  entryNumber: number | null
}

export type DistributionPreview = {
  fiscalYearId: string
  meetingDate: LocalDate
  resultCents: number
  legalReserveCents: number
  voluntaryReserveCents: number
  carryForwardCents: number
  dividendCents: number
  interimDividendCents: number
  lossCarryForwardCents: number
  capitalStockCents: number
  capitalStockSource: "DIARIO" | "DECLARADO"
  warnings: string[]
  entryId: string | null
  dryRun: boolean
}

const catalog = (): ClosingCatalog => ({
  blocks: [...new Set(CLOSING_STEPS.map((s) => s.block))].map((block) => ({
    block,
    label: CLOSING_BLOCK_TEXT[block],
    steps: CLOSING_STEPS.filter((s) => s.block === block).map((s) => ({
      step: s.step,
      titulo: s.titulo,
      norma: s.norma ?? null,
      blocking: s.blocking,
      nature: s.nature,
    })),
  })),
  blockingStepCodes: CLOSING_STEPS.filter((s) => s.blocking).map((s) => s.step),
  entryOrder: CLOSING_ENTRY_ORDER,
})

// ─────────────────────────────────────────────────────────────────────────────
// Lectura y checklist (VIEWER: el asistente se puede mirar sin poder tocarlo)
// ─────────────────────────────────────────────────────────────────────────────

export const getClosingRunAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<ClosingRunView>> => {
    const parsed = getClosingRunSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const run = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      latestClosingRun(tx, parsed.data.fiscalYearId)
    )
    const steps = (run?.steps ?? []) as ClosingStepResult[]
    return {
      success: true,
      data: { run, catalog: catalog(), canClose: canCloseFiscalYear(steps).ok, blockers: blockingFailures(steps) },
    }
  }
)

/** Ejecuta los pasos y sella un `ClosingRun`. **No postea nada** (§5.2). */
export const runClosingChecklistAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<ClosingRunView>> => {
    const parsed = runClosingChecklistSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const answers: Record<string, ManualAnswer> = {}
    for (const a of parsed.data.answers) answers[a.step] = { status: a.status, note: a.note ?? null, answeredById: ctx.user.id }

    const result = await runClosingChecklist(ctx.org.id, parsed.data.fiscalYearId, { userId: ctx.user.id }, {
      refDate: parsed.data.refDate ?? undefined,
      answers,
    })
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    const steps = result.value.steps as ClosingStepResult[]
    revalidatePath(CLOSING_PATH)
    return {
      success: true,
      data: { run: result.value, catalog: catalog(), canClose: canCloseFiscalYear(steps).ok, blockers: blockingFailures(steps) },
    }
  }
)

/**
 * Responde un paso **declarado** (arqueo, existencias, diferido…). Es ADMIN
 * porque una respuesta afirmativa a `IMPUESTO_DIFERIDO_RESPONDIDO` mueve el
 * sello: el `AuditLog` tiene que decir quién la firmó.
 */
export const answerClosingStepAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<ClosingRunView>> => {
    const parsed = answerClosingStepSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const answers: Record<string, ManualAnswer> = {
      [v.step]: { status: v.status, note: v.note ?? null, answeredById: ctx.user.id },
    }
    // Las respuestas anteriores viven en el `ClosingRun`; `readChecklistInput`
    // las recupera y ésta se superpone. El checklist se recalcula ENTERO: una
    // respuesta puede mover el sello, y el sello se compone de todos los pasos.
    const result = await runClosingChecklist(ctx.org.id, v.fiscalYearId, { userId: ctx.user.id }, { answers })
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    const steps = result.value.steps as ClosingStepResult[]
    revalidatePath(CLOSING_PATH)
    return {
      success: true,
      data: { run: result.value, catalog: catalog(), canClose: canCloseFiscalYear(steps).ok, blockers: blockingFailures(steps) },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Postear un paso del cierre (ADMIN) — vista previa obligatoria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Postea **un** asiento del cierre, en el orden de O-17. Los pasos 1-4 tienen
 * acción propia —recurrentes, RECC, prorrata y liquidación de IVA viven en sus
 * pantallas— y los 9-12 los remata `closeFiscalYearE9Action` en una sola
 * transacción; aquí se cubren los **ajustes de valoración y presentación** (5, 6
 * y 7) y el **impuesto** (8), que son los que el asistente postea uno a uno.
 */
export const postClosingStepAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<PostClosingStepResult>> => {
    const parsed = postClosingStepSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const orden = CLOSING_ENTRY_ORDER.find((o) => o.paso.toUpperCase().includes(v.step.split("_")[0]))
    if (!orden?.templateCode) {
      return {
        success: false,
        error: `El paso ${v.step} no postea asiento por esta vía: los recurrentes, el RECC, la prorrata y la liquidación de IVA se postean desde su pantalla, y la regularización, el cierre y la apertura los remata el cierre del ejercicio`,
      }
    }

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const fy = await getFiscalYear(tx, v.fiscalYearId)
      if (!fy) throw new Error("El ejercicio no existe en esta organización")
      const entryDate = v.entryDate ?? fromUtcDate(fy.endDate)
      const lctx = await getLedgerContext(tx, entryDate)
      const built = buildFromTemplate(orden.templateCode as Parameters<typeof buildFromTemplate>[0], { entryDate }, lctx)
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))
      if (v.dryRun) return { step: v.step, dryRun: true, draft: built.value, entryId: null, entryNumber: null }

      const posted = await postEntryTx(tx, built.value, { userId: ctx.user.id })
      const run = await latestClosingRun(tx, v.fiscalYearId)
      if (run) {
        const steps: ClosingStepRecord[] = run.steps.map((s) =>
          s.step === v.step ? { ...s, entryId: posted.id } : s
        )
        await updateClosingRunTx(
          tx,
          { id: run.id, steps, entryIds: { [orden.runColumn]: posted.id } as never },
          { userId: ctx.user.id }
        )
      }
      return { step: v.step, dryRun: false, draft: built.value, entryId: posted.id, entryNumber: posted.entryNumber }
    })

    if (result.ok && !v.dryRun) revalidatePath(CLOSING_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Cerrar y reabrir (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export const closeFiscalYearE9Action = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<CloseFiscalYearE9Result>> => {
    const parsed = closeFiscalYearE9Schema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await closeFiscalYearE9(
      ctx.org.id,
      {
        fiscalYearId: parsed.data.fiscalYearId,
        closingRunId: parsed.data.closingRunId,
        reason: parsed.data.reason,
        refDate: parsed.data.refDate ?? undefined,
      },
      { userId: ctx.user.id }
    )
    if (result.ok) {
      revalidatePath(CLOSING_PATH)
      revalidatePath("/settings/periods")
    }
    return toActionState(result)
  }
)

export const reopenFiscalYearAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<ReopenFiscalYearResult>> => {
    const parsed = reopenFiscalYearSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await reopenFiscalYear(ctx.org.id, parsed.data, { userId: ctx.user.id })
    if (result.ok) {
      revalidatePath(CLOSING_PATH)
      revalidatePath("/settings/periods")
    }
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Estado societario, estado fiscal y distribución del resultado (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

/** Al marcar `APROBADAS`, `requiresDistribution` abre el diálogo de T-35 (O-18). */
export const setAccountsApprovalAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<ApprovalResult>> => {
    const parsed = setAccountsApprovalSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      setAccountsApprovalStatusTx(tx, parsed.data, { userId: ctx.user.id })
    )
    if (result.ok) revalidatePath(CLOSING_PATH)
    return toActionState(result)
  }
)

export const setTaxFilingStatusAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<{ fiscalYearId: string }>> => {
    const parsed = setTaxFilingStatusSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      await setTaxFilingStatusTx(tx, parsed.data, { userId: ctx.user.id })
      return { fiscalYearId: parsed.data.fiscalYearId }
    })
    if (result.ok) revalidatePath(CLOSING_PATH)
    return toActionState(result)
  }
)

/**
 * **T-35 (O-18, R2-2).** La reserva legal **la calcula el motor** con el capital
 * derivado del saldo acreedor de `100` y **no es editable a la baja** (art. 274
 * LSC): por eso el formulario no la manda. Con `capitalStockOverrideCents` el
 * paso sale **WARN** con `CAPITAL_SOCIAL_DECLARADO` y las dos cifras a la vista.
 *
 * El asiento se postea en el **ejercicio abierto**, con la fecha de la junta.
 */
export const distributeProfitAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<DistributionPreview>> => {
    const parsed = distributeProfitSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const fy = await getFiscalYear(tx, v.fiscalYearId)
      if (!fy) throw new Error("El ejercicio no existe en esta organización")
      const cutoff = fromUtcDate(fy.endDate)

      const balances = await readAccountBalances(tx, { cutoff, prefixes: ["129"] })
      const resultCents = balances.get("129") ?? 0
      const { capital, override, check } = await capitalStockFor(tx, { meetingDate: v.meetingDate })
      const currentReserve = await legalReserveBalance(tx, { cutoff: v.meetingDate })

      // Las siete cuentas del reparto salen del PLAN, nunca del código: una
      // clave sin mapear es un error del plan y se dice con su nombre.
      const lctx0 = await getLedgerContext(tx, v.meetingDate)
      const accountOf = (key: AccountKey): string => {
        const code = lctx0.map(key)
        if (!code) throw new Error(`La clave ${key} no está mapeada en el plan de la organización (I-plan-1)`)
        return code
      }
      const plan = distributionPlan({
        resultCents,
        meetingDate: v.meetingDate,
        capital,
        currentLegalReserveCents: currentReserve,
        voluntaryReserveCents: v.voluntaryReserveCents,
        carryForwardCents: v.carryForwardCents,
        dividendCents: v.dividendCents,
        interimDividendCents: v.interimDividendCents,
        accounts: {
          resultAccountCode: accountOf("RESULTADO_EJERCICIO"),
          legalReserveAccountCode: accountOf("RESERVA_LEGAL"),
          voluntaryReserveAccountCode: accountOf("RESERVAS_VOLUNTARIAS"),
          carryForwardAccountCode: accountOf("REMANENTE"),
          dividendAccountCode: accountOf("DIVIDENDO_ACTIVO_A_PAGAR"),
          interimDividendAccountCode: accountOf("DIVIDENDO_ACTIVO_A_CUENTA"),
          lossCarryForwardAccountCode: accountOf("RESULTADOS_NEGATIVOS_ANTERIORES"),
        },
      })
      if (!plan.ok) throw new Error(formatLedgerErrors(plan.errors as never))
      const warnings = check.status === "PASS" ? [] : [check.evidencia]
      void override

      const preview: DistributionPreview = {
        fiscalYearId: v.fiscalYearId,
        meetingDate: v.meetingDate,
        resultCents: plan.value.resultCents,
        legalReserveCents: plan.value.legalReserveCents,
        voluntaryReserveCents: plan.value.voluntaryReserveCents,
        carryForwardCents: plan.value.carryForwardCents,
        dividendCents: plan.value.dividendCents,
        interimDividendCents: plan.value.interimDividendCents,
        lossCarryForwardCents: plan.value.lossCarryForwardCents,
        capitalStockCents: capital.cents,
        capitalStockSource: capital.source,
        warnings,
        entryId: null,
        dryRun: v.dryRun,
      }
      if (v.dryRun) return preview

      const built = buildFromTemplate(
        "DISTRIBUCION_RESULTADO",
        {
          entryDate: v.meetingDate,
          profitCents: Math.max(plan.value.resultCents, 0),
          lossCents: Math.max(-plan.value.resultCents, 0),
          legalReserveCents: plan.value.legalReserveCents,
          voluntaryReserveCents: plan.value.voluntaryReserveCents,
          remainderCents: plan.value.carryForwardCents,
          dividendCents: plan.value.dividendCents,
          interimDividendPaidCents: plan.value.interimDividendCents,
        },
        lctx0
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))
      const posted = await postEntryTx(tx, built.value, { userId: ctx.user.id })

      await createProfitDistributionTx(
        tx,
        { fiscalYearId: v.fiscalYearId, meetingDate: v.meetingDate, plan: plan.value, entryId: posted.id, capital },
        { userId: ctx.user.id }
      )
      return { ...preview, entryId: posted.id }
    })

    if (result.ok && !v.dryRun) revalidatePath(CLOSING_PATH)
    return toActionState(result)
  }
)

export { todayLocalDate }
