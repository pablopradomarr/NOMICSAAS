/**
 * E3 · T5b — Bloque B: tesorería, personal y periodificación (T-08…T-18).
 *
 * Sin cálculo de impuesto: reparten un importe conocido entre cuentas
 * conocidas. Lo delicado son la comisión, la diferencia de cambio, el ajuste de
 * redondeo (R-IVA-7), el reparto multi-destino de la nómina y
 * `PAYMENT_EXCEEDS_LIABILITY`.
 *
 * Módulo PURO.
 */

import { ajusteRedondeo } from "@/lib/ledger/tax"
import { buildEntry } from "@/lib/ledger/post"
import {
  AccountKey,
  AnalyticType,
  Cents,
  DraftLine,
  EntryDraft,
  err,
  fail,
  LedgerContext,
  LedgerError,
  Result,
} from "@/lib/ledger/types"
import { credit, debit, sumCents } from "@/lib/ledger/templates/types"
import type {
  AmortizacionInput,
  CobroClienteInput,
  NominaInput,
  PagoDeudaInput,
  PagoProveedorInput,
  PeriodificacionInput,
} from "@/lib/ledger/templates/schemas"

function analyticFor(ctx: LedgerContext, accountCode: string, override?: AnalyticType | null): AnalyticType | null {
  return override ?? ctx.plan.byCode.get(accountCode)?.analyticType ?? null
}

function mapped(ctx: LedgerContext, key: AccountKey, errors: LedgerError[]): string | null {
  const code = ctx.map(key)
  if (!code) {
    errors.push(err("MAP_KEY_UNMAPPED", "accountKey", `La clave ${key} no está mapeada a ninguna cuenta del plan`))
    return null
  }
  return code
}

/**
 * Líneas de diferencia de cambio y de ajuste de redondeo, comunes a T-08 y
 * T-09. `fx > 0` es ganancia (768) y `fx < 0` pérdida (668).
 */
