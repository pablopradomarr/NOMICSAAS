/**
 * E7 · T7 — Parser de la **Norma 43** del Consejo Superior Bancario (cuaderno
 * CSB43), `docs/design/E7-auditoria.md` §4.2.
 *
 * Recibe el TEXTO ya leído (el IO vive en la server action) y devuelve
 * `{ statement, lines, errors }`. **Un registro que no cuadra no se importa a
 * medias**: se rechaza el fichero entero con la línea y el motivo (§4.2). Por
 * eso `statement` es `null` en cuanto hay un error.
 *
 * Los tres errores silenciosos que este fichero existe para impedir (O-14, R9):
 *
 * 1. **El signo.** Indicador `1` = DEBE (cargo: baja el saldo del titular ⇒
 *    `amountCents < 0`); `2` = HABER (abono ⇒ `> 0`). Invertirlo produce un
 *    extracto que cuadra consigo mismo y punteos que I-E7-2 «confirmaría».
 * 2. **La ventana de siglo.** Las fechas son `AAMMDD`: `00–79 → 20xx`,
 *    `80–99 → 19xx`. Sin ella un extracto de 1998 se parsea como 2098.
 * 3. **El desbordamiento.** Catorce dígitos sin signo caben en `bigint` pero no
 *    siempre en un `number`: se comprueba al parsear y se **rechaza el fichero**,
 *    nunca se trunca.
 *
 * Y el cuarto, que no es del cuaderno sino nuestro: **la fecha de operación es
 * la 11–16 y la fecha valor la 17–22**. Invertirlas mueve movimientos a través
 * del cierre y ningún invariante lo detectaría.
 *
 * Módulo PURO.
 */

import { assignDayOrdinals, bankLineSha256, normalizeText } from "@/lib/bank/hash"
import { daysInMonth } from "@/lib/ledger/dates"
import type { Cents, LocalDate } from "@/lib/bank/types"
import type { ParsedStatement, ParsedStatementLine, ParseIssue, ParseResult } from "@/lib/bank/parse-types"

export type { ParsedStatement, ParsedStatementLine, ParseIssue, ParseResult }

/**
 * Ventana de siglo del cuaderno, **constante documentada** y no una heurística:
 * `00–79 → 20xx`, `80–99 → 19xx`. Un extracto anterior a 1980 no existe en
 * soporte N43.
 */
export const CENTURY_WINDOW = 80

/** Catorce dígitos sin signo: el tope del cuaderno. */
export const N43_AMOUNT_DIGITS = 14

/**
 * Divisas del ISO 4217 **numérico** que el registro 11 declara. Tabla explícita:
 * inventar la traducción a partir del número sería adivinar.
 */
export const ISO_4217_NUMERIC: Readonly<Record<string, string>> = {
  "978": "EUR",
  "840": "USD",
  "826": "GBP",
  "756": "CHF",
  "392": "JPY",
  "124": "CAD",
  "036": "AUD",
  "752": "SEK",
  "578": "NOK",
  "208": "DKK",
  "985": "PLN",
  "203": "CZK",
  "348": "HUF",
  "946": "RON",
  "484": "MXN",
  "032": "ARS",
  "986": "BRL",
  "156": "CNY",
}

export function currencyOf(raw: string): string | null {
  const token = raw.trim()
  if (token === "") return null
  if (/^[A-Za-z]{3}$/.test(token)) return token.toUpperCase()
  if (!/^\d{1,3}$/.test(token)) return null
  return ISO_4217_NUMERIC[token.padStart(3, "0")] ?? null
}

/** `AAMMDD` → `YYYY-MM-DD` con la ventana de siglo. `null` si no es una fecha. */
export function parseN43Date(raw: string): LocalDate | null {
  if (!/^\d{6}$/.test(raw)) return null
  const yy = Number(raw.slice(0, 2))
  const month = Number(raw.slice(2, 4))
  const day = Number(raw.slice(4, 6))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const year = yy < CENTURY_WINDOW ? 2000 + yy : 1900 + yy
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  // Rechaza el 31 de febrero: el cuaderno no lo prohíbe, la contabilidad sí.
  return day > daysInMonth(year, month) ? null : iso
}

/**
 * Importe sin signo → céntimos con el signo del indicador.
 *
 * Se parsea con **`BigInt`** y la guarda es sobre el VALOR, no sobre el ancho:
 * un campo de catorce dígitos siempre cabe en un `number`, pero el acumulado del
 * extracto —y cualquier fichero que se salga del ancho del cuaderno— puede no
 * caber, y perder precisión en silencio es peor que rechazar el fichero.
 */
export function parseN43Amount(raw: string, sign: "1" | "2"): { cents: Cents } | { error: string } {
  const digits = raw.trim()
  if (!/^\d{1,24}$/.test(digits)) return { error: `importe no numérico: "${raw}"` }
  const magnitude = BigInt(digits)
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { error: `importe ${digits} desborda 2^53−1 céntimos: el fichero se rechaza, nunca se trunca` }
  }
  const cents = Number(magnitude)
  if (cents === 0) return { cents: 0 }
  return { cents: sign === "1" ? -cents : cents }
}

