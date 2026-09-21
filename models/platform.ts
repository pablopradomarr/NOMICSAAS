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

import { prisma, type TenantTransactionClient } from "@/lib/db"
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
  /**
   * **ADR-0019 D9** · el administrador de plataforma asigna otro plan a una
   * organización. En modo INTERNO no hay checkout ni portal, así que ésta es la
   * ÚNICA forma de cambiar de plan — y por eso no puede ocurrir sin traza.
   */
  PLAN_CHANGED: "plan.changed",
  /**
   * **E12 · ADR-0020 D1/D3** — las **cuatro** escrituras de operador de
   * `/admin`. Lista cerrada: no hay una quinta, y añadirla exige enmendar el
   * ADR. `I-E12-5` las busca aquí por `action LIKE 'admin.%'` y exige de cada
   * una motivo ≥ 20 caracteres, actor y confirmación por nombre.
   */
  ADMIN_RESET_ORG: "admin.reset_org",
  ADMIN_UNBLOCK: "admin.unblock",
  ADMIN_PLAN_CHANGED: "admin.plan_changed",
  ADMIN_PURGE_RETENTION: "admin.purge_retention",
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
  // E12 · ADR-0020 D3 — `detail` de una escritura de operador lleva SIEMPRE
  // `{ reason, confirmedName, before, after, affectedCounts }`. `reason` ya
  // estaba; las otras cuatro se añaden aquí, y las tres compuestas pasan por
  // `sanitizeNested` (sólo escalares, una capa, sin PII).
  "confirmedName",
  "before",
  "after",
  "affectedCounts",
  // Ronda 1 de E12: `reset-org` declara también lo que RETIENE —filas que una
  // tabla conservada por D2 señala y que por eso no se borran—, tabla a tabla.
  "retenidas",
  "kind",
  "targetKind",
  "targetId",
  "targetRef",
  "exceptionId",
  "expiresAt",
  "dryRun",
])

/**
 * Las tres claves de ADR-0020 D3 cuyo valor es un OBJETO y no un escalar: el
 * antes, el después y los recuentos por tabla. Se admiten **una sola capa** de
 * escalares — ni anidamiento, ni arrays de objetos, ni nada que pueda arrastrar
 * una fila de negocio entera al registro de plataforma.
 */
const DETAIL_OBJECT_KEYS = new Set(["before", "after", "affectedCounts", "retenidas"])

/** Máximo de claves dentro de un objeto de `detail`. Un recuento por tabla de
 * ochenta tablas cabe; un volcado de filas, no. */
const MAX_OBJECT_KEYS = 120

function sanitizeNested(value: unknown): Prisma.InputJsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null
  const out: Record<string, string | number | boolean | null> = {}
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n >= MAX_OBJECT_KEYS) break
    if (v === null || v === undefined) out[k] = null
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v
    else if (typeof v === "bigint") out[k] = v.toString()
    else if (v instanceof Date) out[k] = v.toISOString()
    else if (typeof v === "string") out[k] = v.slice(0, MAX_TEXT)
    else continue // objetos anidados y arrays: fuera, sin excepción
    n++
  }
  return out as Prisma.InputJsonObject
}

const MAX_TEXT = 256

