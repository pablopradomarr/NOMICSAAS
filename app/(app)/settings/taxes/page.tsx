import type { PostableOption } from "@/components/accounts/account-map-table"
import { TaxPolicyForm } from "@/components/accounts/tax-policy-form"
import { TaxRatesTable, type TaxRateView } from "@/components/accounts/tax-rates-table"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Separator } from "@/components/ui/separator"
import { planAccounts } from "@/lib/accounts/tree"
import { requireOrg } from "@/lib/authz"
import { formatBps } from "@/lib/taxes/bps"
import { isInForce } from "@/lib/taxes/rates"
import { getPlan } from "@/models/accounts"
import { listTaxRates } from "@/models/tax-rates"
import { Role } from "@/prisma/client"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Impuestos",
}

/** `Date` → `AAAA-MM-DD` en UTC: las vigencias son `@db.Date`, sin hora. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * E2 · T11 — Tipos impositivos y política fiscal (§6).
 *
 * La vigencia se evalúa EN EL SERVIDOR con la fecha de hoy: el cliente no
 * decide qué tipo está en vigor, sólo lo pinta.
 */
export default async function TaxesSettingsPage() {
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const canEdit = role === Role.ADMIN
  const today = new Date()

  // Secuencial, por el mismo motivo que en el resto de pantallas de E2.
  const rates = await listTaxRates(db)
  const plan = await getPlan(db)
  const codeById = new Map(rates.map((rate) => [rate.id, rate.code]))

  const views: TaxRateView[] = rates.map((rate) => ({
    id: rate.id,
    code: rate.code,
    name: rate.name,
    kind: rate.kind,
    rate: formatBps(rate.rateBps),
    rateInput: formatBps(rate.rateBps),
    appliesTo: rate.appliesTo,
    accountCode: rate.accountCode,
    counterAccountCode: rate.counterAccountCode,
    linkedTaxRateId: rate.linkedTaxRateId,
    linkedCode: rate.linkedTaxRateId ? (codeById.get(rate.linkedTaxRateId) ?? null) : null,
    validFrom: isoDate(rate.validFrom),
    validTo: rate.validTo ? isoDate(rate.validTo) : null,
    inForce: isInForce(rate, today),
    isSystem: rate.isSystem,
  }))

  const options: PostableOption[] = planAccounts(plan)
    .filter((account) => account.isPostable && account.isActive)
    .map((account) => ({ code: account.code, name: account.name }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Impuestos"
        description="Tipos de IVA, IRPF y recargo de equivalencia con su vigencia, y los parámetros fiscales con los que el motor calculará las cuotas."
      />

      <TaxRatesTable rates={views} options={options} canEdit={canEdit} today={isoDate(today)} />

      <Separator />

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Política fiscal de la organización</h3>
        <TaxPolicyForm
          prorrataBps={org.prorrataBps}
          taxRoundingMode={org.taxRoundingMode}
          redondeoToleranciaCents={org.redondeoToleranciaCents}
          canEdit={canEdit}
        />
      </section>
    </div>
  )
}
