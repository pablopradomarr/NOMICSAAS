/**
 * E2 · T5 — Aritmética de tipos impositivos en puntos básicos. Módulo puro.
 *
 * `lib/money.ts` trae `applyPermille` (tanto por mil, redondeo HALF-EVEN). No
 * sirve para impuestos por dos motivos, ambos de la validación contable:
 *  · E-1: 1,75 % (recargo de labores del tabaco) no es entero en tanto por mil.
 *  · R-IVA-2: la cuota se redondea HALF-UP al céntimo, no half-even; el sesgo
 *    del redondeo del banquero no es la convención de la AEAT.
 * Esta es la adaptación a bps: mismos enteros, mismo contrato (céntimos dentro,
 * céntimos fuera), redondeo half-up sobre la magnitud (simétrico en negativos,
 * que es lo que exige una rectificativa).
 */

import { assertCents, Cents } from "@/lib/money"
import { MAX_RATE_BPS } from "@/lib/taxes/types"

const BPS_SCALE = 10000

export function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_RATE_BPS) {
    throw new TypeError(`rateBps debe ser un entero entre 0 y ${MAX_RATE_BPS}, recibido: ${String(bps)}`)
  }
}

/**
 * Cuota de un tipo en puntos básicos sobre una base en céntimos.
 * Todo el cálculo es entero: `Math.round` sobre float perdería exactitud a
 * partir de bases grandes y no está permitido para dinero.
 */
export function applyBps(baseCents: Cents, bps: number): Cents {
  assertCents(baseCents, "base")
  assertBps(bps)
  const sign = baseCents < 0 ? -1 : 1
  const magnitude = Math.abs(baseCents) * bps
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError("cuota fuera del rango entero seguro; usar BigInt")
  }
  const quotient = Math.floor(magnitude / BPS_SCALE)
  const remainder = magnitude - quotient * BPS_SCALE
  // half-up: el empate exacto (0,5 céntimos) sube.
  const rounded = remainder * 2 >= BPS_SCALE ? quotient + 1 : quotient
  return sign * rounded
}

/** Puntos básicos → texto para la UI: 175 → "1,75", 2100 → "21". */
export function formatBps(bps: number): string {
  assertBps(bps)
  const entero = Math.floor(bps / 100)
  const decimales = bps % 100
  if (decimales === 0) return String(entero)
  const dd = String(decimales).padStart(2, "0").replace(/0$/, "")
  return `${entero},${dd}`
}

/**
 * Texto de la UI → puntos básicos. `"21"`, `"21%"`, `"5,2"`, `"1,75"` → 2100,
 * 2100, 520, 175. Devuelve `null` si no es interpretable o se sale de rango.
 * Sin `parseFloat` en ningún paso (ADR-0006).
 */
export function parseBps(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null
    // Un número ya viene en tanto por ciento: 21 → 2100.
    const scaled = Math.round(input * 100)
    return scaled >= 0 && scaled <= MAX_RATE_BPS ? scaled : null
  }
  const raw = input.trim().replace(/\s|%/g, "")
  if (raw === "") return null
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(raw)) return null
  const [entero, decimales = ""] = raw.split(/[.,]/)
  const bps = Number(entero) * 100 + Number((decimales + "00").slice(0, 2))
  return bps >= 0 && bps <= MAX_RATE_BPS ? bps : null
}
