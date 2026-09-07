/**
 * E13 · T3 — Rate limit de auth (docs/design/E13-autenticacion.md §3), envoltorio determinista
 * sobre `lib/rate-limit.ts` (el reloj entra por argumento, sin `Date.now()` implícito). Mismo
 * alcance modesto que el rate limit de invitaciones de E1: en memoria del proceso, no
 * sobrevive a un reinicio ni se comparte entre réplicas (deuda ya declarada, cierre en E11).
 */

import { consumeRateLimit, rateLimitBuckets, RateLimitBucket } from "@/lib/rate-limit"

export const LOGIN_IP_LIMIT = 10
export const LOGIN_IP_WINDOW_MS = 10 * 60 * 1000

export const LOGIN_EMAIL_LIMIT = 5
export const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000

export const RESET_EMAIL_LIMIT = 3
export const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000

export type AuthAttemptKind = "login" | "reset"

export type AuthAttemptResult = { allowed: boolean; retryAfterSeconds: number }

const LIMITS: Record<AuthAttemptKind, { ipLimit: number; ipWindowMs: number; emailLimit: number; emailWindowMs: number }> = {
  login: {
    ipLimit: LOGIN_IP_LIMIT,
    ipWindowMs: LOGIN_IP_WINDOW_MS,
    emailLimit: LOGIN_EMAIL_LIMIT,
    emailWindowMs: LOGIN_EMAIL_WINDOW_MS,
  },
  reset: {
    // El reset comparte ventana/IP con el límite por email: no hay un límite de IP propio
    // en el diseño para "reset", así que reutilizamos el mismo umbral que el email para no
    // introducir un tercer bucket sin criterio (§3, §5 S1/S3).
    ipLimit: RESET_EMAIL_LIMIT,
    ipWindowMs: RESET_EMAIL_WINDOW_MS,
    emailLimit: RESET_EMAIL_LIMIT,
    emailWindowMs: RESET_EMAIL_WINDOW_MS,
  },
}

/**
 * Comprueba (y consume) el intento por IP y por hash del email a la vez: basta con que uno de
 * los dos cubos esté agotado para bloquear. `subjectHash` es el sha256 del email en minúsculas,
 * nunca el email en claro (mismo criterio que E1 con el token de invitación).
 */
export function checkAuthAttempt(
  kind: AuthAttemptKind,
  ip: string,
  subjectHash: string,
  now: number,
  buckets: Map<string, RateLimitBucket> = rateLimitBuckets
): AuthAttemptResult {
  const limits = LIMITS[kind]

  const ipResult = consumeRateLimit(`auth:${kind}:ip:${ip}`, limits.ipLimit, limits.ipWindowMs, now, buckets)
  // Revisión E13 #3: si la IP ya está agotada no se consume el cubo del email, para que un
  // atacante con muchas IPs no pueda vaciar el cubo de una víctima a base de peticiones denegadas.
  if (!ipResult.allowed) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((ipResult.resetAt - now) / 1000)) }
  }
  const emailResult = consumeRateLimit(
    `auth:${kind}:email:${subjectHash}`,
    limits.emailLimit,
    limits.emailWindowMs,
    now,
    buckets
  )

  if (!ipResult.allowed || !emailResult.allowed) {
    const resetAt = Math.max(
      ipResult.allowed ? 0 : ipResult.resetAt,
      emailResult.allowed ? 0 : emailResult.resetAt
    )
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}
