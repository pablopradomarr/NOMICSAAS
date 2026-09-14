/**
 * E10 · T8 — `lib/time/payroll-reclass.ts` (§3.7, camino (b), ADR-0010).
 *
 * Criterio 15 de §12: una línea `640` de 300 000 c en `CC-OPS` con el 100 % de
 * las horas del empleado en P-01 se propone; una repartida 60/40 entre dos
 * proyectos se declara **no atribuible** y remite al camino (a). No se parte
 * ninguna línea, y esta función **nunca cambia nada**: sólo propone.
 */

import { describe, expect, it } from "vitest"

import type { TimeEntryRow } from "@/lib/time/aggregate"
import {
  REQUIRED_CONCENTRATION_BPS,
  proposePayrollReclass,
  proposedMc2ShiftCents,
  type PayrollLineRef,
} from "@/lib/time/payroll-reclass"

const WINDOW = { from: "2026-03-01", to: "2026-03-31" }

let seq = 0
const hours = (over: Partial<TimeEntryRow> & { minutes: number }): TimeEntryRow => {
  seq += 1
  return {
    id: `t-${seq}`,
    employeeId: "e-1",
    employeeCode: "E-01",
    date: "2026-03-10",
    target: { kind: "PROJECT", id: "p-1", code: "P-01" },
    businessLineCode: "BL-CONS",
    productive: true,
    approved: true,
    ...over,
  }
}

const payroll = (over: Partial<PayrollLineRef> = {}): PayrollLineRef => ({
  lineId: "l-1",
  entryId: "asiento-1",
  entryNumber: 42,
  lineNo: 1,
  entryDate: "2026-03-31",
  accountCode: "640",
  amountCents: -300_000,
  costCenterId: "cc-ops",
  costCenterCode: "CC-OPS",
  projectId: null,
  employeeId: "e-1",
  employeeCode: "E-01",
  ...over,
})

describe("criterio 15 · la línea íntegra de un proyecto", () => {
  it("con el 100 % de las horas en P-01 se propone, con R-A3 y el importe entero", () => {
    const { proposals, notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480 }), hours({ minutes: 420, date: "2026-03-11" })],
      window: WINDOW,
    })
    expect(notAttributable).toEqual([])
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      lineId: "l-1",
      fromCostCenterCode: "CC-OPS",
      toProjectCode: "P-01",
      toProjectId: "p-1",
      minutes: 900,
      totalMinutes: 900,
      concentrationBps: 10_000,
      resultingAnalyticType: "COSTE_DIRECTO_MC2",
      amountCents: -300_000,
    })
    expect(proposedMc2ShiftCents(proposals)).toBe(300_000)
  })

  it("O-E10-22 · la concentración exigida es 100 %, fija y sin parámetro", () => {
    expect(REQUIRED_CONCENTRATION_BPS).toBe(10_000)
  })

  it("un contra-apunte baja el neto pero no rompe la atribución íntegra", () => {
    const { proposals } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480 }), hours({ minutes: -120, date: "2026-03-12" })],
      window: WINDOW,
    })
    expect(proposals[0].minutes).toBe(360)
    expect(proposals[0].totalMinutes).toBe(360)
  })

  it("las horas de OTROS empleados no contaminan la atribución de esta línea", () => {
    const { proposals } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [
        hours({ minutes: 480 }),
        hours({ minutes: 600, employeeId: "e-2", employeeCode: "E-02", target: { kind: "PROJECT", id: "p-2", code: "P-02" } }),
      ],
      window: WINDOW,
    })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].toProjectCode).toBe("P-01")
  })
})

