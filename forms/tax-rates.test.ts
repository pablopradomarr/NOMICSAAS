import { setAccountMapEntryFormSchema } from "@/forms/account-map"
import {
  closeTaxRateFormSchema,
  createTaxRateFormSchema,
  taxPolicyFormSchema,
} from "@/forms/tax-rates"
import { describe, expect, it } from "vitest"

const base = {
  code: "iva_21",
  name: "IVA 21 % general",
  kind: "IVA",
  rateBps: "21",
  appliesTo: "BOTH",
  accountCode: "477",
  counterAccountCode: "472",
  validFrom: "2025-01-01",
}

describe("E2 · T9 — schemas de impuestos", () => {
  it("convierte el porcentaje a puntos básicos sin coma flotante (E-1)", () => {
    const casos: [string, number][] = [
      ["21", 2100],
      ["5,2", 520],
      ["1,75", 175],
      ["0", 0],
      ["21%", 2100],
    ]
    for (const [input, expected] of casos) {
      const parsed = createTaxRateFormSchema.safeParse({ ...base, rateBps: input })
      expect(parsed.success, input).toBe(true)
      if (parsed.success) expect(parsed.data.rateBps, input).toBe(expected)
    }
  })

  it("rechaza tipos fuera de rango o con más de dos decimales", () => {
    for (const input of ["101", "-1", "1,755", "abc", ""]) {
      expect(createTaxRateFormSchema.safeParse({ ...base, rateBps: input }).success, input).toBe(false)
    }
  })

  it("normaliza el código a mayúsculas y las fechas de vigencia a UTC", () => {
    const parsed = createTaxRateFormSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.code).toBe("IVA_21")
    expect(parsed.data.validFrom.toISOString()).toBe("2025-01-01T00:00:00.000Z")
    expect(parsed.data.validTo).toBeNull()
  })

  it("rechaza fechas mal formadas y códigos de tipo con espacios", () => {
    expect(createTaxRateFormSchema.safeParse({ ...base, validFrom: "01/01/2025" }).success).toBe(false)
    expect(createTaxRateFormSchema.safeParse({ ...base, code: "IVA 21" }).success).toBe(false)
  })

  it("el cierre de vigencia exige identificador, fecha y motivo", () => {
    const id = "11111111-1111-4111-8111-111111111111"
    expect(closeTaxRateFormSchema.safeParse({ id, validTo: "2026-05-31", reason: "subida" }).success).toBe(true)
    expect(closeTaxRateFormSchema.safeParse({ id, validTo: "2026-05-31", reason: "" }).success).toBe(false)
    expect(closeTaxRateFormSchema.safeParse({ id: "x", validTo: "2026-05-31", reason: "subida" }).success).toBe(false)
  })

  it("la política fiscal admite prorrata vacía y valida los rangos", () => {
    const ok = taxPolicyFormSchema.safeParse({
      prorrataBps: "",
      taxRoundingMode: "PER_TIPO",
      redondeoToleranciaCents: "1",
      reason: "política acordada en el cierre",
    })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.prorrataBps).toBeNull()

    expect(
      taxPolicyFormSchema.safeParse({
        prorrataBps: "10001",
        taxRoundingMode: "PER_TIPO",
        redondeoToleranciaCents: "1",
        reason: "fuera de rango",
      }).success
    ).toBe(false)
    expect(
      taxPolicyFormSchema.safeParse({
        prorrataBps: "500",
        taxRoundingMode: "PER_TIPO",
        redondeoToleranciaCents: "0,5",
        reason: "céntimos no enteros",
      }).success
    ).toBe(false)
  })

  it("el remapeo de una clave de sistema exige motivo (§7)", () => {
    expect(
      setAccountMapEntryFormSchema.safeParse({ key: "BANCO_DEFAULT", accountCode: "5720", reason: "" }).success
    ).toBe(false)
    expect(
      setAccountMapEntryFormSchema.safeParse({
        key: "BANCO_DEFAULT",
        accountCode: "5720",
        reason: "cuenta bancaria nueva",
      }).success
    ).toBe(true)
    expect(
      setAccountMapEntryFormSchema.safeParse({ key: "NO_EXISTE", accountCode: "5720", reason: "motivo" }).success
    ).toBe(false)
  })
})
