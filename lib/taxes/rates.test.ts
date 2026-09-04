import { describe, expect, it } from "vitest"
import { buildPlan } from "@/lib/accounts/codes"
import type { PlanAccount } from "@/lib/accounts/types"
import { applyBps, formatBps, parseBps } from "@/lib/taxes/bps"
import {
  closeTaxRateValidity,
  isInForce,
  overlaps,
  seedTaxRates,
  SEED_TAX_CODES,
  selectTaxRate,
  selectTaxRatesInForce,
  taxAccountFor,
  taxAppliesToSide,
  validateTaxRate,
  VIGENCIA_IVA_2025,
} from "@/lib/taxes/rates"
import type { TaxRateInput, TaxRateRow } from "@/lib/taxes/types"

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

function account(code: string, extra: Partial<PlanAccount> = {}): PlanAccount {
  return {
    code,
    name: `Cuenta ${code}`,
    level: code.length,
    parentCode: null,
    nature: "ACREEDORA",
    statement: "BALANCE_PASIVO",
    epigraph: null,
    epigraphPymes: null,
    bidirectional: false,
    isContra: false,
    analyticType: null,
    cashflowCategory: null,
    isPostable: true,
    isActive: true,
    isSystem: true,
    origin: "SEED",
    ...extra,
  }
}

const plan = buildPlan([
  account("472"),
  account("477"),
  account("473"),
  account("4751"),
  account("430", { isPostable: false }),
  account("640", { isActive: false }),
])

function rate(over: Partial<TaxRateRow> = {}): TaxRateRow {
  return {
    id: "r1",
    code: "IVA_21",
    name: "IVA 21 %",
    kind: "IVA",
    rateBps: 2100,
    appliesTo: "BOTH",
    accountCode: "477",
    counterAccountCode: "472",
    linkedTaxRateId: null,
    validFrom: d("2025-01-01"),
    validTo: null,
    isActive: true,
    isSystem: true,
    ...over,
  }
}

describe("applyBps — cuota en céntimos (R-IVA-2, E-1)", () => {
  it("base 0 y tipo 0 dan cuota 0", () => {
    expect(applyBps(0, 2100)).toBe(0)
    expect(applyBps(10_000, 0)).toBe(0)
  })

  it("21 % de 100,00 € son 21,00 €", () => {
    expect(applyBps(10_000, 2100)).toBe(2100)
  })

  it("1,75 % — el caso que `ratePermille` no representaba", () => {
    expect(applyBps(10_000, 175)).toBe(175)
    expect(applyBps(57_37, 175)).toBe(100) // 100,3975 céntimos → 100
  })

  it("redondeo HALF-UP en el empate exacto, simétrico en negativos (rectificativa)", () => {
    // 0,5 céntimos exactos: 10 céntimos × 50 bps = 0,05 → 0; 10 × 500 = 0,5 → 1
    expect(applyBps(10, 500)).toBe(1)
    expect(applyBps(-10, 500)).toBe(-1)
    expect(applyBps(-10_000, 2100)).toBe(-2100)
  })

  it("rechaza bases no enteras y tipos fuera de rango", () => {
    expect(() => applyBps(10.5, 2100)).toThrow(TypeError)
    expect(() => applyBps(100, 10_001)).toThrow(TypeError)
    expect(() => applyBps(100, -1)).toThrow(TypeError)
    expect(() => applyBps(100, 21.5)).toThrow(TypeError)
  })
})

describe("parseBps / formatBps (sin Float en ningún paso)", () => {
  it("«21», «21 %», «5,2», «1,75» → 2100, 2100, 520, 175", () => {
    expect(parseBps("21")).toBe(2100)
    expect(parseBps("21 %")).toBe(2100)
    expect(parseBps("5,2")).toBe(520)
    expect(parseBps("1,75")).toBe(175)
    expect(parseBps("0")).toBe(0)
    expect(parseBps("100")).toBe(10000)
  })

  it("devuelve null ante basura o fuera de rango", () => {
    for (const bad of ["", "abc", "21,555", "101", "-5", null, undefined]) {
      expect(parseBps(bad), String(bad)).toBeNull()
    }
  })

  it("no acepta `number`: la conversión ×100 sobre flotante es de quien llama (hallazgo 11)", () => {
    expect(parseBps(21 as unknown as string)).toBeNull()
    // La vía correcta, sin pérdida: texto.
    expect(parseBps(String(21.7))).toBe(2170)
  })

  it("formatBps es la inversa para la UI", () => {
    expect(formatBps(2100)).toBe("21")
    expect(formatBps(520)).toBe("5,2")
    expect(formatBps(175)).toBe("1,75")
    expect(formatBps(0)).toBe("0")
  })
})

