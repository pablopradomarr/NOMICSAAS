/**
 * E10 · T8 — `lib/budget/forecast.ts`.
 *
 * Criterio 7 de §12: con los meses cerrados hasta junio, el forecast usa real de
 * enero a junio y presupuesto de julio a diciembre, `provenanceByMonth` lo dice
 * mes a mes, **I-E10-7** en PASS y `Σ forecast = Σ real + Σ ppto` al céntimo.
 */

import { describe, expect, it } from "vitest"

import { MARGIN_LEVELS } from "@/lib/analytics/types"
import { buildForecast, cumulateContribution, decumulate, forecastCoversFiscalYear } from "@/lib/budget/forecast"
import { composeBudget } from "@/lib/budget/hash"
import { buildBudgetMatrix } from "@/lib/budget/matrix"
import { FY_END, FY_MONTHS, FY_START, config, expected, versionsFromFixture } from "@/lib/budget/fixture.test-support"

const YEAR = { from: FY_START, to: FY_END }
const composed = composeBudget(versionsFromFixture(), FY_MONTHS)
const budget = buildBudgetMatrix(composed.effective, config, YEAR)
const actualByMonth = expected.realMatrixByMonthCents
const provenance = Object.fromEntries(Object.entries(composed.provenanceByMonth).map(([m, p]) => [m, p.label]))

const forecast = buildForecast({
  actualByMonth,
  budget,
  fiscalYearMonths: FY_MONTHS,
  cutoffMonth: expected.forecast.cutoffMonth,
  budgetProvenanceByMonth: provenance,
})

describe("decumulate / cumulateContribution · son inversas", () => {
  it("la cumulativa de una matriz de aporte devuelve la de partida", () => {
    const contribution = decumulate(budget.cumulativeCents, budget.columns)
    expect(cumulateContribution(contribution, budget.columns)).toEqual(budget.cumulativeCents)
  })

  it("un mes ausente decumula a ceros densos, no a undefined", () => {
    const zero = decumulate(undefined, budget.columns)
    for (const level of MARGIN_LEVELS) for (const column of budget.columns) expect(zero[level][column]).toBe(0)
  })
})

describe("criterio 7 · forecast con corte a fin de junio", () => {
  it("la procedencia mes a mes es la sellada: real hasta junio, presupuesto después", () => {
    expect(forecast.provenanceByMonth).toEqual(expected.forecast.provenanceByMonth)
    expect(forecast.cutoffMonth).toBe("2026-06")
  })

  it("cada mes de presupuesto dice de qué versión sale (O-E10-9)", () => {
    for (const month of FY_MONTHS) {
      expect(forecast.byMonth[month].provenanceBudget).toBe(expected.forecast.byMonth[month].provenanceBudget)
    }
  })

  it("los totales por nivel son los sellados", () => {
    expect(forecast.levelTotalsCents).toEqual(expected.forecast.levelTotalsCents)
    for (const level of MARGIN_LEVELS) {
      expect(forecast.levelTotalsBig[level]).toBe(BigInt(expected.forecast.levelTotalsCents[level]))
    }
  })

  it.each(MARGIN_LEVELS)("la matriz reproyectada del nivel %s coincide celda a celda", (level) => {
    expect(forecast.matrixCents[level]).toEqual(expected.forecast.matrixCents[level])
  })

  it("el aporte de cada mes es el sellado, celda a celda", () => {
    for (const month of FY_MONTHS) {
      for (const level of MARGIN_LEVELS) {
        for (const column of forecast.columns) {
          expect(forecast.byMonth[month].contributionCents[level][column]).toBe(
            expected.forecast.byMonth[month].cells[level][column] ?? 0
          )
        }
      }
    }
  })

  it("Σ forecast = Σ real(ene-jun) + Σ ppto(jul-dic), al céntimo y por nivel", () => {
    /** Aporte total del nivel en un mes, salga del real o del presupuesto. */
    const contributionOf = (level: string, month: string): number => {
      const cumulative = month <= "2026-06" ? actualByMonth[month] : budget.byMonth[month]
      const contribution = decumulate(cumulative, budget.columns)
      return budget.columns.reduce((acc, column) => acc + contribution[level][column], 0)
    }
    let running = 0
    for (const level of MARGIN_LEVELS) {
      running += FY_MONTHS.reduce((acc, month) => acc + contributionOf(level, month), 0)
      expect(forecast.levelTotalsCents[level]).toBe(running)
    }
  })

  it("I-E10-7 · los doce meses, una vez cada uno y con una sola procedencia", () => {
    expect(forecastCoversFiscalYear(forecast, FY_MONTHS)).toEqual({ ok: true, missing: [], extra: [] })
    expect(Object.keys(forecast.byMonth)).toHaveLength(12)
    expect(new Set(Object.keys(forecast.byMonth)).size).toBe(12)
  })
})

describe("casos límite del forecast", () => {
  it("sin ningún mes cerrado, el forecast es el presupuesto entero, sin error", () => {
    const all = buildForecast({ actualByMonth, budget, fiscalYearMonths: FY_MONTHS, cutoffMonth: null })
    expect(new Set(Object.values(all.provenanceByMonth))).toEqual(new Set(["PRESUPUESTO_ABIERTO"]))
    expect(all.levelTotalsCents).toEqual(budget.levelTotalsCents)
  })

  it("con el ejercicio entero cerrado, el forecast es el real entero", () => {
    const all = buildForecast({ actualByMonth, budget, fiscalYearMonths: FY_MONTHS, cutoffMonth: "2026-12" })
    expect(new Set(Object.values(all.provenanceByMonth))).toEqual(new Set(["REAL_CERRADO"]))
    for (const level of MARGIN_LEVELS) {
      let sum = 0
      for (const column of budget.columns) sum += expected.realMatrixCents[level][column] ?? 0
      expect(all.levelTotalsCents[level]).toBe(sum)
    }
  })

  it("un ejercicio sin meses no produce ni un mes ni una cifra", () => {
    const none = buildForecast({ actualByMonth: {}, budget, fiscalYearMonths: [], cutoffMonth: null })
    expect(none.byMonth).toEqual({})
    for (const level of MARGIN_LEVELS) expect(none.levelTotalsCents[level]).toBe(0)
  })

  it("un mes del ejercicio sin real NI presupuesto aporta 0, no rompe el año", () => {
    const withGap = buildForecast({
      actualByMonth: {},
      budget,
      fiscalYearMonths: ["2026-01"],
      cutoffMonth: "2026-01",
    })
    expect(withGap.byMonth["2026-01"].source).toBe("REAL_CERRADO")
    for (const level of MARGIN_LEVELS) expect(withGap.levelTotalsCents[level]).toBe(0)
  })
})
