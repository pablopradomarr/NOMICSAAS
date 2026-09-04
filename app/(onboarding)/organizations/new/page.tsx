import { NewOrganizationForm } from "@/components/settings/new-organization-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { getCurrentUser } from "@/lib/auth"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Nueva organización",
}

export default async function NewOrganizationPage() {
  // No exige rol: cualquier usuario autenticado puede crear su organización.
  await getCurrentUser()

  return (
    <div className="space-y-8 p-10 pb-16">
      <SettingsPageHeader
        title="Nueva organización"
        description="Cada organización tiene sus propios datos, su plan de cuentas y sus miembros. Serás su administrador."
      />
      <NewOrganizationForm />
    </div>
  )
}
