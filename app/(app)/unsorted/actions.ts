"use server"

import { transactionFormSchema } from "@/forms/transactions"
import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { getOrganizationUploadsDirectory, getTransactionFileUploadPath, safePathJoin, unsortedFilePath } from "@/lib/files"
import { UploadValidationError, assertAcceptableUpload, syncOrganizationStorage } from "@/lib/uploads"
import { createFile, deleteFile, getFileById, updateFile } from "@/models/files"
import {
  createTransaction,
  TransactionData,
  updateTransactionFiles,
  findDuplicateTransaction,
} from "@/models/transactions"
import { Transaction } from "@/prisma/client"
import { randomUUID } from "crypto"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { revalidatePath } from "next/cache"
import path from "path"

export async function saveFileAsTransactionAction(
  _prevState: ActionState<Transaction> | null,
  formData: FormData
): Promise<ActionState<Transaction>> {
  try {
    const { db, org, user } = await requireOrg("EDITOR")
    const validatedForm = transactionFormSchema.safeParse(Object.fromEntries(formData.entries()))

    if (!validatedForm.success) {
      return { success: false, error: validatedForm.error.message }
    }

    // Get the file record
    const fileId = formData.get("fileId") as string
    const file = await getFileById(db, fileId)
    if (!file) throw new Error("File not found")

    const forceSave = formData.get("forceSave") === "true"
    const transactionData = validatedForm.data

    // --- Deduplication Check ---
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

    const transaction = await createTransaction(db, validatedForm.data, { createdById: user.id })

    // Move file to processed location
    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)
    const originalFileName = path.basename(file.path)
    const newRelativeFilePath = getTransactionFileUploadPath(file.id, originalFileName, transaction)

    // Move file to new location and name
    const oldFullFilePath = safePathJoin(organizationUploadsDirectory, file.path)
    const newFullFilePath = safePathJoin(organizationUploadsDirectory, newRelativeFilePath)
    await mkdir(path.dirname(newFullFilePath), { recursive: true })
    await rename(path.resolve(oldFullFilePath), path.resolve(newFullFilePath))

    // Update file record
    await updateFile(db, file.id, {
      path: newRelativeFilePath,
      isReviewed: true,
    })

    await updateTransactionFiles(db, transaction.id, [file.id])
    await syncOrganizationStorage(org.id)

    revalidatePath("/unsorted")
    revalidatePath("/transactions")

    return { success: true, data: transaction }
  } catch (error) {
    console.error("Failed to save transaction:", error)
    return { success: false, error: `Failed to save transaction: ${error}` }
  }
}

export async function deleteUnsortedFileAction(
  _prevState: ActionState<Transaction> | null,
  fileId: string
): Promise<ActionState<Transaction>> {
  try {
    const { db, org } = await requireOrg("EDITOR")
    await deleteFile(db, fileId, getOrganizationUploadsDirectory(org))
    await syncOrganizationStorage(org.id)
    revalidatePath("/unsorted")
    return { success: true }
  } catch (error) {
    console.error("Failed to delete file:", error)
    return { success: false, error: "Failed to delete file" }
  }
}

export async function splitFileIntoItemsAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  try {
    const { db, org, user } = await requireOrg("EDITOR")
    const fileId = formData.get("fileId") as string
    const items = JSON.parse(formData.get("items") as string) as TransactionData[]

    if (!fileId || !items || items.length === 0) {
      return { success: false, error: "File ID and items are required" }
    }

    // Get the original file
    const originalFile = await getFileById(db, fileId)
    if (!originalFile) {
      return { success: false, error: "Original file not found" }
    }

    // Get the original file's content
    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)
    const originalFilePath = safePathJoin(organizationUploadsDirectory, originalFile.path)
    const fileContent = await readFile(originalFilePath)

    // Ronda 2 (#7): el nombre de la parte conserva la EXTENSIÓN del original (si
    // no, `unsortedFilePath` derivaba una extensión del nombre del item) y el
    // contenido vuelve a pasar por la validación, que además devuelve el
    // mimetype real: nunca se persiste el declarado por el cliente.
    const originalExtension = path.extname(originalFile.filename)
    const originalBaseName = path.basename(originalFile.filename, originalExtension)

    // Create a new file for each item
    for (const item of items) {
      const fileUuid = randomUUID()
      const fileName = `${originalBaseName}-part-${item.name}${originalExtension}`
      const mimetype = assertAcceptableUpload(fileName, fileContent)
      const relativeFilePath = unsortedFilePath(fileUuid, fileName)
      const fullFilePath = safePathJoin(organizationUploadsDirectory, relativeFilePath)

      // Create directory if it doesn't exist
      await mkdir(path.dirname(fullFilePath), { recursive: true })

      // Copy the original file content
      await writeFile(fullFilePath, fileContent)

      // Create file record in database with the item data cached
      await createFile(db, {
        id: fileUuid,
        organizationId: org.id,
        uploadedById: user.id,
        filename: fileName,
        path: relativeFilePath,
        mimetype,
        metadata: originalFile.metadata ?? undefined,
        isSplitted: true,
        cachedParseResult: {
          name: item.name,
          merchant: item.merchant,
          description: item.description,
          total: item.total,
          currencyCode: item.currencyCode,
          categoryCode: item.categoryCode,
          projectCode: item.projectCode,
          type: item.type,
          issuedAt: item.issuedAt,
          note: item.note,
          text: item.text,
        },
      })
    }

    // Delete the original file
    await deleteFile(db, fileId, organizationUploadsDirectory)

    // Update organization storage used
    await syncOrganizationStorage(org.id)

    revalidatePath("/unsorted")
    return { success: true }
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return { success: false, error: error.message }
    }
    console.error("Failed to split file into items:", error)
    return { success: false, error: `Failed to split file into items: ${error}` }
  }
}
