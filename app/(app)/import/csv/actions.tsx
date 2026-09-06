"use server"

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { EXPORT_AND_IMPORT_FIELD_MAP } from "@/models/export_and_import"
import { getFields } from "@/models/fields"
import { createTransaction, defaultCurrencyCode, findDuplicateTransaction } from "@/models/transactions"
import { Transaction } from "@/prisma/client"
import { parse } from "@fast-csv/parse"
import { revalidatePath } from "next/cache"

export async function parseCSVAction(
  _prevState: ActionState<string[][]> | null,
  formData: FormData
): Promise<ActionState<string[][]>> {
  const file = formData.get("file") as File
  if (!file) {
    return { success: false, error: "No file uploaded" }
  }

  if (!file.name.toLowerCase().endsWith(".csv")) {
    return { success: false, error: "Only CSV files are allowed" }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const rows: string[][] = []

    const parser = parse()
      .on("data", (row) => rows.push(row))
      .on("error", (error) => {
        throw error
      })
    parser.write(buffer)
    parser.end()

    // Wait for parsing to complete
    await new Promise((resolve) => parser.on("end", resolve))

    return { success: true, data: rows }
  } catch (error) {
    console.error("Error parsing CSV:", error)
    return { success: false, error: "Failed to parse CSV file" }
  }
}

export async function saveTransactionsAction(
  _prevState: ActionState<Transaction> | null,
  formData: FormData
): Promise<ActionState<Transaction>> {
  const { db, user } = await requireOrg("EDITOR")
  try {
    const rows = JSON.parse(formData.get("rows") as string) as Record<string, unknown>[]

    const forceSave = formData.get("forceSave") === "true"
    const startIndex = parseInt(formData.get("resumeIndex") as string) || 0
    const rowsToProcess = rows.slice(startIndex)
    let currentIndex = startIndex
    // G-19: la moneda por defecto es la de la ORGANIZACIÓN, resuelta una vez.
    const fallbackCurrency = await defaultCurrencyCode(db)
    // G-08: columnas admitidas = las del mapa de import ∪ los campos
    // personalizados DE ESTA organización. Nada más entra.
    const allowedCodes = new Set([
      ...Object.keys(EXPORT_AND_IMPORT_FIELD_MAP),
      ...(await getFields(db)).map((field) => field.code),
    ])

    for (const row of rowsToProcess) {
      const transactionData: Record<string, unknown> = {}
      for (const [fieldCode, value] of Object.entries(row)) {
        const fieldDef = EXPORT_AND_IMPORT_FIELD_MAP[fieldCode]
        // E8 · T19 (cierre de G-08). Sólo las columnas del mapa de import entran.
        // Antes, cualquier cabecera del CSV se copiaba tal cual al objeto que
        // acaba en `createTransaction`: bastaba una columna llamada
        // `organizationId` o `journalEntryId` para intentar escribir fuera del
        // tenant o enganchar una operación a un asiento ajeno. Lo que no está
        // mapeado no se importa; se declara y se ignora.
        if (!allowedCodes.has(fieldCode)) continue
        transactionData[fieldCode] = fieldDef?.import ? await fieldDef.import(db, value) : (value as string)
      }
      if (!transactionData.currencyCode) {
        transactionData.currencyCode = fallbackCurrency
      }

      const shouldForceSave = forceSave && currentIndex === startIndex

      // --- Deduplication Check ---
      if (!shouldForceSave) {
        const existingTransaction = await findDuplicateTransaction(db, transactionData)

        if (existingTransaction) {
          return {
            success: false,
            error: "DUPLICATE_FOUND",
            duplicateData: {
              existingTransaction: existingTransaction,
              newTransactionData: transactionData,
              resumeIndex: currentIndex,
            },
          }
        }
      }
      await createTransaction(db, transactionData, { createdById: user.id })

      currentIndex++
    }

    revalidatePath("/import/csv")
    revalidatePath("/transactions")

    return { success: true }
  } catch (error) {
    console.error("Error saving transactions:", error)
    return { success: false, error: "Failed to save transactions: " + error }
  }
}
