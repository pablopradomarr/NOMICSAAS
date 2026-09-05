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

import { Field, Transaction } from "@/prisma/client"

/** Aviso que la UI DEBE mostrar junto a cualquiera de estos dos totales. */
export const UNPOSTED_TOTALS_NOTE =
  "Totales de documentos, no contables: agregan lo que el OCR extrajo y no distinguen los que todavía no " +
  "tienen asiento. Las cifras contables están en Informes."

export function calcTotalPerCurrency(transactions: Transaction[]): Record<string, number> {
  return transactions.reduce(
    (acc, transaction) => {
      if (transaction.convertedCurrencyCode) {
        acc[transaction.convertedCurrencyCode.toUpperCase()] =
          (acc[transaction.convertedCurrencyCode.toUpperCase()] || 0) + (transaction.convertedTotal || 0)
      } else if (transaction.currencyCode) {
        acc[transaction.currencyCode.toUpperCase()] =
          (acc[transaction.currencyCode.toUpperCase()] || 0) + (transaction.total || 0)
      }
      return acc
    },
    {} as Record<string, number>
  )
}

export function calcNetTotalPerCurrency(transactions: Transaction[]): Record<string, number> {
  return transactions.reduce(
    (acc, transaction) => {
      let amount = 0
      let currency: string | undefined
      if (
        transaction.convertedTotal !== null &&
        transaction.convertedTotal !== undefined &&
        transaction.convertedCurrencyCode
      ) {
        amount = transaction.convertedTotal
        currency = transaction.convertedCurrencyCode.toUpperCase()
      } else if (transaction.total !== null && transaction.total !== undefined && transaction.currencyCode) {
        amount = transaction.total
        currency = transaction.currencyCode.toUpperCase()
      }
      if (currency && amount !== 0) {
        const sign = transaction.type === "expense" ? -1 : 1
        acc[currency] = (acc[currency] || 0) + amount * sign
      }
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
