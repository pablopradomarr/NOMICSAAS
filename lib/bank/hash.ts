/**
 * E7 · T7 — Forma canónica y `sha256` de una línea de extracto (§2.4).
 *
 * ```
 * sha256( operationDate ‖ valueDate ‖ amountCents ‖ currency
 *       ‖ normalize(description) ‖ normalize(reference1) ‖ normalize(reference2)
 *       ‖ ordinalDelDíaEnElExtracto )
 * ```
 *
 * El **ordinal del día** es lo que permite importar dos movimientos idénticos el
 * mismo día sin perder ninguno (criterio 8): sin él, el `@@unique(organizationId,
 * bankAccountId, sha256)` los colapsaría en uno y el extracto quedaría corto sin
 * que nada lo dijera.
 *
 * `normalize` = mayúsculas, colapso de espacios y sin acentos: dos importaciones
 * del mismo extracto por dos canales distintos (CSV del banco y N43) no pueden
 * dar dos líneas distintas por un acento o un espacio doble.
 *
 * Módulo PURO: `node:crypto` es determinista y sin IO.
 */

import { createHash } from "node:crypto"

import type { Cents, LocalDate } from "@/lib/bank/types"

const NULL_TOKEN = "∅"

export const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** sha256 de los BYTES importados: clave de idempotencia del extracto (I-E7-5). */
export const sha256OfBytes = (bytes: Uint8Array | Buffer): string =>
  createHash("sha256").update(Buffer.from(bytes)).digest("hex")

/**
 * Mayúsculas, sin diacríticos, espacios colapsados y recortados. No se tocan los
 * dígitos ni la puntuación: una referencia bancaria puede llevar `/` o `-` y
 * borrarlos convertiría dos referencias distintas en la misma.
 */
export function normalizeText(value: string | null | undefined): string {
  if (value === null || value === undefined) return ""
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
}

const nullable = (value: string | null | undefined): string => {
  const n = normalizeText(value)
  return n === "" ? NULL_TOKEN : n
}

/** Lo mínimo que una línea aporta a su sello. */
export type HashableBankLine = {
  operationDate: LocalDate
  valueDate: LocalDate
  amountCents: Cents
  currency: string
  description: string
  reference1?: string | null
  reference2?: string | null
  /** 1..n entre las líneas del MISMO extracto con la misma fecha de operación. */
  dayOrdinal: number
}

export function canonicalBankLineForm(line: HashableBankLine): string {
  return [
    line.operationDate,
    line.valueDate,
    String(line.amountCents),
    line.currency.toUpperCase(),
    nullable(line.description),
    nullable(line.reference1),
    nullable(line.reference2),
    String(line.dayOrdinal),
  ].join("\t")
}

export function bankLineSha256(line: HashableBankLine): string {
  return sha256Hex(canonicalBankLineForm(line))
}

/**
 * Asigna el ordinal del día **en el orden de aparición en el extracto**, que es
 * el orden del fichero: el banco lo emite y nosotros no lo reordenamos.
 */
export function assignDayOrdinals<T extends { operationDate: LocalDate }>(
  lines: readonly T[]
): readonly (T & { dayOrdinal: number })[] {
  const seen = new Map<LocalDate, number>()
  return lines.map((line) => {
    const next = (seen.get(line.operationDate) ?? 0) + 1
    seen.set(line.operationDate, next)
    return { ...line, dayOrdinal: next }
  })
}
