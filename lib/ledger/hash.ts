/**
 * E3 · T4 — Sello de contenido del diario (`ledgerHash` / `entryHash`).
 *
 * Forma canónica **v1, no cambia** (§2.3 del diseño): un cambio de forma
 * invalidaría todos los hashes ya emitidos. Por eso las cuatro columnas
 * analíticas entran en la forma DESDE E3, aunque hasta E4 sean siempre `∅`.
 *
 * Módulo PURO: `node:crypto` es determinista y sin IO.
 */

import { createHash } from "node:crypto"

import type { Cents, EntryKind, LocalDate } from "@/lib/ledger/types"

/** Lo mínimo que una línea debe aportar al hash. */
export type HashableLine = {
  entryDate: LocalDate
  /** 0 para un borrador aún sin numerar (`entryHash` de un asiento nuevo). */
  entryNumber?: number | null
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  entryKind: EntryKind
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
}

const NULL_TOKEN = "∅"

const nullable = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? NULL_TOKEN : v)

/**
 * Orden canónico: `(entryDate, entryNumber, lineNo)`. Con `entryNumber` ausente
 * (borrador) se usa 0, de modo que el orden lo fija `lineNo`, que es lo único
 * conocido antes de postear.
 */
function canonicalSort(lines: readonly HashableLine[]): HashableLine[] {
  return [...lines].sort(
    (a, b) =>
      (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
      (a.entryNumber ?? 0) - (b.entryNumber ?? 0) ||
      a.lineNo - b.lineNo
  )
}

/** Una fila TSV por línea, `\n` entre filas, `∅` para nulos. */
export function canonicalForm(lines: readonly HashableLine[]): string {
  return canonicalSort(lines)
    .map((l) =>
      [
        l.entryDate,
        String(l.entryNumber ?? 0),
        String(l.lineNo),
        l.accountCode,
        String(l.debitCents),
        String(l.creditCents),
        l.entryKind,
        nullable(l.projectId),
        nullable(l.costCenterId),
        nullable(l.businessLineId),
      ].join("\t")
    )
    .join("\n")
}

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** sha256 de la forma canónica de un CONJUNTO de líneas (periodo, informe). */
export function ledgerHash(lines: readonly HashableLine[]): string {
  return sha256(canonicalForm(lines))
}

/**
 * sha256 de las líneas de UN asiento (I-E3-7). Idéntica función que
 * `ledgerHash`: es el mismo sello aplicado a un subconjunto, y esa identidad es
 * la que permite verificar el asiento y el periodo con el mismo código.
 */
export function entryHash(lines: readonly HashableLine[]): string {
  return ledgerHash(lines)
}
