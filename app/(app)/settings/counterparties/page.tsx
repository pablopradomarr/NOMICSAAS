import { CounterpartiesTable, type CounterpartyView } from "@/components/counterparties/counterparties-table"
import { OrganizationFiscalForm } from "@/components/counterparties/organization-fiscal-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Separator } from "@/components/ui/separator"
import { tenantPage } from "@/lib/page-tenant"
import { listCounterparties } from "@/models/counterparties"
import { Role } from "@/prisma/client"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Terceros y calificación fiscal",
}

/**
 * E8 · T23 — Calificación fiscal de la organización y de la contraparte
 * (`docs/design/E8-documentos-asientos.md` §4.2, ADR-0014 D11).
 *
 * Esta pantalla existe porque **hay decisiones fiscales que un documento no
 * puede tomar**: si un proveedor lleva retención, si el cliente está en recargo
 * de equivalencia, de qué país es y si la organización está en el ROI. Antes de
 * E8 todo eso se leía —o se dejaba de leer— del PDF; desde E8 sale de aquí, y lo
 * que el modelo lea sólo sirve para contrastarlo y avisar.
 */
export default tenantPage(async ({ db, org, role }) => {
  const canEdit = role === Role.ADMIN
  const rows = await listCounterparties(db)

  const counterparties: CounterpartyView[] = rows.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    taxId: c.taxId,
    countryCode: c.countryCode,
    vatNumber: c.vatNumber,
    viesValid: c.viesValid,
    viesCheckedAt: c.viesCheckedAt ? c.viesCheckedAt.toISOString().slice(0, 10) : null,
    withholdingRegime: c.withholdingRegime,
    withholdingRateCode: c.withholdingRateCode,
    surchargeRegime: c.surchargeRegime,
    isEmployee: c.isEmployee,
    isActive: c.isActive,
    notes: c.notes,
  }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Terceros y calificación fiscal"
        description="Quién es cada proveedor y cada cliente a efectos de IVA e IRPF, y en qué régimen está la organización. El motor contable lee de aquí, no del documento."
      />

      <OrganizationFiscalForm roiRegistered={org.roiRegistered} ivaRegime={org.ivaRegime} canEdit={canEdit} />

      <Separator />

      <CounterpartiesTable counterparties={counterparties} canEdit={canEdit} />
    </div>
  )
})
