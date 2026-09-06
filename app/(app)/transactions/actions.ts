"use server"

import { transactionFormSchema } from "@/forms/transactions"
import { ActionState } from "@/lib/actions"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import {
  getOrganizationUploadsDirectory,
  getTransactionFileUploadPath,
  isEnoughStorageToUploadFile,
  safePathJoin,
} from "@/lib/files"
import { UploadValidationError, assertAcceptableUpload, sha256OfBuffer, syncOrganizationStorage } from "@/lib/uploads"
import { updateField } from "@/models/fields"
import { createFile, deleteFile } from "@/models/files"
import {
  bulkDeleteTransactions,
  createTransaction,
  deleteTransaction,
  getTransactionById,
  updateTransaction,
  updateTransactionFiles,
  findDuplicateTransaction,
} from "@/models/transactions"
import { Transaction } from "@/prisma/client"
import { randomUUID } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import { revalidatePath } from "next/cache"
import path from "path"

export async function createTransactionAction(
  _prevState: ActionState<Transaction> | null,
  formData: FormData
): Promise<ActionState<Transaction>> {
  try {
    const { db, user } = await requireOrg("EDITOR")
    const validatedForm = transactionFormSchema.safeParse(Object.fromEntries(formData.entries()))

    if (!validatedForm.success) {
      return { success: false, error: validatedForm.error.message }
    }

    const forceSave = formData.get("forceSave") === "true"
    const transactionData = validatedForm.data

    // --- Perform the deduplication check FIRST ---
    if (!forceSave) {
      const existingTransaction = await findDuplicateTransaction(db, transactionData)

      if (existingTransaction) {
        return {
          success: false,
          error: "DUPLICATE_FOUND",
          duplicateData: {
            existingTransaction: existingTransaction,
            newTransactionData: transactionData,
            resumeIndex: 0,
          },
        }
      }
    }

    const newTransaction = await createTransaction(db, transactionData, { createdById: user.id })

    revalidatePath("/transactions")
    return { success: true, data: newTransaction }
  } catch (error) {
    console.error("Failed to create transaction:", error)
    return { success: false, error: "Failed to create transaction" }
  }
}

export async function saveTransactionAction(
  _prevState: ActionState<Transaction> | null,
  formData: FormData
): Promise<ActionState<Transaction>> {
  try {
    const { db } = await requireOrg("EDITOR")
    const transactionId = formData.get("transactionId") as string
    const validatedForm = transactionFormSchema.safeParse(Object.fromEntries(formData.entries()))

    if (!validatedForm.success) {
      return { success: false, error: validatedForm.error.message }
    }

    const transaction = await updateTransaction(db, transactionId, validatedForm.data)

    revalidatePath("/transactions")
    return { success: true, data: transaction }
  } catch (error) {
    console.error("Failed to update transaction:", error)
    return { success: false, error: "Failed to save transaction" }
  }
}

export async function deleteTransactionAction(
  _prevState: ActionState<Transaction> | null,
  transactionId: string
): Promise<ActionState<Transaction>> {
  try {
    const { db, org } = await requireOrg("EDITOR")
    const transaction = await getTransactionById(db, transactionId)
    if (!transaction) throw new Error("Transaction not found")

    await deleteTransaction(db, transaction.id, getOrganizationUploadsDirectory(org))
    await syncOrganizationStorage(org.id)

    revalidatePath("/transactions")

    return { success: true, data: transaction }
  } catch (error) {
    console.error("Failed to delete transaction:", error)
    return { success: false, error: "Failed to delete transaction" }
  }
}

export async function deleteTransactionFileAction(
  transactionId: string,
  fileId: string
): Promise<ActionState<Transaction>> {
  if (!fileId || !transactionId) {
    return { success: false, error: "File ID and transaction ID are required" }
  }

  const { db, org } = await requireOrg("EDITOR")
  const transaction = await getTransactionById(db, transactionId)
  if (!transaction) {
    return { success: false, error: "Transaction not found" }
  }

  await updateTransactionFiles(
    db,
    transactionId,
    transaction.files ? (transaction.files as string[]).filter((id) => id !== fileId) : []
  )

  await deleteFile(db, fileId, getOrganizationUploadsDirectory(org))

  // Update organization storage used
  await syncOrganizationStorage(org.id)

  revalidatePath(`/transactions/${transactionId}`)
  return { success: true, data: transaction }
}

