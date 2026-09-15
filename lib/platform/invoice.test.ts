/**
 * E11 · ola A · T18 — facturación de la plataforma: régimen, devengo y cuota.
 *
 * Cubre los criterios 5, 6 y 7 de §14 y las respuestas C-1, C-2 y C-4 de la
 * validación contable.
 */

import { describe, expect, it } from "vitest"

import {
  accrualDateOf,
  assertB2BSellable,
  esTerritorioEspecialEs,
  formatPlatformInvoiceNumber,
  issueDeadlineOf,
  ivaPeriodOf,
  IVA_GENERAL_BPS,
  PlatformInvoiceError,
  resolveTaxTreatment,
  seriesCodeFor,
  taxCentsInEur,
} from "./invoice"

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe("resolveTaxTreatment — C-1 / O-15", () => {
  it("empresario en el TAI: sujeto y no exento al 21 %", () => {
    const d = resolveTaxTreatment({ country: "ES", vatNumber: "ESB12345678", viesValid: true })
    expect(d.treatment).toBe("REPERCUTIDO_ES")
    expect(d.rateBps).toBe(IVA_GENERAL_BPS)
    expect(d.mention).toBeNull()
  })

  it("Canarias, Ceuta y Melilla: NO SUJETO, aunque el país sea ES", () => {
    for (const cp of ["35001", "38003", "51001", "52005"]) {
      const d = resolveTaxTreatment({ country: "ES", vatNumber: "ESB12345678", viesValid: true }, { postalCode: cp })
      expect(d.treatment, cp).toBe("NO_SUJETO_CANARIAS_CEUTA_MELILLA")
      expect(d.rateBps, cp).toBe(0)
      expect(d.mention, cp).toBeTruthy()
    }
    expect(esTerritorioEspecialEs("28001")).toBe(false)
    expect(esTerritorioEspecialEs(null)).toBe(false)
  })

  // Criterio 6
  it("empresario UE con NIF-IVA válido en VIES: no sujeto, 0 %, con la mención impresa", () => {
    const d = resolveTaxTreatment({ country: "FR", vatNumber: "FR12345678901", viesValid: true })
    expect(d.treatment).toBe("NO_SUJETO_LOCALIZACION_UE")
    expect(d.rateBps).toBe(0)
    expect(d.mention).toMatch(/inversión del sujeto pasivo/i)
    expect(d.mention).toMatch(/69\.Uno\.1º/)
  })

  it("no se llama «ISP» al tratamiento: es una NO SUJECIÓN por localización (O-15)", () => {
    const d = resolveTaxTreatment({ country: "DE", vatNumber: "DE123456789", viesValid: true })
    expect(d.treatment).toBe("NO_SUJETO_LOCALIZACION_UE")
    expect(d.treatment).not.toMatch(/ISP/)
  })

  // Criterio 6, segunda mitad — R-5
  it("VIES caído: se repercute el 21 %. NUNCA se presume válido", () => {
    const d = resolveTaxTreatment({ country: "IT", vatNumber: "IT12345678901", viesValid: null })
    expect(d.treatment).toBe("REPERCUTIDO_ES")
    expect(d.rateBps).toBe(IVA_GENERAL_BPS)
    expect(d.reason).toMatch(/VIES no disponible/i)
  })

  it("NIF-IVA inválido: se repercute el 21 %, y el motivo lo distingue del VIES caído", () => {
    const d = resolveTaxTreatment({ country: "IT", vatNumber: "IT00000000000", viesValid: false })
    expect(d.treatment).toBe("REPERCUTIDO_ES")
    expect(d.reason).toMatch(/no válido/i)
  })

  it("UE sin NIF-IVA: tampoco cabe la no sujeción", () => {
    expect(resolveTaxTreatment({ country: "PT", vatNumber: null, viesValid: null }).treatment).toBe("REPERCUTIDO_ES")
  })

  it("tercer país: no sujeto, con mención", () => {
    for (const pais of ["US", "MX", "GB", "CH"]) {
      const d = resolveTaxTreatment({ country: pais, vatNumber: null, viesValid: null })
      expect(d.treatment, pais).toBe("NO_SUJETO_TERCER_PAIS")
      expect(d.rateBps, pais).toBe(0)
    }
  })

  it("Reino Unido es tercer país desde el Brexit, y XI no cubre servicios", () => {
    expect(resolveTaxTreatment({ country: "GB", vatNumber: "GB123", viesValid: true }).treatment).toBe(
      "NO_SUJETO_TERCER_PAIS"
    )
    expect(resolveTaxTreatment({ country: "XI", vatNumber: "XI123", viesValid: true }).treatment).toBe(
      "NO_SUJETO_TERCER_PAIS"
    )
  })

  it("sin país no se localiza la operación: lanza en vez de inventar una sujeción", () => {
    expect(() => resolveTaxTreatment({ country: "", vatNumber: null, viesValid: null })).toThrow(PlatformInvoiceError)
  })
})

