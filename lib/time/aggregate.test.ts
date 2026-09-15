/**
 * E10 · T5 — tests de `lib/time/aggregate.ts`.
 *
 * Cubren lo que el diseño §3.5 y ADR-0018 D1 exigen: ventana efectiva
 * (O-E10-1), aviso con base **parcial** (O-E10-2), forma canónica **sin `id`**
 * y determinismo byte a byte (O-E10-3), FTE·mes (Q-7 / O-E10-16), techo diario
 * agregado (O-E10-21) y los casos límite obligatorios: 0 horas, sólo no
 * aprobadas, contra-apuntes y techo superado → rechazo.
 */

import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { priorPeriodWindow } from "@/lib/analytics/allocate"
import {
  DAILY_MINUTES_CEILING,
  EMPTY_TIME_HASH,
  HeadcountRow,
  TimeAggregateError,
  TimeEntryRow,
  TimePeriodRef,
  TimeRuleSpec,
  assertHeadcountTargetKind,
  canonicalTimeForm,
  dailyMinutesExcesses,
  fteMonthsByCostCenter,
  minutesByEmployee,
  minutesByTarget,
  priorPeriodStart,
  timeHash,
  timeWindowOf,
  unapprovedMinutesByTarget,
  unapprovedSummary,
} from "@/lib/time/aggregate"

const MARCH = { from: "2026-03-01", to: "2026-03-31" }
const APPROVED = { productiveOnly: true, approvedOnly: true } as const

const project = (code: string) => ({ kind: "PROJECT" as const, id: `p-${code}`, code })
const ceco = (code: string) => ({ kind: "COST_CENTER" as const, id: `c-${code}`, code })

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

/**
 * Un total mensual se reparte en partes de como mucho 1 440 minutos: el techo es
 * por fila, así que 19 200 minutos de un proyecto son catorce partes, no uno.
 */
function many(total: number, over: Partial<TimeEntryRow> = {}): TimeEntryRow[] {
  const rows: TimeEntryRow[] = []
  let left = total
  let day = 1
  while (left > 0) {
    const minutes = Math.min(left, DAILY_MINUTES_CEILING)
    rows.push(entry({ ...over, minutes, date: `2026-03-${String((day % 28) + 1).padStart(2, "0")}` }))
    left -= minutes
    day += 1
  }
  return rows
}

const period = (over: Partial<TimePeriodRef> = {}): TimePeriodRef => ({
  kind: "MONTH",
  label: "2026-03",
  start: "2026-03-01",
  end: "2026-03-31",
  fiscalYearStart: "2026-01-01",
  ...over,
})

const rule = (driver: TimeRuleSpec["driver"], zeroBaseFallback: TimeRuleSpec["zeroBaseFallback"]): TimeRuleSpec => ({
  driver,
  zeroBaseFallback,
})

describe("minutesByTarget / minutesByEmployee", () => {
  it("con 0 partes devuelve vacío, no un cero inventado", () => {
    expect(minutesByTarget([], MARCH, APPROVED)).toEqual([])
    expect(minutesByEmployee([], MARCH, APPROVED)).toEqual([])
  })

  it("suma sólo los aprobados y productivos, y ordena por código de receptor", () => {
    const rows = [
      ...many(19200, { target: project("P-01") }),
      ...many(10800, { target: project("P-02") }),
      ...many(6000, { target: project("P-03") }),
      entry({ minutes: 480, target: project("P-01"), approved: false }),
      entry({ minutes: 480, target: project("P-02"), productive: false }),
    ]
    expect(minutesByTarget(rows, MARCH, APPROVED).map((t) => [t.code, t.minutes])).toEqual([
      ["P-01", 19200],
      ["P-02", 10800],
      ["P-03", 6000],
    ])
  })

  it("las no productivas cuentan con `productiveOnly: false` (denominador distinto, Q-3)", () => {
    const rows = [entry({ minutes: 400 }), entry({ minutes: 100, productive: false })]
    expect(minutesByTarget(rows, MARCH, { productiveOnly: false, approvedOnly: true })[0].minutes).toBe(500)
    expect(minutesByTarget(rows, MARCH, APPROVED)[0].minutes).toBe(400)
  })

  it("el contra-apunte resta con su signo y el neto es exacto", () => {
    const rows = [entry({ minutes: 480 }), entry({ minutes: -250 })]
    expect(minutesByTarget(rows, MARCH, APPROVED)[0].minutes).toBe(230)
    expect(minutesByEmployee(rows, MARCH, APPROVED)[0].minutes).toBe(230)
  })

  it("la ventana es cerrada por los dos extremos", () => {
    const rows = [
      entry({ minutes: 60, date: "2026-02-28" }),
      entry({ minutes: 60, date: "2026-03-01" }),
      entry({ minutes: 60, date: "2026-03-31" }),
      entry({ minutes: 60, date: "2026-04-01" }),
    ]
    expect(minutesByTarget(rows, MARCH, APPROVED)[0].minutes).toBe(120)
  })

  it("agrupa por empleado con su código y ordena por él", () => {
    const rows = [
      entry({ minutes: 300, employeeId: "e-2", employeeCode: "EMP-002" }),
      entry({ minutes: 120, employeeId: "e-1", employeeCode: "EMP-001" }),
      entry({ minutes: 60, employeeId: "e-1", employeeCode: "EMP-001" }),
    ]
    expect(minutesByEmployee(rows, MARCH, APPROVED)).toEqual([
      { employeeCode: "EMP-001", employeeId: "e-1", minutes: 180 },
      { employeeCode: "EMP-002", employeeId: "e-2", minutes: 300 },
    ])
  })
})

