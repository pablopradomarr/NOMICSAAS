/**
 * E10 · T7 — `lib/budget/matrix.ts`.
 *
 * El criterio 2 de §12: la matriz del presupuesto es la suma de sus líneas, por
 * los ocho niveles y los doce meses, `unresolved` vacío, y **byte a byte**
 * contra `docs/design/fixtures/presupuesto-horas-esperado.v1.4.json`.
 */

import { describe, expect, it } from "vitest"

import { MARGIN_LEVELS } from "@/lib/analytics/types"
import { composeBudget } from "@/lib/budget/hash"
import { buildBudgetMatrix, budgetColumns, windowMonths } from "@/lib/budget/matrix"
import type { BudgetCell, BudgetVersion } from "@/lib/budget/types"
import {
  FY_END,
  FY_MONTHS,
  FY_START,
  config,
  dimensionOf,
  expected,
  versionsFromFixture,
} from "@/lib/budget/fixture.test-support"

const YEAR = { from: FY_START, to: FY_END }

const versionOf = (cells: readonly BudgetCell[], over: Partial<BudgetVersion> = {}): BudgetVersion => ({
  id: "b-1",
  code: "2026-BASE",
  scenario: "BASE",
  revision: 0,
  status: "VIGENTE",
  fiscalYearId: "fy-2026",
  fiscalYearStart: FY_START,
  fiscalYearEnd: FY_END,
  validFrom: FY_START,
  validTo: null,
  partialFrom: null,
  cells,
  hours: [],
  ...over,
})

const effective = composeBudget(versionsFromFixture(), FY_MONTHS).effective
const matrix = buildBudgetMatrix(effective, config, YEAR)

describe("buildBudgetMatrix · casos límite", () => {
  it("caso vacío: matriz densa a cero, sin celdas sin resolver", () => {
    const empty = buildBudgetMatrix(versionOf([]), config, YEAR)
    expect(empty.cellCount).toBe(0)
    expect(empty.unresolved).toEqual([])
    for (const level of MARGIN_LEVELS) expect(empty.levelTotalsCents[level]).toBe(0)
    expect(Object.keys(empty.byMonth)).toEqual(FY_MONTHS)
  })

  it("un registro: el aporte cae en su nivel congelado y se acumula hacia abajo", () => {
    const one = buildBudgetMatrix(
      versionOf([
        {
          month: "2026-03-01",
          accountCode: "705",
          dimension: dimensionOf("PROJECT", "P-01", "BL-CONS"),
          analyticType: "INGRESO_DIRECTO",
          marginLevel: "INGRESOS",
          amountCents: 100_000,
          signException: false,
        },
      ]),
      config,
      YEAR
    )
    expect(one.cumulativeCents.INGRESOS["PROJ:P-01"]).toBe(100_000)
    expect(one.cumulativeCents.RESULTADO["PROJ:P-01"]).toBe(100_000)
    expect(one.byMonth["2026-03"].INGRESOS["PROJ:P-01"]).toBe(100_000)
    expect(one.byMonth["2026-04"].INGRESOS["PROJ:P-01"]).toBe(0)
  })

  it("importes negativos: un CECO de MC3 resta desde MC3, no antes", () => {
    const negative = buildBudgetMatrix(
      versionOf([
        {
          month: "2026-01-01",
          accountCode: "621",
          dimension: dimensionOf("COST_CENTER", "CC-OPS", null),
          analyticType: "INDIRECTO_CECO",
          marginLevel: "MC3",
          amountCents: -50_000,
          signException: false,
        },
      ]),
      config,
      YEAR
    )
    expect(negative.cumulativeCents.MC2["CECO:OPERACIONES_INDIRECTAS"]).toBe(0)
    expect(negative.cumulativeCents.MC3["CECO:OPERACIONES_INDIRECTAS"]).toBe(-50_000)
    expect(negative.levelTotalsCents.MC3).toBe(-50_000)
    expect(negative.levelTotalsBig.MC3).toBe(BigInt(-50_000))
  })

  it("una celda fuera de la ventana no entra, ni en el total ni en el mes", () => {
    const outside = buildBudgetMatrix(
      versionOf([
        {
          month: "2027-01-01",
          accountCode: "705",
          dimension: dimensionOf("PROJECT", "P-01", "BL-CONS"),
          analyticType: "INGRESO_DIRECTO",
          marginLevel: "INGRESOS",
          amountCents: 999,
          signException: false,
        },
      ]),
      config,
      YEAR
    )
    expect(outside.cellCount).toBe(0)
    expect(outside.levelTotalsCents.INGRESOS).toBe(0)
  })

  it("O-E10-7 · el nivel sellado manda, y la discrepancia se declara LEVEL_DRIFT", () => {
    const drifted = buildBudgetMatrix(
      versionOf([
        {
          month: "2026-01-01",
          accountCode: "621",
          dimension: dimensionOf("COST_CENTER", "CC-OPS", null),
          analyticType: "INDIRECTO_CECO",
          // CC-OPS está hoy en MC3; la celda se selló en EBITDA.
          marginLevel: "EBITDA",
          amountCents: -50_000,
          signException: false,
        },
      ]),
      config,
      YEAR
    )
    expect(drifted.cumulativeCents.MC3["CECO:OPERACIONES_INDIRECTAS"]).toBe(0)
    expect(drifted.cumulativeCents.EBITDA["CECO:OPERACIONES_INDIRECTAS"]).toBe(-50_000)
    expect(drifted.unresolved.map((u) => u.code)).toEqual(["LEVEL_DRIFT"])
  })

  it("las columnas y los meses son los del contrato sellado", () => {
    expect(budgetColumns(config)).toEqual(expected.columns)
    expect(windowMonths(YEAR)).toEqual(FY_MONTHS)
    expect(matrix.levels).toEqual(expected.levels)
  })
})

