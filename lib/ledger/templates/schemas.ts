/**
 * E3 · T5 — Schemas zod de las 28 plantillas. Módulo PURO (zod no hace IO).
 *
 * Aquí se valida la FORMA del input (tipos, obligatoriedad, enteros, fechas
 * bien escritas). Las reglas contables —cuadre, vigencia de tipos, prorrata
 * configurada, saldo vivo suficiente— las aplica la plantilla y `checkDraft`,
 * porque necesitan el `LedgerContext` y zod no lo tiene.
 */

import { z } from "zod"

/** "YYYY-MM-DD" y día existente (2026-02-29 no lo es). */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato YYYY-MM-DD")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number)
    if (m < 1 || m > 12) return false
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const dim = m === 2 ? (leap ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
    return d >= 1 && d <= dim
  }, "La fecha no existe en el calendario")

/** Importe en céntimos ≥ 0. Nunca `Float`, nunca negativo (ADR-0006). */
export const centsSchema = z.number().int("Los importes son enteros en céntimos").min(0, "Un importe no es negativo")
/** Importe con signo (diferencias de cambio, redondeos). */
export const signedCentsSchema = z.number().int("Los importes son enteros en céntimos")

export const accountCodeSchema = z.string().regex(/^[1-9][0-9]{0,11}$/, "Código de cuenta PGC inválido")
export const uuidSchema = z.string().uuid()
export const taxRateCodeSchema = z.string().min(1).max(24)

const baseDocumentDates = {
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
}

const analyticFields = {
  projectId: uuidSchema.optional(),
  costCenterId: uuidSchema.optional(),
  analyticType: z
    .enum([
      "INGRESO_DIRECTO",
      "COSTE_DIRECTO_MC1",
      "COSTE_DIRECTO_MC2",
      "INDIRECTO_CECO",
      "AMORTIZACION_DETERIORO",
      "FINANCIERO",
      "EXTRAORDINARIO",
      "NO_ANALITICO",
    ])
    .optional(),
}

/** Vencimiento: una línea de 43x/40x por plazo (decisión 6 de §9.2). */
export const dueScheduleSchema = z.array(z.object({ dueDate: localDateSchema, amountCents: centsSchema.min(1) })).min(1)

// ─────────────────────────────────────────────────────────────────────────────
// Bloque A — documento con impuestos (T-01…T-07)
// ─────────────────────────────────────────────────────────────────────────────

export const facturaEmitidaSchema = z.object({
  counterpartyId: uuidSchema.optional(),
  documentNumber: z.string().min(1).max(64),
  ...baseDocumentDates,
  dueDate: localDateSchema.optional(),
  dueSchedule: dueScheduleSchema.optional(),
  lines: z
    .array(
      z.object({
        baseCents: centsSchema.min(1),
        taxRateCode: taxRateCodeSchema,
        surchargeRateCode: taxRateCodeSchema.optional(),
        revenueAccountCode: accountCodeSchema.optional(),
        description: z.string().max(512).optional(),
        ...analyticFields,
      })
    )
    .min(1, "Una factura tiene al menos una línea"),
  withholdingRateCode: taxRateCodeSchema.optional(),
  appliedAdvanceCents: centsSchema.optional(),
  appliedAdvanceTaxCents: centsSchema.optional(),
  totalCents: centsSchema,
  description: z.string().max(512).optional(),
})
export type FacturaEmitidaInput = z.infer<typeof facturaEmitidaSchema>

export const RECTIFICATION_REASONS = ["DEVOLUCION", "DESCUENTO_POSTERIOR", "RAPPEL", "ERROR"] as const
export const rectificationReasonSchema = z.enum(RECTIFICATION_REASONS)

export const abonoEmitidoSchema = facturaEmitidaSchema.extend({
  rectifiesEntryId: uuidSchema.optional(),
  reason: rectificationReasonSchema,
  /** El tipo impositivo es el vigente en el DOCUMENTO ORIGINAL, no el de hoy. */
  originalDocumentDate: localDateSchema.optional(),
})
export type AbonoEmitidoInput = z.infer<typeof abonoEmitidoSchema>

export const DEDUCTIBILITY = ["FULL", "NONE", "PRORRATA"] as const
export const deductibilitySchema = z.enum(DEDUCTIBILITY)

