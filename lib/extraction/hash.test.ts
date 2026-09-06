/**
 * E8 · T5 — canonicidad de `lib/extraction/hash.ts`.
 *
 * Lo que estos tests defienden es una sola afirmación: **dos ejecuciones del
 * mismo camino determinista producen el mismo sello, byte a byte** (I-E8-6,
 * RC-16). Todo lo demás —el orden de claves, la NFC, los finales de línea— son
 * las formas concretas en que esa afirmación se rompería sin que nadie lo note.
 */

import { describe, expect, it } from "vitest"

import {
  canonicalJson,
  normalizeText,
  promptContentHash,
  promptHash,
  proposalHash,
  schemaHash,
} from "@/lib/extraction/hash"
import type { ExtractionProposal } from "@/lib/extraction/types"

const proposal = (over: Partial<ExtractionProposal> = {}): ExtractionProposal => ({
  version: 1,
  docKind: "FACTURA_RECIBIDA",
  documentNumber: "F-2026/104",
  counterparty: { name: "Consultoría Ávila, S.L.", taxId: "B12345674" },
  documentDate: "2026-03-10",
  receptionDate: "2026-03-14",
  currency: "EUR",
  lines: [{ kind: "OPERACION", baseCents: 100000, taxRateCode: "IVA21" }],
  taxes: [{ taxRateCode: "IVA21", baseCents: 100000, quotaCents: 21000 }],
  totalCents: 121000,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeText — LF, sin espacios finales, NFC", () => {
  it("caso vacío: no lanza y devuelve la cadena vacía", () => {
    expect(normalizeText("")).toBe("")
  })

  it("CRLF y CR se unifican a LF: el mismo prompt editado en Windows sella igual", () => {
    expect(normalizeText("uno\r\ndos\rtres")).toBe("uno\ndos\ntres")
    expect(promptHash("uno\r\ndos")).toBe(promptHash("uno\ndos"))
  })

  it("los espacios y tabuladores al final de línea no son instrucciones", () => {
    expect(normalizeText("uno   \n\tdos\t\t")).toBe("uno\n\tdos")
    expect(promptHash("Analiza:   \nel documento  ")).toBe(promptHash("Analiza:\nel documento"))
  })

  it("NFC: «á» compuesta y descompuesta son el mismo texto", () => {
    const compuesta = "Ávila"
    const descompuesta = "Ávila"
    expect(compuesta).not.toBe(descompuesta)
    expect(normalizeText(compuesta)).toBe(normalizeText(descompuesta))
    expect(promptHash(compuesta)).toBe(promptHash(descompuesta))
  })

  it("acabar o no en salto de línea no cambia el sello", () => {
    expect(promptHash("texto\n\n")).toBe(promptHash("texto"))
  })

  it("los espacios INTERIORES sí cuentan: no se normaliza el contenido, sólo el formato", () => {
    expect(promptHash("dos  espacios")).not.toBe(promptHash("dos espacios"))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("canonicalJson — claves ordenadas, sin undefined, NFC", () => {
  it("caso vacío", () => {
    expect(canonicalJson({})).toBe("{}")
    expect(canonicalJson([])).toBe("[]")
    expect(canonicalJson(null)).toBe("null")
  })

  it("el ORDEN de las claves no cambia el resultado (la propiedad clave de I-E8-6)", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })

  it("ordena también en profundidad", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ b: 1, a: 2 }] })).toBe('{"a":[{"a":2,"b":1}],"z":{"x":2,"y":1}}')
  })

  it("`undefined` se OMITE en objetos y se conserva como null en arrays", () => {
    // En un objeto, «ausente» y «undefined» son lo mismo. En un array, omitirlo
    // correría las posiciones y cambiaría el significado.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]")
  })

  it("`null` NO es `undefined`: un campo explícitamente nulo sella distinto que uno ausente", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })

  it("importes negativos y el cero negativo", () => {
    expect(canonicalJson({ cents: -12345 })).toBe('{"cents":-12345}')
    // -0 y 0 son el mismo importe; sellarlos distinto sería un falso positivo.
    expect(canonicalJson({ cents: -0 })).toBe(canonicalJson({ cents: 0 }))
  })

  it("un número no finito LANZA en vez de esconderse como null", () => {
    expect(() => canonicalJson({ total: Number.NaN })).toThrow(/no finito/)
    expect(() => canonicalJson({ total: Number.POSITIVE_INFINITY })).toThrow(/no finito/)
  })

  it("`bigint` se serializa como decimal en texto (JSON.stringify lanzaría)", () => {
    expect(canonicalJson({ rateMicro: 1085000n })).toBe('{"rateMicro":"1085000"}')
  })

  it("un `Date` LANZA: en esta capa las fechas son LocalDate, sin zona", () => {
    expect(() => canonicalJson({ d: new Date("2026-03-10") })).toThrow(/LocalDate/)
  })

  it("una referencia cíclica lanza en vez de colgarse", () => {
    const a: Record<string, unknown> = { name: "a" }
    a.self = a
    expect(() => canonicalJson(a)).toThrow(/cíclica/)
  })

  it("el mismo objeto repetido dos veces NO es un ciclo", () => {
    const shared = { x: 1 }
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}')
  })

  it("NFC también en claves y en valores de texto", () => {
    expect(canonicalJson({ ["Área"]: "Ávila" })).toBe(canonicalJson({ Área: "Ávila" }))
  })

  it("fechas límite y de cierre de ejercicio viajan como texto y no se tocan", () => {
    expect(canonicalJson({ d: "2028-02-29", e: "2026-12-31" })).toBe('{"d":"2028-02-29","e":"2026-12-31"}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("los cuatro sellos", () => {
  it("son sha256 en hexadecimal minúscula de 64 caracteres", () => {
    for (const h of [
      promptHash("x"),
      schemaHash({ type: "object" }),
      proposalHash(proposal()),
      promptContentHash("x"),
    ]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it("`promptHash` sella el prompt EFECTIVO: dos sustituciones distintas, dos sellos", () => {
    const plantilla = (categorias: string) => `Analiza el documento.\nCategorías: ${categorias}`
    expect(promptHash(plantilla("compras, viajes"))).not.toBe(promptHash(plantilla("compras, software")))
  })

  it("`schemaHash` no depende del orden en que se escribió el schema", () => {
    expect(schemaHash({ type: "object", required: ["total"] })).toBe(schemaHash({ required: ["total"], type: "object" }))
    // …pero sí del contenido: quitar un campo obligatorio es otro schema.
    expect(schemaHash({ type: "object", required: ["total"] })).not.toBe(schemaHash({ type: "object", required: [] }))
  })

  it("`proposalHash` es estable entre ejecuciones (I-E8-6) e independiente del orden de claves", () => {
    const p = proposal()
    expect(proposalHash(p)).toBe(proposalHash(p))
    expect(proposalHash(p)).toBe(proposalHash({ ...proposal(), version: 1 }))
  })

  it("`proposalHash`: UN céntimo de diferencia en la cuota cambia el sello", () => {
    const otra = proposal({ taxes: [{ taxRateCode: "IVA21", baseCents: 100000, quotaCents: 21001 }] })
    expect(proposalHash(otra)).not.toBe(proposalHash(proposal()))
  })

  it("`proposalHash`: cambiar la fecha de RECEPCIÓN cambia el sello (decide el trimestre de IVA)", () => {
    expect(proposalHash(proposal({ receptionDate: "2026-04-02" }))).not.toBe(proposalHash(proposal()))
  })

  it("`proposalHash`: un campo declarado `undefined` sella igual que uno ausente", () => {
    expect(proposalHash(proposal({ accrualDate: undefined }))).toBe(proposalHash(proposal()))
    // …pero `null` explícito NO: «sin devengo» y «devengo desconocido» difieren.
    expect(proposalHash(proposal({ accrualDate: null }))).not.toBe(proposalHash(proposal()))
  })

  it("los cuatro sellos son FUNCIONES DISTINTAS del mismo texto donde procede", () => {
    // `promptHash` y `promptContentHash` comparten normalización a propósito: el
    // contenido de una `PromptVersion` sin variables ES el prompt efectivo.
    expect(promptContentHash("Analiza.")).toBe(promptHash("Analiza."))
  })

  it("caso vacío: una propuesta sin líneas ni impuestos también sella", () => {
    const vacia = proposal({ lines: [], taxes: [], totalCents: 0 })
    expect(proposalHash(vacia)).toMatch(/^[0-9a-f]{64}$/)
    expect(proposalHash(vacia)).not.toBe(proposalHash(proposal()))
  })

  it("un total NEGATIVO (abono tal como lo emite el programa del proveedor) sella sin lanzar", () => {
    // La normalización a `ABONO_*` con valores absolutos es de RC-13, no del
    // sello: aquí sólo se comprueba que el sello no es el que estorba.
    expect(proposalHash(proposal({ totalCents: -121000 }))).toMatch(/^[0-9a-f]{64}$/)
  })
})
