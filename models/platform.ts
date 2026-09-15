/**
 * E11 · ola A · T19 — `PlatformAuditLog` y el estado de salud de la instalación.
 *
 * `platform_audit_logs` es **append-only** (patrón de `audit_logs`, ADR-0008) y
 * **no tiene `organization_id` obligatorio**: un webhook cuyo cliente no resuelve
 * es justamente la fila que hay que poder ver. Por eso este fichero usa el
 * cliente sin acotar y está en la lista blanca de `eslint.config.mjs`.
 *
 * **§9.2 · PII.** Aquí van **id y tipo**, nunca el objeto de Stripe (lleva email,
 * dirección de facturación e importes). `sanitizeDetail` lo impone: recorta a
 * una lista blanca de claves y trunca los textos. No es cosmética — es la regla
 * de E1 #16 aplicada al sitio donde más fácil se filtra.
 */

import { prisma } from "@/lib/db"
import { CRON_JOB_SPECS, isStale, type CronJobName } from "@/lib/platform/cron"
import { lastRunsByJob } from "@/models/cron"
import type { Prisma } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// Auditoría de plataforma
// ─────────────────────────────────────────────────────────────────────────────

/** Acciones registradas. Lista cerrada: I-E11-4b busca aquí las excepciones. */
export const PLATFORM_ACTIONS = {
  WEBHOOK_RECEIVED: "webhook.received",
  WEBHOOK_DUPLICATE: "webhook.duplicate",
  WEBHOOK_UNHANDLED: "webhook.unhandled",
  WEBHOOK_ORPHAN: "webhook.orphan",
  WEBHOOK_SIGNATURE_INVALID: "webhook.signature_invalid",
  SUBSCRIPTION_TRANSITION: "subscription.transition",
  PLATFORM_INVOICE_ISSUED: "platform_invoice.issued",
  PLATFORM_INVOICE_RECTIFIED: "platform_invoice.rectified",
  CHECKOUT_STARTED: "checkout.started",
  PORTAL_OPENED: "portal.opened",
  CRON_STARTED: "cron.started",
  CRON_SKIPPED: "cron.skipped",
  CRON_FINISHED: "cron.finished",
  CRON_UNAUTHORIZED: "cron.unauthorized",
  /** §3.5 · la excepción de cuota blanda, que concede el propio motor (O-3). */
  SOFT_LIMIT_EXCEEDED: "limit.soft_exceeded",
} as const

export type PlatformAction = (typeof PLATFORM_ACTIONS)[keyof typeof PLATFORM_ACTIONS]

/**
 * Claves admitidas en `detail`. **Lista blanca**: lo que no está aquí no se
 * escribe. Ni `email`, ni `name`, ni `address`, ni `customer_email`, ni el
 * objeto `data.object` de Stripe.
 */
const DETAIL_ALLOWED_KEYS = new Set([
  "stripeEventId",
  "stripeEventType",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "stripeInvoiceId",
  "stripePriceId",
  "planCode",
  "statusBefore",
  "statusAfter",
  "job",
  "periodKey",
  "refDate",
  "processed",
  "failed",
  "durationMs",
  "reason",
  "fullNumber",
  "seriesCode",
  "taxTreatment",
  "customerCountry",
  "ivaPeriod",
  "limitKey",
  "current",
  "limit",
])

const MAX_TEXT = 256

/** Recorta `detail` a la lista blanca y trunca los textos largos. */
export function sanitizeDetail(detail: Record<string, unknown>): Prisma.InputJsonObject {
  const salida: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(detail)) {
    if (!DETAIL_ALLOWED_KEYS.has(k)) continue
    if (v === null || v === undefined) {
      salida[k] = null
    } else if (typeof v === "number" || typeof v === "boolean") {
      salida[k] = v
    } else if (v instanceof Date) {
      salida[k] = v.toISOString()
    } else {
      salida[k] = String(v).slice(0, MAX_TEXT)
    }
  }
  return salida as Prisma.InputJsonObject
}

