/**
 * E7 · T7 — Salida común de los dos parsers de extracto (§4.2).
 *
 * `lib/bank/csv.ts` y `lib/bank/n43.ts` son **puros**: reciben el texto ya leído
 * (y el mapeo, en CSV) y devuelven `{ statement, lines, errors }`. Con un solo
 * error, `statement` es `null` y `lines` va vacío: **un fichero no se importa a
 * medias**. Media importación es un extracto con un hueco en `lineNo` (I-E7-5
 * FAIL) y un `lineCount` que no coteja con el registro 33 (I-E7-6a FAIL); o
 * peor, un cuadre que «cierra» con movimientos que no están.
 *
 * Módulo PURO.
 */

import type { Cents, IgnoreReason, LocalDate, StatementFormat } from "@/lib/bank/types"

export type ParseIssue = {
  /** Línea del fichero (1..n). `0` = problema del fichero entero. */
  lineNo: number
  message: string
}

export type ParsedStatementLine = {
  lineNo: number
  operationDate: LocalDate
  valueDate: LocalDate
  /** CON SIGNO, en la divisa del extracto: negativo = cargo, positivo = abono. */
  amountCents: Cents
  currency: string
  originalCurrency: string | null
  originalAmountCents: Cents | null
  description: string
  reference1: string | null
  reference2: string | null
  conceptCommon: string | null
  conceptOwn: string | null
  counterpartyName: string | null
  balanceCents?: Cents | null
  /** Ordinal del día dentro del extracto: entra en el `sha256` (criterio 8). */
  dayOrdinal: number
  sha256: string
  /** Con qué estado nace la línea. Sólo el importe 0 nace `IGNORED` (m2). */
  status: "UNMATCHED" | "IGNORED"
  ignoreReason: IgnoreReason | null
}

export type ParsedStatement = {
  format: StatementFormat
  currency: string
  /** Cuenta que declara el fichero, para cotejarla con la `BankAccount` (T9). */
  accountHint: string | null
  periodStart: LocalDate
  periodEnd: LocalDate
  openingBalanceCents: Cents | null
  closingBalanceCents: Cents | null
  declaredLineCount: number | null
  lineCount: number
}

export type ParseResult = {
  statement: ParsedStatement | null
  lines: readonly ParsedStatementLine[]
  errors: readonly ParseIssue[]
}
