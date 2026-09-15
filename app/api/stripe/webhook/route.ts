/**
 * E11 · ola A · T17 — webhook de Stripe, **reescrito** (§8.3, ADR-0019 D1.3).
 *
 * El de TaxHacker tenía tres defectos que no se podían parchear por separado:
 *
 *  1. **No era idempotente.** Stripe reintenta por diseño y el efecto se
 *     aplicaba otra vez. Ahora la idempotencia es el `UNIQUE` de
 *     `subscription_events.stripe_event_id`: el mismo evento entregado tres
 *     veces produce **un** `SubscriptionEvent`, **una** transición y `200` las
 *     tres (I-E11-9, criterio 2).
 *  2. **Daba de alta usuarios y organizaciones.** Si no encontraba el
 *     `stripeCustomerId`, `getOrCreateCloudUser` creaba un tenant con el email
 *     del cliente. **Un webhook no puede crear tenants**: ahora responde `200`
 *     con `ORPHAN_WEBHOOK` y no escribe nada más que su línea de auditoría
 *     (criterio 3).
 *  3. **Devolvía `400` a todo evento no manejado**, que Stripe interpreta como
 *     fallo y **reintenta indefinidamente**. Ahora devuelve `200` y lo registra
 *     (criterio 4).
 *
 * **El único `4xx` es la firma inválida.** Cualquier otra cosa que Stripe no
 * pueda arreglar reintentando es un `200` con motivo: un reintento eterno no
 * corrige un dato que falta en nuestro lado, sólo llena el log.
 */

import { NextResponse } from "next/server"
import type Stripe from "stripe"

import config from "@/lib/config"
import { stripeModuleOff } from "../disabled"
import { mapStripeStatus } from "@/lib/platform/subscription"
import { stripeClient } from "@/lib/stripe"
import { getPlanByStripePriceId } from "@/models/plans"
import { PLATFORM_ACTIONS, recordPlatformAudit } from "@/models/platform"
import { consumeRateLimit, RATE_LIMIT_SCOPES } from "@/models/rate-limit"
import {
  applySubscriptionTransition,
  DuplicateStripeEventError,
  getSubscription,
  organizationIdByStripeCustomer,
  recordSubscriptionEvent,
} from "@/models/subscriptions"
import { tenantDb } from "@/lib/db"
import { issuePlatformInvoice } from "@/models/platform-invoices"
import type { RectificationMode } from "@/prisma/client"

/** Los eventos que esta ruta manda a algún sitio. El resto: `200` y registro. */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "credit_note.created",
])

/** §9.3 · cubo por IP: 300 eventos cada 5 min sobran para el tráfico real. */
const WEBHOOK_LIMIT = 300
const WEBHOOK_WINDOW_MS = 5 * 60 * 1000

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return request.headers.get("x-real-ip") ?? "desconocida"
}

function unixToDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null
}

