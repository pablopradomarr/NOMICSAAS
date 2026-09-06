/**
 * E8 · ronda 1 de corrección — las dos piezas PURAS de `lib/fx/rates.ts`
 * (revisor #7 y #8). El resto del módulo hace IO y se prueba en
 * `tests/integration/e8-extraccion-fx.test.ts`.
 */

import { describe, expect, it } from "vitest"

import { assertCurrencyCode, rateMicroFromValue } from "@/lib/fx/rates"
import { roundHalfEven } from "@/lib/money"

describe("revisor #7 · ISO-4217 en la frontera", () => {
  it("acepta los tres caracteres del código y nada más", () => {
    for (const code of ["EUR", "USD", "CHF", "JPY"]) {
      expect(() => assertCurrencyCode(code)).not.toThrow()
    }
  })

  it("rechaza lo que inyectaría parámetros en la petición a la fuente", () => {
    for (const code of ["US", "USDD", "US&to=EUR", "usd", "US D", "", "EUR/../x"]) {
      expect(() => assertCurrencyCode(code)).toThrow(TypeError)
    }
  })
})

describe("revisor #8 · la tasa pasa a micros sin coma flotante", () => {
  it("un literal de seis decimales da exactamente sus micros", () => {
    expect(rateMicroFromValue(0.925926)).toBe(BigInt(925_926))
    expect(rateMicroFromValue(1.08)).toBe(BigInt(1_080_000))
    expect(rateMicroFromValue(0.92)).toBe(BigInt(920_000))
    expect(rateMicroFromValue(157.31)).toBe(BigInt(157_310_000))
  })

  it("con más de seis decimales redondea half-up sobre el séptimo", () => {
    expect(rateMicroFromValue(0.1234565)).toBe(BigInt(123_457))
    expect(rateMicroFromValue(0.1234564)).toBe(BigInt(123_456))
  })

  it("coincide con el camino anterior donde éste era exacto, y lo mejora donde no lo era", () => {
    // El camino viejo multiplicaba en `Number`: `0.1 * 1e6` da 100000.00000000001
    // y `1.005 * 1e6` da 1004999.9999999999. Aquí el resultado es el literal.
    expect(rateMicroFromValue(0.1)).toBe(BigInt(100_000))
    expect(rateMicroFromValue(1.005)).toBe(BigInt(1_005_000))
    expect(BigInt(roundHalfEven(1.005 * 1_000_000))).toBe(BigInt(1_005_000))
    // Y sobre un barrido de tasas plausibles nunca se aleja más de un micro del
    // valor exacto, que es lo que la fuente publica.
    for (let i = 1; i <= 3_000; i++) {
      const value = Number((i / 1000).toFixed(6))
      const micros = rateMicroFromValue(value)
      expect(micros).toBe(BigInt(Math.round(value * 1_000_000)))
    }
  })

  it("la notación exponencial no rompe: cae al camino documentado", () => {
    expect(rateMicroFromValue(1e-7)).toBe(BigInt(0))
  })
})