describe("unapprovedMinutesByTarget (O-E10-2)", () => {
  it("el caso parcial del bloqueante: 12 000 min sin firmar sobre una base de 36 000", () => {
    const rows = [
      ...many(19200, { target: project("P-01") }),
      ...many(10800, { target: project("P-02") }),
      ...many(6000, { target: project("P-03") }),
      ...many(12000, { target: project("P-03"), approved: false }),
    ]
    expect(unapprovedMinutesByTarget(rows, MARCH, { productiveOnly: true })).toEqual([
      { code: "P-03", id: "p-P-03", kind: "PROJECT", unapprovedMinutes: 12000, shareOfBaseBps: 3333 },
    ])
    const summary = unapprovedSummary(rows, MARCH, { productiveOnly: true })
    expect(summary).toMatchObject({ unapprovedMinutes: 12000, approvedBaseMinutes: 36000, shareOfBaseBps: 3333 })
    expect(summary.targets).toEqual(["P-03"])
  })

  it("sin ninguna hora aprobada la base es 0 y el % no evaluable, pero el aviso existe igual", () => {
    const rows = many(40000, { approved: false })
    expect(unapprovedMinutesByTarget(rows, MARCH, { productiveOnly: true })).toEqual([
      { code: "P-01", id: "p-P-01", kind: "PROJECT", unapprovedMinutes: 40000, shareOfBaseBps: null },
    ])
    expect(minutesByTarget(rows, MARCH, APPROVED)).toEqual([])
  })

  it("sin minutos pendientes no devuelve nada (el aviso no se emite)", () => {
    const rows = [entry({ minutes: 480 })]
    expect(unapprovedMinutesByTarget(rows, MARCH, { productiveOnly: true })).toEqual([])
  })

  it("un pendiente fuera de la ventana no cuenta", () => {
    const rows = [entry({ minutes: 480 }), entry({ minutes: 999, date: "2026-04-02", approved: false })]
    expect(unapprovedMinutesByTarget(rows, MARCH, { productiveOnly: true })).toEqual([])
  })
})

describe("timeWindowOf (O-E10-1)", () => {
  it("sin reglas de actividad no hay ventana y el sello es ∅", () => {
    const rules = [rule("REVENUE_SHARE", "YTD"), rule("FIXED_PERCENT", "SKIP_WARN")]
    expect(timeWindowOf(rules, period())).toBeNull()
    expect(timeHash([entry({ minutes: 60 })], null)).toBe(EMPTY_TIME_HASH)
  })

  it("sin fallback ancho, la ventana es el periodo", () => {
    expect(timeWindowOf([rule("HOURS", "SKIP_WARN")], period())).toEqual({ from: "2026-03-01", to: "2026-03-31" })
  })

  it("con YTD se ensancha hasta el inicio del ejercicio: es el fallo que D1 cierra", () => {
    expect(timeWindowOf([rule("HOURS", "YTD")], period())).toEqual({ from: "2026-01-01", to: "2026-03-31" })
  })

  it("con PRIOR_PERIOD llega al primer día del periodo anterior", () => {
    expect(timeWindowOf([rule("HOURS", "PRIOR_PERIOD")], period())).toEqual({ from: "2026-02-01", to: "2026-03-31" })
  })

  it("con las dos a la vez, la unión: la más ancha", () => {
    const rules = [rule("HOURS", "PRIOR_PERIOD"), rule("HEADCOUNT", "YTD")]
    expect(timeWindowOf(rules, period())).toEqual({ from: "2026-01-01", to: "2026-03-31" })
  })

  it("en enero, PRIOR_PERIOD sale del ejercicio y es MÁS ancho que YTD", () => {
    const p = period({ label: "2026-01", start: "2026-01-01", end: "2026-01-31" })
    expect(timeWindowOf([rule("HOURS", "PRIOR_PERIOD")], p)).toEqual({ from: "2025-12-01", to: "2026-01-31" })
    expect(timeWindowOf([rule("HOURS", "YTD")], p)).toEqual({ from: "2026-01-01", to: "2026-01-31" })
  })

  it("`priorPeriodStart` coincide con `priorPeriodWindow` de la liquidación", () => {
    const labels: [Parameters<typeof priorPeriodStart>[0], string][] = [
      ["MONTH", "2026-03"],
      ["MONTH", "2026-01"],
      ["QUARTER", "2026-Q2"],
      ["QUARTER", "2026-Q1"],
      ["YEAR", "2026"],
    ]
    for (const [kind, label] of labels) {
      expect(priorPeriodStart(kind, label)).toBe(priorPeriodWindow(kind, label).from)
    }
  })
})

