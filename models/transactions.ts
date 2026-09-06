import { TenantClient } from "@/lib/db"
import { Field, Prisma, Transaction } from "@/prisma/client"
import { cache } from "react"
import { getFields } from "./fields"
import { deleteFile } from "./files"

export type TransactionData = {
  name?: string | null
  description?: string | null
  merchant?: string | null
  total?: number | null
  currencyCode?: string | null
  convertedTotal?: number | null
  convertedCurrencyCode?: string | null
  type?: string | null
  items?: TransactionData[] | undefined
  note?: string | null
  files?: string[] | undefined
  extra?: Record<string, unknown>
  categoryCode?: string | null
  projectCode?: string | null
  issuedAt?: Date | string | null
  text?: string | null
  [key: string]: unknown
}

export type TransactionFilters = {
  search?: string
  dateFrom?: string
  dateTo?: string
  ordering?: string
  categoryCode?: string
  projectCode?: string
  type?: string
  page?: number
}

export type TransactionPagination = {
  limit: number
  offset: number
}

export const getTransactions = cache(
  async (
    db: TenantClient,
    filters?: TransactionFilters,
    pagination?: TransactionPagination
  ): Promise<{
    transactions: Transaction[]
    total: number
  }> => {
    const where: Prisma.TransactionWhereInput = {}
    let orderBy: Prisma.TransactionOrderByWithRelationInput = { issuedAt: "desc" }

    if (filters) {
      if (filters.search) {
        where.OR = [
          { name: { contains: filters.search, mode: "insensitive" } },
          { merchant: { contains: filters.search, mode: "insensitive" } },
          { description: { contains: filters.search, mode: "insensitive" } },
          { note: { contains: filters.search, mode: "insensitive" } },
          { text: { contains: filters.search, mode: "insensitive" } },
        ]
      }

      if (filters.dateFrom || filters.dateTo) {
        where.issuedAt = {
          gte: filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00.000Z`) : undefined,
          lte: filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999Z`) : undefined,
        }
      }

      if (filters.categoryCode) {
        where.categoryCode = filters.categoryCode
      }

      if (filters.projectCode) {
        where.projectCode = filters.projectCode
      }

      if (filters.type) {
        where.type = filters.type
      }

      if (filters.ordering) {
        const isDesc = filters.ordering.startsWith("-")
        const field = isDesc ? filters.ordering.slice(1) : filters.ordering
        orderBy = { [field]: isDesc ? "desc" : "asc" }
      }
    }

    if (pagination) {
      const total = await db.transaction.count({ where })
      const transactions = await db.transaction.findMany({
        where,
        include: {
          category: true,
          project: true,
        },
        orderBy,
        take: pagination?.limit,
        skip: pagination?.offset,
      })
      return { transactions, total }
    } else {
      const transactions = await db.transaction.findMany({
        where,
        include: {
          category: true,
          project: true,
        },
        orderBy,
      })
      return { transactions, total: transactions.length }
    }
  }
)

export const getTransactionById = cache(async (db: TenantClient, id: string): Promise<Transaction | null> => {
  return await db.transaction.findFirst({
    where: { id },
    include: {
      category: true,
      project: true,
    },
  })
})

export const getTransactionsByFileId = cache(async (db: TenantClient, fileId: string): Promise<Transaction[]> => {
  return await db.transaction.findMany({
    where: { files: { array_contains: [fileId] } },
  })
})

/**
 * E8 · T19 (cierre de G-19) — moneda por defecto de LA ORGANIZACIÓN.
 *
 * El código heredado asumía `"USD"` cuando la fila no traía moneda. En una
 * contabilidad en euros eso significaba que el dedupe comparaba contra una
 * moneda que no existe en la organización y **nunca encontraba el duplicado**:
 * el gasto entraba dos veces. La moneda por defecto se resuelve en un solo
 * sitio y sale de `Organization.baseCurrency`.
 */
export const defaultCurrencyCode = async (db: TenantClient): Promise<string> => {
  const organization = await db.organization.findFirst({ select: { baseCurrency: true } })
  return organization?.baseCurrency ?? "EUR"
}

// --- 1. New Dedicated Deduplication Function ---
export const findDuplicateTransaction = async (db: TenantClient, data: TransactionData) => {
  const { standard } = await splitTransactionDataExtraFields(data, db)
  const currencyCode = standard.currencyCode || (await defaultCurrencyCode(db))

  if (standard.total && standard.merchant && standard.issuedAt) {
    const existingTransaction = await db.transaction.findFirst({
      where: {
        total: standard.total,
        merchant: standard.merchant,
        issuedAt: standard.issuedAt,
        currencyCode: currencyCode,
      },
    })

    return existingTransaction
  }

  return null
}

export type DocumentKey = {
  /** NIF/CIF de la contraparte tal y como está en su ficha. */
  taxId: string | null | undefined
  documentNumber: string | null | undefined
  /** Ejercicio del documento (año natural de `documentDate`). */
  year: number | null | undefined
}

export type DocumentDuplicate = {
  entryId: string
  entryNumber: number
  documentDate: Date | null
  documentNumber: string
  counterpartyName: string
}

