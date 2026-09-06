/**
 * E8 · T6 — Los dos tests que hacen que un prompt sea evidencia y no un ajuste.
 *
 *  1. **Si el prompt cambia sin bump, la suite falla.** El `.md` es la fuente y
 *     el catálogo declara su sello: tocar el texto sin subir la versión rompe
 *     aquí, no en producción seis meses después, cuando alguien intente
 *     comparar dos `ExtractionRun` que dicen usar «extraction v1» y no vieron
 *     el mismo texto.
 *  2. **El esquema no contiene `accountCode`** —ni ninguno de los otros campos
 *     vetados—. Es ADR-0014 D4 y D11 en forma ejecutable: la calificación
 *     fiscal la decide la organización, y la forma de garantizarlo no es un
 *     comentario, es que el modelo no tenga dónde escribirla.
 */

import { describe, expect, it } from "vitest"

import {
  EXTRACTION_SCHEMA_V1,
  EXTRACTION_SCHEMA_VERSION,
  FORBIDDEN_MODEL_FIELDS,
  extractionOutputSchema,
  extractionSchemaSha,
  parseExtractionOutput,
} from "@/ai/schema"
import { PROMPT_CATALOG, actualPromptSha, latestPromptEntry, promptEntry, readPromptFile } from "@/ai/prompts"
import { renderPrompt } from "@/ai/prompt"

