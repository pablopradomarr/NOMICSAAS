import { describe, expect, it } from "vitest"
import { consumeRateLimit, pruneRateLimitBuckets, RateLimitBucket } from "@/lib/rate-limit"

const WINDOW = 1000

function bucketsFor() {
  return new Map<string, RateLimitBucket>()
}

describe("consumeRateLimit()", () => {
  it("permite hasta el límite y bloquea el siguiente", () => {
    const buckets = bucketsFor()
    expect(consumeRateLimit("k", 3, WINDOW, 0, buckets).allowed).toBe(true)
    expect(consumeRateLimit("k", 3, WINDOW, 10, buckets).allowed).toBe(true)
    expect(consumeRateLimit("k", 3, WINDOW, 20, buckets).allowed).toBe(true)
    const blocked = consumeRateLimit("k", 3, WINDOW, 30, buckets)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it("reabre la ventana cuando expira", () => {
    const buckets = bucketsFor()
    consumeRateLimit("k", 1, WINDOW, 0, buckets)
    expect(consumeRateLimit("k", 1, WINDOW, 500, buckets).allowed).toBe(false)
    expect(consumeRateLimit("k", 1, WINDOW, 1000, buckets).allowed).toBe(true)
  })

  it("aísla cubos distintos", () => {
    const buckets = bucketsFor()
    consumeRateLimit("a", 1, WINDOW, 0, buckets)
    expect(consumeRateLimit("a", 1, WINDOW, 1, buckets).allowed).toBe(false)
    expect(consumeRateLimit("b", 1, WINDOW, 1, buckets).allowed).toBe(true)
  })

  it("un límite de 0 bloquea siempre a partir del primer intento de la ventana", () => {
    const buckets = bucketsFor()
    // El primer intento crea el cubo; el segundo ya encuentra count >= limit.
    consumeRateLimit("k", 0, WINDOW, 0, buckets)
    expect(consumeRateLimit("k", 0, WINDOW, 1, buckets).allowed).toBe(false)
  })
})

describe("pruneRateLimitBuckets()", () => {
  it("borra sólo los cubos vencidos", () => {
    const buckets = bucketsFor()
    consumeRateLimit("viejo", 5, WINDOW, 0, buckets)
    consumeRateLimit("nuevo", 5, WINDOW, 900, buckets)
    pruneRateLimitBuckets(1500, buckets)
    expect(buckets.has("viejo")).toBe(false)
    expect(buckets.has("nuevo")).toBe(true)
  })

  it("no falla con el mapa vacío", () => {
    const buckets = bucketsFor()
    expect(() => pruneRateLimitBuckets(0, buckets)).not.toThrow()
    expect(buckets.size).toBe(0)
  })
})
