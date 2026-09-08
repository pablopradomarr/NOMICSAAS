/**
 * E9 · T5 — `lib/recurring/schedule.ts` (R-REC-1…8).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md): vacío, un registro,
 * importes negativos, fechas límite (cierre de ejercicio, 29-feb) y redondeo de
 * céntimos. Y los de la épica: **determinismo** del sello y de la próxima
 * ejecución, e idempotencia por periodo.
 */

import { describe, expect, it } from "vitest"

import type { LedgerContext, ResolvedLine } from "@/lib/ledger/types"
import { ok } from "@/lib/ledger/types"
import {
  buildOccurrenceDraft,
  canonicalJson,
  daysInclusive,
  duePeriods,
  isPeriodKey,
  isSkip,
  nextDuePeriod,
  nextPeriodKey,
  nextScheduledPeriod,
  occurrenceInputHash,
  periodBounds,
  periodIndex,
  periodKeyFromIndex,
  periodKeyOf,
  periodsBetween,
  postingDateOf,
  toEpochDay,
  type RecurrenceFreq,
  type RecurringRuleRef,
} from "@/lib/recurring/schedule"

const rule = (over: Partial<RecurringRuleRef> = {}): RecurringRuleRef => ({
  id: "r-1",
  code: "REC-001",
  name: "Amortización mensual",
  kind: "AMORTIZACION",
  frequency: "MENSUAL",
  anchor: "ULTIMO_DIA",
  dayOfMonth: null,
  startPeriod: "2026-01",
  endPeriod: null,
  status: "ACTIVA",
  templateCode: "T-14",
  templateInput: { assetId: "fa-1" },
  amountCents: null,
  ...over,
})

