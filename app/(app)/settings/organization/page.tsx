import { OrganizationSettingsForm } from "@/components/settings/organization-settings-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { requireOrg } from "@/lib/authz"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Organización",
}

export default async function OrganizationSettingsPage() {
  const { org, role } = await requireOrg("VIEWER")

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Organización"
        description="Datos fiscales y contables de la organización activa. La moneda base y la variante del PGC condicionan el plan de cuentas y los informes."
      />
      <OrganizationSettingsForm organization={org} canEdit={role === "ADMIN"} />
    </div>
  )
}