/**
 * Deja una línea en la auditoría de plataforma.
 *
 * **Nunca lanza.** Un fallo al auditar no puede tumbar un webhook que Stripe
 * reintentaría, ni abortar un cron a medias: se registra en el log del proceso y
 * se sigue. Lo que sí es inaceptable es *no intentarlo*, y por eso todos los
 * caminos de §7.3 pasan por aquí.
 */
export async function recordPlatformAudit(input: {
  actor: string
  action: PlatformAction
  organizationId?: string | null
  detail?: Record<string, unknown>
}): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actor: input.actor.slice(0, 64),
        action: input.action,
        organizationId: input.organizationId ?? null,
        detail: sanitizeDetail(input.detail ?? {}),
      },
    })
  } catch (e) {
    console.error("[platform-audit] no se pudo registrar la línea de auditoría:", (e as Error).message)
  }
}

export async function listPlatformAudit(opts: { organizationId?: string; limit?: number } = {}) {
  return await prisma.platformAuditLog.findMany({
    where: opts.organizationId ? { organizationId: opts.organizationId } : undefined,
    orderBy: { at: "desc" },
    take: opts.limit ?? 100,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Salud (§7.3) — `GET /api/health`, sin autenticación y **sin PII**
// ─────────────────────────────────────────────────────────────────────────────

export type HealthReport = {
  status: "ok" | "degraded" | "down"
  version: string
  gitSha: string
  db: { ok: boolean; latencyMs: number }
  cron: Array<{ job: string; lastRun: string | null; status: string | null; stale: boolean }>
  migrations: { applied: number; pending: number }
}

/**
 * Migraciones aplicadas y pendientes.
 *
 * «Pendiente» se lee de `_prisma_migrations`: una fila sin `finished_at` o con
 * `rolled_back_at` es una migración a medias, y eso es exactamente lo que hay
 * que ver antes de que alguien lo descubra por una columna que no existe
 * (criterio 54). Lo que este endpoint **no** puede saber es si hay migraciones
 * en el repositorio que aún no llegaron a la base: eso lo detecta el despliegue.
 */
async function migrationState(): Promise<{ applied: number; pending: number }> {
  const rows = await prisma.$queryRaw<{ applied: bigint; pending: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL)::bigint AS applied,
      count(*) FILTER (WHERE "finished_at" IS NULL OR  "rolled_back_at" IS NOT NULL)::bigint AS pending
    FROM "_prisma_migrations"
  `
  return { applied: Number(rows[0]?.applied ?? BigInt(0)), pending: Number(rows[0]?.pending ?? BigInt(0)) }
}

/**
 * El informe de salud. **Ni un nombre, ni un email, ni un NIF, ni un importe del
 * diario** (§7.3): el operador ve *cuánto*, no *qué*.
 *
 * `refDate` entra por parámetro incluso aquí, para que el test pueda fijar el
 * reloj y comprobar el `stale` sin esperar dos cadencias.
 */
export async function healthReport(opts: { version: string; gitSha: string; refDate: Date }): Promise<HealthReport> {
  let dbOk = true
  const t0 = Date.now()
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    dbOk = false
  }
  const latencyMs = Date.now() - t0

  let migrations = { applied: 0, pending: 0 }
  let cron: HealthReport["cron"] = []
  if (dbOk) {
    migrations = await migrationState()
    const ultimos = await lastRunsByJob()
    cron = (Object.keys(CRON_JOB_SPECS) as CronJobName[]).map((job) => {
      const last = ultimos[job] ?? null
      return {
        job,
        lastRun: last ? (last.finishedAt ?? last.startedAt).toISOString() : null,
        status: last?.status ?? null,
        stale: isStale(CRON_JOB_SPECS[job], last, opts.refDate),
      }
    })
  }

  // `pending > 0` ⇒ `degraded` (§7.3). Un cron parado también degrada: los
  // recurrentes no se generan solos si el reloj no llama.
  const status: HealthReport["status"] = !dbOk
    ? "down"
    : migrations.pending > 0 || cron.some((c) => c.stale)
      ? "degraded"
      : "ok"

  return { status, version: opts.version, gitSha: opts.gitSha, db: { ok: dbOk, latencyMs }, cron, migrations }
}
