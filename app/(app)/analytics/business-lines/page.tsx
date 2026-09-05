import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { ArchiveDimensionDialog, BusinessLineDialog } from "@/components/analytics/dimension-forms"
import type { BusinessLineRow } from "@/components/analytics/types"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Líneas de negocio" }

/**
 * E4 · T13 — Líneas de negocio (§6).
 *
 * Agrupan proyectos. En la PyG analítica son columnas de **agregado**: se
 * muestran para leer la cuenta de resultados por negocio, pero no entran en el
 * total, porque sus proyectos ya están contados (I4).
 */
export default tenantPage(async ({ role }) => {
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN

  const listing = await listAnalyticsAction({ includeArchived: true })
  const lines: BusinessLineRow[] = (listing.data?.businessLines ?? []).map((bl) => ({
    id: bl.id,
    code: bl.code,
    name: bl.name,
    color: bl.color,
    isSystem: bl.isSystem,
    isActive: bl.isActive,
    projectCount: bl.projectCount,
    lineCount: bl.lineCount,
  }))
  const projects = listing.data?.projects ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Líneas de negocio</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Agrupación comercial de los proyectos. Cambiar la línea de negocio de un proyecto{" "}
            <strong>no reescribe las líneas ya contabilizadas</strong> (R-A9): los informes de periodos anteriores no
            cambian.
          </p>
        </div>
        <BusinessLineDialog canEdit={canEdit} />
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="business-lines-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Código</th>
              <th className="px-3 py-2 text-left font-medium">Nombre</th>
              <th className="px-3 py-2 text-left font-medium">Color</th>
              <th className="px-3 py-2 text-left font-medium">Proyectos</th>
              <th className="px-3 py-2 text-right font-medium">Líneas del diario</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((line) => {
              const own = projects.filter((p) => p.businessLineId === line.id)
              return (
                <tr key={line.id} className="h-8" data-business-line-code={line.code}>
                  <td className="px-3 py-1 font-code text-xs">{line.code}</td>
                  <td className="px-3 py-1">
                    {line.name}
                    {line.isSystem && <span className="ml-2 text-[11px] text-muted-foreground">(de sistema)</span>}
                    {!line.isActive && <span className="ml-2 text-[11px] text-muted-foreground">(archivada)</span>}
                  </td>
                  <td className="px-3 py-1">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-sm border"
                        style={{ backgroundColor: line.color }}
                      />
                      <span className="font-code text-xs text-muted-foreground">{line.color}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1 text-xs">
                    {own.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      own.map((p, index) => (
                        <span key={p.id}>
                          {index > 0 && " · "}
                          <Link
                            href={`/analytics/projects/${p.id}`}
                            className="font-code underline-offset-2 hover:underline"
                          >
                            {p.code}
                          </Link>
                        </span>
                      ))
                    )}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{line.lineCount}</td>
                  <td className="px-3 py-1">
                    <div className="flex justify-end gap-1">
                      <BusinessLineDialog line={line} canEdit={canEdit} />
                      <ArchiveDimensionDialog
                        kind="BusinessLine"
                        id={line.id}
                        code={line.code}
                        isAdmin={isAdmin}
                        disabled={line.isSystem || !line.isActive}
                        disabledReason={line.isSystem ? "Línea de sistema" : "Ya está archivada"}
                      />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
})
