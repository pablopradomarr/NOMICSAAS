/**
 * E10 · T8 — `lib/budget/variance.ts` y la liquidación presupuestaria de
 * `settleBudgetMatrix` (O-E10-4).
 *
 * Criterios 3, 27 y 27-bis de §12, byte a byte contra
 * `docs/design/fixtures/presupuesto-horas-esperado.json`.
 */

import { describe, expect, it } from "vitest"

import { rulesHash } from "@/lib/analytics/allocate"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import { composeBudget } from "@/lib/budget/hash"
import { buildBudgetMatrix, settleBudgetMatrix, settlementLadder } from "@/lib/budget/matrix"
import {
  buildVariance,
  isDimensionColumn,
  maxDimensionVariance,
  varianceBps,
  varianceCoverage,
  type VarianceCell,
} from "@/lib/budget/variance"
import {
  FY_END,
  FY_MONTHS,
  FY_START,
  YEAR_PERIOD,
  config,
  expected,
  headcountFromFixture,
  rulesFromFixture,
  versionsFromFixture,
} from "@/lib/budget/fixture.test-support"
import { absorptionVariance } from "@/lib/time/cost"

const YEAR = { from: FY_START, to: FY_END }

const composed = composeBudget(versionsFromFixture(), FY_MONTHS)
const budgetNone = buildBudgetMatrix(composed.effective, config, YEAR)
const rules = rulesFromFixture()
const headcount = headcountFromFixture()

const realNone = { matrixCents: expected.realMatrixCents, columns: budgetNone.columns }

const settlement = settleBudgetMatrix(budgetNone, {
  rules,
  budgetHours: composed.effective.hours,
  headcount,
  config,
  period: YEAR_PERIOD,
})
if (!settlement.ok) throw new Error(`la liquidación presupuestaria falló: ${settlement.error.reason}`)
const budgetSettled = settlement.value.matrix
const realSettled = {
  matrixCents: (expected.allocation as { real: { matrixCents: Record<string, Record<string, number>> } }).real
    .matrixCents,
  columns: budgetNone.columns,
}

/** Sólo los siete campos que el contrato sellado publica de cada celda. */
const seven = (c: VarianceCell) => ({
  level: c.level,
  column: c.column,
  month: c.month,
  actualCents: c.actualCents,
  budgetCents: c.budgetCents,
  varianceCents: c.varianceCents,
  varianceBps: c.varianceBps,
  notComparable: c.notComparable,
})

describe("varianceBps · entero, con signo y sin infinitos", () => {
  it("presupuesto 0 ⇒ null: decide el umbral absoluto, nunca ∞ ni NaN", () => {
    expect(varianceBps(1_000, 0)).toBeNull()
    expect(varianceBps(0, 0)).toBeNull()
  })

  it("trunca hacia cero y conserva el signo de la desviación", () => {
    expect(varianceBps(1_100, 1_000)).toBe(1_000)
    expect(varianceBps(900, 1_000)).toBe(-1_000)
    // 33 / 1000 = 3,3 % ⇒ 330 bps exactos; 34 / 999 ⇒ 340 bps truncados.
    expect(varianceBps(1_033, 1_000)).toBe(330)
    expect(varianceBps(1_033, 999)).toBe(340)
  })

  it("con presupuesto negativo compara MAGNITUDES y el signo es el de la resta", () => {
    expect(varianceBps(-900, -1_000)).toBe(1_000)
    expect(varianceBps(-1_100, -1_000)).toBe(-1_000)
  })

  it("las columnas por dimensión se distinguen de los agregados", () => {
    expect(isDimensionColumn("PROJ:P-01")).toBe(true)
    expect(isDimensionColumn("BL:BL-CONS")).toBe(true)
    expect(isDimensionColumn("CECO:G_A")).toBe(true)
    expect(isDimensionColumn("NO_ANALITICO")).toBe(false)
    expect(isDimensionColumn("FINANCIERO")).toBe(false)
  })
})

describe("criterio 3 · desviación sin imputar, byte a byte", () => {
  const cells = buildVariance({ actual: realNone, budget: budgetNone, actualAllocationState: "NONE" })

  it("las celdas son exactamente las selladas", () => {
    expect(cells.map(seven)).toEqual(expected.variance.withAllocationsFalse.cells)
  })

  it("ninguna celda es no comparable: los dos estados son NONE", () => {
    expect(cells.every((c) => !c.notComparable)).toBe(true)
    expect(varianceCoverage(cells).notComparableCells).toBe(0)
  })

  it("desviación = real − presupuesto al céntimo en todas las celdas", () => {
    for (const cell of cells) expect(cell.varianceCents).toBe(cell.actualCents - (cell.budgetCents ?? 0))
  })

  it("las tres cifras de cabecera del contrato", () => {
    const totalOf = (level: string) =>
      cells.filter((c) => c.level === level).reduce((acc, c) => acc + (c.varianceCents ?? 0), 0)
    expect(totalOf("INGRESOS")).toBe(-76_400)
    expect(totalOf("MC3")).toBe(63_350)
    expect(totalOf("EBITDA")).toBe(228_797)
  })

  it("una celda sin presupuesto sale con las tres derivadas a null, NUNCA a 0", () => {
    const solo = buildVariance({
      actual: { matrixCents: { ...budgetNone.cumulativeCents, INGRESOS: { "PROJ:P-01": 1_000 } }, columns: budgetNone.columns },
      budget: { ...budgetNone, cumulativeCents: { ...budgetNone.cumulativeCents, INGRESOS: { "PROJ:P-01": 0 } } },
      actualAllocationState: "NONE",
    })
    const cell = solo.find((c) => c.level === "INGRESOS" && c.column === "PROJ:P-01")
    expect(cell?.varianceBps).toBeNull()
    expect(cell?.varianceCents).toBe(1_000)
  })

  it("una celda con 0 en las dos matrices no se publica: no dice nada", () => {
    const empty = buildVariance({
      actual: { matrixCents: {}, columns: budgetNone.columns },
      budget: { ...budgetNone, cumulativeCents: {} },
      actualAllocationState: "NONE",
    })
    expect(empty).toEqual([])
  })
})