describe("canonicalTimeForm / timeHash (O-E10-3)", () => {
  const rows = [
    entry({ minutes: 480, date: "2026-03-02", employeeCode: "EMP-002", employeeId: "e-2", target: project("P-02") }),
    entry({ minutes: 120, date: "2026-03-01", target: ceco("CC-OPS"), productive: false }),
    entry({ minutes: 240, date: "2026-03-01" }),
    entry({ minutes: 999, date: "2026-03-05", approved: false }),
    entry({ minutes: 999, date: "2026-04-05" }),
  ]

  it("la forma es `fecha|empleado|receptor|minutos|productiva`, sólo aprobadas de la ventana", () => {
    expect(canonicalTimeForm(rows, MARCH)).toBe(
      ["2026-03-01|EMP-001|CC-OPS|120|0", "2026-03-01|EMP-001|P-01|240|1", "2026-03-02|EMP-002|P-02|480|1"].join("\n")
    )
  })

  it("el orden de entrada no cambia ni un byte", () => {
    const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]]
    expect(canonicalTimeForm(shuffled, MARCH)).toBe(canonicalTimeForm(rows, MARCH))
    expect(timeHash(shuffled, MARCH)).toBe(timeHash(rows, MARCH))
  })

  it("el `id` NO entra: recargar el fixture con otros uuid da el mismo sello", () => {
    const recargado = rows.map((r, i) => ({ ...r, id: `otro-uuid-${i}` }))
    expect(timeHash(recargado, MARCH)).toBe(timeHash(rows, MARCH))
  })

  it("cambiar minutos, productividad o receptor SÍ mueve el sello", () => {
    const base = timeHash(rows, MARCH)
    expect(timeHash([...rows.slice(1), { ...rows[0], minutes: 481 }], MARCH)).not.toBe(base)
    expect(timeHash([...rows.slice(1), { ...rows[0], productive: false }], MARCH)).not.toBe(base)
    expect(timeHash([...rows.slice(1), { ...rows[0], target: project("P-09") }], MARCH)).not.toBe(base)
  })

  it("aprobar en mayo un parte de ENERO mueve el sello de marzo si la ventana es YTD", () => {
    const enero = entry({ minutes: 800, date: "2026-01-14", approved: false })
    const ytd = timeWindowOf([rule("HOURS", "YTD")], period())
    const antes = timeHash([...rows, enero], ytd)
    const despues = timeHash([...rows, { ...enero, approved: true }], ytd)
    expect(despues).not.toBe(antes)
    // …y con la ventana acotada al periodo NO se movía: el fallo de la ronda 0.
    expect(timeHash([...rows, { ...enero, approved: true }], MARCH)).toBe(timeHash([...rows, enero], MARCH))
  })

  it("sin partes aprobados el sello es el de la cadena vacía, no `∅`", () => {
    expect(timeHash([], MARCH)).toBe(createHash("sha256").update("", "utf8").digest("hex"))
  })
})

