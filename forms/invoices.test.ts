/**
 * E8 · T18 — el esquema de emisión sólo acepta lo que el cliente puede decidir.
 *
 * Ni bases, ni cuotas, ni totales, ni el número de factura: la base la recalcula
 * el servidor (G-21) y el número lo da la serie (O-18). Zod **estricto**: una
 * clave de más es un error, no un campo que se ignora en silencio.
 */

import { describe, expect, it } from "vitest"

import { emitInvoiceSchema } from "./invoices"

const valid = {
  documentDate: "2026-03-15",
  lines: [{ description: "Consultoría", quantityMilli: 2_500, unitPriceCents: 4_500, taxRateCode: "IVA_21" }],
}

describe("emitInvoiceSchema", () => {
  it("acepta lo mínimo y aplica la serie ordinaria por defecto", () => {
    const parsed = emitInvoiceSchema.parse(valid)
    expect(parsed.seriesKind).toBe("ORDINARIA")
    expect(parsed.lines).toHaveLength(1)
  })

  it("RECHAZA cifras derivadas del cliente: base, cuota, total y número de factura", () => {
    for (const intruder of [
      { totalCents: 1 },
      { invoiceNumber: "F-00042" },
      { documentNumber: "F-00042" },
      { taxTotalCents: 1 },
    ]) {
      expect(() => emitInvoiceSchema.parse({ ...valid, ...intruder }), JSON.stringify(intruder)).toThrow()
    }
    expect(() =>
      emitInvoiceSchema.parse({ ...valid, lines: [{ ...valid.lines[0], baseCents: 11_250 }] })
    ).toThrow()
  })

  it("cantidad y precio son enteros positivos: el dinero no es coma flotante", () => {
    expect(() => emitInvoiceSchema.parse({ ...valid, lines: [{ ...valid.lines[0], quantityMilli: 2.5 }] })).toThrow()
    expect(() => emitInvoiceSchema.parse({ ...valid, lines: [{ ...valid.lines[0], unitPriceCents: 0 }] })).toThrow()
    expect(() => emitInvoiceSchema.parse({ ...valid, lines: [{ ...valid.lines[0], unitPriceCents: -100 }] })).toThrow()
  })

  it("una factura sin líneas no es una factura", () => {
    expect(() => emitInvoiceSchema.parse({ ...valid, lines: [] })).toThrow()
  })

  it("la fecha va en AAAA-MM-DD", () => {
    expect(() => emitInvoiceSchema.parse({ ...valid, documentDate: "15/03/2026" })).toThrow()
  })

  it("rectificar exige serie rectificativa, y la rectificativa exige causa y modo (art. 15 RD 1619/2012)", () => {
    const rectifies = {
      entryId: "11111111-1111-4111-8111-111111111111",
      reason: "ERROR" as const,
      mode: "SUSTITUCION" as const,
    }
    expect(() => emitInvoiceSchema.parse({ ...valid, seriesKind: "RECTIFICATIVA" })).toThrow(/causa y modo|rectifica/)
    expect(() => emitInvoiceSchema.parse({ ...valid, rectifies })).toThrow(/serie rectificativa/)
    expect(emitInvoiceSchema.parse({ ...valid, seriesKind: "RECTIFICATIVA", rectifies }).rectifies?.mode).toBe(
      "SUSTITUCION"
    )
  })
})
