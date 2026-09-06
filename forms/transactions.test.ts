import { describe, expect, it } from "vitest"
import { transactionFormSchema } from "./transactions"

describe("transactionFormSchema issuedAt", () => {
  it("parses date-only strings as UTC midnight", () => {
    const result = transactionFormSchema.safeParse({ issuedAt: "2024-04-09" })

    expect(result.success).toBe(true)
    if (!result.success) return

    const date = result.data.issuedAt as Date
    expect(date.toISOString()).toBe("2024-04-09T00:00:00.000Z")
    expect(date.getUTCFullYear()).toBe(2024)
    expect(date.getUTCMonth()).toBe(3) // April
    expect(date.getUTCDate()).toBe(9)
    expect(date.getUTCHours()).toBe(0)
    expect(date.getUTCMinutes()).toBe(0)
  })

  it("keeps the calendar day in UTC regardless of local timezone", () => {
    const result = transactionFormSchema.safeParse({ issuedAt: "2024-04-09" })
    expect(result.success).toBe(true)
    if (!result.success) return

    const fixed = result.data.issuedAt as Date
    expect(fixed.getUTCDate()).toBe(9)
    expect(fixed.toISOString().startsWith("2024-04-09")).toBe(true)
  })

  it("still accepts full ISO datetime strings", () => {
    const result = transactionFormSchema.safeParse({ issuedAt: "2024-04-09T15:30:00.000Z" })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.data.issuedAt as Date).toISOString()).toBe("2024-04-09T15:30:00.000Z")
  })
})

/**
 * E8 · T19 (cierre de G-07) — el formulario parsea importes con `parseCents`,
 * no con `parseFloat(x) * 100`.
 *
 * Los casos que el gap nombraba: `19.99` (que en coma flotante daba
 * `1998.9999999999998` para una columna `Int`), la notación española, y el
 * texto ilegible, que antes se colaba como 0 y ahora es un error de validación.
 */
const parse = (total: string) => transactionFormSchema.parse({ total })

describe("transactionFormSchema · importes en céntimos enteros", () => {
  it("19.99 da 1999 céntimos exactos, no 1998,999…", () => {
    expect(parse("19.99").total).toBe(1999)
  })

  it("notación española con separador de millares", () => {
    expect(parse("1.234,56").total).toBe(123_456)
    expect(parse("1 234,56").total).toBe(123_456)
  })

  it("símbolo de moneda y negativos", () => {
    expect(parse("-12,50 €").total).toBe(-1250)
    expect(parse("(12,50)").total).toBe(-1250)
  })

  it("vacío es null, no cero", () => {
    expect(parse("").total).toBeNull()
    expect(transactionFormSchema.parse({}).total).toBeNull()
  })

  it("un importe ilegible NO vale 0: es un error de validación", () => {
    expect(() => parse("doce euros")).toThrow()
  })

  it("`convertedTotal` pasa por el mismo parseador", () => {
    expect(transactionFormSchema.parse({ convertedTotal: "0,1" }).convertedTotal).toBe(10)
    expect(() => transactionFormSchema.parse({ convertedTotal: "n/d" })).toThrow()
  })

  it("el resultado es SIEMPRE un entero seguro", () => {
    for (const raw of ["0.1", "0.2", "0.3", "1.005", "99999.99"]) {
      const cents = parse(raw).total
      expect(Number.isSafeInteger(cents)).toBe(true)
    }
  })
})
