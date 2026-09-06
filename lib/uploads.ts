import { File as PrismaFile, Organization, User } from "@/prisma/client"
import { TenantClient } from "@/lib/db"
import { createFile } from "@/models/files"
import { createHash, randomUUID } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import sharp from "sharp"
import config from "./config"
import {
  getOrganizationStorageUsed,
  getOrganizationUploadsDirectory,
  getStaticDirectory,
  isEnoughStorageToUploadFile,
  safePathJoin,
  unsortedFilePath,
} from "./files"
import { updateOrganization } from "@/models/organizations"

// ─────────────────────────────────────────────────────────────────────────────
// E1-fix (#18) — validación de subidas: lista blanca, límite de tamaño y
// detección del tipo real por magic bytes.
//
// `File.type` lo elige el navegador (o el atacante): no es una comprobación de
// seguridad. Aquí se valida el CONTENIDO. Los formatos sin firma binaria
// estable (csv, txt, eml) se aceptan por extensión y se verifica que el buffer
// no empiece por una firma binaria conocida y prohibida.
// ─────────────────────────────────────────────────────────────────────────────

/** Límite por fichero individual (además de la cuota de la organización). */
export const MAX_UPLOAD_FILE_SIZE = 25 * 1024 * 1024

/** Lista blanca: extensión → mimetype canónico que se persiste. */
export const ALLOWED_UPLOAD_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  eml: "message/rfc822",
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UploadValidationError"
  }
}

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false
  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

/**
 * Tipo real del buffer por cabecera binaria. Devuelve la extensión canónica o
 * `null` si no reconoce ninguna firma (caso de los formatos de texto).
 * Puro: no toca disco ni reloj.
 */
export function sniffFileExtension(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return "pdf" // %PDF
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "jpg"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return "webp"
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = buffer.subarray(8, 12).toString("latin1")
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic"
  }
  // ZIP: xlsx (OOXML) y cualquier otro contenedor zip
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) return "xlsx"
  return null
}

/**
 * Un zip es xlsx sólo si contiene `[Content_Types].xml` (parte obligatoria de
 * OOXML). Ronda 2 (#11): sin esta comprobación, cualquier zip —un .docx, un
 * .jar, un zip con lo que sea— pasaba como hoja de cálculo por tener la firma
 * `PK\x03\x04`. El nombre de cada entrada viaja SIN comprimir en su cabecera
 * local, así que basta con buscarlo en el buffer.
 */
export function isOoxmlPackage(buffer: Buffer): boolean {
  return buffer.includes(Buffer.from("[Content_Types].xml", "latin1"))
}

