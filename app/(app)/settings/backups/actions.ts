"use server"

/**
 * E11 · ola C · **T22** — las acciones de `/settings/backups`, **reescritas**.
 *
 * Lo que desaparece y por qué: la acción heredada de TaxHacker
 * (`restoreBackupAction`) restauraba **encima de la organización actual** tras
 * llamar a `cleanupOrganizationTables`, es decir, **borraba asientos
 * contabilizados** y luego metía otros en su sitio. Eso es imposible de defender
 * ante el append-only de ADR-0003 y ante el art. 30 CCom, y el criterio 35 de
 * E11 lo dice sin rodeos: *no existe ningún camino que restaure encima de una
 * organización con datos*. La restauración va **siempre a una organización
 * nueva**; la actual no se toca.
 *
 * Lo que queda: pedir una copia, y los dos «restablecer a valores por defecto»
 * heredados, que sólo tocan catálogos (categorías, campos, monedas, prompt) y
 * ningún asiento.
 *
 * **Dependencia declarada (ola B).** El volcado en *streaming* (T8), la
 * restauración con las seis comprobaciones (T9) y la descarga por URL firmada
 * viven en `models/backups.ts` y `lib/storage/`, que son de la ola B. Esta
 * pantalla **encola** el trabajo y **enseña** su estado, que es lo que le toca:
 * el `backup-worker` del reloj (T16) lo avanza. Mientras la ola B no haya
 * aterrizado, `startRestoreAction` se niega explicando por qué, en vez de
 * fingir que restaura.
 */

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { recordAuditLog } from "@/models/audit-log"
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCIES, DEFAULT_FIELDS, DEFAULT_SETTINGS } from "@/models/defaults"
import { BackupTrigger, Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

const BACKUPS_PATH = "/settings/backups"

/** Versión del formato del ZIP (§5). La escribe quien vuelca; aquí se declara. */
const BACKUP_FORMAT_VERSION = "2.0"

export type RequestBackupResult = { backupJobId: string; trigger: string }

/**
 * Encola una copia de seguridad.
 *
 * **Permitida en `READ_ONLY` y SIN CUOTA cuando el trigger es `EXIT`** (D5 +
 * O-4): la portabilidad de sus propios datos no la puede desactivar un precio.
 * El guardián de cuotas de la ola B es quien lo aplica; aquí se declara el
 * trigger correcto para que pueda hacerlo.
 */
export async function requestBackupAction(kind: "MANUAL" | "EXIT" = "MANUAL"): Promise<ActionState<RequestBackupResult>> {
  const { db, org, user } = await requireOrg(Role.ADMIN)

  const trigger = kind === "EXIT" ? BackupTrigger.EXIT : BackupTrigger.MANUAL

  // Una sola copia viva por organización: encolar otra mientras la anterior
  // corre no produce dos ZIP, produce dos volcados compitiendo por la misma
  // transacción larga.
  const inFlight = await db.backupJob.findFirst({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  })
  if (inFlight) {
    return { success: false, error: "Ya hay una copia de seguridad en curso. Espera a que termine." }
  }

  const expiresAt = new Date(Date.now() + org.backupRetentionDays * 24 * 60 * 60 * 1000)
  const job = await db.backupJob.create({
    data: {
      organizationId: org.id,
      status: "QUEUED",
      trigger,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: "e11",
      gitSha: (process.env.GIT_SHA ?? "desconocido").slice(0, 40),
      requestedById: user.id,
      expiresAt,
    },
  })

  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "REQUEST_BACKUP",
    after: { backupJobId: job.id, trigger, expiresAt: expiresAt.toISOString() },
    userId: user.id,
  })

  revalidatePath(BACKUPS_PATH)
  return { success: true, data: { backupJobId: job.id, trigger } }
}

/**
 * **La restauración crea una organización nueva; la actual no se toca.**
 *
 * El motor de restauración y sus **seis comprobaciones** (§5.4) son de la ola B
 * (T9). Hasta que aterricen, esta acción **no restaura**: lo dice. Una pantalla
 * que fingiera restaurar y dejara la organización a medias sería peor que no
 * tener el botón — y `DONE_UNVERIFIED` es FAIL, no «casi bien».
 */
export async function startRestoreAction(formData: FormData): Promise<ActionState<{ restoreJobId: string }>> {
  const { org, user } = await requireOrg(Role.ADMIN)

  const reason = String(formData.get("reason") ?? "").trim()
  if (reason.length < 8) {
    return { success: false, error: "Escribe el motivo de la restauración: queda en el registro de auditoría." }
  }

  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "REQUEST_RESTORE",
    reason,
    after: { requested: true, target: "organización nueva" },
    userId: user.id,
  })

  return {
    success: false,
    error:
      "La restauración a una organización nueva todavía no está disponible en esta instalación: el motor que la " +
      "verifica (las seis comprobaciones de §5.4) se despliega con el resto de la épica. Tu petición y su motivo han " +
      "quedado registrados. Mientras tanto puedes descargar el archivo completo de tus datos.",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Restablecer catálogos — heredado, y sólo toca catálogos
// ─────────────────────────────────────────────────────────────────────────────

export async function resetLLMSettingsAction() {
  const { db } = await requireOrg(Role.ADMIN)
  const organizationId = db.$organizationId
  const llmSettings = DEFAULT_SETTINGS.filter((setting) => setting.code === "prompt_analyse_new_file")

  for (const setting of llmSettings) {
    await db.setting.upsert({
      where: { organizationId_code: { organizationId, code: setting.code } },
      update: { value: setting.value },
      create: { ...setting, organizationId },
    })
  }

  redirect(BACKUPS_PATH)
}

export async function resetFieldsAndCategoriesAction() {
  const { db } = await requireOrg(Role.ADMIN)
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

  redirect(BACKUPS_PATH)
}
