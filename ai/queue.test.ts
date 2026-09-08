/**
 * E9 · T22 — techo de extracciones **por organización y por minuto**, según el
 * plan (§5.4, deuda de E8).
 *
 * No se prueba `enqueueExtraction` entera —necesita base, fichero y proveedor—:
 * se prueba la **decisión**, que es la que estaba sin cerrar. Lo demás ya lo
 * cubren los tests de integración de E8.
 */

import { beforeEach, describe, expect, it } from "vitest"

import {
  EXTRACTION_RATE_LIMIT_BY_PLAN,
  ExtractionRateLimitedError,
  extractionRateLimitFor,
} from "@/ai/queue"
import { EXTRACTION_RATE_LIMIT, EXTRACTION_RATE_WINDOW_MS, extractionRateLimitKey } from "@/lib/analyze-queue"
import { consumeRateLimit, rateLimitBuckets } from "@/lib/rate-limit"

describe("T22 · techo por organización, minuto y plan", () => {
  beforeEach(() => rateLimitBuckets.clear())

  it("cada plan tiene su techo y un plan desconocido cae al de por defecto", () => {
    expect(extractionRateLimitFor({ membershipPlan: "free" })).toBe(EXTRACTION_RATE_LIMIT_BY_PLAN.free)
    expect(extractionRateLimitFor({ membershipPlan: "  PRO " })).toBe(EXTRACTION_RATE_LIMIT_BY_PLAN.pro)
    expect(extractionRateLimitFor({ membershipPlan: "plan-que-no-existe" })).toBe(EXTRACTION_RATE_LIMIT)
    expect(extractionRateLimitFor({ membershipPlan: null })).toBe(EXTRACTION_RATE_LIMIT)
    // El techo nunca desaparece por no reconocer una cadena.
    for (const limit of Object.values(EXTRACTION_RATE_LIMIT_BY_PLAN)) expect(limit).toBeGreaterThan(0)
  })

  it("la ventana es de un minuto y el techo del plan se agota en ella", () => {
    expect(EXTRACTION_RATE_WINDOW_MS).toBe(60_000)
    const limit = extractionRateLimitFor({ membershipPlan: "free" })
    const key = extractionRateLimitKey("org-1")
    const now = 1_700_000_000_000
    for (let i = 0; i < limit; i++) {
      expect(consumeRateLimit(key, limit, EXTRACTION_RATE_WINDOW_MS, now).allowed).toBe(true)
    }
    const rechazada = consumeRateLimit(key, limit, EXTRACTION_RATE_WINDOW_MS, now)
    expect(rechazada.allowed).toBe(false)
    expect(rechazada.resetAt).toBe(now + EXTRACTION_RATE_WINDOW_MS)
    // Otra organización no paga el ritmo de la primera.
    expect(consumeRateLimit(extractionRateLimitKey("org-2"), limit, EXTRACTION_RATE_WINDOW_MS, now).allowed).toBe(true)
    // Pasada la ventana, el cubo se renueva.
    expect(consumeRateLimit(key, limit, EXTRACTION_RATE_WINDOW_MS, now + EXTRACTION_RATE_WINDOW_MS).allowed).toBe(true)
  })

  it("el rechazo dice el techo, el plan y cuándo se libera", () => {
    const e = new ExtractionRateLimitedError(1_700_000_060_000, 10, "free")
    expect(e.limit).toBe(10)
    expect(e.plan).toBe("free")
    expect(e.windowMs).toBe(EXTRACTION_RATE_WINDOW_MS)
    expect(e.message).toContain("10 por minuto")
    expect(e.message).toContain("free")
  })
})
