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
  /**
   * E8 · ADR-0014 D8 (O-14): fecha de la operación = **devengo del IVA**
   * (art. 75 LIVA). Es la que elige el tipo aplicable (art. 90.Dos). Opcional:
   * sin ella el devengo es `accrualDate ?? documentDate`, que es el caso normal.
   */
  operationDate: localDateSchema.optional(),
}

/**
 * E8 · ADR-0014 D3 — cuota **del documento** por tipo impositivo.
 *
 * Con override presente la plantilla contabiliza esta cuota tal cual (el IVA
 * deducible es el repercutido por el proveedor, arts. 92.Uno y 97.Uno LIVA) y
 * `checkDraft` comprueba `|override − recalculada| ≤ 1 c` **por tipo**. Sin
 * override, el comportamiento es exactamente el de E3.
 */
export const taxOverrideSchema = z.object({
  taxRateCode: taxRateCodeSchema,
  quotaCents: centsSchema,
})
export type TaxOverrideInput = z.infer<typeof taxOverrideSchema>

/**
 * E8 · ADR-0014 D6/D9 — claves de contrapartida de una factura recibida.
 *
 * `PROVEEDORES` (400) para 60x · `ACREEDORES` (410) para 62x/63x/64x/66x/69x ·
 * `PROVEEDORES_INMOVILIZADO` (**523 siempre en el alta**; la reclasificación
 * 523→173 se mide desde el CIERRE y es un asiento de E9) · tesorería
 * (`BANCO_DEFAULT`/`CAJA`) para el ticket, que se paga en el acto ·
 * `REMUNERACIONES_PENDIENTES` (465) para la nota de gasto de un empleado, que
 * **nunca** es un 400 ni un 410.
 */
export const PAYABLE_KEYS = [
  "PROVEEDORES",
  "ACREEDORES",
  "PROVEEDORES_INMOVILIZADO",
  "BANCO_DEFAULT",
  "CAJA",
  "REMUNERACIONES_PENDIENTES",
] as const
export type PayableKey = (typeof PAYABLE_KEYS)[number]
export const payableKeySchema = z.enum(PAYABLE_KEYS)

/**
 * E8 · ADR-0014 D6 — reparto del pasivo de un documento **mixto**.
 *
 * Un bloque por naturaleza de línea, y **`amountCents` es el bruto del bloque:
 * su base más su cuota** (la del documento si hay override), antes de retención
 * y de anticipo aplicado. La plantilla comprueba con tolerancia 0 que
 * `Σ amountCents = base + cuotas` y reparte retención y anticipo entre los
 * bloques por **mayor resto (Hamilton)** con desempate por código de cuenta, de
 * modo que el céntimo huérfano cae en el bloque de mayor importe y
 * `Σ líneas de pasivo` es exacto.
 *
 * Quien construye los bloques (`postFromProposal`, E8 · T9) obtiene la cuota de
 * cada línea con `lineTaxes()` de `templates/documento.ts`, que es la misma
 * aritmética que usa la plantilla: no hay dos cálculos que puedan divergir.
 */
export const payableBlockSchema = z.object({
  payableKey: payableKeySchema,
  amountCents: centsSchema.min(1),
})
export type PayableBlockInput = z.infer<typeof payableBlockSchema>

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
  /** ADR-0014 D3: la cuota que se contabiliza es la del documento. */
  taxOverrides: z.array(taxOverrideSchema).optional(),
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
  /**
   * Contrapartida por defecto del documento y, con ella, la cuenta de gasto
   * por defecto (600 vs 623). En un documento **mixto** el pasivo lo reparten
   * `payableBlocks`; ésta sigue decidiendo el gasto por defecto de las líneas
   * que no traen `expenseAccountCode`.
   */
  payableKey: payableKeySchema,
  /** ADR-0014 D6 (O-3): una línea de pasivo por naturaleza, con su cuota. */
  payableBlocks: z.array(payableBlockSchema).min(1).optional(),
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
  /**
   * E8 · ADR-0014 D10 (O-12/RC-20) — base de la retención cuando **no** es la
   * base total del documento. Los suplidos (art. 78.Tres.3º LIVA) viajan en
   * `lines` porque son líneas del asiento y suman al total, pero quedan fuera
   * de la base de retención: sin este campo, una factura de abogado con tasa
   * judicial retendría 19 500 donde el art. 75 RIRPF dice 15 000. Ausente —todo
   * E3 hasta hoy—, la base es la suma de las bases de línea, sin cambio alguno.
   */
  withholdingBaseCents: centsSchema.optional(),
  /** Clave de la cuenta de retención según el modelo (111 vs 115). */
  withholdingKey: z
    .enum(["IRPF_PROFESIONALES_A_PAGAR", "IRPF_ALQUILERES_A_PAGAR", "IRPF_TRABAJO_A_PAGAR", "IRPF_A_PAGAR"])
    .optional(),
  appliedAdvanceCents: centsSchema.optional(),
  /** ADR-0014 D3: la cuota que se contabiliza es la del documento. */
  taxOverrides: z.array(taxOverrideSchema).optional(),
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

