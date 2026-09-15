/**
 * E11 · ola A · T15 — la suscripción de una organización y su historia.
 *
 * Dos reglas gobiernan este fichero:
 *
 * 1. **Una organización, una suscripción** (I-E11-5). El `@@unique` está en la
 *    base; aquí no hay ningún camino que cree la segunda.
 * 2. **La transición y su evento nacen en la MISMA transacción.** Un estado
 *    cambiado sin `SubscriptionEvent` es un `READ_ONLY` que nadie sabe explicar,
 *    y `subscription_events` es append-only precisamente para eso (I-E11-9).
 *
 * El nivel de acceso NO se calcula aquí: lo decide `accessLevelOf`
 * (`lib/platform/subscription.ts`), función pura definida **una sola vez**.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { tenantDb, tenantTransaction, withTenantGucs } from "@/lib/db"
import { accessLevelOf, exportWindowUntilOf, graceUntilOf } from "@/lib/platform/subscription"
import type { AccessVerdict } from "@/lib/platform/subscription"
import type { PlanLimits, SubscriptionRow } from "@/lib/platform/types"
import {
  INTERNAL_PLAN_CODE,
  INTERNAL_PLAN_LIMITS,
  defaultPlanCodeFor,
  internalAccessLevel,
  type BillingProvider,
} from "@/lib/platform/billing"
import config from "@/lib/config"
import { getPlanAt, getPlanById, limitsOf } from "@/models/plans"
import type { Prisma, SubscriptionStatus } from "@/prisma/client"

type AnyTenantClient = TenantClient | TenantTransactionClient

/**
 * El cliente que necesita la siembra al alta: **el de `withTenantGucs`**, que no
 * lleva `$organizationId` porque la organización se está creando en ese mismo
 * instante. Se pide lo mínimo —SQL crudo— en vez de exigir un `TenantClient`
 * completo que ahí no existe.
 */
type SeedClient = Pick<TenantTransactionClient, "$queryRaw" | "$executeRaw">


type SubscriptionDbRow = {
  id: string
  organization_id: string
  plan_code: string
  plan_id: string
  stripe_subscription_id: string | null
  status: SubscriptionStatus
  current_period_start: Date | null
  current_period_end: Date | null
  cancel_at_period_end: boolean
  trial_end: Date | null
  grace_until: Date | null
  export_window_until: Date | null
  customer_country: string | null
  vat_number: string | null
  vat_validated_at: Date | null
  vat_validation_source: string | null
  vat_validation_ref: string | null
}

export type Subscription = SubscriptionRow & {
  id: string
  stripeSubscriptionId: string | null
  vatValidationSource: string | null
  vatValidationRef: string | null
}

function toSubscription(r: SubscriptionDbRow): Subscription {
  return {
    id: r.id,
    organizationId: r.organization_id,
    planCode: r.plan_code,
    planId: r.plan_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    status: r.status,
    currentPeriodStart: r.current_period_start,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    trialEnd: r.trial_end,
    graceUntil: r.grace_until,
    exportWindowUntil: r.export_window_until,
    customerCountry: r.customer_country,
    vatNumber: r.vat_number,
    vatValidatedAt: r.vat_validated_at,
    vatValidationSource: r.vat_validation_source,
    vatValidationRef: r.vat_validation_ref,
  }
}

const SELECT_SUBSCRIPTION = `
  SELECT "id", "organization_id", "plan_code", "plan_id", "stripe_subscription_id", "status",
         "current_period_start", "current_period_end", "cancel_at_period_end", "trial_end",
         "grace_until", "export_window_until", "customer_country", "vat_number",
         "vat_validated_at", "vat_validation_source", "vat_validation_ref"
    FROM "subscriptions"`

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Auditor H-4 (ALTA) — el filtro de tenant va en el `WHERE`, no en la RLS.**
 *
 * La ronda anterior lanzaba `SELECT … FROM subscriptions LIMIT 1` **sin
 * `WHERE`**, apoyándose sólo en la política de fila. CLAUDE.md declara la RLS
 * *segunda* barrera, y bajo cualquier rol `BYPASSRLS` —el propietario de
 * `DIRECT_URL`, `app_maintenance`, o un despliegue donde el rol de la aplicación
 * sea el dueño— esto devolvía **la suscripción de otra organización**: el
 * auditor lo reprodujo con `app.current_org` fijado en A y la fila devuelta
 * perteneciendo a B. Y de ahí salía el `UPDATE … WHERE id = <el de otra
 * organización>` que afectaba a 0 filas y aun así registraba un cambio de plan.
 */