export async function POST(request: Request) {
  // **ADR-0019 D9** — Stripe apagado: 404 antes de verificar firma o consumir cuota.
  const apagado = stripeModuleOff()
  if (apagado) return apagado

  const signature = request.headers.get("stripe-signature")
  const body = await request.text()

  if (!stripeClient || !config.stripe.webhookSecret) {
    // Sin Stripe configurado (self-hosted) la ruta no existe funcionalmente.
    // `501` y no `500`: no es un fallo, es una función que esta instalación no
    // tiene, y el operador lo lee distinto.
    return NextResponse.json({ error: "Stripe no está configurado en esta instalación" }, { status: 501 })
  }

  const ip = clientIp(request)
  const cubo = await consumeRateLimit(RATE_LIMIT_SCOPES.STRIPE_WEBHOOK, ip, {
    limit: WEBHOOK_LIMIT,
    windowMs: WEBHOOK_WINDOW_MS,
    at: new Date(),
  })
  if (!cubo.allowed) {
    // `429` y no `200`: aquí Stripe SÍ debe reintentar, porque el evento es
    // legítimo y el rechazo es nuestro.
    return NextResponse.json({ error: "Demasiadas peticiones" }, { status: 429 })
  }

  let event: Stripe.Event
  try {
    if (!signature) throw new Error("falta la cabecera stripe-signature")
    // La verificación de `constructEvent` ya compara en tiempo constante.
    event = stripeClient.webhooks.constructEvent(body, signature, config.stripe.webhookSecret)
  } catch (err) {
    await recordPlatformAudit({
      actor: "stripe",
      action: PLATFORM_ACTIONS.WEBHOOK_SIGNATURE_INVALID,
      detail: { reason: (err as Error).message },
    })
    return new NextResponse("Firma del webhook no verificada", { status: 400 })
  }

  // §9.2 · al log van id y tipo. NUNCA el objeto íntegro, que lleva email,
  // dirección de facturación e importes del cliente (regla de E1 #16).
  await recordPlatformAudit({
    actor: "stripe",
    action: PLATFORM_ACTIONS.WEBHOOK_RECEIVED,
    detail: { stripeEventId: event.id, stripeEventType: event.type },
  })

  if (!HANDLED.has(event.type)) {
    await recordPlatformAudit({
      actor: "stripe",
      action: PLATFORM_ACTIONS.WEBHOOK_UNHANDLED,
      detail: { stripeEventId: event.id, stripeEventType: event.type },
    })
    // Criterio 4: `200`, y Stripe no reintenta.
    return NextResponse.json({ received: true, handled: false }, { status: 200 })
  }

  const customerId = customerIdOf(event)
  if (!customerId) {
    await recordPlatformAudit({
      actor: "stripe",
      action: PLATFORM_ACTIONS.WEBHOOK_ORPHAN,
      detail: { stripeEventId: event.id, stripeEventType: event.type, reason: "SIN_CLIENTE" },
    })
    return NextResponse.json({ received: true, orphan: "ORPHAN_WEBHOOK" }, { status: 200 })
  }

  const organizationId = await organizationIdByStripeCustomer(customerId)
  if (!organizationId) {
    // Criterio 3 · **un webhook no puede crear tenants**. Ni un usuario, ni una
    // organización, ni una suscripción. Queda la línea de auditoría, que es lo
    // que permite descubrir el cliente de Stripe que nadie reclamó.
    await recordPlatformAudit({
      actor: "stripe",
      action: PLATFORM_ACTIONS.WEBHOOK_ORPHAN,
      detail: { stripeEventId: event.id, stripeEventType: event.type, stripeCustomerId: customerId },
    })
    return NextResponse.json({ received: true, orphan: "ORPHAN_WEBHOOK" }, { status: 200 })
  }

  try {
    await handle(event, organizationId, customerId)
  } catch (e) {
    if (e instanceof DuplicateStripeEventError) {
      // Criterio 2: ya aplicado. `200`, y ni una transición más.
      await recordPlatformAudit({
        actor: "stripe",
        action: PLATFORM_ACTIONS.WEBHOOK_DUPLICATE,
        organizationId,
        detail: { stripeEventId: event.id, stripeEventType: event.type },
      })
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 })
    }
    // Un fallo real SÍ merece que Stripe reintente: `500`.
    console.error(`[stripe] fallo procesando ${event.id} (${event.type}):`, (e as Error).message)
    return NextResponse.json({ error: "No se pudo procesar el evento" }, { status: 500 })
  }

  return NextResponse.json({ received: true, handled: true }, { status: 200 })
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolución del cliente
// ─────────────────────────────────────────────────────────────────────────────

function customerIdOf(event: Stripe.Event): string | null {
  const obj = event.data.object as { customer?: string | { id: string } | null }
  const c = obj.customer
  if (!c) return null
  return typeof c === "string" ? c : c.id
}

// ─────────────────────────────────────────────────────────────────────────────
// Los ocho eventos
// ─────────────────────────────────────────────────────────────────────────────

async function handle(event: Stripe.Event, organizationId: string, customerId: string): Promise<void> {
  const occurredAt = new Date(event.created * 1000)
  const refDate = occurredAt

  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = await subscriptionOf(event)
      if (!subscription) {
        await recordSubscriptionEvent(organizationId, {
          stripeEventId: event.id,
          eventType: event.type,
          occurredAt,
          payload: { stripeCustomerId: customerId, reason: "SIN_SUSCRIPCION" },
        })
        return
      }

      const priceId = subscription.items.data[0]?.price?.id ?? null
      const plan = priceId ? await getPlanByStripePriceId(tenantDb(organizationId), priceId) : null

      // Un `price` que no está en el catálogo NO se adivina: se registra el
      // evento y se deja el plan como está. Inventar un plan a partir de un
      // importe sería decidir por el cliente qué límites tiene contratados.
      const statusStripe = event.type === "customer.subscription.deleted" ? "canceled" : subscription.status

      const { statusBefore } = await applySubscriptionTransition(
        organizationId,
        {
          ...(plan ? { planCode: plan.code, planId: plan.id } : {}),
          stripeSubscriptionId: subscription.id,
          status: mapStripeStatus(statusStripe),
          currentPeriodStart: unixToDate(subscriptionPeriod(subscription).start),
          currentPeriodEnd: unixToDate(subscriptionPeriod(subscription).end),
          cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
          trialEnd: unixToDate(subscription.trial_end),
        },
        {
          stripeEventId: event.id,
          eventType: event.type,
          occurredAt,
          // §9.2 · payload RECORTADO: ids, tipo, precio, periodo y estado.
          payload: {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            stripePriceId: priceId,
            stripeStatus: statusStripe,
            planCode: plan?.code ?? null,
          },
        },
        refDate
      )

      await recordPlatformAudit({
        actor: "stripe",
        action: PLATFORM_ACTIONS.SUBSCRIPTION_TRANSITION,
        organizationId,
        detail: {
          stripeEventId: event.id,
          stripeEventType: event.type,
          statusBefore,
          statusAfter: mapStripeStatus(statusStripe),
          planCode: plan?.code ?? null,
        },
      })
      return
    }

    case "invoice.finalized": {
      await issueFromStripeInvoice(event, organizationId, customerId, occurredAt, null)
      return
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice
      await recordSubscriptionEvent(organizationId, {
        stripeEventId: event.id,
        eventType: event.type,
        occurredAt,
        payload: {
          stripeCustomerId: customerId,
          stripeInvoiceId: invoice.id ?? null,
          stripeStatus: invoice.status ?? null,
        },
      })
      return
    }

    case "credit_note.created": {
      // C-3 · una nota de crédito modifica una base ya repercutida: **factura
      // rectificativa** en la serie `PLT-R`, con referencia inequívoca, causa y
      // modo (art. 15 RD 1619/2012).
      await issueFromCreditNote(event, organizationId, customerId, occurredAt)
      return
    }
  }
}

