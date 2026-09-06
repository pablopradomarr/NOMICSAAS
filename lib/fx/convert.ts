/**
 * E8 · T10 — Conversión de una propuesta a la moneda base. Módulo **PURO**:
 * sin IO, sin Prisma, sin red, sin `Date.now()`. La tasa entra por parámetro.
 *
 * ## La decisión que gobierna el fichero (ADR-0014 D2)
 *
 * En el reconocimiento inicial **no hay diferencia de cambio** (NRV 11ª): todo
 * el documento se valora al tipo de contado de la fecha de la transacción. Si
 * se convierte cada importe por separado y se redondea, la suma de las partes
 * no da el todo y aparece un céntimo huérfano. Contabilizarlo sería inventar un
 * resultado financiero que la norma no reconoce; dejarlo descuadraría el asiento.
 *
 * Por eso el residuo **se elimina por construcción**:
 *
 * ```
 * payable_EUR = convert(total_divisa)          ← lo que se debe, al céntimo
 * base_i_EUR  = convert(base_i_divisa)         ← siguen siendo líneas del documento
 * cuota_EUR   = payable_EUR − Σ base_i_EUR     ← repartida entre tipos por mayor resto
 * ```
 *
 * Cero residuo, cero línea de ajuste, y el drill-down sigue llevando a una línea
 * real del PDF. Si alguna vez procediera reconocer un residuo de conversión, su
 * cuenta sería **668/768**, jamás 669/769, que está reservado al redondeo de
 * tesorería (ADR-0014 D3).
 *
 * **Excepción declarada:** un documento sin línea de impuesto (exento,
 * exportación) no tiene dónde absorber la diferencia. En ese caso la absorben
 * las **bases**, también por mayor resto. La alternativa —una línea de ajuste—
 * metería en el asiento un concepto que no existe en el documento.
 */

import type { Cents } from "@/lib/extraction/types"
import type { ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"
import { assertCents, convertWithRateMicro, splitLargestRemainder, sumCents } from "@/lib/money"

export type LocalDateString = string

/** 1,000000 en micro-unidades. `target = ES2017` no admite literales `1n`. */
export const ONE_MICRO = BigInt(1_000_000)
const ZERO_MICRO = BigInt(0)

/**
 * Tasa aplicada, copiada al asiento. `id` es la fila de `exchange_rates`; es
 * `null` sólo en la identidad (misma moneda), que no se persiste.
 */
export type RateRef = {
  id: string | null
  from: string
  to: string
  /** Tipo × 1 000 000. `amount_to = amount_from × rateMicro / 1e6`. */
  rateMicro: bigint
  /** Fecha REAL de la tasa. Puede ser anterior al `documentDate` (D2). */
  rateDate: LocalDateString
  source: string
}

export class FxConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FxConversionError"
  }
}

/** Convierte un importe en céntimos con la tasa en micro-unidades (half-even). */
export function convertCents(cents: Cents, rateMicro: bigint): Cents {
  return convertWithRateMicro(cents, rateMicro)
}

export type ConversionReport = {
  /** Contravalor exacto del total del documento. Es la cifra que se debe. */
  payableCents: Cents
  /** Suma de bases convertidas. */
  basesCents: Cents
  /** Cuota total que el reparto tenía que alcanzar. */
  quotaTargetCents: Cents
  /** Dónde absorbió la diferencia: en las cuotas o —sin impuestos— en las bases. */
  absorbedBy: "cuotas" | "bases" | "nada"
  /** **Siempre 0.** Si no lo fuera, el reparto estaría mal y el test lo dice. */
  residualCents: Cents
}

/**
 * Convierte la propuesta a `baseCurrency`.
 *
 * @param proposal propuesta en divisa. No se muta.
 * @param rate tasa `proposal.currency → baseCurrency` a la fecha del documento.
 * @param baseCurrency moneda base de la organización (ISO 4217).
 * @returns la MISMA propuesta si ya está en moneda base; si no, una copia en
 *          moneda base cuya identidad interna cierra con **tolerancia 0**.
 * @throws FxConversionError si la tasa no es la del par pedido.
 */
