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
import { fxClosingAdjustments, type ClosingRate, type FxPosition } from "@/lib/closing/fx"
import { RECLASS_PAIRS, reclassifyMaturities } from "@/lib/closing/reclass"
import { discountCents as pvDiscountCents, presentValueCents } from "@/lib/closing/present-value"
import { buildFromTemplate } from "@/lib/ledger/templates"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { AccountKey, EntryDraft, LocalDate } from "@/lib/ledger/types"
import {
  FX_RATE_WINDOW_DAYS,
  latestClosingRun,
  readAccountBalances,
  readMaturityPositions,
  readReclassificationPairs,
  readFxPositions,
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
import { createHash } from "node:crypto"
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
  /**
   * **T16.** Lo que la pantalla tiene que enseñar junto a la vista previa: de
   * dónde salieron las cifras que el servidor ha derivado. Nunca las calcula el
   * cliente; aquí sólo se le dice qué se usó (la tasa de cierre efectiva y su
   * fecha, la frontera de vencimiento, la base y el tipo del impuesto…).
   */
  parametros: readonly { etiqueta: string; valor: string }[]
  /** Avisos del motor que no impiden postear pero que hay que leer. */
  avisos: readonly string[]
}

/**
 * **Los cuatro pasos que el asistente postea uno a uno** (órdenes 5, 6, 7 y 8
 * de O-17). Antes se buscaban por coincidencia de texto sobre
 * `CLOSING_ENTRY_ORDER` (`paso.toUpperCase().includes(step.split("_")[0])`), y
 * eso hacía dos cosas mal: «RECLASIFICACION_VENCIMIENTOS» no casaba con
 * «Reclasificación por vencimiento» —la tilde—, y «CIERRE_APERTURA» o
 * «IVA_LIQUIDADO» casaban con asientos que **no** se postean por esta vía.
 * Un mapa explícito no se equivoca de asiento.
 */
const POSTABLE_STEPS: Readonly<Record<string, number>> = {
  VALOR_ACTUAL_APLAZAMIENTO: 5,
  DIFERENCIAS_DE_CAMBIO: 6,
  RECLASIFICACION_VENCIMIENTOS: 7,
  IMPUESTO_BENEFICIOS: 8,
}

/**
 * **El input fino de T-30/T-31/T-32/T-25 (aviso de C1).** La pantalla recoge
 * los **parámetros** del paso —la ventana de la tasa de cierre, el caso del
 * valor actual, el tipo del impuesto y los pagos fraccionados— y **nunca** las
 * cifras: el importe del ajuste, el descuento, los movimientos de
 * reclasificación y la cuota los deriva este fichero **en servidor**, con los
 * mismos motores puros que evalúan el paso en el checklist.
 */
const closingStepParamsSchema = z
  .object({
    /** T-30 · ventana en días naturales para buscar la tasa de cierre (O-5). */
    fxWindowDays: z.number().int().min(1).max(31).optional(),
    /** T-32 · frontera corriente / no corriente, norma 6ª: doce meses. */
    reclassThresholdMonths: z.number().int().min(1).max(60).optional(),
    /** T-31 · el caso del ajuste y la posición aplazada. */
    pvCase: z.enum(["A_EJERCICIO_CORRIENTE", "C_NO_INMOVILIZADO"]).optional(),
    pvSide: z.enum(["PASIVO", "ACTIVO"]).optional(),
    pvPositionAccountCode: z.string().trim().min(3).max(20).optional(),
    pvAssetAccountCode: z.string().trim().min(3).max(20).optional(),
    pvOriginAccountCode: z.string().trim().min(3).max(20).optional(),
    pvCounterpartyId: z.string().uuid().optional(),
    /** Nominal aplazado y meses hasta el vencimiento: los declara quien cierra. */
    pvNominalCents: z.number().int().min(1).optional(),
    pvMonths: z.number().int().min(1).max(600).optional(),
    /** T-25 · tipo de gravamen en puntos básicos (25 % = 2500). */
    taxRateBps: z.number().int().min(0).max(10000).optional(),
    /** T-25 · pagos fraccionados; por defecto, el saldo deudor de `473`. */
    taxPrepaymentsCents: z.number().int().min(0).optional(),
  })
  .default({})

const postClosingStepParamsSchema = z.object({ params: closingStepParamsSchema })
type ClosingStepParams = z.infer<typeof closingStepParamsSchema>

const eur = (cents: number): string =>
  `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} €`

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

/**
 * Ejecuta los pasos y **sella un `ClosingRun`**. No postea ningún asiento
 * (§5.2), pero **sí escribe**: inserta una fila en `closing_runs` —append-only—
 * y su `AuditLog`.
 *
 * **DEBE 9 del revisor.** Por eso es `EDITOR` y no `VIEWER`: §10 concede al
 * VIEWER *ver* el checklist, no crearlo, y con `VIEWER` cualquiera podía generar
 * runs indefinidamente y ensuciar la traza del cierre. La lectura sigue abierta
 * a todo el mundo en `getClosingRunAction`, que devuelve el ÚLTIMO run sellado.
 */