/** El acumulado del extracto también tiene que caber (ADR-0015 D1, O-23). */
function assertSafeTotal(label: string, value: bigint): string | null {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER)
  return value > MAX || value < -MAX
    ? `${label} ${value.toString()} desborda 2^53−1 céntimos: el fichero se rechaza, nunca se trunca`
    : null
}

const at = (line: string, from: number, to: number): string => line.slice(from - 1, to)

type Draft = {
  operationDate: LocalDate
  valueDate: LocalDate
  amountCents: Cents
  conceptCommon: string
  conceptOwn: string
  documentNumber: string
  reference1: string | null
  reference2: string | null
  concepts: string[]
  originalCurrency: string | null
  originalAmountCents: Cents | null
}

/**
 * Parsea un fichero Norma 43 completo.
 *
 * Sólo se admite **una cuenta por fichero**: un extracto es de una cuenta
 * bancaria y el modelo (`BankStatement.bankAccountId`) también. Un fichero con
 * dos registros `11` se rechaza nombrando la línea, en vez de importar la
 * primera cuenta y perder la segunda sin decirlo.
 */
export function parseN43(content: string): ParseResult {
  const errors: ParseIssue[] = []
  const rows = content.split(/\r\n|\r|\n/)
  const drafts: Draft[] = []

  let header: { periodStart: LocalDate; periodEnd: LocalDate; opening: Cents; currency: string; account: string } | null =
    null
  let footer: { declaredLineCount: number; closing: Cents; debitCount: number; creditCount: number } | null = null
  let fileEnd = false
  let current: Draft | null = null

  const push = (lineNo: number, message: string): void => {
    errors.push({ lineNo, message })
  }

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const lineNo = i + 1
    if (raw === undefined || raw.trim() === "") continue
    const code = at(raw, 1, 2)

    switch (code) {
      case "11": {
        if (header !== null) {
          push(lineNo, "el fichero declara dos cuentas (registro 11 repetido): un extracto es de una sola cuenta")
          break
        }
        const periodStart = parseN43Date(at(raw, 21, 26))
        const periodEnd = parseN43Date(at(raw, 27, 32))
        const signRaw = at(raw, 33, 33)
        const currency = currencyOf(at(raw, 48, 50))
        if (periodStart === null) push(lineNo, `fecha inicial inválida: "${at(raw, 21, 26)}"`)
        if (periodEnd === null) push(lineNo, `fecha final inválida: "${at(raw, 27, 32)}"`)
        if (signRaw !== "1" && signRaw !== "2") push(lineNo, `indicador de signo del saldo inicial inválido: "${signRaw}"`)
        if (currency === null) push(lineNo, `clave de divisa desconocida: "${at(raw, 48, 50)}"`)
        const opening =
          signRaw === "1" || signRaw === "2" ? parseN43Amount(at(raw, 34, 47), signRaw) : { error: "signo inválido" }
        if ("error" in opening) push(lineNo, `saldo inicial: ${opening.error}`)
        if (periodStart !== null && periodEnd !== null && currency !== null && !("error" in opening)) {
          if (periodStart > periodEnd) push(lineNo, `periodo invertido: ${periodStart} > ${periodEnd}`)
          header = {
            periodStart,
            periodEnd,
            opening: opening.cents,
            currency,
            account: `${at(raw, 3, 6)}${at(raw, 7, 10)}${at(raw, 11, 20)}`.trim(),
          }
        }
        break
      }
      case "22": {
        if (header === null) {
          push(lineNo, "movimiento (registro 22) antes de la cabecera de cuenta (registro 11)")
          break
        }
        const operationDate = parseN43Date(at(raw, 11, 16))
        const valueDate = parseN43Date(at(raw, 17, 22))
        const signRaw = at(raw, 28, 28)
        if (operationDate === null) push(lineNo, `fecha de operación inválida: "${at(raw, 11, 16)}"`)
        if (valueDate === null) push(lineNo, `fecha valor inválida: "${at(raw, 17, 22)}"`)
        if (signRaw !== "1" && signRaw !== "2") {
          push(lineNo, `indicador debe/haber inválido: "${signRaw}" (1 = cargo, 2 = abono)`)
          break
        }
        const amount = parseN43Amount(at(raw, 29, 42), signRaw)
        if ("error" in amount) {
          push(lineNo, amount.error)
          break
        }
        if (operationDate === null || valueDate === null) break
        current = {
          operationDate,
          valueDate,
          amountCents: amount.cents,
          conceptCommon: at(raw, 23, 24).trim(),
          conceptOwn: at(raw, 25, 27).trim(),
          documentNumber: at(raw, 43, 52).trim(),
          reference1: at(raw, 53, 64).trim() || null,
          reference2: at(raw, 65, 80).trim() || null,
          concepts: [],
          originalCurrency: null,
          originalAmountCents: null,
        }
        drafts.push(current)
        break
      }
      case "23": {
        if (current === null) {
          push(lineNo, "concepto complementario (registro 23) sin movimiento previo (registro 22)")
          break
        }
        const c1 = at(raw, 5, 42).trim()
        const c2 = at(raw, 43, 80).trim()
        if (c1 !== "") current.concepts.push(c1)
        if (c2 !== "") current.concepts.push(c2)
        break
      }
      case "24": {
        if (current === null) {
          push(lineNo, "importe en divisa (registro 24) sin movimiento previo (registro 22)")
          break
        }
        const currency = currencyOf(at(raw, 5, 7))
        if (currency === null) {
          push(lineNo, `clave de divisa desconocida en el registro 24: "${at(raw, 5, 7)}"`)
          break
        }
        // El registro 24 no lleva indicador propio: hereda el signo del 22.
        const amount = parseN43Amount(at(raw, 8, 21), current.amountCents < 0 ? "1" : "2")
        if ("error" in amount) {
          push(lineNo, `importe en divisa: ${amount.error}`)
          break
        }
        current.originalCurrency = currency
        current.originalAmountCents = amount.cents
        break
      }
      case "33": {
        if (header === null) {
          push(lineNo, "final de cuenta (registro 33) sin cabecera")
          break
        }
        const debitCount = Number(at(raw, 21, 25))
        const creditCount = Number(at(raw, 40, 44))
        const signRaw = at(raw, 59, 59)
        if (!Number.isInteger(debitCount) || !Number.isInteger(creditCount)) {
          push(lineNo, "número de apuntes del registro 33 no numérico")
          break
        }
        if (signRaw !== "1" && signRaw !== "2") {
          push(lineNo, `indicador de signo del saldo final inválido: "${signRaw}"`)
          break
        }
        const closing = parseN43Amount(at(raw, 60, 73), signRaw)
        if ("error" in closing) {
          push(lineNo, `saldo final: ${closing.error}`)
          break
        }
        footer = { declaredLineCount: debitCount + creditCount, closing: closing.cents, debitCount, creditCount }
        current = null
        break
      }
      case "88": {
        fileEnd = true
        const declared = Number(at(raw, 21, 26))
        if (!Number.isInteger(declared)) push(lineNo, "número de registros del registro 88 no numérico")
        break
      }
      default:
        push(lineNo, `registro desconocido: "${code}"`)
    }
  }

  if (header === null) errors.push({ lineNo: 0, message: "el fichero no trae cabecera de cuenta (registro 11)" })
  if (footer === null) errors.push({ lineNo: 0, message: "el fichero no trae final de cuenta (registro 33)" })
  if (!fileEnd) errors.push({ lineNo: 0, message: "el fichero no trae fin de fichero (registro 88)" })

  if (header !== null) {
    const total = drafts.reduce((acc, d) => acc + BigInt(d.amountCents), BigInt(0))
    const overflow =
      assertSafeTotal("la suma de movimientos", total) ??
      assertSafeTotal("el saldo final calculado", BigInt(header.opening) + total)
    if (overflow !== null) errors.push({ lineNo: 0, message: overflow })
  }

  if (errors.length > 0 || header === null || footer === null) {
    return { statement: null, lines: [], errors }
  }

  const withOrdinals = assignDayOrdinals(drafts)
  const lines: ParsedStatementLine[] = withOrdinals.map((d, index) => {
    const description = normalizeText([d.concepts.join(" "), d.documentNumber].filter((s) => s !== "").join(" "))
    const line: ParsedStatementLine = {
      lineNo: index + 1,
      operationDate: d.operationDate,
      valueDate: d.valueDate,
      amountCents: d.amountCents,
      currency: header.currency,
      originalCurrency: d.originalCurrency,
      originalAmountCents: d.originalAmountCents,
      description,
      reference1: d.reference1,
      reference2: d.reference2,
      conceptCommon: d.conceptCommon || null,
      conceptOwn: d.conceptOwn || null,
      counterpartyName: null,
      dayOrdinal: d.dayOrdinal,
      sha256: "",
      // **m2.** El apunte de 0,00 € del banco se importa y nace IGNORED con
      // IMPORTE_CERO: rechazarlo partiría el `lineNo` (I-E7-5) y el cotejo con
      // el registro 33 (I-E7-6a) por un movimiento que el banco sí declaró.
      status: d.amountCents === 0 ? "IGNORED" : "UNMATCHED",
      ignoreReason: d.amountCents === 0 ? "IMPORTE_CERO" : null,
    }
    return { ...line, sha256: bankLineSha256({ ...line }) }
  })

  const statement: ParsedStatement = {
    format: "N43",
    currency: header.currency,
    accountHint: header.account,
    // **Registro 11, posiciones 21-32** (H-7): el periodo lo declara el banco.
    periodStart: header.periodStart,
    periodEnd: header.periodEnd,
    periodDeclared: true,
    openingBalanceCents: header.opening,
    closingBalanceCents: footer.closing,
    declaredLineCount: footer.declaredLineCount,
    lineCount: lines.length,
  }

  return { statement, lines, errors: [] }
}
