import "server-only"

/**
 * E12 · T13 — **la doble confirmación, verificada EN EL SERVIDOR** (ADR-0020 D4).
 *
 * > *Una confirmación que sólo vive en el diálogo no es una confirmación: es una
 * > animación.*
 *
 * El mecanismo tiene **dos** piezas y las dos se comprueban aquí, no en el
 * cliente:
 *
 *  1. **El nombre exacto**, tecleado por la persona y comparado en el servidor
 *     contra `organizations.name` (`confirmsName`, sin `toLowerCase` y sin
 *     plegar acentos).
 *  2. **El token de confirmación**: la primera llamada *enumera* lo que va a
 *     pasar —recuentos por tabla, plan de antes y de después, lista de objetos a
 *     purgar— y firma esa enumeración con HMAC-SHA-256. La segunda llamada trae
 *     el token, y la acción **vuelve a enumerar** y exige que el resumen coincida.
 *
 * La segunda pieza es la que hace que la primera sirva de algo. Sin ella, entre
 * la pantalla que dice «se van a borrar 12 filas» y el botón que las borra puede
 * haber pasado cualquier cosa: otro operador trabajando sobre la misma
 * organización (el caso adversarial que T24 va a probar), un backup terminado,
 * un `RestoreJob` que arrancó. Con ella, si el mundo cambió entre los dos pasos,
 * la operación **se niega y se vuelve a enumerar**. Es preferible repetir el
 * diálogo a ejecutar algo distinto de lo que se enseñó.
 *
 * El token caduca en **cinco minutos**: lo suficiente para leer la enumeración,
 * poco para dejarlo abierto en una pestaña.
 */

import config from "@/lib/config"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { OperatorAction } from "@/lib/ledger/invariants-e12"

/** Vida del token, en milisegundos. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000

export type ConfirmationClaims = {
  action: OperatorAction
  organizationId: string
  /** Quién enumeró. El token no vale para otro operador. */
  actor: string
  /** Huella de la enumeración que se le enseñó a la persona. */
  planHash: string
  /** Caducidad, epoch en milisegundos. */
  exp: number
}

const b64url = (buf: Buffer): string => buf.toString("base64url")

function sign(payload: string): string {
  return b64url(createHmac("sha256", config.auth.secret).update(payload).digest())
}

/**
 * Huella de una enumeración. Forma canónica: claves ordenadas y JSON compacto,
 * como el resto de hashes del sistema (ADR-0011). Un recuento distinto ⇒ otro
 * hash ⇒ el token deja de valer.
 */
export function planHashOf(plan: unknown): string {
  const canonical = JSON.stringify(plan, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString()
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k]
          return acc
        }, {})
    }
    return v
  })
  return b64url(createHmac("sha256", config.auth.secret).update(`plan:${canonical}`).digest()).slice(0, 32)
}

/** Emite el token que acompaña a una enumeración. */
export function issueConfirmation(claims: Omit<ConfirmationClaims, "exp">, now: Date): string {
  const full: ConfirmationClaims = { ...claims, exp: now.getTime() + CONFIRMATION_TTL_MS }
  const payload = b64url(Buffer.from(JSON.stringify(full), "utf8"))
  return `${payload}.${sign(payload)}`
}

export type ConfirmationVerdict =
  | { ok: true; claims: ConfirmationClaims }
  | { ok: false; error: string }

/**
 * Verifica el token. **Todo** lo que puede fallar devuelve un mensaje en
 * español y ninguno de ellos revela por qué internamente: «vuelve a enumerar» es
 * la única respuesta útil en los cinco casos.
 */
export function verifyConfirmation(
  token: string,
  expected: Omit<ConfirmationClaims, "exp">,
  now: Date
): ConfirmationVerdict {
  const reenumerar = "La confirmación ya no es válida. Vuelve a abrir la operación para ver qué va a pasar ahora."

  const dot = token.lastIndexOf(".")
  if (dot <= 0) return { ok: false, error: reenumerar }
  const payload = token.slice(0, dot)
  const mac = token.slice(dot + 1)

  const expectedMac = Buffer.from(sign(payload), "utf8")
  const gotMac = Buffer.from(mac, "utf8")
  if (expectedMac.length !== gotMac.length || !timingSafeEqual(expectedMac, gotMac)) {
    return { ok: false, error: reenumerar }
  }

  let claims: ConfirmationClaims
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConfirmationClaims
  } catch {
    return { ok: false, error: reenumerar }
  }

  if (claims.exp <= now.getTime()) {
    return { ok: false, error: "La confirmación ha caducado (cinco minutos). Vuelve a abrir la operación." }
  }
  if (claims.action !== expected.action || claims.organizationId !== expected.organizationId) {
    return { ok: false, error: reenumerar }
  }
  if (claims.actor !== expected.actor) {
    // Un token no se presta: quien enumeró es quien ejecuta.
    return { ok: false, error: "Esta confirmación la emitió otra sesión. Vuelve a abrir la operación." }
  }
  if (claims.planHash !== expected.planHash) {
    return {
      ok: false,
      error:
        "Lo que va a pasar ha cambiado desde que se enumeró (otro operador, un trabajo que terminó, " +
        "una copia nueva). La operación se ha detenido: vuelve a abrirla y revisa el recuento.",
    }
  }
  return { ok: true, claims }
}
