/**
 * E8 · T18 — recálculo en servidor de la factura emitida (G-21).
 *
 * Lo que estos tests defienden: que del cliente no entre **ninguna** cifra
 * derivada, que el redondeo sea half-even y que la rectificativa por sustitución
 * contabilice la diferencia y no el importe nuevo.
 */

import { describe, expect, it } from "vitest"

import {
  computeInvoiceTotals,
  lineBaseCents,
  QUANTITY_SCALE,
  substitutionDeltaByRate,
  withLineBases,
  type EmitInvoiceLine,
} from "./totals"

const IVA = { IVA_21: 2100, IVA_10: 1000, IVA_0: 0 } as Record<string, number>
const rateBps = (code: string) => (code in IVA ? IVA[code] : null)

const line = (over: Partial<EmitInvoiceLine> = {}): EmitInvoiceLine => ({
  description: "Servicio",
  quantityMilli: 1 * QUANTITY_SCALE,
  unitPriceCents: 100_000,
  taxRateCode: "IVA_21",
  ...over,
})

describe("lineBaseCents · cantidad × precio con un solo redondeo half-even", () => {
  it("cantidad entera", () => {
    expect(lineBaseCents(3 * QUANTITY_SCALE, 1_999)).toBe(5_997)
  })

  it("cantidad con decimales", () => {
    // 2,5 h × 45,00 € = 112,50 €
    expect(lineBaseCents(2_500, 4_500)).toBe(11_250)
  })

  it("empate exacto en medio céntimo → al PAR (half-even, ADR-0006)", () => {
    // 0,5 × 1 céntimo = 0,5 → 0 (par). 1,5 × 1 = 1,5 → 2 (par).
    expect(lineBaseCents(500, 1)).toBe(0)
    expect(lineBaseCents(1_500, 1)).toBe(2)
    expect(lineBaseCents(2_500, 1)).toBe(2)
    expect(lineBaseCents(3_500, 1)).toBe(4)
  })

  it("rechaza cantidades o precios no enteros: el dinero no es coma flotante", () => {
    expect(() => lineBaseCents(1.5, 100)).toThrow(TypeError)
    expect(() => lineBaseCents(1_000, 19.99)).toThrow(TypeError)
  })

  it("`withLineBases` conserva el orden y no toca nada más", () => {
    const lines = [line({ description: "A" }), line({ description: "B", quantityMilli: 2_000 })]
    expect(withLineBases(lines).map((l) => [l.description, l.baseCents])).toEqual([
      ["A", 100_000],
      ["B", 200_000],
    ])
  })
})

