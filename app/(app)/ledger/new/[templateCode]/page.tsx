import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { dimensionOptions } from "@/app/(app)/analytics/shared"
import { postableAccounts, taxRateOptions } from "@/app/(app)/ledger/shared"
import { TemplateForm } from "@/components/ledger/template-form"
import { Button } from "@/components/ui/button"
import { requireOrg } from "@/lib/authz"
import { templateFormSpec } from "@/lib/ledger-ui/template-fields"
import { isTemplateCode, TEMPLATES } from "@/lib/ledger/templates"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ templateCode: string }>
}): Promise<Metadata> {
  const { templateCode } = await params
  const label = isTemplateCode(templateCode) ? TEMPLATES[templateCode].label : "Nuevo asiento"
  return { title: label }
}

/**
 * E3 · T11 — Formulario de una plantilla de asiento (T-01…T-24).
 *
 * El formulario **se genera del schema zod de la plantilla**
 * (`templateFormSpec`), que es el mismo que valida la acción del servidor: la
 * pantalla no puede pedir campos que el motor no entienda ni olvidarse de uno.
 *
 * Las tres fechas: documento y devengo se piden; la **fecha contable** la
 * calcula `resolveEntryDate` en el servidor y aparece en la vista previa con su
 * motivo (mes bloqueado → primer mes abierto).
 */
export default async function TemplateEntryPage({ params }: { params: Promise<{ templateCode: string }> }) {
  const { templateCode } = await params
  if (!isTemplateCode(templateCode)) notFound()

  const template = TEMPLATES[templateCode]
  // Las cuatro de cierre no tienen acción de usuario en E3 (§1): llegan en E9.
  if (template.systemOnly) notFound()

  const { db, role } = await requireOrg(Role.VIEWER)
  const canPost = role === Role.EDITOR || role === Role.ADMIN
  const accounts = await postableAccounts(db)
  const taxRates = await taxRateOptions(db)
  const listing = await listAnalyticsAction({})
  const dimensions = dimensionOptions(listing.data?.projects ?? [], listing.data?.costCenters ?? [])
  const spec = templateFormSpec(template.code, template.label, template.block, template.schema)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{template.label}</h1>
          <p className="font-code text-xs text-muted-foreground">{template.code}</p>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Los importes se escriben en euros y el servidor los convierte a céntimos. Las cuentas de contrapartida las
            resuelve el mapa de cuentas de la organización y los tipos impositivos, los vigentes a la fecha del
            documento: aquí no se teclea ninguna cuenta que decida el motor.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/ledger/new">Cambiar de plantilla</Link>
        </Button>
      </div>

      <TemplateForm
        spec={spec}
        accounts={accounts}
        taxRates={taxRates}
        canPost={canPost}
        defaultDate={todayLocalDate()}
        dimensions={dimensions}
      />
    </div>
  )
}
