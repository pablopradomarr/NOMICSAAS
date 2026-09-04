"use server"

import { ActionState } from "@/lib/actions"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import { isEnoughStorageToUploadFile } from "@/lib/files"
import { UploadValidationError, ingestUnsortedFile, syncOrganizationStorage } from "@/lib/uploads"
import { revalidatePath } from "next/cache"

export async function uploadFilesAction(formData: FormData): Promise<ActionState<null>> {
  const { db, org, user } = await requireOrg("EDITOR")
  const files = formData.getAll("files") as File[]

  // Check limits
  const totalFileSize = files.reduce((acc, file) => acc + file.size, 0)
  if (!isEnoughStorageToUploadFile(org, totalFileSize)) {
    return { success: false, error: `Insufficient storage to upload these files` }
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