export const facturaRecibidaSchema = z.object({
  counterpartyId: uuidSchema.optional(),
  supplierDocumentNumber: z.string().min(1).max(64),
  ...baseDocumentDates,
  dueDate: localDateSchema.optional(),
  dueSchedule: dueScheduleSchema.optional(),
  payableKey: z.enum(["PROVEEDORES", "ACREEDORES"]),
  lines: z
    .array(
      z.object({
        baseCents: centsSchema.min(1),
        taxRateCode: taxRateCodeSchema,
        expenseAccountCode: accountCodeSchema.optional(),
        deductibility: deductibilitySchema.default("FULL"),
        description: z.string().max(512).optional(),
        ...analyticFields,
      })
    )
    .min(1),
  withholdingRateCode: taxRateCodeSchema.optional(),
  /** Clave de la cuenta de retención según el modelo (111 vs 115). */
  withholdingKey: z
    .enum(["IRPF_PROFESIONALES_A_PAGAR", "IRPF_ALQUILERES_A_PAGAR", "IRPF_TRABAJO_A_PAGAR", "IRPF_A_PAGAR"])
    .optional(),
  appliedAdvanceCents: centsSchema.optional(),
  totalCents: centsSchema,
  description: z.string().max(512).optional(),
})
export type FacturaRecibidaInput = z.infer<typeof facturaRecibidaSchema>

export const facturaRecibidaIspSchema = facturaRecibidaSchema
export type FacturaRecibidaIspInput = FacturaRecibidaInput

export const abonoRecibidoSchema = facturaRecibidaSchema.extend({
  rectifiesEntryId: uuidSchema.optional(),
  reason: rectificationReasonSchema,
  originalDocumentDate: localDateSchema.optional(),
})
export type AbonoRecibidoInput = z.infer<typeof abonoRecibidoSchema>

const bankKeySchema = z.enum(["BANCO_DEFAULT", "CAJA"])

export const anticipoSchema = z.object({
  counterpartyId: uuidSchema.optional(),
  ...baseDocumentDates,
  bankKey: bankKeySchema.default("BANCO_DEFAULT"),
  bankAccountCode: accountCodeSchema.optional(),
  amountCents: centsSchema.min(1),
  taxRateCode: taxRateCodeSchema.optional(),
  description: z.string().max(512).optional(),
})
export type AnticipoInput = z.infer<typeof anticipoSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Bloque B — tesorería, personal y periodificación (T-08…T-18)
// ─────────────────────────────────────────────────────────────────────────────

export const cobroClienteSchema = z.object({
  bankKey: bankKeySchema.default("BANCO_DEFAULT"),
  bankAccountCode: accountCodeSchema.optional(),
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  settlements: z
    .array(
      z.object({
        receivableKey: z.enum(["CLIENTES", "CLIENTES_DUDOSO_COBRO"]).default("CLIENTES"),
        amountCents: centsSchema.min(1),
        sourceEntryId: uuidSchema.optional(),
        counterpartyId: uuidSchema.optional(),
      })
    )
    .min(1),
  amountReceivedCents: centsSchema,
  bankFeeCents: centsSchema.optional(),
  /** E4 · T6: destino de la comisión `626`. Default: el CECO de kind `G_A`. */
  bankFeeCostCenterId: uuidSchema.optional(),
  bankFeeProjectId: uuidSchema.optional(),
  /** + ganancia (768), − pérdida (668). Signo del input, no de la línea. */
  fxDifferenceCents: signedCentsSchema.optional(),
  roundingCents: signedCentsSchema.optional(),
  /** E4 · T6: destino de `668`/`768` y `669`/`769`. Default: CECO `FINANCIERO`. */
  financialCostCenterId: uuidSchema.optional(),
  description: z.string().max(512).optional(),
})
export type CobroClienteInput = z.infer<typeof cobroClienteSchema>

export const pagoProveedorSchema = z.object({
  bankKey: bankKeySchema.default("BANCO_DEFAULT"),
  bankAccountCode: accountCodeSchema.optional(),
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  settlements: z
    .array(
      z.object({
        payableKey: z.enum(["PROVEEDORES", "ACREEDORES"]).default("PROVEEDORES"),
        amountCents: centsSchema.min(1),
        sourceEntryId: uuidSchema.optional(),
        counterpartyId: uuidSchema.optional(),
      })
    )
    .min(1),
  amountPaidCents: centsSchema,
  bankFeeCents: centsSchema.optional(),
  /** E4 · T6: destino de la comisión `626`. Default: el CECO de kind `G_A`. */
  bankFeeCostCenterId: uuidSchema.optional(),
  bankFeeProjectId: uuidSchema.optional(),
  fxDifferenceCents: signedCentsSchema.optional(),
  roundingCents: signedCentsSchema.optional(),
  /** E4 · T6: destino de `668`/`768` y `669`/`769`. Default: CECO `FINANCIERO`. */
  financialCostCenterId: uuidSchema.optional(),
  description: z.string().max(512).optional(),
})
export type PagoProveedorInput = z.infer<typeof pagoProveedorSchema>