export const runClosingChecklistAction = withOrg(
  Role.EDITOR,
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
    const parsedParams = postClosingStepParamsSchema.safeParse(input ?? {})
    if (!parsedParams.success) return invalid(parsedParams.error)
    const v = parsed.data
    const params = parsedParams.data.params

    const ordenNo = POSTABLE_STEPS[v.step]
    const orden = ordenNo ? CLOSING_ENTRY_ORDER.find((o) => o.orden === ordenNo) : undefined
    if (!orden?.templateCode) {
      return {
        success: false,
        error: `El paso ${v.step} no postea asiento por esta vía: los recurrentes, el RECC, la prorrata y la liquidación de IVA se postean desde su pantalla, y la regularización, el cierre y la apertura los remata el cierre del ejercicio`,
      }
    }

    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const fy = await getFiscalYear(tx, v.fiscalYearId)
      if (!fy) throw new Error("El ejercicio no existe en esta organización")
      const cutoff = fromUtcDate(fy.endDate)
      const entryDate = v.entryDate ?? cutoff
      const lctx = await getLedgerContext(tx, entryDate)
      const derived = await deriveStepTemplateInput(tx, {
        step: v.step,
        cutoff,
        entryDate,
        organizationId: ctx.org.id,
        params,
      })

      const built = buildFromTemplate(
        orden.templateCode as Parameters<typeof buildFromTemplate>[0],
        derived.input as never,
        lctx
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))
      if (v.dryRun) {
        return {
          step: v.step,
          dryRun: true,
          draft: built.value,
          entryId: null,
          entryNumber: null,
          parametros: derived.parametros,
          avisos: derived.avisos,
        }
      }

      // **DEBE 5 del revisor.** Sin clave de idempotencia, un doble envío
      // duplicaba T-31 (valor actual) y T-25 (impuesto): T-30 y T-32 se
      // autoprotegen recalculando Δ = 0, los otros dos no, y con T-25 duplicado
      // `6300` queda al doble y `473` sobrecancelada — justo lo que O-26 y la
      // reversión de O-21 existen para evitar. La clave es determinista y la
      // resuelve `postEntryTx` contra el índice único de `idempotency_key`.
      // `idempotency_key` es `varchar(64)`: el uuid del ejercicio más el paso se
      // pasan, así que la clave es `cierre:` + sha256 de la terna. Determinista
      // y del mismo largo siempre.
      const idempotencyKey = `cierre:${createHash("sha256")
        .update(`${v.fiscalYearId}|${v.step}|${orden.templateCode}`)
        .digest("hex")
        .slice(0, 56)}`
      const posted = await postEntryTx(tx, built.value, { userId: ctx.user.id }, { idempotencyKey })
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
      return {
        step: v.step,
        dryRun: false,
        draft: built.value,
        entryId: posted.id,
        entryNumber: posted.entryNumber,
        parametros: derived.parametros,
        avisos: derived.avisos,
      }
    })

    if (result.ok && !v.dryRun) revalidatePath(CLOSING_PATH)
    return toActionState(result)
  }
)

type DerivedStepInput = {
  input: Record<string, unknown>
  parametros: { etiqueta: string; valor: string }[]
  avisos: string[]
}

/**
 * **Aquí es donde vive el input fino.** Cuatro pasos, cuatro derivaciones, todas
 * con el motor puro correspondiente y **ninguna** con una cifra que venga del
 * navegador: lo que llega de la pantalla son parámetros (ventana, caso, tipo,
 * meses), no importes contables.
 */
