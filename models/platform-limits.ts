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
import { readUsageInTransaction } from "@/models/usage"
import { periodMonthOf } from "@/lib/platform/usage"
import type { Plan } from "@/prisma/client"

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
  await tx.$queryRaw`
    SELECT 1 FROM subscriptions WHERE organization_id = ${organizationId}::uuid FOR SHARE`

  const subscription = await tx.subscription.findFirst({
    where: { organizationId },
    include: { plan: true },
  })
  const organization = await tx.organization.findFirst({
    where: { id: organizationId },
    select: { isActive: true },
  })
  /**
   * **ADR-0019 D9 · modo INTERNO.** Sin fila no hay plan que resolver, y en uso
   * interno la respuesta correcta es `ILIMITADO`, no un bloqueo.
   */
  if (!subscription) {
    const limitesSinFila = isInternalBilling(config.billing.provider) ? INTERNAL_PLAN_LIMITS : UNLIMITED_PLAN
    return { limits: limitesSinFila, access: "FULL", reason: null }
  }

  const limits = limitsOf(planRowOf(subscription.plan))
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

/** `Plan` de Prisma → `PlanRow` del motor puro. Una sola traducción, aquí. */
function planRowOf(plan: Plan): PlanRow {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    listPriceCents: plan.listPriceCents,
    currency: plan.currency,
    interval: plan.interval,
    stripePriceId: plan.stripePriceId,
    isPublic: plan.isPublic,
    validFrom: plan.validFrom,
    validTo: plan.validTo,
    maxMembers: plan.maxMembers,
    maxOcrDocsMonth: plan.maxOcrDocsMonth,
    maxStorageBytes: plan.maxStorageBytes,
    maxExportsMonth: plan.maxExportsMonth,
    maxBackupsMonth: plan.maxBackupsMonth,
    maxOrganizations: plan.maxOrganizations,
    softMaxEntriesMonth: plan.softMaxEntriesMonth,
    graceDays: plan.graceDays,
    backupRetentionDays: plan.backupRetentionDays,
  }
}

let resolver: PlanContextResolver = defaultPlanContextResolver

/** Inyección explícita (tests, y el cableado de la ola A cuando exista). */
export function setPlanContextResolver(next: PlanContextResolver): void {
  resolver = next
}
export function resetPlanContextResolver(): void {
  resolver = defaultPlanContextResolver
}

/** El uso traducido a la escala de cada clave. */
function usageFor(figures: {
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
  const { figures } = await readUsageInTransaction(tx, organizationId, options.refDate, periodMonth)

  const usage = usageFor(figures)
  if (key === "maxOrganizations" && options.organizationsOfUser !== undefined) {
    usage.maxOrganizations = options.organizationsOfUser
  }

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
 * Deja constancia de la excepción automática. `platform_audit_logs` es de M3
 * (**ola A · T15**): mientras no exista, la traza va al `AuditLog` de la
 * organización, que es append-only desde E2 y sí existe. Ninguna excepción se
 * concede en silencio, que es lo que el invariante I-E11-4b comprueba.
 */
async function recordAutomaticException(
  tx: TenantTransactionClient,
  organizationId: string,
  warn: SoftWarning
): Promise<void> {
  const detail = {
    code: warn.code,
    key: warn.key,
    current: warn.current.toString(),
    soft: warn.soft.toString(),
    usedBps: warn.usedBps,
  }
  const hasPlatformLog = await tx.$queryRaw<{ present: boolean }[]>`
    SELECT to_regclass('public.platform_audit_logs') IS NOT NULL AS present`
  if (hasPlatformLog[0]?.present) {
    await tx.$executeRaw`
      INSERT INTO platform_audit_logs (actor, action, organization_id, detail)
      VALUES ('cron', 'LIMITE_EXCEPCION_AUTOMATICA', ${organizationId}::uuid, ${JSON.stringify(detail)}::jsonb)`
    return
  }
  await tx.auditLog.create({
    data: {
      organizationId,
      entity: "Subscription",
      entityId: organizationId,
      action: "LIMITE_EXCEPCION_AUTOMATICA",
      after: detail,
      reason: warn.code,
    },
  })
}

/** Reexportado para que el llamante no tenga que importar de dos sitios. */
export { backupConsumesQuota }
