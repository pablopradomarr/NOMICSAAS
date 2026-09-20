import { File as PrismaFile, Organization, StoredObjectPurpose, User } from "@/prisma/client"
import { TenantClient } from "@/lib/db"
import { createFile, findFilesBySha256 } from "@/models/files"
import { createHash, randomUUID } from "crypto"
import path from "path"
import config from "./config"
import { unsortedFilePath } from "./files"
import { putObject } from "@/models/storage"

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

/**
 * **E12 · T15 (deuda 4)** — el logotipo de la organización y el avatar del
 * usuario van **al almacén**, no a `uploads/<org>/static/`.
 *
 * Eran los dos últimos ficheros que vivían sólo en disco, y en Vercel eso es
 * `/tmp`: el logotipo de una factura desaparecía en el despliegue siguiente. El
 * mismo hecho 4 de ADR-0019 que obligó a mover los documentos.
 *
 * Tres cosas cambian y ninguna es cosmética:
 *
 *  - **Se nombran por su `sha256`**, como todo lo demás en el almacén. El
 *    nombre que traía el cliente no entra nunca en una clave.
 *  - **`kind = BRANDING`**, que **no cuenta para la cuota** (O-12c). Cobrarle al
 *    cliente 40 KB por su propio logotipo es ruido en una cifra que tiene que
 *    ser creíble.
 *  - **`purpose`** dice si es logotipo o avatar, con un enumerado.
 *
 * Devuelve la URL con la que la interfaz lo pinta, que es lo único que el
 * llamante necesita: `/files/branding/<sha256>`.
 */
