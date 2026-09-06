/**
 * E8 · T10 — Conversión: el residuo tiene que ser CERO, siempre.
 *
 * Un solo enunciado con muchas formas: convertido el documento, la identidad
 * `total = Σ bases + Σ cuotas − retención − anticipo` sigue cerrando con
 * **tolerancia 0**, y el total en moneda base es exactamente el contravalor del
 * total del documento. Si alguna vez estos tests fallan por un céntimo, el
 * asiento que saldría de ahí no cuadraría o llevaría una línea de ajuste que la
 * NRV 11ª no reconoce en el reconocimiento inicial.
 */

import { describe, expect, it } from "vitest"

import { convertCents, convertProposal, convertProposalWithReport, FxConversionError, type RateRef } from "@/lib/fx/convert"
import type { ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"
import { sumCents } from "@/lib/money"

const rate = (rateMicro: bigint, from = "USD", to = "EUR"): RateRef => ({
  id: "11111111-1111-4111-8111-111111111111",
  from,
  to,
  rateMicro,
  rateDate: "2026-03-04",
  source: "ECB_FRANKFURTER",
})

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  const lines: ProposalLine[] = overrides.lines
    ? [...overrides.lines]
    : [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA21" }]
  const taxes: ProposalTax[] = overrides.taxes
    ? [...overrides.taxes]
    : [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }]
  const total =
    overrides.totalCents ??
    sumCents(lines.map((line) => line.baseCents)) + sumCents(taxes.map((tax) => tax.quotaCents))
  return {
    version: 1,
    docKind: "FACTURA_RECIBIDA",
    documentNumber: "F-1",
    counterparty: { name: "Acme Inc", taxId: "US-99" },
    documentDate: "2026-03-04",
    receptionDate: "2026-03-10",
    currency: "USD",
    lines,
    taxes,
    totalCents: total,
    ...overrides,
  }
}

/** Identidad interna del documento, la misma que comprueba `reconcile`. */
const implied = (p: ExtractionProposal): number =>
  sumCents(p.lines.map((line) => line.baseCents)) +
  sumCents(p.taxes.map((tax) => tax.quotaCents)) -
  (p.withholding?.quotaCents ?? 0) -
  (p.appliedAdvanceCents ?? 0)

describe("convertCents", () => {
  it("convierte con redondeo half-even", () => {
    expect(convertCents(10_000, 920_000n)).toBe(9_200)
    expect(convertCents(1, 1_500_000n)).toBe(2) // 1,5 → 2 (par)
    expect(convertCents(3, 500_000n)).toBe(2) // 1,5 → 2 (par)
    expect(convertCents(1, 500_000n)).toBe(0) // 0,5 → 0 (par)
  })

  it("respeta el signo de un abono", () => {
    expect(convertCents(-10_000, 920_000n)).toBe(-9_200)
  })

  it("la identidad devuelve el mismo importe", () => {
    expect(convertCents(123_456, 1_000_000n)).toBe(123_456)
  })
})

