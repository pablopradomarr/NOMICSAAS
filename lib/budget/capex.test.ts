/**
 * E12 · T19 — tests de `lib/budget/capex.ts` (Q-4; ADR-0018 D2 enmendada).
 *
 * Los cinco casos límite que `dev-backend` exige de toda función pura: vacío, un
 * registro, importes negativos (aquí: la convención de signo del aporte), fechas
 * límite (alta en diciembre, alta fuera del ejercicio) y redondeo de céntimos
 * —que es el que de verdad muerde: **Σ dotaciones = base amortizable**, exacto—.
 *
 * Las cifras esperadas son **literales congelados**, tomados del ejemplo que
 * escribió Q-4 o calculados a mano; ninguna sale de llamar al módulo que se
 * prueba (regla 7 de §7.3).
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_DEPRECIATION_ACCOUNT,
  addMonths,
  capexDepreciationForFiscalYear,
  capexDepreciationTotal,
  capexSchedule,
  capexToBudgetCells,
  type BudgetCapexCell,
} from "@/lib/budget/capex"
import type { BudgetDimension } from "@/lib/budget/types"

const P01: BudgetDimension = { kind: "PROJECT", id: "p1", code: "P-01", businessLineCode: "LN-1" }
const CCOPS: BudgetDimension = { kind: "COST_CENTER", id: "c1", code: "CC-OPS" }

const capex = (over: Partial<BudgetCapexCell> = {}): BudgetCapexCell => ({
  month: "2026-04-01",
  accountCode: "213",
  dimension: CCOPS,
  amountCents: 3_000_000,
  residualCents: 0,
  method: "LINEAL",
  usefulLifeMonths: 60,
  startsAt: "MES_DE_ALTA",
  ...over,
})

describe("addMonths — aritmética de calendario sin `Date`", () => {
  it("avanza dentro del año", () => {
    expect(addMonths("2026-04", 3)).toBe("2026-07")
  })
  it("cruza el año", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02")
  })
  it("no avanza con 0", () => {
    expect(addMonths("2026-01", 0)).toBe("2026-01")
  })
  it("cruza varios años", () => {
    expect(addMonths("2026-04", 60)).toBe("2031-04")
  })
})

describe("capexSchedule — el calendario completo, no el del ejercicio", () => {
  it("el ejemplo de Q-4: 3.000.000 c, lineal a 5 años, alta en abril", () => {
    const rows = capexSchedule(capex())
    expect(rows).toHaveLength(60)
    expect(rows[0]!.month).toBe("2026-04")
    expect(rows[59]!.month).toBe("2031-03")
    // 3.000.000 / 60 = 50.000 exactos, sin resto que repartir.
    expect(new Set(rows.map((r) => r.amountCents))).toEqual(new Set([50_000]))
  })

  it("`MES_SIGUIENTE` desplaza la primera dotación un mes (D-3 de E9)", () => {
    const rows = capexSchedule(capex({ startsAt: "MES_SIGUIENTE" }))
    expect(rows[0]!.month).toBe("2026-05")
    expect(rows[59]!.month).toBe("2031-04")
  })

  it("Σ dotaciones = base amortizable, EXACTO, aunque no divida", () => {
    // 1.000.000 c entre 7 meses: 142.857,14… Reparto por mayor resto.
    const rows = capexSchedule(capex({ amountCents: 1_000_000, usefulLifeMonths: 7 }))
    expect(rows.reduce((a, r) => a + r.amountCents, 0)).toBe(1_000_000)
    // Y el resto se reparte, no se tira: hay meses de 142.858 y de 142.857.
    expect([...new Set(rows.map((r) => r.amountCents))].sort()).toEqual([142_857, 142_858])
  })

  it("el valor residual NO se amortiza", () => {
    const rows = capexSchedule(capex({ amountCents: 1_200_000, residualCents: 200_000, usefulLifeMonths: 10 }))
    expect(rows.reduce((a, r) => a + r.amountCents, 0)).toBe(1_000_000)
    expect(rows).toHaveLength(10)
  })

  it("`SUMA_DIGITOS` es degresivo y sigue sumando la base exacta", () => {
    const rows = capexSchedule(capex({ amountCents: 1_000_000, usefulLifeMonths: 4, method: "SUMA_DIGITOS" }))
    // Pesos 4,3,2,1 sobre 10: 400.000 / 300.000 / 200.000 / 100.000.
    expect(rows.map((r) => r.amountCents)).toEqual([400_000, 300_000, 200_000, 100_000])
    expect(rows.reduce((a, r) => a + r.amountCents, 0)).toBe(1_000_000)
  })

  it("caso vacío: una inversión sin base amortizable no produce dotación", () => {
    expect(capexSchedule(capex({ amountCents: 100, residualCents: 99, usefulLifeMonths: 0 }))).toEqual([])
  })
})

describe("capexDepreciationForFiscalYear — sólo los meses del ejercicio", () => {
  it("el ejemplo de Q-4 da 450.000 c en 2026 (abril a diciembre)", () => {
    const rows = capexDepreciationForFiscalYear([capex()], "2026-01-01", "2026-12-31")
    expect(rows).toHaveLength(9)
    expect(rows[0]!.month).toBe("2026-04")
    expect(rows[8]!.month).toBe("2026-12")
    expect(capexDepreciationTotal(rows)).toBe(450_000)
  })

  it("una inversión de diciembre sólo aporta su mes", () => {
    const rows = capexDepreciationForFiscalYear([capex({ month: "2026-12-01" })], "2026-01-01", "2026-12-31")
    expect(rows).toHaveLength(1)
    expect(capexDepreciationTotal(rows)).toBe(50_000)
  })

  it("una inversión de diciembre con `MES_SIGUIENTE` NO aporta nada al ejercicio", () => {
    const rows = capexDepreciationForFiscalYear(
      [capex({ month: "2026-12-01", startsAt: "MES_SIGUIENTE" })],
      "2026-01-01",
      "2026-12-31"
    )
    expect(rows).toEqual([])
    expect(capexDepreciationTotal(rows)).toBe(0)
  })

  it("dos inversiones sobre la misma dimensión y el mismo mes se AGREGAN", () => {
    const rows = capexDepreciationForFiscalYear(
      [capex({ usefulLifeMonths: 12, amountCents: 1_200_000, month: "2026-01-01" }),
       capex({ usefulLifeMonths: 12, amountCents: 2_400_000, month: "2026-01-01" })],
      "2026-01-01",
      "2026-12-31"
    )
    expect(rows).toHaveLength(12)
    expect(rows[0]!.amountCents).toBe(100_000 + 200_000)
    expect(capexDepreciationTotal(rows)).toBe(3_600_000)
  })

  it("dos dimensiones distintas NO se mezclan, y el orden es determinista", () => {
    const rows = capexDepreciationForFiscalYear(
      [capex({ dimension: P01, month: "2026-01-01", usefulLifeMonths: 12, amountCents: 1_200_000 }),
       capex({ dimension: CCOPS, month: "2026-01-01", usefulLifeMonths: 12, amountCents: 1_200_000 })],
      "2026-01-01",
      "2026-12-31"
    )
    expect(rows).toHaveLength(24)
    // Enero primero, y dentro de enero, COST_CENTER antes que PROJECT (orden
    // lexicográfico de la clave canónica). Lo que importa es que sea ESTABLE.
    expect(rows.slice(0, 2).map((r) => `${r.month}/${r.dimension.kind}`)).toEqual([
      "2026-01/COST_CENTER",
      "2026-01/PROJECT",
    ])
  })

  it("caso vacío: sin inversiones, ni una fila y total 0", () => {
    expect(capexDepreciationForFiscalYear([], "2026-01-01", "2026-12-31")).toEqual([])
    expect(capexDepreciationTotal([])).toBe(0)
  })

  it("una inversión de un ejercicio ANTERIOR sigue dotando en éste", () => {
    const rows = capexDepreciationForFiscalYear([capex({ month: "2025-04-01" })], "2026-01-01", "2026-12-31")
    expect(rows).toHaveLength(12)
    expect(capexDepreciationTotal(rows)).toBe(600_000)
  })
})

describe("capexToBudgetCells — la PROPUESTA, con el signo de aporte de D2", () => {
  it("la dotación es un gasto y entra en NEGATIVO", () => {
    const rows = capexDepreciationForFiscalYear([capex()], "2026-01-01", "2026-12-31")
    const cells = capexToBudgetCells(rows)
    expect(cells).toHaveLength(9)
    expect(cells[0]).toEqual({
      month: "2026-04-01",
      accountCode: DEFAULT_DEPRECIATION_ACCOUNT,
      dimension: CCOPS,
      amountCents: -50_000,
    })
    expect(cells.reduce((a, c) => a + c.amountCents, 0)).toBe(-450_000)
  })

  it("admite otra `68x` cuando la inversión no es material", () => {
    const rows = capexDepreciationForFiscalYear([capex({ accountCode: "206" })], "2026-01-01", "2026-12-31")
    expect(capexToBudgetCells(rows, { accountCode: "680" })[0]!.accountCode).toBe("680")
  })

  it("la cuenta por omisión es la 681 del PGC 2007", () => {
    expect(DEFAULT_DEPRECIATION_ACCOUNT).toBe("681")
  })
})
