/**
 * E11 · ola A · T17 — checkout **por organización** (§8.2, ADR-0019 D1).
 *
 * El de TaxHacker no pedía sesión: cualquiera podía crear una sesión de pago
 * para cualquier plan, y la suscripción quedaba colgando de un cliente de Stripe
 * que el webhook no sabía a quién atribuir — el mismo agujero por el que el
 * webhook acababa dando de alta tenants.
 *
 * Aquí: **ADMIN de la organización activa**, el `customer` de Stripe es el de
 * ESA organización, y el plan sale del **catálogo versionado** (`plans`), no de
 * una constante de TypeScript.
 *
 * **Permitida en `READ_ONLY`** (§8.2): es cómo se sale del impago. Denegarla
 * sería encerrar al cliente en la mora.
 */

import { NextRequest, NextResponse } from "next/server"

import config from "@/lib/config"
import { tenantDb } from "@/lib/db"
import { requireOrg } from "@/lib/authz"
import { assertB2BSellable, PlatformInvoiceError } from "@/lib/platform/invoice"
import { isSellable } from "@/lib/platform/plan"
import { stripeClient } from "@/lib/stripe"
import { getPlanAt } from "@/models/plans"
import { PLATFORM_ACTIONS, recordPlatformAudit } from "@/models/platform"
import { getSubscription } from "@/models/subscriptions"

export async function POST(request: NextRequest) {
  // Facturación → ADMIN. El cliente de Stripe cuelga de la organización (T11).
  const { org } = await requireOrg("ADMIN")

  const code = new URL(request.url).searchParams.get("code")
  if (!code) return NextResponse.json({ error: "Falta el código de plan" }, { status: 400 })

  if (!stripeClient) {
    return NextResponse.json({ error: "La facturación no está disponible en esta instalación" }, { status: 501 })
  }

  const db = tenantDb(org.id)
  const refDate = new Date()

  let plan
  try {
    plan = await getPlanAt(db, code, refDate)
  } catch {
    return NextResponse.json({ error: `No hay ningún plan «${code}» vigente hoy` }, { status: 400 })
  }

  // P-1 · **FREE no es vendible**: se ofrece en el alta, pero sin precio en
  // Stripe no hay checkout. Y un plan de pago cuyo precio todavía no se ha
  // creado en Stripe tampoco se puede contratar: mejor un error claro que una
  // sesión de pago rota.
  if (!isSellable(plan)) {
    return NextResponse.json(
      { error: `El plan ${plan.name} no se puede contratar todavía: no tiene precio publicado` },
      { status: 400 }
    )
  }

  // P-1 · B2B-only con NIF-IVA obligatorio fuera de España (C-1). Se comprueba
  // ANTES del checkout, no al facturar: descubrir en el devengo que no se puede
  // aplicar la no sujeción obliga a repercutir el 21 % a quien no lo esperaba.
  const sub = await getSubscription(db)
  try {
    assertB2BSellable({
      country: sub?.customerCountry ?? "ES",
      vatNumber: sub?.vatNumber ?? null,
      viesValid: null,
    })
  } catch (e) {
    if (e instanceof PlatformInvoiceError) return NextResponse.json({ error: e.message }, { status: 400 })
    throw e
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      // El cliente de Stripe es el de ESTA organización: sin esto, el webhook no
      // puede resolver el tenant y el evento acaba en `ORPHAN_WEBHOOK`.
      ...(org.stripeCustomerId ? { customer: org.stripeCustomerId } : {}),
      billing_address_collection: "required",
      line_items: [{ price: plan.stripePriceId!, quantity: 1 }],
      mode: "subscription",
      // Stripe Tax calcula; la PRUEBA y la responsabilidad son nuestras (C-1).
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      allow_promotion_codes: true,
      client_reference_id: org.id,
      success_url: config.stripe.paymentSuccessUrl,
      cancel_url: config.stripe.paymentCancelUrl,
    })

    if (!session.url) {
      return NextResponse.json({ error: "Stripe no devolvió una URL de pago" }, { status: 502 })
    }

    await recordPlatformAudit({
      actor: "operator:checkout",
      action: PLATFORM_ACTIONS.CHECKOUT_STARTED,
      organizationId: org.id,
      detail: { planCode: plan.code, stripePriceId: plan.stripePriceId, stripeCustomerId: org.stripeCustomerId },
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    // §9.2 · al log, el motivo; nunca el objeto de Stripe.
    console.error("[stripe] no se pudo crear la sesión de pago:", (error as Error).message)
    return NextResponse.json({ error: "No se pudo iniciar el pago" }, { status: 502 })
  }
}
