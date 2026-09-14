/**
 * E10 · T7/T8 — soporte COMPARTIDO de los tests de `lib/budget/**`.
 *
 * Reconstruye, desde el fixture sellado
 * `docs/design/fixtures/presupuesto-horas-esperado.json`, las dos versiones de
 * presupuesto y la `AnalyticsConfig` del ejercicio 2026, para que los tests
 * comparen **byte a byte** contra el contrato congelado por D6.
 *
 * No es código de producción: vive junto a los tests y nadie más lo importa.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { defaultMarginLevels } from "@/lib/analytics/seed"
import type { AnalyticsConfig, AnalyticType, MarginLevel, MarginLevelRow } from "@/lib/analytics/types"
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import type { BudgetCell, BudgetHoursCell, BudgetVersion } from "@/lib/budget/types"
import { loadFixture, planForVariant } from "@/tests/support/fixtures"

export const EXPECTED_PATH = path.join(
  process.cwd(),
  "docs",
  "design",
  "fixtures",
  "presupuesto-horas-esperado.json"
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
}

export type Expected = {
  marginConfigHash: string
  levels: MarginLevel[]
  columns: string[]
  budgets: ExpectedBudgetHeader[]
  budgetLines: Record<string, ExpectedLine[]>
  budgetHoursLines: ExpectedHoursLine[]
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
    // Las horas presupuestadas del fixture son las de la versión efectiva; se
    // cuelgan de la BASE, que es la que cubre el año entero.
    hours: header.code === "2026-BASE" ? expected.budgetHoursLines.map(hoursCellOf) : [],
  }))
}

export const FY_MONTHS: string[] = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)
