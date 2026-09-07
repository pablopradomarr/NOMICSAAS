/**
 * E7 · T7 — Parser de extracto **CSV con mapeo por banco** (§4.2).
 *
 * No hay «un CSV bancario»: hay tantos como bancos. Por eso el mapeo es un dato
 * de la `BankAccount` (`csvMapping`, versionado como configuración y dentro de
 * `configHash`) y no una heurística del código: adivinar qué columna es el
 * importe, o si `01/02/03` es enero o febrero, es exactamente el tipo de error
 * silencioso que la capa de fiabilidad existe para impedir.
 *
 * Lo que el mapeo NO permite es inventar: si no hay columna de `reference1`, la
 * referencia es `null` y **la agrupación N-a-1 simplemente no se ofrece** (§4.2).
 *
 * Módulo PURO: recibe el texto ya leído y el mapeo; devuelve
 * `{ statement, lines, errors }` y rechaza el fichero entero al primer registro
 * que no cuadre.
 */

import { assignDayOrdinals, bankLineSha256, normalizeText } from "@/lib/bank/hash"
import type { Cents, LocalDate } from "@/lib/bank/types"
import type { ParsedStatement, ParsedStatementLine, ParseIssue, ParseResult } from "@/lib/bank/parse-types"
import { parseCents } from "@/lib/money"
import { isValidLocalDate } from "@/lib/ledger/dates"

export type { ParsedStatement, ParsedStatementLine, ParseIssue, ParseResult }

/**
 * `SIGNED`: una sola columna de importe, con su signo.
 * `DEBIT_CREDIT`: importe en valor absoluto y una columna que dice de qué lado
 * está. Los dos existen en la banca española y confundirlos invierte el extracto
 * entero sin que nada lo delate.
 */
export type CsvSignMode = "SIGNED" | "DEBIT_CREDIT"

export type CsvColumnMap = {
  operationDate: string
  valueDate?: string
  amount: string
  sign?: string
  description: string
  reference1?: string
  reference2?: string
  currency?: string
  counterpartyName?: string
  balance?: string
}

export type CsvMapping = {
  delimiter: string
  /** Separador decimal del banco: `,` en España, `.` en los extractos en inglés. */
  decimal: "," | "."
  /** `DD/MM/YYYY`, `YYYY-MM-DD`, `DD.MM.YY`… Tokens: `DD`, `MM`, `YYYY`, `YY`. */
  dateFormat: string
  /** Ventana de siglo para `YY`: `00..centuryWindow-1 → 20xx`, el resto `19xx`. */
  centuryWindow?: number
  columns: CsvColumnMap
  signMode: CsvSignMode
  /** Filas de cabecera o de cortesía que el banco antepone. */
  skipRows?: number
  /** Valores de la columna de signo que significan cargo / abono. */
  debitValues?: readonly string[]
  creditValues?: readonly string[]
  /** Divisa del extracto cuando el fichero no la trae en ninguna columna. */
  defaultCurrency?: string
  /** Saldos declarados por el banco, cuando el CSV no los trae (I-E7-6a). */
  openingBalanceCents?: Cents | null
  closingBalanceCents?: Cents | null
  declaredLineCount?: number | null
}

const DEFAULT_DEBIT_VALUES: readonly string[] = ["D", "DEBE", "CARGO", "DEBIT", "1", "-"]
const DEFAULT_CREDIT_VALUES: readonly string[] = ["H", "C", "HABER", "ABONO", "CREDIT", "2", "+"]

