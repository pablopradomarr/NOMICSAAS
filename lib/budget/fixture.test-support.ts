/**
 * E10 · T7/T8 — soporte COMPARTIDO de los tests de `lib/budget/**`.
 *
 * Reconstruye, desde el fixture sellado
 * `docs/design/fixtures/presupuesto-horas-esperado.v1.2.json`, las dos versiones de
 * presupuesto y la `AnalyticsConfig` del ejercicio 2026, para que los tests
 * comparen **byte a byte** contra el contrato congelado por D6.
 *
 * No es código de producción: vive junto a los tests y nadie más lo importa.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import type { AllocationPeriodRef, AllocationRuleSpec } from "@/lib/analytics/allocate"
import { defaultMarginLevels } from "@/lib/analytics/seed"
import type { HeadcountRow } from "@/lib/time/aggregate"
import type { AnalyticsConfig, AnalyticType, MarginLevel, MarginLevelRow } from "@/lib/analytics/types"
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import type { BudgetCell, BudgetHoursCell, BudgetVersion } from "@/lib/budget/types"
import { loadFixture, planForVariant } from "@/tests/support/fixtures"

export const EXPECTED_PATH = path.join(
  process.cwd(),
  "docs",
  "design",
  "fixtures",
  "presupuesto-horas-esperado.v1.2.json"
)

export type ExpectedLine = {
  month: string
  accountCode: string | null
  analyticType: AnalyticType
  marginLevel: MarginLevel
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionCode: string
  businessLineCode: string | null
  amountCents: number
  signException: boolean
}

export type ExpectedHoursLine = {
  month: string
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionCode: string
  businessLineCode: string | null
  employeeCode: string | null
  minutes: number
}

export type ExpectedBudgetHeader = {
  code: string
  scenario: "BASE" | "REVISADO"
  revision: number
  status: string
  validFrom: string
  validTo: string | null
  partialFrom: string | null
  budgetHash: string
  marginConfigHash: string
  lineCount: number
  hoursLineCount: number
}

export type Expected = {
  marginConfigHash: string
  levels: MarginLevel[]
  columns: string[]
  budgets: ExpectedBudgetHeader[]
  budgetLines: Record<string, ExpectedLine[]>
  budgetHoursLines: ExpectedHoursLine[]
  budgetHoursLinesByVersion: Record<string, ExpectedHoursLine[]>
  budgetComposition: { provenanceByMonth: Record<string, string>; effectiveLineCount: number }
  budgetMatrixCents: Record<string, Record<string, number>>
  budgetMatrixByMonthCents: Record<string, Record<string, Record<string, number>>>
  budgetLevelTotalsCents: Record<string, number>
  budgetBusinessLineMatrixCents: Record<string, Record<string, number>>
  realMatrixCents: Record<string, Record<string, number>>
  realMatrixByMonthCents: Record<string, Record<string, Record<string, number>>>
  variance: {
    withAllocationsFalse: { allocationStateReal: string; allocationStateBudget: string; cells: ExpectedVarianceCell[] }
    withAllocationsTrue: {
      allocationStateReal: string
      allocationStateBudget: string
      budgetRulesHash: string
      cells: ExpectedVarianceCell[]
    }
    budgetNotSettleable: {
      code: string
      reason: string
      notComparableCells: number
      publishedCells: number
      cells: ExpectedVarianceCell[]
    }
  }
  forecast: {
    cutoffMonth: string
    byMonth: Record<string, { source: string; provenanceBudget: string | null; cells: Record<string, Record<string, number>> }>
    provenanceByMonth: Record<string, string>
    levelTotalsCents: Record<string, number>
    matrixCents: Record<string, Record<string, number>>
  }
  absorption: { valuedCents: number; payrollCents: number; absorptionCents: number; absorptionBps: number | null }
  allocation: Record<string, unknown>
  timeAggregates: Record<string, unknown>
}

export type ExpectedVarianceCell = {
  level: MarginLevel
  column: string
  month: string | null
  actualCents: number
  budgetCents: number | null
  varianceCents: number | null
  varianceBps: number | null
  notComparable: boolean
}

export const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as Expected

export const FY_START = "2026-01-01"
export const FY_END = "2026-12-31"
export const FISCAL_YEAR_ID = "fy-2026"

export const loaded = loadFixture("ejercicio-completo")

const plan = planForVariant("PYMES")
const analyticTypeByAccount = new Map<string, AnalyticType | null>(
  [...plan.byCode.entries()].map(([code, a]) => [code, a.analyticType])
)

const LEVELS: MarginLevelRow[] = defaultMarginLevels().map((l) => ({
  level: l.level,
  label: l.label,
  analyticTypes: l.analyticTypes,
  sortOrder: l.sortOrder,
  isVisible: true,
  validFrom: "1970-01-01",
  validTo: null,
}))

export const config: AnalyticsConfig = {
  organizationId: "org-test",
  levels: LEVELS,
  businessLines: loaded.dimensions.businessLines,
  projects: loaded.dimensions.projects,
  costCenters: loaded.dimensions.costCenters,
  unassignedCostCenterId: loaded.dimensions.unassignedCostCenterId,
  analyticTypeByAccount,
  incomeTaxPrefixes: INCOME_TAX_PREFIXES,
  nonAnalyticLevel: "EBITDA",
  analyticsRequired: true,
}

const projectByCode = new Map(config.projects.map((p) => [p.code, p]))
const cecoByCode = new Map(config.costCenters.map((c) => [c.code, c]))

export function dimensionOf(kind: "PROJECT" | "COST_CENTER", code: string, businessLineCode: string | null) {
  if (kind === "PROJECT") {
    const project = projectByCode.get(code)
    if (!project) throw new Error(`El fixture presupuesta el proyecto ${code}, que no existe en las dimensiones`)
    return { kind: "PROJECT" as const, id: project.id, code, businessLineCode }
  }
  const ceco = cecoByCode.get(code)
  if (!ceco) throw new Error(`El fixture presupuesta el CECO ${code}, que no existe en las dimensiones`)
  return { kind: "COST_CENTER" as const, id: ceco.id, code }
}

export const cellOf = (line: ExpectedLine): BudgetCell => ({
  month: line.month,
  accountCode: line.accountCode,
  dimension: dimensionOf(line.dimensionKind, line.dimensionCode, line.businessLineCode),
  analyticType: line.analyticType,
  marginLevel: line.marginLevel,
  amountCents: line.amountCents,
  signException: line.signException,
})

export const hoursCellOf = (line: ExpectedHoursLine): BudgetHoursCell => ({
  month: line.month,
  dimension: dimensionOf(line.dimensionKind, line.dimensionCode, line.businessLineCode),
  employeeCode: line.employeeCode,
  minutes: line.minutes,
})

/** Las dos versiones del fixture, ya en la forma que consume el motor. */
export function versionsFromFixture(): BudgetVersion[] {
  return expected.budgets.map((header) => ({
    id: `budget-${header.code}`,
    code: header.code,
    scenario: header.scenario,
    revision: header.revision,
    status: "VIGENTE" as const,
    fiscalYearId: FISCAL_YEAR_ID,
    fiscalYearStart: FY_START,
    fiscalYearEnd: FY_END,
    validFrom: header.validFrom,
    validTo: header.validTo,
    partialFrom: header.partialFrom,
    cells: expected.budgetLines[header.code].map(cellOf),
    // Cada versión lleva las horas de los meses que cubre: la BASE, los doce;
    // la REV1 parcial, los suyos desde `partialFrom`. Así la composición de
    // O-E10-9 devuelve las 36 líneas, vengan del mes que vengan. Desde la
    // ronda 1 las horas entran en el `budgetHash` (ADR-0018 D2), así que el
    // reparto por versión lo publica el propio fixture y no se re-deriva aquí.
    hours: expected.budgetHoursLinesByVersion[header.code].map(hoursCellOf),
  }))
}

