import { FiscalYearForm } from "@/components/ledger/fiscal-year-form"
import { PeriodLockGrid } from "@/components/ledger/period-lock-grid"
import type { FiscalYearView } from "@/components/ledger/types"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { listFiscalYears } from "@/models/fiscal-years"
import { listPeriodLocks } from "@/models/period-locks"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Ejercicios" }

/**
 * E3 · T12 — Ejercicios contables y bloqueo de meses (diseño §6).
 *
 * `VIEWER` y `EDITOR` ven el estado; sólo `ADMIN` abre, bloquea, desbloquea y
 * cierra. La pantalla oculta los controles, pero quien de verdad decide son las
 * acciones (`requireOrg(ADMIN)`) y los triggers de la base.
 */
export default tenantPage(async ({ db, role }) => {
  const canManage = role === Role.ADMIN

  const rows = await listFiscalYears(db)
  const locks = await listPeriodLocks(db)
  const counts = await db.journalEntry.groupBy({ by: ["fiscalYearId"], _count: { _all: true } })
  const countByFy = new Map(counts.map((c) => [c.fiscalYearId, c._count._all]))

  const fiscalYears: FiscalYearView[] = rows.map((fy) => ({
    id: fy.id,
    code: fy.code,
    startDate: fy.startDate.toISOString().slice(0, 10),
    endDate: fy.endDate.toISOString().slice(0, 10),
    status: fy.status,
    lastEntryNumber: fy.lastEntryNumber,
    entryCount: countByFy.get(fy.id) ?? 0,
    closedAt: fy.closedAt ? fy.closedAt.toISOString() : null,
    lockedMonths: locks
      .filter((l) => l.fiscalYearId === fy.id)
      .map((l) => l.month)
      .sort((a, b) => a - b),
  }))

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Ejercicios"
        description="Ejercicios contables de la organización y bloqueo de sus meses. Bloquear un mes impide fechar asientos nuevos en él; cerrar el ejercicio exige los doce bloqueados y no tiene vuelta atrás."
      />

      {canManage && <FiscalYearForm />}

      {fiscalYears.length === 0 ? (
        <p className="rounded-md border p-6 text-sm text-muted-foreground">
          Todavía no hay ningún ejercicio. {canManage ? "Crea el primero arriba." : "Pídeselo a un administrador."}
        </p>
      ) : (
        <div className="space-y-4">
          {fiscalYears.map((fy) => (
            <PeriodLockGrid key={fy.id} fiscalYear={fy} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  )
})