/** Recorta `detail` a la lista blanca y trunca los textos largos. */
export function sanitizeDetail(detail: Record<string, unknown>): Prisma.InputJsonObject {
  const salida: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(detail)) {
    if (!DETAIL_ALLOWED_KEYS.has(k)) continue
    if (DETAIL_OBJECT_KEYS.has(k)) {
      const nested = sanitizeNested(v)
      if (nested !== null) (salida as Record<string, unknown>)[k] = nested
      continue
    }
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

/**
 * E12 · T13 — el registro de plataforma **de una organización**, leído con el
 * cliente ACOTADO.
 *
 * `listPlatformAudit` va por el cliente sin tenant y por eso no ve estas filas:
 * la política de `platform_audit_logs` es `organization_id IS NULL OR
 * organization_id = app.current_org()` (ronda 1 de E11, H-8), así que sin GUC
 * fijado devuelve **vacío en silencio** — el fallo que ADR-0009 avisa en cada
 * página de `CLAUDE.md`. La pantalla de `/admin/<id>` ya está dentro de la
 * transacción de esa organización: se lee desde ahí.
 */
export async function listPlatformAuditForOrganization(
  tx: Pick<TenantTransactionClient, "$queryRaw" | "$organizationId">,
  limit = 30
): Promise<{ id: string; at: Date; actor: string; action: string; reason: string | null }[]> {
  return await tx.$queryRaw<{ id: string; at: Date; actor: string; action: string; reason: string | null }[]>`
    SELECT "id", "at", "actor", "action", "detail" ->> 'reason' AS reason
      FROM "platform_audit_logs"
     WHERE "organization_id" = ${tx.$organizationId}::uuid
     ORDER BY "at" DESC
     LIMIT ${limit}
  `
}

/**
 * E12 · T13 — la línea de plataforma escrita **dentro de la transacción del
 * tenant**, y por SQL sin `RETURNING`.
 *
 * Dos razones, y las dos se pagaron en el e2e de `/admin` antes de encontrarlas:
 *
 *  1. **`RETURNING` exige SELECT sobre la fila nueva**, y la política de lectura
 *     de `platform_audit_logs` es `organization_id IS NULL OR = current_org()`
 *     (H-8 de E11). Sin GUC fijado, `prisma.create` insertaba y después no podía
 *     leer lo insertado: `new row violates row-level security policy`. Y como
 *     `recordPlatformAudit` **nunca lanza** —correcto para un webhook—, la línea
 *     se perdía **en silencio**. Una auditoría que se pierde en silencio es
 *     exactamente lo que ADR-0020 existe para impedir.
 *  2. **Atomicidad.** La escritura de operador y su registro viven o mueren
 *     juntos, como `writeAuditLog` con su mutación (ADR-0008).
 *
 * Aquí **sí lanza**: si no se puede registrar una escritura de operador, la
 * escritura no debe ocurrir.
 */
export async function recordPlatformAuditTx(
  tx: Pick<TenantTransactionClient, "$executeRaw" | "$organizationId">,
  input: { actor: string; action: PlatformAction; detail?: Record<string, unknown> }
): Promise<void> {
  const detail = sanitizeDetail(input.detail ?? {})
  await tx.$executeRaw`
    INSERT INTO "platform_audit_logs" ("id", "at", "actor", "action", "organization_id", "detail")
    VALUES (gen_random_uuid(), now(), ${input.actor.slice(0, 64)}, ${input.action},
            ${tx.$organizationId}::uuid, ${JSON.stringify(detail)}::jsonb)
  `
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

// ─────────────────────────────────────────────────────────────────────────────
// E12 · T13 — el inventario que ve el operador en `/admin` (ADR-0020 §5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una organización vista **desde la plataforma**: plan, uso grueso, sello del
 * último barrido y excepciones vivas.
 *
 * `§9.2 · PII`: aquí NO va un email, ni un NIF, ni una cifra del diario. El
 * operador ve **cuánto**, no **qué** — la misma regla que gobierna `/api/health`.
 * El nombre de la organización sí va, y tiene que ir: es lo que D4 obliga a
 * teclear para confirmar.
 */
export type OperatorOrganizationRow = {
  id: string
  slug: string
  name: string
  isActive: boolean
  isPersonal: boolean
  planCode: string | null
  subscriptionStatus: string | null
  journalEntries: number
  members: number
  /** Sello del último `InvariantRun`, o `null` si nunca se barrió. */
  lastSeal: string | null
  lastSweepAt: string | null
  /** Excepciones de operador vivas a la fecha de referencia. */
  liveExceptions: number
}

/**
 * Recorre TODAS las organizaciones, que es justamente lo que un panel de
 * operador tiene que hacer y lo que `tenantDb` no puede hacer.
 *
 * **No lee las tablas: llama a `app.operator_organizations`**, una función
 * `SECURITY DEFINER` que devuelve los AGREGADOS y nada más. La alternativa
 * —darle al operador `SELECT` sobre `organizations`, `journal_entries` y
 * `memberships`— habría convertido el panel en una llave para leer el diario de
 * cualquier cliente, y ADR-0020 §9.2 dice que el operador ve **cuánto**, no
 * **qué**. Quien autoriza sigue siendo `requirePlatformAdmin()`.
 *
 * Una sola consulta. Cincuenta organizaciones no pueden costar doscientas (el
 * N+1 que el estándar de calidad prohíbe).
 */
export async function listOrganizationsForOperator(refDate: Date): Promise<OperatorOrganizationRow[]> {
  const rows = await prisma.$queryRaw<
    {
      id: string
      slug: string
      name: string
      is_active: boolean
      is_personal: boolean
      plan_code: string | null
      subscription_status: string | null
      journal_entries: bigint
      members: bigint
      last_seal: string | null
      last_sweep_at: Date | null
      live_exceptions: bigint
    }[]
  >`SELECT * FROM app.operator_organizations(${refDate}::timestamp(3))`
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    isActive: r.is_active,
    isPersonal: r.is_personal,
    planCode: r.plan_code,
    subscriptionStatus: r.subscription_status,
    journalEntries: Number(r.journal_entries),
    members: Number(r.members),
    lastSeal: r.last_seal,
    lastSweepAt: r.last_sweep_at ? r.last_sweep_at.toISOString() : null,
    liveExceptions: Number(r.live_exceptions),
  }))
}

