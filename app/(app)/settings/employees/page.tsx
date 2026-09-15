import { listEmployeesAction } from "@/app/(app)/settings/employees/actions"
import { EmployeesPanel } from "@/components/employees/employees-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Empleados" }

/**
 * E10 · T17 — `/settings/employees` (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Empleados con su FTE y su centro de coste por defecto, y **tarifas con su
 * historial de vigencias y su `basis`**. La tarifa individual sólo la ve un
 * ADMIN (§10): para el resto la columna dice «oculta», que no es lo mismo que
 * «no hay».
 */
export default tenantPage(async ({ org, role }) => {
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN
  const today = todayLocalDate()

  const employees = await listEmployeesAction({ includeArchived: true })
  const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: today }))

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Empleados y tarifas"
        description="La ficha de personal y el coste-hora que convierte los partes en coste. La base de la tarifa (bruto sin SS, coste empresa con SS, coste total con estructura) viaja siempre con la cifra: dos bases difieren ≈ 31,9 % y compararlas es comparar dos magnitudes distintas."
      />

      {!employees.success ? (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" role="alert" data-testid="employees-error">
          ⚠ No se han podido leer los empleados: {employees.error}
        </p>
      ) : (
        <EmployeesPanel
          employees={employees.data ?? []}
          costCenters={config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
          canEdit={canEdit}
          isAdmin={isAdmin}
          today={today}
          defaultPeriod={{ from: `${today.slice(0, 4)}-01-01`, to: today }}
          currency={org.baseCurrency}
        />
      )}

      <p className="text-xs text-muted-foreground">
        La plantilla por centro de coste y mes —la base del driver{" "}
        <span className="font-code">PLANTILLA</span>— se registra en{" "}
        <Link href="/settings/headcount" className="underline underline-offset-2">
          Configuración → Plantilla
        </Link>
        . Los partes de horas están en{" "}
        <Link href="/time" className="underline underline-offset-2">
          Horas
        </Link>
        .
      </p>
    </div>
  )
})