describe("criterio 2 · la matriz del presupuesto del fixture, byte a byte", () => {
  it("las 80 celdas de la versión efectiva entran y ninguna queda sin resolver", () => {
    expect(matrix.cellCount).toBe(expected.budgetComposition.effectiveLineCount)
    expect(matrix.unresolved).toEqual([])
  })

  it.each(MARGIN_LEVELS)("la matriz cumulativa del nivel %s coincide celda a celda", (level) => {
    expect(matrix.cumulativeCents[level]).toEqual(expected.budgetMatrixCents[level])
  })

  it("los totales por nivel son los sellados, también en BigInt", () => {
    expect(matrix.levelTotalsCents).toEqual(expected.budgetLevelTotalsCents)
    for (const level of MARGIN_LEVELS) {
      expect(matrix.levelTotalsBig[level]).toBe(BigInt(expected.budgetLevelTotalsCents[level]))
    }
  })

  it("Σ_c presupuesto[ℓ][c] = Σ de las líneas de los niveles ≤ ℓ, en los ocho niveles", () => {
    let running = 0
    for (const level of MARGIN_LEVELS) {
      running += effective.cells
        .filter((c) => c.marginLevel === level)
        .reduce((acc, c) => acc + c.amountCents, 0)
      expect(matrix.levelTotalsCents[level]).toBe(running)
    }
  })

  it.each(FY_MONTHS)("la matriz del mes %s coincide celda a celda", (month) => {
    expect(matrix.byMonth[month]).toEqual(expected.budgetMatrixByMonthCents[month])
  })

  it("el anual es la suma de los doce meses, al céntimo", () => {
    for (const level of MARGIN_LEVELS) {
      for (const column of matrix.columns) {
        const sum = FY_MONTHS.reduce((acc, m) => acc + matrix.byMonth[m][level][column], 0)
        expect(sum).toBe(matrix.cumulativeCents[level][column])
      }
    }
  })

  it("los agregados por línea de negocio son los sellados y NO entran en el total", () => {
    expect(matrix.businessLineMatrixCents).toEqual(expected.budgetBusinessLineMatrixCents)
    expect(matrix.businessLineMatrixCents.INGRESOS["BL-CONS"] + matrix.businessLineMatrixCents.INGRESOS["BL-DEV"]).toBe(
      matrix.levelTotalsCents.INGRESOS
    )
  })

  it("la matriz nace SIN imputar: allocationState NONE y sin rulesHash", () => {
    expect(matrix.allocationState).toBe("NONE")
    expect(matrix.budgetRulesHash).toBeNull()
    expect(matrix.settlementWarnings).toEqual([])
  })
})
