// E13 · T3 — Tests de `checkAuthAttempt()` (docs/design/E13-autenticacion.md §3, §8.1 criterio 3).
import { describe, expect, it } from "vitest"
import {
  checkAuthAttempt,
  LOGIN_EMAIL_LIMIT,
  LOGIN_IP_LIMIT,
  RESET_EMAIL_LIMIT,
} from "@/lib/auth-rate-limit"
import { RateLimitBucket } from "@/lib/rate-limit"

function bucketsFor() {
  return new Map<string, RateLimitBucket>()
}

const IP = "203.0.113.7"
const EMAIL_HASH = "a".repeat(64) // forma de un sha256 en hex

describe("checkAuthAttempt() — login", () => {
  it("permite hasta LOGIN_EMAIL_LIMIT intentos del mismo email y bloquea el siguiente", () => {
    const buckets = bucketsFor()
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      // IPs distintas para no chocar con el límite de IP en esta prueba.
      expect(checkAuthAttempt("login", `10.0.0.${i}`, EMAIL_HASH, 0, buckets).allowed).toBe(true)
    }
    const blocked = checkAuthAttempt("login", "10.0.0.99", EMAIL_HASH, 0, buckets)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("bloquea por IP aunque el email cambie en cada intento", () => {
    const buckets = bucketsFor()
    for (let i = 0; i < LOGIN_IP_LIMIT; i++) {
      expect(checkAuthAttempt("login", IP, `email-${i}`, 0, buckets).allowed).toBe(true)
    }
    expect(checkAuthAttempt("login", IP, "otro-email-mas", 0, buckets).allowed).toBe(false)
  })

  it("reabre la ventana cuando expira (15 min por email)", () => {
    const buckets = bucketsFor()
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      checkAuthAttempt("login", `10.0.1.${i}`, EMAIL_HASH, 0, buckets)
    }
    expect(checkAuthAttempt("login", "10.0.1.99", EMAIL_HASH, 0, buckets).allowed).toBe(false)
    // 15 minutos + 1 ms después, la ventana del email ya expiró.
    expect(checkAuthAttempt("login", "10.0.1.100", EMAIL_HASH, 15 * 60 * 1000 + 1, buckets).allowed).toBe(true)
  })

  it("no mezcla los cubos de login y reset para el mismo sujeto", () => {
    const buckets = bucketsFor()
    for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
      checkAuthAttempt("login", `10.0.2.${i}`, EMAIL_HASH, 0, buckets)
    }
    expect(checkAuthAttempt("login", "10.0.2.99", EMAIL_HASH, 0, buckets).allowed).toBe(false)
    // El mismo email, pero para "reset", tiene su propio cubo intacto.
    expect(checkAuthAttempt("reset", "10.0.2.99", EMAIL_HASH, 0, buckets).allowed).toBe(true)
  })
})

describe("checkAuthAttempt() — reset", () => {
  it("permite hasta RESET_EMAIL_LIMIT intentos y bloquea el siguiente", () => {
    const buckets = bucketsFor()
    for (let i = 0; i < RESET_EMAIL_LIMIT; i++) {
      expect(checkAuthAttempt("reset", `10.0.3.${i}`, EMAIL_HASH, 0, buckets).allowed).toBe(true)
    }
    expect(checkAuthAttempt("reset", "10.0.3.99", EMAIL_HASH, 0, buckets).allowed).toBe(false)
  })
})
