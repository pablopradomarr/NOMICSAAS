import { SettingsPageHeader } from "@/components/settings/page-header"
import { InvoicesBlock, PlanBlock, type PlatformInvoiceView } from "@/components/subscription/subscription-blocks"
import { PlanSwitcher } from "@/components/subscription/plan-switcher"
import { UsageBars } from "@/components/subscription/usage-bars"
import { Separator } from "@/components/ui/separator"
import config from "@/lib/config"
import { INTERNAL_BILLING_NOTICE_ES, isInternalBilling } from "@/lib/platform/billing"
import { tenantPage } from "@/lib/page-tenant"
import { getPlanById, listPlans } from "@/models/plans"
import { getSubscriptionContext } from "@/models/subscriptions"
import { listPlatformInvoices } from "@/models/platform-invoices"
import { getUsage } from "@/models/usage"
import { Role } from "@/prisma/client"
import { Metadata } from "next"

export const metadata: Metadata = { title: "Suscripción y uso" }

/**
 * E11 · ola C · **T22** — `/settings/subscription` (§10).
 *
 * Cuatro bloques: plan actual con su estado y, si procede, el aviso de gracia
 * **con la fecha exacta**; el uso del mes con sus seis barras, su sello y **las
 * exclusiones declaradas** (P6); las facturas de `PlatformInvoice` con **nuestro
 * número de serie**; y el botón al portal de Stripe, donde se cambia de plan, la
 * tarjeta y los datos fiscales — no se reimplementa ni uno.
 *
 * `VIEWER` ve el **uso**, no la facturación: el consumo es información de
 * trabajo, el importe y las facturas son del ADMIN.
 *
 * Sin Stripe configurado (self-hosted) la página dice «facturación no disponible
 * en esta instalación» y enseña el uso igual: una instalación propia no deja de
 * tener derecho a saber cuánto está consumiendo.
 *
 * Todo lo que se pinta viene calculado del servidor. El único cálculo del
 * cliente es el ancho de la barra, y está marcado como feedback visual.
 */
export default tenantPage(async ({ db, org, role }) => {
  const isAdmin = role === Role.ADMIN
  const now = new Date()

  // En SERIE dentro de la transacción de `tenantPage`: una conexión por
  // petición (E6-perf). `getUsage` y `getSubscriptionContext` entran en la
  // transacción abierta en vez de tomar otra del pool.
  /**
   * **E11 · integración** — sin el puente `platformDeployment()`: su comentario
   * ya decía que era «un puente con fecha de caducidad», y la fecha es hoy.
   */
  const interno = isInternalBilling(config.billing.provider)
  const context = await getSubscriptionContext(org.id, now, { organizationIsActive: org.isActive })
  const plan = context.subscription ? await getPlanById(db, context.subscription.planId) : null
  const usage = await getUsage(org.id, now)
  // **ADR-0019 D9** — en modo INTERNO no hay facturas de plataforma que listar,
  // porque no se emite ninguna: sin contraprestación no hay operación sujeta
  // (art. 4.Uno LIVA) y una factura a cero no documenta nada.
  const invoiceRows = isAdmin && !interno ? await listPlatformInvoices(db, 24) : []
  // La lista incluye los planes NO vendibles (`ILIMITADO` entre ellos): esto no
  // es un escaparate, es la herramienta con la que se ejercitan los límites.
  const planCodes = isAdmin && interno ? [...new Set((await listPlans(db)).map((row) => row.code))].sort() : []

  const invoices: PlatformInvoiceView[] = invoiceRows.map((invoice) => ({
    id: invoice.id,
    fullNumber: invoice.fullNumber,
    operationDate: invoice.operationDate,
    totalCents: invoice.totalCents,
    currency: invoice.currency,
    status: invoice.status,
    pdfAvailable: invoice.storedObjectId !== null,
  }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Suscripción y uso"
        description="Tu plan, lo que llevas consumido este mes y las facturas que te hemos emitido. El uso se deriva de tus propios datos cada vez que cambian: no hay ningún contador guardado que pueda quedarse viejo."
      />

      {isAdmin ? (
        <PlanBlock
          subscription={
            context.subscription
              ? {
                  planCode: context.subscription.planCode,
                  planName: plan?.name ?? null,
                  status: String(context.subscription.status),
                  currentPeriodEnd: context.subscription.currentPeriodEnd,
                  cancelAtPeriodEnd: context.subscription.cancelAtPeriodEnd,
                }
              : null
          }
          plan={plan}
          access={context.access}
          stripeConfigured={Boolean(config.stripe.secretKey)}
          internalBilling={interno}
          internalNotice={INTERNAL_BILLING_NOTICE_ES}
        />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="viewer-notice">
          Tu rol te deja ver el consumo de la organización. El plan y las facturas los gestiona quien la administra.
        </p>
      )}

      {isAdmin && interno && planCodes.length > 0 && (
        <>
          <Separator />
          <PlanSwitcher planCodes={planCodes} currentCode={context.subscription?.planCode ?? null} />
        </>
      )}

      <Separator />

      <UsageBars
        figures={usage.figures}
        limits={context.limits}
        computedAt={usage.computedAt}
        gitSha={usage.gitSha}
        fromCache={usage.fromCache}
        periodMonth={usage.periodMonth}
      />

      {isAdmin && !interno && (
        <>
          <Separator />
          <InvoicesBlock invoices={invoices} />
        </>
      )}
    </div>
  )
})
