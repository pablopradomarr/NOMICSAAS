"use server"

/**
 * E11 · integración — **el administrador de plataforma cambia el plan de una
 * organización** (ADR-0019 **D9**).
 *
 * En modo INTERNO no hay checkout ni portal de Stripe, así que **ésta es la
 * única forma de cambiar de plan**. Y hace falta que la haya: sin ella no se
 * puede probar que las cuotas de recurso bloquean cuando deben, ni que la cuota
 * blanda avisa sin bloquear nunca (D7). Un producto en el que los límites no se
 * pueden ejercitar es un producto en el que los límites no se saben.
 *
 * Tres cosas que no son negociables:
 *
 *  1. **Queda registrado, dos veces.** `PlatformAuditLog` con el plan de antes y
 *     el de después (`plan.changed`), y `AuditLog` de la organización. Un cambio
 *     de límites sin traza es un bloqueo de cuota que nadie sabe explicar, que
 *     es justamente el defecto que D1.3 corrige en el webhook.
 *  2. **No inventa un `SubscriptionEvent`.** Ese registro es de eventos de
 *     Stripe y su `stripe_event_id` es la idempotencia del webhook; meterle una
 *     fila sintética sería ensuciar el mecanismo que impide aplicar dos veces un
 *     reintento.
 *  3. **El plan sale del catálogo**, resuelto por vigencia. No se admite un
 *     código que no exista hoy: `resolvePlanAt` lanza y la acción lo traduce.
 */

import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { isInternalBilling } from "@/lib/platform/billing"
import { listPlans } from "@/models/plans"
import { changeOrganizationPlan } from "@/models/subscriptions"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const SUBSCRIPTION_PATH = "/settings/subscription"

/**
 * ¿Es esta persona el administrador de plataforma?
 *
 * Con `PLATFORM_ADMIN_EMAILS` puesta, manda la lista. Vacía:
 *
 *  · en modo **INTERNO**, lo es el ADMIN de la organización — en una instalación
 *    de uso interno quien opera y quien administra son la misma persona, y
 *    exigir una variable de entorno para poder cambiar de plan sería un candado
 *    sin cerradura;
 *  · en modo **`stripe`**, **nadie**: allí el plan se cambia en el portal, que es
 *    donde están la tarjeta y los datos fiscales, y un atajo por la aplicación
 *    dejaría la suscripción de Stripe y la nuestra diciendo cosas distintas.
 */
function isPlatformAdmin(email: string): boolean {
  if (config.billing.adminEmails.length > 0) {
    return config.billing.adminEmails.includes(email.trim().toLowerCase())
  }
  return isInternalBilling(config.billing.provider)
}

export type ChangePlanResult = { planCode: string; previousPlanCode: string | null }

export async function changePlanAction(formData: FormData): Promise<ActionState<ChangePlanResult>> {
  const { org, user } = await requireOrg(Role.ADMIN)

  if (!isPlatformAdmin(user.email)) {
    return {
      success: false,
      error:
        "Sólo el administrador de plataforma puede cambiar el plan de una organización. " +
        (isInternalBilling(config.billing.provider)
          ? "Configure PLATFORM_ADMIN_EMAILS con su correo."
          : "En el modo de pago el plan se cambia en el portal de Stripe."),
    }
  }

  const planCode = String(formData.get("planCode") ?? "").trim().toUpperCase()
  if (!planCode) {
    return { success: false, error: "Elige el plan que quieres asignar." }
  }

  try {
    const resultado = await changeOrganizationPlan(org.id, planCode, new Date(), `operator:${user.email}`)
    revalidatePath(SUBSCRIPTION_PATH)
    return {
      success: true,
      data: { planCode: resultado.planCode, previousPlanCode: resultado.previousPlanCode },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `No se ha podido asignar el plan ${planCode}`,
    }
  }
}

/**
 * Los códigos de plan asignables hoy. **Incluye los no vendibles** —`ILIMITADO`
 * el primero—: la lista de esta pantalla no es un escaparate comercial, es la
 * herramienta con la que el operador ejercita los límites.
 */
export async function assignablePlanCodes(): Promise<string[]> {
  const { db } = await requireOrg(Role.ADMIN)
  const plans = await listPlans(db)
  return [...new Set(plans.map((plan) => plan.code))].sort()
}
