import { listDebtSchedulesAction } from "@/app/(app)/settings/debt/actions"
import { DebtPanel } from "@/components/debt/debt-panel"
import { DebtScheduleForm } from "@/components/debt/debt-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Deuda" }

/**
 * E9 · T18 — `/settings/debt` (§7, ADR-0016 D5, O-6).
 *
 * Préstamos y aplazamientos con su cuadro de vencimientos, el alta por **T-37**
 * y —lo primero de la pantalla— la lista de **deudas sin desglose** que están
 * bloqueando el cierre. Dejarlas en una nota informativa sería firmar un
 * balance mal clasificado.
 */
export default tenantPage(async ({ role }) => {
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN
  const cutoff = todayLocalDate()

  const overview = await listDebtSchedulesAction({ cutoff })
  if (!overview.success || !overview.data) {
    return (
      <div className="space-y-6">
        <Header />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" data-testid="debt-error">
          ⚠ No se han podido leer los cuadros de deuda: {overview.error}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header />
      {canEdit && <DebtScheduleForm />}
      <DebtPanel overview={overview.data} canEdit={canEdit} isAdmin={isAdmin} />
    </div>
  )
})

function Header() {
  return (
    <SettingsPageHeader
      title="Deuda y cuadros de vencimientos"
      description="Préstamos y aplazamientos con el desglose de vencimientos que la reclasificación del cierre necesita para separar la parte corriente de la no corriente. Sin cuadro no hay parte corriente que presentar: esas posiciones se enseñan arriba porque bloquean el cierre."
    />
  )
}
