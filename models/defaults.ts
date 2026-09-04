import { TenantClient } from "@/lib/db"
import {
  DEFAULT_CATEGORIES,
  DEFAULT_CURRENCIES,
  DEFAULT_FIELDS,
  DEFAULT_PROJECTS,
  DEFAULT_SETTINGS,
} from "@/models/defaults-data"

export {
  DEFAULT_CATEGORIES,
  DEFAULT_CURRENCIES,
  DEFAULT_FIELDS,
  DEFAULT_PROMPT_ANALYSE_NEW_FILE,
  DEFAULT_PROJECTS,
  DEFAULT_SETTINGS,
} from "@/models/defaults-data"

/** Semilla de proyectos, categorías, monedas, campos y settings de UNA organización. */
export async function createOrganizationDefaults(db: TenantClient) {
  const organizationId = db.$organizationId

  for (const project of DEFAULT_PROJECTS) {
    await db.project.upsert({
      where: { organizationId_code: { organizationId, code: project.code } },
      update: { name: project.name, color: project.color, llm_prompt: project.llm_prompt },
      create: { ...project, organizationId },
    })
  }

  for (const category of DEFAULT_CATEGORIES) {
    await db.category.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name, color: category.color, llm_prompt: category.llm_prompt },
      create: { ...category, organizationId },
    })
  }

  for (const currency of DEFAULT_CURRENCIES) {
    await db.currency.upsert({
      where: { organizationId_code: { organizationId, code: currency.code } },
      update: { name: currency.name },
      create: { ...currency, organizationId },
    })
  }

  for (const field of DEFAULT_FIELDS) {
    await db.field.upsert({
      where: { organizationId_code: { organizationId, code: field.code } },
      update: {
        name: field.name,
        type: field.type,
        llm_prompt: field.llm_prompt,
        isVisibleInList: field.isVisibleInList,
        isVisibleInAnalysis: field.isVisibleInAnalysis,
        isRequired: field.isRequired,
        isExtra: field.isExtra,
      },
      create: { ...field, organizationId },
    })
  }

  for (const setting of DEFAULT_SETTINGS) {
    await db.setting.upsert({
      where: { organizationId_code: { organizationId, code: setting.code } },
      update: { name: setting.name, description: setting.description, value: setting.value },
      create: { ...setting, organizationId },
    })
  }
}

export async function isDatabaseEmpty(db: TenantClient) {
  const fieldsCount = await db.field.count()
  return fieldsCount === 0
}
