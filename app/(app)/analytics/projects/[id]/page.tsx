import { analyticPnlAction, listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { dimensionOptions, projectExtras } from "@/app/(app)/analytics/shared"
import { accountNames, defaultPeriod } from "@/app/(app)/ledger/shared"
import { ProjectDialog, ProjectStateButtons } from "@/components/analytics/dimension-forms"
import { ReclassifyDialog, type ReclassifyLine } from "@/components/analytics/reclassify-dialog"
import { MARGIN_LEVEL_LABELS, PROJECT_STATUS_LABELS, formatBps } from "@/components/analytics/types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { marginBps } from "@/lib/analytics/margins"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import { requireOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticLines } from "@/models/analytics"
import { listFiscalYears } from "@/models/fiscal-years"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Proyecto" }

/**
 * E4 · T13/T15 — Ficha de proyecto: mini PyG por niveles y sus líneas del
 * diario, con la reclasificación analítica (ADR-0010) desde la propia ficha.
 *
 * La mini PyG es **la columna del proyecto de la matriz**, leída tal cual: no
 * se recalcula aquí ni se suma nada en el navegador.
 */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN

  const listing = await listAnalyticsAction({ includeArchived: true })
  const project = (listing.data?.projects ?? []).find((p) => p.id === id)
  if (!project) notFound()
  const businessLines = (listing.data?.businessLines ?? []).filter((bl) => bl.isActive)
  const costCenters = listing.data?.costCenters ?? []

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

  const extras = await projectExtras(db, [project.id])
  const extra = extras.get(project.id)

  const pnlState = await analyticPnlAction({
    from: period.from,
    to: period.to,
    ...(openFy ? { fiscalYearId: openFy.id } : {}),
  })
  const pnl = pnlState.success ? pnlState.data?.pnl : undefined
  const column = `PROJ:${project.code}`

  const names = await accountNames(db)
  const lines = await tenantTransaction(org.id, async (tx) =>
    getAnalyticLines(tx, {
      from: period.from,
      to: period.to,
      projectId: project.id,
      ...(openFy ? { fiscalYearId: openFy.id } : {}),
    })
  )

  const codeOfCostCenter = new Map(costCenters.map((c) => [c.id, c.code]))
  const reclassifyLines: ReclassifyLine[] = lines.map((line) => ({
    id: line.id ?? "",
    lineNo: line.lineNo,
    entryNumber: line.entryNumber,
    entryDate: line.entryDate,
    accountCode: line.accountCode,
    accountName: names.get(line.accountCode) ?? "",
    amountCents: line.creditCents - line.debitCents,
    analyticType: line.analyticType,
    projectId: line.projectId,
    costCenterId: line.costCenterId,
    destinationLabel: line.projectId
      ? project.code
      : line.costCenterId
        ? (codeOfCostCenter.get(line.costCenterId) ?? "CECO")
        : "sin destino",
  })).filter((l) => l.id !== "")

  const revenueCents = pnl?.matrixCents.INGRESOS?.[column] ?? 0
  const projectRow = {
    id: project.id,
    code: project.code,
    name: project.name,
    businessLineId: project.businessLineId,
    businessLineCode: project.businessLineCode,
    status: project.status,
    closedAt: project.closedAt ?? null,
    isActive: project.isActive,
    lineCount: project.lineCount,
    startDate: extra?.startDate ?? null,
    endDate: extra?.endDate ?? null,
    budgetRevenueCents: extra?.budgetRevenueCents ?? null,
    budgetCostCents: extra?.budgetCostCents ?? null,
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/analytics/projects">← Proyectos</Link>
        </Button>
        <div className="flex gap-2">
          <ProjectDialog businessLines={businessLines} project={projectRow} canEdit={canEdit} />
          <ProjectStateButtons project={projectRow} canEdit={canEdit} isAdmin={isAdmin} today={refDate} />
          <ReclassifyDialog
            lines={reclassifyLines}
            options={dimensionOptions(listing.data?.projects ?? [], costCenters)}
            canReclassify={canEdit}
            role={role}
          />
        </div>
      </div>

      <div className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="font-code">{project.code}</span> · {project.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Línea de negocio <span className="font-code">{project.businessLineCode ?? "—"}</span> ·{" "}
          {PROJECT_STATUS_LABELS[project.status] ?? project.status}
          {extra?.startDate && <> · desde {formatLocalDate(extra.startDate)}</>}
          {extra?.endDate && <> hasta {formatLocalDate(extra.endDate)}</>}
        </p>
        <p className="text-sm text-muted-foreground">
          Periodo {formatLocalDate(period.from)} – {formatLocalDate(period.to)} · moneda base {org.baseCurrency}
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Mini PyG del proyecto</h2>
        {!pnl ? (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
            No se ha podido calcular la matriz: {pnlState.error ?? "error desconocido"}.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="project-mini-pnl">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Nivel</th>
                  <th className="px-3 py-2 text-right font-medium">Aporte del nivel</th>
                  <th className="px-3 py-2 text-right font-medium">Acumulado</th>
                  <th className="px-3 py-2 text-right font-medium">% sobre ingresos</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {MARGIN_LEVELS.map((level) => {
                  const cumulative = pnl.matrixCents[level]?.[column] ?? 0
                  const contribution = pnl.contributionByLevelCents[level]?.[column] ?? 0
                  const companyOnly = level === "EBIT" || level === "BAI" || level === "RESULTADO"
                  return (
                    <tr key={level} className="h-8" data-level={level}>
                      <td className="px-3 py-1 font-medium">
                        {MARGIN_LEVEL_LABELS[level] ?? level}
                        {companyOnly && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            lectura de compañía, no margen de proyecto
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right">
                        <AmountPlain cents={contribution} />
                      </td>
                      <td className={companyOnly ? "px-3 py-1 text-right text-muted-foreground" : "px-3 py-1 text-right"}>
                        <AmountPlain cents={cumulative} />
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
                        {level === "INGRESOS" ? "—" : formatBps(marginBps(cumulative, revenueCents))}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ConfidenceBadge level="calculado" />
          Presupuesto de ingresos <AmountPlain cents={extra?.budgetRevenueCents ?? 0} /> · presupuesto de costes{" "}
          <AmountPlain cents={extra?.budgetCostCents ?? 0} />. El porcentaje se deriva de dos cifras del motor y no se
          persiste (I-E4-6).
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Líneas del proyecto en el periodo</h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="project-lines">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Fecha</th>
                <th className="px-3 py-2 text-left font-medium">Asiento</th>
                <th className="px-3 py-2 text-left font-medium">Cuenta</th>
                <th className="px-3 py-2 text-left font-medium">Tipo analítico</th>
                <th className="px-3 py-2 text-right font-medium">Debe</th>
                <th className="px-3 py-2 text-right font-medium">Haber</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-muted-foreground" colSpan={6}>
                    Este proyecto no tiene líneas en el periodo.
                  </td>
                </tr>
              )}
              {lines.map((line) => (
                <tr key={line.id ?? `${line.entryId}-${line.lineNo}`} className="h-8">
                  <td className="px-3 py-1 tabular-nums text-muted-foreground">{formatLocalDate(line.entryDate)}</td>
                  <td className="px-3 py-1 font-code text-xs">
                    <Link href={`/ledger/${line.entryId}`} className="underline-offset-2 hover:underline">
                      {line.entryNumber}/{line.lineNo}
                    </Link>
                  </td>
                  <td className="px-3 py-1">
                    <span className="font-code text-xs">{line.accountCode}</span>{" "}
                    <span className="text-muted-foreground">{names.get(line.accountCode) ?? ""}</span>
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">{line.analyticType ?? "—"}</td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={line.debitCents} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={line.creditCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