describe("assertB2BSellable — P-1", () => {
  it("España sin NIF-IVA pasa: la condición de empresario se acredita aquí de otra forma", () => {
    expect(() => assertB2BSellable({ country: "ES", vatNumber: null, viesValid: null })).not.toThrow()
  })

  it("fuera de España sin NIF-IVA, no se vende (evita el alta en OSS)", () => {
    expect(() => assertB2BSellable({ country: "FR", vatNumber: null, viesValid: null })).toThrow(/NIF-IVA/)
    expect(() => assertB2BSellable({ country: "US", vatNumber: null, viesValid: null })).toThrow(/NIF-IVA/)
  })

  it("sin país tampoco", () => {
    expect(() => assertB2BSellable({ country: "", vatNumber: "X", viesValid: null })).toThrow(/país/)
  })
})

describe("ivaPeriodOf y el devengo — C-2, ADR-0014 D8", () => {
  it("clave canónica AAAA-Qn", () => {
    expect(ivaPeriodOf(D("2026-01-01"))).toBe("2026-Q1")
    expect(ivaPeriodOf(D("2026-03-31"))).toBe("2026-Q1")
    expect(ivaPeriodOf(D("2026-04-01"))).toBe("2026-Q2")
    expect(ivaPeriodOf(D("2026-12-31"))).toBe("2026-Q4")
  })

  it("el cobro POSTERIOR no mueve el devengo: exigible el 1, cobrado el 3 ⇒ devengo el 1", () => {
    expect(accrualDateOf(D("2026-10-01"), D("2026-10-03"))).toEqual(D("2026-10-01"))
  })

  it("el cobro ANTICIPADO sí lo adelanta (art. 75.Dos LIVA)", () => {
    expect(accrualDateOf(D("2026-10-01"), D("2026-09-28"))).toEqual(D("2026-09-28"))
  })

  it("sin cobro, devenga por exigibilidad (art. 75.Uno.7º)", () => {
    expect(accrualDateOf(D("2026-10-01"), null)).toEqual(D("2026-10-01"))
  })

  it("un devengo del 30/09 declara en Q3 aunque la factura se expida el 16/10", () => {
    const devengo = accrualDateOf(D("2026-09-30"), D("2026-10-03"))
    expect(ivaPeriodOf(devengo)).toBe("2026-Q3")
    expect(issueDeadlineOf(devengo)).toEqual(D("2026-10-16"))
  })

  it("el plazo de expedición es el día 16 del mes siguiente, y cruza el año", () => {
    expect(issueDeadlineOf(D("2026-12-05"))).toEqual(D("2027-01-16"))
  })
})

describe("taxCentsInEur — C-4", () => {
  it("en EUR la cuota ya está en euros y no hay conversión que sellar", () => {
    expect(taxCentsInEur(1029, "EUR", null)).toEqual({ taxCentsEur: 1029, fx: null })
  })

  it("en USD convierte a la tasa del devengo y sella la fecha REAL de la tasa", () => {
    const quote = { rateMicro: 920_000n, date: D("2026-10-01"), source: "ECB" }
    const r = taxCentsInEur(1000, "USD", quote)
    expect(r.taxCentsEur).toBe(920)
    expect(r.fx).toBe(quote)
  })

  it("redondea medio arriba, al céntimo", () => {
    // 1 c × 1,500000 = 1,5 c → 2 c
    expect(taxCentsInEur(1, "USD", { rateMicro: 1_500_000n, date: D("2026-10-01"), source: "ECB" }).taxCentsEur).toBe(2)
    // 1 c × 1,499999 → 1 c
    expect(taxCentsInEur(1, "USD", { rateMicro: 1_499_999n, date: D("2026-10-01"), source: "ECB" }).taxCentsEur).toBe(1)
  })

  it("cuota cero convierte a cero", () => {
    expect(taxCentsInEur(0, "USD", { rateMicro: 920_000n, date: D("2026-10-01"), source: "ECB" }).taxCentsEur).toBe(0)
  })

  it("sin tasa NO se emite a ciegas: lanza nombrando el requisito legal", () => {
    expect(() => taxCentsInEur(1000, "USD", null)).toThrow(/79\.Once/)
  })
})

describe("numeración — O-9, O-10", () => {
  it("cuatro dígitos, con el año ya en el prefijo", () => {
    expect(formatPlatformInvoiceNumber("PLT-2026-", 1)).toBe("PLT-2026-0001")
    expect(formatPlatformInvoiceNumber("PLT-2026-", 1234)).toBe("PLT-2026-1234")
    expect(formatPlatformInvoiceNumber("PLT-R-2026-", 7)).toBe("PLT-R-2026-0007")
  })

  it("una rectificativa va a su serie específica (art. 15.4 RD 1619/2012)", () => {
    expect(seriesCodeFor("ORDINARIA")).toBe("PLT")
    expect(seriesCodeFor("RECTIFICATIVA")).toBe("PLT-R")
  })
})
