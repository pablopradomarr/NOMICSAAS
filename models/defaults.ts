import { TenantClient, tenantTransaction } from "@/lib/db"
import type { PgcVariant } from "@/prisma/client"
import { importNpgc } from "@/models/accounts"
import { defaultBusinessLineId, seedAnalyticsDefaults } from "@/models/analytics"
import { DefaultDeductibility } from "@/prisma/client"
import {
  CATEGORIES_REQUIERE_DECISION,
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

/**
 * Semilla de proyectos, categorías, monedas, campos y settings de UNA
 * organización. Desde E2 siembra además el plan contable NPGC, el mapa de
 * cuentas de sistema y los tipos impositivos (§4.3).
 */
export async function createOrganizationDefaults(
  db: TenantClient,
  opts: { pgcVariant?: PgcVariant; now?: Date; userId?: string | null } = {}
) {
  const organizationId = db.$organizationId

  // E4 (§2.8): la analítica se siembra ANTES que los proyectos, porque desde E4
  // `Project.businessLineId` es NOT NULL y el proyecto heredado «personal»
  // necesita una línea de negocio a la que colgarse (D-E4-1).
  await tenantTransaction(organizationId, opts.userId ?? undefined, async (tx) =>
    seedAnalyticsDefaults(tx, { userId: opts.userId ?? null })
  )
  const businessLineId = await defaultBusinessLineId(db)

  for (const project of DEFAULT_PROJECTS) {
    await db.project.upsert({
      where: { organizationId_code: { organizationId, code: project.code } },
      update: { name: project.name, color: project.color, llm_prompt: project.llm_prompt },
      create: { ...project, organizationId, businessLineId },
    })
  }

  for (const category of DEFAULT_CATEGORIES) {
    // E8 · T23 (O-17): la deducibilidad se siembra en el ALTA y no se pisa en el
    // `update` — si el usuario la ha cambiado, es una decisión suya.
    const defaultDeductibility = CATEGORIES_REQUIERE_DECISION.includes(category.code)
      ? DefaultDeductibility.REQUIERE_DECISION
      : DefaultDeductibility.FULL
    await db.category.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name, color: category.color, llm_prompt: category.llm_prompt },
      create: { ...category, organizationId, defaultDeductibility },
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

  // E2 (§4.3) — plan de cuentas, mapa de sistema y tipos impositivos.
  // `importNpgc` es idempotente: repetir el alta no crea nada nuevo y NO pisa lo
  // que el ADMIN haya editado (`origin ≠ SEED`). La variante sale de la propia
  // organización si no se pasa: es su modelo de cuentas anuales.
  // La lectura va dentro de `tenantTransaction` para que corra con
  // `app.current_org` fijado: `Organization` no está en TENANT_MODELS y hoy la
  // salva la cláusula de escape de RLS, que E3 retira.
  const variant =
    opts.pgcVariant ??
    (await tenantTransaction(organizationId, async (tx) => tx.organization.findFirst({ where: { id: organizationId } })))
      ?.pgcVariant ??
    "PYMES"
  await importNpgc(organizationId, variant, {
    useSubaccounts: true,
    createSoftwareAccounts: false,
    actor: { userId: opts.userId ?? null },
    now: opts.now,
  })
}

export async function isDatabaseEmpty(db: TenantClient) {
  const fieldsCount = await db.field.count()
  return fieldsCount === 0
}
