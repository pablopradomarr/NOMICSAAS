"use server"

import * as React from "react"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import {
  getTransactionFileUploadPath,
  getOrganizationUploadsDirectory,
  isEnoughStorageToUploadFile,
  safePathJoin,
} from "@/lib/files"
import { getAppData, setAppData } from "@/models/apps"
import { createFile } from "@/models/files"
import { syncOrganizationStorage } from "@/lib/uploads"
import { Prisma } from "@/prisma/client"
import {
  createTransaction,
  updateTransactionFiles,
  TransactionData,
  findDuplicateTransaction,
} from "@/models/transactions"
import { Transaction } from "@/prisma/client"
import { renderToBuffer } from "@react-pdf/renderer"
import { randomUUID } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import { revalidatePath } from "next/cache"
import path from "path"
import { createElement } from "react"
import { InvoiceFormData } from "./components/invoice-page"
import { InvoicePDF } from "./components/invoice-pdf"
import { InvoiceTemplate } from "./default-templates"
import { InvoiceAppData } from "./page"

export async function generateInvoicePDF(data: InvoiceFormData): Promise<Uint8Array> {
  const pdfElement = createElement(InvoicePDF, { data })
  const buffer = await renderToBuffer(pdfElement as unknown as React.ReactElement<Record<string, never>>)
  return new Uint8Array(buffer)
}

export async function addNewTemplateAction(template: InvoiceTemplate) {
  const { db, user } = await requireOrg("EDITOR")
  const appData = (await getAppData(db, user.id, "invoices")) as InvoiceAppData | null
  const updatedTemplates = [...(appData?.templates || []), template]
  const appDataResult = await setAppData(db, user.id, "invoices", {
    ...appData,
    templates: updatedTemplates,
  } as unknown as Prisma.InputJsonValue)
  return { success: true, data: appDataResult }
}

export async function deleteTemplateAction(templateId: string) {
  const { db, user } = await requireOrg("EDITOR")
  const appData = (await getAppData(db, user.id, "invoices")) as InvoiceAppData | null
  if (!appData) return { success: false, error: "No app data found" }

  const updatedTemplates = appData.templates.filter((t) => t.id !== templateId)
  const appDataResult = await setAppData(db, user.id, "invoices", {
    ...appData,
    templates: updatedTemplates,
  } as unknown as Prisma.InputJsonValue)
  return { success: true, data: appDataResult }
}

export async function saveInvoiceAsTransactionAction(
  formData: InvoiceFormData,
  forceSave: boolean = false
): Promise<{
  success: boolean
  error?: string
  data?: Transaction
  duplicateData?: {
    existingTransaction: Transaction
    newTransactionData: Record<string, unknown>
  }
}> {
  try {
    const { db, org, user } = await requireOrg("EDITOR")

    // Generate PDF
    const pdfBuffer = await generateInvoicePDF(formData)

    // Calculate total amount from items
    const subtotal = formData.items.reduce((sum, item) => sum + item.subtotal, 0)
    const taxes = formData.additionalTaxes.reduce((sum, tax) => sum + tax.amount, 0)
    const fees = formData.additionalFees.reduce((sum, fee) => sum + fee.amount, 0)
    const totalAmount = (formData.taxIncluded ? subtotal : subtotal + taxes) + fees

    // Create transaction
    const rawTransactionData: TransactionData = {
      name: `Invoice #${formData.invoiceNumber || "unknown"}`,
      merchant: `${formData.billTo.split("\n")[0]}`,
      total: totalAmount * 100,
      currencyCode: formData.currency,
      issuedAt: new Date(formData.date),
      categoryCode: null,
      projectCode: null,
      type: "income",
      status: "pending",
    }

    // --- Deduplication Check ---
    if (!forceSave) {
      const existingTransaction = await findDuplicateTransaction(db, rawTransactionData)

      if (existingTransaction) {
        return {
          success: false,
          error: "DUPLICATE_FOUND",
          duplicateData: {
            existingTransaction: existingTransaction,
            newTransactionData: rawTransactionData,
          },
        }
      }
    }

    const transaction = await createTransaction(db, rawTransactionData, { createdById: user.id })

    // Check storage limits
    if (!isEnoughStorageToUploadFile(org, pdfBuffer.length)) {
      return {
        success: false,
        error: "Insufficient storage to save invoice PDF",
      }
    }

    if (isSubscriptionExpired(org)) {
      return {
        success: false,
        error: "Your subscription has expired, please upgrade your account or buy new subscription plan",
      }
    }

    // Save PDF file
    const fileUuid = randomUUID()
    const fileName = `invoice-${formData.invoiceNumber}.pdf`
    const relativeFilePath = getTransactionFileUploadPath(fileUuid, fileName, transaction)
    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)
    const fullFilePath = safePathJoin(organizationUploadsDirectory, relativeFilePath)

    await mkdir(path.dirname(fullFilePath), { recursive: true })
    await writeFile(fullFilePath, pdfBuffer)

    // Create file record in database
    const fileRecord = await createFile(db, {
      id: fileUuid,
      organizationId: org.id,
      uploadedById: user.id,
      filename: fileName,
      path: relativeFilePath,
      mimetype: "application/pdf",
      isReviewed: true,
      metadata: {
        size: pdfBuffer.length,
        lastModified: Date.now(),
      },
    })

    // Update transaction with the file ID
    await updateTransactionFiles(db, transaction.id, [fileRecord.id])
    await syncOrganizationStorage(org.id)

    revalidatePath("/transactions")

    return { success: true, data: transaction }
  } catch (error) {
    console.error("Failed to save invoice as transaction:", error)
    return {
      success: false,
      error: `Failed to save invoice as transaction: ${error}`,
    }
  }
}
