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

import { hamilton } from "@/lib/analytics/allocate"
import type { Cents } from "@/lib/extraction/types"
import type { ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"
import { assertCents, convertWithRateMicro, sumCents } from "@/lib/money"

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

// ─────────────────────────────────────────────────────────────────────────────
// El reparto, UNA sola vez
// ─────────────────────────────────────────────────────────────────────────────

export type ConvertedDocument = {
  /** Base de cada línea del documento, en moneda base y en el mismo orden. */
  lineBases: readonly Cents[]
  /** Cuota de cada tipo en moneda base; su suma absorbe la diferencia. */
  quotaByRate: Readonly<Record<string, Cents>>
  /** Las mismas cuotas **en el orden recibido** (un documento puede repetir tipo). */
  quotaShares: readonly Cents[]
  /** Bruto convertido: `Σ bases + Σ cuotas`, exacto. */
  grossCents: Cents
}

/**
 * **El núcleo de la conversión de un documento (ADR-0014 D2).**
 *
 * `payable_EUR = convert(bruto)`, `base_i_EUR = convert(base_i)` y las **cuotas
 * absorben la diferencia**, repartida por mayor resto (Hamilton) con desempate
 * por código de tipo. No hay residuo que contabilizar: no existe.
 *
 * Vive aquí —y no en `lib/ledger/postFromProposal.ts`, que es quien la
 * consume— porque es aritmética de divisa, no de asiento, y porque tenerla dos
 * veces era tener dos repartos que divergen en el céntimo. `postFromProposal`
 * la re-exporta para no romper a quien ya la importaba de allí.
 *
 * @param grossTargetCents contravalor exacto que el reparto debe alcanzar.
 *        Por defecto `convert(Σ bases + Σ cuotas)`; el conversor de propuesta
 *        pasa el suyo porque su identidad incluye retención y anticipo.
 */
export function convertDocumentToBase(
  lines: readonly { baseCents: Cents }[],
  quotas: readonly { taxRateCode: string; quotaCents: Cents }[],
  rateMicro: bigint,
  opts: { grossTargetCents?: Cents } = {}
): ConvertedDocument {
  const grossOriginal = sumCents(lines.map((l) => l.baseCents)) + sumCents(quotas.map((q) => q.quotaCents))
  const grossCents = opts.grossTargetCents ?? convertCents(grossOriginal, rateMicro)
  const lineBases = lines.map((l) => convertCents(l.baseCents, rateMicro))
  const pool = grossCents - sumCents(lineBases)
  const shares = shareByLargestRemainder(
    pool,
    quotas.map((q) => ({ code: q.taxRateCode, weight: q.quotaCents }))
  )
  const quotaByRate: Record<string, Cents> = {}
  quotas.forEach((q, i) => {
    quotaByRate[q.taxRateCode] = shares[i]
  })
  return { lineBases, quotaByRate, quotaShares: shares, grossCents }
}

/**
 * Mayor resto sobre `hamilton()` —la misma función que reparte la liquidación
 * analítica— con dos adaptaciones que el documento necesita y la liquidación no:
 * pesos **todos negativos** (un abono) se reparten en valor absoluto y se les
 * devuelve el signo, y pesos **todos cero** reparten a partes iguales en vez de
 * devolver ceros y perder el importe.
 */
function shareByLargestRemainder(total: Cents, weights: readonly { code: string; weight: Cents }[]): Cents[] {
  assertCents(total, "total del reparto")
  if (weights.length === 0) return []
  const signs = weights.map((w) => (w.weight < 0 ? -1 : 1))
  const homogeneous = signs.every((s) => s === signs[0])
  const allZero = weights.every((w) => w.weight === 0)
  // El desempate de `hamilton` es por código MENOR: con el índice como código,
  // eso es «a igualdad de resto, la primera línea del documento».
  const keyed = weights.map((w, i) => ({
    code: `${String(i).padStart(4, "0")}|${w.code}`,
    weight: allZero ? 1 : Math.abs(w.weight),
  }))
  const shares = hamilton(Math.abs(total), keyed)
  const totalSign = total < 0 ? -1 : 1
  return shares.map((s, i) => (homogeneous ? totalSign * s.amountCents : Math.abs(s.amountCents) * signs[i]))
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
    // **El mismo reparto que el asiento** (`convertDocumentToBase`): con el
    // contravalor objetivo de esta identidad, que incluye retención y anticipo.
    convertedQuotas = [
      ...convertDocumentToBase(
        proposal.lines.map((line) => ({ baseCents: line.baseCents })),
        proposal.taxes.map((tax) => ({ taxRateCode: tax.taxRateCode, quotaCents: tax.quotaCents })),
        rate.rateMicro,
        { grossTargetCents: basesCents + quotaTargetCents }
      ).quotaShares,
    ]
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
  return shareByLargestRemainder(
    total,
    weights.map((weight, index) => ({ code: String(index), weight }))
  )
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