describe("selectTaxRate — vigencia (C-7, criterio 8)", () => {
  const cerrado = rate({ id: "viejo", validFrom: d("2025-01-01"), validTo: d("2026-05-31") })
  const nuevo = rate({ id: "nuevo", validFrom: d("2026-06-01"), validTo: null })

  it("lista vacía → null", () => {
    expect(selectTaxRate([], "IVA_21", d("2026-01-01"))).toBeNull()
  })

  it("un asiento de 2024 NO coge el tipo de 2025", () => {
    expect(selectTaxRate([cerrado, nuevo], "IVA_21", d("2024-03-01"))).toBeNull()
  })

  it("fechas límite: el primer y el último día de vigencia SÍ están dentro", () => {
    expect(selectTaxRate([cerrado], "IVA_21", d("2025-01-01"))?.id).toBe("viejo")
    expect(selectTaxRate([cerrado], "IVA_21", d("2026-05-31"))?.id).toBe("viejo")
    expect(selectTaxRate([cerrado], "IVA_21", d("2026-06-01"))).toBeNull()
  })

  it("con los dos, cada fecha coge el suyo", () => {
    expect(selectTaxRate([cerrado, nuevo], "IVA_21", d("2026-03-01"))?.id).toBe("viejo")
    expect(selectTaxRate([cerrado, nuevo], "IVA_21", d("2026-07-01"))?.id).toBe("nuevo")
  })

  it("un tipo desactivado no se selecciona", () => {
    expect(selectTaxRate([rate({ isActive: false })], "IVA_21", d("2026-01-01"))).toBeNull()
  })

  it("selectTaxRatesInForce filtra por kind", () => {
    const irpf = rate({ id: "irpf", code: "IRPF_PROF_15", kind: "IRPF", rateBps: 1500 })
    const vigentes = selectTaxRatesInForce([cerrado, irpf], d("2026-01-01"), "IRPF")
    expect(vigentes.map((r) => r.code)).toEqual(["IRPF_PROF_15"])
  })

  it("isInForce / overlaps: contiguos sin solape", () => {
    expect(isInForce(cerrado, d("2026-05-31"))).toBe(true)
    expect(overlaps(cerrado, nuevo)).toBe(false)
    expect(overlaps(cerrado, rate({ validFrom: d("2026-05-31") }))).toBe(true)
  })
})

describe("taxAccountFor (C-2: una fila, dos cuentas)", () => {
  it("SALE → accountCode, PURCHASE → counterAccountCode", () => {
    expect(taxAccountFor(rate(), "SALE")).toBe("477")
    expect(taxAccountFor(rate(), "PURCHASE")).toBe("472")
  })

  it("sin contrapartida, la compra cae en la cuenta de venta", () => {
    expect(taxAccountFor(rate({ counterAccountCode: null }), "PURCHASE")).toBe("477")
  })

  it("appliesTo restringe la dirección admisible", () => {
    const soloVenta = rate({ appliesTo: "SALE" })
    expect(taxAppliesToSide(soloVenta, "SALE")).toBe(true)
    expect(taxAppliesToSide(soloVenta, "PURCHASE")).toBe(false)
    expect(taxAppliesToSide(rate(), "PURCHASE")).toBe(true)
  })
})

