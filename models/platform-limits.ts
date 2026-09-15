/**
 * E11 · T9/T13 — **el guardián de cuota**, en un solo sitio (§3.5, ADR-0019 D7).
 *
 * ## Contrato
 *
 * `assertWithinLimit` corre **dentro de la MISMA transacción que la escritura** y
 * **antes** de tocar nada: ni fila a medias, ni fichero huérfano, ni documento
 * descartado. Si rechaza, lanza `LimitExceededError`, que la capa de acción
 * traduce a un `ActionState` en español con la cifra concreta.
 *
 * Sólo acepta `HardLimitKey`. **`softMaxEntriesMonth` no tiene guardián**: ésa es
 * literalmente la corrección de O-3, y el tipo la sostiene.
 *
 * ## Las siete acciones que lo invocan (§3.5, verificado por I-E11-4c)
 *
 * | Acción | Clave | `delta` |
 * |---|---|---|
 * | `inviteMemberAction` | `maxMembers` | 1 |
 * | `acceptInvitationAction` | `maxMembers` | 1 (revalida: la invitación pudo emitirse hace un mes) |
 * | `analyzeFileAction` | `maxOcrDocsMonth` | 1 por run raíz — **denegada en `READ_ONLY`** (O-16) |
 * | `uploadFileAction` | `maxStorageBytes` | `file.size` — **permitida en `READ_ONLY` con cuota blanda** (O-16) |
 * | `exportReportAction` | `maxExportsMonth` | 1 |
 * | `requestBackupAction` | `maxBackupsMonth` | 1 — salvo `EXIT` o `accessLevelOf ≠ FULL` (O-4) |
 * | `createOrganizationAction` | `maxOrganizations` | 1 contra el **usuario**; una `isDemo` no cuenta |
 *
 * `postEntryAction`, `postFromProposal` y la generación de recurrentes **no
 * aparecen**, y no pueden aparecer.
 *
 * ## Resolución del plan
 *
 * Los límites y el nivel de acceso salen del motor puro de la **ola A**:
 * `resolvePlanAt`/`limitsOf` (`lib/platform/plan.ts`) y `accessLevelOf`
 * (`lib/platform/subscription.ts`). Aquí sólo se leen las filas, con
 * **`FOR SHARE` sobre la suscripción**: la comprobación de cuota y la escritura
 * que la consume comparten transacción, y sin el bloqueo compartido dos
 * peticiones simultáneas cuelan la última plaza.
 *
 * Una organización **sin `Subscription`** no se bloquea: rige `UNLIMITED_PLAN`
 * con acceso `FULL`. I-E11-5 exige que no exista ninguna así, pero el guardián
 * no es el sitio donde enterarse — impedir registrar un hecho contable por una
 * fila de facturación que falta es justo lo que D7 prohíbe.
 */

import type { TenantTransactionClient } from "@/lib/db"
import {
  UNLIMITED,
  backupConsumesQuota,
  checkLimit,
  checkSoftEntries,
  type AccessLevel,
  type HardLimitKey,
  type LimitUsage,
  type PlanLimits,
  type SoftWarning,
} from "@/lib/platform/limits"
import { accessLevelOf } from "@/lib/platform/subscription"
import { INTERNAL_PLAN_LIMITS, isInternalBilling } from "@/lib/platform/billing"
import config from "@/lib/config"
import { limitsOf } from "@/lib/platform/plan"
import type { PlanRow } from "@/lib/platform/types"
import { EXPORT_AUDIT_ACTIONS } from "@/models/usage"
import { BILLABLE_BACKUP_TRIGGERS, BILLABLE_STORAGE_KINDS, SYSTEM_ENTRY_KINDS, periodMonthOf } from "@/lib/platform/usage"

export class LimitExceededError extends Error {
  constructor(
    readonly key: HardLimitKey,
    readonly current: bigint,
    readonly limit: bigint,
    message: string
  ) {
    super(message)
    this.name = "LimitExceededError"
  }
}

