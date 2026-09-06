"use server"

import * as React from "react"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import type { TenantClient } from "@/lib/db"
import {
  getTransactionFileUploadPath,
  getOrganizationUploadsDirectory,
  isEnoughStorageToUploadFile,
  safePathJoin,
} from "@/lib/files"
import { emitInvoiceSchema, type EmitInvoiceInput } from "@/forms/invoices"
import { emitInvoice } from "@/models/invoices"
import { formatLedgerErrors, todayLocalDate } from "@/models/ledger"
import { lineBaseCents, QUANTITY_SCALE } from "@/lib/invoices/totals"
import type { Organization } from "@/prisma/client"
import { getAppData, setAppData } from "@/models/apps"
import { createFile } from "@/models/files"
import { sha256OfBuffer, syncOrganizationStorage } from "@/lib/uploads"
import { Prisma } from "@/prisma/client"
import {
  createTransaction,
  updateTransactionFiles,
  TransactionData,
  findDuplicateTransaction,
  getTransactionById,
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

/**
 * E8 · T18 — emitir una factura y contabilizarla.
 *
 * Orden deliberado:
 *
 * 1. **Transacción corta**: número de la serie con `FOR UPDATE`, recálculo en
 *    servidor y asiento T-01/T-02. Si algo falla, el número no se consume y no
 *    queda hueco (I-E8-20).
 * 2. **PDF después**, ya con el número asignado: renderizarlo dentro de la
 *    transacción la alargaría segundos y serializaría toda la serie. Se guarda
 *    como `File` con su `sha256` (G-11) y se engancha a la operación.
 *
 * Rol **EDITOR**: un `VIEWER` ve las facturas emitidas —es información de
 * auditoría— y no emite ninguna.
 */
export async function emitInvoiceAction(rawInput: unknown): Promise<
  | { success: true; documentNumber: string; transactionId: string; entryId: string; totalCents: number; fileId: string | null }
  | { success: false; error: string }
> {
  const { db, org, user } = await requireOrg("EDITOR")

  const parsed = emitInvoiceSchema.safeParse(rawInput)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") }
  }

  const emitted = await emitInvoice(org.id, parsed.data, { userId: user.id }, { refDate: todayLocalDate() })
  if (!emitted.ok) {
    return { success: false, error: formatLedgerErrors(emitted.errors) }
  }

  // El asiento ya existe: el PDF es un adjunto, y si falla no deshace la
  // factura. Se declara el fallo en vez de fingir que no pasó nada.
  let fileId: string | null = null
  try {
    fileId = await attachInvoicePdf(db, org, user.id, emitted.value.transactionId, {
      ...invoiceFormDataFor(parsed.data, emitted.value.documentNumber, org.baseCurrency),
    })
  } catch (error) {
    console.error("Factura emitida sin PDF adjunto:", error)
  }

  revalidatePath("/transactions")
  revalidatePath("/ledger")

  return {
    success: true,
    documentNumber: emitted.value.documentNumber,
    transactionId: emitted.value.transactionId,
    entryId: emitted.value.entry.id,
    totalCents: emitted.value.totalCents,
    fileId,
  }
}

/** Datos mínimos del PDF a partir de la entrada validada y el número asignado. */
function invoiceFormDataFor(input: EmitInvoiceInput, documentNumber: string, currency: string): InvoiceFormData {
  const blank = {
    title: "Factura",
    businessLogo: null,
    date: input.documentDate,
    dueDate: input.dueDate ?? "",
    currency,
    companyDetails: "",
    companyDetailsLabel: "De",
    billTo: input.customerName ?? "",
    billToLabel: "Para",
    taxIncluded: false,
    additionalTaxes: [],
    additionalFees: [],
    notes: input.notes ?? "",
    bankDetails: "",
    issueDateLabel: "Fecha de emisión",
    dueDateLabel: "Vencimiento",
    itemLabel: "Concepto",
    quantityLabel: "Cantidad",
    unitPriceLabel: "Precio unitario",
    subtotalLabel: "Subtotal",
    summarySubtotalLabel: "Base imponible",
    summaryTotalLabel: "Total",
  }
  return {
    ...blank,
    invoiceNumber: documentNumber,
    items: input.lines.map((line) => ({
      name: line.description,
      subtitle: "",
      showSubtitle: false,
      quantity: line.quantityMilli / QUANTITY_SCALE,
      unitPrice: line.unitPriceCents / 100,
      subtotal: lineBaseCents(line.quantityMilli, line.unitPriceCents) / 100,
    })),
  }
}

/** Renderiza el PDF, lo guarda con su `sha256` y lo engancha a la operación. */
async function attachInvoicePdf(
  db: TenantClient,
  org: Organization,
  userId: string,
  transactionId: string,
  formData: InvoiceFormData
): Promise<string> {
  const pdfBuffer = await generateInvoicePDF(formData)
  if (!isEnoughStorageToUploadFile(org, pdfBuffer.length)) {
    throw new Error("Insufficient storage to save invoice PDF")
  }

  const transaction = await getTransactionById(db, transactionId)
  if (!transaction) throw new Error("La operación de la factura no existe en esta organización")

  const fileUuid = randomUUID()
  const fileName = `factura-${formData.invoiceNumber}.pdf`
  const relativeFilePath = getTransactionFileUploadPath(fileUuid, fileName, transaction)
  const fullFilePath = safePathJoin(getOrganizationUploadsDirectory(org), relativeFilePath)

  await mkdir(path.dirname(fullFilePath), { recursive: true })
  await writeFile(fullFilePath, pdfBuffer)

  const fileRecord = await createFile(db, {
    id: fileUuid,
    organizationId: org.id,
    uploadedById: userId,
    filename: fileName,
    path: relativeFilePath,
    mimetype: "application/pdf",
    // G-11: el PDF que emitimos nosotros también entra en la cadena de sha.
    sha256: sha256OfBuffer(pdfBuffer),
    sizeBytes: pdfBuffer.length,
    isReviewed: true,
    metadata: { size: pdfBuffer.length, source: "invoice", documentNumber: formData.invoiceNumber },
  })

  await updateTransactionFiles(db, transactionId, [fileRecord.id])
  await syncOrganizationStorage(org.id)
  return fileRecord.id
}

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
      // E8 · T4 (G-11): también el PDF que emitimos nosotros tiene su sha.
      sha256: sha256OfBuffer(pdfBuffer),
      sizeBytes: pdfBuffer.length,
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
