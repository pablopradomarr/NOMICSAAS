import { listAssetsAction } from "@/app/(app)/settings/assets/actions"
import { AssetForm } from "@/components/assets/asset-form"
import { AssetsPanel } from "@/components/assets/assets-panel"
import type { AssetView } from "@/components/assets/types"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Inmovilizado" }

/**
 * E9 · T17 — `/settings/assets` (`docs/design/E9-cierre-recurrentes.md` §7).
 *
 * Activos con coste, amortización acumulada, valor neto contable y estado; la
 * ficha abre el cuadro mes a mes **con el enlace al asiento de cada periodo**
 * contabilizado (O-19), sus revisiones prospectivas y las acciones de baja y
 * venta con el aviso del art. 110 LIVA.
 *
 * Las dos cifras derivadas que la pantalla necesita para avisar —lo que el
 * cuadro sellado explica y el valor neto contable— se calculan **aquí, en el
 * servidor**, y viajan ya hechas: el navegador no suma cifras contables.
 */
export default tenantPage(async ({ org, role }) => {
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN
  const cutoff = todayLocalDate()

  const assets = await listAssetsAction({ cutoff })
  // E10 · T17 (deuda §0-bis #7): el alta necesita el catálogo analítico vigente
  // y saber si la organización exige destino en las cuentas 6/7.
  const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: cutoff }))
  if (!assets.success) {
    return (
      <div className="space-y-6">
        <Header />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" data-testid="assets-error">
          ⚠ No se ha podido leer el inmovilizado: {assets.error}
        </p>
      </div>
    )
  }

  const views: AssetView[] = (assets.data ?? []).map((detail) => {
    const posted = new Set(detail.postedPeriods)
    const explainedCents = detail.schedule
      .filter((row) => posted.has(row.period))
      .reduce((acc, row) => acc + row.quotaCents, 0)
    const last = detail.schedule.filter((row) => row.period <= cutoff.slice(0, 7)).at(-1)
    return {
      ...detail,
      explainedCents,
      // I-E9-3/I-E9-5 en versión de pantalla: el cuadro sellado tiene que
      // explicar lo que el diario atribuye al activo, céntimo a céntimo.
      mismatch: explainedCents !== detail.accumulatedCents,
      netBookValueCents: last?.netBookValueCents ?? detail.asset.acquisitionCostCents,
    }
  })

  return (
    <div className="space-y-6">
      <Header />
      {canEdit && (
        <AssetForm
          projects={config.projects.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
          costCenters={config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
          analyticsRequired={config.analyticsRequired}
        />
      )}
      <AssetsPanel assets={views} cutoff={cutoff} canEdit={canEdit} isAdmin={isAdmin} />
    </div>
  )
})

function Header() {
  return (
    <SettingsPageHeader
      title="Inmovilizado"
      description="Activos con su cuadro de amortización lineal, sus revisiones prospectivas y su baja o venta. El cuadro no se almacena: se deriva del activo y de sus revisiones, y su sello (scheduleHash) permite comprobar que es el mismo que se firmó al darlo de alta."
    />
  )
}
