import { listPeriodGridAction } from "@/app/(app)/settings/periods/actions"
import { PeriodsGrid } from "@/components/periods/periods-grid"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Bloqueo de periodos" }

/**
 * E9 · T18 — `/settings/periods` (§7, §5.3).
 *
 * La rejilla ejercicio × mes con las **tres** barreras a la vista: el bloqueo
 * del mes, el periodo de IVA en el que cae y si ese periodo está liquidado.
 * Sustituye a la rejilla de `/settings/fiscal-years`, que se queda con los
 * ejercicios y sus estados societario y fiscal.
 */
export default tenantPage(async ({ role }) => {
  const years = await listPeriodGridAction()
  if (!years.success) {
    return (
      <div className="space-y-6">
        <Header />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" data-testid="periods-error">
          ⚠ No se ha podido leer la rejilla de periodos: {years.error}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header />
      <PeriodsGrid years={years.data ?? []} isAdmin={role === Role.ADMIN} />
    </div>
  )
})

function Header() {
  return (
    <SettingsPageHeader
      title="Bloqueo de periodos"
      description="Un mes bloqueado no admite asientos nuevos con esa fecha; un periodo de IVA liquidado no admite asientos con cuentas de IVA, aunque el mes siga abierto. Son barreras distintas porque el periodo de IVA no coincide con la fecha del asiento. Bloquear y desbloquear son de administrador y quedan escritos con su motivo."
    />
  )
}
