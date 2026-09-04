"use server"

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { getUserUploadsDirectory, safePathJoin } from "@/lib/files"
import { syncOrganizationStorage } from "@/lib/uploads"
import { cleanupOrganizationTables, MODEL_BACKUP, modelFromJSON } from "@/models/backups"
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCIES, DEFAULT_FIELDS, DEFAULT_SETTINGS } from "@/models/defaults"
import fs from "fs/promises"
import JSZip from "jszip"
import path from "path"
import { redirect } from "next/navigation"

const SUPPORTED_BACKUP_VERSIONS = ["1.0"]
const REMOVE_EXISTING_DATA = true
const MAX_BACKUP_SIZE = 256 * 1024 * 1024 // 256MB

type BackupRestoreResult = {
  counters: Record<string, number>
}

/** Backup = volcado íntegro del tenant → ADMIN. */
export async function restoreBackupAction(
  _prevState: ActionState<BackupRestoreResult> | null,
  formData: FormData
): Promise<ActionState<BackupRestoreResult>> {
  const { db, org, user } = await requireOrg("ADMIN")
  const userUploadsDirectory = getUserUploadsDirectory(user)
  const file = formData.get("file") as File

  if (!file || file.size === 0) {
    return { success: false, error: "No file provided" }
  }

  if (file.size > MAX_BACKUP_SIZE) {
    return { success: false, error: `Backup file too large. Maximum size is ${MAX_BACKUP_SIZE / 1024 / 1024}MB` }
  }

  // Read zip archive
  let zip: JSZip
  try {
    const fileBuffer = await file.arrayBuffer()
    const fileData = Buffer.from(fileBuffer)
    zip = await JSZip.loadAsync(fileData)
  } catch (error) {
    return { success: false, error: "Bad zip archive: " + (error as Error).message }
  }

  // Check metadata and start restoring
  try {
    const metadataFile = zip.file("data/metadata.json")
    if (metadataFile) {
      const metadataContent = await metadataFile.async("string")
      try {
        const metadata = JSON.parse(metadataContent)
        if (!metadata.version || !SUPPORTED_BACKUP_VERSIONS.includes(metadata.version)) {
          return {
            success: false,
            error: `Incompatible backup version: ${
              metadata.version || "unknown"
            }. Supported versions: ${SUPPORTED_BACKUP_VERSIONS.join(", ")}`,
          }
        }
        console.log(`Restoring backup version ${metadata.version} created at ${metadata.timestamp}`)
      } catch (error) {
        console.warn("Could not parse backup metadata:", error)
      }
    } else {
      console.warn("No metadata found in backup, assuming legacy format")
    }

    // Remove existing data (sólo de esta organización: tenantDb acota el deleteMany)
    if (REMOVE_EXISTING_DATA) {
      await cleanupOrganizationTables(db)
      await fs.rm(userUploadsDirectory, { recursive: true, force: true })
    }

    const counters: Record<string, number> = {}

    // Restore tables
    for (const backup of MODEL_BACKUP) {
      try {
        const jsonFile = zip.file(`data/${backup.filename}`)
        if (jsonFile) {
          const jsonContent = await jsonFile.async("string")
          const restoredCount = await modelFromJSON(db, backup, jsonContent)
          console.log(`Restored ${restoredCount} records from ${backup.filename}`)
          counters[backup.filename] = restoredCount
        }
      } catch (error) {
        console.error(`Error restoring model from ${backup.filename}:`, error)
      }
    }

    // Restore files
    try {
      let restoredFilesCount = 0
      const files = await db.file.findMany()

      for (const file of files) {
        const filePathWithoutPrefix = path.normalize(file.path.replace(/^.*\/uploads\//, ""))
        const zipFilePath = path.join("data/uploads", filePathWithoutPrefix)
        const zipFile = zip.file(zipFilePath)
        if (!zipFile) {
          console.log(`File ${file.path} not found in backup`)
          continue
        }

        const fileContents = await zipFile.async("nodebuffer")
        const fullFilePath = safePathJoin(userUploadsDirectory, filePathWithoutPrefix)
        if (!fullFilePath.startsWith(path.normalize(userUploadsDirectory))) {
          console.error(`Attempted path traversal detected for file ${file.path}`)
          continue
        }

        try {
          await fs.mkdir(path.dirname(fullFilePath), { recursive: true })
          await fs.writeFile(fullFilePath, fileContents)
          restoredFilesCount++
        } catch (error) {
          console.error(`Error writing file ${fullFilePath}:`, error)
          continue
        }

        await db.file.update({
          where: { id: file.id },
          data: {
            path: filePathWithoutPrefix,
          },
        })
      }
      counters["Uploaded attachments"] = restoredFilesCount
    } catch (error) {
      console.error("Error restoring uploaded files:", error)
      return {
        success: false,
        error: `Error restoring uploaded files: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    await syncOrganizationStorage(org.id)

    return { success: true, data: { counters } }
  } catch (error) {
    console.error("Error restoring from backup:", error)
    return {
      success: false,
      error: `Error restoring from backup: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function resetLLMSettingsAction() {
  const { db } = await requireOrg("ADMIN")
  const organizationId = db.$organizationId
  const llmSettings = DEFAULT_SETTINGS.filter((setting) => setting.code === "prompt_analyse_new_file")

  for (const setting of llmSettings) {
    await db.setting.upsert({
      where: { organizationId_code: { organizationId, code: setting.code } },
      update: { value: setting.value },
      create: { ...setting, organizationId },
    })
  }

  redirect("/settings/backups")
}

export async function resetFieldsAndCategoriesAction() {
  const { db } = await requireOrg("ADMIN")
  const organizationId = db.$organizationId

  for (const category of DEFAULT_CATEGORIES) {
    await db.category.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name, color: category.color, llm_prompt: category.llm_prompt, createdAt: new Date() },
      create: { ...category, organizationId, createdAt: new Date() },
    })
  }
  await db.category.deleteMany({
    where: { code: { notIn: DEFAULT_CATEGORIES.map((category) => category.code) } },
  })

  for (const currency of DEFAULT_CURRENCIES) {
    await db.currency.upsert({
      where: { organizationId_code: { organizationId, code: currency.code } },
      update: { name: currency.name },
      create: { ...currency, organizationId },
    })
  }
  await db.currency.deleteMany({
    where: { code: { notIn: DEFAULT_CURRENCIES.map((currency) => currency.code) } },
  })

  for (const field of DEFAULT_FIELDS) {
    await db.field.upsert({
      where: { organizationId_code: { organizationId, code: field.code } },
      update: {
        name: field.name,
        type: field.type,
        llm_prompt: field.llm_prompt,
        createdAt: new Date(),
        isVisibleInList: field.isVisibleInList,
        isVisibleInAnalysis: field.isVisibleInAnalysis,
        isRequired: field.isRequired,
        isExtra: field.isExtra,
      },
      create: { ...field, organizationId, createdAt: new Date() },
    })
  }
  await db.field.deleteMany({
    where: { code: { notIn: DEFAULT_FIELDS.map((field) => field.code) } },
  })

  redirect("/settings/backups")
}