/** Divide una fila respetando comillas dobles (`""` es una comilla escapada). */
export function splitCsvRow(row: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (quoted) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (row.startsWith(delimiter, i)) {
      out.push(field)
      field = ""
      i += delimiter.length - 1
    } else field += ch
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/** Fecha del banco → `YYYY-MM-DD` según el formato declarado. */
export function parseMappedDate(raw: string, format: string, centuryWindow = 80): LocalDate | null {
  const value = raw.trim()
  // Formato de ancho fijo: si el banco emite `1/2/2026` con formato
  // `DD/MM/YYYY`, no se «interpreta», se rechaza. Interpretar es adivinar.
  if (value.length !== format.length) return null
  const tokens: { token: string; index: number }[] = []
  for (const token of ["YYYY", "YY", "MM", "DD"]) {
    const index = format.indexOf(token)
    if (index >= 0 && !tokens.some((t) => t.index <= index && index < t.index + t.token.length)) {
      tokens.push({ token, index })
    }
  }
  if (tokens.length !== 3) return null
  let year: number | null = null
  let month: number | null = null
  let day: number | null = null
  for (const { token, index } of tokens) {
    const slice = value.slice(index, index + token.length)
    if (!/^\d+$/.test(slice)) return null
    const n = Number(slice)
    if (token === "YYYY") year = n
    else if (token === "YY") year = n < centuryWindow ? 2000 + n : 1900 + n
    else if (token === "MM") month = n
    else day = n
  }
  if (year === null || month === null || day === null) return null
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  return isValidLocalDate(iso) ? iso : null
}

/**
 * Importe textual → céntimos con el separador decimal DECLARADO. No se adivina:
 * `1.234` es mil doscientos treinta y cuatro con decimal `,` y uno coma dos tres
 * cuatro con decimal `.`, y quien lo sabe es el mapeo del banco.
 */
export function parseMappedAmount(raw: string, decimal: "," | "."): Cents | null {
  const cleaned = raw.replace(/[^\d,.\-+()]/g, "").trim()
  if (cleaned === "") return null
  const normalized = decimal === "," ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "")
  return parseCents(normalized)
}