/** Firmas binarias explícitamente prohibidas (ejecutables y scripts nativos). */
function isForbiddenBinary(buffer: Buffer): boolean {
  return (
    startsWith(buffer, [0x4d, 0x5a]) || // PE/EXE
    startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(buffer, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O fat / class
    startsWith(buffer, [0x23, 0x21]) // shebang
  )
}

/**
 * Valida un fichero subido y devuelve el mimetype canónico a persistir.
 * @throws UploadValidationError si excede el tamaño, la extensión no está en la
 * lista blanca o el contenido no corresponde a la extensión declarada.
 */
export function assertAcceptableUpload(filename: string, buffer: Buffer): string {
  if (buffer.length === 0) {
    throw new UploadValidationError(`El fichero ${filename} está vacío`)
  }
  if (buffer.length > MAX_UPLOAD_FILE_SIZE) {
    throw new UploadValidationError(
      `El fichero ${filename} supera el límite de ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024} MB por fichero`
    )
  }

  const extension = path.extname(filename).slice(1).toLowerCase()
  const declared = ALLOWED_UPLOAD_TYPES[extension]
  if (!declared) {
    throw new UploadValidationError(
      `Tipo de fichero no admitido: ${filename}. Admitidos: ${Object.keys(ALLOWED_UPLOAD_TYPES).join(", ")}`
    )
  }

  if (isForbiddenBinary(buffer)) {
    throw new UploadValidationError(`El contenido de ${filename} no corresponde a un documento`)
  }

  const sniffed = sniffFileExtension(buffer)
  if (sniffed === null) {
    // Formato sin firma: sólo se acepta si la extensión declarada es de texto.
    if (!["csv", "txt", "eml"].includes(extension)) {
      throw new UploadValidationError(`El contenido de ${filename} no corresponde a la extensión .${extension}`)
    }
    return declared
  }

  if (sniffed === "xlsx" && !isOoxmlPackage(buffer)) {
    throw new UploadValidationError(`${filename} es un archivo comprimido, no una hoja de cálculo xlsx`)
  }

  const sniffedMime = ALLOWED_UPLOAD_TYPES[sniffed]
  if (sniffedMime !== declared) {
    throw new UploadValidationError(
      `El contenido de ${filename} es de tipo ${sniffedMime} y no coincide con la extensión .${extension}`
    )
  }
  return declared
}

export async function uploadStaticImage(
  user: User,
  organization: Organization,
  file: File,
  saveFileName: string,
  maxWidth: number = config.upload.images.maxWidth,
  maxHeight: number = config.upload.images.maxHeight,
  quality: number = config.upload.images.quality
) {
  // E1-fix (#5): `static/` cuelga de la organización, no del email del usuario.
  const uploadDirectory = getStaticDirectory(organization)

  if (!isEnoughStorageToUploadFile(organization, file.size)) {
    throw Error("Not enough space to upload the file")
  }
  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    throw new UploadValidationError(
      `El fichero supera el límite de ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024} MB por fichero`
    )
  }

  await mkdir(uploadDirectory, { recursive: true })

  // Get target format from saveFileName extension
  const targetFormat = path.extname(saveFileName).slice(1).toLowerCase()
  if (!targetFormat) {
    throw Error("Target filename must have an extension")
  }

  // Convert image and save to static folder
  const uploadFilePath = safePathJoin(uploadDirectory, saveFileName)
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // El contenido debe ser realmente una imagen (magic bytes), no sólo decir serlo.
  const sniffed = sniffFileExtension(buffer)
  if (!sniffed || !["png", "jpg", "webp", "heic"].includes(sniffed)) {
    throw new UploadValidationError("El fichero subido no es una imagen válida")
  }

  const sharpInstance = sharp(buffer).rotate().resize(maxWidth, maxHeight, {
    fit: "inside",
    withoutEnlargement: true,
  })

  // Set output format and quality
  switch (targetFormat) {
    case "png":
      await sharpInstance.png().toFile(uploadFilePath)
      break
    case "jpg":
    case "jpeg":
      await sharpInstance.jpeg({ quality }).toFile(uploadFilePath)
      break
    case "webp":
      await sharpInstance.webp({ quality }).toFile(uploadFilePath)
      break
    case "avif":
      await sharpInstance.avif({ quality }).toFile(uploadFilePath)
      break
    default:
      throw Error(`Unsupported target format: ${targetFormat}`)
  }

  return uploadFilePath
}

/**
 * **E8 · T4 (G-11).** sha256 de los BYTES del fichero, en hexadecimal minúscula.
 *
 * Se calcula **al ingerir**, no después: es el eslabón que ata el asiento al
 * documento (I-E8-2), la clave con la que se detecta el duplicado antes de
 * pagarlo dos veces (I-E8-13) y lo que RC-10 contrasta contra el sha que vio la
 * extracción. Un fichero sin `sha256` no se analiza ni se contabiliza (I-E8-9),
 * y por eso la columna es `NOT NULL`: la alternativa —calcularlo «cuando haga
 * falta»— deja huecos que sólo se descubren auditando.
 *
 * Es IO por naturaleza (opera sobre los bytes), así que vive aquí y no en
 * `lib/extraction/hash.ts`, que es puro.
 */
export function sha256OfBuffer(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex")
}

export type UploadContext = {
  db: TenantClient
  organization: Organization
  user: User
}

export async function ingestUnsortedFile(
  ctx: UploadContext,
  input: { buffer: Buffer; filename: string; mimetype: string; metadata?: Record<string, unknown> }
): Promise<PrismaFile> {
  const { db, organization, user } = ctx
  if (!isEnoughStorageToUploadFile(organization, input.buffer.length)) {
    throw new Error("Not enough space to upload the file")
  }

  // E1-fix (#18): el mimetype que se persiste sale del CONTENIDO, no del cliente.
  const mimetype = assertAcceptableUpload(input.filename, input.buffer)

  const fileUuid = randomUUID()
  const relativeFilePath = unsortedFilePath(fileUuid, input.filename)
  const fullFilePath = safePathJoin(getOrganizationUploadsDirectory(organization), relativeFilePath)

  await mkdir(path.dirname(fullFilePath), { recursive: true })
  await writeFile(fullFilePath, input.buffer)

  return await createFile(db, {
    id: fileUuid,
    organizationId: organization.id,
    uploadedById: user.id,
    filename: input.filename,
    path: relativeFilePath,
    mimetype,
    sha256: sha256OfBuffer(input.buffer),
    sizeBytes: input.buffer.length,
    metadata: { size: input.buffer.length, ...input.metadata },
  })
}

/** Recalcula y persiste el consumo de disco de la organización (cuota T11). */
export async function syncOrganizationStorage(organizationId: string): Promise<number> {
  const storageUsed = await getOrganizationStorageUsed({ id: organizationId })
  await updateOrganization(organizationId, { storageUsed })
  return storageUsed
}
