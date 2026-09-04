import { requireOrg } from "@/lib/authz"
import { stripeClient } from "@/lib/stripe"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest) {
  // Facturación → ADMIN. El cliente de Stripe cuelga de la organización (T11).
  const { org } = await requireOrg("ADMIN")

  if (!stripeClient) {
    return new NextResponse("Stripe client is not initialized", { status: 500 })
  }

  try {
    if (!org.stripeCustomerId) {
      return NextResponse.json({ error: "No Stripe customer ID found for this organization" }, { status: 400 })
    }

    const portalSession = await stripeClient.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${request.nextUrl.origin}/settings/profile`,
    })

    return NextResponse.redirect(portalSession.url)
  } catch (error) {
    console.error("Stripe portal error:", error)
    return NextResponse.json({ error: "Failed to create Stripe portal session" }, { status: 500 })
  }
}