/**
 * **E9 · R-IVA-19 (O-14/O-15) — bloque RECC de T-08 y T-09.**
 *
 * Bajo el régimen especial del criterio de caja el IVA se devenga **al cobro** y
 * se deduce **al pago** (art. 163 *terdecies* LIVA), y el destinatario en
 * régimen general de un proveedor acogido **también difiere** su deducción. Con
 * cobro o pago parcial, `cuotaDevengada = trunc(cobro × cuotaTotal / total)` con
 * el **residuo al último**, que es lo que aporta `isFinal`.
 *
 * Ausente el bloque, T-08 y T-09 son EXACTAMENTE los de E3: ni una línea más.
 */
export const reccBlockSchema = z.object({
  documentNumber: z.string().min(1).max(64),
  /** Total de la factura (base + cuota): denominador del prorrateo. */
  totalInvoiceCents: centsSchema.min(1),
  /** Cuota total repercutida (T-08) o soportada (T-09) del documento. */
  totalQuotaCents: centsSchema,
  /** Ya devengada (o deducida) por cobros o pagos anteriores. */
  alreadyAccruedCents: centsSchema.default(0),
  /** Importe imputado a esta factura; por defecto, el cobrado o pagado. */
  collectedCents: centsSchema.optional(),
  /** Último cobro o pago: arrastra el residuo y salda la cuota (I-E9-26). */
  isFinal: z.boolean().default(false),
})
export type ReccBlockInput = z.infer<typeof reccBlockSchema>

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
  /** E9 · O-15: devengo del repercutido al cobro (`4778 → 477`). */
  recc: reccBlockSchema.optional(),
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
  /** E9 · O-15: deducción del soportado al pago (`472 → 4728`). */
  recc: reccBlockSchema.optional(),
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

// ─────────────────────────────────────────────────────────────────────────────
// Bloque E9 — T-29 … T-37 (ADR-0016)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **T-29 · R-IVA-18 (O-16).** La base es la del **DUA** —valor en aduana +
 * aranceles + gravámenes y gastos hasta el primer lugar de destino (art. 83.Uno
 * LIVA)—, **no** la de la factura del proveedor, que ya se contabilizó sin IVA.
 * Los aranceles son **mayor coste** (NRV 10ª.1 y 2ª.1), nunca gasto financiero.
 */
export const duaImportacionSchema = z.object({
  ...baseDocumentDates,
  documentNumber: z.string().min(1).max(64),
  counterpartyId: uuidSchema.optional(),
  /** Valor en aduana declarado en el DUA. Sólo informa la casilla: no se asienta. */
  customsValueCents: centsSchema,
  /** Derechos arancelarios: mayor coste de la mercancía o del inmovilizado. */
  dutiesCents: centsSchema.default(0),
  /** Cuenta del mayor coste (600, 2xx…). Sin ella, la clave `ARANCELES`. */
  dutiesAccountCode: accountCodeSchema.optional(),
  vatQuotaCents: centsSchema,
  /** Art. 167.Dos LIVA y 74.1 RIVA: exige periodo MENSUAL. */
  importDeferral: z.boolean().default(false),
  periodKind: z.enum(["MENSUAL", "TRIMESTRAL"]).default("TRIMESTRAL"),
  /** Bien de inversión: cambia las casillas 32-33 por 34-35, no el asiento. */
  investmentGood: z.boolean().default(false),
  /** Contrapartida del importe a pagar a la Aduana o al transitario. */
  payableKey: z.enum(["ACREEDORES", "PROVEEDORES", "BANCO_DEFAULT", "CAJA"]).default("ACREEDORES"),
  payableAccountCode: accountCodeSchema.optional(),
  dueDate: localDateSchema.optional(),
  description: z.string().max(512).optional(),
  ...analyticFields,
})
export type DuaImportacionInput = z.infer<typeof duaImportacionSchema>