/**
 * Plan sin techos. Rige para una organización sin `Subscription` — que I-E11-5
 * declara imposible, pero que el guardián no puede convertir en un bloqueo.
 */
export const UNLIMITED_PLAN: PlanLimits = {
  maxMembers: Number(UNLIMITED),
  maxOcrDocsMonth: Number(UNLIMITED),
  maxStorageBytes: UNLIMITED,
  maxExportsMonth: Number(UNLIMITED),
  maxBackupsMonth: Number(UNLIMITED),
  maxOrganizations: Number(UNLIMITED),
  softMaxEntriesMonth: Number(UNLIMITED),
  graceDays: 0,
  backupRetentionDays: 30,
}

export type PlanContext = { limits: PlanLimits; access: AccessLevel; reason: string | null }

export type PlanContextResolver = (
  tx: TenantTransactionClient,
  organizationId: string,
  refDate: Date
) => Promise<PlanContext>

/**
 * Lee `Subscription ⋈ Plan` **con `FOR SHARE` sobre la suscripción** y deja que
 * el motor puro de la ola A decida el nivel de acceso. El `SELECT … FOR SHARE`
 * va en crudo porque Prisma no expone el bloqueo compartido; la fila que lee es
 * la misma que después usa `accessLevelOf`.
 */
export const defaultPlanContextResolver: PlanContextResolver = async (tx, organizationId, refDate) => {
  /**
   * **QA BUG-E11-1 — UNA consulta, no tres.** La ronda anterior hacía el
   * `FOR SHARE`, después `subscription.findFirst({ include: { plan } })` y
   * después `organization.findFirst()`: tres viajes dentro de la transacción de
   * la escritura, en la única conexión, antes siquiera de mirar la cuota. El
   * techo 4 de §12 pide **≤ 2 consultas y < 25 ms** en el camino caliente, y
   * sólo esto ya lo rebasaba.
   *
   * Ahora es un solo `SELECT` con el `LEFT JOIN` de las tres tablas y el
   * `FOR SHARE OF s`, que es exactamente el bloqueo compartido que hacía falta:
   * dos peticiones simultáneas siguen sin colar la última plaza.
   */
  const rows = await tx.$queryRaw<
    ({ org_is_active: boolean | null; sub_status: string | null; current_period_end: Date | null; grace_until: Date | null } & Record<string, unknown>)[]
  >`
    SELECT o.is_active AS org_is_active,
           s.status::text AS sub_status, s.current_period_end, s.grace_until,
           p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
           p.list_price_cents, p.currency, p.interval, p.stripe_price_id, p.is_public,
           p.valid_from, p.valid_to,
           p.max_members, p.max_ocr_docs_month, p.max_storage_bytes, p.max_exports_month,
           p.max_backups_month, p.max_organizations, p.soft_max_entries_month,
           p.grace_days, p.backup_retention_days
      FROM subscriptions s
      JOIN organizations o ON o.id = s.organization_id
      JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = ${organizationId}::uuid
       FOR SHARE OF s`
  /**
   * **Un `JOIN` interno, y por tanto `FOR SHARE OF s` legal.** Postgres rechaza
   * `FOR SHARE` sobre el lado anulable de un `LEFT JOIN` («FOR SHARE cannot be
   * applied to the nullable side of an outer join»), así que la consulta va
   * dirigida por `subscriptions`: con fila, **una** consulta y el bloqueo
   * compartido puesto; sin fila —el caso que I-E11-5 declara imposible—, una
   * segunda para saber si la organización está activa. El camino caliente paga
   * la primera y nada más.
   */
  const row = rows[0]
  const subscription = row
    ? {
        status: row.sub_status as SubscriptionStatusLike,
        currentPeriodEnd: row.current_period_end,
        graceUntil: row.grace_until,
        plan: planFromRow(row),
      }
    : null
  const organization = row
    ? { isActive: row.org_is_active }
    : await tx.organization.findFirst({ where: { id: organizationId }, select: { isActive: true } })
  /**
   * **ADR-0019 D9 · modo INTERNO.** Sin fila no hay plan que resolver, y en uso
   * interno la respuesta correcta es `ILIMITADO`, no un bloqueo.
   */
  if (!subscription) {
    const limitesSinFila = isInternalBilling(config.billing.provider) ? INTERNAL_PLAN_LIMITS : UNLIMITED_PLAN
    return { limits: limitesSinFila, access: "FULL", reason: null }
  }

  const limits = limitsOf(subscription.plan)
  const verdict = accessLevelOf(
    {
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      graceUntil: subscription.graceUntil,
    },
    limits,
    refDate,
    { organizationIsActive: organization?.isActive !== false, billingProvider: config.billing.provider }
  )
  return { limits, access: verdict.level, reason: verdict.reason }
}

