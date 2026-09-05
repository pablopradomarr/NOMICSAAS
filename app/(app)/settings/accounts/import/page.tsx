import { AccountImportWizard } from "@/components/accounts/account-import-wizard"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Importar plan de cuentas",
}

/**
 * E2 · T11 — Import de un plan propio (§6). Sólo ADMIN: quien no lo es recibe
 * 404, para no confirmar siquiera que la pantalla existe (mismo criterio que
 * `/settings/members` en E1).
 */
export default tenantPage(async () => {
  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Importar plan de cuentas"
        description="Carga un cuadro de cuentas propio desde CSV. El diff se calcula en el servidor y se previsualiza antes de escribir nada."
      />
      <AccountImportWizard />
    </div>
  )
}, { minRole: Role.ADMIN, notFoundOnForbidden: true })
