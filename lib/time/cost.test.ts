/**
 * E10 · T6 — tests de `lib/time/cost.ts`.
 *
 * Casos límite obligatorios del encargo: 0 horas, sólo no aprobadas, cambio de
 * tarifa a mitad de mes, empate del Hamilton (O-E10-13) y los cuatro no
 * evaluables (tarifa ausente, tarifa solapada, sin minutos productivos, sin
 * nómina / cobertura insuficiente), más el conflicto de `basis` (O-E10-14/15) y
 * la absorción (O-E10-20).
 */

import { describe, expect, it } from "vitest"

import { TimeEntryRow } from "@/lib/time/aggregate"
import {
  DEFAULT_PAYROLL_ACCOUNT_PREFIXES,
  EmployeeRateRow,
  PAYROLL_PREFIXES_BY_BASIS,
  TimeCostError,
  absorptionVariance,
  checkRateBasisConflict,
  costOfTime,
  deriveHourlyCost,
  matchesPayrollPrefix,
  overlappingRates,
  rateAt,
} from "@/lib/time/cost"

const MARCH = { from: "2026-03-01", to: "2026-03-31" }

const project = (code: string) => ({ kind: "PROJECT" as const, id: `p-${code}`, code })

let seq = 0
function entry(partial: Partial<TimeEntryRow> & { minutes: number }): TimeEntryRow {
  seq += 1
  return {
    id: `t-${String(seq).padStart(3, "0")}`,
    employeeId: "e-1",
    employeeCode: "EMP-001",
    date: "2026-03-10",
    target: project("P-01"),
    businessLineCode: "LN-1",
    productive: true,
    approved: true,
    ...partial,
  }
}

const rate = (over: Partial<EmployeeRateRow> & { hourlyCostCents: number }): EmployeeRateRow => ({
  id: `r-${over.hourlyCostCents}-${over.validFrom ?? "x"}`,
  employeeId: "e-1",
  employeeCode: "EMP-001",
  basis: "COSTE_EMPRESA_CON_SS",
  validFrom: "2026-01-01",
  validTo: null,
  ...over,
})

describe("rateAt y vigencias", () => {
  const rates = [
    rate({ hourlyCostCents: 3000, validFrom: "2026-01-01", validTo: "2026-03-15" }),
    rate({ hourlyCostCents: 3517, validFrom: "2026-03-16", validTo: null }),
  ]

  it("elige la vigente el DÍA del parte, no la de fin de periodo", () => {
    expect(rateAt(rates, "e-1", "2026-03-15")).toMatchObject({ kind: "FOUND", rate: { hourlyCostCents: 3000 } })
    expect(rateAt(rates, "e-1", "2026-03-16")).toMatchObject({ kind: "FOUND", rate: { hourlyCostCents: 3517 } })
  })

  it("sin tarifa ese día devuelve MISSING; jamás la anterior", () => {
    expect(rateAt(rates, "e-1", "2025-12-31").kind).toBe("MISSING")
    expect(rateAt(rates, "e-9", "2026-03-10").kind).toBe("MISSING")
  })

  it("dos vigencias solapadas se denuncian, no se elige una", () => {
    const solapadas = [
      rate({ id: "a", hourlyCostCents: 3000, validFrom: "2026-01-01", validTo: "2026-03-31" }),
      rate({ id: "b", hourlyCostCents: 3517, validFrom: "2026-03-01", validTo: null }),
    ]
    expect(rateAt(solapadas, "e-1", "2026-03-10").kind).toBe("OVERLAP")
    expect(overlappingRates(solapadas)).toEqual([{ employeeCode: "EMP-001", a: "a", b: "b" }])
    expect(overlappingRates(rates)).toEqual([])
  })
})