/** Estado de la suscripción tal como lo devuelve el `SELECT` crudo. */
type SubscriptionStatusLike = Parameters<typeof accessLevelOf>[0]["status"]

/** Fila cruda del `LEFT JOIN` → `PlanRow` del motor puro. Una sola traducción. */
function planFromRow(row: Record<string, unknown>): PlanRow {
  const int = (value: unknown): number => Number(value ?? 0)
  return {
    id: String(row.plan_id),
    code: String(row.plan_code),
    name: String(row.plan_name),
    listPriceCents: int(row.list_price_cents),
    currency: String(row.currency),
    interval: String(row.interval),
    stripePriceId: (row.stripe_price_id as string | null) ?? null,
    isPublic: row.is_public === true,
    validFrom: row.valid_from as Date,
    validTo: (row.valid_to as Date | null) ?? null,
    maxMembers: int(row.max_members),
    maxOcrDocsMonth: int(row.max_ocr_docs_month),
    maxStorageBytes: BigInt((row.max_storage_bytes as bigint | number | string | null) ?? 0),
    maxExportsMonth: int(row.max_exports_month),
    maxBackupsMonth: int(row.max_backups_month),
    maxOrganizations: int(row.max_organizations),
    softMaxEntriesMonth: int(row.soft_max_entries_month),
    graceDays: int(row.grace_days),
    backupRetentionDays: int(row.backup_retention_days),
  } as PlanRow
}

let resolver: PlanContextResolver = defaultPlanContextResolver

/** Inyección explícita (tests, y el cableado de la ola A cuando exista). */
export function setPlanContextResolver(next: PlanContextResolver): void {
  resolver = next
}
export function resetPlanContextResolver(): void {
  resolver = defaultPlanContextResolver
}

/**
 * Escala vacía. `checkLimit` **sólo lee `usage[key]`** (está probado), así que
 * el camino caliente rellena una clave y deja el resto a cero en vez de pagar el
 * recuento de las seis.
 */
function emptyUsage(): LimitUsage {
  return {
    maxMembers: BigInt(0),
    maxOcrDocsMonth: BigInt(0),
    maxStorageBytes: BigInt(0),
    maxExportsMonth: BigInt(0),
    maxBackupsMonth: BigInt(0),
    maxOrganizations: BigInt(0),
    softMaxEntriesMonth: BigInt(0),
  }
}

/**
 * **Una sola cifra, un solo agregado.** Las definiciones son literalmente las de
 * §3.4 —las mismas exclusiones, los mismos `kind`—, que es lo que mantiene
 * coherentes el guardián y el `UsageRun` que I-E11-1 enfrenta a la Σ real.
 */
