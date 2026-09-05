import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { ArchiveDimensionDialog, CostCenterDialog } from "@/components/analytics/dimension-forms"
import { COST_CENTER_KIND_LABELS, type CostCenterRow } from "@/components/analytics/types"
import { AmountPlain } from "@/components/ledger/amount"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Centros de coste" }

/**
 * E4 · T13 — Centros de coste (§6).
 *
 * El `kind` decide la columna de la matriz y el `marginLevel` el nivel en el
 * que se descuenta (MC3 o EBITDA) — y sólo se aplica a las líneas cuyo tipo
 * efectivo es `INDIRECTO_CECO` (R-A6): un `668` imputado a `CC-FIN` cae en BAI,
 * no en EBITDA. Los tres campos estructurales mueven importe entre niveles, así
 * que sólo los cambia un ADMIN y la acción lo vuelve a exigir.
 */
export default tenantPage(async ({ org, role }) => {
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN

  const listing = await listAnalyticsAction({ includeArchived: true })
  const rows: CostCenterRow[] = (listing.data?.costCenters ?? []).map((cc) => ({
    id: cc.id,
    code: cc.code,
    name: cc.name,
    kind: cc.kind,
    marginLevel: cc.marginLevel,
    allocatable: cc.allocatable,
    isActive: cc.isActive,
    isSystem: cc.isSystem,
    lineCount: cc.lineCount,
    imputedCents: cc.imputedCents,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Centros de coste</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Destino indirecto de las líneas de grupo 6 y 7. La columna «Imputable» indica si la liquidación de E5 podrá
            repartirlo a proyectos; hoy ningún CECO se imputa todavía, así que MC3 de un proyecto no incluye estructura.
          </p>
        </div>
        <CostCenterDialog canEdit={canEdit} isAdmin={isAdmin} />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="cost-centers-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Código</th>
              <th className="px-3 py-2 text-left font-medium">Nombre</th>
              <th className="px-3 py-2 text-left font-medium">Tipo</th>
              <th className="px-3 py-2 text-left font-medium">Nivel de margen</th>
              <th className="px-3 py-2 text-left font-medium">Imputable en E5</th>
              <th className="px-3 py-2 text-right font-medium">Líneas</th>
              <th className="px-3 py-2 text-right font-medium">Aporte acumulado</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((cc) => (
              <tr key={cc.id} className="h-8" data-cost-center-code={cc.code}>
                <td className="px-3 py-1 font-code text-xs">{cc.code}</td>
                <td className="px-3 py-1">
                  {cc.name}
                  {cc.isSystem && <span className="ml-2 text-[11px] text-muted-foreground">(de sistema)</span>}
                  {!cc.isActive && <span className="ml-2 text-[11px] text-muted-foreground">(archivado)</span>}
                </td>
                <td className="px-3 py-1 text-xs">{COST_CENTER_KIND_LABELS[cc.kind] ?? cc.kind}</td>
                <td className="px-3 py-1 font-code text-xs">{cc.marginLevel}</td>
                <td className="px-3 py-1 text-xs">{cc.allocatable ? "Sí" : "No"}</td>
                <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{cc.lineCount}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={cc.imputedCents} />
                </td>
                <td className="px-3 py-1">
                  <div className="flex justify-end gap-1">
                    <CostCenterDialog costCenter={cc} canEdit={canEdit} isAdmin={isAdmin} />
                    <ArchiveDimensionDialog
                      kind="CostCenter"
                      id={cc.id}
                      code={cc.code}
                      isAdmin={isAdmin}
                      disabled={cc.isSystem || !cc.isActive}
                      disabledReason={cc.isSystem ? "Centro de coste de sistema: no se archiva" : "Ya está archivado"}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        El aporte acumulado es <strong>haber − debe</strong> de todas las líneas imputadas al centro, en{" "}
        {org.baseCurrency}, sin acotar al periodo: para la cifra del periodo, la PyG analítica.
      </p>
    </div>
  )
})
