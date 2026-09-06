import { listAllocationRulesAction } from "@/app/(app)/analytics/allocations/actions"
import { AllocationRuleForm } from "@/components/analytics/allocation-rule-form"
import { AllocationCascadeGraph } from "@/components/analytics/allocation-cascade-graph"
import { AllocationRulesTable } from "@/components/analytics/allocation-rules-table"
import type {
  AllocationDimensions,
  AllocationRuleView,
  SourceShareGroup,
} from "@/components/analytics/allocation-types"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Reglas de liquidación" }

/**
 * E5 · T11 — Reglas de liquidación de centros de coste (`E5-liquidacion.md` §6).
 *
 * Qué centro de coste reparte, con qué criterio, a quién, cada cuánto, en qué
 * orden y desde cuándo. Nada de esto se calcula aquí: la pantalla lista lo que
 * devuelve `listAllocationRulesAction` y ofrece las tres operaciones de
 * política —alta del conjunto, versionado y cierre—, todas ellas ADMIN y todas
 * con motivo.
 *
 * La banda de aviso de `Σ sourceShareBps ≠ 100 %` por `(centro de coste,
 * periodicidad)` se compone en el SERVIDOR sumando puntos básicos enteros: no
 * es una cifra contable (no es dinero), es la comprobación de cobertura de la
 * política, y su versión definitiva la hace la acción al guardar.
 *
 * Lecturas en SERIE: `tenantPage` abre UNA transacción para todo el render.
 */
export default tenantPage(async ({ db, org, role }) => {
  const isAdmin = role === Role.ADMIN

  const state = await listAllocationRulesAction({ includeClosed: true })
  const costCenters = await db.costCenter.findMany({
    select: { id: true, code: true, name: true, allocatable: true, isActive: true },
    orderBy: { code: "asc" },
  })
  const projects = await db.project.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  })
  const businessLines = await db.businessLine.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  })
  const fiscalYears = await db.fiscalYear.findMany({
    where: { status: "OPEN" },
    select: { startDate: true },
    orderBy: { startDate: "asc" },
    take: 1,
  })

  const costCenterById = new Map(costCenters.map((c) => [c.id, c]))
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const businessLineById = new Map(businessLines.map((b) => [b.id, b]))

  const rules: AllocationRuleView[] = (state.data ?? []).map((rule) => ({
    id: rule.id,
    code: rule.code,
    name: rule.name,
    sourceCostCenterId: rule.sourceCostCenterId,
    sourceCostCenterCode: rule.sourceCostCenterCode,
    sourceCostCenterName: costCenterById.get(rule.sourceCostCenterId)?.name ?? "",
    targetKind: rule.targetKind,
    driver: rule.driver,
    period: rule.period,
    priority: rule.priority,
    sourceShareBps: rule.sourceShareBps,
    zeroBaseFallback: rule.zeroBaseFallback,
    validFrom: rule.validFrom,
    validTo: rule.validTo,
    isActive: rule.isActive,
    lineCount: rule.lineCount,
    targets: rule.targets.map((t) => ({
      label:
        (t.projectId ? projectById.get(t.projectId)?.code : undefined) ??
        (t.businessLineId ? businessLineById.get(t.businessLineId)?.code : undefined) ??
        (t.costCenterId ? costCenterById.get(t.costCenterId)?.code : undefined) ??
        "—",
      percentBps: t.percentBps,
      amountCents: t.amountCents,
    })),
  }))

  // Cobertura de la política: Σ cuotas por (centro de coste, periodicidad),
  // sólo sobre las reglas VIGENTES. Puntos básicos enteros, sin dinero.
  const groups = new Map<string, SourceShareGroup>()
  for (const rule of rules) {
    if (!rule.isActive) continue
    const key = `${rule.sourceCostCenterCode}|${rule.period}`
    const group = groups.get(key) ?? {
      sourceCostCenterCode: rule.sourceCostCenterCode,
      sourceCostCenterName: rule.sourceCostCenterName,
      period: rule.period,
      totalBps: 0,
      ruleCodes: [],
    }
    group.totalBps += rule.sourceShareBps
    group.ruleCodes.push(rule.code)
    groups.set(key, group)
  }

  const dimensions: AllocationDimensions = {
    allocatableCostCenters: costCenters
      .filter((c) => c.allocatable && c.isActive)
      .map((c) => ({ id: c.id, code: c.code, name: c.name })),
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    businessLines: businessLines.map((b) => ({ id: b.id, code: b.code, name: b.name })),
  }

  const defaultValidFrom = fiscalYears[0]?.startDate.toISOString().slice(0, 10) ?? `${new Date().getUTCFullYear()}-01-01`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Reglas de liquidación</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Cómo se reparte el saldo de los centros de coste imputables entre proyectos, líneas de negocio y otros
            centros de coste. Las reglas son <strong>política</strong>: sólo las cambia un administrador, siempre con
            motivo, y nunca se editan las que ya tienen liquidaciones emitidas. El nivel de margen viaja con el importe,
            así que una cascada de un centro de EBITDA a uno de MC3 no mueve el MC3 de la compañía.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/analytics/allocations/runs" data-testid="go-to-runs">
              Simular y liquidar
            </Link>
          </Button>
          <AllocationRuleForm dimensions={dimensions} isAdmin={isAdmin} defaultValidFrom={defaultValidFrom} />
        </div>
      </div>

      {!state.success && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert" data-testid="allocation-rules-error">
          No se han podido leer las reglas: {state.error ?? "error desconocido"}.
        </p>
      )}

      <AllocationCascadeGraph rules={rules} />

      <AllocationRulesTable
        rules={rules}
        shareGroups={[...groups.values()]}
        isAdmin={isAdmin}
        currency={org.baseCurrency}
      />
    </div>
  )
})