async function readUsageForKey(
  tx: TenantTransactionClient,
  organizationId: string,
  key: HardLimitKey,
  periodMonth: string
): Promise<bigint> {
  const start = new Date(`${periodMonth}T00:00:00.000Z`)
  const endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))

  if (key === "maxMembers") {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM memberships
       WHERE organization_id = ${organizationId}::uuid AND accepted_at IS NOT NULL`
    return BigInt(rows[0]?.n ?? BigInt(0))
  }
  if (key === "maxOcrDocsMonth") {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM extraction_runs
       WHERE organization_id = ${organizationId}::uuid
         AND created_at >= ${start} AND created_at < ${endExclusive}
         AND parent_run_id IS NULL`
    return BigInt(rows[0]?.n ?? BigInt(0))
  }
  if (key === "maxStorageBytes") {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM stored_objects
       WHERE organization_id = ${organizationId}::uuid
         AND kind::text = ANY (${[...BILLABLE_STORAGE_KINDS]}::text[])`
    return BigInt(rows[0]?.n ?? BigInt(0))
  }
  if (key === "maxExportsMonth") {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT (
        (SELECT count(*) FROM audit_logs a
          WHERE a.organization_id = ${organizationId}::uuid
            AND a.ts >= ${start} AND a.ts < ${endExclusive}
            AND a.action = ANY (${[...EXPORT_AUDIT_ACTIONS]}::text[]))
        + (SELECT count(*) FROM backup_jobs b
            WHERE b.organization_id = ${organizationId}::uuid
              AND b.created_at >= ${start} AND b.created_at < ${endExclusive}
              AND b.trigger::text = ANY (${[...BILLABLE_BACKUP_TRIGGERS]}::text[]))
      )::bigint AS n`
    return BigInt(rows[0]?.n ?? BigInt(0))
  }
  if (key === "maxBackupsMonth") {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM backup_jobs
       WHERE organization_id = ${organizationId}::uuid
         AND created_at >= ${start} AND created_at < ${endExclusive}
         AND trigger::text = ANY (${[...BILLABLE_BACKUP_TRIGGERS]}::text[])
         AND status IN ('DONE', 'RUNNING')`
    return BigInt(rows[0]?.n ?? BigInt(0))
  }
  // `maxOrganizations` se cuenta contra el USUARIO y lo aporta el llamante.
  return BigInt(0)
}

/**
 * El uso COMPLETO traducido a la escala de cada clave. Lo usa `/settings` para
 * pintar las seis barras; el guardián **no**, porque paga seis recuentos para
 * responder a una pregunta (BUG-E11-1).
 */
export function usageFor(figures: {
  members: number
  entries: number
  ocrDocs: number
  exports: number
  backups: number
  storageBytes: bigint
}): LimitUsage {
  return {
    maxMembers: BigInt(figures.members),
    maxOcrDocsMonth: BigInt(figures.ocrDocs),
    maxStorageBytes: figures.storageBytes,
    maxExportsMonth: BigInt(figures.exports),
    maxBackupsMonth: BigInt(figures.backups),
    maxOrganizations: BigInt(0), // se cuenta contra el USUARIO, no contra la organización
    softMaxEntriesMonth: BigInt(figures.entries),
  }
}

export type AssertOptions = {
  /** Fecha de referencia. Obligatoria: el reloj no entra solo en ningún sitio. */
  refDate: Date
  /** Mes de la cuota. Por defecto, el de `refDate`. */
  periodMonth?: string
  /** Nº de organizaciones del usuario, sólo para `maxOrganizations`. */
  organizationsOfUser?: bigint
}

/**
 * **El guardián.** Lanza `LimitExceededError` si la operación rebasa una cuota
 * dura; devuelve el aviso cuando la cuota es blanda por mora (O-16). Nunca
 * escribe nada por sí mismo salvo el registro de la excepción automática.
 */
export async function assertWithinLimit(
  tx: TenantTransactionClient,
  key: HardLimitKey,
  delta: bigint,
  options: AssertOptions
): Promise<{ warn: SoftWarning | null }> {
  const organizationId = tx.$organizationId
  const periodMonth = options.periodMonth ?? periodMonthOf(options.refDate)

  const { limits, access } = await resolver(tx, organizationId, options.refDate)

  /**
   * **QA BUG-E11-1 — el camino caliente** (techo 4 de §12: < 25 ms, ≤ 2
   * consultas).
   *
   * Lo que hacía la ronda anterior: llamar SIEMPRE a `readUsageInTransaction`,
   * que recomputa **las seis cifras** desde cero —organización, `readFigures`,
   * `readSources` y el `computeLedgerHash` del mes— dentro de la transacción de
   * la escritura. Con volumen mínimo medía 28-70 ms y con 50 000 asientos no hay
   * techo que valga: se pagaba el uso entero para responder a una sola pregunta.
   *
   * Dos atajos, en este orden, y ninguno relaja la garantía:
   *
   * 1. **Límite ilimitado (`-1`), ni una consulta.** Es la resolución que
   *    `checkLimit` hace antes de mirar el uso, adelantada aquí para no leerlo:
   *    en modo INTERNO con el plan `ILIMITADO` —el caso de TODAS las escrituras
   *    hoy— el guardián cuesta exactamente la consulta del plan.
   * 2. **Sólo la cifra de ESTA clave**, en un agregado SQL. Es más fuerte que
   *    una caché, no más débil: no puede servir un recuento viejo, que es
   *    justamente lo que I-E11-1 castiga. Y el `UsageRun` del mes **no se toca**:
   *    la caché de `getUsage` sigue siendo la de §3.4, con su `sourceHash`, y el
   *    invariante la sigue enfrentando a la Σ real.
   *
   * Total en el peor caso: **2 consultas**.
   */
  const rawLimit = limits[key]
  const limitValue = typeof rawLimit === "bigint" ? rawLimit : BigInt(rawLimit)
  if (limitValue < BigInt(0)) return { warn: null }

  const usage = emptyUsage()
  usage[key] =
    key === "maxOrganizations"
      ? (options.organizationsOfUser ?? BigInt(0))
      : await readUsageForKey(tx, organizationId, key, periodMonth)

  const verdict = checkLimit(key, usage, limits, delta, access)
  if (!verdict.ok) {
    throw new LimitExceededError(verdict.key, verdict.current, verdict.limit, verdict.message)
  }
  if (verdict.warn) {
    // **La excepción la concede el motor, no un operador** (O-3): en E11
    // `/admin` es de sólo lectura y nadie podría concederla a mano.
    await recordAutomaticException(tx, organizationId, verdict.warn)
  }
  return { warn: verdict.warn ?? null }
}

/**
 * Deja constancia de la excepción automática en `platform_audit_logs`. Ninguna
 * excepción se concede en silencio: es lo que I-E11-4(b) comprueba.
 *
 * **Revisor PUEDE 10, dos correcciones.** (1) Se retira el `to_regclass`: era
 * andamio de la ola B y M3 creó la tabla hace tres migraciones; una rama muerta
 * en el camino de una excepción de cuota es una rama que nadie volverá a probar.
 * (2) El actor ya no es `'cron'` por defecto —la excepción la dispara casi
 * siempre una acción de usuario—: es **`motor`**, que es quien de verdad la
 * concede (O-3: en E11 `/admin` es de sólo lectura y ningún operador podría).
 *
 * `periodMonth` hace el registro **idempotente por mes**: una superación
 * sostenida deja una línea, no una por escritura.
 */
async function recordAutomaticException(
  tx: TenantTransactionClient,
  organizationId: string,
  warn: SoftWarning,
  periodMonth?: string
): Promise<void> {
  const detail = {
    code: warn.code,
    key: warn.key,
    current: warn.current.toString(),
    soft: warn.soft.toString(),
    usedBps: warn.usedBps,
    ...(periodMonth ? { periodMonth } : {}),
  }
  if (periodMonth) {
    const yaRegistrada = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM platform_audit_logs
       WHERE organization_id = ${organizationId}::uuid
         AND action = 'LIMITE_EXCEPCION_AUTOMATICA'
         AND detail->>'code' = ${warn.code}
         AND detail->>'periodMonth' = ${periodMonth}`
    if ((yaRegistrada[0]?.n ?? BigInt(0)) > BigInt(0)) return
  }
  await tx.$executeRaw`
    INSERT INTO platform_audit_logs (actor, action, organization_id, detail)
    VALUES ('motor', 'LIMITE_EXCEPCION_AUTOMATICA', ${organizationId}::uuid, ${JSON.stringify(detail)}::jsonb)`
}

