/**
 * Rate limit en memoria (E1-fix, hallazgo #14).
 *
 * Alcance deliberadamente modesto: frena el abuso desde un mismo proceso
 * (fuerza bruta sobre `/invite/<token>`, reenvío masivo de invitaciones). No
 * sobrevive a un reinicio ni se comparte entre réplicas — para eso hará falta
 * Redis o una tabla, y queda anotado en el diseño. La barrera persistente que sí
 * sobrevive es `Invitation.attempts`, que bloquea el enlace a los 5 intentos.
 *
 * La ventana se pasa por parámetro y el reloj entra como argumento: la función
 * es determinista y testeable sin `Date.now()` implícito.
 */

export type RateLimitBucket = { count: number; resetAt: number }

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number }

/** Estado compartido del proceso; se expone para poder limpiarlo en tests. */
export const rateLimitBuckets = new Map<string, RateLimitBucket>()

export const INVITE_ATTEMPT_LIMIT = 10
export const INVITE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000

/** Intentos fallidos de aceptación tras los cuales la invitación queda bloqueada. */
export const INVITATION_MAX_ATTEMPTS = 5

/**
 * Consume una unidad del cubo `key`. Puro respecto al reloj: `now` es argumento.
 * @param key identificador del sujeto limitado (IP, token, email…)
 * @param limit número de intentos permitidos por ventana
 * @param windowMs duración de la ventana en milisegundos
 * @param now instante de referencia en epoch ms
 */
export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  buckets: Map<string, RateLimitBucket> = rateLimitBuckets
): RateLimitResult {
  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs
    buckets.set(key, { count: 1, resetAt })
    return { allowed: true, remaining: limit - 1, resetAt }
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt }
  }

  bucket.count += 1
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt }
}

/** Elimina los cubos ya expirados (llamada oportunista para no crecer sin límite). */
export function pruneRateLimitBuckets(now: number, buckets: Map<string, RateLimitBucket> = rateLimitBuckets): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}
