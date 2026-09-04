import { TenantClient } from "@/lib/db"
import { codeFromName } from "@/lib/utils"
import { formatDate } from "date-fns"
import { createCategory, getCategoryByCode } from "./categories"
import { createProject, getProjectByCode } from "./projects"
import { TransactionFilters } from "./transactions"

export type ExportFilters = TransactionFilters

export type ExportFields = string[]

/**
 * Los conversores reciben el cliente acotado a la organización (nunca un userId):
 * así categorías y proyectos referenciados en el CSV se resuelven dentro del tenant.
 */
export type ExportImportFieldSettings = {
  code: string
  type: string
  export?: (db: TenantClient, value: unknown) => Promise<unknown>
  import?: (db: TenantClient, value: unknown) => Promise<unknown>
}

export const EXPORT_AND_IMPORT_FIELD_MAP: Record<string, ExportImportFieldSettings> = {
  name: {
    code: "name",
    type: "string",
  },
  description: {
    code: "description",
    type: "string",
  },
  merchant: {
    code: "merchant",
    type: "string",
  },
  total: {
    code: "total",
    type: "number",
    export: async function (_db, value) {
      return (value as number) / 100
    },
    import: async function (_db, value) {
      const num = parseFloat(String(value))
      return isNaN(num) ? 0.0 : num * 100
    },
  },
  currencyCode: {
    code: "currencyCode",
    type: "string",
  },
  convertedTotal: {
    code: "convertedTotal",
    type: "number",
    export: async function (_db, value) {
      if (!value) {
        return null
      }
      return (value as number) / 100
    },
    import: async function (_db, value) {
      const num = parseFloat(String(value))
      return isNaN(num) ? 0.0 : num * 100
    },
  },
  convertedCurrencyCode: {
    code: "convertedCurrencyCode",
    type: "string",
  },
  type: {
    code: "type",
    type: "string",
    export: async function (_db, value) {
      return value ? String(value).toLowerCase() : ""
    },
    import: async function (_db, value) {
      return String(value).toLowerCase()
    },
  },
  note: {
    code: "note",
    type: "string",
  },
  categoryCode: {
    code: "categoryCode",
    type: "string",
    export: async function (db, value) {
      if (!value) {
        return null
      }
      const category = await getCategoryByCode(db, String(value))
      return category?.name
    },
    import: async function (db, value) {
      const category = await importCategory(db, String(value))
      return category?.code
    },
  },
  projectCode: {
    code: "projectCode",
    type: "string",
    export: async function (db, value) {
      if (!value) {
        return null
      }
      const project = await getProjectByCode(db, String(value))
      return project?.name
    },
    import: async function (db, value) {
      const project = await importProject(db, String(value))
      return project?.code
    },
  },
  issuedAt: {
    code: "issuedAt",
    type: "date",
    export: async function (_db, value) {
      const date = value as Date | null
      if (!date || isNaN(date.getTime())) {
        return null
      }

      try {
        return formatDate(date, "yyyy-MM-dd")
      } catch (_error) {
        return null
      }
    },
    import: async function (_db, value) {
      const raw = String(value)
      try {
        // Date-only strings parse as UTC midnight; append local time to avoid -1 day shift
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return new Date(raw + "T00:00:00")
        }
        return new Date(raw)
      } catch (_error) {
        return null
      }
    },
  },
}

/**
 * G-08 (docs/AUDITORIA-FIABILIDAD.md): la búsqueda del proyecto existente NO
 * llevaba filtro de propietario, así que un import de CSV podía engancharse al
 * proyecto de OTRO usuario. Con `tenantDb` el filtro por organización se inyecta
 * y el bug desaparece por construcción.
 */
export const importProject = async (db: TenantClient, name: string) => {
  const code = codeFromName(name)

  const existingProject = await db.project.findFirst({
    where: {
      OR: [{ code }, { name }],
    },
  })

  if (existingProject) {
    return existingProject
  }

  return await createProject(db, { code, name })
}

/** Ídem G-08 para categorías. */
export const importCategory = async (db: TenantClient, name: string) => {
  const code = codeFromName(name)

  const existingCategory = await db.category.findFirst({
    where: {
      OR: [{ code }, { name }],
    },
  })

  if (existingCategory) {
    return existingCategory
  }

  return await createCategory(db, { code, name })
}
