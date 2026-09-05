import { listAnalyticsAction, analyticPnlAction } from "@/app/(app)/analytics/actions"
import { projectExtras, projectPeriodFigures } from "@/app/(app)/analytics/shared"
import { defaultPeriod } from "@/app/(app)/ledger/shared"
import { ArchiveDimensionDialog, ProjectDialog, ProjectStateButtons } from "@/components/analytics/dimension-forms"
import { PROJECT_STATUS_LABELS, type ProjectRow } from "@/components/analytics/types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { requireOrg } from "@/lib/authz"
import { listFiscalYears } from "@/models/fiscal-years"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Proyectos" }

/**
 * E4 · T13 — Proyectos, la dimensión analítica directa (§6).
 *
 * Sustituye al CRUD heredado de `/settings/projects`, que era una etiqueta en
 * inglés sin línea de negocio. Las cifras del periodo salen de la MATRIZ
 * (`buildAnalyticPnl`), no de una consulta propia: así la ficha y la PyG
 * analítica no pueden discrepar. La desviación contra presupuesto va marcada
 * `calculado`: el presupuesto es un dato del usuario, no del diario.
 */
export default async function ProjectsPage() {
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN

  const refDate = todayLocalDate()
  const fiscalYears = await listFiscalYears(db)
  const openFy = fiscalYears.find((fy) => fy.status === "OPEN") ?? fiscalYears[0] ?? null
  const period = defaultPeriod(
    openFy
      ? {
          startDate: openFy.startDate.toISOString().slice(0, 10),
          endDate: openFy.endDate.toISOString().slice(0, 10),
        }
      : null,
    refDate
  )

  const listing = await listAnalyticsAction({ includeArchived: true })
  const projects = listing.data?.projects ?? []
  const businessLines = (listing.data?.businessLines ?? []).filter((bl) => bl.isActive)

  const extras = await projectExtras(
    db,
    projects.map((p) => p.id)
  )
  const pnlState = await analyticPnlAction({
    from: period.from,
    to: period.to,
    ...(openFy ? { fiscalYearId: openFy.id } : {}),
  })
  const pnl = pnlState.success ? pnlState.data?.pnl : undefined

  const rows: ProjectRow[] = projects.map((p) => {
    const extra = extras.get(p.id)
    const figures = pnl ? projectPeriodFigures(pnl, p.code) : null
    const budgetRevenueCents = extra?.budgetRevenueCents ?? null
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      businessLineId: p.businessLineId,
      businessLineCode: p.businessLineCode,
      status: p.status,
      closedAt: p.closedAt ?? null,
      isActive: p.isActive,
      lineCount: p.lineCount,
      counterpartyId: extra?.counterpartyId ?? null,
      startDate: extra?.startDate ?? null,
      endDate: extra?.endDate ?? null,
      budgetRevenueCents,
      budgetCostCents: extra?.budgetCostCents ?? null,
      periodRevenueCents: figures ? figures.revenueCents : null,
      periodMc2Cents: figures ? figures.mc2Cents : null,
      periodMc3Cents: figures ? figures.mc3Cents : null,
      revenueVarianceCents:
        figures && budgetRevenueCents !== null ? figures.revenueCents - budgetRevenueCents : null,
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Cada proyecto pertenece a una línea de negocio y es el destino directo de las líneas de gasto e ingreso de
            grupo 6 y 7. Las cifras del periodo son las de la PyG analítica de{" "}
            {formatLocalDate(period.from)} – {formatLocalDate(period.to)}.
          </p>
        </div>
        <ProjectDialog businessLines={businessLines} canEdit={canEdit} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="projects-empty">
          Aún no hay proyectos: crea el primero para ver la PyG analítica por proyecto.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="projects-table">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Código</th>
                <th className="px-3 py-2 text-left font-medium">Proyecto</th>
                <th className="px-3 py-2 text-left font-medium">Línea de negocio</th>
                <th className="px-3 py-2 text-left font-medium">Estado</th>
                <th className="px-3 py-2 text-left font-medium">Cliente</th>
                <th className="px-3 py-2 text-right font-medium">Presupuesto ingresos</th>
                <th className="px-3 py-2 text-right font-medium">Ingresos del periodo</th>
                <th className="px-3 py-2 text-right font-medium">Desviación</th>
                <th className="px-3 py-2 text-right font-medium">MC3 del periodo</th>
                <th className="px-3 py-2 text-right font-medium">Líneas</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((project) => (
                <tr key={project.id} className="h-8" data-project-code={project.code}>
                  <td className="px-3 py-1 font-code text-xs">
                    <Link href={`/analytics/projects/${project.id}`} className="underline-offset-2 hover:underline">
                      {project.code}
                    </Link>
                  </td>
                  <td className="px-3 py-1">
                    <Link href={`/analytics/projects/${project.id}`} className="underline-offset-2 hover:underline">
                      {project.name}
                    </Link>
                    {!project.isActive && (
                      <span className="ml-2 text-[11px] text-muted-foreground">(archivado)</span>
                    )}
                  </td>
                  <td className="px-3 py-1 font-code text-xs">{project.businessLineCode ?? "—"}</td>
                  <td className="px-3 py-1 text-xs">
                    {PROJECT_STATUS_LABELS[project.status] ?? project.status}
                    {project.closedAt && (
                      <span className="ml-1 text-muted-foreground">({formatLocalDate(project.closedAt)})</span>
                    )}
                  </td>
                  <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                    {project.counterpartyId ? project.counterpartyId.slice(0, 8) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={project.budgetRevenueCents ?? 0} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={project.periodRevenueCents ?? 0} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    {project.revenueVarianceCents == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <AmountPlain cents={project.revenueVarianceCents} />
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={project.periodMc3Cents ?? 0} />
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{project.lineCount}</td>
                  <td className="px-3 py-1">
                    <div className="flex justify-end gap-1">
                      <ProjectDialog businessLines={businessLines} project={project} canEdit={canEdit} />
                      <ProjectStateButtons
                        project={project}
                        canEdit={canEdit}
                        isAdmin={isAdmin}
                        today={refDate}
                      />
                      <ArchiveDimensionDialog
                        kind="Project"
                        id={project.id}
                        code={project.code}
                        isAdmin={isAdmin}
                        disabled={!project.isActive}
                        disabledReason="Ya está archivado"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ConfidenceBadge level="calculado" />
        La desviación es <strong>ingresos del periodo − presupuesto</strong>: no se almacena en ninguna parte y se
        recalcula en cada lectura. Moneda base {org.baseCurrency}.
      </p>
    </div>
  )
}
