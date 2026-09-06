/**
 * E3 · T4 — `lib/ledger/tax.ts` (§0.1 del experto).
 */

import { describe, expect, it } from "vitest"

import {
  ajusteRedondeo,
  cuota,
  cuotaPorLinea,
  cuotaPorTipo,
  deducible,
  groupBasesByRate,
  overrideQuota,
  retencion,
  selectRate,
  taxAccrualDate,
  TOLERANCIA_CUOTA_IVA_CENTS,
} from "@/lib/ledger/tax"
import { testContext } from "@/tests/support/ledger-context"

describe("cuotaPorTipo / cuotaPorLinea (R-IVA-1 y R-IVA-3)", () => {
  it("sin bases (caso vacío) la cuota es 0", () => {
    expect(cuotaPorTipo([], 2100)).toBe(0)
    expect(cuotaPorLinea([], 2100)).toBe(0)
  })

  it("una sola base: los dos métodos coinciden", () => {
    expect(cuotaPorTipo([100000], 2100)).toBe(21000)
    expect(cuotaPorLinea([100000], 2100)).toBe(21000)
  })

  it("tres líneas de 33,33 € al 21 %: PER_TIPO da UNA cuota sobre la base agregada", () => {
    // R-IVA-1: applyBps(9999, 2100) = 2099,79 → 2100.
    expect(cuotaPorTipo([3333, 3333, 3333], 2100)).toBe(2100)
    // R-IVA-3: 700 + 700 + 700 (cada 3333 × 21 % = 699,93 → 700).
    expect(cuotaPorLinea([3333, 3333, 3333], 2100)).toBe(2100)
  })

  it("el modo sellado en el asiento decide cuál se aplica", () => {
    const bases = [1050, 1050, 1050]
    expect(cuota(bases, 2100, "PER_TIPO")).toBe(cuotaPorTipo(bases, 2100))
    expect(cuota(bases, 2100, "PER_LINEA")).toBe(cuotaPorLinea(bases, 2100))
  })

  it("half-up al céntimo, no half-even (R-IVA-2)", () => {
    // 50 × 21 % = 10,5 céntimos → 11 (half-up), no 10 (half-even).
    expect(cuotaPorTipo([50], 2100)).toBe(11)
  })

  it("tipo exento: cuota 0 (la plantilla omite la línea, C-3)", () => {
    expect(cuotaPorTipo([500000], 0)).toBe(0)
  })
})

describe("retencion (R-IVA-6)", () => {
  it("se calcula UNA vez sobre la base total del documento", () => {
    expect(retencion(800000, 1500)).toBe(120000)
    expect(retencion(120000, 1900)).toBe(22800)
  })

  it("base 0 → retención 0", () => {
    expect(retencion(0, 1500)).toBe(0)
  })
})

describe("deducible (prorrata, art. 103 LIVA)", () => {
  it("FULL: todo deducible", () => {
    expect(deducible(16800, "FULL", null)).toEqual({ deducibleCents: 16800, noDeducibleCents: 0 })
  })

  it("NONE: nada deducible, todo engorda el gasto", () => {
    expect(deducible(10500, "NONE", null)).toEqual({ deducibleCents: 0, noDeducibleCents: 10500 })
  })

  it("PRORRATA 90 %: 16.800 → 15.120 deducible y 1.680 no deducible", () => {
    expect(deducible(16800, "PRORRATA", 9000)).toEqual({ deducibleCents: 15120, noDeducibleCents: 1680 })
  })

  it("PRORRATA sin prorrataBps configurada devuelve null (PRORRATA_NOT_CONFIGURED)", () => {
    expect(deducible(16800, "PRORRATA", null)).toBeNull()
  })

  it("prorrata 0 %: nada deducible", () => {
    expect(deducible(16800, "PRORRATA", 0)).toEqual({ deducibleCents: 0, noDeducibleCents: 16800 })
  })
})

describe("ajusteRedondeo (R-IVA-7)", () => {
  const ctx = testContext({ redondeoToleranciaCents: 1 })

  it("diferencia 0 → sin línea", () => {
    expect(ajusteRedondeo(0, ctx)).toEqual({ kind: "NONE" })
  })

  it("1 céntimo de menos → gasto de redondeo; 1 de más → ingreso", () => {
    expect(ajusteRedondeo(1, ctx)).toEqual({ kind: "GASTO", amountCents: 1 })
    expect(ajusteRedondeo(-1, ctx)).toEqual({ kind: "INGRESO", amountCents: 1 })
  })

  it("5 céntimos con tolerancia 1 → error, y nada se persiste", () => {
    const r = ajusteRedondeo(5, ctx)
    expect(r.kind).toBe("ERROR")
    if (r.kind === "ERROR") expect(r.error.code).toBe("TAX_ROUNDING_EXCEEDED")
  })
})