describe("criterio 15 · lo que NO se propone, y por qué", () => {
  it("una línea repartida 60/40 es NO atribuible y remite al camino (a)", () => {
    const { proposals, notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [
        hours({ minutes: 600 }),
        hours({ minutes: 400, date: "2026-03-11", target: { kind: "PROJECT", id: "p-2", code: "P-02" } }),
      ],
      window: WINDOW,
    })
    expect(proposals).toEqual([])
    expect(notAttributable).toHaveLength(1)
    expect(notAttributable[0].reason).toBe("SPLIT_ACROSS_PROJECTS")
    expect(notAttributable[0].distribution).toEqual([
      { projectCode: "P-01", minutes: 600, shareBps: 6_000 },
      { projectCode: "P-02", minutes: 400, shareBps: 4_000 },
    ])
    expect(notAttributable[0].detail).toContain("driver HOURS")
  })

  it("el 99,9 % tampoco basta: con 8 000 bps el MC2 del proyecto se llevaría lo ajeno", () => {
    const { proposals, notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [
        hours({ minutes: 999 }),
        hours({ minutes: 1, date: "2026-03-11", target: { kind: "PROJECT", id: "p-2", code: "P-02" } }),
      ],
      window: WINDOW,
    })
    expect(proposals).toEqual([])
    expect(notAttributable[0].reason).toBe("SPLIT_ACROSS_PROJECTS")
  })

  it("sin empleado en la línea no hay horas con las que atribuirla", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll({ employeeId: null, employeeCode: null })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_EMPLOYEE")
    expect(notAttributable[0].detail).toContain("camino (a)")
  })

  it("sin horas aprobadas en la ventana, no evaluable: nunca se atribuye a ciegas", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480, approved: false })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_HOURS")
  })

  it("las horas NO productivas no atribuyen coste de proyecto (Q-3)", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480, productive: false })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_HOURS")
  })

  it("las horas de FUERA de la ventana no cuentan", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480, date: "2026-02-10" })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_HOURS")
  })

  it("las horas contra un CECO no atribuyen: el receptor tiene que ser un proyecto", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll()],
      hours: [hours({ minutes: 480, target: { kind: "COST_CENTER", id: "cc-ops", code: "CC-OPS" } })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_HOURS")
  })

  it("`641` queda fuera de la nómina reclasificable (O-E10-11)", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll({ accountCode: "641" })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NOT_PAYROLL")
  })

  it("una cuenta que no es de nómina no se propone nunca", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll({ accountCode: "621" })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NOT_PAYROLL")
  })

  it("una línea ya imputada a proyecto no tiene nada que reclasificar", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll({ projectId: "p-1" })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("ALREADY_ON_PROJECT")
  })

  it("una línea sin CECO no es del camino (b)", () => {
    const { notAttributable } = proposePayrollReclass({
      payrollLines: [payroll({ costCenterId: null, costCenterCode: null })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(notAttributable[0].reason).toBe("NO_COST_CENTER")
  })
})

describe("casos límite obligatorios", () => {
  it("caso vacío: ni propuestas ni rechazos", () => {
    expect(proposePayrollReclass({ payrollLines: [], hours: [], window: WINDOW })).toEqual({
      proposals: [],
      notAttributable: [],
    })
  })

  it("determinista: el orden de salida es (asiento, línea), no el de entrada", () => {
    const lines = [
      payroll({ lineId: "l-2", entryId: "asiento-2", lineNo: 1 }),
      payroll({ lineId: "l-1", entryId: "asiento-1", lineNo: 3 }),
      payroll({ lineId: "l-0", entryId: "asiento-1", lineNo: 2 }),
    ]
    const { proposals } = proposePayrollReclass({ payrollLines: lines, hours: [hours({ minutes: 480 })], window: WINDOW })
    expect(proposals.map((p) => p.lineId)).toEqual(["l-0", "l-1", "l-2"])
  })

  it("un importe POSITIVO en una 640 (regularización) también se propone tal cual", () => {
    const { proposals } = proposePayrollReclass({
      payrollLines: [payroll({ amountCents: 12_345 })],
      hours: [hours({ minutes: 480 })],
      window: WINDOW,
    })
    expect(proposals[0].amountCents).toBe(12_345)
    expect(proposedMc2ShiftCents(proposals)).toBe(-12_345)
  })
})