const periodSchema = z.object({ year: z.number().int().min(1900).max(2999), month: z.number().int().min(1).max(12) })

export const nominaSchema = z.object({
  period: periodSchema,
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  gross: z
    .array(z.object({ amountCents: centsSchema.min(1), accountCode: accountCodeSchema.optional(), ...analyticFields }))
    .min(1),
  employerSS: z
    .array(z.object({ amountCents: centsSchema.min(1), accountCode: accountCodeSchema.optional(), ...analyticFields }))
    .default([]),
  employeeSSCents: centsSchema,
  withholdingCents: centsSchema,
  withholdingTaxRateCode: taxRateCodeSchema.optional(),
  advanceAppliedCents: centsSchema.optional(),
  /** Declarado por el proveedor de nóminas: el motor lo VALIDA, no lo calcula. */
  netCents: centsSchema,
  description: z.string().max(512).optional(),
})
export type NominaInput = z.infer<typeof nominaSchema>

/** Forma común de T-11, T-12, T-13 y T-24: una deuda al debe, tesorería al haber. */
export const pagoDeudaSchema = z.object({
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  bankKey: bankKeySchema.default("BANCO_DEFAULT"),
  bankAccountCode: accountCodeSchema.optional(),
  liabilityKey: z.enum([
    "REMUNERACIONES_PENDIENTES",
    "SS_ACREEDORA",
    "IRPF_A_PAGAR",
    "IRPF_PROFESIONALES_A_PAGAR",
    "IRPF_ALQUILERES_A_PAGAR",
    "IRPF_TRABAJO_A_PAGAR",
    "HP_ACREEDORA_IVA",
    "HP_ACREEDORA_IS",
  ]),
  amountCents: centsSchema.min(1),
  /** Saldo acreedor vivo de la cuenta: si falta, se toma de `ctx.balances`. */
  openLiabilityCents: centsSchema.optional(),
  /** Recargo o intereses de demora: línea propia, nunca engordan la deuda. */
  surchargeCents: centsSchema.optional(),
  surchargeAccountCode: accountCodeSchema.optional(),
  /** E4 · T6: destino del recargo `631`/`669`. Default: el CECO de kind `G_A`. */
  surchargeCostCenterId: uuidSchema.optional(),
  surchargeProjectId: uuidSchema.optional(),
  description: z.string().max(512).optional(),
})
export type PagoDeudaInput = z.infer<typeof pagoDeudaSchema>

export const amortizacionSchema = z.object({
  period: periodSchema,
  documentDate: localDateSchema,
  entryDate: localDateSchema.optional(),
  items: z
    .array(
      z.object({
        assetAccountCode: accountCodeSchema,
        expenseAccountCode: accountCodeSchema,
        accumulatedAccountCode: accountCodeSchema,
        amountCents: centsSchema.min(1),
        /** Valor de adquisición y amortización acumulada, para la comprobación. */
        acquisitionCostCents: centsSchema.optional(),
        accumulatedCents: centsSchema.optional(),
        ...analyticFields,
      })
    )
    .min(1),
  description: z.string().max(512).optional(),
})
export type AmortizacionInput = z.infer<typeof amortizacionSchema>

export const periodificacionSchema = z.object({
  documentDate: localDateSchema,
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  /** Une el par periodificación / devengo. */
  sourceId: z.string().max(128).optional(),
  items: z
    .array(
      z.object({
        /** Cuenta de gasto (6xx) o de ingreso (7xx) que se periodifica. */
        accountCode: accountCodeSchema.optional(),
        accountKey: z.enum(["VENTAS_DEFAULT", "SUBCONTRATACION_DEFAULT", "COMPRAS_DEFAULT"]).optional(),
        amountCents: centsSchema.min(1),
        description: z.string().max(512).optional(),
        ...analyticFields,
      })
    )
    .min(1),
  description: z.string().max(512).optional(),
})
export type PeriodificacionInput = z.infer<typeof periodificacionSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Bloque C — estructurales y de cierre (T-19…T-28)
// ─────────────────────────────────────────────────────────────────────────────

export const traspasoTesoreriaSchema = z.object({
  documentDate: localDateSchema,
  entryDate: localDateSchema.optional(),
  fromKey: bankKeySchema.optional(),
  fromAccountCode: accountCodeSchema.optional(),
  toKey: bankKeySchema.optional(),
  toAccountCode: accountCodeSchema.optional(),
  amountCents: centsSchema.min(1),
  bankFeeCents: centsSchema.optional(),
  /** E4 · T6: destino de la comisión `626`. Default: el CECO de kind `G_A`. */
  bankFeeCostCenterId: uuidSchema.optional(),
  bankFeeProjectId: uuidSchema.optional(),
  description: z.string().max(512).optional(),
})
export type TraspasoTesoreriaInput = z.infer<typeof traspasoTesoreriaSchema>

