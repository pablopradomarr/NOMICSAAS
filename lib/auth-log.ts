/**
 * E13 · T3 — Log de auth de PROCESO (docs/design/E13-autenticacion.md §7b, decisión D-13-3).
 *
 * Para lo pre-tenant: `login_ok`, `login_ko`, `reset_requested`, `reset_completed`. Nunca va a
 * `AuditLog` porque `audit_logs.organization_id` es `NOT NULL` y una petición no autenticada
 * (email inexistente incluido) no debe poder escribir en una tabla de tenant: sería a la vez
 * un vector de DoS por inflado y una fuga que revelaría qué emails tienen cuenta — justo lo
 * que el invariante S1 impide. Línea JSON estructurada a stdout; nunca el email en claro, sólo
 * su sha256 (`emailHash`).
 */

export type AuthLogEvent = "login_ok" | "login_ko" | "reset_requested" | "reset_completed"

export type AuthLogEntry = {
  event: AuthLogEvent
  emailHash: string
  ip: string
  userAgent?: string | null
  ts: string
  userId?: string
}

export function logAuthEvent(entry: Omit<AuthLogEntry, "ts">): void {
  const line: AuthLogEntry = { ...entry, ts: new Date().toISOString() }
  // Línea JSON estructurada: nunca el email en claro, nunca la contraseña ni su longitud.
  console.log(JSON.stringify({ scope: "auth", ...line }))
}