/**
 * **La cuota BLANDA del registro contable, cableada** (§3.5, O-3; auditor H-5).
 *
 * `checkSoftEntries` era código muerto: sus únicas referencias en todo el
 * repositorio estaban en sus propios tests, de modo que **nada de §3.5 ocurría**
 * —ni el aviso al 80 % y al 100 %, ni el motivo `CUOTA_DE_ASIENTOS_SUPERADA`, ni
 * el WARN en la familia PLATAFORMA de `/audit`, ni el `PlatformAuditLog` de
 * excepción automática—, e I-E11-4(b) habría pasado por vacuidad.
 *
 * Tres propiedades que no se negocian:
 *
 * 1. **NUNCA bloquea.** No lanza, no devuelve rechazo y no puede impedir un
 *    `postEntry`: el tipo de `checkSoftEntries` lo sostiene y aquí se respeta.
 *    Un fallo al anotar el aviso **no puede tumbar el asiento**, así que se
 *    captura y se sigue: el hecho contable ya ha ocurrido (D7).
 * 2. **No cuesta nada en el caso normal.** Con `softMaxEntriesMonth = -1`
 *    —modo INTERNO, plan ILIMITADO— sale antes de contar una sola fila.
 * 3. **Un aviso por mes, no uno por asiento.** La excepción automática se
 *    registra con `ON CONFLICT DO NOTHING` sobre `(organización, mes, código)`:
 *    lo que I-E11-4(b) exige es que la superación TENGA su registro, no que haya
 *    mil.
 */