export function convertProposal(
  proposal: ExtractionProposal,
  rate: RateRef,
  baseCurrency: string
): ExtractionProposal {
  return convertProposalWithReport(proposal, rate, baseCurrency).proposal
}

export function convertProposalWithReport(
  proposal: ExtractionProposal,
  rate: RateRef,
  baseCurrency: string
): { proposal: ExtractionProposal; report: ConversionReport } {
  const base = baseCurrency.toUpperCase()
  const from = proposal.currency.toUpperCase()

  if (from === base) {
    return {
      proposal,
      report: {
        payableCents: proposal.totalCents,
        basesCents: sumCents(proposal.lines.map((line) => line.baseCents)),
        quotaTargetCents: sumCents(proposal.taxes.map((tax) => tax.quotaCents)),
        absorbedBy: "nada",
        residualCents: 0,
      },
    }
  }

  if (rate.from.toUpperCase() !== from || rate.to.toUpperCase() !== base) {
    throw new FxConversionError(
      `La tasa es ${rate.from}→${rate.to} y el documento pide ${from}→${base}: convertir con otro par ` +
        "produciría una cifra plausible y falsa"
    )
  }
  if (rate.rateMicro <= ZERO_MICRO) {
    throw new FxConversionError(`rateMicro debe ser positivo, recibido ${rate.rateMicro.toString()}`)
  }

  const conv = (cents: Cents): Cents => convertCents(cents, rate.rateMicro)

  const payableCents = conv(proposal.totalCents)

  // ── Bases de línea ──────────────────────────────────────────────────────────
  const lineBases = proposal.lines.map((line) => conv(line.baseCents))
  const basesCents = sumCents(lineBases)

  // ── Reducciones del total que no son base ni cuota ─────────────────────────
  const withholdingCents = proposal.withholding ? conv(proposal.withholding.quotaCents) : 0
  const advanceCents = proposal.appliedAdvanceCents ? conv(proposal.appliedAdvanceCents) : 0

  /**
   * Identidad que el documento en divisa cumple (o no). Si NO la cumple, el
   * desajuste es del documento y lo detecta `reconcile`: la conversión no lo
   * arregla ni lo esconde, lo arrastra convertido. Absorberlo aquí sería
   * fabricar una factura que cuadra y no existe.
   */
  const originalImplied =
    sumCents(proposal.lines.map((line) => line.baseCents)) +
    sumCents(proposal.taxes.map((tax) => tax.quotaCents)) -
    (proposal.withholding?.quotaCents ?? 0) -
    (proposal.appliedAdvanceCents ?? 0)
  const originalResidual = proposal.totalCents - originalImplied
  const carriedResidual = originalResidual === 0 ? 0 : conv(originalResidual)

  const quotaTargetCents = payableCents - basesCents + withholdingCents + advanceCents - carriedResidual

  let convertedBases = lineBases
  let convertedQuotas: Cents[]
  let absorbedBy: ConversionReport["absorbedBy"]

  if (proposal.taxes.length > 0) {
    convertedQuotas = distribute(quotaTargetCents, proposal.taxes.map((tax) => tax.quotaCents))
    absorbedBy = "cuotas"
  } else if (quotaTargetCents === 0) {
    convertedQuotas = []
    absorbedBy = "nada"
  } else if (proposal.lines.length > 0) {
    // Documento exento / exportación: no hay cuota que absorba el céntimo.
    convertedBases = distribute(basesCents + quotaTargetCents, proposal.lines.map((line) => line.baseCents))
    convertedQuotas = []
    absorbedBy = "bases"
  } else {
    throw new FxConversionError(
      "La propuesta no tiene ni líneas ni impuestos donde absorber la diferencia de conversión"
    )
  }

  const lines: ProposalLine[] = proposal.lines.map((line, index) => ({
    ...line,
    baseCents: convertedBases[index],
    ...(line.discountCents !== undefined ? { discountCents: conv(line.discountCents) } : {}),
    ...(line.unitPriceCents !== undefined ? { unitPriceCents: conv(line.unitPriceCents) } : {}),
  }))

  /**
   * La base de cada tipo se recompone desde las líneas ya convertidas, no se
   * convierte por su cuenta: así el pie del documento sigue cuadrando con sus
   * líneas en moneda base, que es lo que mira el libro registro de IVA.
   */
  const taxes: ProposalTax[] = proposal.taxes.map((tax, index) => ({
    ...tax,
    baseCents: taxBaseFromLines(proposal.lines, lines, tax.taxRateCode) ?? conv(tax.baseCents),
    quotaCents: convertedQuotas[index],
  }))

  const converted: ExtractionProposal = {
    ...proposal,
    currency: base,
    lines,
    taxes,
    totalCents: payableCents,
    ...(proposal.withholding
      ? { withholding: { ...proposal.withholding, quotaCents: withholdingCents } }
      : {}),
    ...(proposal.appliedAdvanceCents !== undefined ? { appliedAdvanceCents: advanceCents } : {}),
    ...(proposal.appliedAdvanceTaxCents !== undefined
      ? { appliedAdvanceTaxCents: conv(proposal.appliedAdvanceTaxCents) }
      : {}),
    ...(proposal.dueSchedule
      ? {
          dueSchedule: distribute(payableCents, proposal.dueSchedule.map((due) => due.amountCents)).map(
            (amountCents, index) => ({ dueDate: proposal.dueSchedule![index].dueDate, amountCents })
          ),
        }
      : {}),
  }

  const achievedQuota = sumCents(converted.taxes.map((tax) => tax.quotaCents))
  const achievedBases = sumCents(converted.lines.map((line) => line.baseCents))
  const residualCents =
    payableCents - (achievedBases + achievedQuota - withholdingCents - advanceCents + carriedResidual)

  return {
    proposal: converted,
    report: {
      payableCents,
      basesCents: achievedBases,
      quotaTargetCents,
      absorbedBy,
      residualCents,
    },
  }
}