/** El objeto `Subscription` del evento, recuperándolo si sólo viene el id. */
async function subscriptionOf(event: Stripe.Event): Promise<Stripe.Subscription | null> {
  if (event.type.startsWith("customer.subscription.")) {
    return event.data.object as Stripe.Subscription
  }
  const session = event.data.object as Stripe.Checkout.Session
  const ref = session.subscription
  if (!ref) return null
  if (typeof ref !== "string") return ref
  if (!stripeClient) return null
  return await stripeClient.subscriptions.retrieve(ref)
}

/**
 * El periodo vigente. Stripe lo mueve entre la suscripción y su primer item
 * según la versión de la API; se leen los dos y se prefiere el del item, que es
 * donde vive en las versiones recientes.
 */
function subscriptionPeriod(sub: Stripe.Subscription): { start: number | null; end: number | null } {
  const item = sub.items?.data?.[0] as { current_period_start?: number; current_period_end?: number } | undefined
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number }
  return {
    start: item?.current_period_start ?? legacy.current_period_start ?? null,
    end: item?.current_period_end ?? legacy.current_period_end ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Emisión de NUESTRA factura (T18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consulta VIES. **Se deja explícitamente sin implementar aquí**: el cliente de
 * VIES es un servicio externo y esta ruta es pura orquestación.
 *
 * Lo que sí queda fijado es la **regla ante el fallo** (R-5, C-1): devolver
 * `null` significa «no se pudo comprobar», y `resolveTaxTreatment` repercute
 * entonces el 21 %. **Nunca se presume válido.** Mientras no haya cliente VIES,
 * el resultado es `null` y la factura sale con IVA: conservador, rectificable, y
 * jamás una cuota sin ingresar.
 */
async function validateVies(_vatNumber: string | null): Promise<{ valid: boolean | null; source: string; ref: string | null }> {
  return { valid: null, source: "SIN_VERIFICAR", ref: null }
}

async function issueFromStripeInvoice(
  event: Stripe.Event,
  organizationId: string,
  customerId: string,
  occurredAt: Date,
  rectifies: { invoiceId: string; cause: string; mode: RectificationMode } | null
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice
  if (!invoice.id) return

  const db = tenantDb(organizationId)
  const sub = await getSubscription(db)

  const vies = await validateVies(sub?.vatNumber ?? null)
  const linea = invoice.lines?.data?.[0] as { period?: { start: number; end: number } } | undefined
  const periodStart = unixToDate(linea?.period?.start) ?? new Date(invoice.created * 1000)
  const periodEnd = unixToDate(linea?.period?.end)

  const emitida = await issuePlatformInvoice({
    organizationId,
    facts: {
      stripeInvoiceId: invoice.id,
      subscriptionId: sub?.id ?? null,
      periodStart,
      periodEnd,
      // El cobro sólo adelanta el devengo si es ANTERIOR a la exigibilidad (C-2).
      paidAt: invoice.status === "paid" ? occurredAt : null,
      issuedAt: occurredAt,
      subtotalCents: invoice.subtotal ?? 0,
      taxCents: (invoice.total ?? 0) - (invoice.subtotal ?? 0),
      totalCents: invoice.total ?? 0,
      currency: (invoice.currency ?? "eur").toUpperCase(),
      status: invoice.status ?? "open",
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    },
    recipient: {
      country: sub?.customerCountry ?? "ES",
      vatNumber: sub?.vatNumber ?? null,
      viesValid: vies.valid,
    },
    vatValidatedAt: vies.valid === null ? null : occurredAt,
    vatValidationSource: vies.valid === null ? null : vies.source,
    vatValidationRef: vies.ref,
    ...(rectifies ? { rectifies } : {}),
  })

  await recordSubscriptionEvent(organizationId, {
    stripeEventId: event.id,
    eventType: event.type,
    occurredAt,
    payload: {
      stripeCustomerId: customerId,
      stripeInvoiceId: invoice.id,
      fullNumber: emitida.fullNumber,
      ivaPeriod: emitida.ivaPeriod,
    },
  })

  await recordPlatformAudit({
    actor: "stripe",
    action: rectifies ? PLATFORM_ACTIONS.PLATFORM_INVOICE_RECTIFIED : PLATFORM_ACTIONS.PLATFORM_INVOICE_ISSUED,
    organizationId,
    detail: {
      stripeEventId: event.id,
      stripeInvoiceId: invoice.id,
      fullNumber: emitida.fullNumber,
      taxTreatment: emitida.taxTreatment,
      ivaPeriod: emitida.ivaPeriod,
    },
  })
}

async function issueFromCreditNote(
  event: Stripe.Event,
  organizationId: string,
  customerId: string,
  occurredAt: Date
): Promise<void> {
  const nota = event.data.object as Stripe.CreditNote
  const facturaStripe = typeof nota.invoice === "string" ? nota.invoice : nota.invoice?.id
  const db = tenantDb(organizationId)

  const original = facturaStripe
    ? await db.platformInvoice.findFirst({ where: { stripeInvoiceId: facturaStripe } })
    : null

  if (!original) {
    // Sin la factura original no hay «referencia inequívoca a la rectificada»
    // (art. 15.2 RD 1619/2012), así que **no se emite una rectificativa huérfana**:
    // se deja registrado el hecho y se responde 200.
    await recordSubscriptionEvent(organizationId, {
      stripeEventId: event.id,
      eventType: event.type,
      occurredAt,
      payload: { stripeCustomerId: customerId, stripeInvoiceId: facturaStripe ?? null, reason: "SIN_ORIGINAL" },
    })
    return
  }

  const sub = await getSubscription(db)

  const emitida = await issuePlatformInvoice({
    organizationId,
    facts: {
      // La rectificativa es un documento NUESTRO con su propio identificador de
      // origen: se indexa por el id de la nota de crédito, no por el de la
      // factura original, que ya está ocupado.
      stripeInvoiceId: nota.id,
      subscriptionId: sub?.id ?? null,
      periodStart: original.periodStart ?? original.operationDate,
      periodEnd: original.periodEnd,
      paidAt: null,
      issuedAt: occurredAt,
      // Signo negativo: minora la base ya repercutida (art. 89 LIVA).
      subtotalCents: -(nota.subtotal ?? 0),
      taxCents: -((nota.total ?? 0) - (nota.subtotal ?? 0)),
      totalCents: -(nota.total ?? 0),
      currency: (nota.currency ?? "eur").toUpperCase(),
      status: "issued",
      hostedInvoiceUrl: nota.pdf ?? null,
    },
    recipient: {
      country: original.customerCountry,
      vatNumber: original.vatNumber,
      viesValid: null,
    },
    // **La rectificativa conserva el régimen de la original**: rectificar no es
    // recalificar la operación, y volver a consultar VIES hoy podría convertir
    // en «repercutido» la rectificación de una operación que en su devengo NO
    // estaba sujeta (art. 89 LIVA: se rectifica lo repercutido, no se rehace).
    forceTreatment: {
      treatment: original.taxTreatment,
      mention: original.reverseChargeMention,
    },
    vatValidatedAt: original.vatValidatedAt,
    vatValidationSource: original.vatValidationSource,
    vatValidationRef: original.vatValidationRef,
    rectifies: {
      invoiceId: original.id,
      cause: (nota.reason ?? "Rectificación de la operación documentada").slice(0, 256),
      mode: "DIFERENCIAS",
    },
  })

  await recordSubscriptionEvent(organizationId, {
    stripeEventId: event.id,
    eventType: event.type,
    occurredAt,
    payload: {
      stripeCustomerId: customerId,
      stripeInvoiceId: nota.id,
      fullNumber: emitida.fullNumber,
      ivaPeriod: emitida.ivaPeriod,
    },
  })

  await recordPlatformAudit({
    actor: "stripe",
    action: PLATFORM_ACTIONS.PLATFORM_INVOICE_RECTIFIED,
    organizationId,
    detail: { stripeEventId: event.id, fullNumber: emitida.fullNumber, ivaPeriod: emitida.ivaPeriod },
  })
}
