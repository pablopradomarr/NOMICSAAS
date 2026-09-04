import { File, Organization, Transaction } from "@/prisma/client"
import { formatDate } from "date-fns"
import { access, constants, readdir, stat } from "fs/promises"
import path from "path"
import config from "./config"

export const FILE_UPLOAD_PATH = path.resolve(process.env.UPLOAD_PATH || "./uploads")
export const FILE_UNSORTED_DIRECTORY_NAME = "unsorted"
export const FILE_PREVIEWS_DIRECTORY_NAME = "previews"
export const FILE_STATIC_DIRECTORY_NAME = "static"
export const FILE_IMPORT_CSV_DIRECTORY_NAME = "csv"

/**
 * Referencia mínima a una organización para resolver rutas de disco.
 * E1-fix (#3): el sujeto del almacenamiento es la ORGANIZACIÓN, no el usuario.
 */
export type OrganizationRef = Pick<Organization, "id">

/**
 * Directorio raíz de una organización: `uploads/<organizationId>/…`.
 *
 * Antes de E1-fix la ruta se derivaba del email del usuario que hacía la
 * petición, de modo que otro miembro de la misma organización recibía 404 al
 * descargar un fichero subido por un compañero (hallazgo BLOQUEA-3). El
 * identificador es un uuid: no contiene separadores ni `..`, pero se compone
 * igualmente con `safePathJoin`.
 */
export function getOrganizationUploadsDirectory(organization: OrganizationRef) {
  return safePathJoin(FILE_UPLOAD_PATH, organization.id)
}

/** `uploads/<organizationId>/static` — logo de facturación y avatar (#5). */
export function getStaticDirectory(organization: OrganizationRef) {
  return safePathJoin(getOrganizationUploadsDirectory(organization), FILE_STATIC_DIRECTORY_NAME)
}

/** `uploads/<organizationId>/previews` — miniaturas y páginas de PDF. */
export function getOrganizationPreviewsDirectory(organization: OrganizationRef) {
  return safePathJoin(getOrganizationUploadsDirectory(organization), FILE_PREVIEWS_DIRECTORY_NAME)
}

export function unsortedFilePath(fileUuid: string, filename: string) {
  const fileExtension = path.extname(filename)
  return safePathJoin(FILE_UNSORTED_DIRECTORY_NAME, `${fileUuid}${fileExtension}`)
}

export function previewFilePath(fileUuid: string, page: number, extension = "webp") {
  return safePathJoin(FILE_PREVIEWS_DIRECTORY_NAME, `${fileUuid}.${page}.${extension}`)
}

export function getTransactionFileUploadPath(fileUuid: string, filename: string, transaction: Transaction) {
  const fileExtension = path.extname(filename)
  const storedFileName = `${fileUuid}${fileExtension}`
  return formatFilePath(storedFileName, transaction.issuedAt || new Date())
}

export function fullPathForFile(organization: OrganizationRef, file: File) {
  return safePathJoin(getOrganizationUploadsDirectory(organization), file.path)
}

export function getTransactionExportRelativeFolder(transaction: Transaction, totalFiles: number): string {
  return path.posix.join(
    transaction.issuedAt ? formatDate(transaction.issuedAt, "yyyy/MM") : "",
    totalFiles > 1 ? transaction.name || transaction.id : ""
  )
}

export function getTransactionExportFileName(transaction: Transaction, file: File): string {
  const ext = path.extname(file.path)
  const shortId = file.id.replace(/-/g, "").slice(0, 5)
  const baseName = `${formatDate(transaction.issuedAt || new Date(), "yyyy-MM-dd")} - ${transaction.name || transaction.id}`
  return `${baseName} ${shortId}${ext}`
}

export function getTransactionExportFilePath(transaction: Transaction, file: File, totalFiles: number): string {
  return path.posix.join(
    "files",
    getTransactionExportRelativeFolder(transaction, totalFiles),
    getTransactionExportFileName(transaction, file)
  )
}

function formatFilePath(filename: string, date: Date, format = "{YYYY}/{MM}/{name}{ext}") {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const ext = path.extname(filename)
  const name = path.basename(filename, ext)

  return format.replace("{YYYY}", String(year)).replace("{MM}", month).replace("{name}", name).replace("{ext}", ext)
}

export function safePathJoin(basePath: string, ...paths: string[]) {
  const joinedPath = path.join(basePath, path.normalize(path.join(...paths)))
  if (!joinedPath.startsWith(basePath)) {
    throw new Error("Path traversal detected")
  }
  return joinedPath
}

export async function fileExists(filePath: string) {
  try {
    await access(path.normalize(filePath), constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function getDirectorySize(directoryPath: string) {
  let totalSize = 0
  async function calculateSize(dir: string) {
    if (!(await fileExists(dir))) return
    const files = await readdir(dir, { withFileTypes: true })
    for (const file of files) {
      const fullPath = path.join(dir, file.name)
      if (file.isDirectory()) {
        await calculateSize(fullPath)
      } else if (file.isFile()) {
        const stats = await stat(fullPath)
        totalSize += stats.size
      }
    }
  }
  await calculateSize(directoryPath)
  return totalSize
}

/**
 * Consumo de disco de una organización = tamaño de SU directorio.
 *
 * E1-fix (#6): antes se sumaban los directorios (por email) de todos los
 * miembros, lo que contabilizaba en una organización ficheros que el usuario
 * había subido en OTRA organización de la que también era miembro.
 */
export async function getOrganizationStorageUsed(organization: OrganizationRef): Promise<number> {
  return await getDirectorySize(getOrganizationUploadsDirectory(organization))
}

/**
 * E1 (T11): la cuota de almacenamiento es de la ORGANIZACIÓN, y desde E1-fix
 * también lo es el directorio físico (`uploads/<organizationId>/…`).
 */
export function isEnoughStorageToUploadFile(organization: Organization, fileSize: number) {
  if (config.selfHosted.isEnabled || organization.storageLimit < 0) {
    return true
  }
  return organization.storageUsed + fileSize <= organization.storageLimit
}