export async function getSubscription(db: AnyTenantClient): Promise<Subscription | null> {
  const rows = await db.$queryRawUnsafe<SubscriptionDbRow[]>(
    `${SELECT_SUBSCRIPTION} WHERE "organization_id" = $1::uuid LIMIT 1`,
    db.$organizationId
  )
  return rows[0] ? toSubscription(rows[0]) : null
}

/**
 * Suscripción + límites del plan CONTRATADO + nivel de acceso, de una sola vez.
 *
 * Es lo que `requireOrg` necesita y lo que la cabecera pinta. Se resuelve en una
 * transacción de lectura para no pagar dos viajes en el camino caliente
 * (techo 4 de §12: < 25 ms, ≤ 2 consultas).
 *
 * **Sin fila no se inventa un acceso pleno**: una organización sin suscripción
 * es un fallo de I-E11-5 y sale `READ_ONLY` con motivo. Suponer `FULL` sería
 * regalar el producto a cualquier fallo de backfill; suponer `BLOCKED`, quitarle
 * sus libros a quien paga.
 */
export type SubscriptionContext = {
  subscription: Subscription | null
  limits: PlanLimits | null
  access: AccessVerdict
}

export async function getSubscriptionContext(
  organizationId: string,
  refDate: Date,
  opts: { organizationIsActive?: boolean; billingProvider?: BillingProvider } = {}
): Promise<SubscriptionContext> {
  const db = tenantDb(organizationId)
  const subscription = await getSubscription(db)
  const provider = opts.billingProvider ?? config.billing.provider

  if (!subscription) {
    // **ADR-0019 D9.** En modo INTERNO, una organización sin fila de suscripción
    // no está «en sólo lectura hasta que se regularice»: no hay nada que
    // regularizar. Rige `ILIMITADO` y el acceso es pleno.
    const interno = internalAccessLevel(provider, opts)
    if (interno) return { subscription: null, limits: INTERNAL_PLAN_LIMITS, access: interno }
    return {
      subscription: null,
      limits: null,
      access: {
        level: opts.organizationIsActive === false ? "BLOCKED" : "READ_ONLY",
        reason:
          "Esta organización no tiene suscripción asociada (I-E11-5). Está en sólo lectura hasta " +
          "que se regularice; puede consultar y exportar sus libros con normalidad.",
        graceUntil: null,
      },
    }
  }

  const plan = await getPlanById(db, subscription.planId)
  const limits = plan ? limitsOf(plan) : null
  const access = accessLevelOf(subscription, { graceDays: limits?.graceDays ?? 0 }, refDate, {
    ...opts,
    billingProvider: provider,
  })
  return { subscription, limits, access }
}

/**
 * La organización a la que pertenece un `stripe_customer_id`.
 *
 * Pasa por la puerta `SECURITY DEFINER` que E3 ya dejó hecha
 * (`app.organization_id_by_stripe_customer`): el webhook no tiene sesión, así
 * que no hay organización activa que fijar en los GUC. **No crea nada**: si
 * devuelve `null`, el webhook responde `200` con `ORPHAN_WEBHOOK` y ahí termina
 * (ADR-0019 D1.3).
 */
export async function organizationIdByStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  return await withTenantGucs(null, undefined, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string | null }[]>`
      SELECT app.organization_id_by_stripe_customer(${stripeCustomerId}) AS id
    `
    return rows[0]?.id ?? null
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura: la transición y su evento, juntas o ninguna
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionPatch = {
  planCode?: string
  planId?: string
  stripeSubscriptionId?: string | null
  status?: SubscriptionStatus
  currentPeriodStart?: Date | null
  currentPeriodEnd?: Date | null
  cancelAtPeriodEnd?: boolean
  trialEnd?: Date | null
  customerCountry?: string | null
  vatNumber?: string | null
  vatValidatedAt?: Date | null
  vatValidationSource?: string | null
  vatValidationRef?: string | null
}

