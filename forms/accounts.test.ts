import {
  createAccountFormSchema,
  deleteAccountFormSchema,
  importPlanCsvFormSchema,
  renameAccountFormSchema,
  setAccountActiveFormSchema,
  updateAccountClassificationFormSchema,
} from "@/forms/accounts"
import { describe, expect, it } from "vitest"

describe("E2 · T9 — schemas del editor de plan", () => {
  it("acepta un alta mínima y normaliza los selects vacíos a null", () => {
    const parsed = createAccountFormSchema().safeParse({
      code: "7050001",
      name: "  Consultoría – Cliente X  ",
      statement: "",
      epigraph: "",
      analyticType: "",
      cashflowCategory: "",
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.name).toBe("Consultoría – Cliente X")
    expect(parsed.data.statement).toBeNull()
    expect(parsed.data.analyticType).toBeNull()
    expect(parsed.data.cashflowCategory).toBeNull()
  })

  it("rechaza códigos con cero a la izquierda, vacíos o no numéricos (R-01)", () => {
    for (const code of ["0705", "", "70a", "-1", "7050001234567"]) {
      expect(createAccountFormSchema().safeParse({ code, name: "Cuenta" }).success, code).toBe(false)
    }
  })

  it("R-15: con catálogo, sólo admite epígrafes que existan en la variante", () => {
    const catalogo = new Set(["1. Importe neto de la cifra de negocios"])
    const schema = createAccountFormSchema(catalogo)
    expect(schema.safeParse({ code: "7050001", name: "Cliente X", epigraph: "Ventas varias" }).success).toBe(false)
    expect(
      schema.safeParse({ code: "7050001", name: "Cliente X", epigraph: "1. Importe neto de la cifra de negocios" })
        .success
    ).toBe(true)
    // Sin epígrafe se hereda el del padre: no es un error.
    expect(schema.safeParse({ code: "7050001", name: "Cliente X", epigraph: "" }).success).toBe(true)
  })

  it("rechaza un nombre vacío al renombrar (R-19 permite renombrar, no borrar el nombre)", () => {
    expect(renameAccountFormSchema.safeParse({ code: "705", name: " " }).success).toBe(false)
    expect(renameAccountFormSchema.safeParse({ code: "705", name: "Ventas" }).success).toBe(true)
  })

  it("exige motivo al desactivar y no al reactivar", () => {
    expect(setAccountActiveFormSchema.safeParse({ code: "705", isActive: "false" }).success).toBe(false)
    expect(
      setAccountActiveFormSchema.safeParse({ code: "705", isActive: "false", reason: "xx" }).success
    ).toBe(false)
    expect(
      setAccountActiveFormSchema.safeParse({ code: "705", isActive: "false", reason: "ya no se usa" }).success
    ).toBe(true)
    expect(setAccountActiveFormSchema.safeParse({ code: "705", isActive: "true" }).success).toBe(true)
  })

  it("el borrado exige siempre motivo", () => {
    expect(deleteAccountFormSchema.safeParse({ code: "705", reason: "" }).success).toBe(false)
    expect(deleteAccountFormSchema.safeParse({ code: "705", reason: "duplicada" }).success).toBe(true)
  })

  it("la clasificación no admite el estado financiero (R-10a: no es editable)", () => {
    const parsed = updateAccountClassificationFormSchema.safeParse({
      code: "430",
      epigraph: "B.III.1 Clientes por ventas y prestaciones de servicios",
      analyticType: "NO_ANALITICO",
      cashflowCategory: "",
      reason: "reclasificación acordada con el auditor",
      statement: "PYG",
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect("statement" in parsed.data).toBe(false)
    expect(parsed.data.cashflowCategory).toBeNull()
  })

  it("el import exige columnas de código y nombre y un separador conocido", () => {
    const base = { csv: "a,b\n1,2", mappingCode: "a", mappingName: "b", dryRun: "true" }
    expect(importPlanCsvFormSchema.safeParse(base).success).toBe(true)
    expect(importPlanCsvFormSchema.safeParse({ ...base, mappingName: "" }).success).toBe(false)
    expect(importPlanCsvFormSchema.safeParse({ ...base, delimiter: "|" }).success).toBe(false)
    expect(importPlanCsvFormSchema.safeParse({ ...base, csv: "" }).success).toBe(false)
  })
})
