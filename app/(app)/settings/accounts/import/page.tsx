import { AccountImportWizard } from "@/components/accounts/account-import-wizard"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { AuthzError, requireOrg } from "@/lib/authz"
import { Role } from "@/prisma/client"
import { Metadata } from "next"
import { notFound, redirect } from "next/navigation"

export const metadata: Metadata = {
  title: "Importar plan de cuentas",
}

/**
 * E2 · T11 — Import de un plan propio (§6). Sólo ADMIN: quien no lo es recibe
 * 404, para no confirmar siquiera que la pantalla existe (mismo criterio que
 * `/settings/members` en E1).
 */
export default async function ImportPlanPage() {
  try {
    await requireOrg(Role.ADMIN)
  } catch (error) {
    if (error instanceof AuthzError) {
      if (error.code === "NO_ORGANIZATION") redirect("/organizations/new")
      notFound()
    }
    throw error
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Importar plan de cuentas"
        description="Carga un cuadro de cuentas propio desde CSV. El diff se calcula en el servidor y se previsualiza antes de escribir nada."
      />
      <AccountImportWizard />
    </div>
  )
}
