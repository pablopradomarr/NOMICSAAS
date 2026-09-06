/**
 * E8 · T13 — `splitProposal`: N propuestas sobre UN documento, con la cuota
 * repartida por mayor resto y tolerancia 0 (criterio 22).
 */

import { describe, expect, it } from "vitest"

import { splitProposal } from "@/lib/extraction/split"
import type { ExtractionProposal } from "@/lib/extraction/types"

const base = (overrides: Partial<ExtractionProposal> = {}): ExtractionProposal => ({
  version: 1,
  docKind: "FACTURA_RECIBIDA",
  documentNumber: "F-2026-0001",
  counterparty: { name: "Proveedor SL", taxId: "B12345674" },
  documentDate: "2026-03-10",
  receptionDate: "2026-03-12",
  currency: "EUR",
  lines: [
    { kind: "OPERACION", baseCents: 33_333, taxRateCode: "IVA_21", accountCode: "629" },
    { kind: "OPERACION", baseCents: 33_333, taxRateCode: "IVA_21", accountCode: "629" },
    { kind: "OPERACION", baseCents: 33_334, taxRateCode: "IVA_21", accountCode: "629" },
  ],
  taxes: [{ taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 }],
  totalCents: 121_000,
  ...overrides,
})

describe("splitProposal", () => {
  it("tres grupos, tres propuestas, y la suma de totales es el total del documento", () => {
    const result = splitProposal(base(), [{ lineIndexes: [0] }, { lineIndexes: [1] }, { lineIndexes: [2] }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposals).toHaveLength(3)
    const totals = result.proposals.map((p) => p.totalCents)
    expect(totals.reduce((a, b) => a + b, 0)).toBe(121_000)
    const quotas = result.proposals.map((p) => p.taxes[0].quotaCents)
    // 21 000 repartidos sobre 33 333 / 33 333 / 33 334: ni un céntimo perdido.
    expect(quotas.reduce((a, b) => a + b, 0)).toBe(21_000)
    expect(quotas).toEqual([7_000, 7_000, 7_000])
  })

  it("cada grupo conserva sus líneas y sólo los tipos que usa", () => {
    const p = base({
      lines: [
        { kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA_21", accountCode: "217" },
        { kind: "OPERACION", baseCents: 20_000, taxRateCode: "IVA_10", accountCode: "629" },
      ],
      taxes: [
        { taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 },
        { taxRateCode: "IVA_10", baseCents: 20_000, quotaCents: 2_000 },
      ],
      totalCents: 143_000,
    })
    const result = splitProposal(p, [{ lineIndexes: [0] }, { lineIndexes: [1] }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposals[0].taxes.map((t) => t.taxRateCode)).toEqual(["IVA_21"])
    expect(result.proposals[0].totalCents).toBe(121_000)
    expect(result.proposals[1].taxes.map((t) => t.taxRateCode)).toEqual(["IVA_10"])
    expect(result.proposals[1].totalCents).toBe(22_000)
  })

  it("una línea fuera de todo grupo es un error: el documento entero se contabiliza", () => {
    const result = splitProposal(base(), [{ lineIndexes: [0] }, { lineIndexes: [1] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].code).toBe("SPLIT_NOT_A_PARTITION")
  })

  it("una línea en dos grupos a la vez es un error", () => {
    const result = splitProposal(base(), [{ lineIndexes: [0, 1] }, { lineIndexes: [1, 2] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.code)).toContain("SPLIT_LINE_REPEATED")
  })

  it("un índice inexistente es un error, no una línea vacía", () => {
    const result = splitProposal(base(), [{ lineIndexes: [0, 1] }, { lineIndexes: [2, 9] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].code).toBe("SPLIT_INDEX_OUT_OF_RANGE")
  })

  it("un documento con retención no se divide: la base de la retención es del documento", () => {
    const p = base({ withholding: { rateCode: "IRPF_15", quotaCents: 15_000 } })
    const result = splitProposal(p, [{ lineIndexes: [0] }, { lineIndexes: [1, 2] }])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].code).toBe("SPLIT_NOT_SPLITTABLE")
  })

  it("es determinista: dos splits iguales dan lo mismo", () => {
    const groups = [{ lineIndexes: [0, 2] }, { lineIndexes: [1] }]
    expect(JSON.stringify(splitProposal(base(), groups))).toBe(JSON.stringify(splitProposal(base(), groups)))
  })
})
