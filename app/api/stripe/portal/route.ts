/**
 * E11 · ola A · T17 — portal de facturación **por organización** (§8.2, §10).
 *
 * En el portal de Stripe se cambia de plan, la tarjeta y los datos fiscales: **no
 * se reimplementa ni uno**. Reconstruir esa pantalla significaría mantener un
 * segundo juego de datos fiscales que puede divergir del que emite las facturas.
 *
 * **Permitida en `READ_ONLY`** (§8.2): junto con el checkout, es cómo se sale del
 * impago.
 */

import { NextRequest, NextResponse } from "next/server"

import { requireOrg } from "@/lib/authz"
import { stripeClient } from "@/lib/stripe"
import { PLATFORM_ACTIONS, recordPlatformAudit } from "@/models/platform"

export async function GET(request: NextRequest) {
  // Facturación → ADMIN. El cliente de Stripe cuelga de la organización (T11).
  const { org } = await requireOrg("ADMIN")

  if (!stripeClient) {
    return NextResponse.json({ error: "La facturación no está disponible en esta instalación" }, { status: 501 })
  }

  if (!org.stripeCustomerId) {
    return NextResponse.json(
      { error: "Esta organización todavía no tiene ninguna suscripción de pago" },
      { status: 400 }
    )
  }

  try {
    const portalSession = await stripeClient.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${request.nextUrl.origin}/settings/subscription`,
    })

    await recordPlatformAudit({
      actor: "operator:portal",
      action: PLATFORM_ACTIONS.PORTAL_OPENED,
      organizationId: org.id,
      detail: { stripeCustomerId: org.stripeCustomerId },
    })

    return NextResponse.redirect(portalSession.url)
  } catch (error) {
    console.error("[stripe] no se pudo abrir el portal:", (error as Error).message)
    return NextResponse.json({ error: "No se pudo abrir el portal de facturación" }, { status: 502 })
  }
}
