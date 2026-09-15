/**
 * E11 · integración — **el modo de facturación** (ADR-0019 **D9**, aprobado por
 * Pablo el 2026-09-15).
 *
 * > **La decisión, textual:** *el SaaS es de USO INTERNO y no se cobra. Sin
 * > Stripe, sin facturas de plataforma, sin cobro. Toda organización nace con el
 * > plan `ILIMITADO`. `READ_ONLY` por impago NUNCA en modo INTERNO.*
 *
 * Dos modos, y uno solo activo por despliegue:
 *
 * | `BILLING_PROVIDER` | Qué significa |
 * |---|---|
 * | **`none`** (por defecto) | **INTERNO.** Plan `ILIMITADO`, acceso `FULL` siempre, `/api/stripe/*` responde **404**, `/settings/subscription` enseña plan y uso sin portal ni facturas |
 * | `stripe` | Lo que describen D1…D8: catálogo de planes, mora, gracia, serie de facturación propia |
 *
 * ## Por qué el modo entra por parámetro y no se lee aquí
 *
 * Este módulo es **PURO**: no importa `lib/config`, no lee `process.env` y no
 * mira el reloj. El modo lo pasa quien llama, exactamente igual que `refDate`.
 * Así los tests del modo `stripe` —que son los que ya existían— **no cambian ni
 * una línea**: el valor por defecto de todo parámetro `provider` es `"stripe"`,
 * que es el comportamiento que esas suites describen.
 *
 * ## Por qué `ILIMITADO` es una fila del catálogo y no un objeto en TypeScript
 *
 * Porque el catálogo es la fuente de los límites (D1.1) y `Subscription.planId`
 * apunta a una **versión**. Un plan que viviera en una constante volvería a ser
 * exactamente el defecto que E11 vino a cerrar: «el plan vive en una constante
 * de TypeScript (`PLANS` en `lib/stripe.ts`)». La fila la siembra la migración
 * M6, no es vendible (`is_public = false`, sin `stripe_price_id`) y tiene los
 * siete límites a `-1`.
 */

import type { AccessLevel, PlanLimits } from "./types"
import { UNLIMITED } from "./types"

export type BillingProvider = "none" | "stripe"

/** Código del plan interno. Lo siembra la migración M6; aquí sólo se nombra. */
export const INTERNAL_PLAN_CODE = "ILIMITADO"

/** El plan que la instalación asigna al alta, según el modo. */
export function defaultPlanCodeFor(provider: BillingProvider): string {
  return provider === "none" ? INTERNAL_PLAN_CODE : "FREE"
}

/** ¿Está encendido el módulo de Stripe? Lo consultan las rutas `/api/stripe/*`. */
export function isStripeEnabled(provider: BillingProvider): boolean {
  return provider === "stripe"
}

/** ¿Estamos en modo INTERNO? Azúcar legible, para que nadie compare cadenas. */
export function isInternalBilling(provider: BillingProvider): boolean {
  return provider === "none"
}

/**
 * Los límites del modo INTERNO: **los siete a `-1`**.
 *
 * Es la misma forma que la fila `ILIMITADO` del catálogo, y sirve de red cuando
 * la fila todavía no está sembrada (una instalación a medio migrar). Nunca se
 * usa para *rebajar* nada: `-1` lo resuelve `checkLimit` antes de mirar el uso.
 *
 * `backupRetentionDays` es **3650 días** (el plazo largo del art. 26.5 LIS) y no
 * `-1`: el CHECK `plans_gracia_no_negativa` exige `> 0`, y con razón — una
 * retención de cero caducaría el ZIP en el instante de crearlo. En uso interno
 * no hay motivo para destruir una copia a los treinta días.
 */
export const INTERNAL_PLAN_LIMITS: PlanLimits = {
  maxMembers: Number(UNLIMITED),
  maxOcrDocsMonth: Number(UNLIMITED),
  maxStorageBytes: UNLIMITED,
  maxExportsMonth: Number(UNLIMITED),
  maxBackupsMonth: Number(UNLIMITED),
  maxOrganizations: Number(UNLIMITED),
  softMaxEntriesMonth: Number(UNLIMITED),
  graceDays: 0,
  backupRetentionDays: 3650,
}

/**
 * **El acceso en modo INTERNO**, y la única excepción que admite.
 *
 * `FULL` siempre. Lo único que sigue produciendo `BLOCKED` es la desactivación
 * que decide el propio ADMIN de la organización, que no es una mora nuestra sino
 * una decisión suya — y que D6 ya reservaba para eso.
 *
 * Devuelve `null` cuando el modo no es interno, para que el llamante siga con
 * `accessLevelOf` sin un `if` repartido por treinta ficheros.
 */
export function internalAccessLevel(
  provider: BillingProvider,
  opts: { organizationIsActive?: boolean } = {}
): { level: AccessLevel; reason: string | null; graceUntil: null } | null {
  if (provider !== "none") return null
  if (opts.organizationIsActive === false) {
    return { level: "BLOCKED", reason: "La organización está desactivada por su administrador.", graceUntil: null }
  }
  return { level: "FULL", reason: null, graceUntil: null }
}

/** Texto de la pantalla de suscripción en modo INTERNO. Una sola redacción. */
export const INTERNAL_BILLING_NOTICE_ES =
  "Modo interno: sin facturación. Esta instalación no cobra, no emite facturas de plataforma y no tiene " +
  "ningún límite de plan activo. Lo que ves abajo es el consumo real de la organización, derivado de tus " +
  "propios datos: sirve para dimensionar, no para facturar."