describe("convertProposal — residuo cero (ADR-0014 D2)", () => {
  it("no toca la propuesta si ya está en moneda base", () => {
    const p = proposal({ currency: "EUR" })
    expect(convertProposal(p, rate(920_000n, "EUR", "EUR"), "EUR")).toBe(p)
  })

  it("caso simple: total convertido exacto y cuota absorbiendo la diferencia", () => {
    const p = proposal()
    const { proposal: c, report } = convertProposalWithReport(p, rate(920_000n), "EUR")
    expect(c.currency).toBe("EUR")
    expect(c.totalCents).toBe(convertCents(121_000, 920_000n))
    expect(implied(c)).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
    expect(report.absorbedBy).toBe("cuotas")
  })

  it("varios tipos: el céntimo huérfano se reparte por mayor resto y no se pierde", () => {
    const p = proposal({
      lines: [
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: "IVA21" },
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: "IVA10" },
        { kind: "OPERACION", baseCents: 3_334, taxRateCode: "IVA04" },
      ],
      taxes: [
        { taxRateCode: "IVA21", baseCents: 3_333, quotaCents: 700 },
        { taxRateCode: "IVA10", baseCents: 3_333, quotaCents: 333 },
        { taxRateCode: "IVA04", baseCents: 3_334, quotaCents: 133 },
      ],
    })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(implied(c)).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
    expect(sumCents(c.taxes.map((t) => t.quotaCents))).toBe(report.quotaTargetCents)
    // Las bases NO se tocan cuando hay cuotas que absorban.
    expect(c.lines.map((l) => l.baseCents)).toEqual(p.lines.map((l) => convertCents(l.baseCents, 1_083_333n)))
  })

  it("documento exento (sin impuestos): absorben las BASES, y siguen sumando el total", () => {
    const p = proposal({
      lines: [
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: null },
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: null },
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: null },
      ],
      taxes: [],
      totalCents: 9_999,
    })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(sumCents(c.lines.map((l) => l.baseCents))).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
    expect(report.absorbedBy).toBe("bases")
  })

  it("con retención: la retención se convierte y la identidad sigue cerrando", () => {
    const p = proposal({
      lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA21" }],
      taxes: [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }],
      withholding: { rateCode: "IRPF15", quotaCents: 15_000 },
      totalCents: 106_000,
    })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_087_312n), "EUR")
    expect(implied(c)).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
    expect(c.withholding?.quotaCents).toBe(convertCents(15_000, 1_087_312n))
  })

  it("con anticipo aplicado: también entra en la identidad", () => {
    const p = proposal({
      lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA21" }],
      taxes: [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }],
      appliedAdvanceCents: 30_000,
      appliedAdvanceTaxCents: 5_207,
      totalCents: 91_000,
    })
    const { proposal: c, report } = convertProposalWithReport(p, rate(913_777n), "EUR")
    expect(implied(c)).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
  })

  it("abono (todo negativo): el reparto conserva el signo y el residuo sigue siendo cero", () => {
    const p = proposal({
      docKind: "ABONO_RECIBIDO",
      lines: [
        { kind: "OPERACION", baseCents: -3_333, taxRateCode: "IVA21" },
        { kind: "OPERACION", baseCents: -6_667, taxRateCode: "IVA10" },
      ],
      taxes: [
        { taxRateCode: "IVA21", baseCents: -3_333, quotaCents: -700 },
        { taxRateCode: "IVA10", baseCents: -6_667, quotaCents: -667 },
      ],
    })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(c.totalCents).toBeLessThan(0)
    expect(implied(c)).toBe(c.totalCents)
    expect(report.residualCents).toBe(0)
  })

  it("un documento que NO cuadra en divisa tampoco cuadra en euros: el desajuste se arrastra, no se esconde", () => {
    const p = proposal({
      lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA21" }],
      taxes: [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }],
      totalCents: 121_050, // 50 céntimos de más: es un error del documento
    })
    const { proposal: c } = convertProposalWithReport(p, rate(1_000_000n), "EUR")
    expect(c.totalCents - implied(c)).toBe(50)
  })

  it("los vencimientos se reparten hasta sumar EXACTAMENTE el total convertido", () => {
    const p = proposal({
      dueSchedule: [
        { dueDate: "2026-04-04", amountCents: 40_333 },
        { dueDate: "2026-05-04", amountCents: 40_333 },
        { dueDate: "2026-06-04", amountCents: 40_334 },
      ],
    })
    const { proposal: c } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(sumCents(c.dueSchedule!.map((due) => due.amountCents))).toBe(c.totalCents)
  })

  it("la base de cada tipo se recompone desde sus líneas ya convertidas", () => {
    const p = proposal({
      lines: [
        { kind: "OPERACION", baseCents: 1_111, taxRateCode: "IVA21" },
        { kind: "OPERACION", baseCents: 2_222, taxRateCode: "IVA21" },
        { kind: "OPERACION", baseCents: 3_333, taxRateCode: "IVA10" },
      ],
      taxes: [
        { taxRateCode: "IVA21", baseCents: 3_333, quotaCents: 700 },
        { taxRateCode: "IVA10", baseCents: 3_333, quotaCents: 333 },
      ],
    })
    const { proposal: c } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(c.taxes[0].baseCents).toBe(c.lines[0].baseCents + c.lines[1].baseCents)
    expect(c.taxes[1].baseCents).toBe(c.lines[2].baseCents)
  })

  it("es determinista: dos conversiones de lo mismo dan lo mismo", () => {
    const p = proposal({ lines: [{ kind: "OPERACION", baseCents: 7_777, taxRateCode: "IVA21" }] })
    const a = convertProposal(p, rate(1_083_333n), "EUR")
    const b = convertProposal(p, rate(1_083_333n), "EUR")
    expect(a).toEqual(b)
  })

  it("no muta la propuesta original", () => {
    const p = proposal()
    const snapshot = JSON.stringify(p)
    convertProposal(p, rate(920_000n), "EUR")
    expect(JSON.stringify(p)).toBe(snapshot)
  })

  it("rechaza una tasa de otro par: convertir con el tipo equivocado da una cifra plausible y falsa", () => {
    expect(() => convertProposal(proposal(), rate(920_000n, "GBP", "EUR"), "EUR")).toThrow(FxConversionError)
    expect(() => convertProposal(proposal(), rate(920_000n, "USD", "GBP"), "EUR")).toThrow(FxConversionError)
  })

  it("rechaza una tasa no positiva", () => {
    expect(() => convertProposal(proposal(), rate(0n), "EUR")).toThrow(FxConversionError)
  })

  it("propuesta sin líneas ni impuestos: el total entero es desajuste del documento y se arrastra tal cual", () => {
    const p = proposal({ lines: [], taxes: [], totalCents: 1 })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(c.totalCents).toBe(convertCents(1, 1_083_333n))
    expect(report.absorbedBy).toBe("nada")
    expect(report.residualCents).toBe(0)
  })

  it("propuesta a cero: convertir cero es cero, sin residuo", () => {
    const p = proposal({ lines: [], taxes: [], totalCents: 0 })
    const { proposal: c, report } = convertProposalWithReport(p, rate(1_083_333n), "EUR")
    expect(c.totalCents).toBe(0)
    expect(report.residualCents).toBe(0)
  })
})

describe("residuo cero — barrido sobre tasas y bases", () => {
  it("cien combinaciones de tasa y base cierran con tolerancia 0", () => {
    const rates = [830_017n, 920_000n, 1_083_333n, 1_000_001n, 1_170_913n]
    const bases = [1, 7, 99, 3_333, 100_007, 999_983, 1_234_567]
    let checked = 0
    for (const rateMicro of rates) {
      for (const baseCents of bases) {
        for (const quota of [0, Math.round(baseCents * 0.21), Math.round(baseCents * 0.1)]) {
          const p = proposal({
            lines: [
              { kind: "OPERACION", baseCents, taxRateCode: "IVA21" },
              { kind: "OPERACION", baseCents: baseCents + 1, taxRateCode: "IVA10" },
            ],
            taxes: [
              { taxRateCode: "IVA21", baseCents, quotaCents: quota },
              { taxRateCode: "IVA10", baseCents: baseCents + 1, quotaCents: quota + 1 },
            ],
          })
          const { proposal: c, report } = convertProposalWithReport(p, rate(rateMicro), "EUR")
          expect(report.residualCents).toBe(0)
          expect(implied(c)).toBe(c.totalCents)
          checked += 1
        }
      }
    }
    expect(checked).toBe(105)
  })
})
