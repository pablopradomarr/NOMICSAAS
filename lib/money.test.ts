import { describe, expect, it } from "vitest"
import {
  applyPermille,
  convertWithRateMicro,
  formatCents,
  parseCents,
  roundHalfEven,
  splitLargestRemainder,
  sumCents,
} from "./money"

describe("roundHalfEven", () => {
  it("redondea al par en .5", () => {
    expect(roundHalfEven(0.5)).toBe(0)
    expect(roundHalfEven(1.5)).toBe(2)
    expect(roundHalfEven(2.5)).toBe(2)
    expect(Object.is(roundHalfEven(-0.5), 0)).toBe(true)
    expect(roundHalfEven(-1.5)).toBe(-2)
  })
  it("redondea normal fuera de .5", () => {
    expect(roundHalfEven(1.49)).toBe(1)
    expect(roundHalfEven(1.51)).toBe(2)
    expect(roundHalfEven(-1.51)).toBe(-2)
  })
})

describe("parseCents", () => {
  it("formatos es-ES y en-US", () => {
    expect(parseCents("1.234,56")).toBe(123456)
    expect(parseCents("1,234.56")).toBe(123456)
    expect(parseCents("1234.56")).toBe(123456)
    expect(parseCents("1234,5")).toBe(123450)
    expect(parseCents("1 234,56 €")).toBe(123456)
    expect(parseCents("1.234")).toBe(123400) // miles, no decimal
    expect(parseCents("12")).toBe(1200)
  })
  it("negativos y vacíos", () => {
    expect(parseCents("-12,50")).toBe(-1250)
    expect(parseCents("(12,50)")).toBe(-1250)
    expect(parseCents("")).toBeNull()
    expect(parseCents(null)).toBeNull()
    expect(parseCents("abc")).toBeNull()
  })
  it("números", () => {
    expect(parseCents(12.345)).toBe(1234) // half-even sobre 1234.5
    expect(parseCents(0)).toBe(0)
  })
})

describe("formatCents", () => {
  it("es-ES con símbolo", () => {
    expect(formatCents(123456)).toMatch(/1\.234,56\s?€/)
    expect(formatCents(-1250)).toMatch(/−12,50\s?€/)
    expect(formatCents(0, { zeroAsDash: true })).toBe("—")
  })
  it("rechaza no enteros", () => {
    expect(() => formatCents(12.5)).toThrow()
  })
})

describe("applyPermille / convertWithRateMicro", () => {
  it("IVA 21% sobre 100,00", () => expect(applyPermille(10000, 210)).toBe(2100))
  it("IRPF 15% sobre 33,33 → 5,00 (half-even de 4,9995)", () => expect(applyPermille(3333, 150)).toBe(500))
  it("conversión con tasa 1,085 → 108,50", () => expect(convertWithRateMicro(10000, 1_085_000n)).toBe(10850))
  it("importe negativo", () => expect(applyPermille(-10000, 210)).toBe(-2100))
})

describe("splitLargestRemainder", () => {
  it("suma exacta con restos", () => {
    const r = splitLargestRemainder(100, [1, 1, 1])
    expect(r).toEqual([34, 33, 33])
    expect(sumCents(r)).toBe(100)
  })
  it("dataset vacío y un solo receptor", () => {
    expect(splitLargestRemainder(100, [])).toEqual([])
    expect(splitLargestRemainder(100, [5])).toEqual([100])
  })
  it("pesos cero → igualitario; negativos → signo conservado", () => {
    expect(splitLargestRemainder(10, [0, 0, 0, 0])).toEqual([3, 3, 2, 2])
    expect(splitLargestRemainder(-100, [1, 1, 1])).toEqual([-34, -33, -33])
  })
  it("proporcional a ingresos con remanente al mayor", () => {
    const r = splitLargestRemainder(1000, [700, 200, 100])
    expect(r).toEqual([700, 200, 100])
    const r2 = splitLargestRemainder(1001, [700, 200, 100])
    expect(sumCents(r2)).toBe(1001)
    expect(r2[0]).toBe(701)
  })
  it("propiedad: Σ = total para casos aleatorios fijos", () => {
    const cases: Array<[number, number[]]> = [
      [999, [3, 3, 3]],
      [1, [1, 2, 3]],
      [123456, [0.1, 0.2, 0.7]],
      [50, [10, 20, 30, 40]],
    ]
    for (const [t, w] of cases) expect(sumCents(splitLargestRemainder(t, w))).toBe(t)
  })
  it("rechaza pesos negativos y total no entero", () => {
    expect(() => splitLargestRemainder(100, [1, -1])).toThrow()
    expect(() => splitLargestRemainder(100.5, [1])).toThrow()
  })
})

describe("sumCents", () => {
  it("suma y valida", () => {
    expect(sumCents([1, 2, 3])).toBe(6)
    expect(() => sumCents([1, 2.5])).toThrow()
  })
})