/**
 * **T-30 · R-FX-1…6 (O-4/O-5).** Una posición **monetaria** por fila, con su
 * `Δ = convertWithRateMicro(D, r) − S` ya calculado por `lib/closing/fx.ts`: la
 * plantilla **no convierte**, sella. `exchangeRateId` es obligatorio con divisa
 * (CHECK de `journal_lines`) y es la tasa efectiva del cierre (R-FX-5).
 */
export const diferenciasCambioSchema = z.object({
  /** Fecha de corte; es también la del asiento salvo `entryDate` explícito. */
  cutoff: localDateSchema,
  entryDate: localDateSchema.optional(),
  adjustments: z
    .array(
      z.object({
        accountCode: accountCodeSchema,
        counterpartyId: uuidSchema.optional(),
        currency: z.string().length(3),
        /** `Δ` con signo: `> 0` beneficio (768), `< 0` pérdida (668). */
        deltaCents: signedCentsSchema,
        exchangeRateId: uuidSchema,
        /** Tasa efectiva usada: la de mayor `rateDate ≤ cutoff` (R-FX-5). */
        rateDate: localDateSchema,
      })
    )
    .min(1),
  /** E4 · T6: 668/768 son FINANCIERO, nivel BAI, CECO `CC-FIN` por defecto. */
  financialCostCenterId: uuidSchema.optional(),
  description: z.string().max(512).optional(),
})
export type DiferenciasCambioInput = z.infer<typeof diferenciasCambioSchema>

/**
 * **T-31 · R-VA-1 (O-1).** El valor actual es **valoración inicial**, no ajuste
 * de cierre: esta plantilla es el **plan de corrección** de lo que no se hizo en
 * el alta. El caso **B** (alta de un ejercicio ya cerrado) **no entra aquí**: es
 * un error de ejercicios anteriores y se corrige con **T-22** contra `113`.
 */
export const AJUSTE_VALOR_ACTUAL_CASES = ["A_EJERCICIO_CORRIENTE", "C_NO_INMOVILIZADO"] as const

export const ajusteValorActualSchema = z.object({
  documentDate: localDateSchema.optional(),
  entryDate: localDateSchema,
  case: z.enum(AJUSTE_VALOR_ACTUAL_CASES),
  /** `PASIVO`: débito aplazado (523/173). `ACTIVO`: crédito aplazado (253/543). */
  side: z.enum(["PASIVO", "ACTIVO"]).default("PASIVO"),
  /** Cuenta de la deuda o del crédito aplazado. */
  positionAccountCode: accountCodeSchema.optional(),
  positionKey: z
    .enum(["PROVEEDORES_INMOVILIZADO", "DEUDA_LARGO_INMOVILIZADO", "CREDITO_ENAJENACION_CP", "CREDITO_ENAJENACION_LP"])
    .optional(),
  counterpartyId: uuidSchema.optional(),
  /** `nominal − valor actual`, siempre positivo. */
  discountCents: centsSchema.min(1),
  /** Caso A: cuenta del inmovilizado cuyo coste se reduce (2131, 216…). */
  assetAccountCode: accountCodeSchema.optional(),
  /** Caso C: cuenta de gasto o de ingreso original del mismo ejercicio. */
  originAccountCode: accountCodeSchema.optional(),
  /** Caso A: amortización dotada en exceso sobre el coste bruto, a revertir. */
  excessDepreciationCents: centsSchema.default(0),
  accumulatedAccountCode: accountCodeSchema.optional(),
  depreciationExpenseAccountCode: accountCodeSchema.optional(),
  fixedAssetId: uuidSchema.optional(),
  /** Interés implícito devengado hasta el corte: `662` (pasivo) o `762` (activo). */
  implicitInterestCents: centsSchema.default(0),
  description: z.string().max(512).optional(),
  ...analyticFields,
})
export type AjusteValorActualInput = z.infer<typeof ajusteValorActualSchema>