/**
 * Reparto de Hamilton (mayor resto) de `total` con pesos `|weights|`,
 * conservando el signo de cada peso original cuando todos comparten signo.
 *
 * `splitLargestRemainder` reparte un total con signo único; una factura mezcla
 * signos sólo en casos patológicos (una línea negativa dentro de una factura
 * positiva). Cuando ocurre, se reparte sobre los valores absolutos y se
 * devuelve el signo original de cada elemento, de modo que **la suma sigue
 * siendo exacta** para el caso homogéneo, que es el 100 % de los documentos
 * reales, y no se corrompe el signo en el caso raro.
 */
function distribute(total: Cents, weights: readonly Cents[]): Cents[] {
  assertCents(total, "total del reparto")
  if (weights.length === 0) return []
  const signs = weights.map((weight) => (weight < 0 ? -1 : 1))
  const homogeneous = signs.every((sign) => sign === signs[0])
  const shares = splitLargestRemainder(total, weights.map((weight) => Math.abs(weight)))
  if (homogeneous) return shares
  return shares.map((share, index) => Math.abs(share) * signs[index])
}

/** Suma de las bases YA convertidas de las líneas con ese tipo; `null` si no hay. */
function taxBaseFromLines(
  original: readonly ProposalLine[],
  converted: readonly ProposalLine[],
  taxRateCode: string
): Cents | null {
  const indexes = original
    .map((line, index) => (line.taxRateCode === taxRateCode ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length === 0) return null
  return sumCents(indexes.map((index) => converted[index].baseCents))
}
