"use server"

import { ActionState } from "@/lib/actions"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import { isEnoughStorageToUploadFile } from "@/lib/files"
import { ingestUnsortedFile, syncOrganizationStorage } from "@/lib/uploads"
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

  // Process each file
  await Promise.all(
    files.map(async (file) => {
      if (!(file instanceof File)) {
        return { success: false, error: "Invalid file" }
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

  await syncOrganizationStorage(org.id)

  revalidatePath("/unsorted")

  return { success: true, error: null }
}
