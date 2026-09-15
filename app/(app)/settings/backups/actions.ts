"use server"

/**
 * E11 · integración de las tres olas · **T22, cableada** — las acciones de
 * `/settings/backups`.
 *
 * ## Lo que esta ronda cierra
 *
 * La ola C dejó esta pantalla como **«puente temporal»**: `requestBackupAction`
 * insertaba la fila de `BackupJob` a mano —saltándose la cuota, que vive en
 * `models/backups.requestBackup`— y `startRestoreAction` **se negaba**, con un
 * mensaje que explicaba que el motor «se despliega con el resto de la épica».
 * El motor es de la ola B y aterrizó el mismo día. Aquí se conectan:
 * `requestBackup` (cuota y portabilidad de O-4), `runBackupJob` (ZIP firmado y
 * subido al almacén), `restoreBackupIntoOrganization` (siempre a organización
 * nueva) y `verifyRestore` (**las seis comprobaciones de §5.4**).
 *
 * ## Dos reglas que no cambian
 *
 * 1. **La restauración va SIEMPRE a una organización NUEVA** (ADR-0019 D2.4). La
 *    actual no se toca. El camino heredado —`cleanupOrganizationTables` y
 *    restaurar encima— se ha retirado del código, no sólo de la interfaz.
 * 2. **`DONE` exige `verified = true`** (O-2). Un resultado sin verificar es
 *    `DONE_UNVERIFIED`, la organización se **conserva y se marca**, y se
 *    enseñan las seis comprobaciones enfrentadas. Borrarla sería destruir la
 *    evidencia; llamarla `DONE` sería mentir.
 */

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { tenantTransaction } from "@/lib/db"
import { recordAuditLog } from "@/models/audit-log"
import {
  requestBackup,
  restoreBackupIntoOrganization,
  runBackupJob,
  signingKeyFromEnv,
} from "@/models/backups"
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCIES, DEFAULT_FIELDS, DEFAULT_SETTINGS } from "@/models/defaults"
import { createOrganizationWithOwner } from "@/models/organizations"
import { BackupTrigger, Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

const BACKUPS_PATH = "/settings/backups"

/** Tamaño máximo del ZIP que se admite subir por la interfaz. */
const MAX_RESTORE_ZIP_BYTES = 512 * 1024 * 1024

export type RequestBackupResult = { backupJobId: string; trigger: string; status: string; error: string | null }

/**
 * Encola una copia **y la ejecuta**.
 *
 * La cuota la aplica `requestBackup`, no esta acción: **una cuota cableada en la
 * interfaz es una cuota que la siguiente pantalla se olvida** (es la razón por la
 * que T13 la puso en el modelo). De ahí sale también O-4: el backup de salida
 * (`EXIT`) y cualquiera pedido fuera de `FULL` **no consumen** `maxBackupsMonth`.
 *
 * **Por qué se ejecuta en línea y no se deja al reloj.** `backup-worker` sigue
 * recogiendo lo que quede en `QUEUED` —un fallo de red, un despliegue a mitad—,
 * pero una pantalla que sólo encola obliga al usuario a esperar sin saber a qué:
 * el caso normal es un ZIP de unos megas y termina en la misma petición. Si
 * falla, la fila queda en `FAILED` **con el motivo escrito**, que es lo que el
 * CHECK `backup_jobs_done_is_complete` garantiza que no se pueda disfrazar.
 */
export async function requestBackupAction(kind: "MANUAL" | "EXIT" = "MANUAL"): Promise<ActionState<RequestBackupResult>> {
  const { db, org, user } = await requireOrg(Role.ADMIN)
  const trigger = kind === "EXIT" ? BackupTrigger.EXIT : BackupTrigger.MANUAL
  const refDate = new Date()

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

  if (!config.platform.signingKey) {
    return {
      success: false,
      error:
        "Esta instalación no tiene PLATFORM_SIGNING_KEY configurada: un backup sin firma no se emite, porque no " +
        "se podría demostrar que el archivo no se ha tocado. Configúrela y vuelva a intentarlo.",
    }
  }

  let job
  try {
    job = await requestBackup({
      organizationId: org.id,
      trigger,
      requestedById: user.id,
      refDate,
      retentionDays: org.backupRetentionDays,
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No se ha podido encolar la copia" }
  }

  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "REQUEST_BACKUP",
    after: { backupJobId: job.id, trigger, expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null },
    userId: user.id,
  })

  let status = "QUEUED"
  let error: string | null = null
  try {
    const done = await runBackupJob(org.id, job.id, refDate)
    status = String(done.status)
  } catch (e) {
    // La fila ya ha quedado en `FAILED` con su motivo: `runBackupJob` lo escribe
    // antes de relanzar. Aquí sólo se traduce a un mensaje en español.
    status = "FAILED"
    error = e instanceof Error ? e.message : "El volcado ha fallado"
  }

  revalidatePath(BACKUPS_PATH)
  return { success: true, data: { backupJobId: job.id, trigger, status, error } }
}

export type RestoreCheckResult = { key: string; label: string; ok: boolean; detail: string | null }

export type StartRestoreResult = {
  restoreJobId: string
  /** La organización NUEVA. La actual no se ha tocado. */
  organizationId: string
  organizationName: string
  status: string
  verified: boolean
  checks: RestoreCheckResult[]
}

/**
 * **Restaura el ZIP en una organización NUEVA** y deja las seis comprobaciones
 * a la vista.
 *
 * El orden es el de §5.4 y no es negociable: firma y manifest **antes de
 * descomprimir un byte**, tabla a tabla en orden de FK abortando a la primera
 * fila rechazada, las tasas de cambio referenciadas, los ficheros con su sha256,
 * las seis comprobaciones y sólo entonces `DONE` — o `DONE_UNVERIFIED`.
 *
 * La organización nueva nace **sin siembra**: lo que la llena es el ZIP, y
 * sembrar el plan de cuentas antes de restaurar haría fallar el recuento tabla a
 * tabla de la comprobación 1 con datos perfectamente buenos.
 */
export async function startRestoreAction(formData: FormData): Promise<ActionState<StartRestoreResult>> {
  const { org, user } = await requireOrg(Role.ADMIN)
  const refDate = new Date()

  const reason = String(formData.get("reason") ?? "").trim()
  if (reason.length < 8) {
    return { success: false, error: "Escribe el motivo de la restauración: queda en el registro de auditoría." }
  }

  const upload = formData.get("file")
  if (!(upload instanceof File) || upload.size === 0) {
    return { success: false, error: "Adjunta el archivo .zip de la copia que quieres restaurar." }
  }
  if (upload.size > MAX_RESTORE_ZIP_BYTES) {
    return {
      success: false,
      error: `El archivo supera el límite de ${MAX_RESTORE_ZIP_BYTES / 1024 / 1024} MB que admite esta pantalla.`,
    }
  }

  let keys: Map<string, Buffer>
  try {
    keys = restoreKeys()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "No hay clave de firma configurada" }
  }

  const archive = Buffer.from(await upload.arrayBuffer())

  // La organización de destino se crea ANTES de descomprimir: si el archivo no
  // sirve, la restauración falla con el destino vacío, que es exactamente el
  // estado que hay que poder enseñar (nunca se toca la de origen).
  const nombre = `${org.name} — restaurada ${refDate.toISOString().slice(0, 10)}`
  const destino = await createOrganizationWithOwner(
    { name: nombre, baseCurrency: org.baseCurrency, timezone: org.timezone, pgcVariant: org.pgcVariant },
    user.id,
    refDate
  )

  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "REQUEST_RESTORE",
    reason,
    after: { target: destino.id, targetName: destino.name },
    userId: user.id,
  })

  const outcome = await restoreBackupIntoOrganization({
    archive,
    targetOrganizationId: destino.id,
    requestedById: user.id,
    refDate,
    keys,
  })

  // `CheckResult` (§5.4) trae `id`, `status` y la evidencia enfrentada. La vista
  // enseña la comprobación y su veredicto; `INFO` **no es PASS** —«no evaluable»
  // no se pinta en verde— y por eso `ok` sólo es cierto con `PASS`.
  const checks: RestoreCheckResult[] = (outcome.verification?.checks ?? []).map((check) => ({
    key: check.id,
    label: check.title,
    ok: check.status === "PASS",
    detail:
      check.note ??
      (check.evidence
        .filter((row) => !row.ok)
        .map((row) => `${row.label}: se esperaba ${row.expected} y hay ${row.actual}`)
        .join(" · ") ||
        null),
  }))

  // El `RestoreJob` vive en la organización DESTINO: es la que acota su RLS
  // (`restore_jobs.organization_id`). Por eso la lista de esta pantalla enseña
  // las restauraciones HACIA esta organización, y el resultado de la que se
  // acaba de lanzar se devuelve a la vista.
  const restore = await tenantTransaction(destino.id, async (tx) =>
    tx.restoreJob.create({
      data: {
        organizationId: destino.id,
        status: outcome.status,
        progressBps: 10000,
        verification: outcome.verification ? JSON.parse(JSON.stringify(outcome.verification)) : undefined,
        verified: outcome.status === "DONE",
        rejected: outcome.rejected ? JSON.parse(JSON.stringify(outcome.rejected)) : undefined,
        error: outcome.error,
        requestedById: user.id,
        startedAt: refDate,
        finishedAt: new Date(),
      },
    })
  )

  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "RESTORE_FINISHED",
    reason,
    after: {
      restoreJobId: restore.id,
      target: destino.id,
      status: outcome.status,
      verified: outcome.status === "DONE",
      failed: checks.filter((c) => !c.ok).map((c) => c.key),
    },
    userId: user.id,
  })

  revalidatePath(BACKUPS_PATH)

  if (outcome.status === "FAILED") {
    return {
      success: false,
      error:
        `El archivo no se ha podido restaurar: ${outcome.error ?? "motivo desconocido"}. ` +
        (outcome.rejected
          ? `Fila rechazada en ${outcome.rejected.table}, línea ${outcome.rejected.line}: ${outcome.rejected.motivo}. `
          : "") +
        `La organización «${destino.name}» se conserva vacía como evidencia; la actual no se ha tocado.`,
    }
  }

  return {
    success: true,
    data: {
      restoreJobId: restore.id,
      organizationId: destino.id,
      organizationName: destino.name,
      status: outcome.status,
      verified: outcome.status === "DONE",
      checks,
    },
  }
}

/**
 * Las claves de firma admitidas al **verificar**: la vigente y la anterior.
 *
 * La rotación se admite en la lectura y **no** en la escritura: un ZIP firmado
 * con la clave que se acaba de retirar sigue siendo suyo y tiene que poder
 * restaurarse; uno nuevo se firma siempre con la vigente.
 */
function restoreKeys(): Map<string, Buffer> {
  const { key, keyId } = signingKeyFromEnv()
  const keys = new Map<string, Buffer>([[keyId, key]])
  const previous = config.platform.signingKeyPrevious
  if (previous) {
    // El `keyId` de la anterior no se guarda aparte: se admite bajo su propio
    // identificador convencional y bajo el vigente, para que rotar no exija
    // recordar dos variables.
    keys.set(`${keyId}-prev`, Buffer.from(previous, "utf8"))
    keys.set("k0", Buffer.from(previous, "utf8"))
  }
  return keys
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