export async function noteSoftEntryQuota(
  tx: TenantTransactionClient,
  options: { refDate: Date; periodMonth?: string; delta?: bigint }
): Promise<{ warn: SoftWarning | null; blocksAccessory: boolean }> {
  const organizationId = tx.$organizationId
  const periodMonth = options.periodMonth ?? periodMonthOf(options.refDate)
  try {
    /**
     * **Una consulta propia, mínima y SIN bloqueo.** No se usa el resolver del
     * guardián: esto corre dentro de la transacción de un `postEntry`, y un
     * `FOR SHARE` —o cualquier sentencia que pueda fallar— envenenaría esa
     * transacción y tumbaría el asiento. Un aviso no puede costar un hecho
     * contable (D7). Sin suscripción o sin techo blando, no hay nada que contar.
     */
    const planRows = await tx.$queryRaw<{ soft: number | null }[]>`
      SELECT p.soft_max_entries_month AS soft
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = ${organizationId}::uuid
       LIMIT 1`
    const soft = planRows[0]?.soft ?? -1
    if (soft < 0) return { warn: null, blocksAccessory: false }
    const limits: PlanLimits = { ...UNLIMITED_PLAN, softMaxEntriesMonth: soft }

    const start = new Date(`${periodMonth}T00:00:00.000Z`)
    const endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM journal_entries e
       WHERE e.organization_id = ${organizationId}::uuid
         AND e.entry_date >= ${start}::date AND e.entry_date < ${endExclusive}::date
         AND e.reverses_entry_id IS NULL
         AND e.kind::text <> ALL (${[...SYSTEM_ENTRY_KINDS]}::text[])`
    const verdict = checkSoftEntries(BigInt(rows[0]?.n ?? BigInt(0)), limits, options.delta ?? BigInt(0))
    if (verdict.warn) await recordAutomaticException(tx, organizationId, verdict.warn, periodMonth)
    return verdict
  } catch (error) {
    // El aviso es información; el asiento es el hecho. Jamás al revés.
    console.warn(`[platform-limits] no se ha podido evaluar la cuota blanda de ${organizationId}`, error)
    return { warn: null, blocksAccessory: false }
  }
}

/** Reexportado para que el llamante no tenga que importar de dos sitios. */
export { backupConsumesQuota, checkSoftEntries }