describe("computeInvoiceTotals · el servidor no lee ni una cifra del cliente", () => {
  it("una línea al 21 %", () => {
    const totals = computeInvoiceTotals([line()], { rateBps, taxRoundingMode: "PER_TIPO" })
    expect(totals.baseTotalCents).toBe(100_000)
    expect(totals.taxTotalCents).toBe(21_000)
    expect(totals.withholdingCents).toBe(0)
    expect(totals.totalCents).toBe(121_000)
  })

  it("dos tipos: una línea de cuota por tipo, en el orden de aparición", () => {
    const totals = computeInvoiceTotals(
      [line({ unitPriceCents: 100_000 }), line({ taxRateCode: "IVA_10", unitPriceCents: 50_000 })],
      { rateBps, taxRoundingMode: "PER_TIPO" }
    )
    expect(totals.taxByRate).toEqual([
      { taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 },
      { taxRateCode: "IVA_10", baseCents: 50_000, quotaCents: 5_000 },
    ])
    expect(totals.totalCents).toBe(176_000)
  })

  it("PER_TIPO agrega antes de redondear; PER_LINEA redondea línea a línea (R-IVA-1 / R-IVA-3)", () => {
    // Tres líneas de 3,33 € al 21 %: 0,6993 € por línea.
    const lines = [line({ unitPriceCents: 333 }), line({ unitPriceCents: 333 }), line({ unitPriceCents: 333 })]
    expect(computeInvoiceTotals(lines, { rateBps, taxRoundingMode: "PER_TIPO" }).taxTotalCents).toBe(210)
    expect(computeInvoiceTotals(lines, { rateBps, taxRoundingMode: "PER_LINEA" }).taxTotalCents).toBe(210)
    // Un caso donde SÍ divergen: 0,02 € al 21 % = 0,0042 → 0 por línea; agregado,
    // 0,06 € × 21 % = 0,0126 → 1 céntimo. El modo se sella en el asiento (R-IVA-4).
    const centimos = [line({ unitPriceCents: 2 }), line({ unitPriceCents: 2 }), line({ unitPriceCents: 2 })]
    expect(computeInvoiceTotals(centimos, { rateBps, taxRoundingMode: "PER_TIPO" }).taxTotalCents).toBe(1)
    expect(computeInvoiceTotals(centimos, { rateBps, taxRoundingMode: "PER_LINEA" }).taxTotalCents).toBe(0)
  })

  it("la retención se practica sobre la BASE, no sobre el total (R-IVA-6)", () => {
    const totals = computeInvoiceTotals([line()], {
      rateBps,
      taxRoundingMode: "PER_TIPO",
      withholdingRateBps: 1500,
    })
    expect(totals.withholdingCents).toBe(15_000)
    expect(totals.totalCents).toBe(100_000 + 21_000 - 15_000)
  })

  it("tipo exento: base sí, cuota no", () => {
    const totals = computeInvoiceTotals([line({ taxRateCode: "IVA_0" })], { rateBps, taxRoundingMode: "PER_TIPO" })
    expect(totals.taxTotalCents).toBe(0)
    expect(totals.totalCents).toBe(100_000)
  })

  it("un tipo que la organización no tiene vigente es un error, nunca un 0 %", () => {
    expect(() => computeInvoiceTotals([line({ taxRateCode: "IVA_INVENTADO" })], { rateBps, taxRoundingMode: "PER_TIPO" })).toThrow(
      /no está vigente/
    )
  })

  it("factura sin líneas y línea de base cero: se rechazan", () => {
    expect(() => computeInvoiceTotals([], { rateBps, taxRoundingMode: "PER_TIPO" })).toThrow(/al menos una línea/)
    expect(() =>
      computeInvoiceTotals([line({ quantityMilli: 1, unitPriceCents: 1 })], { rateBps, taxRoundingMode: "PER_TIPO" })
    ).toThrow(/base positiva/)
  })
})

describe("substitutionDeltaByRate · la rectificativa por sustitución contabiliza la DIFERENCIA (D12)", () => {
  it("100 000 → 80 000 abona 20 000, no 80 000", () => {
    expect(
      substitutionDeltaByRate([{ taxRateCode: "IVA_21", baseCents: 100_000 }], [{ taxRateCode: "IVA_21", baseCents: 80_000 }])
    ).toEqual([{ taxRateCode: "IVA_21", baseCents: 20_000 }])
  })

  it("un tipo que desaparece se abona entero", () => {
    expect(
      substitutionDeltaByRate(
        [
          { taxRateCode: "IVA_21", baseCents: 100_000 },
          { taxRateCode: "IVA_10", baseCents: 50_000 },
        ],
        [{ taxRateCode: "IVA_21", baseCents: 100_000 }]
      )
    ).toEqual([{ taxRateCode: "IVA_10", baseCents: 50_000 }])
  })

  it("rectificativa AL ALZA: se rechaza y se remite a la factura complementaria", () => {
    expect(() =>
      substitutionDeltaByRate(
        [{ taxRateCode: "IVA_21", baseCents: 80_000 }],
        [{ taxRateCode: "IVA_21", baseCents: 100_000 }]
      )
    ).toThrow(/complementaria/)
  })

  it("un tipo que no estaba en la original no se cuela por la rectificativa", () => {
    expect(() =>
      substitutionDeltaByRate(
        [{ taxRateCode: "IVA_21", baseCents: 100_000 }],
        [
          { taxRateCode: "IVA_21", baseCents: 80_000 },
          { taxRateCode: "IVA_10", baseCents: 10_000 },
        ]
      )
    ).toThrow(/no estaban en la factura original/)
  })

  it("sustitución que no cambia nada: no hay abono que emitir", () => {
    expect(() =>
      substitutionDeltaByRate([{ taxRateCode: "IVA_21", baseCents: 100_000 }], [{ taxRateCode: "IVA_21", baseCents: 100_000 }])
    ).toThrow(/no cambia ningún importe/)
  })
})