describe("selectRate (C-10)", () => {
  const ctx = testContext()

  it("selecciona por la fecha del DOCUMENTO", () => {
    const r = selectRate(ctx, "IVA_21", "2026-03-10", "SALE")
    expect("rate" in r && r.rate.rateBps).toBe(2100)
  })

  it("un documento anterior a la vigencia no coge el tipo de hoy", () => {
    const r = selectRate(ctx, "IVA_21", "2024-06-01", "SALE")
    expect("error" in r && r.error.code).toBe("TAX_RATE_NOT_IN_FORCE")
  })

  it("tipo inexistente → TAX_RATE_NOT_IN_FORCE", () => {
    const r = selectRate(ctx, "IVA_INVENTADO", "2026-03-10", "SALE")
    expect("error" in r && r.error.code).toBe("TAX_RATE_NOT_IN_FORCE")
  })

  it("un tipo de solo compra no vale del lado venta (TAX_SIDE_MISMATCH)", () => {
    const r = selectRate(ctx, "IVA_ISP", "2026-03-10", "SALE")
    expect("error" in r && r.error.code).toBe("TAX_SIDE_MISMATCH")
  })
})

describe("groupBasesByRate", () => {
  it("sin líneas devuelve una lista vacía", () => {
    expect(groupBasesByRate([])).toEqual([])
  })

  it("agrupa conservando el orden de aparición", () => {
    const groups = groupBasesByRate([
      { baseCents: 500000, taxRateCode: "IVA_21" },
      { baseCents: 120000, taxRateCode: "IVA_10" },
      { baseCents: 100000, taxRateCode: "IVA_21" },
    ])
    expect(groups.map((g) => g.code)).toEqual(["IVA_21", "IVA_10"])
    expect(groups[0].bases).toEqual([500000, 100000])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E8 · T9b — cuota del documento y fecha de devengo (ADR-0014 D3 y D8)
// ─────────────────────────────────────────────────────────────────────────────

describe("overrideQuota (ADR-0014 D3)", () => {
  it("sin overrides devuelve null: el motor recalcula, como en E3", () => {
    expect(overrideQuota(undefined, "IVA_21")).toBeNull()
    expect(overrideQuota([], "IVA_21")).toBeNull()
  })

  it("devuelve la cuota del documento para SU tipo, y null para los demás", () => {
    const overrides = [
      { taxRateCode: "IVA_21", quotaCents: 21001 },
      { taxRateCode: "IVA_10", quotaCents: 0 },
    ]
    expect(overrideQuota(overrides, "IVA_21")).toBe(21001)
    // Una cuota de cero declarada es una cuota, no una ausencia.
    expect(overrideQuota(overrides, "IVA_10")).toBe(0)
    expect(overrideQuota(overrides, "IVA_4")).toBeNull()
  })

  it("la tolerancia por tipo es constante del motor (un céntimo)", () => {
    expect(TOLERANCIA_CUOTA_IVA_CENTS).toBe(1)
  })
})

describe("taxAccrualDate (art. 90.Dos LIVA, O-14)", () => {
  it("con las tres fechas iguales —el caso de todos los fixtures— nada cambia", () => {
    const d = "2026-03-10"
    expect(taxAccrualDate({ operationDate: d, accrualDate: d, documentDate: d })).toBe(d)
  })

  it("manda la fecha de operación; luego el devengo contable; luego la expedición", () => {
    expect(taxAccrualDate({ documentDate: "2026-06-25" })).toBe("2026-06-25")
    expect(taxAccrualDate({ accrualDate: "2026-07-01", documentDate: "2026-06-25" })).toBe("2026-07-01")
    expect(taxAccrualDate({ operationDate: "2026-08-01", accrualDate: "2026-07-01", documentDate: "2026-06-25" })).toBe(
      "2026-08-01"
    )
  })

  it("un null explícito no cuenta como fecha", () => {
    expect(taxAccrualDate({ operationDate: null, accrualDate: null, documentDate: "2026-06-25" })).toBe("2026-06-25")
  })
})