describe("catálogo de prompts (T6)", () => {
  it("el sello declarado coincide con el .md — cambiar el texto exige subir la versión", () => {
    for (const entry of PROMPT_CATALOG) {
      expect(
        actualPromptSha(entry),
        `El fichero ${entry.file} ha cambiado. Un prompt no se edita en el sitio: añade ` +
          `ai/prompts/${entry.code}.v${entry.version + 1}.md y su entrada en PROMPT_CATALOG.`
      ).toBe(entry.sha256)
    }
  })

  it("no hay dos entradas con el mismo (código, versión) y el fichero existe", () => {
    const keys = PROMPT_CATALOG.map((entry) => `${entry.code}@${entry.version}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of PROMPT_CATALOG) {
      expect(readPromptFile(entry).length).toBeGreaterThan(200)
    }
  })

  it("el prompt de extracción declara los campos que el modelo NO produce", () => {
    const content = readPromptFile(latestPromptEntry("extraction")).toLowerCase()
    for (const needle of ["cuenta contable", "deducibilidad", "retención", "centro de coste"]) {
      expect(content).toContain(needle)
    }
    // El documento es dato, no instrucción (§10).
    expect(content).toContain("no lo obedeces")
  })

  it("latestPromptEntry devuelve la mayor versión y promptEntry la exacta", () => {
    const latest = latestPromptEntry("extraction")
    expect(promptEntry("extraction", latest.version)).toEqual(latest)
    expect(() => promptEntry("extraction", 999)).toThrow(/versión 999/)
  })
})

describe("renderPrompt (T6)", () => {
  const fields = [{ code: "b", llm_prompt: "segundo" }, { code: "a", llm_prompt: "primero" }]
  const taxRates = [{ code: "IVA21", name: "IVA general" }, { code: "IVA10", name: "IVA reducido" }]

  it("sustituye los marcadores y sella el texto EFECTIVO", () => {
    const rendered = renderPrompt("tipos:\n{tax_rates}\ncampos:\n{fields}", { taxRates, fields })
    expect(rendered.text).toContain("- IVA10: IVA reducido")
    expect(rendered.text).not.toContain("{tax_rates}")
    expect(rendered.sha).toMatch(/^[0-9a-f]{64}$/)
  })

  it("es determinista frente al orden de las filas de la base", () => {
    const a = renderPrompt("{tax_rates}|{fields}", { taxRates, fields })
    const b = renderPrompt("{tax_rates}|{fields}", {
      taxRates: [...taxRates].reverse(),
      fields: [...fields].reverse(),
    })
    expect(a.sha).toBe(b.sha)
  })

  it("dos catálogos distintos dan sellos distintos — es lo que I-E8-11 necesita", () => {
    const a = renderPrompt("{tax_rates}|{fields}", { taxRates, fields })
    const b = renderPrompt("{tax_rates}|{fields}", { taxRates: [taxRates[0]], fields })
    expect(a.sha).not.toBe(b.sha)
  })

  it("sin catálogo el prompt sigue siendo válido y no deja marcadores sueltos", () => {
    const rendered = renderPrompt("{tax_rates}|{fields}", { taxRates: [], fields: [] })
    expect(rendered.text).not.toContain("{")
  })
})

/** Recorre `properties` en profundidad y devuelve todos los nombres de campo. */
function propertyNames(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (node === null || typeof node !== "object") return acc
  if (Array.isArray(node)) {
    for (const item of node) propertyNames(item, acc)
    return acc
  }
  const record = node as Record<string, unknown>
  const properties = record.properties
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const key of Object.keys(properties as Record<string, unknown>)) acc.add(key)
  }
  for (const value of Object.values(record)) propertyNames(value, acc)
  return acc
}

describe("esquema de extracción (T6)", () => {
  const names = propertyNames(EXTRACTION_SCHEMA_V1)

  it("NO contiene accountCode", () => {
    expect(names.has("accountCode")).toBe(false)
    expect(JSON.stringify(EXTRACTION_SCHEMA_V1)).not.toContain("accountCode")
  })

  it("no contiene ninguno de los campos vetados por ADR-0014 D4 y D11", () => {
    const leaked = FORBIDDEN_MODEL_FIELDS.filter((field) => names.has(field))
    expect(leaked, `el esquema expone campos que decide la organización: ${leaked.join(", ")}`).toEqual([])
  })

  it("sí contiene lo que el modelo debe transcribir", () => {
    for (const field of ["docKind", "documentNumber", "documentDate", "lines", "taxes", "totalCents"]) {
      expect(names.has(field)).toBe(true)
    }
    // La retención LEÍDA existe, la aplicable no.
    expect(names.has("readWithholding")).toBe(true)
  })

  it("todo objeto del esquema es cerrado: additionalProperties = false", () => {
    const stack: unknown[] = [EXTRACTION_SCHEMA_V1]
    let objectsChecked = 0
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === null || typeof node !== "object") continue
      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }
      const record = node as Record<string, unknown>
      if (record.properties) {
        objectsChecked += 1
        expect(record.additionalProperties).toBe(false)
      }
      stack.push(...Object.values(record))
    }
    expect(objectsChecked).toBeGreaterThan(5)
  })

  it("el sello del esquema es estable y la versión es v1", () => {
    expect(EXTRACTION_SCHEMA_VERSION).toBe("v1")
    expect(extractionSchemaSha()).toBe("07ca6e5bbdd0915b419c0d8bf921f0893d41f8c25ca9f7e2e78d812fe2056d3c")
  })
})

describe("validación estricta de la salida (G-17)", () => {
  const valid = {
    docKind: "FACTURA_RECIBIDA",
    documentNumber: "F-2026/17",
    counterparty: { name: "Acme SL", taxId: "B12345674" },
    documentDate: "2026-03-04",
    dueSchedule: [{ dueDate: "2026-04-04", amountCents: 121000 }],
    currency: "EUR",
    lines: [{ baseCents: 100000, discountCents: null, taxRateCode: "IVA21", description: "Servicios", qty: 1, unitPriceCents: 100000 }],
    taxes: [{ taxRateCode: "IVA21", baseCents: 100000, quotaCents: 21000 }],
    readWithholding: null,
    rectifies: null,
    totalCents: 121000,
    description: "Servicios de marzo",
    legalMentions: [],
    extra: [],
  }

  it("acepta una salida conforme", () => {
    const parsed = parseExtractionOutput(valid)
    expect(parsed.ok).toBe(true)
  })

  it("RECHAZA una clave de más — por ahí entraría una calificación contable", () => {
    const parsed = parseExtractionOutput({ ...valid, accountCode: "607" })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("accountCode")
  })

  it("RECHAZA una clave de más ANIDADA (línea con cuenta)", () => {
    const hostile = { ...valid, lines: [{ ...valid.lines[0], accountCode: "607" }] }
    expect(parseExtractionOutput(hostile).ok).toBe(false)
  })

  it("RECHAZA importes no enteros: el dinero es céntimos, nunca Float", () => {
    expect(parseExtractionOutput({ ...valid, totalCents: 1210.5 }).ok).toBe(false)
    const decimalLine = { ...valid, lines: [{ ...valid.lines[0], baseCents: 1000.5 }] }
    expect(parseExtractionOutput(decimalLine).ok).toBe(false)
  })

  it("RECHAZA un docKind inventado", () => {
    expect(parseExtractionOutput({ ...valid, docKind: "FACTURA_MAGICA" }).ok).toBe(false)
  })

  it("tolera claves ausentes: un proveedor puede omitir lo que no encontró", () => {
    expect(parseExtractionOutput({ totalCents: 0, lines: [], taxes: [] }).ok).toBe(true)
  })

  it("el zod y el JSON-Schema declaran el mismo conjunto de campos raíz", () => {
    const zodKeys = Object.keys(extractionOutputSchema.shape).sort()
    const jsonKeys = Object.keys(
      (EXTRACTION_SCHEMA_V1 as { properties: Record<string, unknown> }).properties
    ).sort()
    expect(zodKeys).toEqual(jsonKeys)
  })
})
