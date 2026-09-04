import { TenantClient } from "@/lib/db"
import { FILE_UPLOAD_PATH, safePathJoin } from "@/lib/files"
import { Prisma } from "@/prisma/client"
import { unlink } from "fs/promises"
import path from "path"
import { cache } from "react"
import { getTransactionById } from "./transactions"

export const getUnsortedFiles = cache(async (db: TenantClient) => {
  return await db.file.findMany({
    where: { isReviewed: false },
    orderBy: { createdAt: "desc" },
  })
})

export const getUnsortedFilesCount = cache(async (db: TenantClient) => {
  return await db.file.count({
    where: { isReviewed: false },
  })
})

export const getFileById = cache(async (db: TenantClient, id: string) => {
  return await db.file.findFirst({
    where: { id },
  })
})

export const getFilesByTransactionId = cache(async (db: TenantClient, id: string) => {
  const transaction = await getTransactionById(db, id)
  if (transaction && transaction.files) {
    return await db.file.findMany({
      where: {
        id: { in: transaction.files as string[] },
      },
      orderBy: { createdAt: "asc" },
    })
  }
  return []
})

export const createFile = async (db: TenantClient, data: Prisma.FileUncheckedCreateInput) => {
  return await db.file.create({ data })
}

export const updateFile = async (db: TenantClient, id: string, data: Prisma.FileUncheckedUpdateInput) => {
  return await db.file.update({
    where: { id },
    data,
  })
}

/**
 * Borra el registro y su fichero físico. `uploadsDirectory` lo resuelve el
 * llamante (`getUserUploadsDirectory`), que es quien tiene el contexto de disco.
 */
export const deleteFile = async (db: TenantClient, id: string, uploadsDirectory: string) => {
  const file = await getFileById(db, id)
  if (!file) {
    return
  }

  // Security: ensure the resolved path stays within the upload directory
  const resolvedUploadPath = path.resolve(FILE_UPLOAD_PATH)
  const resolvedFilePath = path.resolve(resolvedUploadPath, file.path)

  if (!resolvedFilePath.startsWith(resolvedUploadPath + path.sep)) {
    console.error("Security: attempted path traversal in file delete", { filePath: file.path, resolvedFilePath })
    return
  }

  try {
    // Use safePathJoin to prevent path traversal attacks (issue #75).
    await unlink(safePathJoin(uploadsDirectory, file.path))
  } catch (error) {
    console.error("Error deleting file:", error)
  }

  return await db.file.delete({
    where: { id },
  })
}