describe("techo diario (O-E10-21)", () => {
  // **criterio 29** (Q-2): minutos ENTEROS, nunca centésimas de hora. 7 h 20 min
  // son `440` exactos; en centésimas serían 733,33 y habría que redondear.
  it("criterio 29 · un parte por encima de ±1 440 se RECHAZA en todos los agregados", () => {
    const malo = [entry({ minutes: DAILY_MINUTES_CEILING + 60 })]
    expect(() => minutesByTarget(malo, MARCH, APPROVED)).toThrow(TimeAggregateError)
    expect(() => minutesByTarget(malo, MARCH, APPROVED)).toThrow(/techo diario/)
    expect(() => canonicalTimeForm(malo, MARCH)).toThrow(TimeAggregateError)
    expect(() => minutesByTarget([entry({ minutes: -1441 })], MARCH, APPROVED)).toThrow(/techo diario/)
  })

  it("minutos no enteros se rechazan (Q-2: la unidad es el minuto)", () => {
    expect(() => minutesByTarget([entry({ minutes: 7.33 })], MARCH, APPROVED)).toThrow(/enteros/)
  })

  it("cuatro partes de 1 440 del mismo día son legales por fila y el AGREGADO los caza", () => {
    const rows = [
      entry({ minutes: 1440, date: "2026-03-10", target: project("P-01") }),
      entry({ minutes: 1440, date: "2026-03-10", target: project("P-02") }),
      entry({ minutes: 1440, date: "2026-03-10", target: project("P-03"), approved: false }),
      entry({ minutes: 1440, date: "2026-03-10", target: ceco("CC-OPS") }),
      entry({ minutes: 1440, date: "2026-03-11" }),
    ]
    expect(dailyMinutesExcesses(rows)).toEqual([
      { employeeCode: "EMP-001", employeeId: "e-1", date: "2026-03-10", minutes: 5760 },
    ])
  })

  it("el contra-apunte devuelve el día al rango y deja de ser exceso", () => {
    const rows = [
      entry({ minutes: 1440, date: "2026-03-10" }),
      entry({ minutes: 480, date: "2026-03-10" }),
      entry({ minutes: -480, date: "2026-03-10" }),
    ]
    expect(dailyMinutesExcesses(rows)).toEqual([])
  })
})

describe("fteMonthsByCostCenter (Q-7 / O-E10-16)", () => {
  const snap = (code: string, periodEnd: string, fteMilli: number): HeadcountRow => ({
    costCenterId: `c-${code}`,
    costCenterCode: code,
    periodEnd,
    fteMilli,
  })

  it("en un run MENSUAL hay un solo snapshot: FTE·mes = stock a fin de periodo", () => {
    const rows = [snap("CC-A", "2026-03-31", 3000), snap("CC-B", "2026-03-31", 2000), snap("CC-C", "2026-03-31", 1000)]
    expect(fteMonthsByCostCenter(rows, MARCH).map((w) => [w.code, w.fteMilli])).toEqual([
      ["CC-A", 3000],
      ["CC-B", 2000],
      ["CC-C", 1000],
    ])
  })

  it("en un run ANUAL, un CECO vivo de febrero a noviembre pesa 10 × 3 000 y no 0", () => {
    const meses = [
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
    ]
    const rows = meses.map((m) => snap("CC-SOP", m, 3000))
    const anual = { from: "2026-01-01", to: "2026-12-31" }
    expect(fteMonthsByCostCenter(rows, anual)).toEqual([
      { code: "CC-SOP", id: "c-CC-SOP", fteMilli: 30000, snapshotCount: 10, declared: true },
    ])
    // Con el stock a 31-12 su peso era 0 y su estructura se trasladaba a los demás.
    expect(fteMonthsByCostCenter(rows, { from: "2026-12-01", to: "2026-12-31" })).toEqual([])
  })

  it("distingue «no hay nadie» (0 declarado) de «no lo hemos rellenado» (sin snapshot)", () => {
    const rows = [snap("CC-A", "2026-03-31", 0)]
    const weights = fteMonthsByCostCenter(rows, MARCH, {
      eligible: [
        { id: "c-CC-A", code: "CC-A" },
        { id: "c-CC-B", code: "CC-B" },
      ],
    })
    expect(weights).toEqual([
      { code: "CC-A", id: "c-CC-A", fteMilli: 0, snapshotCount: 1, declared: true },
      { code: "CC-B", id: "c-CC-B", fteMilli: 0, snapshotCount: 0, declared: false },
    ])
  })

  it("un `fteMilli` negativo o no entero se rechaza", () => {
    expect(() => fteMonthsByCostCenter([snap("CC-A", "2026-03-31", -1)], MARCH)).toThrow(TimeAggregateError)
    expect(() => fteMonthsByCostCenter([snap("CC-A", "2026-03-31", 1.5)], MARCH)).toThrow(/entero/)
  })

  it("HEADCOUNT sólo reparte a CECOs", () => {
    expect(() => assertHeadcountTargetKind("PROJECTS", "R-04")).toThrow(/COST_CENTERS/)
    expect(() => assertHeadcountTargetKind("BUSINESS_LINES")).toThrow(TimeAggregateError)
    expect(() => assertHeadcountTargetKind("COST_CENTERS")).not.toThrow()
  })
})