/** Un objetivo concreto sobre el que se puede levantar una guardia (ADR-0020 D1). */
export type OperatorGuardTarget = { id: string | null; ref: string | null; label: string }

export type OperatorGuardTargets = {
  periodLocks: OperatorGuardTarget[]
  closingGuards: OperatorGuardTarget[]
  stuckRestores: OperatorGuardTarget[]
  stuckCronJobs: OperatorGuardTarget[]
}

/**
 * Qué hay atascado AHORA, por clase de guardia.
 *
 * **Sólo se ofrece levantar lo que de verdad está atascado.** Un desplegable con
 * todas las guardias posibles invitaría a crear excepciones «por si acaso», y
 * una excepción de más es exactamente lo que ADR-0020 existe para evitar.
 *
 * **Se lee con el cliente ACOTADO de la organización**, no con el cliente sin
 * tenant: `period_locks`, `fiscal_years` y `restore_jobs` llevan RLS estricta y
 * una consulta fuera de `tenantDb` no da error — devuelve VACÍO (ADR-0009). Un
 * desplegable vacío por esa razón habría sido un fallo silencioso de manual.
 *
 * «Colgado» es un `RestoreJob` que lleva más de una hora sin terminar: el techo
 * de §12 de E11 para una restauración es muy inferior, así que a la hora ya no
 * está trabajando, está atascado. El umbral entra por parámetro para que el test
 * no tenga que esperar.
 */
export async function operatorGuardTargets(
  tx: Pick<TenantTransactionClient, "$queryRaw" | "$organizationId">,
  refDate: Date,
  stuckAfterMs: number = 60 * 60 * 1000
): Promise<OperatorGuardTargets> {
  const organizationId = tx.$organizationId
  const cutoff = new Date(refDate.getTime() - stuckAfterMs)

  const locks = await tx.$queryRaw<{ id: string; month: number; code: string; reason: string | null }[]>`
    SELECT pl."id", pl."month", fy."code", pl."reason"
      FROM "period_locks" pl
      JOIN "fiscal_years" fy ON fy."id" = pl."fiscal_year_id"
     WHERE pl."organization_id" = ${organizationId}::uuid
     ORDER BY fy."code" DESC, pl."month" DESC
     LIMIT 60
  `
  const years = await tx.$queryRaw<{ id: string; code: string; status: string }[]>`
    SELECT "id", "code", "status"::text AS status
      FROM "fiscal_years"
     WHERE "organization_id" = ${organizationId}::uuid AND "status" <> 'OPEN'
     ORDER BY "code" DESC
     LIMIT 20
  `
  const restores = await tx.$queryRaw<{ id: string; status: string; created_at: Date }[]>`
    SELECT "id", "status"::text AS status, "created_at"
      FROM "restore_jobs"
     WHERE "organization_id" = ${organizationId}::uuid
       AND "status" IN ('QUEUED', 'RUNNING', 'VERIFYING')
       AND "created_at" < ${cutoff}
     ORDER BY "created_at" ASC
     LIMIT 20
  `
  // `cron_runs` es de PLATAFORMA: no lleva `organization_id` (§9.5). Un job
  // atascado en PARTIAL bloquea a todas las organizaciones por igual, y la
  // excepción se registra contra la que la pide — que es quien la sufre.
  const cron = await tx.$queryRaw<{ job: string; period_key: string; started_at: Date }[]>`
    SELECT "job", "period_key", "started_at"
      FROM "cron_runs"
     WHERE "status" = 'PARTIAL' AND "started_at" < ${cutoff}
     ORDER BY "started_at" ASC
     LIMIT 20
  `

  return {
    periodLocks: locks.map((l) => ({
      id: l.id,
      ref: null,
      label: `${l.code} · mes ${String(l.month).padStart(2, "0")}${l.reason ? ` · ${l.reason.slice(0, 60)}` : ""}`,
    })),
    closingGuards: years.map((y) => ({ id: y.id, ref: null, label: `Ejercicio ${y.code} · ${y.status}` })),
    stuckRestores: restores.map((r) => ({
      id: r.id,
      ref: null,
      label: `${r.status} desde ${r.created_at.toISOString().slice(0, 16).replace("T", " ")}`,
    })),
    stuckCronJobs: cron.map((c) => ({
      id: null,
      ref: `${c.job}:${c.period_key}`,
      label: `${c.job} · ${c.period_key} · PARTIAL desde ${c.started_at.toISOString().slice(0, 16).replace("T", " ")}`,
    })),
  }
}