async function deriveStepTemplateInput(
  tx: Parameters<typeof readFxPositions>[0],
  opts: {
    step: string
    cutoff: LocalDate
    entryDate: LocalDate
    organizationId: string
    params: ClosingStepParams
  }
): Promise<DerivedStepInput> {
  const { step, cutoff, entryDate, params } = opts
  const org = await tx.organization.findFirst({
    where: { id: opts.organizationId },
    select: { baseCurrency: true, discountRateMonthlyMicroBps: true, pvMaterialityCents: true },
  })
  const baseCurrency = org?.baseCurrency ?? "EUR"

  // ── T-30 · diferencias de cambio (O-4/O-5) ─────────────────────────────
  if (step === "DIFERENCIAS_DE_CAMBIO") {
    const windowDays = params.fxWindowDays ?? FX_RATE_WINDOW_DAYS
    const positions = await readFxPositions(tx, { cutoff, baseCurrency, windowDays })
    const puras: FxPosition[] = positions.map((p) => ({
      accountCode: p.accountCode,
      counterpartyId: p.counterpartyId,
      currency: p.currency,
      baseBalanceCents: p.baseBalanceCents,
      currencyBalanceCents: p.originalBalanceCents,
      // **O-4 / H-5**: lo dice el plan y el motor lo explica al excluirlo.
      isMonetary: p.isMonetary,
    }))
    const rates: ClosingRate[] = positions
      .filter((p): p is typeof p & { rateMicro: bigint; rateDate: LocalDate } => p.rateMicro !== null && p.rateDate !== null)
      .map((p) => ({ currency: p.currency, rateMicro: p.rateMicro, rateDate: p.rateDate }))
    const result = fxClosingAdjustments(puras, rates, cutoff, windowDays)
    if (result.missingRates.length > 0) {
      throw new Error(
        `Sin tasa publicada en la ventana de ${windowDays} días para ${result.missingRates.join(", ")}: ` +
          `amplíe la ventana o cargue la tasa. No se inventa ninguna (R-FX-5)`
      )
    }
    const moving = result.byPosition.filter((a) => a.deltaCents !== 0)
    if (moving.length === 0) throw new Error("Ninguna posición monetaria en divisa tiene diferencia al corte: no hay asiento que postear")

    // La tasa se **sella** en el asiento: hay que resolver su `exchangeRateId`.
    const adjustments: Record<string, unknown>[] = []
    for (const a of moving) {
      const rate = await tx.exchangeRate.findFirst({
        where: { from: a.currency, to: baseCurrency, date: toUtcDate(a.rateDate) },
        orderBy: { fetchedAt: "desc" },
        select: { id: true },
      })
      if (!rate) throw new Error(`La tasa ${a.currency}/${baseCurrency} de ${a.rateDate} no está persistida: no se puede sellar el asiento`)
      adjustments.push({
        accountCode: a.accountCode,
        counterpartyId: a.counterpartyId ?? undefined,
        currency: a.currency,
        deltaCents: a.deltaCents,
        exchangeRateId: rate.id,
        rateDate: a.rateDate,
      })
    }
    return {
      input: { cutoff, entryDate, adjustments },
      parametros: [
        { etiqueta: "Ventana de la tasa de cierre", valor: `${windowDays} días naturales hasta ${cutoff}` },
        ...result.usedRates.map((r) => ({
          etiqueta: `Tasa de cierre ${r.currency}/${baseCurrency}`,
          valor: `${(Number(r.rateMicro) / 1_000_000).toFixed(6)} de ${r.rateDate}`,
        })),
        { etiqueta: "Posiciones ajustadas", valor: `${moving.length} de ${result.byPosition.length}` },
      ],
      avisos: result.excludedNonMonetary.map(
        (p) => `${p.accountCode} en ${p.currency} queda fuera del barrido: la cuenta no es monetaria en el plan (O-4, I-E9-24)`
      ),
    }
  }

  // ── T-32 · reclasificación por vencimiento (O-6/O-7) ───────────────────
  if (step === "RECLASIFICACION_VENCIMIENTOS") {
    const thresholdMonths = params.reclassThresholdMonths ?? 12
    const pairs = await readReclassificationPairs(tx)
    const pairRefs = (pairs.length > 0
      ? pairs.map((p) => ({ longCode: p.longAccountCode, shortCode: p.shortAccountCode }))
      : RECLASS_PAIRS.map((p) => ({ longCode: p.longCode, shortCode: p.shortCode })))
    const positions = await readMaturityPositions(tx, {
      cutoff,
      accountCodes: [...new Set(pairRefs.flatMap((p) => [p.longCode, p.shortCode]))],
    })
    const result = reclassifyMaturities(
      positions.map((p) => ({
        accountCode: p.accountCode,
        counterpartyId: p.counterpartyId,
        currency: p.currency ?? baseCurrency,
        dueDate: p.dueDate,
        // `debe − haber` (H-1): `readMaturityPositions` devuelve ya la
        // convención del motor y `entryNumber` es el asiento vivo más antiguo
        // del grupo (H-4, R-RC-3). Invertir el signo aquí posteaba T-32 al revés.
        openCents: p.openCents,
        entryNumber: p.entryNumber,
      })),
      pairRefs,
      cutoff,
      { thresholdMonths }
    )
    if (result.blocking.length > 0) {
      throw new Error(
        `Hay ${result.blocking.length} posición(es) de 17x/52x sin desglose de vencimientos (O-6, I-E9-25): ` +
          `${result.blocking.map((b) => b.accountCode).join(", ")}. Dé de alta el cuadro en Configuración › Deuda`
      )
    }
    if (result.moved.length === 0) throw new Error("Ninguna posición cambia de tramo al corte: no hay reclasificación que postear")
    return {
      input: {
        cutoff,
        entryDate,
        moves: result.moved.map((m) => ({
          fromAccountCode: m.fromCode,
          toAccountCode: m.toCode,
          amountCents: m.amountCents,
          side: m.debtor ? "ACTIVO" : "PASIVO",
          counterpartyId: m.counterpartyId ?? undefined,
          currency: m.currency,
          dueDate: m.dueDate,
        })),
      },
      parametros: [
        { etiqueta: "Frontera corriente / no corriente", valor: `${thresholdMonths} meses · ${result.boundaryDate} (norma 6ª de elaboración)` },
        { etiqueta: "Movimientos", valor: `${result.moved.length}` },
      ],
      avisos: [
        ...result.warnings.map((w) => w.mensaje),
        ...result.unknownMaturity.map((p) => `${p.accountCode} no se reclasifica: la posición no tiene vencimiento (I-E9-16)`),
      ],
    }
  }

  // ── T-31 · valor actual del aplazamiento (O-1/O-2) ─────────────────────
  if (step === "VALOR_ACTUAL_APLAZAMIENTO") {
    const rate = org?.discountRateMonthlyMicroBps ?? null
    if (rate === null) {
      throw new Error(
        "La organización no tiene declarado el tipo de descuento mensual: fíjelo en Configuración antes de valorar un aplazamiento (O-2)"
      )
    }
    const { pvCase, pvSide, pvPositionAccountCode, pvNominalCents, pvMonths } = params
    if (!pvCase || !pvPositionAccountCode || !pvNominalCents || !pvMonths) {
      throw new Error("Faltan los parámetros del ajuste: caso, cuenta de la posición aplazada, nominal y meses hasta el vencimiento")
    }
    const presentValue = presentValueCents(pvNominalCents, rate, pvMonths)
    const descuento = pvDiscountCents(pvNominalCents, presentValue)
    const materiality = Number(org?.pvMaterialityCents ?? 0)
    if (pvMonths <= 12) throw new Error(`El aplazamiento es de ${pvMonths} meses: por debajo de doce no se descuenta (R-VA-1)`)
    if (descuento < materiality) {
      throw new Error(
        `El descuento (${eur(descuento)}) no alcanza la materialidad declarada (${eur(materiality)}): no procede el ajuste (R-VA-2)`
      )
    }
    return {
      input: {
        entryDate,
        case: pvCase,
        side: pvSide ?? "PASIVO",
        positionAccountCode: pvPositionAccountCode,
        assetAccountCode: params.pvAssetAccountCode,
        originAccountCode: params.pvOriginAccountCode,
        counterpartyId: params.pvCounterpartyId,
        discountCents: descuento,
      },
      parametros: [
        { etiqueta: "Tipo de descuento mensual declarado", valor: `${(rate / 10_000).toFixed(4)} % mensual (O-2)` },
        { etiqueta: "Nominal aplazado", valor: eur(pvNominalCents) },
        { etiqueta: "Meses hasta el vencimiento", valor: `${pvMonths}` },
        { etiqueta: "Valor actual calculado en servidor", valor: eur(presentValue) },
        { etiqueta: "Descuento (nominal − valor actual)", valor: eur(descuento) },
        { etiqueta: "Materialidad declarada", valor: eur(materiality) },
      ],
      avisos: [],
    }
  }

  // ── T-25 · impuesto sobre beneficios (O-26) ────────────────────────────
  if (step === "IMPUESTO_BENEFICIOS") {
    const rateBps = params.taxRateBps ?? 2500
    const acreedores = await readAccountBalances(tx, { cutoff, prefixes: ["6", "7"], sign: "ACREEDOR" })
    let resultado = 0
    for (const [code, cents] of acreedores) if (!code.startsWith("6300")) resultado += cents
    const deudores = await readAccountBalances(tx, { cutoff, prefixes: ["473"], sign: "DEUDOR" })
    const pagosFraccionados =
      params.taxPrepaymentsCents ?? Math.max(0, [...deudores.values()].reduce((a, b) => a + b, 0))
    return {
      input: {
        documentDate: entryDate,
        entryDate,
        taxableBaseCents: resultado,
        rateBps,
        prepaymentsCents: pagosFraccionados,
      },
      parametros: [
        { etiqueta: "Resultado contable antes de impuestos (derivado del diario)", valor: eur(resultado) },
        { etiqueta: "Tipo de gravamen", valor: `${(rateBps / 100).toFixed(2)} %` },
        { etiqueta: "Pagos fraccionados y retenciones (saldo deudor de 473)", valor: eur(pagosFraccionados) },
      ],
      avisos: [
        "La base es el resultado contable: los ajustes extracontables, las BIN y las diferencias temporarias no están soportados todavía (E10). Si los hay, la cuota que se postee será la del resultado contable y hay que revisarla.",
      ],
    }
  }

  throw new Error(`El paso ${step} no tiene derivación de parámetros`)
}

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