function financialLines(
  ctx: LedgerContext,
  opts: { fxDifferenceCents?: number; roundingCents?: number },
  errors: LedgerError[]
): DraftLine[] {
  const lines: DraftLine[] = []
  const fx = opts.fxDifferenceCents ?? 0
  if (fx < 0) {
    const code = mapped(ctx, "DIFERENCIA_CAMBIO_NEGATIVA", errors)
    if (code) lines.push(debit(-fx, { accountCode: code, analyticType: analyticFor(ctx, code) }))
  } else if (fx > 0) {
    const code = mapped(ctx, "DIFERENCIA_CAMBIO_POSITIVA", errors)
    if (code) lines.push(credit(fx, { accountCode: code, analyticType: analyticFor(ctx, code) }))
  }

  const rounding = opts.roundingCents ?? 0
  if (rounding !== 0) {
    const adjust = ajusteRedondeo(rounding, ctx)
    if (adjust.kind === "ERROR") {
      errors.push(adjust.error)
    } else if (adjust.kind === "GASTO") {
      const code = mapped(ctx, "REDONDEO_GASTO", errors)
      if (code) lines.push(debit(adjust.amountCents, { accountCode: code, analyticType: analyticFor(ctx, code) }))
    } else if (adjust.kind === "INGRESO") {
      const code = mapped(ctx, "REDONDEO_INGRESO", errors)
      if (code) lines.push(credit(adjust.amountCents, { accountCode: code, analyticType: analyticFor(ctx, code) }))
    }
  }
  return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// T-08 · COBRO_CLIENTE
// ─────────────────────────────────────────────────────────────────────────────

export function buildCobroCliente(input: CobroClienteInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)
  const feeCents = input.bankFeeCents ?? 0
  const feeCode = feeCents > 0 ? mapped(ctx, "COMISIONES_BANCARIAS", errors) : null

  const financial = financialLines(ctx, input, errors)

  const settlementLines = input.settlements.map((s) => {
    const code = mapped(ctx, s.receivableKey, errors)
    return credit(s.amountCents, { accountCode: code ?? "", counterpartyId: s.counterpartyId ?? null })
  })

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    debit(input.amountReceivedCents, { accountCode: bankCode! }),
    // Servicio bancario exento (art. 20.Uno.18º): sin IVA.
    ...(feeCode ? [debit(feeCents, { accountCode: feeCode, analyticType: analyticFor(ctx, feeCode) })] : []),
    ...financial,
    ...settlementLines,
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Cobro de cliente",
      kind: "NORMAL",
      sourceType: "BANK_IMPORT",
      templateCode: "COBRO_CLIENTE",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-09 · PAGO_PROVEEDOR — espejo exacto de T-08
// ─────────────────────────────────────────────────────────────────────────────

export function buildPagoProveedor(input: PagoProveedorInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)
  const feeCents = input.bankFeeCents ?? 0
  const feeCode = feeCents > 0 ? mapped(ctx, "COMISIONES_BANCARIAS", errors) : null
  const financial = financialLines(ctx, input, errors)

  const settlementLines = input.settlements.map((s) => {
    const code = mapped(ctx, s.payableKey, errors)
    return debit(s.amountCents, { accountCode: code ?? "", counterpartyId: s.counterpartyId ?? null })
  })

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    ...settlementLines,
    ...(feeCode ? [debit(feeCents, { accountCode: feeCode, analyticType: analyticFor(ctx, feeCode) })] : []),
    ...financial,
    credit(input.amountPaidCents, { accountCode: bankCode! }),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Pago a proveedor",
      kind: "NORMAL",
      sourceType: "BANK_IMPORT",
      templateCode: "PAGO_PROVEEDOR",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-10 · NOMINA
// ─────────────────────────────────────────────────────────────────────────────

export function buildNomina(input: NominaInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const salaryDefault = mapped(ctx, "SUELDOS_DEFAULT", errors)
  const employerSSDefault = mapped(ctx, "SS_EMPRESA_DEFAULT", errors)
  const payableCode = mapped(ctx, "REMUNERACIONES_PENDIENTES", errors)
  const ssCode = mapped(ctx, "SS_ACREEDORA", errors)
  const withholdingCode = mapped(ctx, "IRPF_TRABAJO_A_PAGAR", errors)
  const advanceCents = input.advanceAppliedCents ?? 0
  const advanceCode = advanceCents > 0 ? mapped(ctx, "ANTICIPOS_REMUNERACIONES", errors) : null

  const grossTotal = sumCents(input.gross.map((g) => g.amountCents))
  const employerSSTotal = sumCents(input.employerSS.map((g) => g.amountCents))

  // P1 aplicado a la letra: los importes que vienen de un tercero (art. 82
  // RIRPF) se VALIDAN por identidad; el motor no los recalcula.
  const computedNet = grossTotal - input.employeeSSCents - input.withholdingCents - advanceCents
  if (computedNet !== input.netCents) {
    errors.push(
      err(
        "DOCUMENT_TOTAL_MISMATCH",
        "netCents",
        `El neto declarado (${input.netCents}) no es bruto ${grossTotal} − SS trabajador ${input.employeeSSCents} ` +
          `− IRPF ${input.withholdingCents} − anticipo ${advanceCents} = ${computedNet}`,
        { check: "C-5" }
      )
    )
  }
  if (advanceCents > computedNet + advanceCents) {
    errors.push(err("TEMPLATE_INPUT", "advanceAppliedCents", "El anticipo aplicado excede el neto de la nómina"))
  }

  let withholdingRateId: string | null = null
  if (input.withholdingTaxRateCode) {
    const rate = ctx.rates.find((r) => r.code === input.withholdingTaxRateCode)
    withholdingRateId = rate?.id ?? null
  }

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    // Una línea por DESTINO: una persona en tres proyectos y G&A son cuatro
    // líneas del mismo asiento, nunca cuatro cuentas.
    ...input.gross.map((g) => {
      const code = g.accountCode ?? salaryDefault!
      return debit(g.amountCents, {
        accountCode: code,
        analyticType: analyticFor(ctx, code, g.analyticType),
        projectId: g.projectId ?? null,
        costCenterId: g.costCenterId ?? null,
      })
    }),
    ...input.employerSS.map((g) => {
      const code = g.accountCode ?? employerSSDefault!
      return debit(g.amountCents, {
        accountCode: code,
        analyticType: analyticFor(ctx, code, g.analyticType),
        projectId: g.projectId ?? null,
        costCenterId: g.costCenterId ?? null,
      })
    }),
    credit(input.netCents, { accountCode: payableCode! }),
    ...(advanceCode ? [credit(advanceCents, { accountCode: advanceCode })] : []),
    // Cuota obrera + cuota patronal: es UNA sola deuda con la TGSS.
    credit(input.employeeSSCents + employerSSTotal, { accountCode: ssCode! }),
    credit(input.withholdingCents, { accountCode: withholdingCode!, taxRateId: withholdingRateId }),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `Nómina ${String(input.period.month).padStart(2, "0")}/${input.period.year}`,
      kind: "NORMAL",
      sourceType: "MANUAL",
      sourceId: `${input.period.year}-${String(input.period.month).padStart(2, "0")}`,
      templateCode: "NOMINA",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-11 · T-12 · T-13 · T-24 — una deuda al debe, tesorería al haber
// ─────────────────────────────────────────────────────────────────────────────

const LIABILITY_TEMPLATE = {
  REMUNERACIONES_PENDIENTES: "PAGO_NOMINA",
  SS_ACREEDORA: "PAGO_SEGURIDAD_SOCIAL",
  IRPF_A_PAGAR: "PAGO_RETENCIONES",
  IRPF_PROFESIONALES_A_PAGAR: "PAGO_RETENCIONES",
  IRPF_ALQUILERES_A_PAGAR: "PAGO_RETENCIONES",
  IRPF_TRABAJO_A_PAGAR: "PAGO_RETENCIONES",
  HP_ACREEDORA_IVA: "PAGO_IMPUESTO",
  HP_ACREEDORA_IS: "PAGO_IMPUESTO",
} as const

/**
 * Pago de una deuda con la tesorería. El importe **no puede exceder el saldo
 * acreedor vivo** de la cuenta: un pago que dejaría saldo deudor en 4750/4751/
 * 476 bloquea con `PAYMENT_EXCEEDS_LIABILITY`.
 */
export function buildPagoDeuda(
  input: PagoDeudaInput,
  ctx: LedgerContext,
  templateCode?: string
): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const liabilityCode = mapped(ctx, input.liabilityKey, errors)
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)

  // Saldo acreedor vivo: el del input, si no el que el llamante haya leído.
  const balance = liabilityCode ? ctx.balances?.get(liabilityCode) : undefined
  const open = input.openLiabilityCents ?? (balance !== undefined ? -balance : undefined)
  if (open !== undefined && input.amountCents > open) {
    errors.push(
      err(
        "PAYMENT_EXCEEDS_LIABILITY",
        "amountCents",
        `El pago de ${input.amountCents} excede el saldo vivo de la cuenta ${liabilityCode} (${open})`
      )
    )
  }

  const surchargeCents = input.surchargeCents ?? 0
  if (surchargeCents > 0 && !input.surchargeAccountCode) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "surchargeAccountCode",
        "El recargo o los intereses de demora van en su propia línea (631/669), nunca engordando la deuda tributaria"
      )
    )
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    debit(input.amountCents, { accountCode: liabilityCode! }),
    ...(surchargeCents > 0
      ? [
          debit(surchargeCents, {
            accountCode: input.surchargeAccountCode!,
            analyticType: analyticFor(ctx, input.surchargeAccountCode!),
          }),
        ]
      : []),
    credit(input.amountCents + surchargeCents, { accountCode: bankCode! }),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Pago de deuda",
      kind: "NORMAL",
      sourceType: "BANK_IMPORT",
      templateCode: templateCode ?? LIABILITY_TEMPLATE[input.liabilityKey],
      lines,
    },
    ctx
  )
}