export async function uploadTransactionFilesAction(formData: FormData): Promise<ActionState<Transaction>> {
  try {
    const transactionId = formData.get("transactionId") as string
    const files = formData.getAll("files") as File[]

    if (!files || !transactionId) {
      return { success: false, error: "No files or transaction ID provided" }
    }

    const { db, org, user } = await requireOrg("EDITOR")
    const transaction = await getTransactionById(db, transactionId)
    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)

    // Check limits
    const totalFileSize = files.reduce((acc, file) => acc + file.size, 0)
    if (!isEnoughStorageToUploadFile(org, totalFileSize)) {
      return { success: false, error: `Insufficient storage to upload new files` }
    }

    if (isSubscriptionExpired(org)) {
      return {
        success: false,
        error: "Your subscription has expired, please upgrade your account or buy new subscription plan",
      }
    }

    // Ronda 2 (#7): los adjuntos de una transacción son subidas de usuario
    // exactamente igual que las de /files, así que pasan por la MISMA validación
    // (lista blanca + tamaño + magic bytes) y se persiste el mimetype DETECTADO,
    // nunca el `file.type` que declara el navegador.
    let fileRecords
    try {
      fileRecords = await Promise.all(
        files.map(async (file) => {
          const arrayBuffer = await file.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          const mimetype = assertAcceptableUpload(file.name, buffer)

          const fileUuid = randomUUID()
          const relativeFilePath = getTransactionFileUploadPath(fileUuid, file.name, transaction)
          const fullFilePath = safePathJoin(organizationUploadsDirectory, relativeFilePath)
          await mkdir(path.dirname(fullFilePath), { recursive: true })
          await writeFile(fullFilePath, buffer)

          return await createFile(db, {
            id: fileUuid,
            organizationId: org.id,
            uploadedById: user.id,
            filename: file.name,
            path: relativeFilePath,
            mimetype,
            // E8 · T4 (G-11): el sha se calcula AL INGERIR, siempre.
            sha256: sha256OfBuffer(buffer),
            sizeBytes: buffer.length,
            isReviewed: true,
            metadata: {
              size: buffer.length,
              lastModified: file.lastModified,
            },
          })
        })
      )
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return { success: false, error: error.message }
      }
      throw error
    }

    // Update invoice with the new file ID
    await updateTransactionFiles(
      db,
      transactionId,
      transaction.files
        ? [...(transaction.files as string[]), ...fileRecords.map((file) => file.id)]
        : fileRecords.map((file) => file.id)
    )

    // Update organization storage used
    await syncOrganizationStorage(org.id)

    revalidatePath(`/transactions/${transactionId}`)
    return { success: true }
  } catch (error) {
    console.error("Upload error:", error)
    return { success: false, error: `File upload failed: ${error}` }
  }
}

export async function bulkDeleteTransactionsAction(transactionIds: string[]) {
  try {
    const { db } = await requireOrg("EDITOR")
    await bulkDeleteTransactions(db, transactionIds)
    revalidatePath("/transactions")
    return { success: true }
  } catch (error) {
    console.error("Failed to delete transactions:", error)
    return { success: false, error: "Failed to delete transactions" }
  }
}

export async function updateFieldVisibilityAction(fieldCode: string, isVisible: boolean) {
  try {
    const { db } = await requireOrg("EDITOR")
    await updateField(db, fieldCode, {
      isVisibleInList: isVisible,
    })
    return { success: true }
  } catch (error) {
    console.error("Failed to update field visibility:", error)
    return { success: false, error: "Failed to update field visibility" }
  }
}
