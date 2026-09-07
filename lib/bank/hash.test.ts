/**
 * E7 · T7 — Forma canónica y sello de una línea de extracto (§2.4), y el borde
 * de `bigint` (ADR-0015 D1).
 */

import { describe, expect, it } from "vitest"

import { assignDayOrdinals, bankLineSha256, canonicalBankLineForm, normalizeText, sha256OfBytes } from "@/lib/bank/hash"
import { centsFromBigInt, daysBetween } from "@/lib/bank/types"

const base = {
  operationDate: "2026-01-10",
  valueDate: "2026-01-12",
  amountCents: -12345,
  currency: "EUR",
  description: "Pago  proveedor  Suministros del Norte",
  reference1: "REM000000001",
  reference2: null,
  dayOrdinal: 1,
}

describe("normalizeText", () => {
  it("mayúsculas, sin acentos y espacios colapsados", () => {
    expect(normalizeText("  Comisión   de  mantenimiento ")).toBe("COMISION DE MANTENIMIENTO")
    expect(normalizeText(null)).toBe("")
  })

  it("no toca la puntuación de una referencia bancaria", () => {
    expect(normalizeText("REF-2026/0001")).toBe("REF-2026/0001")
  })
})

describe("bankLineSha256", () => {
  it("la forma canónica lleva los ocho campos en orden", () => {
    expect(canonicalBankLineForm(base).split("\t")).toEqual([
      "2026-01-10",
      "2026-01-12",
      "-12345",
      "EUR",
      "PAGO PROVEEDOR SUMINISTROS DEL NORTE",
      "REM000000001",
      "∅",
      "1",
    ])
  })

  it("es estable: el mismo dato da el mismo sello", () => {
    expect(bankLineSha256(base)).toBe(bankLineSha256({ ...base }))
    expect(bankLineSha256(base)).toHaveLength(64)
  })

  it("dos líneas idénticas del mismo día se distinguen por el ordinal", () => {
    expect(bankLineSha256(base)).not.toBe(bankLineSha256({ ...base, dayOrdinal: 2 }))
  })

  it("cambiar un céntimo, la divisa o la fecha valor cambia el sello", () => {
    expect(bankLineSha256({ ...base, amountCents: -12346 })).not.toBe(bankLineSha256(base))
    expect(bankLineSha256({ ...base, currency: "USD" })).not.toBe(bankLineSha256(base))
    expect(bankLineSha256({ ...base, valueDate: "2026-01-13" })).not.toBe(bankLineSha256(base))
  })

  it("dos escrituras del mismo concepto (acento, espacio doble) dan el mismo sello", () => {
    expect(bankLineSha256({ ...base, description: "PAGO PROVEEDOR SUMINISTROS DEL NORTE" })).toBe(bankLineSha256(base))
  })
})

describe("assignDayOrdinals", () => {
  it("numera por fecha de operación en el ORDEN DEL FICHERO", () => {
    const lines = assignDayOrdinals([
      { operationDate: "2026-01-10" },
      { operationDate: "2026-01-10" },
      { operationDate: "2026-01-11" },
      { operationDate: "2026-01-10" },
    ])
    expect(lines.map((l) => l.dayOrdinal)).toEqual([1, 2, 1, 3])
  })
})

describe("sha256OfBytes", () => {
  it("sella los bytes del fichero importado", () => {
    expect(sha256OfBytes(Buffer.from("", "utf8"))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })
})

describe("el borde de bigint (ADR-0015 D1)", () => {
  it("convierte lo que cabe", () => {
    expect(centsFromBigInt(BigInt(2500000000))).toBe(2500000000)
    expect(centsFromBigInt(BigInt(-1))).toBe(-1)
  })

  it("LANZA por encima de 2^53−1 en vez de perder precisión en silencio", () => {
    expect(() => centsFromBigInt(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), "saldo")).toThrow(/2\^53/)
  })
})

describe("daysBetween", () => {
  it("cuenta días naturales, incluido el salto de año y el 29 de febrero", () => {
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3)
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2)
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1)
    expect(daysBetween("2026-01-10", "2026-01-10")).toBe(0)
  })
})
