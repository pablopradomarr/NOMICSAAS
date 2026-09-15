"use server"

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { UploadValidationError, assertAcceptableUpload } from "@/lib/uploads"
import { EXPORT_AND_IMPORT_FIELD_MAP } from "@/models/export_and_import"
import { getFields } from "@/models/fields"
import { createTransaction, defaultCurrencyCode, findDuplicateTransaction } from "@/models/transactions"
import { Transaction } from "@/prisma/client"
import { parse } from "@fast-csv/parse"
import { revalidatePath } from "next/cache"

/**
 * **E11 · ola C · T21 — D-9 / PUEDE 14 de E10, cerrada.**
 *
 * El import comprobaba la extensión y nada más: un `.xlsx` renombrado a `.csv`
 * entraba como binario y salía como **30 000 rechazos fila a fila** en vez de un
 * «esto no es un CSV». Ahora pasa por `assertAcceptableUpload` —la misma lista
 * blanca, el mismo *sniff* de cabecera binaria y el mismo techo de tamaño que
 * los documentos de E8—, y sólo se admite lo que además declara `text/csv`.
 *
 * La validación es de borde: rechaza antes de leer una sola fila.
 */
export async function parseCSVAction(
  _prevState: ActionState<string[][]> | null,
  formData: FormData
): Promise<ActionState<string[][]>> {
  // El import escribe operaciones: exige EDITOR como la acción de guardado.
  await requireOrg("EDITOR")

  const file = formData.get("file") as File
  if (!file || file.size === 0) {
    return { success: false, error: "No se ha subido ningún fichero" }
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(await file.arrayBuffer())
  } catch {
    return { success: false, error: "No se ha podido leer el fichero" }
  }

  try {
    const mimetype = assertAcceptableUpload(file.name, buffer)
    if (mimetype !== "text/csv") {
      return {
        success: false,
        error: `El fichero ${file.name} es de tipo ${mimetype}: el import sólo admite CSV. Expórtalo como CSV y vuelve a intentarlo.`,
      }
    }
  } catch (error) {
    if (error instanceof UploadValidationError) return { success: false, error: error.message }
    throw error
  }

  try {
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