/**
 * E8 · T19 / I-E8-13 (G-11, O-19) — duplicado por `(taxId, nº de documento,
 * ejercicio)`.
 *
 * El `sha256` sólo caza el MISMO fichero; la factura reenviada en PDF y en foto,
 * o tecleada dos veces, pasa por debajo. La clave que un auditor usa para el
 * libro registro es ésta, y es el vector clásico del doble pago y de la doble
 * deducción.
 *
 * Devuelve los asientos que ya usan esa clave; el llamante decide. **El aviso no
 * bloquea**: hay casos legítimos (un split, una serie repetida entre ejercicios
 * mal cerrada), y forzarlo exige `AuditLog` con `FORCE_DUPLICATE` y motivo.
 */
export const findDuplicateDocuments = async (db: TenantClient, key: DocumentKey): Promise<DocumentDuplicate[]> => {
  const { taxId, documentNumber, year } = key
  if (!taxId || !documentNumber || !year) return []

  const counterparties = await db.counterparty.findMany({ where: { taxId }, select: { id: true, name: true } })
  if (counterparties.length === 0) return []
  const namesById = new Map(counterparties.map((c) => [c.id, c.name]))

  const entries = await db.journalEntry.findMany({
    where: {
      sourceId: documentNumber,
      documentDate: {
        gte: new Date(Date.UTC(year, 0, 1)),
        lte: new Date(Date.UTC(year, 11, 31)),
      },
      lines: { some: { counterpartyId: { in: [...namesById.keys()] } } },
    },
    select: { id: true, entryNumber: true, documentDate: true, lines: { select: { counterpartyId: true } } },
    orderBy: { entryNumber: "asc" },
  })

  return entries.map((entry) => {
    const counterpartyId = entry.lines.map((l) => l.counterpartyId).find((id) => id && namesById.has(id))
    return {
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      documentDate: entry.documentDate,
      documentNumber,
      counterpartyName: (counterpartyId && namesById.get(counterpartyId)) || "",
    }
  })
}

export const createTransaction = async (
  db: TenantClient,
  data: TransactionData,
  options: { createdById?: string | null } = {}
): Promise<Transaction> => {
  const { standard, extra } = await splitTransactionDataExtraFields(data, db)

  const newTransaction = await db.transaction.create({
    data: {
      ...standard,
      extra: extra,
      items: data.items as Prisma.InputJsonValue,
      createdById: options.createdById ?? null,
      organizationId: db.$organizationId,
    } as Prisma.TransactionUncheckedCreateInput,
  })

  return newTransaction
}

export const updateTransaction = async (
  db: TenantClient,
  id: string,
  data: TransactionData
): Promise<Transaction> => {
  const { standard, extra } = await splitTransactionDataExtraFields(data, db)

  return await db.transaction.update({
    where: { id },
    data: {
      ...standard,
      extra: extra,
      items: data.items ? (data.items as Prisma.InputJsonValue) : [],
    } as Prisma.TransactionUncheckedUpdateInput,
  })
}

export const updateTransactionFiles = async (
  db: TenantClient,
  id: string,
  files: string[]
): Promise<Transaction> => {
  return await db.transaction.update({
    where: { id },
    data: { files },
  })
}

export const deleteTransaction = async (
  db: TenantClient,
  id: string,
  uploadsDirectory: string
): Promise<Transaction | undefined> => {
  const transaction = await getTransactionById(db, id)

  if (transaction) {
    const files = Array.isArray(transaction.files) ? transaction.files : []

    for (const fileId of files as string[]) {
      if ((await getTransactionsByFileId(db, fileId)).length <= 1) {
        await deleteFile(db, fileId, uploadsDirectory)
      }
    }

    return await db.transaction.delete({
      where: { id },
    })
  }
}

export const bulkDeleteTransactions = async (db: TenantClient, ids: string[]) => {
  return await db.transaction.deleteMany({
    where: { id: { in: ids } },
  })
}

const splitTransactionDataExtraFields = async (
  data: TransactionData,
  db: TenantClient
): Promise<{ standard: TransactionData; extra: Prisma.InputJsonValue }> => {
  const fields = await getFields(db)
  const fieldMap = fields.reduce(
    (acc, field) => {
      acc[field.code] = field
      return acc
    },
    {} as Record<string, Field>
  )

  const standard: TransactionData = {}
  const extra: Record<string, unknown> = {}

  Object.entries(data).forEach(([key, value]) => {
    const fieldDef = fieldMap[key]
    if (fieldDef) {
      if (fieldDef.isExtra) {
        extra[key] = value
      } else {
        standard[key] = value
      }
    }
  })

  return { standard, extra: extra as Prisma.InputJsonValue }
}

/**
 * E6 · T18 (cierre de G-06) — documentos SIN asiento.
 *
 * El panel heredado los contaba como 0 y los sumaba en silencio: un gasto que
 * el OCR había leído pero que nadie había contabilizado desaparecía del total
 * sin dejar rastro. Aquí se **cuentan** y se declaran; no se suman a nada. La
 * leyenda que la UI pinta al lado es `UNPOSTED_DOCUMENTS_NOTE`.
 */
export const countUnpostedTransactions = async (db: TenantClient): Promise<number> =>
  await db.transaction.count({ where: { journalEntryId: null } })

export const UNPOSTED_DOCUMENTS_NOTE = (n: number): string =>
  `${n} documento(s) sin asiento: no entran en ninguna cifra de este panel.`