export async function uploadStaticImage(
  db: TenantClient,
  organization: Organization,
  file: File,
  purpose: StoredObjectPurpose,
  targetFormat: "png" | "jpg" | "jpeg" | "webp" | "avif",
  maxWidth: number = config.upload.images.maxWidth,
  maxHeight: number = config.upload.images.maxHeight,
  quality: number = config.upload.images.quality
): Promise<string> {
  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    throw new UploadValidationError(
      `El fichero supera el límite de ${MAX_UPLOAD_FILE_SIZE / 1024 / 1024} MB por fichero`
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // El contenido debe ser realmente una imagen (magic bytes), no sólo decir serlo.
  const sniffed = sniffFileExtension(buffer)
  if (!sniffed || !["png", "jpg", "webp", "heic"].includes(sniffed)) {
    throw new UploadValidationError("El fichero subido no es una imagen válida")
  }

  /**
   * **Ronda 1 de E8, revisor #5.** `sharp` carga un binario nativo y cuesta
   * ~2,3 s la primera vez. Importarlo arriba metía ese coste en el grafo de
   * CUALQUIER módulo que tocara `lib/uploads`. Se carga cuando de verdad hay una
   * imagen que redimensionar.
   */
  const { default: sharp } = await import("sharp")
  const sharpInstance = sharp(buffer).rotate().resize(maxWidth, maxHeight, {
    fit: "inside",
    withoutEnlargement: true,
  })

  let convertido: Buffer
  let mimeType: string
  switch (targetFormat) {
    case "png":
      convertido = await sharpInstance.png().toBuffer()
      mimeType = "image/png"
      break
    case "jpg":
    case "jpeg":
      convertido = await sharpInstance.jpeg({ quality }).toBuffer()
      mimeType = "image/jpeg"
      break
    case "webp":
      convertido = await sharpInstance.webp({ quality }).toBuffer()
      mimeType = "image/webp"
      break
    case "avif":
      convertido = await sharpInstance.avif({ quality }).toBuffer()
      mimeType = "image/avif"
      break
    default:
      throw new UploadValidationError(`Formato de destino no admitido: ${targetFormat}`)
  }

  const sha256 = sha256OfBuffer(convertido)
  await putObject(db, {
    organizationId: organization.id,
    kind: "BRANDING",
    purpose,
    sha256,
    mimeType,
    body: convertido,
  })
  return brandingUrl(sha256)
}

/** La URL con la que la interfaz pinta una imagen de marca. */
export function brandingUrl(sha256: string): string {
  return `/files/branding/${sha256}`
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

/**
 * E8 · T19 (G-11) — resultado de una ingesta con su aviso de duplicado.
 *
 * `duplicateOf` son los ficheros de la organización con los MISMOS bytes. Se
 * devuelve además del fichero creado, y **no** aborta la ingesta: el criterio de
 * duplicado lo aplica quien contabiliza (I-E8-13), no quien guarda bytes; un
 * adjunto legítimamente repetido no puede perderse en el camino de entrada.
 */
export type IngestResult = { file: PrismaFile; duplicateOf: PrismaFile[] }

/**
 * Ingesta con aviso de duplicado. `ingestUnsortedFile` la envuelve y devuelve
 * sólo el fichero, que es lo que espera el código heredado.
 */
export async function ingestUnsortedFileWithDedupe(
  ctx: UploadContext,
  input: { buffer: Buffer; filename: string; mimetype: string; metadata?: Record<string, unknown> }
): Promise<IngestResult> {
  const { db, organization, user } = ctx

  // E1-fix (#18): el mimetype que se persiste sale del CONTENIDO, no del cliente.
  // **Va PRIMERO**: un ejecutable disfrazado de PDF se rechaza por lo que es, no
  // por lo que ocupa, y el motivo que ve el usuario tiene que ser ése.
  const mimetype = assertAcceptableUpload(input.filename, input.buffer)

  /**
   * **E12 · T15 (deuda 3).** Aquí estaba `isEnoughStorageToUploadFile`, que leía
   * `organizations.storage_used` / `storage_limit` — el contador vivo que P2
   * prohíbe y que esta épica retira. La cuota de almacenamiento la pone
   * `assertWithinLimit(tx, "maxStorageBytes", …)` sobre la cifra DERIVADA, en la
   * misma transacción que la escritura, y es quien decide si es dura o blanda
   * según el nivel de acceso (O-16).
   *
   * Vive aquí y no en la server action **a propósito**: una cuota cableada en la
   * interfaz es una cuota que la pantalla siguiente se olvida de poner.
   */
  const { assertWithinLimit } = await import("@/models/platform-limits")
  await assertWithinLimit(db, "maxStorageBytes", BigInt(input.buffer.length), { refDate: new Date() })
  const sha256 = sha256OfBuffer(input.buffer)
  const duplicateOf = await findFilesBySha256(db, sha256)

  const fileUuid = randomUUID()
  const relativeFilePath = unsortedFilePath(fileUuid, input.filename)

  /**
   * **E11 · T7 (D-11, ADR-0019 D3) + integración de olas.** Los bytes van al
   * ALMACÉN y **sólo** al almacén, identificados por su `sha256`, y de ahí sale
   * el `StoredObject` que I-E11-6 comprueba. Hasta esta épica todo colgaba de
   * `FILE_UPLOAD_PATH`, que en Vercel es `/tmp`: efímero entre despliegues y no
   * compartido entre funciones, de modo que el `sha256 NOT NULL` de E8 vigilaba
   * unos bytes que el despliegue siguiente no tenía.
   *
   * **La doble escritura de T7 se retira aquí.** Era explícitamente transitoria
   * («mientras los lectores heredados no estén cableados al almacén»): los seis
   * lectores —descarga, vista previa, OCR, ZIP de exportación, volcado del
   * backup y las dos pantallas que comprueban si el papel sigue ahí— pasan hoy
   * por `lib/documents.ts`. Mantener la copia en disco a partir de ahora sería
   * pagar el doble de bytes por una réplica que nadie lee y que I-E11-6 no
   * vigila. Lo subido ANTES de la migración sigue en disco y lo sube
   * `scripts/migrate-uploads-to-storage.ts`, que es idempotente.
   *
   * `file.path` sobrevive como **etiqueta lógica** (en qué carpeta iría el
   * documento), no como localización: la localización es la clave del almacén.
   */
  await putObject(db, {
    organizationId: organization.id,
    kind: "DOCUMENT",
    sha256,
    mimeType: mimetype,
    body: input.buffer,
  })

  const file = await createFile(db, {
    id: fileUuid,
    organizationId: organization.id,
    uploadedById: user.id,
    filename: input.filename,
    path: relativeFilePath,
    mimetype,
    sha256,
    sizeBytes: input.buffer.length,
    metadata: {
      size: input.buffer.length,
      ...input.metadata,
      ...(duplicateOf.length > 0 ? { duplicateOfFileIds: duplicateOf.map((f) => f.id) } : {}),
    },
  })
  return { file, duplicateOf }
}

export async function ingestUnsortedFile(
  ctx: UploadContext,
  input: { buffer: Buffer; filename: string; mimetype: string; metadata?: Record<string, unknown> }
): Promise<PrismaFile> {
  return (await ingestUnsortedFileWithDedupe(ctx, input)).file
}

/**
 * **`syncOrganizationStorage` RETIRADA en E12 · T15 (deuda 3).**
 *
 * Recalculaba y persistía `organizations.storage_used`, que era el contador
 * vivo del mismo dato que `models/usage.ts` deriva de `stored_objects`: dos
 * cifras del mismo hecho, coincidiendo sólo mientras alguien se acordara de
 * llamar a esta función después de cada escritura. En doce sitios. La columna
 * ya no existe y la cifra es una: `computeUsage().storageBytes`.
 */