export const asientoManualSchema = z.object({
  documentDate: localDateSchema.optional(),
  accrualDate: localDateSchema.optional(),
  entryDate: localDateSchema.optional(),
  description: z.string().min(1).max(512),
  sourceId: z.string().max(128).optional(),
  lines: z
    .array(
      z.object({
        accountCode: accountCodeSchema.optional(),
        accountKey: z.string().optional(),
        debitCents: centsSchema.default(0),
        creditCents: centsSchema.default(0),
        description: z.string().max(512).optional(),
        dueDate: localDateSchema.optional(),
        counterpartyId: uuidSchema.optional(),
        taxRateId: uuidSchema.optional(),
        ...analyticFields,
      })
    )
    .min(2, "Un asiento manual tiene al menos dos líneas"),
})
export type AsientoManualInput = z.infer<typeof asientoManualSchema>

export const contraAsientoSchema = z.object({
  entryId: uuidSchema,
  reason: z.string().min(10, "El motivo de la anulación debe tener al menos 10 caracteres").max(512),
  requestedDate: localDateSchema.optional(),
})
export type ContraAsientoInput = z.infer<typeof contraAsientoSchema>

export const AJUSTE_CERRADO_KINDS = ["MATERIAL", "NO_SIGNIFICATIVO"] as const

export const ajusteEjercicioCerradoSchema = z.object({
  /** Fecha del documento antiguo: cae en el ejercicio CLOSED. */
  documentDate: localDateSchema,
  /** Fecha contable en el ejercicio abierto. */
  entryDate: localDateSchema,
  adjustmentKind: z.enum(AJUSTE_CERRADO_KINDS),
  /** 113 reservas o 121 resultados negativos (material); 678/778 si no. */
  equityAccountCode: accountCodeSchema.optional(),
  direction: z.enum(["GASTO", "INGRESO"]),
  amountCents: centsSchema.min(1),
  /** Contrapartida real: acreedor, proveedor, cliente, 47x… */
  counterpartKey: z.enum(["ACREEDORES", "PROVEEDORES", "CLIENTES", "BANCO_DEFAULT"]).optional(),
  counterpartAccountCode: accountCodeSchema.optional(),
  /** IVA deducible del documento antiguo dentro del plazo de 4 años (art. 99). */
  deductibleVatCents: centsSchema.optional(),
  deductibleVatRateCode: taxRateCodeSchema.optional(),
  reason: z.string().min(10).max(512),
  ...analyticFields,
})
export type AjusteEjercicioCerradoInput = z.infer<typeof ajusteEjercicioCerradoSchema>

export const regularizacionIvaSchema = z.object({
  periodStart: localDateSchema,
  periodEnd: localDateSchema,
  entryDate: localDateSchema.optional(),
  /** Se DERIVAN del diario, jamás de un input libre del usuario (P1). */
  outputCents: centsSchema,
  inputCents: centsSchema,
  carryForwardCents: centsSchema.optional(),
  description: z.string().max(512).optional(),
})
export type RegularizacionIvaInput = z.infer<typeof regularizacionIvaSchema>

export const pagoImpuestoSchema = pagoDeudaSchema
export type PagoImpuestoInput = PagoDeudaInput

export const impuestoBeneficiosSchema = z.object({
  documentDate: localDateSchema,
  entryDate: localDateSchema.optional(),
  /** Base imponible con ajustes extracontables: se calcula FUERA (E9). */
  taxableBaseCents: signedCentsSchema,
  rateBps: z.number().int().min(0).max(10000),
  /** Pagos fraccionados ya soportados (473/4709) que minoran la cuota. */
  prepaymentsCents: centsSchema.optional(),
  description: z.string().max(512).optional(),
})
export type ImpuestoBeneficiosInput = z.infer<typeof impuestoBeneficiosSchema>

/** T-26/T-27/T-28 construyen desde SALDOS: el llamante los aporta. */
export const balanceDrivenSchema = z.object({
  entryDate: localDateSchema,
  description: z.string().max(512).optional(),
  /** `{ accountCode: saldo }` con saldo = Σdebe − Σhaber (negativo = acreedor). */
  balances: z.record(accountCodeSchema, signedCentsSchema).optional(),
})
export type BalanceDrivenInput = z.infer<typeof balanceDrivenSchema>

export const aperturaEjercicioSchema = balanceDrivenSchema.extend({
  /** Ejercicio nuevo al que se abre; su primer día es la fecha del asiento. */
  fiscalYearId: uuidSchema.optional(),
})
export type AperturaEjercicioInput = z.infer<typeof aperturaEjercicioSchema>