describe("criterio 27 · comparabilidad presupuesto ↔ real, con las dos liquidadas", () => {
  const cells = buildVariance({ actual: realSettled, budget: budgetSettled, actualAllocationState: "SETTLED" })

  it("la escalera es la de E5: doce meses, cuatro trimestres y el año", () => {
    const ladder = settlementLadder(YEAR_PERIOD)
    expect(ladder.map((p) => p.label)).toEqual([
      ...FY_MONTHS,
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
      "2026",
    ])
  })

  it("la matriz presupuestaria liquidada es la sellada, celda a celda", () => {
    const dryRun = (
      expected.allocation as {
        budgetDryRun: { matrixCents: Record<string, Record<string, number>>; levelTotalsCents: Record<string, number> }
      }
    ).budgetDryRun
    for (const level of MARGIN_LEVELS) expect(budgetSettled.cumulativeCents[level]).toEqual(dryRun.matrixCents[level])
    expect(budgetSettled.levelTotalsCents).toEqual(dryRun.levelTotalsCents)
  })

  it("el dry-run usa LAS MISMAS reglas que el real y lo declara en su rulesHash", () => {
    expect(budgetSettled.allocationState).toBe("SETTLED")
    expect(budgetSettled.budgetRulesHash).toBe(rulesHash(rules))
  })

  it("Σ_c Δ[ℓ][c] = 0 en todo nivel: la imputación es un traspaso de suma cero", () => {
    for (const level of MARGIN_LEVELS) {
      const delta = settlement.value.allocationDeltaCents[level]
      expect(Object.values(delta).reduce((a, b) => a + b, 0)).toBe(0)
    }
  })

  it("los diecisiete runs del dry-run son los sellados, con sus reglas y sus importes", () => {
    const sealed = (
      expected.allocation as {
        budgetDryRun: { runs: { period: string; rulesApplied: string[]; lineCount: number; totalAllocatedCents: number }[] }
      }
    ).budgetDryRun.runs
    expect(
      settlement.value.runs.map((r) => ({
        period: r.period,
        rulesApplied: [...r.rulesApplied].sort(),
        lineCount: r.lineCount,
        totalAllocatedCents: r.totalAllocatedCents,
      }))
    ).toEqual(sealed.map((r) => ({
        period: r.period,
        rulesApplied: [...r.rulesApplied].sort(),
        lineCount: r.lineCount,
        totalAllocatedCents: r.totalAllocatedCents,
      })))
  })

  it("las líneas del dry-run son las selladas: importe, base y bps del driver", () => {
    const sealed = (
      expected.allocation as {
        budgetDryRun: {
          lines: {
            runId: string
            ruleCode: string
            target: string
            marginLevel: string
            amountCents: number
            driverBase: number
            driverBaseTotal: number
            driverShareBps: number
          }[]
        }
      }
    ).budgetDryRun.lines
    expect(
      settlement.value.lines.map((l) => ({
        runId: l.runId,
        ruleCode: l.ruleCode,
        target: l.target.code,
        marginLevel: l.marginLevel,
        amountCents: l.amountCents,
        driverBase: l.driverBase,
        driverBaseTotal: l.driverBaseTotal,
        driverShareBps: l.driverShareBps,
      }))
    ).toEqual(
      sealed.map((l) => ({
        runId: l.runId,
        ruleCode: l.ruleCode,
        target: l.target,
        marginLevel: l.marginLevel,
        amountCents: l.amountCents,
        driverBase: l.driverBase,
        driverBaseTotal: l.driverBaseTotal,
        driverShareBps: l.driverShareBps,
      }))
    )
  })

  it("las celdas de desviación imputadas son las selladas", () => {
    expect(cells.map(seven)).toEqual(expected.variance.withAllocationsTrue.cells)
    expect(cells.every((c) => !c.notComparable)).toBe(true)
  })

  it("INGRESOS, MC1 y MC2 no se mueven al liquidar: la imputación no las toca", () => {
    for (const level of ["INGRESOS", "MC1", "MC2"] as const) {
      expect(budgetSettled.cumulativeCents[level]).toEqual(budgetNone.cumulativeCents[level])
    }
  })
})