export const FY_MONTHS: string[] = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)

// ─────────────────────────────────────────────────────────────────────────────
// T8 — reglas de E10, plantilla y matrices del REAL, desde el mismo JSON sellado
// ─────────────────────────────────────────────────────────────────────────────

export type ExpectedRule = {
  code: string
  name: string
  sourceCostCenterCode: string
  period: "MONTH" | "QUARTER" | "YEAR"
  priority: number
  sourceShareBps: number
  targetKind: "PROJECTS" | "BUSINESS_LINES" | "COST_CENTERS"
  driver: string
  targetFilter: Record<string, unknown> | null
  zeroBaseFallback: string
  targets: { projectCode?: string; businessLineCode?: string; costCenterCode?: string; percentBps?: number }[]
}

const blByCode = new Map(config.businessLines.map((b) => [b.code, b]))

/** Las siete reglas de E10 del fixture, con los ids reales de las dimensiones. */
export function rulesFromFixture(): AllocationRuleSpec[] {
  const rules = (expected.allocation as { rules: ExpectedRule[] }).rules
  return rules.map((r) => ({
    id: `rule-${r.code}`,
    code: r.code,
    name: r.name,
    sourceCostCenterId: cecoIdOf(r.sourceCostCenterCode),
    targetKind: r.targetKind,
    driver: r.driver as AllocationRuleSpec["driver"],
    period: r.period,
    priority: r.priority,
    sourceShareBps: r.sourceShareBps,
    zeroBaseFallback: r.zeroBaseFallback as AllocationRuleSpec["zeroBaseFallback"],
    targetFilter: (r.targetFilter as AllocationRuleSpec["targetFilter"]) ?? null,
    validFrom: FY_START,
    validTo: null,
    isActive: true,
    targets: r.targets.map((t, i) => ({
      projectId: t.projectCode ? projectIdOf(t.projectCode) : null,
      businessLineId: t.businessLineCode ? (blByCode.get(t.businessLineCode)?.id ?? null) : null,
      costCenterId: t.costCenterCode ? cecoIdOf(t.costCenterCode) : null,
      percentBps: t.percentBps ?? null,
      amountCents: null,
      sortOrder: i + 1,
    })),
  }))
}

export function cecoIdOf(code: string): string {
  const ceco = config.costCenters.find((c) => c.code === code)
  if (!ceco) throw new Error(`El fixture usa el CECO ${code}, que no existe en las dimensiones`)
  return ceco.id
}

export function projectIdOf(code: string): string {
  const project = config.projects.find((p) => p.code === code)
  if (!project) throw new Error(`El fixture usa el proyecto ${code}, que no existe en las dimensiones`)
  return project.id
}

/** Snapshots de plantilla del fixture, en FTE·mes por CECO y fin de mes. */
export function headcountFromFixture(): HeadcountRow[] {
  const rows = (expected as unknown as {
    headcountSnapshots: { costCenterCode: string; asOf: string; fteMilli: number }[]
  }).headcountSnapshots
  return rows.map((r) => ({
    costCenterId: cecoIdOf(r.costCenterCode),
    costCenterCode: r.costCenterCode,
    periodEnd: r.asOf,
    fteMilli: r.fteMilli,
  }))
}

/** El periodo anual del informe, sobre el que corre la escalera de liquidación. */
export const YEAR_PERIOD: AllocationPeriodRef = {
  kind: "YEAR",
  label: "2026",
  start: FY_START,
  end: FY_END,
  fiscalYearId: FISCAL_YEAR_ID,
  fiscalYearStart: FY_START,
  fiscalYearEnd: FY_END,
}
