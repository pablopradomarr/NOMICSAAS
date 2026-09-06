/**
 * E8 · T23 — validación de entrada de la calificación fiscal.
 *
 * Aquí se comprueba lo que el schema y la normalización **sí** deciden. Lo que
 * NO deciden, y por eso no se prueba aquí, es el fondo fiscal: el dígito de
 * control del NIF por ramas (RC-11), VIES y la coherencia entre régimen y tipo
 * de retención (RC-19) viven en `lib/extraction/reconcile.ts` (T7), porque
 * tienen que dar el mismo veredicto desde el formulario y desde el lote.
 */

import { describe, expect, it } from "vitest"

import {
  categoryFiscalFormSchema,
  createCounterpartyFormSchema,
  organizationFiscalFormSchema,
} from "@/forms/counterparties"
import { normalizeCode, normalizeTaxId } from "@/models/counterparties"

const base = { code: "prov-001", name: "  Consultoría Ávila, S.L.  " }

describe("createCounterpartyFormSchema", () => {
  it("caso mínimo: código y nombre bastan; el régimen nace en NINGUNO", () => {
    const parsed = createCounterpartyFormSchema.parse(base)
    expect(parsed.name).toBe("Consultoría Ávila, S.L.")
    expect(parsed.withholdingRegime).toBe("NINGUNO")
    expect(parsed.surchargeRegime).toBe(false)
    expect(parsed.isEmployee).toBe(false)
  })

  it("los vacíos del formulario son `null`, no cadenas vacías", () => {
    // Una cadena vacía en `taxId` haría que RC-11 creyera que hay NIF y que es
    // inválido, en vez de que no lo hay.
    const parsed = createCounterpartyFormSchema.parse({ ...base, taxId: "", countryCode: "", vatNumber: "" })
    expect(parsed.taxId).toBeNull()
    expect(parsed.countryCode).toBeNull()
    expect(parsed.vatNumber).toBeNull()
  })

  it("el país se normaliza a mayúsculas y exige DOS letras", () => {
    expect(createCounterpartyFormSchema.parse({ ...base, countryCode: "de" }).countryCode).toBe("DE")
    expect(createCounterpartyFormSchema.safeParse({ ...base, countryCode: "ESP" }).success).toBe(false)
  })

  it("una casilla marcada llega como `on`; ausente es `false`", () => {
    const marcado = createCounterpartyFormSchema.parse({ ...base, surchargeRegime: "on", isEmployee: "on" })
    expect(marcado.surchargeRegime).toBe(true)
    expect(marcado.isEmployee).toBe(true)
  })

  it("el código admite el juego que identifica y rechaza el resto", () => {
    expect(createCounterpartyFormSchema.safeParse({ ...base, code: "PROV.001-A_2" }).success).toBe(true)
    expect(createCounterpartyFormSchema.safeParse({ ...base, code: "" }).success).toBe(false)
    expect(createCounterpartyFormSchema.safeParse({ ...base, code: "prov 001" }).success).toBe(false)
    expect(createCounterpartyFormSchema.safeParse({ ...base, code: "x".repeat(25) }).success).toBe(false)
  })

  it("los seis regímenes de retención son los del enum, y nada más", () => {
    for (const regimen of ["NINGUNO", "PROFESIONAL", "PROFESIONAL_INICIO", "ARRENDADOR", "AGRICOLA", "MODULOS"]) {
      expect(createCounterpartyFormSchema.safeParse({ ...base, withholdingRegime: regimen }).success, regimen).toBe(
        true
      )
    }
    expect(createCounterpartyFormSchema.safeParse({ ...base, withholdingRegime: "INVENTADO" }).success).toBe(false)
  })
})

describe("normalización del maestro", () => {
  it("el código identifica: mayúsculas y sin espacios", () => {
    expect(normalizeCode("  prov 001 ")).toBe("PROV-001")
  })

  it("«B-12 345 674» y «B12345674» son el MISMO NIF", () => {
    // Sin esto, el mismo proveedor entraría dos veces y la detección de
    // duplicados por `(taxId, nº documento, ejercicio)` (I-E8-13) no vería el
    // segundo pago.
    expect(normalizeTaxId("B-12 345 674")).toBe("B12345674")
    expect(normalizeTaxId("b12345674")).toBe("B12345674")
  })

  it("un NIF vacío o en blanco es `null`, no una cadena", () => {
    expect(normalizeTaxId("")).toBeNull()
    expect(normalizeTaxId("   ")).toBeNull()
    expect(normalizeTaxId(null)).toBeNull()
    expect(normalizeTaxId(undefined)).toBeNull()
  })
})

describe("organizationFiscalFormSchema", () => {
  it("por defecto, régimen general y sin ROI", () => {
    const parsed = organizationFiscalFormSchema.parse({})
    expect(parsed.ivaRegime).toBe("GENERAL")
    expect(parsed.roiRegistered).toBe(false)
  })

  it("acepta los cuatro regímenes declarados y rechaza cualquier otro", () => {
    for (const r of ["GENERAL", "RECC", "REDEME", "OTRO"]) {
      expect(organizationFiscalFormSchema.safeParse({ ivaRegime: r }).success, r).toBe(true)
    }
    expect(organizationFiscalFormSchema.safeParse({ ivaRegime: "SIMPLIFICADO" }).success).toBe(false)
  })
})

describe("categoryFiscalFormSchema", () => {
  it("una categoría NO puede apuntar al subgrupo 64 (O-13)", () => {
    // Las nóminas se contabilizan con T-10, jamás por una plantilla de compra:
    // una categoría que apunte a 640 metería el sueldo por el circuito de
    // proveedores, con su 472 y su 400.
    const result = categoryFiscalFormSchema.safeParse({ code: "salary", defaultAccountCode: "640" })
    expect(result.success).toBe(false)
    expect(result.success ? "" : result.error.issues[0].message).toMatch(/subgrupo 64/)
  })

  it("una cuenta de servicios exteriores sí vale", () => {
    expect(categoryFiscalFormSchema.parse({ code: "online", defaultAccountCode: "629" }).defaultAccountCode).toBe("629")
  })

  it("sin cuenta por defecto: `null`, y deducibilidad FULL", () => {
    const parsed = categoryFiscalFormSchema.parse({ code: "other", defaultAccountCode: "" })
    expect(parsed.defaultAccountCode).toBeNull()
    expect(parsed.defaultDeductibility).toBe("FULL")
  })

  it("`REQUIERE_DECISION` es un valor de primera clase, no un truco", () => {
    expect(
      categoryFiscalFormSchema.parse({ code: "food", defaultDeductibility: "REQUIERE_DECISION" }).defaultDeductibility
    ).toBe("REQUIERE_DECISION")
  })
})