describe("costOfTime", () => {
  it("con 0 partes no hay coste ni filas no evaluables", () => {
    const out = costOfTime([], [rate({ hourlyCostCents: 3517 })], MARCH)
    expect(out.byTarget).toEqual([])
    expect(out.unpriced).toEqual([])
    expect(out.totals).toEqual({ minutes: 0, valuedCents: 0, evaluableTargets: 0, notEvaluableTargets: 0 })
  })

  it("sólo con partes SIN aprobar no se valora nada (R-H-3)", () => {
    const out = costOfTime([entry({ minutes: 480, approved: false })], [rate({ hourlyCostCents: 3517 })], MARCH)
    expect(out.byTarget).toEqual([])
  })

  it("las horas NO productivas quedan fuera: la tarifa ya las absorbe (Q-3, modelo A)", () => {
    const rows = [entry({ minutes: 480 }), entry({ minutes: 300, productive: false })]
    const out = costOfTime(rows, [rate({ hourlyCostCents: 3000 })], MARCH)
    expect(out.byTarget[0].minutes).toBe(480)
    expect(out.byTarget[0].costCents).toBe(24000) // ⌊480 × 3000 / 60⌋
  })

  it("cambio de tarifa a mitad de mes: cada parte con la suya", () => {
    const rates = [
      rate({ id: "r1", hourlyCostCents: 3000, validFrom: "2026-01-01", validTo: "2026-03-15" }),
      rate({ id: "r2", hourlyCostCents: 3600, validFrom: "2026-03-16", validTo: null }),
    ]
    const rows = [entry({ minutes: 600, date: "2026-03-10" }), entry({ minutes: 600, date: "2026-03-20" })]
    const out = costOfTime(rows, rates, MARCH)
    expect(out.byTarget[0].entries.map((e) => [e.date, e.hourlyCostCents, e.costCents])).toEqual([
      ["2026-03-10", 3000, 30000],
      ["2026-03-20", 3600, 36000],
    ])
    expect(out.byTarget[0].costCents).toBe(66000)
  })

  it("Hamilton: el céntimo del truncamiento va al mayor resto y Σ por parte = T", () => {
    // 440 min → 1 547 480 c·min ⇒ ⌊⌋ 25 791, resto 20
    // 100 min →   351 700 c·min ⇒ ⌊⌋  5 861, resto 40
    // T = ⌊1 899 180 / 60⌋ = 31 653 ⇒ falta 1 c, y va al resto 40.
    const rows = [entry({ minutes: 440, date: "2026-03-05" }), entry({ minutes: 100, date: "2026-03-06" })]
    const out = costOfTime(rows, [rate({ hourlyCostCents: 3517 })], MARCH)
    const target = out.byTarget[0]
    expect(target.entries.map((e) => e.costCents)).toEqual([25791, 5862])
    expect(target.costCents).toBe(31653)
    expect(target.entries.reduce((a, e) => a + e.costCents, 0)).toBe(target.costCents)
  })

  it("empate de restos: gana el parte de menor (fecha, código de empleado, id)", () => {
    const rows = [
      entry({ minutes: 1, date: "2026-03-02", employeeId: "e-2", employeeCode: "EMP-002", id: "z" }),
      entry({ minutes: 1, date: "2026-03-01", employeeId: "e-1", employeeCode: "EMP-001", id: "a" }),
    ]
    const rates = [rate({ hourlyCostCents: 90 }), rate({ id: "r2", employeeId: "e-2", employeeCode: "EMP-002", hourlyCostCents: 90 })]
    const out = costOfTime(rows, rates, MARCH)
    // p = 90 en los dos ⇒ base 1 y resto 30 cada uno; T = ⌊180/60⌋ = 3 ⇒ 1 c al primero.
    expect(out.byTarget[0].entries.map((e) => [e.entryId, e.costCents])).toEqual([
      ["a", 2],
      ["z", 1],
    ])
    expect(out.byTarget[0].costCents).toBe(3)
  })

  it("es determinista: el orden de entrada no cambia ni una cifra", () => {
    const rows = [
      entry({ minutes: 440, date: "2026-03-05" }),
      entry({ minutes: 100, date: "2026-03-06" }),
      entry({ minutes: -40, date: "2026-03-07" }),
      entry({ minutes: 200, date: "2026-03-08", target: project("P-02") }),
    ]
    const rates = [rate({ hourlyCostCents: 3517 })]
    const a = costOfTime(rows, rates, MARCH)
    const b = costOfTime([rows[3], rows[1], rows[0], rows[2]], rates, MARCH)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it("el contra-apunte resta con su signo y Σ por parte sigue siendo el total", () => {
    const rows = [entry({ minutes: 480, date: "2026-03-05" }), entry({ minutes: -250, date: "2026-03-06" })]
    const out = costOfTime(rows, [rate({ hourlyCostCents: 3517 })], MARCH)
    const target = out.byTarget[0]
    expect(target.minutes).toBe(230)
    expect(target.costCents).toBe(Math.floor((480 * 3517 - 250 * 3517) / 60))
    expect(target.entries.reduce((a, e) => a + e.costCents, 0)).toBe(target.costCents)
  })

  it("sin tarifa vigente el receptor es NO EVALUABLE, nunca 0, con empleado y fecha", () => {
    const rows = [
      entry({ minutes: 480, date: "2026-03-05" }),
      entry({ minutes: 480, date: "2026-02-20", employeeId: "e-9", employeeCode: "EMP-009" }),
      entry({ minutes: 120, date: "2026-03-20", employeeId: "e-9", employeeCode: "EMP-009" }),
    ]
    const out = costOfTime(rows, [rate({ hourlyCostCents: 3517 })], MARCH)
    expect(out.byTarget[0].costCents).toBeNull()
    expect(out.byTarget[0].notEvaluableReason).toBe("TARIFA_AUSENTE")
    expect(out.unpriced).toEqual([
      {
        entryId: rows[2].id,
        employeeCode: "EMP-009",
        employeeId: "e-9",
        date: "2026-03-20",
        targetCode: "P-01",
        minutes: 120,
        reason: "TARIFA_AUSENTE",
      },
    ])
    expect(out.totals.valuedCents).toBe(0)
    expect(out.totals.notEvaluableTargets).toBe(1)
  })

  it("tarifa solapada ⇒ no evaluable por `TARIFA_SOLAPADA`", () => {
    const rates = [
      rate({ id: "a", hourlyCostCents: 3000, validFrom: "2026-01-01", validTo: "2026-03-31" }),
      rate({ id: "b", hourlyCostCents: 3517, validFrom: "2026-03-01", validTo: null }),
    ]
    const out = costOfTime([entry({ minutes: 60 })], rates, MARCH)
    expect(out.byTarget[0].notEvaluableReason).toBe("TARIFA_SOLAPADA")
    expect(out.byTarget[0].costCents).toBeNull()
  })

  it("mezclar bases en un receptor deja la cifra sin significado: no evaluable (O-E10-15)", () => {
    const rates = [
      rate({ hourlyCostCents: 3517, basis: "COSTE_EMPRESA_CON_SS" }),
      rate({ id: "r2", employeeId: "e-2", employeeCode: "EMP-002", hourlyCostCents: 2666, basis: "BRUTO_SIN_SS" }),
    ]
    const rows = [entry({ minutes: 60 }), entry({ minutes: 60, employeeId: "e-2", employeeCode: "EMP-002" })]
    const out = costOfTime(rows, rates, MARCH)
    expect(out.byTarget[0].notEvaluableReason).toBe("BASIS_CONFLICT")
    expect(out.byTarget[0].costCents).toBeNull()
    expect(out.byTarget[0].basis).toBeNull()
    expect(out.basisConflict).toEqual(["BRUTO_SIN_SS", "COSTE_EMPRESA_CON_SS"])
  })

  it("una tarifa ≤ 0 o no entera se rechaza", () => {
    expect(() => costOfTime([], [rate({ hourlyCostCents: 0 })], MARCH)).toThrow(TimeCostError)
    expect(() => costOfTime([], [rate({ hourlyCostCents: 35.17 })], MARCH)).toThrow(/entero/)
  })
})

describe("deriveHourlyCost (D3 / O-E10-11, O-E10-12)", () => {
  const base = {
    scope: "COST_CENTER" as const,
    productiveMinutes: 90000,
    linesTotal: 34,
    linesMatched: 34,
    matchedAmountCents: 5276000,
    accountPrefixes: DEFAULT_PAYROLL_ACCOUNT_PREFIXES,
    basis: "COSTE_EMPRESA_CON_SS" as const,
    minCoverageBps: 7500,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    costCenterCode: "CC-OPS",
  }

  it("coste empresa con SS: 5 276 000 c y 90 000 minutos ⇒ 3 517 c/h con sus términos", () => {
    const out = deriveHourlyCost({ ...base, payrollCents: 5276000 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.hourlyCostCents).toBe(3517)
    expect(out.value.derivation).toMatchObject({
      scope: "COST_CENTER",
      costCenterCode: "CC-OPS",
      payrollCents: 5276000,
      productiveMinutes: 90000,
      accountPrefixes: ["640", "642", "645", "649"],
      excludedPrefixes: ["641"],
      basis: "COSTE_EMPRESA_CON_SS",
      coverageBps: null,
    })
  })

  it("la misma nómina en BRUTO_SIN_SS da 2 666 c/h: 851 c/h de diferencia (Q-1)", () => {
    const out = deriveHourlyCost({
      ...base,
      payrollCents: 4000000,
      basis: "BRUTO_SIN_SS",
      accountPrefixes: PAYROLL_PREFIXES_BY_BASIS.BRUTO_SIN_SS,
    })
    expect(out.ok && out.value.hourlyCostCents).toBe(2666)
  })

  it("`641` nunca entra en la base por defecto", () => {
    expect(DEFAULT_PAYROLL_ACCOUNT_PREFIXES).not.toContain("641")
    expect(matchesPayrollPrefix("6410", DEFAULT_PAYROLL_ACCOUNT_PREFIXES)).toBe(false)
    expect(matchesPayrollPrefix("6400", DEFAULT_PAYROLL_ACCOUNT_PREFIXES)).toBe(true)
    expect(matchesPayrollPrefix("6420", PAYROLL_PREFIXES_BY_BASIS.BRUTO_SIN_SS)).toBe(false)
  })

  it("sin minutos productivos: NO EVALUABLE, nunca ∞ ni 0", () => {
    const out = deriveHourlyCost({ ...base, payrollCents: 5276000, productiveMinutes: 0 })
    expect(out).toMatchObject({ ok: false, error: "NO_PRODUCTIVE_TIME" })
  })

  it("sin nómina: NO EVALUABLE", () => {
    expect(deriveHourlyCost({ ...base, payrollCents: 0 })).toMatchObject({ ok: false, error: "NO_PAYROLL" })
  })

  it("ámbito EMPLEADO con cobertura suficiente: declara su cobertura", () => {
    const out = deriveHourlyCost({
      ...base,
      scope: "EMPLOYEE",
      employeeCode: "EMP-001",
      payrollCents: 5276000,
      matchedAmountCents: 4115280, // 78 % del importe
      linesMatched: 8,
      productiveMinutes: 90000,
      minCoverageBps: 7500,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.derivation.coverageBps).toBe(7800)
    expect(out.value.derivation.linesMatched).toBe(8)
    expect(out.value.hourlyCostCents).toBe(Math.floor((4115280 * 60) / 90000))
  })

  it("por debajo de la cobertura mínima NO extrapola en silencio", () => {
    const out = deriveHourlyCost({
      ...base,
      scope: "EMPLOYEE",
      employeeCode: "EMP-001",
      payrollCents: 5276000,
      matchedAmountCents: 1000000,
      linesMatched: 3,
      minCoverageBps: 7500,
    })
    expect(out).toMatchObject({ ok: false, error: "COVERAGE_TOO_LOW", coverageBps: 1895 })
  })
})

describe("checkRateBasisConflict (O-E10-14)", () => {
  it("COSTE_TOTAL_CON_ESTRUCTURA con una regla de actividad vigente es excluyente", () => {
    const out = checkRateBasisConflict("COSTE_TOTAL_CON_ESTRUCTURA", [
      { driver: "HOURS", code: "R-01" },
      { driver: "REVENUE_SHARE", code: "R-02" },
    ])
    expect(out).toMatchObject({ ok: false, code: "RATE_BASIS_CONFLICT", rules: ["R-01"] })
  })

  it("sin reglas de actividad, o con otra base, no hay conflicto", () => {
    expect(checkRateBasisConflict("COSTE_TOTAL_CON_ESTRUCTURA", [{ driver: "REVENUE_SHARE" }])).toEqual({ ok: true })
    expect(checkRateBasisConflict("COSTE_EMPRESA_CON_SS", [{ driver: "HOURS", code: "R-01" }])).toEqual({ ok: true })
  })
})

describe("absorptionVariance (O-E10-20)", () => {
  it("5 275 500 c valorados contra 5 276 000 c de nómina: infraabsorción de −500 c", () => {
    const out = absorptionVariance({
      valuedCents: 5275500,
      payrollCents: 5276000,
      byCostCenter: [
        { code: "CC-OPS", valuedCents: 3275500, payrollCents: 3276000 },
        { code: "CC-DEV", valuedCents: 2000000, payrollCents: 2000000 },
      ],
    })
    expect(out.absorptionCents).toBe(-500)
    expect(out.direction).toBe("INFRAABSORCION")
    expect(out.byCostCenter.map((r) => [r.code, r.absorptionCents, r.direction])).toEqual([
      ["CC-DEV", 0, "EXACTA"],
      ["CC-OPS", -500, "INFRAABSORCION"],
    ])
  })

  it("una infraabsorción del 20 % se publica con su % (I-E10-12 no la ve)", () => {
    const out = absorptionVariance({ valuedCents: 800000, payrollCents: 1000000, byCostCenter: [] })
    expect(out.absorptionBps).toBe(-2000)
    expect(out.direction).toBe("INFRAABSORCION")
  })

  it("sobreabsorción y nómina 0 (% no evaluable, nunca ∞)", () => {
    expect(absorptionVariance({ valuedCents: 1100000, payrollCents: 1000000, byCostCenter: [] })).toMatchObject({
      absorptionCents: 100000,
      absorptionBps: 1000,
      direction: "SOBREABSORCION",
    })
    expect(absorptionVariance({ valuedCents: 0, payrollCents: 0, byCostCenter: [] })).toMatchObject({
      absorptionBps: null,
      direction: "EXACTA",
    })
  })
})