export const buildPagoNomina = (i: PagoDeudaInput, ctx: LedgerContext) => buildPagoDeuda(i, ctx, "PAGO_NOMINA")
export const buildPagoSeguridadSocial = (i: PagoDeudaInput, ctx: LedgerContext) =>
  buildPagoDeuda(i, ctx, "PAGO_SEGURIDAD_SOCIAL")
export const buildPagoRetenciones = (i: PagoDeudaInput, ctx: LedgerContext) => buildPagoDeuda(i, ctx, "PAGO_RETENCIONES")
export const buildPagoImpuesto = (i: PagoDeudaInput, ctx: LedgerContext) => buildPagoDeuda(i, ctx, "PAGO_IMPUESTO")

// ─────────────────────────────────────────────────────────────────────────────
// T-14 · AMORTIZACION_MENSUAL
// ─────────────────────────────────────────────────────────────────────────────

export function buildAmortizacion(input: AmortizacionInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []

  // Amortización acumulada ≤ valor de adquisición por activo. Solo se puede
  // comprobar si el llamante aporta ambos importes.
  for (const item of input.items) {
    if (item.acquisitionCostCents === undefined || item.accumulatedCents === undefined) continue
    if (item.accumulatedCents + item.amountCents > item.acquisitionCostCents) {
      errors.push(
        err(
          "TEMPLATE_INPUT",
          "amountCents",
          `La amortización acumulada de ${item.assetAccountCode} superaría su valor de adquisición ` +
            `(${item.accumulatedCents} + ${item.amountCents} > ${item.acquisitionCostCents})`
        )
      )
    }
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  // Una línea de contra-cuenta por cuenta acumulada (agrupando los activos que
  // comparten 281x), en el orden de aparición.
  const accumulated: { code: string; amountCents: Cents }[] = []
  for (const item of input.items) {
    const at = accumulated.find((a) => a.code === item.accumulatedAccountCode)
    if (at) at.amountCents += item.amountCents
    else accumulated.push({ code: item.accumulatedAccountCode, amountCents: item.amountCents })
  }

  const lines: DraftLine[] = [
    ...input.items.map((item) =>
      debit(item.amountCents, {
        accountCode: item.expenseAccountCode,
        analyticType: analyticFor(ctx, item.expenseAccountCode, item.analyticType),
        projectId: item.projectId ?? null,
        costCenterId: item.costCenterId ?? null,
      })
    ),
    ...accumulated.map((a) => credit(a.amountCents, { accountCode: a.code })),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? input.documentDate,
      description:
        input.description ?? `Amortización ${String(input.period.month).padStart(2, "0")}/${input.period.year}`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: `${input.period.year}-${String(input.period.month).padStart(2, "0")}`,
      templateCode: "AMORTIZACION_MENSUAL",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-15 … T-18 · Periodificaciones (480 / 485) y su devengo
// ─────────────────────────────────────────────────────────────────────────────

type PeriodificacionVariant =
  | "PERIODIFICACION_GASTO"
  | "DEVENGO_PERIODIFICACION_GASTO"
  | "PERIODIFICACION_INGRESO"
  | "DEVENGO_PERIODIFICACION_INGRESO"

/**
 * Las cuatro comparten forma: una cuenta de periodificación (480 gasto / 485
 * ingreso) contra la cuenta de PyG, con la columna que corresponda.
 *
 * 438 y 485 NO son intercambiables (438 es un anticipo cobrado con IVA
 * devengado; 485 es un ingreso facturado no imputable al periodo), y por eso la
 * plantilla no deja elegir la cuenta de periodificación.
 */
export function buildPeriodificacion(
  input: PeriodificacionInput,
  ctx: LedgerContext,
  variant: PeriodificacionVariant
): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const isExpense = variant === "PERIODIFICACION_GASTO" || variant === "DEVENGO_PERIODIFICACION_GASTO"
  const accrualCode = mapped(ctx, isExpense ? "PERIODIFICACION_GASTO" : "PERIODIFICACION_INGRESO", errors)

  const items = input.items.map((item) => {
    const code = item.accountCode ?? (item.accountKey ? ctx.map(item.accountKey as AccountKey) : null)
    if (!code) {
      errors.push(err("ACCOUNT_UNKNOWN", "accountCode", "La línea no indica cuenta de gasto o de ingreso"))
    }
    return { ...item, code: code ?? "" }
  })
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const total = sumCents(items.map((i) => i.amountCents))

  // 480: se DEBITA al periodificar el gasto y se ABONA al devengarlo.
  // 485: se ABONA al periodificar el ingreso y se DEBITA al devengarlo.
  const accrualOnDebit = variant === "PERIODIFICACION_GASTO" || variant === "DEVENGO_PERIODIFICACION_INGRESO"
  const accrualLine = accrualOnDebit ? debit(total, { accountCode: accrualCode! }) : credit(total, { accountCode: accrualCode! })
  const pnlLines = items.map((item) => {
    const rest = {
      accountCode: item.code,
      description: item.description ?? null,
      analyticType: analyticFor(ctx, item.code, item.analyticType),
      projectId: item.projectId ?? null,
      costCenterId: item.costCenterId ?? null,
    }
    return accrualOnDebit ? credit(item.amountCents, rest) : debit(item.amountCents, rest)
  })

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? PERIODIFICACION_LABEL[variant],
      kind: "NORMAL",
      sourceType: "MANUAL",
      // El par periodificación / devengo comparte `sourceId`.
      sourceId: input.sourceId ?? null,
      templateCode: variant,
      lines: accrualOnDebit ? [accrualLine, ...pnlLines] : [...pnlLines, accrualLine],
    },
    ctx
  )
}

const PERIODIFICACION_LABEL: Record<PeriodificacionVariant, string> = {
  PERIODIFICACION_GASTO: "Periodificación de gasto anticipado (480)",
  DEVENGO_PERIODIFICACION_GASTO: "Devengo de gasto periodificado (480)",
  PERIODIFICACION_INGRESO: "Periodificación de ingreso anticipado (485)",
  DEVENGO_PERIODIFICACION_INGRESO: "Devengo de ingreso periodificado (485)",
}