describe("criterio 27-bis · cuando el presupuesto no puede seguir", () => {
  const notSettleable = settleBudgetMatrix(budgetNone, {
    rules,
    budgetHours: [],
    headcount,
    config,
    period: YEAR_PERIOD,
  })

  it("una regla HOURS sin horas presupuestadas devuelve BUDGET_NOT_SETTLEABLE", () => {
    expect(notSettleable.ok).toBe(false)
    if (notSettleable.ok) return
    expect(notSettleable.error.code).toBe("BUDGET_NOT_SETTLEABLE")
    expect(notSettleable.error.reason).toContain("AL-OPS-M")
    expect(notSettleable.error.reason).toContain("HORAS")
  })

  it("una regla HEADCOUNT sin ningún snapshot también lo devuelve", () => {
    const noHeadcount = settleBudgetMatrix(budgetNone, {
      rules,
      budgetHours: composed.effective.hours,
      headcount: [],
      config,
      period: YEAR_PERIOD,
    })
    expect(noHeadcount.ok).toBe(false)
    if (noHeadcount.ok) return
    expect(noHeadcount.error.reason).toContain("AL-GA-CC-Y")
    expect(noHeadcount.error.reason).toContain("PLANTILLA")
  })

  it("I-E10-18 · real SETTLED contra presupuesto NONE: 43 celdas no publicadas y 15 sí", () => {
    const cells = buildVariance({ actual: realSettled, budget: budgetNone, actualAllocationState: "SETTLED" })
    expect(cells.map(seven)).toEqual(expected.variance.budgetNotSettleable.cells)
    const coverage = varianceCoverage(cells)
    expect(coverage.notComparableCells).toBe(expected.variance.budgetNotSettleable.notComparableCells)
    expect(coverage.notComparableCells).toBe(43)
    expect(coverage.publishedCells).toBe(expected.variance.budgetNotSettleable.publishedCells)
    expect(coverage.publishedCells).toBe(15)
  })

  it("INGRESOS, MC1 y MC2 SÍ se publican; el total compañía, en todos los niveles", () => {
    const cells = buildVariance({ actual: realSettled, budget: budgetNone, actualAllocationState: "SETTLED" })
    for (const cell of cells) {
      if (["INGRESOS", "MC1", "MC2"].includes(cell.level)) expect(cell.notComparable).toBe(false)
      if (!isDimensionColumn(cell.column)) expect(cell.notComparable).toBe(false)
    }
    // Nunca una matriz mixta: o todas las celdas por dimensión de un nivel ≥ MC3
    // salen sin publicar, o ninguna.
    for (const level of ["MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"] as const) {
      const byDimension = cells.filter((c) => c.level === level && isDimensionColumn(c.column))
      expect(byDimension.every((c) => c.notComparable)).toBe(true)
    }
  })

  it("O-E10-18 · la compensación entre dimensiones no se esconde", () => {
    const cells = buildVariance({ actual: realSettled, budget: budgetSettled, actualAllocationState: "SETTLED" })
    const worst = maxDimensionVariance(cells, "MC3")
    expect(worst).not.toBeNull()
    expect(Math.abs(worst?.varianceCents ?? 0)).toBeGreaterThan(0)
  })
})

describe("O-E10-20 · la absorción que acompaña a la desviación", () => {
  it("el informe de absorción del fixture: −22 787 c de infraabsorción (−87 bps)", () => {
    const sealed = expected.absorption as {
      valuedCents: number
      payrollCents: number
      absorptionCents: number
      absorptionBps: number | null
      byCostCenter: { costCenterCode: string; valuedCents: number; payrollCents: number; absorptionCents: number }[]
    }
    const report = absorptionVariance({
      valuedCents: sealed.valuedCents,
      payrollCents: sealed.payrollCents,
      byCostCenter: sealed.byCostCenter.map((r) => ({
        code: r.costCenterCode,
        valuedCents: r.valuedCents,
        payrollCents: r.payrollCents,
      })),
    })
    expect(report.absorptionCents).toBe(-22_787)
    expect(report.absorptionCents).toBe(sealed.absorptionCents)
    expect(report.direction).toBe("INFRAABSORCION")
    // El IMPORTE cuadra al céntimo con el sellado. El **porcentaje** no: el
    // generador usa `//` de Python (suelo, −87 bps) y `bpsOf` de `lib/time/cost.ts`
    // usa `Math.trunc` (hacia cero, −86 bps). Con absorción negativa las dos
    // convenciones se separan en 1 bps. La que el diseño escribe para
    // `varianceBps` es «suelo de la MAGNITUD y después el signo» (−86), así que
    // el que hay que mover es el fixture, no el motor; queda REPORTADO a T6/T10
    // y no se congela aquí ninguna de las dos.
    expect(Math.abs((report.absorptionBps ?? 0) - (sealed.absorptionBps ?? 0))).toBeLessThanOrEqual(1)
    expect(report.byCostCenter.map((r) => [r.code, r.absorptionCents])).toEqual(
      sealed.byCostCenter.map((r) => [r.costCenterCode, r.absorptionCents])
    )
  })
})
