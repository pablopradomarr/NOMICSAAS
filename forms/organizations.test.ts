import { createOrganizationFormSchema, switchOrganizationSchema, updateOrganizationFormSchema } from "@/forms/organizations"
import { describe, expect, it } from "vitest"

describe("forms/organizations", () => {
  it("aplica los valores por defecto del alta (EUR, Europe/Madrid, PYMES)", () => {
    const parsed = createOrganizationFormSchema.parse({ name: "Estudio Norte SL" })
    expect(parsed).toMatchObject({
      name: "Estudio Norte SL",
      baseCurrency: "EUR",
      timezone: "Europe/Madrid",
      pgcVariant: "PYMES",
      taxId: null,
    })
  })

  it("normaliza moneda y NIF a mayúsculas", () => {
    const parsed = createOrganizationFormSchema.parse({ name: "Acme", baseCurrency: "usd", taxId: " b12345678 " })
    expect(parsed.baseCurrency).toBe("USD")
    expect(parsed.taxId).toBe("B12345678")
  })

  it("rechaza monedas que no son ISO-4217 de tres letras", () => {
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", baseCurrency: "EUROS" }).success).toBe(false)
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", baseCurrency: "E1" }).success).toBe(false)
  })

  it("rechaza zonas horarias que no son identificadores IANA", () => {
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", timezone: "Madrid" }).success).toBe(false)
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", timezone: "GMT+1" }).success).toBe(false)
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", timezone: "America/Argentina/Salta" }).success).toBe(
      true
    )
  })

  it("rechaza nombres demasiado cortos y variantes de PGC desconocidas", () => {
    expect(createOrganizationFormSchema.safeParse({ name: "A" }).success).toBe(false)
    expect(createOrganizationFormSchema.safeParse({ name: "Acme", pgcVariant: "ABREVIADO" }).success).toBe(false)
  })

  it("la edición exige todos los campos (no hay defaults silenciosos)", () => {
    expect(updateOrganizationFormSchema.safeParse({ name: "Acme" }).success).toBe(false)
    expect(
      updateOrganizationFormSchema.safeParse({
        name: "Acme",
        baseCurrency: "EUR",
        timezone: "Europe/Madrid",
        pgcVariant: "GENERAL",
      }).success
    ).toBe(true)
  })

  it("el switcher exige un uuid", () => {
    expect(switchOrganizationSchema.safeParse({ organizationId: "no-es-uuid" }).success).toBe(false)
    expect(
      switchOrganizationSchema.safeParse({ organizationId: "cccccccc-cccc-4ccc-8ccc-cccccccccc10" }).success
    ).toBe(true)
  })
})
