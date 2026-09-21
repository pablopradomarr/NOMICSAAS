/**
 * TaxHacker heredado, **acotado en E6** (§4 del diseño, cierre de G-05/G-06).
 *
 * Estas dos sumas por moneda son la única cifra del producto que NO sale del
 * libro diario: agregan `Transaction.total`, que es lo que el OCR extrajo de un
 * documento **todavía sin contabilizar**. Su ámbito queda reducido al pie de la
 * pantalla de documentos, y allí se pinta con el badge `no verificado` y la
 * leyenda de que no entran en ninguna cifra contable.
 *
 * **Prohibido usarlas en el panel, en un informe o en cualquier sitio donde
 * puedan confundirse con una cifra contable.** El panel se reescribió sobre el
 * diario justamente porque este agregado producía totales que no cuadraban con
 * el balance y nadie sabía por qué (G-05). Los agregados de `models/stats.ts`,
 * que hacían lo mismo a escala de panel, se retiraron.
 */

/**
 * ── E12 · T18 · **G-20** ─────────────────────────────────────────────────────
 *
 * Hasta esta épica estas dos funciones **no tenían un solo test**, y la primera
 * tanda los encontró: `(transaction.total || 0)` deja pasar `NaN` (`NaN || 0`
 * es `NaN`), deja pasar `Infinity`, y con una cadena —que una fila de OCR sí
 * puede traer— **concatena en vez de sumar**: `0 + "1234" + 5000` da
 * `"012345000"`, una cadena que la pantalla pinta como si fuera un total.
 *
 * Eso es **G-05 vivo** en el único agregado del producto que no sale del
 * diario, y por eso el saneado de abajo no es defensivo: es el arreglo. Lo que
 * no es un número finito **no entra**, y una fila rota no contamina a la buena
 * que tiene al lado.
 */
import { Field, Transaction } from "@/prisma/client"

/** Aviso que la UI DEBE mostrar junto a cualquiera de estos dos totales. */
export const UNPOSTED_TOTALS_NOTE =
  "Totales de documentos, no contables: agregan lo que el OCR extrajo y no distinguen los que todavía no " +
  "tienen asiento. Las cifras contables están en Informes."

/**
 * El importe, o `null`. **`NaN`, `Infinity`, una cadena y un `null` valen lo
 * mismo aquí: nada.** Un total ausente es un total ausente; convertirlo en 0
 * afirmaría que hubo un movimiento de cero, y dejarlo pasar produciría el
 * `NaN` de G-05.
 */
function finiteAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** El código ISO en mayúsculas, o `null`. La cadena vacía no es una moneda. */
function currencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toUpperCase()
  return trimmed === "" ? null : trimmed
}

/**
 * El par `(moneda, importe)` que de verdad aporta una fila: **la conversión
 * manda**, y si la conversión está a medias —moneda sin importe, o importe sin
 * moneda— se cae a la original en vez de perder la fila.
 */
function amountOf(transaction: Transaction): { currency: string; amount: number } | null {
  const convertedCurrency = currencyKey(transaction.convertedCurrencyCode)
  const convertedAmount = finiteAmount(transaction.convertedTotal)
  if (convertedCurrency !== null && convertedAmount !== null) {
    return { currency: convertedCurrency, amount: convertedAmount }
  }
  const currency = currencyKey(transaction.currencyCode)
  const amount = finiteAmount(transaction.total)
  if (currency !== null && amount !== null) return { currency, amount }
  return null
}

export function calcTotalPerCurrency(transactions: Transaction[]): Record<string, number> {
  return transactions.reduce(
    (acc, transaction) => {
      const row = amountOf(transaction)
      if (row === null) return acc
      acc[row.currency] = (acc[row.currency] ?? 0) + row.amount
      return acc
    },
    {} as Record<string, number>
  )
}

export function calcNetTotalPerCurrency(transactions: Transaction[]): Record<string, number> {
  return transactions.reduce(
    (acc, transaction) => {
      const row = amountOf(transaction)
      // Un importe 0 no crea la moneda: un cubo a cero afirmaría que hubo
      // movimiento en ella, y no lo hubo.
      if (row === null || row.amount === 0) return acc
      const sign = transaction.type === "expense" ? -1 : 1
      acc[row.currency] = (acc[row.currency] ?? 0) + row.amount * sign
      return acc
    },
    {} as Record<string, number>
  )
}

export const isTransactionIncomplete = (fields: Field[], transaction: Transaction): boolean => {
  const incompleteFields = incompleteTransactionFields(fields, transaction)

  return incompleteFields.length > 0
}

export const incompleteTransactionFields = (fields: Field[], transaction: Transaction): Field[] => {
  const requiredFields = fields.filter((field) => field.isRequired)

  return requiredFields.filter((field) => {
    const value = field.isExtra
      ? (transaction.extra as Record<string, unknown>)?.[field.code]
      : transaction[field.code as keyof Transaction]

    return value === undefined || value === null || value === ""
  })
}
