import { listHeadcountAction } from "@/app/(app)/settings/employees/actions"
import { HeadcountPanel } from "@/components/employees/headcount-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Button } from "@/components/ui/button"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Plantilla" }

/**
 * E10 · T17 — `/settings/headcount`: plantilla por centro de coste y mes en
 * **FTE·mes** (Q-7), con derivación desde las fichas de personal y edición
 * manual.
 *
 * Lo que la pantalla tiene que separar, y separa: **«0 declarado» de «sin
 * rellenar»**. Es la diferencia entre un dato y un hueco, y la que decide si el
 * informe sale con `PLANTILLA_AUSENTE`.
 */
export default tenantPage<SearchParamsProps>(async ({ org, role, searchParams }) => {
  const params = await searchParams
  const raw = params.ejercicio
  const asked = Array.isArray(raw) ? raw[0] : raw
  const year = /^\d{4}$/.test(asked ?? "") ? (asked as string) : todayLocalDate().slice(0, 4)
  const canEdit = role === Role.EDITOR || role === Role.ADMIN

  const rows = await listHeadcountAction({ from: `${year}-01-01`, to: `${year}-12-31` })
  const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: `${year}-12-31` }))

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Plantilla por centro de coste"
        description="La base del driver de reparto PLANTILLA: un snapshot por centro de coste y mes, a fin de mes y en FTE·mes. El driver lee sólo estos snapshots, así que un reparto ya cerrado no cambia porque alguien edite una ficha de personal años después."
      />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Ejercicio:</span>
        {[-1, 0, 1].map((delta) => {
          const value = String(Number(year) + delta)
          return (
            <Button key={value} asChild variant={value === year ? "default" : "outline"} size="sm">
              <Link href={`/settings/headcount?ejercicio=${value}`} data-testid={`headcount-year-${value}`}>
                {value}
              </Link>
            </Button>
          )
        })}
      </div>

      {!rows.success ? (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" role="alert" data-testid="headcount-error">
          ⚠ No se ha podido leer la plantilla: {rows.error}
        </p>
      ) : (
        <HeadcountPanel
          year={year}
          rows={rows.data ?? []}
          costCenters={config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
          canEdit={canEdit}
        />
      )}
    </div>
  )
})
