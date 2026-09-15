"use server"

import { ActionState } from "@/lib/actions"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { isEnoughStorageToUploadFile } from "@/lib/files"
import { UploadValidationError, ingestUnsortedFile, syncOrganizationStorage } from "@/lib/uploads"
import { LimitExceededError, assertWithinLimit } from "@/models/platform-limits"
import { revalidatePath } from "next/cache"

/**
 * **E11 · T13 (§3.5, O-16).** Subir el justificante es `REGISTRO_DOCUMENTAL`, no
 * una escritura ordinaria: **se permite en mora**. La obligación de anotación en
 * el libro registro no se suspende porque nosotros no hayamos cobrado, y sin
 * bytes no hay `sha256` ni I-E8-2 que valga (art. 30 CCom, art. 165.Uno LIVA).
 * `maxStorageBytes` se aplica como cuota **blanda** mientras el acceso no sea
 * `FULL`: avisa, deja subir y deja un `PlatformAuditLog` de excepción
 * automática.
 */
export async function uploadFilesAction(formData: FormData): Promise<ActionState<null>> {
  const { db, org, user } = await requireOrg("EDITOR", { writeKind: "REGISTRO_DOCUMENTAL" })
  const files = formData.getAll("files") as File[]

  // Check limits
  const totalFileSize = files.reduce((acc, file) => acc + file.size, 0)
  if (!isEnoughStorageToUploadFile(org, totalFileSize)) {
    return { success: false, error: `Insufficient storage to upload these files` }
  }

  // **El guardián corre ANTES de cualquier escritura**: ni fila a medias ni
  // fichero huérfano. `delta` son los bytes que esta subida va a ocupar.
  try {
    await tenantTransaction(org.id, async (tx) => {
      await assertWithinLimit(tx, "maxStorageBytes", BigInt(totalFileSize), { refDate: new Date() })
    })
  } catch (error) {
    if (error instanceof LimitExceededError) return { success: false, error: error.message }
    throw error
  }

  if (isSubscriptionExpired(org)) {
    return {
      success: false,
      error: "Your subscription has expired, please upgrade your account or buy new subscription plan",
    }
  }

  // Process each file. E1-fix (#18): la validación de tipo y tamaño vive en
  // `ingestUnsortedFile` (lista blanca + magic bytes); si un fichero no pasa,
  // se aborta la subida entera y se devuelve el motivo al usuario.
  try {
    await Promise.all(
      files.map(async (file) => {
        if (!(file instanceof File)) {
          throw new UploadValidationError("Fichero no válido")
        }
        const arrayBuffer = await file.arrayBuffer()
        return await ingestUnsortedFile(
          { db, organization: org, user },
          {
            buffer: Buffer.from(arrayBuffer),
            filename: file.name,
            mimetype: file.type,
            metadata: { lastModified: file.lastModified },
          }
        )
      })
    )
  } catch (error) {
    await syncOrganizationStorage(org.id)
    if (error instanceof UploadValidationError) {
      return { success: false, error: error.message }
    }
    console.error("Failed to upload files:", error)
    return { success: false, error: "No se han podido subir los ficheros" }
  }

  await syncOrganizationStorage(org.id)

  revalidatePath("/unsorted")

  return { success: true, error: null }
}