const ctx = (over: Partial<LedgerContext> = {}): LedgerContext =>
  ({
    organizationId: "org-1",
    refDate: "2026-06-30",
    plan: { accounts: [], byCode: new Map() },
    map: () => null,
    rates: [],
    fiscalYears: [{ id: "fy-2026", code: "2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "OPEN" }],
    periodLocks: [],
    policy: { taxRoundingMode: "PER_LINE", prorrataBps: null, redondeoToleranciaCents: 0, analyticsRequired: false },
    dimensions: { projects: [], costCenters: [], businessLines: [] },
    baseCurrency: "EUR",
    ...over,
  }) as unknown as LedgerContext

const lines = (amountCents: number): ResolvedLine[] => [
  { lineNo: 1, accountCode: "6813", debitCents: amountCents, creditCents: 0 },
  { lineNo: 2, accountCode: "2811", debitCents: 0, creditCents: amountCents },
]
const buildLines = (amountCents: number) => ok(lines(amountCents))

describe("claves de periodo", () => {
  it("deriva la clave de cada frecuencia", () => {
    expect(periodKeyOf("2026-03-17", "MENSUAL")).toBe("2026-03")
    expect(periodKeyOf("2026-04-01", "TRIMESTRAL")).toBe("2026-Q2")
    expect(periodKeyOf("2026-06-30", "SEMESTRAL")).toBe("2026-S1")
    expect(periodKeyOf("2026-07-01", "SEMESTRAL")).toBe("2026-S2")
    expect(periodKeyOf("2026-12-31", "ANUAL")).toBe("2026")
  })

  it("ida y vuelta por índice para las cuatro frecuencias", () => {
    const freqs: RecurrenceFreq[] = ["MENSUAL", "TRIMESTRAL", "SEMESTRAL", "ANUAL"]
    const keys = ["2026-11", "2026-Q4", "2026-S2", "2026"]
    freqs.forEach((freq, i) => {
      expect(periodKeyFromIndex(periodIndex(keys[i], freq), freq)).toBe(keys[i])
      expect(isPeriodKey(keys[i], freq)).toBe(true)
    })
  })

  it("rechaza una clave de otra frecuencia", () => {
    expect(isPeriodKey("2026-Q2", "MENSUAL")).toBe(false)
    expect(isPeriodKey("2026-13", "MENSUAL")).toBe(false)
    expect(() => periodIndex("2026-Q5", "TRIMESTRAL")).toThrow()
  })

  it("cambia de año sin usar Date", () => {
    expect(nextPeriodKey("2026-12", "MENSUAL")).toBe("2027-01")
    expect(nextPeriodKey("2026-Q4", "TRIMESTRAL")).toBe("2027-Q1")
    expect(nextPeriodKey("2026-S2", "SEMESTRAL")).toBe("2027-S1")
    expect(nextPeriodKey("2026", "ANUAL")).toBe("2027")
  })

  it("acota bien febrero, incluido el bisiesto", () => {
    expect(periodBounds("2026-02", "MENSUAL")).toEqual({ start: "2026-02-01", end: "2026-02-28" })
    expect(periodBounds("2028-02", "MENSUAL")).toEqual({ start: "2028-02-01", end: "2028-02-29" })
    expect(periodBounds("2026-Q1", "TRIMESTRAL")).toEqual({ start: "2026-01-01", end: "2026-03-31" })
    expect(periodBounds("2026", "ANUAL")).toEqual({ start: "2026-01-01", end: "2026-12-31" })
  })
})

describe("R-REC-2 · fecha del asiento", () => {
  it("último día, primero, y día del mes SATURADO", () => {
    expect(postingDateOf("2026-02", "MENSUAL", "ULTIMO_DIA")).toBe("2026-02-28")
    expect(postingDateOf("2026-02", "MENSUAL", "PRIMER_DIA")).toBe("2026-02-01")
    expect(postingDateOf("2026-02", "MENSUAL", "DIA_DEL_MES", 31)).toBe("2026-02-28")
    expect(postingDateOf("2028-02", "MENSUAL", "DIA_DEL_MES", 31)).toBe("2028-02-29")
    expect(postingDateOf("2026-03", "MENSUAL", "DIA_DEL_MES", 15)).toBe("2026-03-15")
    // En un trimestre, el día declarado cae en el ÚLTIMO mes del periodo.
    expect(postingDateOf("2026-Q1", "TRIMESTRAL", "DIA_DEL_MES", 10)).toBe("2026-03-10")
  })
})

describe("R-REC-1 / R-REC-5 · periodos vencidos", () => {
  it("vacío: sin periodos vencidos antes de la vigencia", () => {
    expect(duePeriods(rule({ startPeriod: "2027-01" }), [], "2026-06-30")).toEqual([])
  })

  it("uno: el primer periodo vencido", () => {
    const due = duePeriods(rule(), [], "2026-01-31")
    expect(due.map((p) => p.key)).toEqual(["2026-01"])
    expect(due[0].postingDate).toBe("2026-01-31")
  })

  it("nunca un periodo que no ha terminado (I8)", () => {
    // El 30 de junio, junio ya venció; julio no existe todavía.
    expect(duePeriods(rule(), [], "2026-06-30").map((p) => p.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ])
    expect(duePeriods(rule(), [], "2026-06-29").map((p) => p.key)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ])
  })

  it("idempotencia: lo ya generado no vuelve a salir", () => {
    const due = duePeriods(rule(), ["2026-01", "2026-02", "2026-03"], "2026-06-30")
    expect(due.map((p) => p.key)).toEqual(["2026-04", "2026-05", "2026-06"])
  })

  it("R-REC-5: una regla PAUSADA no genera y NO rellena hacia atrás", () => {
    expect(duePeriods(rule({ status: "PAUSADA" }), [], "2026-06-30")).toEqual([])
    expect(duePeriods(rule({ status: "FINALIZADA" }), [], "2026-06-30")).toEqual([])
    // Al reactivarla, los periodos ya registrados como OMITIDA no reaparecen.
    const reactivada = duePeriods(rule(), ["2026-01", "2026-02", "2026-03", "2026-04"], "2026-06-30")
    expect(reactivada.map((p) => p.key)).toEqual(["2026-05", "2026-06"])
  })

  it("respeta el fin de vigencia", () => {
    const due = duePeriods(rule({ endPeriod: "2026-03" }), [], "2026-12-31")
    expect(due.map((p) => p.key)).toEqual(["2026-01", "2026-02", "2026-03"])
  })

  it("periodsBetween no depende de la fecha de referencia y respeta la vigencia", () => {
    expect(periodsBetween(rule({ startPeriod: "2026-03", endPeriod: "2026-05" }), "2026-01", "2026-12").map((p) => p.key)).toEqual([
      "2026-03",
      "2026-04",
      "2026-05",
    ])
    expect(periodsBetween(rule(), "2026-05", "2026-01")).toEqual([])
  })
})

describe("próxima ejecución determinista", () => {
  it("es el primer periodo vencido pendiente", () => {
    expect(nextDuePeriod(rule(), ["2026-01"], "2026-06-30")?.key).toBe("2026-02")
    expect(nextDuePeriod(rule(), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"], "2026-06-30")).toBeNull()
  })

  it("al día, apunta al periodo siguiente aunque no haya vencido", () => {
    const generated = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]
    expect(nextScheduledPeriod(rule(), generated, "2026-06-30")?.key).toBe("2026-07")
    expect(nextScheduledPeriod(rule({ endPeriod: "2026-06" }), generated, "2026-06-30")).toBeNull()
    expect(nextScheduledPeriod(rule({ status: "PAUSADA" }), generated, "2026-06-30")).toBeNull()
  })

  it("es estable: dos llamadas con la misma entrada dan lo mismo", () => {
    const a = nextDuePeriod(rule(), ["2026-01"], "2026-06-30")
    const b = nextDuePeriod(rule(), ["2026-01"], "2026-06-30")
    expect(a).toEqual(b)
  })
})

describe("I-E9-1b · sello del input efectivo", () => {
  it("es determinista y no depende del orden de las claves", () => {
    const period = periodsBetween(rule(), "2026-03", "2026-03")[0]
    const h1 = occurrenceInputHash(rule(), period, { b: 2, a: 1 })
    const h2 = occurrenceInputHash(rule(), period, { a: 1, b: 2 })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it("cambia si cambia la regla, el periodo o el input", () => {
    const p3 = periodsBetween(rule(), "2026-03", "2026-03")[0]
    const p4 = periodsBetween(rule(), "2026-04", "2026-04")[0]
    const base = occurrenceInputHash(rule(), p3, { assetId: "fa-1" })
    expect(occurrenceInputHash(rule(), p4, { assetId: "fa-1" })).not.toBe(base)
    expect(occurrenceInputHash(rule(), p3, { assetId: "fa-2" })).not.toBe(base)
    expect(occurrenceInputHash(rule({ anchor: "PRIMER_DIA" }), p3, { assetId: "fa-1" })).not.toBe(base)
  })

  it("canonicalJson: claves ordenadas, sin undefined y NFC", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]")
    expect(canonicalJson("á")).toBe(JSON.stringify("á"))
    expect(() => canonicalJson(Number.NaN)).toThrow()
  })
})

describe("buildOccurrenceDraft", () => {
  const period = (key: string) => periodsBetween(rule(), key, key)[0]

  it("importe fijo: borrador con kind y sourceId de R-REC-6", () => {
    const r = rule({ kind: "IMPORTE_FIJO", amountCents: 12_345 })
    const out = buildOccurrenceDraft(r, period("2026-03"), { buildLines }, ctx())
    expect(isSkip(out)).toBe(false)
    if (isSkip(out) || !out.ok) throw new Error("esperaba borrador")
    expect(out.value.kind).toBe("RECURRING")
    expect(out.value.sourceType).toBe("RECURRING")
    expect(out.value.sourceId).toBe("REC-001/2026-03")
    expect(out.value.entryDate).toBe("2026-03-31")
    expect(out.value.accrualDate).toBe("2026-03-31")
    expect(out.value.fiscalYearId).toBe("fy-2026")
    expect(out.value.lines.map((l) => l.debitCents + l.creditCents)).toEqual([12_345, 12_345])
  })

  it("R-REC-8: cuota 0 no genera asiento", () => {
    const out = buildOccurrenceDraft(rule(), period("2026-03"), { rows: [{ period: "2026-03", quotaCents: 0 }], buildLines }, ctx())
    expect(out).toEqual({ skip: "CUOTA_CERO" })
    const fijo = buildOccurrenceDraft(rule({ kind: "IMPORTE_FIJO", amountCents: 0 }), period("2026-03"), { buildLines }, ctx())
    expect(fijo).toEqual({ skip: "CUOTA_CERO" })
  })

  it("R-REC-4: sin fila en el cuadro no se interpola", () => {
    const out = buildOccurrenceDraft(rule(), period("2026-03"), { rows: [{ period: "2026-04", quotaCents: 100 }], buildLines }, ctx())
    expect(out).toEqual({ skip: "SIN_FILA_EN_CUADRO" })
  })

  it("importes negativos: se aceptan (una regularización a la baja) y llegan a las líneas", () => {
    const out = buildOccurrenceDraft(
      rule({ kind: "IMPORTE_FIJO", amountCents: -500 }),
      period("2026-03"),
      { buildLines: (amount) => ok([{ lineNo: 1, accountCode: "480", debitCents: 0, creditCents: amount }]) },
      ctx()
    )
    if (isSkip(out) || !out.ok) throw new Error("esperaba borrador")
    expect(out.value.lines[0].creditCents).toBe(-500)
  })

  it("R-REC-1: un periodo sin vencer no produce asiento", () => {
    const out = buildOccurrenceDraft(rule(), period("2026-12"), { rows: [{ period: "2026-12", quotaCents: 100 }], buildLines }, ctx())
    if (isSkip(out) || out.ok) throw new Error("esperaba error")
    expect(out.errors[0].code).toBe("FUTURE_DATE")
  })

  it("ejercicio cerrado: se devuelve FY_CLOSED para que el llamante use T-22", () => {
    const cerrado = ctx({
      fiscalYears: [{ id: "fy-2026", code: "2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "CLOSED" }],
    })
    const out = buildOccurrenceDraft(rule(), period("2026-03"), { rows: [{ period: "2026-03", quotaCents: 100 }], buildLines }, cerrado)
    if (isSkip(out) || out.ok) throw new Error("esperaba error")
    expect(out.errors[0].code).toBe("FY_CLOSED")
  })

  it("mes bloqueado: el asiento se desplaza al primer mes abierto con su coletilla", () => {
    const bloqueado = ctx({ periodLocks: [{ fiscalYearId: "fy-2026", month: 3 }] })
    const out = buildOccurrenceDraft(rule(), period("2026-03"), { rows: [{ period: "2026-03", quotaCents: 100 }], buildLines }, bloqueado)
    if (isSkip(out) || !out.ok) throw new Error("esperaba borrador")
    expect(out.value.entryDate).toBe("2026-04-01")
    expect(out.value.accrualDate).toBe("2026-03-31")
    expect(out.value.description).toContain("[devengo 2026-03-31]")
  })

  it("una regla PAUSADA no construye borrador ni por la puerta de atrás", () => {
    const out = buildOccurrenceDraft(rule({ status: "PAUSADA" }), period("2026-03"), { rows: [{ period: "2026-03", quotaCents: 100 }], buildLines }, ctx())
    if (isSkip(out) || out.ok) throw new Error("esperaba error")
    expect(out.errors[0].check).toBe("R-REC-5")
  })
})

describe("ACT/ACT con los dos extremos incluidos (R-PE-1)", () => {
  it("del 15-11-2026 al 14-11-2027 hay 365 días, no 364", () => {
    expect(daysInclusive("2026-11-15", "2027-11-14")).toBe(365)
  })

  it("cuenta el 29 de febrero", () => {
    expect(daysInclusive("2028-02-01", "2028-02-29")).toBe(29)
    expect(daysInclusive("2028-01-01", "2028-12-31")).toBe(366)
    expect(daysInclusive("2026-01-01", "2026-12-31")).toBe(365)
  })

  it("un solo día cuenta uno; un intervalo invertido, cero", () => {
    expect(daysInclusive("2026-03-01", "2026-03-01")).toBe(1)
    expect(daysInclusive("2026-03-02", "2026-03-01")).toBe(0)
  })

  it("toEpochDay avanza de uno en uno en los cambios de mes, año y siglo", () => {
    expect(toEpochDay("2026-03-01") - toEpochDay("2026-02-28")).toBe(1)
    expect(toEpochDay("2028-03-01") - toEpochDay("2028-02-29")).toBe(1)
    expect(toEpochDay("2027-01-01") - toEpochDay("2026-12-31")).toBe(1)
    expect(toEpochDay("2100-03-01") - toEpochDay("2100-02-28")).toBe(1) // 2100 no es bisiesto
  })
})
