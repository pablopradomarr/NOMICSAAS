/**
 * E10 · T11 — Tests de los invariantes del presupuesto y de las horas.
 *
 * La regla que gobierna este fichero, y que cada caso comprueba: **nunca un PASS
 * que no se haya comprobado**. Por eso hay, para casi todos, tres casos —el que
 * cuadra, el que no, y el que **no se puede evaluar**— y el tercero exige `INFO`
 * diciendo qué falta, jamás verde.
 */

import { describe, expect, it } from "vitest"

import {
  budgetSealReasons,
  checkIE101,
  checkIE102,
  checkIE103,
  checkIE104,
  checkIE105,
  checkIE106,
  checkIE107,
  checkIE108,
  checkIE109,
  checkIE1010,
  checkIE1011,
  checkIE1012,
  checkIE1013,
  checkIE1014,
  checkIE1015,
  checkIE1016,
  checkIE1017,
  checkIE1018,
  isE10SealReason,
  runBudgetInvariants,
  E10_SEAL_REASONS,
  E10_SEAL_REASON_BY_RULE,
  E10_SEAL_REASON_TEXT,
  type AllocationRunAudit,
  type BudgetBlock,
  type BudgetLineRef,
  type BudgetVersionRef,
  type TimeEntryAudit,
} from "@/lib/budget/invariants-e10"
import { timeSealOf } from "@/lib/analytics/allocate"
import { familyOf } from "@/lib/audit/families"
import type { AllocationPeriodRef, AllocationRuleSpec } from "@/lib/analytics/allocate"
import type { EmployeeRateRow } from "@/lib/time/cost"

const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)

const FY = { code: "2026", start: "2026-01-01", end: "2026-12-31", months: MONTHS }

const line = (over: Partial<BudgetLineRef> = {}): BudgetLineRef => ({
  versionCode: "2026-BASE",
  month: "2026-03-01",
  dimensionKind: "PROJECT",
  dimensionCode: "P-01",
  businessLineCode: "BL-CONS",
  accountCode: "7050",
  analyticType: "INGRESO_DIRECTO",
  marginLevel: "INGRESOS",
  amountCents: 100000,
  ...over,
})

const version = (over: Partial<BudgetVersionRef> = {}): BudgetVersionRef => ({
  code: "2026-BASE",
  fiscalYearCode: "2026",
  scenario: "BASE",
  revision: 0,
  status: "VIGENTE",
  validFrom: "2026-01-01",
  validTo: null,
  partialFrom: null,
  budgetHash: "h-base",
  recomputedHash: "h-base",
  monthsCovered: MONTHS,
  ...over,
})

const parte = (over: Partial<TimeEntryAudit> = {}): TimeEntryAudit => ({
  id: "t-1",
  employeeId: "emp-1",
  employeeCode: "E-01",
  date: "2026-03-10",
  target: { kind: "PROJECT", id: "p1", code: "P-01" },
  businessLineCode: "BL-CONS",
  minutes: 480,
  productive: true,
  approved: true,
  ...over,
})

const period = (label: string, kind: "MONTH" | "QUARTER" | "YEAR" = "MONTH"): AllocationPeriodRef => ({
  kind,
  label,
  start: kind === "YEAR" ? "2026-01-01" : `${label}-01`,
  end: kind === "YEAR" ? "2026-12-31" : `${label}-31`,
  fiscalYearId: "fy-2026",
  fiscalYearStart: "2026-01-01",
  fiscalYearEnd: "2026-12-31",
})

