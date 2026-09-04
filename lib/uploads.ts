import { File as PrismaFile, Organization, User } from "@/prisma/client"
import { TenantClient } from "@/lib/db"
import { createFile } from "@/models/files"
import { randomUUID } from "crypto"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import sharp from "sharp"
import config from "./config"
import {
  getOrganizationStorageUsed,
  getStaticDirectory,
  getUserUploadsDirectory,
  isEnoughStorageToUploadFile,
  safePathJoin,
  unsortedFilePath,
} from "./files"
import { listOrganizationMemberEmails } from "@/models/memberships"
import { updateOrganization } from "@/models/organizations"

export async function uploadStaticImage(
  user: User,
  organization: Organization,
  file: File,
  saveFileName: string,
  maxWidth: number = config.upload.images.maxWidth,
  maxHeight: number = config.upload.images.maxHeight,
  quality: number = config.upload.images.quality
) {
  const uploadDirectory = getStaticDirectory(user)

  if (!isEnoughStorageToUploadFile(organization, file.size)) {
    throw Error("Not enough space to upload the file")
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

  const fileUuid = randomUUID()
  const relativeFilePath = unsortedFilePath(fileUuid, input.filename)
  const fullFilePath = safePathJoin(getUserUploadsDirectory(user), relativeFilePath)

  await mkdir(path.dirname(fullFilePath), { recursive: true })
  await writeFile(fullFilePath, input.buffer)

  return await createFile(db, {
    id: fileUuid,
    organizationId: organization.id,
    uploadedById: user.id,
    filename: input.filename,
    path: relativeFilePath,
    mimetype: input.mimetype,
    metadata: { size: input.buffer.length, ...input.metadata },
  })
}

/** Recalcula y persiste el consumo de disco de la organización (cuota T11). */
export async function syncOrganizationStorage(organizationId: string): Promise<number> {
  const emails = await listOrganizationMemberEmails(organizationId)
  const storageUsed = await getOrganizationStorageUsed(emails)
  await updateOrganization(organizationId, { storageUsed })
  return storageUsed
}