export type SubscriptionEventInput = {
  stripeEventId: string
  eventType: string
  occurredAt: Date
  /** §9.2 · ya RECORTADO por quien llama. Aquí no se recorta nada por si acaso. */
  payload: Prisma.InputJsonValue
}

export class DuplicateStripeEventError extends Error {
  constructor(readonly stripeEventId: string) {
    super(`El evento de Stripe ${stripeEventId} ya estaba aplicado`)
    this.name = "DuplicateStripeEventError"
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002"
}

/**
 * Aplica una transición de suscripción y deja su `SubscriptionEvent`, **en una
 * sola transacción**.
 *
 * La idempotencia es el `UNIQUE` de `stripe_event_id`: si el evento ya estaba
 * aplicado, la inserción choca, la transacción revierte entera y se lanza
 * `DuplicateStripeEventError`. El webhook lo traduce a `200` — **Stripe reintenta
 * por diseño y el efecto no se puede aplicar dos veces** (I-E11-9, criterio 2).
 *
 * `statusBefore` / `statusAfter` se encadenan sin hueco: se lee el estado dentro
 * de la misma transacción, no antes.
 */
export async function applySubscriptionTransition(
  organizationId: string,
  patch: SubscriptionPatch,
  event: SubscriptionEventInput,
  refDate: Date
): Promise<{ subscription: Subscription; statusBefore: SubscriptionStatus | null }> {
  return await tenantTransaction(organizationId, async (tx) => {
    const antes = await getSubscription(tx)
    const statusBefore = antes?.status ?? null

    if (!antes) {
      throw new Error(
        `La organización ${organizationId} no tiene Subscription: el webhook NO da de alta tenants ` +
          "(ADR-0019 D1.3). Revise el backfill de M4."
      )
    }

    const statusAfter = patch.status ?? antes.status
    const planId = patch.planId ?? antes.planId
    const plan = await getPlanById(tx, planId)
    const graceDays = plan?.graceDays ?? 0

    const proyectada = { ...antes, ...patch, status: statusAfter }
    const graceUntil = graceUntilOf(proyectada, { graceDays }, refDate)
    const exportWindowUntil = exportWindowUntilOf({ ...proyectada, exportWindowUntil: antes.exportWindowUntil }, refDate)

    await tx.$executeRaw`
      UPDATE "subscriptions" SET
        "plan_code"              = ${patch.planCode ?? antes.planCode},
        "plan_id"                = ${planId}::uuid,
        "stripe_subscription_id" = ${patch.stripeSubscriptionId !== undefined ? patch.stripeSubscriptionId : antes.stripeSubscriptionId},
        "status"                 = ${statusAfter}::"subscription_status",
        "current_period_start"   = ${patch.currentPeriodStart !== undefined ? patch.currentPeriodStart : antes.currentPeriodStart},
        "current_period_end"     = ${patch.currentPeriodEnd !== undefined ? patch.currentPeriodEnd : antes.currentPeriodEnd},
        "cancel_at_period_end"   = ${patch.cancelAtPeriodEnd ?? antes.cancelAtPeriodEnd},
        "trial_end"              = ${patch.trialEnd !== undefined ? patch.trialEnd : antes.trialEnd},
        "grace_until"            = ${graceUntil},
        "export_window_until"    = ${exportWindowUntil},
        "customer_country"       = ${patch.customerCountry !== undefined ? patch.customerCountry : antes.customerCountry},
        "vat_number"             = ${patch.vatNumber !== undefined ? patch.vatNumber : antes.vatNumber},
        "vat_validated_at"       = ${patch.vatValidatedAt !== undefined ? patch.vatValidatedAt : antes.vatValidatedAt},
        "vat_validation_source"  = ${patch.vatValidationSource !== undefined ? patch.vatValidationSource : antes.vatValidationSource},
        "vat_validation_ref"     = ${patch.vatValidationRef !== undefined ? patch.vatValidationRef : antes.vatValidationRef},
        "updated_at"             = now()
      WHERE "id" = ${antes.id}::uuid AND "organization_id" = ${organizationId}::uuid
    `

    try {
      await tx.subscriptionEvent.create({
        data: {
          organizationId,
          subscriptionId: antes.id,
          stripeEventId: event.stripeEventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          statusBefore,
          statusAfter,
          payload: event.payload,
        },
      })
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateStripeEventError(event.stripeEventId)
      throw e
    }

    const despues = await getSubscription(tx)
    return { subscription: despues!, statusBefore }
  })
}

/**
 * Registra un evento de Stripe que **no cambia el estado** (una factura
 * finalizada, por ejemplo). Misma idempotencia, mismo append-only.
 */
export async function recordSubscriptionEvent(
  organizationId: string,
  event: SubscriptionEventInput
): Promise<void> {
  await tenantTransaction(organizationId, async (tx) => {
    const actual = await getSubscription(tx)
    try {
      await tx.subscriptionEvent.create({
        data: {
          organizationId,
          subscriptionId: actual?.id ?? null,
          stripeEventId: event.stripeEventId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          statusBefore: actual?.status ?? null,
          statusAfter: actual?.status ?? "INCOMPLETE",
          payload: event.payload,
        },
      })
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateStripeEventError(event.stripeEventId)
      throw e
    }
  })
}

/** ¿Ya se aplicó este evento? Consulta barata previa al trabajo pesado. */
export async function isStripeEventApplied(db: AnyTenantClient, stripeEventId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "subscription_events" WHERE "stripe_event_id" = ${stripeEventId}
  `
  return (rows[0]?.n ?? BigInt(0)) > BigInt(0)
}

/** Los eventos de una organización, del más reciente al más antiguo. */
export async function listSubscriptionEvents(db: AnyTenantClient, limit = 50) {
  return await db.subscriptionEvent.findMany({
    orderBy: { occurredAt: "desc" },
    take: limit,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Siembra al alta y cambio de plan por el administrador de plataforma (D9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **La suscripción nace con la organización** (ADR-0019 **D9**).
 *
 * Se llama DENTRO de la transacción que crea la organización, junto a la
 * membresía y al plan de cuentas: o nace todo o no nace nada. Antes de D9 la
 * fila la ponía sólo el backfill de M4, de modo que **toda organización creada
 * después de la migración se quedaba sin suscripción** — y `getSubscriptionContext`
 * la mandaba a `READ_ONLY` con un motivo que no era verdad.
 *
 * En modo INTERNO asigna `ILIMITADO`; en modo `stripe`, `FREE`, que es lo que el
 * backfill de M4 ya hacía. Idempotente: si la fila está, no la toca (el
 * `@@unique(organizationId)` la protege igualmente).
 *
 * **Lanza** si no hay versión vigente del plan por defecto: el alta aborta
 * entera. Una organización sin suscripción es el estado que I-E11-5 prohíbe, y
 * nacer coja en silencio es peor que no nacer (revisor BLOQUEA 4).
 */
export async function ensureSubscriptionForOrganization(
  tx: SeedClient,
  organizationId: string,
  refDate: Date,
  provider: BillingProvider = config.billing.provider
): Promise<void> {
  const existentes = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "subscriptions" WHERE "organization_id" = ${organizationId}::uuid`
  if ((existentes[0]?.n ?? BigInt(0)) > BigInt(0)) return

  const code = defaultPlanCodeFor(provider)
  /**
   * **Revisor BLOQUEA 4 — el error NO se traga.**
   *
   * La ronda anterior capturaba el fallo de `getPlanAt` con un `console.warn` y
   * volvía sin crear la fila: producía en silencio, y en el camino de alta,
   * exactamente el estado que I-E11-5 prohíbe y que D9 promete imposible («toda
   * organización nace con el plan ILIMITADO»). Una instalación con el catálogo
   * de planes incompleto es una instalación rota; lo correcto es **abortar la
   * transacción entera del alta**, no dar de alta una organización coja que
   * alguien descubrirá cuando falle otra cosa.
   */
  const plan: { id: string } = await getPlanAt(tx as unknown as TenantTransactionClient, code, refDate)

  await tx.$executeRaw`
    INSERT INTO "subscriptions" ("organization_id", "plan_code", "plan_id", "status", "created_at", "updated_at")
    VALUES (${organizationId}::uuid, ${code}, ${plan.id}::uuid, 'ACTIVE', ${refDate}, ${refDate})
    ON CONFLICT ("organization_id") DO NOTHING`
}

/**
 * **Cambio de plan por el administrador de plataforma** (ADR-0019 D9).
 *
 * En modo INTERNO no hay checkout ni portal, así que la única forma de **probar
 * los límites** es que quien opera la instalación asigne otro plan a una
 * organización. Se registra en `platform_audit_logs` con el plan de antes y el
 * de después: un cambio de límites sin traza sería un `READ_ONLY` —o un
 * bloqueo de cuota— que nadie sabe explicar, que es justo lo que D1.3 evita en
 * el webhook.
 *
 * No emite `SubscriptionEvent`: ese registro es de eventos de **Stripe** y tiene
 * `stripe_event_id UNIQUE`; inventarle uno sintético ensuciaría la idempotencia
 * del webhook. La traza de plataforma es el sitio correcto.
 */
export async function changeOrganizationPlan(
  organizationId: string,
  planCode: string,
  refDate: Date,
  actor: string
): Promise<{ planCode: string; planId: string; previousPlanCode: string | null }> {
  const resultado = await tenantTransaction(organizationId, async (tx) => {
    const plan = await getPlanAt(tx, planCode, refDate)
    const antes = await getSubscription(tx)

    if (!antes) {
      await tx.$executeRaw`
        INSERT INTO "subscriptions" ("organization_id", "plan_code", "plan_id", "status", "created_at", "updated_at")
        VALUES (${organizationId}::uuid, ${plan.code}, ${plan.id}::uuid, 'ACTIVE', ${refDate}, ${refDate})`
      return { planCode: plan.code, planId: plan.id, previousPlanCode: null }
    }

    /**
     * **Auditor H-4 · la traza no puede mentir (P6).** El `UPDATE` devuelve el
     * número de filas afectadas y aquí se **exige que sea exactamente una**
     * antes de escribir el `AuditLog` y el `PlatformAuditLog`. La ronda anterior
     * no lo miraba: con la suscripción de otra organización en la mano, el
     * `UPDATE` tocaba 0 filas, la función devolvía `success: true` y quedaban
     * dos registros diciendo que el plan había cambiado a FREE mientras la
     * suscripción seguía en ILIMITADO con su `updated_at` original.
     */
    const afectadas = await tx.$executeRaw`
      UPDATE "subscriptions"
         SET "plan_code" = ${plan.code}, "plan_id" = ${plan.id}::uuid, "updated_at" = ${refDate}
       WHERE "id" = ${antes.id}::uuid AND "organization_id" = ${organizationId}::uuid`
    if (afectadas !== 1) {
      throw new Error(
        `el cambio de plan de la organización ${organizationId} ha afectado a ${afectadas} filas y no a una: ` +
          "no se registra un cambio que no ha ocurrido"
      )
    }

    await tx.auditLog.create({
      data: {
        organizationId,
        entity: "Subscription",
        entityId: antes.id,
        action: "CAMBIO_DE_PLAN",
        before: { planCode: antes.planCode },
        after: { planCode: plan.code },
        reason: `Cambio de plan por el administrador de plataforma (${actor})`,
      },
    })
    return { planCode: plan.code, planId: plan.id, previousPlanCode: antes.planCode }
  })

  const { PLATFORM_ACTIONS, recordPlatformAudit } = await import("@/models/platform")
  await recordPlatformAudit({
    actor,
    action: PLATFORM_ACTIONS.PLAN_CHANGED,
    organizationId,
    detail: { planCode: resultado.planCode, reason: `antes: ${resultado.previousPlanCode ?? "sin suscripción"}` },
  })
  return resultado
}

/** El código del plan interno, reexportado para quien sólo importa este módulo. */
export { INTERNAL_PLAN_CODE }