const rule = (over: Partial<AllocationRuleSpec> = {}): AllocationRuleSpec => ({
  id: "r-1",
  code: "AL-OPS-M",
  name: "Operaciones por horas",
  sourceCostCenterId: "cc-ops",
  targetKind: "PROJECTS",
  driver: "HOURS",
  period: "MONTH",
  priority: 10,
  sourceShareBps: 10000,
  zeroBaseFallback: "SKIP_WARN",
  targetFilter: null,
  validFrom: "2026-01-01",
  validTo: null,
  isActive: true,
  targets: [],
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────

describe("los cinco motivos de sello (ADR-0018 D5)", () => {
  it("código cerrado, con texto y sin `PRESUPUESTO_NO_SELLADO` (EV-14 retirada)", () => {
    expect([...E10_SEAL_REASONS]).toEqual([
      "DESVIACION_PRESUPUESTO",
      "PRESUPUESTO_AUSENTE",
      "HORAS_SIN_APROBAR",
      "PLANTILLA_AUSENTE",
      "TARIFA_AUSENTE",
    ])
    for (const code of E10_SEAL_REASONS) expect(E10_SEAL_REASON_TEXT[code].length).toBeGreaterThan(20)
    expect(isE10SealReason("PRESUPUESTO_NO_SELLADO")).toBe(false)
  })

  it("O-E10-17 · un motivo, una regla: ningún motivo decorativo y ninguna regla huérfana", () => {
    const emitidos = new Set(Object.values(E10_SEAL_REASON_BY_RULE))
    for (const code of E10_SEAL_REASONS) expect(emitidos.has(code)).toBe(true)
    for (const [regla, code] of Object.entries(E10_SEAL_REASON_BY_RULE)) {
      expect(isE10SealReason(code)).toBe(true)
      expect(regla.length).toBeGreaterThan(0)
    }
  })

  it("`budgetSealReasons` compone los motivos desde los DATOS, no desde los checks", () => {
    expect(budgetSealReasons({})).toEqual([])
    expect(budgetSealReasons({ budgetHash: "b", previousBudgetHash: "a" })).toEqual(["DESVIACION_PRESUPUESTO"])
    expect(budgetSealReasons({ hasActiveBudget: false })).toEqual(["PRESUPUESTO_AUSENTE"])
    expect(budgetSealReasons({ firedThresholds: ["desviacionEbitda"] })).toEqual(["DESVIACION_PRESUPUESTO"])
    expect(budgetSealReasons({ allocationSealReasons: ["HORAS_SIN_APROBAR", "PLANTILLA_AUSENTE"] })).toEqual([
      "HORAS_SIN_APROBAR",
      "PLANTILLA_AUSENTE",
    ])
    // EV-17 sólo mueve el sello si el informe PUBLICA coste-hora o margen/hora.
    expect(budgetSealReasons({ unpricedTimeEntries: 3 })).toEqual([])
    expect(budgetSealReasons({ unpricedTimeEntries: 3, publishesHourlyCost: true })).toEqual(["TARIFA_AUSENTE"])
  })

  it("los dieciocho caen en la familia `PRESUPUESTO`", () => {
    for (const check of runBudgetInvariants({})) expect(familyOf(check.id)).toBe("PRESUPUESTO")
  })
})

describe("runBudgetInvariants · el contrato del bloque", () => {
  it("sin bloques salen los DIECIOCHO, todos INFO y ninguno en verde", () => {
    const checks = runBudgetInvariants({})
    expect(checks).toHaveLength(18)
    expect(checks.map((c) => c.id)).toEqual([
      "I-E10-1",
      "I-E10-2",
      "I-E10-3",
      "I-E10-4",
      "I-E10-5",
      "I-E10-6",
      "I-E10-7",
      "I-E10-8",
      "I-E10-9",
      "I-E10-10",
      "I-E10-11",
      "I-E10-12",
      "I-E10-13",
      "I-E10-14",
      "I-E10-15",
      "I-E10-16",
      "I-E10-17",
      "I-E10-18",
    ])
    expect(checks.every((c) => c.status === "INFO")).toBe(true)
    expect(checks.every((c) => c.evidencia.startsWith("no evaluable:"))).toBe(true)
  })
})

describe("I-E10-1 · Σ líneas = totales por nivel", () => {
  const lines = [line({ amountCents: 100000 }), line({ month: "2026-04-01", amountCents: 50000 })]
  const base: BudgetBlock = {
    versions: [version()],
    lines,
    fiscalYear: FY,
    matrix: {
      levelTotalsCents: { INGRESOS: 150000 },
      byMonthCents: { "2026-03": { INGRESOS: 100000 }, "2026-04": { INGRESOS: 50000 } },
      unresolved: [],
    },
  }

  it("cuadra al céntimo y con la suma de los meses", () => {
    expect(checkIE101(base).status).toBe("PASS")
  })

  it("una línea fuera de la matriz es FAIL, no un redondeo", () => {
    expect(checkIE101({ ...base, matrix: { ...base.matrix!, unresolved: ["2026-03 P-99"] } }).status).toBe("FAIL")
  })

  it("un céntimo de diferencia por nivel es FAIL (tolerancia 0)", () => {
    const check = checkIE101({ ...base, matrix: { ...base.matrix!, levelTotalsCents: { INGRESOS: 150001 } } })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("150001")
  })

  it("sin matriz, INFO: no se puede dar por bueno lo que no se ha construido", () => {
    expect(checkIE101({ ...base, matrix: undefined }).status).toBe("INFO")
  })
})

describe("I-E10-2 · desviación exacta", () => {
  it("desviación = real − presupuesto, celda a celda", () => {
    const check = checkIE102({
      versions: [],
      lines: [],
      fiscalYear: FY,
      variance: [{ level: "MC3", column: "PROJ:P-01", month: "2026-03", actualCents: -100, budgetCents: -300, varianceCents: 200 }],
    })
    expect(check.status).toBe("PASS")
  })

  it("un céntimo de más en la desviación es FAIL", () => {
    const check = checkIE102({
      versions: [],
      lines: [],
      fiscalYear: FY,
      variance: [{ level: "MC3", column: "PROJ:P-01", month: "2026-03", actualCents: -100, budgetCents: -300, varianceCents: 201 }],
    })
    expect(check.status).toBe("FAIL")
  })

  it("una celda NO publicada no se compara: no hay presupuesto que restar", () => {
    const check = checkIE102({
      versions: [],
      lines: [],
      fiscalYear: FY,
      variance: [
        { level: "MC3", column: "PROJ:P-01", month: "2026-03", actualCents: -100, budgetCents: 0, varianceCents: 0, published: false },
      ],
    })
    expect(check.status).toBe("PASS")
  })
})

describe("I-E10-3 · la base de `HOURS` es la de la VENTANA EFECTIVA", () => {
  const entries: TimeEntryAudit[] = [
    parte({ id: "t-ene", date: "2026-01-12", minutes: 600 }),
    parte({ id: "t-mar", date: "2026-03-10", minutes: 480 }),
    parte({ id: "t-mar-2", date: "2026-03-11", minutes: 120, approved: false }),
  ]
  const run = (over: Partial<AllocationRunAudit> = {}): AllocationRunAudit => ({
    runId: "RUN-2026-03",
    period: period("2026-03"),
    rules: [rule()],
    lines: [
      {
        ruleCode: "AL-OPS-M",
        driver: "HOURS",
        targetKind: "PROJECTS",
        targetCode: "P-01",
        targetId: "p1",
        driverBase: 480,
        driverBaseTotal: 480,
        fallbackApplied: null,
      },
    ],
    timeHash: "x",
    timeHashWindowStart: "2026-03-01",
    timeHashWindowEnd: "2026-03-31",
    ...over,
  })

  it("con la ventana del periodo, la base son los 480 minutos aprobados de marzo", () => {
    expect(checkIE103({ entries, runs: [run()] }).status).toBe("PASS")
  })

  it("con fallback `YTD` la base es la del EJERCICIO hasta el corte, no la del mes", () => {
    const ytd = run({
      rules: [rule({ zeroBaseFallback: "YTD" })],
      lines: [{ ...run().lines[0], driverBase: 1080, driverBaseTotal: 1080, fallbackApplied: "YTD" }],
    })
    expect(checkIE103({ entries, runs: [ytd] }).status).toBe("PASS")
    // Con la base del periodo, el mismo run daría FAIL: es O-E10-1 hecho test.
    const conBaseDelMes = run({
      rules: [rule({ zeroBaseFallback: "YTD" })],
      lines: [{ ...run().lines[0], driverBase: 480, driverBaseTotal: 480, fallbackApplied: "YTD" }],
    })
    expect(checkIE103({ entries, runs: [conBaseDelMes] }).status).toBe("FAIL")
  })

  it("`driverBaseTotal` distinto de Σ `driverBase` es FAIL", () => {
    const malo = run({ lines: [{ ...run().lines[0], driverBaseTotal: 999 }] })
    expect(checkIE103({ entries, runs: [malo] }).status).toBe("FAIL")
  })

  it("sin runs, INFO", () => {
    expect(checkIE103({ entries }).status).toBe("INFO")
    expect(checkIE103(undefined).status).toBe("INFO")
  })
})

describe("I-E10-4 · las aprobadas son inmutables y se corrigen con contra-apunte", () => {
  const original = parte({ id: "t-1", minutes: 480 })

  it("un contra-apunte con motivo, signo contrario y la misma dimensión: PASS", () => {
    const contra = parte({ id: "t-2", minutes: -250, reversesId: "t-1", reason: "error de imputación" })
    expect(checkIE104({ entries: [original, contra] }).status).toBe("PASS")
  })

  it("motivo de nueve caracteres: FAIL (R-H-4 exige diez)", () => {
    const contra = parte({ id: "t-2", minutes: -250, reversesId: "t-1", reason: "me colé!!" })
    expect(checkIE104({ entries: [original, contra] }).status).toBe("FAIL")
  })

  it("un contra-apunte que excede a su original en magnitud: FAIL", () => {
    const contra = parte({ id: "t-2", minutes: -600, reversesId: "t-1", reason: "corrección completa" })
    expect(checkIE104({ entries: [original, contra] }).status).toBe("FAIL")
  })

  it("una fila aprobada que ha cambiado por SQL se delata por su huella", () => {
    const tocada = parte({ approvedFingerprint: "a", currentFingerprint: "b" })
    const check = checkIE104({ entries: [tocada] })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("fuera de la transición de aprobación")
  })
})

describe("I-E10-5 · coste-hora vigente única por fecha", () => {
  const rate = (over: Partial<EmployeeRateRow> = {}): EmployeeRateRow => ({
    id: "r-1",
    employeeId: "emp-1",
    employeeCode: "E-01",
    hourlyCostCents: 3500,
    basis: "COSTE_EMPRESA_CON_SS",
    validFrom: "2026-01-01",
    validTo: null,
    ...over,
  })

  it("una sola tarifa vigente y todos los partes con tarifa: PASS", () => {
    expect(checkIE105({ entries: [parte()], rates: [rate()] }).status).toBe("PASS")
  })

  it("dos vigencias solapadas: FAIL (la base lo impide con 23P01)", () => {
    const check = checkIE105({ entries: [parte()], rates: [rate(), rate({ id: "r-2", validFrom: "2026-02-01" })] })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("23P01")
  })

  it("un parte sin tarifa ese día: INFO nombrando empleado y fecha, nunca 0", () => {
    const check = checkIE105({ entries: [parte({ date: "2025-12-30" })], rates: [rate()] })
    expect(check.status).toBe("INFO")
    expect(check.evidencia).toContain("E-01 2025-12-30")
    expect(check.evidencia).toContain("NO EVALUABLE")
  })

  it("…y WARN con `TARIFA_AUSENTE` si el informe publica coste-hora (EV-17)", () => {
    const check = checkIE105({ entries: [parte({ date: "2025-12-30" })], rates: [rate()], publishesHourlyCost: true })
    expect(check.status).toBe("WARN")
    expect(check.evidencia).toContain("TARIFA_AUSENTE")
  })
})

describe("I-E10-6 · una versión sellada no cambia", () => {
  it("el hash recomputado coincide con el sellado: PASS", () => {
    expect(checkIE106({ versions: [version()], lines: [], fiscalYear: FY }).status).toBe("PASS")
  })

  it("editar una celda por SQL delata la versión POR SU NOMBRE", () => {
    const check = checkIE106({ versions: [version({ recomputedHash: "otro" })], lines: [], fiscalYear: FY })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("2026-BASE")
  })

  it("sin hash recomputado, INFO: no se puede afirmar lo que no se ha rehecho", () => {
    expect(checkIE106({ versions: [version({ recomputedHash: null })], lines: [], fiscalYear: FY }).status).toBe("INFO")
  })

  it("un BORRADOR no se comprueba: todavía no hay nada sellado", () => {
    const check = checkIE106({
      versions: [version({ status: "BORRADOR", budgetHash: null, recomputedHash: null })],
      lines: [],
      fiscalYear: FY,
    })
    expect(check.status).toBe("INFO")
  })
})

describe("I-E10-7 · forecast sin solape ni hueco", () => {
  const forecast = {
    months: MONTHS.map((month, i) => ({
      month,
      provenance: (i < 4 ? "REAL_CERRADO" : "PRESUPUESTO_ABIERTO") as "REAL_CERRADO" | "PRESUPUESTO_ABIERTO",
      amountCents: 1000,
    })),
    fiscalYearMonths: MONTHS,
    realToCutoffCents: 4000,
    budgetFromCutoffCents: 8000,
  }

  it("corte en abril: real ene-abr, presupuesto may-dic, y las dos sumas cuadran", () => {
    expect(checkIE107({ versions: [], lines: [], fiscalYear: FY, forecast }).status).toBe("PASS")
  })

  it("un mes repetido con dos procedencias: FAIL", () => {
    const solapado = { ...forecast, months: [...forecast.months, { ...forecast.months[0], provenance: "PRESUPUESTO_ABIERTO" as const }] }
    expect(checkIE107({ versions: [], lines: [], fiscalYear: FY, forecast: solapado }).status).toBe("FAIL")
  })

  it("un mes que falta: FAIL nombrándolo", () => {
    const conHueco = { ...forecast, months: forecast.months.filter((m) => m.month !== "2026-07"), budgetFromCutoffCents: 7000 }
    const check = checkIE107({ versions: [], lines: [], fiscalYear: FY, forecast: conHueco })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("2026-07")
  })
})

describe("I-E10-8 · unicidad y exclusividad de celda (O-A6)", () => {
  it("dos líneas para la misma (mes, dimensión, cuenta): FAIL", () => {
    const check = checkIE108({ versions: [], lines: [line(), line()], fiscalYear: FY })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("2 líneas para la misma celda")
  })

  it("la misma celda con cuenta NULL también es única", () => {
    const sinCuenta = line({ accountCode: null })
    expect(checkIE108({ versions: [], lines: [sinCuenta, sinCuenta], fiscalYear: FY }).status).toBe("FAIL")
    expect(checkIE108({ versions: [], lines: [sinCuenta, line()], fiscalYear: FY }).status).toBe("PASS")
  })

  it("la LN denormalizada que no es la del proyecto: FAIL", () => {
    const check = checkIE108({
      versions: [],
      lines: [line({ businessLineCode: "BL-DEV", projectBusinessLineCode: "BL-CONS" })],
      fiscalYear: FY,
    })
    expect(check.status).toBe("FAIL")
  })
})

describe("I-E10-9 y I-E10-15 · vigencias sin solape, sin hueco y correlativas", () => {
  const base = version({ validTo: "2026-06-30" })
  const rev1 = version({
    code: "2026-REV1",
    revision: 1,
    validFrom: "2026-07-01",
    validTo: null,
    partialFrom: "2026-07-01",
    budgetHash: "h-rev1",
    recomputedHash: "h-rev1",
    monthsCovered: MONTHS.slice(6),
  })

  it("BASE hasta junio y REV1 desde julio: las dos coexisten sin solape", () => {
    expect(checkIE109({ versions: [base, rev1], lines: [], fiscalYear: FY }).status).toBe("PASS")
    expect(checkIE1015({ versions: [base, rev1], lines: [], fiscalYear: FY }).status).toBe("PASS")
  })

  it("una vigencia solapada: FAIL (el EXCLUDE de la base responde 23P01)", () => {
    const solapada = { ...rev1, validFrom: "2026-06-15" }
    expect(checkIE109({ versions: [base, solapada], lines: [], fiscalYear: FY }).status).toBe("FAIL")
  })

  it("una revisión 1 sin BASE anterior: FAIL", () => {
    expect(checkIE109({ versions: [rev1], lines: [], fiscalYear: FY }).status).toBe("FAIL")
  })

  it("O-E10-8 · un hueco en julio: FAIL nombrando el mes, no `PRESUPUESTO_AUSENTE`", () => {
    const conHueco = { ...rev1, validFrom: "2026-08-01" }
    const check = checkIE1015({ versions: [base, conHueco], lines: [], fiscalYear: FY })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("2026-07")
  })
})

describe("I-E10-10 · partes bien formados, con el techo diario AGREGADO", () => {
  it("un parte normal: PASS", () => {
    expect(checkIE1010({ entries: [parte()], fiscalYearWindow: { from: "2026-01-01", to: "2026-12-31" } }).status).toBe("PASS")
  })

  it("O-E10-21 · cuatro partes de 1 440 el mismo día —cada uno legal— son FAIL", () => {
    const entries = [0, 1, 2, 3].map((i) => parte({ id: `t-${i}`, minutes: 1440 }))
    const check = checkIE1010({ entries })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("supera el techo diario")
  })

  it("minutos negativos sin contra-apunte, minutos a 0 y fecha fuera del ejercicio: FAIL", () => {
    expect(checkIE1010({ entries: [parte({ minutes: -60 })] }).status).toBe("FAIL")
    expect(checkIE1010({ entries: [parte({ minutes: 0 })] }).status).toBe("FAIL")
    expect(
      checkIE1010({ entries: [parte({ date: "2025-12-31" })], fiscalYearWindow: { from: "2026-01-01", to: "2026-12-31" } }).status
    ).toBe("FAIL")
  })

  it("un parte en un mes BLOQUEADO: FAIL", () => {
    expect(checkIE1010({ entries: [parte()], lockedMonths: ["2026-03"] }).status).toBe("FAIL")
  })
})

describe("I-E10-11 · la base de `HEADCOUNT` es FTE·mes", () => {
  const headcount = MONTHS.map((month) => ({
    costCenterId: "cc-ops",
    costCenterCode: "CC-OPS",
    periodEnd: `${month}-${month === "2026-02" ? "28" : "30"}`,
    fteMilli: 4000,
  }))
  const run = (driverBase: number, hc = headcount): AllocationRunAudit => ({
    runId: "RUN-2026",
    period: period("2026", "YEAR"),
    rules: [rule({ driver: "HEADCOUNT", period: "YEAR", targetKind: "COST_CENTERS" })],
    lines: [
      {
        ruleCode: "AL-GA-CC-Y",
        driver: "HEADCOUNT",
        targetKind: "COST_CENTERS",
        targetCode: "CC-OPS",
        targetId: "cc-ops",
        driverBase,
        driverBaseTotal: driverBase,
        fallbackApplied: null,
      },
    ],
    timeHash: "x",
    timeHashWindowStart: null,
    timeHashWindowEnd: null,
    ...(hc === headcount ? {} : {}),
  })

  it("Q-7 · doce snapshots de 4 000 dan 48 000 FTE·mes en el run anual, no 4 000", () => {
    expect(checkIE1011({ entries: [], headcount, runs: [run(48000)] }).status).toBe("PASS")
    expect(checkIE1011({ entries: [], headcount, runs: [run(4000)] }).status).toBe("FAIL")
  })

  it("dos snapshots para el mismo (CECO, mes): FAIL", () => {
    const duplicado = [...headcount, headcount[0]]
    expect(checkIE1011({ entries: [], headcount: duplicado, runs: [] }).status).toBe("FAIL")
  })

  it("un receptor SIN snapshot es WARN con `PLANTILLA_AUSENTE`; con 0 declarado, PASS", () => {
    const sinNada = checkIE1011({ entries: [], headcount: [], runs: [run(0, [])] })
    expect(sinNada.status).toBe("WARN")
    expect(sinNada.evidencia).toContain("PLANTILLA_AUSENTE")
    const cero = headcount.map((h) => ({ ...h, fteMilli: 0 }))
    const declarado = checkIE1011({ entries: [], headcount: cero, runs: [run(0, cero)] })
    expect(declarado.status).toBe("PASS")
  })
})

describe("I-E10-12 · el personal imputado no excede al contabilizado", () => {
  it("infraabsorción: PASS, es información de gestión y no un descuadre", () => {
    const check = checkIE1012({ entries: [], payroll: [{ periodLabel: "2026", valuedCents: 5275500, payrollCents: 5276000 }] })
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("GUARDA")
  })

  it("exceso: FAIL nombrando el periodo", () => {
    const check = checkIE1012({ entries: [], payroll: [{ periodLabel: "2026-03", valuedCents: 100, payrollCents: 90 }] })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("2026-03")
  })
})

describe("I-E10-13 · reproducibilidad y aislamiento", () => {
  const inputs = { ledgerHash: "l", budgetHash: "b", timeHash: "t", paramsHash: "p", gitSha: "abc1234" }

  it("dos ejecuciones idénticas y las siete tablas a 0 filas / 42501: PASS", () => {
    const check = checkIE1013({
      versions: [],
      lines: [],
      fiscalYear: FY,
      reproducibility: {
        canonicalResultJson: ["{}", "{}"],
        inputs,
        tenantIsolation: [{ table: "budgets", rowsWithoutGuc: 0, insertSqlState: "42501" }],
      },
    })
    expect(check.status).toBe("PASS")
  })

  it("una sola ejecución no prueba nada: INFO", () => {
    expect(
      checkIE1013({ versions: [], lines: [], fiscalYear: FY, reproducibility: { canonicalResultJson: ["{}"], inputs } }).status
    ).toBe("INFO")
  })

  it("una tabla que devuelve filas sin GUC: FAIL", () => {
    const check = checkIE1013({
      versions: [],
      lines: [],
      fiscalYear: FY,
      reproducibility: {
        canonicalResultJson: ["{}", "{}"],
        inputs,
        tenantIsolation: [{ table: "time_entries", rowsWithoutGuc: 3, insertSqlState: "42501" }],
      },
    })
    expect(check.status).toBe("FAIL")
  })
})

describe("I-E10-14 · tipo declarado y coherencia de signo", () => {
  it("O-E10-23 · una línea SIN `analyticType` es FAIL, y además se cuenta", () => {
    const check = checkIE1014({ versions: [], lines: [line({ analyticType: null })], fiscalYear: FY })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("SIN analyticType")
  })

  it("un gasto en positivo es FAIL; un ingreso en positivo, PASS", () => {
    expect(
      checkIE1014({
        versions: [],
        lines: [line({ accountCode: "6400", analyticType: "INDIRECTO_CECO", amountCents: 1200000 })],
        fiscalYear: FY,
      }).status
    ).toBe("FAIL")
    expect(checkIE1014({ versions: [], lines: [line()], fiscalYear: FY }).status).toBe("PASS")
  })

  it("las excepciones declaradas (`7080`) salen LISTADAS, no calladas", () => {
    const check = checkIE1014({
      versions: [],
      lines: [line({ accountCode: "7080", analyticType: "INGRESO_DIRECTO", amountCents: -50000 })],
      fiscalYear: FY,
    })
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("7080")
  })
})

describe("I-E10-16 · completitud de la versión (O-E10-9)", () => {
  it("una revisión que sólo trae jul-dic y DECLARA `partialFrom`: PASS", () => {
    const rev1 = version({ code: "2026-REV1", revision: 1, partialFrom: "2026-07-01", monthsCovered: MONTHS.slice(6) })
    expect(checkIE1016({ versions: [rev1], lines: [], fiscalYear: FY }).status).toBe("PASS")
  })

  it("…y la misma SIN declararlo desinfla el año a la mitad: FAIL", () => {
    const rev1 = version({ code: "2026-REV1", revision: 1, partialFrom: null, monthsCovered: MONTHS.slice(6) })
    const check = checkIE1016({ versions: [rev1], lines: [], fiscalYear: FY })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("partialFrom")
  })
})

describe("I-E10-17 · el `timeHash` cubre la ventana consumida (O-E10-1)", () => {
  const entries = [parte({ id: "t-ene", date: "2026-01-12", minutes: 600 }), parte({ id: "t-mar", date: "2026-03-10" })]

  it("una regla `YTD` sella desde el 1 de enero y el hash recomputado coincide", () => {
    // El sello se calcula con el MISMO motor que lo produce en producción.
    const reglas = [rule({ zeroBaseFallback: "YTD" })]
    const seal = timeSealOf(reglas, period("2026-03"), entries)
    const run: AllocationRunAudit = {
      runId: "RUN-2026-03",
      period: period("2026-03"),
      rules: reglas,
      lines: [],
      timeHash: seal.timeHash,
      timeHashWindowStart: seal.timeHashWindowStart,
      timeHashWindowEnd: seal.timeHashWindowEnd,
    }
    expect(run.timeHashWindowStart).toBe("2026-01-01")
    expect(checkIE1017({ entries, runs: [run] }).status).toBe("PASS")

    // Sellar SÓLO el periodo es lo que la ronda 0 hacía: la ventana no contiene
    // la consumida y el invariante lo dice.
    const corto = { ...run, timeHashWindowStart: "2026-03-01" }
    const check = checkIE1017({ entries, runs: [corto] })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("no contiene la consumida")

    // Y aprobar después un parte de enero caduca el run: cuarta causa de STALE.
    const conParteNuevo = [...entries, parte({ id: "t-ene-2", date: "2026-01-20", minutes: 800 })]
    const caducado = checkIE1017({ entries: conParteNuevo, runs: [run] })
    expect(caducado.status).toBe("FAIL")
    expect(caducado.evidencia).toContain("CADUCADO")
  })

  it("un run sin drivers de actividad sella `∅` y ventana NULL", () => {
    const run: AllocationRunAudit = {
      runId: "RUN-2026-Q2",
      period: period("2026-Q2", "QUARTER"),
      rules: [rule({ driver: "REVENUE_SHARE" })],
      lines: [],
      timeHash: "∅",
      timeHashWindowStart: null,
      timeHashWindowEnd: null,
    }
    expect(checkIE1017({ entries, runs: [run] }).status).toBe("PASS")
    expect(checkIE1017({ entries, runs: [{ ...run, timeHash: "otro" }] }).status).toBe("FAIL")
  })
})

describe("I-E10-18 · comparabilidad presupuesto ↔ real (O-E10-4)", () => {
  const block = (over: Partial<NonNullable<BudgetBlock["comparability"]>>): BudgetBlock => ({
    versions: [],
    lines: [],
    fiscalYear: FY,
    comparability: {
      publishesByDimension: true,
      withAllocations: true,
      rulesHash: "h",
      budgetRulesHash: "h",
      notPublishedCells: 0,
      publishedByDimensionCells: 12,
      ...over,
    },
  })

  it("las mismas reglas en las dos matrices: PASS, y la desviación de MC3 es comparable", () => {
    expect(checkIE1018(block({})).status).toBe("PASS")
  })

  it("27-bis · sin poder liquidar el presupuesto, las celdas salen NO PUBLICADAS", () => {
    const check = checkIE1018(block({ budgetRulesHash: null, notPublishedCells: 12, publishedByDimensionCells: 0 }))
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("NO PUBLICADAS")
  })

  it("…y publicarlas igualmente sería comparar dos medidas distintas: FAIL", () => {
    expect(checkIE1018(block({ budgetRulesHash: "otro" })).status).toBe("FAIL")
  })

  it("si el informe no publica por dimensión, no hay nada que comparar: INFO", () => {
    expect(checkIE1018(block({ publishesByDimension: false })).status).toBe("INFO")
  })
})
