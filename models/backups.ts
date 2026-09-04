import { TenantClient } from "@/lib/db"

/**
 * Backup/restore por ORGANIZACIÓN (era por usuario). El volcado no incluye
 * `organization_id` ni la autoría: `tenantDb` los inyecta al restaurar, así que
 * un backup de una organización nunca puede reinsertarse en otra por accidente.
 */
type BackupRow = Record<string, unknown>

type BackupDelegate = {
  findMany: (args?: { where?: BackupRow }) => Promise<BackupRow[]>
  create: (args: { data: BackupRow }) => Promise<unknown>
  deleteMany: (args?: { where?: BackupRow }) => Promise<{ count: number }>
}

export type BackupSetting = {
  filename: string
  model: (db: TenantClient) => BackupDelegate
  backup: (row: BackupRow) => BackupRow
  restore: (json: BackupRow) => BackupRow
}

// Ordering is important here
export const MODEL_BACKUP: BackupSetting[] = [
  {
    filename: "settings.json",
    model: (db) => db.setting as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      value: row.value,
    }),
    restore: (json) => ({
      code: json.code,
      name: json.name,
      description: json.description,
      value: json.value,
    }),
  },
  {
    filename: "currencies.json",
    model: (db) => db.currency as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
    }),
    restore: (json) => ({
      code: json.code,
      name: json.name,
    }),
  },
  {
    filename: "categories.json",
    model: (db) => db.category as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      color: row.color,
      llm_prompt: row.llm_prompt,
      createdAt: row.createdAt,
    }),
    restore: (json) => ({
      code: json.code,
      name: json.name,
      color: json.color,
      llm_prompt: json.llm_prompt,
      createdAt: json.createdAt,
    }),
  },
  {
    filename: "projects.json",
    model: (db) => db.project as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      color: row.color,
      llm_prompt: row.llm_prompt,
      createdAt: row.createdAt,
    }),
    restore: (json) => ({
      code: json.code,
      name: json.name,
      color: json.color,
      llm_prompt: json.llm_prompt,
      createdAt: json.createdAt,
    }),
  },
  {
    filename: "fields.json",
    model: (db) => db.field as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      llm_prompt: row.llm_prompt,
      options: row.options,
      isVisibleInList: row.isVisibleInList,
      isVisibleInAnalysis: row.isVisibleInAnalysis,
      isRequired: row.isRequired,
      isExtra: row.isExtra,
    }),
    restore: (json) => ({
      code: json.code,
      name: json.name,
      type: json.type,
      llm_prompt: json.llm_prompt,
      options: json.options,
      isVisibleInList: json.isVisibleInList,
      isVisibleInAnalysis: json.isVisibleInAnalysis,
      isRequired: json.isRequired,
      isExtra: json.isExtra,
    }),
  },
  {
    filename: "files.json",
    model: (db) => db.file as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      filename: row.filename,
      path: row.path,
      metadata: row.metadata,
      isReviewed: row.isReviewed,
      mimetype: row.mimetype,
      createdAt: row.createdAt,
    }),
    restore: (json) => ({
      id: json.id,
      filename: json.filename,
      path: typeof json.path === "string" ? json.path.replace(/^.*\/uploads\//, "") : "",
      metadata: json.metadata,
      isReviewed: json.isReviewed,
      mimetype: json.mimetype,
    }),
  },
  {
    filename: "transactions.json",
    model: (db) => db.transaction as unknown as BackupDelegate,
    backup: (row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      merchant: row.merchant,
      total: row.total,
      currencyCode: row.currencyCode,
      convertedTotal: row.convertedTotal,
      convertedCurrencyCode: row.convertedCurrencyCode,
      type: row.type,
      note: row.note,
      files: row.files,
      extra: row.extra,
      categoryCode: row.categoryCode,
      projectCode: row.projectCode,
      issuedAt: row.issuedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      text: row.text,
    }),
    restore: (json) => ({
      id: json.id,
      name: json.name,
      description: json.description,
      merchant: json.merchant,
      total: json.total,
      currencyCode: json.currencyCode,
      convertedTotal: json.convertedTotal,
      convertedCurrencyCode: json.convertedCurrencyCode,
      type: json.type,
      note: json.note,
      files: json.files,
      extra: json.extra,
      issuedAt: json.issuedAt,
      // Escalares, no `connect`: la FK compuesta (code, organization_id) ya
      // garantiza que la categoría/proyecto sean de la misma organización.
      categoryCode: json.categoryCode ?? null,
      projectCode: json.projectCode ?? null,
    }),
  },
]

export async function modelToJSON(db: TenantClient, backupSettings: BackupSetting): Promise<string> {
  const data = await backupSettings.model(db).findMany()

  if (!data || data.length === 0) {
    return "[]"
  }

  return JSON.stringify(
    data.map((row) => backupSettings.backup(row)),
    null,
    2
  )
}

export async function modelFromJSON(
  db: TenantClient,
  backupSettings: BackupSetting,
  jsonContent: string
): Promise<number> {
  if (!jsonContent) return 0

  try {
    const records = JSON.parse(jsonContent) as BackupRow[]

    if (!records || records.length === 0) {
      return 0
    }

    let insertedCount = 0
    for (const rawRecord of records) {
      const record = preprocessRowData(rawRecord)

      try {
        const data = backupSettings.restore(record)
        await backupSettings.model(db).create({ data })
      } catch (error) {
        console.error(`Error importing record:`, error)
      }
      insertedCount++
    }

    return insertedCount
  } catch (error) {
    console.error(`Error parsing JSON content:`, error)
    return 0
  }
}

/** Vacía las tablas de negocio de la organización activa (orden inverso por FK). */
export async function cleanupOrganizationTables(db: TenantClient) {
  for (const { model } of [...MODEL_BACKUP].reverse()) {
    try {
      await model(db).deleteMany()
    } catch (error) {
      console.error(`Error clearing table:`, error)
    }
  }
}

function preprocessRowData(row: BackupRow): BackupRow {
  const processedRow: BackupRow = {}

  for (const [key, value] of Object.entries(row)) {
    if (value === "" || value === "null" || value === undefined) {
      processedRow[key] = null
      continue
    }

    // Try to parse JSON for object fields
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        processedRow[key] = JSON.parse(value)
        continue
      } catch (_e) {
        // Not valid JSON, continue with normal processing
      }
    }

    // Handle dates (checking for ISO date format)
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(value)) {
      processedRow[key] = new Date(value)
      continue
    }

    // Handle numbers
    if (typeof value === "string" && !isNaN(Number(value)) && key !== "id" && !key.endsWith("Code")) {
      // Convert numbers but preserving string IDs
      processedRow[key] = Number(value)
      continue
    }

    // Default: keep as is
    processedRow[key] = value
  }

  return processedRow
}