/**
 * **T-32 · R-RC-1…7 (O-7/O-8).** Un movimiento por par y contraparte, con suma
 * cero por par (I-E9-16). `side` decide la columna: una **deuda** se reclasifica
 * cargando la cuenta de origen y abonando la de destino; un **crédito**, al
 * revés. Los importes los fija `lib/closing/reclass.ts`; aquí no se decide nada.
 */
export const reclasificacionVencimientosSchema = z.object({
  cutoff: localDateSchema,
  entryDate: localDateSchema.optional(),
  moves: z
    .array(
      z.object({
        fromAccountCode: accountCodeSchema,
        toAccountCode: accountCodeSchema,
        amountCents: centsSchema.min(1),
        side: z.enum(["PASIVO", "ACTIVO"]),
        counterpartyId: uuidSchema.optional(),
        currency: z.string().length(3).optional(),
        dueDate: localDateSchema.optional(),
      })
    )
    .min(1),
  description: z.string().max(512).optional(),
})
export type ReclasificacionVencimientosInput = z.infer<typeof reclasificacionVencimientosSchema>

/** Campos comunes de la baja (T-33) y la venta (T-34) de inmovilizado. */
const disposalBase = {
  documentDate: localDateSchema,
  entryDate: localDateSchema.optional(),
  fixedAssetId: uuidSchema.optional(),
  /** Código del activo, para el concepto de las líneas. */
  assetCode: z.string().min(1).max(64),
  assetAccountCode: accountCodeSchema,
  accumulatedAccountCode: accountCodeSchema,
  /** Coste íntegro y amortización acumulada **hasta el mes de baja inclusive**. */
  acquisitionCostCents: centsSchema.min(1),
  accumulatedCents: centsSchema.default(0),
  /** Deterioro acumulado (29x), si lo hay: minora el VNC y se cancela. */
  impairmentCents: centsSchema.default(0),
  impairmentAccountCode: accountCodeSchema.optional(),
  description: z.string().max(512).optional(),
  ...analyticFields,
}

/**
 * **T-33 · R-AM-6 (O-24).** Baja sin contraprestación: `28x (D)` · `671 (D)` por
 * el VNC · `2xx (H)` por el coste íntegro. La dotación del mes de baja se postea
 * **antes** (T-14), no aquí.
 */
export const bajaInmovilizadoSchema = z.object({ ...disposalBase })
export type BajaInmovilizadoInput = z.infer<typeof bajaInmovilizadoSchema>

/**
 * **T-34 · R-AM-7 (O-24).** Venta: la contrapartida es `543` —o `253` si el
 * aplazamiento supera el año—, **nunca `430`**. El resultado va a `771`/`671` y
 * la cuota a `477`.
 */
export const ventaInmovilizadoSchema = z.object({
  ...disposalBase,
  counterpartyId: uuidSchema.optional(),
  priceCents: centsSchema,
  vatQuotaCents: centsSchema.default(0),
  taxRateCode: taxRateCodeSchema.optional(),
  /** `CREDITO_ENAJENACION_CP` (543) o `CREDITO_ENAJENACION_LP` (253). */
  receivableKey: z.enum(["CREDITO_ENAJENACION_CP", "CREDITO_ENAJENACION_LP"]).default("CREDITO_ENAJENACION_CP"),
  receivableAccountCode: accountCodeSchema.optional(),
  dueDate: localDateSchema.optional(),
})
export type VentaInmovilizadoInput = z.infer<typeof ventaInmovilizadoSchema>

/**
 * **T-35 · §4.9 (O-18).** Distribución del resultado acordada por la junta
 * (art. 164 LSC). La **reserva legal** la calcula `lib/closing/distribution.ts`
 * (art. 274 LSC) y no es editable a la baja; aquí llega ya calculada y la
 * plantilla comprueba que el reparto suma **exactamente** el resultado.
 */
