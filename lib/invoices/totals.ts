/**
 * E8 · T18 (cierre de G-21) — recálculo de la factura emitida **en servidor**.
 *
 * El generador heredado enviaba `item.subtotal`, `tax.amount` y el total ya
 * calculados en el navegador y el servidor los guardaba tal cual: cualquiera con
 * las herramientas de desarrollador emitía una factura de 12 000 € cuyo asiento
 * decía 1 200 €. Aquí el cliente sólo manda **cantidad, precio unitario y código
 * de tipo**; todo lo demás se recalcula, en céntimos enteros y con redondeo
 * half-even (ADR-0006), y las cifras del cliente no se leen nunca (P1).
 *
 * Módulo **puro**: sin IO, sin reloj, sin Prisma. La cuota y la retención se
 * calculan con las mismas funciones del motor de E3 (`lib/ledger/tax.ts`), de
 * modo que el total que se le pasa a la plantilla y el que la plantilla
 * recalcula en `checkDocument` no pueden divergir por una aritmética paralela.
 */

import type { Cents } from "@/lib/money"
import { roundHalfEven, sumCents } from "@/lib/money"
import { cuota, groupBasesByRate, retencion } from "@/lib/ledger/tax"
import type { TaxRoundingMode } from "@/lib/ledger/types"

/** Escala de la cantidad: milésimas de unidad (3 decimales), entero. */
export const QUANTITY_SCALE = 1000

export type EmitInvoiceLine = {
  description: string
  /** Cantidad × 1000, entero. `2,5 h` → `2500`. */
  quantityMilli: number
  unitPriceCents: Cents
  taxRateCode: string
  revenueAccountCode?: string
  projectId?: string
  costCenterId?: string
}

export type ComputedLine = EmitInvoiceLine & { baseCents: Cents }

/**
 * Base de una línea: `cantidad × precio unitario`, con **un solo** redondeo
 * half-even al céntimo. Nunca `parseFloat`, nunca el subtotal del cliente.
 */
export function lineBaseCents(quantityMilli: number, unitPriceCents: Cents): Cents {
  if (!Number.isInteger(quantityMilli) || !Number.isInteger(unitPriceCents)) {
    throw new TypeError("cantidad (milésimas) y precio unitario (céntimos) deben ser enteros")
  }
  return roundHalfEven((quantityMilli * unitPriceCents) / QUANTITY_SCALE)
}

/** Añade a cada línea su base recalculada. El orden se conserva. */
export function withLineBases(lines: readonly EmitInvoiceLine[]): ComputedLine[] {
  return lines.map((line) => ({ ...line, baseCents: lineBaseCents(line.quantityMilli, line.unitPriceCents) }))
}

export type RateLookup = (taxRateCode: string) => number | null

export type InvoiceTotals = {
  lines: ComputedLine[]
  baseTotalCents: Cents
  /** Cuota por tipo, en el orden en que aparecen los tipos en las líneas. */
  taxByRate: { taxRateCode: string; baseCents: Cents; quotaCents: Cents }[]
  taxTotalCents: Cents
  withholdingCents: Cents
  totalCents: Cents
}

/**
 * Totales del documento. `rateBps` los resuelve el llamante contra el
 * `LedgerContext` (los tipos vigentes al devengo, art. 90.Dos LIVA): esta
 * función no conoce la base de datos.
 *
 * @throws si un código de tipo no existe: emitir una factura con un IVA que la
 * organización no tiene configurada es un error de configuración, no un 0 %.
 */
export function computeInvoiceTotals(
  lines: readonly EmitInvoiceLine[],
  opts: { rateBps: RateLookup; taxRoundingMode: TaxRoundingMode; withholdingRateBps?: number | null }
): InvoiceTotals {
  const computed = withLineBases(lines)
  if (computed.length === 0) {
    throw new Error("Una factura tiene al menos una línea")
  }
  if (computed.some((l) => l.baseCents < 1)) {
    throw new Error("Toda línea de la factura tiene base positiva; para minorar se emite una rectificativa")
  }

  const baseTotalCents = sumCents(computed.map((l) => l.baseCents))

  const taxByRate = groupBasesByRate(
    computed.map((l) => ({ baseCents: l.baseCents, taxRateCode: l.taxRateCode }))
  ).map((group) => {
    const bps = opts.rateBps(group.code)
    if (bps === null) throw new Error(`El tipo impositivo ${group.code} no está vigente en esta organización`)
    return {
      taxRateCode: group.code,
      baseCents: sumCents(group.bases),
      quotaCents: cuota(group.bases, bps, opts.taxRoundingMode),
    }
  })
  const taxTotalCents = sumCents(taxByRate.map((t) => t.quotaCents))

  // La retención se practica sobre la BASE del documento, no sobre el total.
  const withholdingCents = opts.withholdingRateBps ? retencion(baseTotalCents, opts.withholdingRateBps) : 0

  return {
    lines: computed,
    baseTotalCents,
    taxByRate,
    taxTotalCents,
    withholdingCents,
    totalCents: baseTotalCents + taxTotalCents - withholdingCents,
  }
}

/**
 * Rectificativa por **sustitución** (ADR-0014 D12): la factura nueva fija los
 * importes definitivos, y lo que se contabiliza es la **diferencia** contra la
 * original. Contabilizar la cifra nueva duplicaría la operación.
 *
 * Devuelve, por tipo impositivo, la base que hay que abonar. Una rectificativa
 * **al alza** no cabe en un abono: se rechaza y se remite a emitir la factura
 * complementaria, que es lo que el art. 15 RD 1619/2012 espera.
 */
export function substitutionDeltaByRate(
  original: readonly { taxRateCode: string; baseCents: Cents }[],
  replacement: readonly { taxRateCode: string; baseCents: Cents }[]
): { taxRateCode: string; baseCents: Cents }[] {
  const after = new Map<string, Cents>()
  for (const r of replacement) after.set(r.taxRateCode, (after.get(r.taxRateCode) ?? 0) + r.baseCents)

  const deltas: { taxRateCode: string; baseCents: Cents }[] = []
  for (const o of original) {
    const newBase = after.get(o.taxRateCode) ?? 0
    after.delete(o.taxRateCode)
    const delta = o.baseCents - newBase
    if (delta < 0) {
      throw new Error(
        `La rectificativa por sustitución sube la base del tipo ${o.taxRateCode} (${o.baseCents} → ${newBase}): ` +
          "una rectificativa al alza se emite como factura complementaria, no como abono"
      )
    }
    if (delta > 0) deltas.push({ taxRateCode: o.taxRateCode, baseCents: delta })
  }
  const extra = [...after.keys()]
  if (extra.length > 0) {
    throw new Error(
      `La rectificativa por sustitución introduce tipos que no estaban en la factura original: ${extra.join(", ")}`
    )
  }
  if (deltas.length === 0) {
    throw new Error("La rectificativa por sustitución no cambia ningún importe: no hay nada que abonar")
  }
  return deltas
}