describe("validateTaxRate", () => {
  const base: TaxRateInput = {
    code: "IVA_21",
    name: "IVA 21 %",
    kind: "IVA",
    rateBps: 2100,
    appliesTo: "BOTH",
    accountCode: "477",
    counterAccountCode: "472",
    linkedTaxRateId: null,
    validFrom: d("2026-01-01"),
    validTo: null,
  }

  it("el caso correcto pasa con la lista de existentes vacía", () => {
    expect(validateTaxRate(base, [], plan, d("2026-01-01")).ok).toBe(true)
  })

  it("rateBps fuera de rango y EXENTO con cuota", () => {
    const alto = validateTaxRate({ ...base, rateBps: 10001 }, [], plan, d("2026-01-01"))
    expect(alto.ok).toBe(false)
    if (!alto.ok) expect(alto.errors[0].code).toBe("RATE_RANGE")

    const exento = validateTaxRate({ ...base, kind: "EXENTO", rateBps: 2100 }, [], plan, d("2026-01-01"))
    expect(exento.ok).toBe(false)
    if (!exento.ok) expect(exento.errors.map((e) => e.code)).toContain("RATE_RANGE")
  })

  it("validTo anterior a validFrom", () => {
    const result = validateTaxRate({ ...base, validTo: d("2025-12-31") }, [], plan, d("2026-01-01"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("VALIDITY_RANGE")
  })

  it("I-E2-3: solape con un tipo del mismo código; contiguos, no", () => {
    const abierto = rate({ id: "viejo", validFrom: d("2025-01-01"), validTo: null })
    const solapa = validateTaxRate({ ...base, validFrom: d("2026-06-01") }, [abierto], plan, d("2026-06-01"))
    expect(solapa.ok).toBe(false)
    if (!solapa.ok) expect(solapa.errors[0].code).toBe("RATE_OVERLAP")

    const cerrado = rate({ id: "viejo", validFrom: d("2025-01-01"), validTo: d("2026-05-31") })
    expect(validateTaxRate({ ...base, validFrom: d("2026-06-01") }, [cerrado], plan, d("2026-06-01")).ok).toBe(true)

    // Editar el propio tipo no cuenta como solape consigo mismo.
    expect(validateTaxRate({ ...base, id: "viejo", validFrom: d("2025-01-01") }, [abierto], plan, d("2026-01-01")).ok).toBe(true)
  })

  it("cuentas inexistentes, inactivas o no postables", () => {
    const inexistente = validateTaxRate({ ...base, accountCode: "999" }, [], plan, d("2026-01-01"))
    expect(inexistente.ok).toBe(false)
    if (!inexistente.ok) expect(inexistente.errors[0].code).toBe("ACCOUNT_NOT_FOUND")

    const noPostable = validateTaxRate({ ...base, accountCode: "430" }, [], plan, d("2026-01-01"))
    expect(noPostable.ok).toBe(false)
    if (!noPostable.ok) expect(noPostable.errors[0].code).toBe("ACCOUNT_NOT_POSTABLE")

    const inactiva = validateTaxRate({ ...base, counterAccountCode: "640" }, [], plan, d("2026-01-01"))
    expect(inactiva.ok).toBe(false)
    if (!inactiva.ok) expect(inactiva.errors[0].code).toBe("ACCOUNT_INACTIVE")
  })

  it("criterio 9: un RECARGO sin enlace falla; con un IVA vigente, pasa", () => {
    const recargo: TaxRateInput = {
      ...base,
      code: "REQ_1_75",
      name: "Recargo 1,75 %",
      kind: "RECARGO",
      rateBps: 175,
      appliesTo: "SALE",
      counterAccountCode: null,
    }
    const sinEnlace = validateTaxRate(recargo, [], plan, d("2026-01-01"))
    expect(sinEnlace.ok).toBe(false)
    if (!sinEnlace.ok) expect(sinEnlace.errors[0].code).toBe("RATE_LINK")

    const iva = rate({ id: "iva21", validFrom: d("2025-01-01") })
    expect(validateTaxRate({ ...recargo, linkedTaxRateId: "iva21" }, [iva], plan, d("2026-01-01")).ok).toBe(true)

    // Enlazado a un IVA cuya vigencia no cubre la del recargo.
    const ivaViejo = rate({ id: "viejo", validFrom: d("2020-01-01"), validTo: d("2021-12-31") })
    const fuera = validateTaxRate({ ...recargo, linkedTaxRateId: "viejo" }, [ivaViejo], plan, d("2026-01-01"))
    expect(fuera.ok).toBe(false)

    // Un tipo que no es recargo no puede llevar enlace.
    const ivaConEnlace = validateTaxRate({ ...base, linkedTaxRateId: "iva21" }, [iva], plan, d("2026-01-01"))
    expect(ivaConEnlace.ok).toBe(false)
  })

  it("closeTaxRateValidity no admite cerrar antes de empezar", () => {
    expect(closeTaxRateValidity(rate(), d("2024-12-31")).ok).toBe(false)
    expect(closeTaxRateValidity(rate(), d("2026-05-31")).ok).toBe(true)
  })
})

describe("seedTaxRates — catálogo inicial (§3.1)", () => {
  const resolve = (key: string): string | null =>
    ({
      IVA_REPERCUTIDO: "477",
      IVA_SOPORTADO: "472",
      IVA_REPERCUTIDO_ISP: "477",
      IVA_SOPORTADO_ISP: "472",
      IRPF_PROFESIONALES_A_PAGAR: "47510",
      IRPF_ALQUILERES_A_PAGAR: "47511",
      IRPF_TRABAJO_A_PAGAR: "47512",
      IRPF_A_PAGAR: "4751",
      IRPF_RETENIDO_CLIENTES: "473",
    })[key] ?? null

  const seeds = seedTaxRates(resolve as never, { orgValidFrom: d("2026-09-04") })

  it("siembra todo el catálogo y ningún tipo derogado (C-7)", () => {
    expect(seeds).toHaveLength(SEED_TAX_CODES.length)
    expect(seeds.map((s) => s.code)).not.toContain("IVA_18")
    expect(seeds.every((s) => s.validTo === null)).toBe(true)
  })

  it("los tipos de IVA arrancan el 2025-01-01 y los de IRPF en el alta de la organización", () => {
    const iva21 = seeds.find((s) => s.code === "IVA_21")
    expect(iva21?.validFrom).toEqual(VIGENCIA_IVA_2025)
    expect(seeds.find((s) => s.code === "IRPF_PROF_15")?.validFrom).toEqual(d("2026-09-04"))
  })

  it("REQ_1_75 son 175 bps y enlaza con IVA_21 (criterio 9)", () => {
    const recargo = seeds.find((s) => s.code === "REQ_1_75")
    expect(recargo?.rateBps).toBe(175)
    expect(recargo?.linkedCode).toBe("IVA_21")
    expect(recargo?.appliesTo).toBe("SALE")
    expect(recargo?.counterAccountCode).toBeNull()
  })

  it("IVA_ISP lleva LAS DOS cuentas y sólo aplica en compra (doble apunte)", () => {
    const isp = seeds.find((s) => s.code === "IVA_ISP")
    expect(isp?.appliesTo).toBe("PURCHASE")
    expect(isp?.accountCode).toBe("477")
    expect(isp?.counterAccountCode).toBe("472")
  })

  it("las retenciones separan la cuenta por modelo (C-3)", () => {
    const byCode = new Map(seeds.map((s) => [s.code, s]))
    expect(byCode.get("IRPF_PROF_15")?.accountCode).toBe("47510")
    expect(byCode.get("IRPF_ALQ_19")?.accountCode).toBe("47511")
    expect(byCode.get("IRPF_ADMIN_35")?.accountCode).toBe("47512")
    expect(byCode.get("IRPF_PROF_15")?.counterAccountCode).toBe("473")
  })

  it("si una clave no resuelve, su tipo NO se siembra (en vez de apuntar a nada)", () => {
    expect(seedTaxRates(() => null, { orgValidFrom: d("2026-09-04") })).toEqual([])
  })

  it("todo el catálogo pasa `validateTaxRate` sobre un plan que tiene sus cuentas", () => {
    const planSeed = buildPlan([account("472"), account("477"), account("473"), account("4751"), account("47510"), account("47511"), account("47512")])
    const existing: TaxRateRow[] = []
    for (const seed of seeds) {
      const input: TaxRateInput = {
        ...seed,
        linkedTaxRateId: seed.linkedCode ? (existing.find((e) => e.code === seed.linkedCode)?.id ?? null) : null,
      }
      const result = validateTaxRate(input, existing, planSeed, seed.validFrom)
      expect(result.ok, `${seed.code}: ${result.ok ? "" : JSON.stringify(result.errors)}`).toBe(true)
      if (result.ok) existing.push({ ...result.value, id: seed.code })
    }
  })
})