export const distribucionResultadoSchema = z.object({
  /** Fecha de la junta (art. 164 LSC); el asiento va al ejercicio ABIERTO. */
  entryDate: localDateSchema,
  documentDate: localDateSchema.optional(),
  /** Beneficio a distribuir (saldo acreedor de `129`). Excluyente con `lossCents`. */
  profitCents: centsSchema.default(0),
  /** Pérdida del ejercicio (saldo deudor de `129`): `121 (D) / 129 (H)`. */
  lossCents: centsSchema.default(0),
  legalReserveCents: centsSchema.default(0),
  voluntaryReserveCents: centsSchema.default(0),
  remainderCents: centsSchema.default(0),
  /** Dividendo **total** acordado, incluido el ya satisfecho a cuenta. */
  dividendCents: centsSchema.default(0),
  /** Dividendo a cuenta ya satisfecho (`557`, deudora): se cancela aquí. */
  interimDividendPaidCents: centsSchema.default(0),
  /** Compensación de pérdidas de ejercicios anteriores (`121`). */
  priorLossesOffsetCents: centsSchema.default(0),
  description: z.string().max(512).optional(),
})
export type DistribucionResultadoInput = z.infer<typeof distribucionResultadoSchema>

/**
 * **T-36 · R-IVA-19 (O-14/O-15).** Barrido del 31 de diciembre del art. 163
 * *terdecies* LIVA: `4778 → 477` y `4728 → 472` de toda factura del año anterior
 * con cuota pendiente. Es una regla determinista, no un aviso.
 */
export const devengoReccSchema = z.object({
  cutoff: localDateSchema,
  entryDate: localDateSchema.optional(),
  pending: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        side: z.enum(["EMITIDA", "RECIBIDA"]),
        documentNumber: z.string().min(1).max(64),
        operationDate: localDateSchema,
        totalQuotaCents: centsSchema,
        accruedCents: centsSchema.default(0),
      })
    )
    .min(1),
  description: z.string().max(512).optional(),
})
export type DevengoReccInput = z.infer<typeof devengoReccSchema>

/**
 * **T-37 · R-RC-4 (O-6).** Alta de un préstamo **con su cuadro**: una línea de
 * `170`/`520` **por vencimiento de principal**, con su `dueDate`. Sin desglose,
 * el balance presenta cero en «Deudas a corto plazo» teniendo préstamos vivos y
 * `RECLASIFICACION_VENCIMIENTOS` queda en FAIL bloqueante (I-E9-25).
 */
export const altaPrestamoSchema = z.object({
  documentDate: localDateSchema,
  entryDate: localDateSchema.optional(),
  /** Código del cuadro (`DebtSchedule.code`), para el concepto y el `sourceId`. */
  scheduleCode: z.string().min(1).max(32),
  counterpartyId: uuidSchema.optional(),
  /** Par largo/corto validado contra `ReclassificationPair` (170↔520, 171↔521…). */
  longAccountCode: accountCodeSchema,
  shortAccountCode: accountCodeSchema,
  principalCents: centsSchema.min(1),
  bankKey: bankKeySchema.default("BANCO_DEFAULT"),
  bankAccountCode: accountCodeSchema.optional(),
  /** Comisión de apertura: línea propia, minora el efectivo recibido. */
  arrangementFeeCents: centsSchema.default(0),
  arrangementFeeAccountCode: accountCodeSchema.optional(),
  arrangementFeeCostCenterId: uuidSchema.optional(),
  /** Frontera corto/largo desde la fecha del alta (norma 6ª de elaboración). */
  currentThresholdMonths: z.number().int().min(1).max(120).default(12),
  installments: z
    .array(
      z.object({
        seq: z.number().int().min(1),
        dueDate: localDateSchema,
        /** Principal del vencimiento. El interés **no** se registra en el alta. */
        principalCents: centsSchema.min(1),
      })
    )
    .min(1),
  currency: z.string().length(3).optional(),
  description: z.string().max(512).optional(),
})
export type AltaPrestamoInput = z.infer<typeof altaPrestamoSchema>
