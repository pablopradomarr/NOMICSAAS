import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCents } from "@/lib/money"
import type { AccessVerdict } from "@/lib/platform/subscription"
import type { PlanRow } from "@/lib/platform/types"
import Link from "next/link"

/**
 * E11 · ola C · **T22** — los bloques de `/settings/subscription` que no son el
 * uso (§10): plan actual con su estado, las facturas **de nuestra serie**, y la
 * puerta al portal de Stripe.
 *
 * Tres decisiones que no son de maquetación:
 *
 *  · **El aviso de mora lleva la fecha exacta** hasta la que dura la gracia. «Tu
 *    cuenta está en revisión» no es información: una fecha sí.
 *  · **La factura se descarga de nuestro almacén**, no del enlace de Stripe: es
 *    la copia conservada, con nuestro número de serie (C-5, I-E11-13).
 *  · **El plan se cambia en el portal de Stripe**, y no se reimplementa ni uno de
 *    sus formularios: la tarjeta y los datos fiscales viven allí.
 */

// E11 · integración — zona FIJA: sin ella el servidor formatea en UTC y el
// navegador en la del usuario, y una fecha que no coincide aborta la
// hidratación de la pantalla entera (ver `components/backups/backups-panel`).
const DATE_ES = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Madrid",
})

const STATUS_LABELS: Record<string, string> = {
  TRIALING: "en periodo de prueba",
  ACTIVE: "activa",
  PAST_DUE: "impago pendiente",
  CANCELED: "cancelada",
  INCOMPLETE: "alta sin completar",
  UNPAID: "impagada",
}

const ACCESS_LABELS: Record<string, string> = {
  FULL: "Acceso completo",
  READ_ONLY: "Sólo lectura",
  BLOCKED: "Acceso bloqueado",
}

export type SubscriptionView = {
  planCode: string
  planName: string | null
  status: string
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
} | null

export function PlanBlock({
  subscription,
  plan,
  access,
  stripeConfigured,
  internalBilling = false,
  internalNotice = null,
}: {
  subscription: SubscriptionView
  plan: PlanRow | null
  access: AccessVerdict
  stripeConfigured: boolean
  /** **ADR-0019 D9** — modo INTERNO: sin portal, sin checkout, sin facturas. */
  internalBilling?: boolean
  internalNotice?: string | null
}) {
  return (
    <section className="space-y-4" data-testid="plan-block" data-access-level={access.level}>
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Tu plan</h3>
        {subscription ? (
          <p className="text-sm">
            <strong>{plan?.name ?? subscription.planCode}</strong>{" "}
            <span className="text-muted-foreground">
              — {STATUS_LABELS[subscription.status] ?? subscription.status.toLowerCase()}
            </span>
            {plan && (
              <span className="text-muted-foreground">
                {" "}
                · {formatCents(plan.listPriceCents, { currency: plan.currency })} al{" "}
                {plan.interval === "YEAR" ? "año" : "mes"}
              </span>
            )}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="plan-empty">
            Esta organización no tiene ninguna suscripción asociada. Puedes consultar y exportar tus libros con
            normalidad mientras se regulariza.
          </p>
        )}
        {subscription?.currentPeriodEnd && (
          <p className="text-xs text-muted-foreground">
            {subscription.cancelAtPeriodEnd ? "Termina el " : "Se renueva el "}
            {DATE_ES.format(subscription.currentPeriodEnd)}
          </p>
        )}
      </div>

      <div
        className={
          access.level === "FULL"
            ? "rounded-md border px-3 py-2 text-sm"
            : "rounded-md border border-[#F5A623] bg-[#FFF8EC] px-3 py-2 text-sm"
        }
        data-testid="access-notice"
      >
        <strong>{ACCESS_LABELS[access.level] ?? access.level}.</strong>{" "}
        {access.reason ?? "Todas las funciones están disponibles."}
        {access.graceUntil && (
          <span data-testid="grace-until"> El plazo termina el {DATE_ES.format(access.graceUntil)}.</span>
        )}
        {access.level === "READ_ONLY" && (
          <span className="mt-1 block text-xs">
            Puedes seguir consultando, exportando y descargando tus datos, y registrar los hechos que ya han ocurrido:
            contra-asientos, obligaciones devengadas y el libro registro. Lo que queda en pausa es el trabajo ordinario.
          </span>
        )}
      </div>

      {/*
        **ADR-0019 D9.** En modo INTERNO no hay portal al que mandar a nadie: no
        existe cuenta de Stripe, ni tarjeta, ni factura. Se dice con esas
        palabras en vez de dejar un botón que llevaría a un 404.
      */}
      {internalBilling ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm" data-testid="internal-billing-notice">
          <strong>Modo interno: sin facturación.</strong> {internalNotice}
        </p>
      ) : stripeConfigured ? (
        <Button asChild size="sm" data-testid="stripe-portal">
          <Link href="/api/stripe/portal">Gestionar el plan, la tarjeta y los datos fiscales</Link>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="stripe-unavailable">
          La facturación no está disponible en esta instalación. El uso se muestra igualmente.
        </p>
      )}
    </section>
  )
}

export type PlatformInvoiceView = {
  id: string
  fullNumber: string
  operationDate: Date
  totalCents: number
  currency: string
  status: string
  pdfAvailable: boolean
}

export function InvoicesBlock({ invoices }: { invoices: PlatformInvoiceView[] }) {
  return (
    <section className="space-y-3" data-testid="invoices-block">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Tus facturas</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Con <strong>nuestro número de serie</strong> y la fecha de devengo, que es la que cuenta a efectos de IVA y no
          tiene por qué coincidir con la de expedición. El PDF que se descarga es la copia que conservamos nosotros.
        </p>
      </div>

      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="invoices-empty">
          Todavía no hemos emitido ninguna factura a esta organización.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Número</TableHead>
                <TableHead>Devengo</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>PDF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => (
                <TableRow key={invoice.id} data-testid={`invoice-${invoice.fullNumber}`}>
                  <TableCell className="font-mono text-xs">{invoice.fullNumber}</TableCell>
                  <TableCell className="tabular-nums">{DATE_ES.format(invoice.operationDate)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCents(invoice.totalCents, { currency: invoice.currency })}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{invoice.status.toLowerCase()}</TableCell>
                  <TableCell className="text-sm">
                    {invoice.pdfAvailable ? (
                      <Link
                        href={`/settings/subscription/invoices/${invoice.id}`}
                        className="underline underline-offset-2"
                      >
                        Descargar
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">en preparación</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
