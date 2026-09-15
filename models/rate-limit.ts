/**
 * E11 · ola A · T15 — rate limit **persistente**. Cierra **D-10** (ADR-0017 R4).
 *
 * Hasta aquí los cubos vivían en memoria de proceso (`lib/auth-rate-limit.ts`):
 * desaparecían al reiniciar y **no se compartían entre réplicas**, de modo que
 * seis intentos repartidos entre dos réplicas contaban como tres y tres — es
 * decir, el límite no existía en cuanto hubiera más de un proceso (criterio 57).
 *
 * `rate_limit_buckets` **no tiene `organization_id`** (§9.5): el cubo se llena
 * antes de saber quién llama. Por eso este fichero usa el cliente sin acotar y
 * está en la lista blanca de `eslint.config.mjs`.
 *
 * **§9.2 · la clave es SIEMPRE un `sha256`**, nunca el email ni la IP en claro.
 * Lo garantiza `hashKey()` aquí y un CHECK `~ '^[0-9a-f]{64}$'` en la base: un
 * descuido no puede meter PII en un cubo de rate limit.
 */

import { createHash } from "node:crypto"

import { prisma } from "@/lib/db"

/** Ámbitos declarados. Uno nuevo se añade aquí, no se inventa en la llamada. */
export const RATE_LIMIT_SCOPES = {
  /** E13: intentos de acceso por email. Cierra la deuda D-10. */
  AUTH_LOGIN: "auth:login",
  /** E13: peticiones de restablecimiento de contraseña por email. */
  AUTH_RESET: "auth:reset",
  /** §9.3 · webhook de Stripe por IP. */
  STRIPE_WEBHOOK: "stripe:webhook",
  /** §9.3 · `/api/cron/[job]` por IP. Se consume TAMBIÉN en el 401 (criterio 51). */
  CRON: "cron:ip",
  /** §9.3 · `requestBackupAction` por organización. */
  BACKUP_REQUEST: "backup:request",
} as const

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[keyof typeof RATE_LIMIT_SCOPES]

/** sha256 en hexadecimal. El valor en claro **no sale de esta función**. */
export function hashKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex")
}

/** Inicio de la ventana fija a la que pertenece `at`. */
export function windowStart(at: Date, windowMs: number): Date {
  return new Date(Math.floor(at.getTime() / windowMs) * windowMs)
}

export type RateLimitVerdict = {
  allowed: boolean
  /** Peticiones consumidas en la ventana, ya contando ésta. */
  count: number
  limit: number
  /** Cuándo vuelve a permitirse. Lo usa la cabecera `Retry-After`. */
  resetAt: Date
}

/**
 * Consume una unidad del cubo `(scope, key, ventana)` y dice si se permite.
 *
 * El incremento es **atómico**: un `INSERT … ON CONFLICT DO UPDATE SET count =
 * count + 1` devolviendo el valor. Dos réplicas que atiendan a la vez suman
 * dos, no uno — que es justo lo que el cubo en memoria no podía hacer.
 *
 * El consumo ocurre **siempre**, incluso cuando se deniega: si el intento
 * rechazado no contara, un atacante tendría reintentos gratis.
 */
export async function consumeRateLimit(
  scope: RateLimitScope,
  rawKey: string,
  opts: { limit: number; windowMs: number; at: Date }
): Promise<RateLimitVerdict> {
  const key = hashKey(rawKey)
  const windowAt = windowStart(opts.at, opts.windowMs)
  const expiresAt = new Date(windowAt.getTime() + opts.windowMs)

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "rate_limit_buckets" ("scope", "key", "window_at", "count", "expires_at")
    VALUES (${scope}, ${key}, ${windowAt}, 1, ${expiresAt})
    ON CONFLICT ("scope", "key", "window_at")
    DO UPDATE SET "count" = "rate_limit_buckets"."count" + 1
    RETURNING "count"
  `
  const count = rows[0]?.count ?? 1
  return { allowed: count <= opts.limit, count, limit: opts.limit, resetAt: expiresAt }
}

/** Consulta sin consumir. Para pintar el estado, nunca para decidir. */
export async function peekRateLimit(
  scope: RateLimitScope,
  rawKey: string,
  opts: { windowMs: number; at: Date }
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT "count" FROM "rate_limit_buckets"
     WHERE "scope" = ${scope} AND "key" = ${hashKey(rawKey)}
       AND "window_at" = ${windowStart(opts.at, opts.windowMs)}
  `
  return rows[0]?.count ?? 0
}

/**
 * Vacía el cubo de una clave: lo llama el acceso correcto tras un login válido,
 * para que un usuario legítimo no arrastre sus intentos fallidos.
 */
export async function clearRateLimit(scope: RateLimitScope, rawKey: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { scope, key: hashKey(rawKey) } })
}

/**
 * Barrido de cubos caducados. Lo invoca el job `retention` (§7.1): sin él la
 * tabla crece sin techo, y un cubo caducado no dice nada de nadie.
 */
export async function pruneExpiredBuckets(before: Date): Promise<number> {
  const r = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: before } } })
  return r.count
}