export function parseBankCsv(content: string, mapping: CsvMapping): ParseResult {
  const errors: ParseIssue[] = []
  const rows = content.split(/\r\n|\r|\n/)
  const skip = mapping.skipRows ?? 0
  const headerRowIndex = skip
  const headerRow = rows[headerRowIndex]
  if (headerRow === undefined || headerRow.trim() === "") {
    return { statement: null, lines: [], errors: [{ lineNo: headerRowIndex + 1, message: "el fichero no trae cabecera" }] }
  }
  const header = splitCsvRow(headerRow, mapping.delimiter).map((h) => normalizeText(h))
  const indexOf = (name: string | undefined): number => (name === undefined ? -1 : header.indexOf(normalizeText(name)))

  const cols = mapping.columns
  const required: [string, number][] = [
    ["operationDate", indexOf(cols.operationDate)],
    ["amount", indexOf(cols.amount)],
    ["description", indexOf(cols.description)],
  ]
  if (mapping.signMode === "DEBIT_CREDIT") required.push(["sign", indexOf(cols.sign)])
  for (const [name, index] of required) {
    if (index < 0) {
      errors.push({
        lineNo: headerRowIndex + 1,
        message: `el mapeo declara la columna «${String(cols[name as keyof CsvColumnMap] ?? name)}» y la cabecera no la trae`,
      })
    }
  }
  if (errors.length > 0) return { statement: null, lines: [], errors }

  const iOp = indexOf(cols.operationDate)
  const iValue = indexOf(cols.valueDate)
  const iAmount = indexOf(cols.amount)
  const iSign = indexOf(cols.sign)
  const iDesc = indexOf(cols.description)
  const iRef1 = indexOf(cols.reference1)
  const iRef2 = indexOf(cols.reference2)
  const iCurrency = indexOf(cols.currency)
  const iCounterparty = indexOf(cols.counterpartyName)
  const iBalance = indexOf(cols.balance)
  const debitValues = (mapping.debitValues ?? DEFAULT_DEBIT_VALUES).map((v) => normalizeText(v))
  const creditValues = (mapping.creditValues ?? DEFAULT_CREDIT_VALUES).map((v) => normalizeText(v))
  const century = mapping.centuryWindow ?? 80

  type Draft = Omit<ParsedStatementLine, "lineNo" | "sha256" | "dayOrdinal">
  const drafts: Draft[] = []
  const currencies = new Set<string>()

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const raw = rows[i]
    const lineNo = i + 1
    if (raw === undefined || raw.trim() === "") continue
    const cells = splitCsvRow(raw, mapping.delimiter)
    const cell = (index: number): string => (index >= 0 ? (cells[index] ?? "") : "")

    const operationDate = parseMappedDate(cell(iOp), mapping.dateFormat, century)
    if (operationDate === null) {
      errors.push({ lineNo, message: `fecha de operación ilegible: "${cell(iOp)}" (formato ${mapping.dateFormat})` })
      continue
    }
    const valueDate = iValue >= 0 ? parseMappedDate(cell(iValue), mapping.dateFormat, century) : operationDate
    if (valueDate === null) {
      errors.push({ lineNo, message: `fecha valor ilegible: "${cell(iValue)}" (formato ${mapping.dateFormat})` })
      continue
    }
    const magnitude = parseMappedAmount(cell(iAmount), mapping.decimal)
    if (magnitude === null) {
      errors.push({ lineNo, message: `importe ilegible: "${cell(iAmount)}"` })
      continue
    }
    let amountCents = magnitude
    if (mapping.signMode === "DEBIT_CREDIT") {
      const signToken = normalizeText(cell(iSign))
      if (debitValues.includes(signToken)) amountCents = -Math.abs(magnitude)
      else if (creditValues.includes(signToken)) amountCents = Math.abs(magnitude)
      else {
        errors.push({ lineNo, message: `indicador debe/haber desconocido: "${cell(iSign)}"` })
        continue
      }
    }
    const currency = (iCurrency >= 0 ? cell(iCurrency).toUpperCase() : "") || (mapping.defaultCurrency ?? "EUR")
    currencies.add(currency)
    const balance = iBalance >= 0 ? parseMappedAmount(cell(iBalance), mapping.decimal) : null

    drafts.push({
      operationDate,
      valueDate,
      amountCents,
      currency,
      originalCurrency: null,
      originalAmountCents: null,
      description: normalizeText(cell(iDesc)),
      reference1: iRef1 >= 0 ? cell(iRef1) || null : null,
      reference2: iRef2 >= 0 ? cell(iRef2) || null : null,
      conceptCommon: null,
      conceptOwn: null,
      counterpartyName: iCounterparty >= 0 ? cell(iCounterparty) || null : null,
      balanceCents: balance,
      // **m2**: el apunte de 0,00 € se importa y nace IGNORED con IMPORTE_CERO.
      status: amountCents === 0 ? "IGNORED" : "UNMATCHED",
      ignoreReason: amountCents === 0 ? "IMPORTE_CERO" : null,
    })
  }

  if (errors.length > 0) return { statement: null, lines: [], errors }
  if (drafts.length === 0) {
    return { statement: null, lines: [], errors: [{ lineNo: 0, message: "el fichero no trae ningún movimiento" }] }
  }
  if (currencies.size > 1) {
    return {
      statement: null,
      lines: [],
      errors: [{ lineNo: 0, message: `el extracto mezcla divisas (${[...currencies].sort().join(", ")}): se rechaza entero` }],
    }
  }

  const withOrdinals = assignDayOrdinals(drafts)
  const lines: ParsedStatementLine[] = withOrdinals.map((d, index) => {
    const base = { ...d, lineNo: index + 1, sha256: "" }
    return { ...base, sha256: bankLineSha256(base) }
  })
  const dates = lines.map((l) => l.operationDate).sort()

  const statement: ParsedStatement = {
    format: "CSV",
    currency: [...currencies][0] ?? mapping.defaultCurrency ?? "EUR",
    accountHint: null,
    periodStart: dates[0] as LocalDate,
    periodEnd: dates[dates.length - 1] as LocalDate,
    openingBalanceCents: mapping.openingBalanceCents ?? null,
    closingBalanceCents: mapping.closingBalanceCents ?? null,
    declaredLineCount: mapping.declaredLineCount ?? null,
    lineCount: lines.length,
  }
  return { statement, lines, errors: [] }
}
