import config from "@/lib/config"
import { PLANS, stripeClient } from "@/lib/stripe"
import {
  getOrganizationByStripeCustomerId,
  getOrganizationByStripeCustomerIdOrThrow,
  updateOrganization,
} from "@/models/organizations"
import { getOrCreateCloudUser } from "@/models/users"
import { NextResponse } from "next/server"
import Stripe from "stripe"

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature")
  const body = await request.text()

  if (!signature || !config.stripe.webhookSecret) {
    return new NextResponse("Webhook signature or secret missing", { status: 400 })
  }

  if (!stripeClient) {
    return new NextResponse("Stripe client is not initialized", { status: 500 })
  }

  let event: Stripe.Event

  try {
    event = stripeClient.webhooks.constructEvent(body, signature, config.stripe.webhookSecret)
  } catch (err) {
    console.error(`Webhook signature verification failed:`, err)
    return new NextResponse("Webhook signature verification failed", { status: 400 })
  }

  // E1-fix (#16): el objeto íntegro del evento lleva email, dirección de
  // facturación e importes del cliente. Al log sólo van el id y el tipo.
  console.log(`Stripe webhook recibido: ${event.id} (${event.type})`)

  // Handle the event
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const customerId = session.customer as string
        const subscriptionId = session.subscription as string
        const subscription = await stripeClient.subscriptions.retrieve(subscriptionId)

        for (const item of subscription.items.data) {
          await handleOrganizationSubscriptionUpdate(customerId, item)
        }
        break
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        for (const item of subscription.items.data) {
          await handleOrganizationSubscriptionUpdate(customerId, item)
        }
        break
      }

      default:
        console.log(`Unhandled event type ${event.type}`)
        return new NextResponse("No handler for event type", { status: 400 })
    }

    return new NextResponse("Webhook processed successfully", { status: 200 })
  } catch (error) {
    console.error("Error processing webhook:", error)
    return new NextResponse("Webhook processing failed", { status: 500 })
  }
}

/** E1 (T11): el plan, la caducidad y las cuotas son de la ORGANIZACIÓN. */
async function handleOrganizationSubscriptionUpdate(
  customerId: string,
  item: Stripe.SubscriptionItem
) {
  console.log(`Actualizando suscripción del cliente Stripe ${customerId}`)

  if (!stripeClient) {
    return new NextResponse("Stripe client is not initialized", { status: 500 })
  }

  const plan = Object.values(PLANS).find((p) => p.stripePriceId === item.price.id)
  if (!plan) {
    throw new Error(`Plan not found for price ID: ${item.price.id}`)
  }

  // `stripe_customer_id` es UNIQUE desde 20260904140100: la resolución es
  // determinista, no "la primera que aparezca" (#16).
  let organization = await getOrganizationByStripeCustomerId(customerId)
  if (!organization) {
    const customer = (await stripeClient.customers.retrieve(customerId)) as Stripe.Customer
    console.log(`Organización no encontrada para el cliente Stripe ${customerId}: se da de alta`)

    await getOrCreateCloudUser(
      customer.email as string,
      { email: customer.email as string, name: customer.name as string },
      { stripeCustomerId: customer.id }
    )
    organization = await getOrganizationByStripeCustomerIdOrThrow(customerId)
  }

  const newMembershipExpiresAt = new Date(item.current_period_end * 1000)

  await updateOrganization(organization.id, {
    membershipPlan: plan.code,
    membershipExpiresAt:
      organization.membershipExpiresAt && organization.membershipExpiresAt > newMembershipExpiresAt
        ? organization.membershipExpiresAt
        : newMembershipExpiresAt,
    storageLimit: plan.limits.storage,
    aiBalance: plan.limits.ai,
  })

  console.log(`Organización ${organization.id} actualizada al plan ${plan.code}`)
}
