import { getAnalyticsConfigAction } from "@/app/(app)/analytics/actions"
import { AnalyticsPolicyForm, MarginConfigTable } from "@/components/analytics/margin-config-table"
import type { MarginLevelRowView } from "@/components/analytics/types"
import { requireOrg } from "@/lib/authz"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Analítica" }

/**
 * E4 · T13 — Configuración analítica de la organización (§6).
 *
 * `analyticsRequired`, `nonAnalyticLevel` y la `MarginLevelConfig` **versionada**
 * con su historial. Todo de ADMIN: la lectura la puede hacer cualquier rol
 * —saber cómo se compone un margen no es un privilegio—, pero los controles de
 * escritura sólo aparecen para ADMIN y la acción lo vuelve a exigir.
 */
export default async function AnalyticsSettingsPage() {
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const isAdmin = role === Role.ADMIN
  const refDate = todayLocalDate()

  const configState = await getAnalyticsConfigAction(refDate)
  const config = configState.data

  const historyRows = await db.marginLevelConfig.findMany({
    orderBy: [{ validFrom: "desc" }, { sortOrder: "asc" }],
  })
  const history: MarginLevelRowView[] = historyRows.map((row) => ({
    level: row.level,
    label: row.label,
    analyticTypes: row.analyticTypes,
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo ? row.validTo.toISOString().slice(0, 10) : null,
  }))

  const levels: MarginLevelRowView[] = (config?.levels ?? []).map((row) => ({
    level: row.level,
    label: row.label,
    analyticTypes: [...row.analyticTypes],
    sortOrder: row.sortOrder,
    isVisible: row.isVisible,
    validFrom: row.validFrom,
    validTo: row.validTo,
  }))

  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Analítica</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Cómo se compone cada nivel de margen de la{" "}
          <Link href="/analytics/pyg" className="underline underline-offset-2">
            PyG analítica
          </Link>{" "}
          y qué hace el motor cuando una línea de grupo 6 o 7 llega sin destino. El hash de esta configuración
          (`marginConfigHash`) entra en el sello de cada informe analítico: cambiarla caduca los informes analíticos del
          periodo, nunca los financieros.
        </p>
      </div>

      {!config ? (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          No se ha podido leer la configuración analítica: {configState.error ?? "error desconocido"}.
        </p>
      ) : (
        <>
          <AnalyticsPolicyForm
            analyticsRequired={config.analyticsRequired}
            nonAnalyticLevel={config.nonAnalyticLevel}
            isAdmin={isAdmin}
          />
          <MarginConfigTable
            levels={levels}
            history={history}
            isAdmin={isAdmin}
            defaultValidFrom={refDate}
          />
        </>
      )}

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">
          Sólo un ADMIN cambia esta configuración: mueve importe entre niveles de margen en todos los periodos abiertos.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Organización <span className="font-code">{org.name}</span> · moneda base {org.baseCurrency}.
      </p>
    </div>
  )
}
