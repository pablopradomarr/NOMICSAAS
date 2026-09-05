/**
 * E3 · T4 — `lib/ledger/dates.ts`. Casos obligatorios: vacío, un registro,
 * fechas límite (29-feb, cierre de ejercicio) y desplazamiento por mes bloqueado.
 */

import { describe, expect, it } from "vitest"

import {
  compareDates,
  daysInMonth,
  firstDayOfMonth,
  firstDayOfNextMonth,
  firstOpenMonthFrom,
  fromUtcDate,
  isLeapYear,
  isValidLocalDate,
  lastDayOfMonth,
  parseLocalDate,
  resolveEntryDate,
  resolveReversalDate,
  toUtcDate,
} from "@/lib/ledger/dates"
import { FY_2025_CLOSED, FY_2026, FY_2027, testContext } from "@/tests/support/ledger-context"

describe("aritmética de fechas contables", () => {
  it("29 de febrero solo existe en año bisiesto", () => {
    expect(isLeapYear(2024)).toBe(true)
    expect(isLeapYear(2026)).toBe(false)
    expect(isLeapYear(2000)).toBe(true)
    expect(isLeapYear(1900)).toBe(false)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(isValidLocalDate("2024-02-29")).toBe(true)
    expect(isValidLocalDate("2026-02-29")).toBe(false)
    expect(parseLocalDate("2026-02-29")).toBeNull()
  })

  it("rechaza formatos que no son YYYY-MM-DD", () => {
    for (const bad of ["", "2026-1-1", "01/01/2026", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      expect(isValidLocalDate(bad)).toBe(false)
    }
  })

  it("ordena por texto, que es el orden cronológico", () => {
    expect(compareDates("2026-01-31", "2026-02-01")).toBe(-1)
    expect(compareDates("2026-12-31", "2027-01-01")).toBe(-1)
    expect(compareDates("2026-03-10", "2026-03-10")).toBe(0)
  })

  it("primer y último día de mes, con paso de año en diciembre", () => {
    expect(firstDayOfMonth("2026-03-17")).toBe("2026-03-01")
    expect(lastDayOfMonth("2026-02-05")).toBe("2026-02-28")
    expect(lastDayOfMonth("2024-02-05")).toBe("2024-02-29")
    expect(firstDayOfNextMonth("2026-12-05")).toBe("2027-01-01")
    expect(firstDayOfNextMonth("2026-01-31")).toBe("2026-02-01")
  })

  it("convierte a `Date` siempre en UTC (sin desfase de un día)", () => {
    expect(toUtcDate("2026-03-10").toISOString()).toBe("2026-03-10T00:00:00.000Z")
    expect(fromUtcDate(new Date("2026-03-10T00:00:00.000Z"))).toBe("2026-03-10")
  })
})

describe("resolveEntryDate (§2.2)", () => {
  it("sin fecha ninguna, error de formato (caso vacío)", () => {
    const r = resolveEntryDate({}, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].code).toBe("DATE_FORMAT")
  })

  it("mes abierto: la fecha contable es el devengo, sin coletilla", () => {
    const r = resolveEntryDate({ documentDate: "2026-03-10" }, testContext())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.entryDate).toBe("2026-03-10")
      expect(r.value.shifted).toBe("NONE")
      expect(r.value.note).toBeUndefined()
      expect(r.value.fiscalYearId).toBe(FY_2026.id)
    }
  })

  it("el devengo manda sobre la fecha del documento", () => {
    const r = resolveEntryDate({ documentDate: "2026-03-10", accrualDate: "2026-04-02" }, testContext())
    expect(r.ok && r.value.entryDate).toBe("2026-04-02")
  })

  it("mes bloqueado: primer día del primer mes abierto, con [devengo …]", () => {
    const ctx = testContext({ periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    const r = resolveEntryDate({ accrualDate: "2026-03-10" }, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.entryDate).toBe("2026-04-01")
      expect(r.value.shifted).toBe("MONTH_LOCKED")
      expect(r.value.note).toBe("[devengo 2026-03-10]")
    }
  })

  it("varios meses bloqueados seguidos: salta al primero abierto", () => {
    const ctx = testContext({
      periodLocks: [3, 4, 5].map((month) => ({ fiscalYearId: FY_2026.id, month })),
    })
    const r = resolveEntryDate({ accrualDate: "2026-03-10" }, ctx)
    expect(r.ok && r.value.entryDate).toBe("2026-06-01")
  })

  it("ejercicio cerrado: señal FY_CLOSED, que dirige a T-22", () => {
    const r = resolveEntryDate({ documentDate: "2025-11-30" }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0].code).toBe("FY_CLOSED")
      expect(r.errors[0].message).toContain("T-22")
    }
  })

  it("fecha futura respecto de refDate: bloquea sin excepción (O-8)", () => {
    const r = resolveEntryDate({ documentDate: "2026-12-31" }, testContext({ refDate: "2026-06-30" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].code).toBe("FUTURE_DATE")
  })

  it("sin ejercicio que contenga la fecha, FY_NOT_FOUND", () => {
    const r = resolveEntryDate({ documentDate: "2020-01-15" }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0].code).toBe("FY_NOT_FOUND")
  })

  it("31 de diciembre del ejercicio: sigue dentro (fecha límite de cierre)", () => {
    const r = resolveEntryDate({ documentDate: "2026-12-31" }, testContext({ refDate: "2027-01-05" }))
    expect(r.ok && r.value.entryDate).toBe("2026-12-31")
    expect(r.ok && r.value.fiscalYearId).toBe(FY_2026.id)
  })

  it("29-feb de un año bisiesto es una fecha contable válida", () => {
    const ctx = testContext({
      refDate: "2024-12-31",
      fiscalYears: [{ id: "fy-2024", code: "2024", startDate: "2024-01-01", endDate: "2024-12-31", status: "OPEN" }],
    })
    const r = resolveEntryDate({ documentDate: "2024-02-29" }, ctx)
    expect(r.ok && r.value.entryDate).toBe("2024-02-29")
  })
})

describe("firstOpenMonthFrom", () => {
  it("sin ejercicios (caso vacío) devuelve null", () => {
    expect(firstOpenMonthFrom(testContext({ fiscalYears: [] }), "2026-03-10")).toBeNull()
  })

  it("salta un ejercicio cerrado entero al siguiente abierto", () => {
    const ctx = testContext({ fiscalYears: [FY_2025_CLOSED, FY_2026] })
    expect(firstOpenMonthFrom(ctx, "2025-06-10")).toBe("2026-01-01")
  })

  it("con los doce meses bloqueados pasa al ejercicio siguiente", () => {
    const ctx = testContext({
      fiscalYears: [FY_2026, FY_2027],
      periodLocks: Array.from({ length: 12 }, (_, i) => ({ fiscalYearId: FY_2026.id, month: i + 1 })),
    })
    expect(firstOpenMonthFrom(ctx, "2026-05-10")).toBe("2027-01-01")
  })
})

describe("resolveReversalDate (§2.5)", () => {
  it("mes abierto: la MISMA fecha del original", () => {
    const r = resolveReversalDate("2026-03-10", testContext())
    expect(r.ok && r.value.entryDate).toBe("2026-03-10")
    expect(r.ok && r.value.shifted).toBe(false)
  })

  it("mes cerrado: primer día del primer mes abierto, no «hoy»", () => {
    const ctx = testContext({ refDate: "2026-07-20", periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    const r = resolveReversalDate("2026-03-10", ctx)
    expect(r.ok && r.value.entryDate).toBe("2026-04-01")
    expect(r.ok && r.value.shifted).toBe(true)
  })

  it("requestedDate solo puede RETRASAR la fecha", () => {
    const ctx = testContext({ refDate: "2026-07-20", periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    expect(resolveReversalDate("2026-03-10", ctx, "2026-06-15").ok).toBe(true)
    const early = resolveReversalDate("2026-03-10", ctx, "2026-03-11")
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.errors[0].code).toBe("MONTH_LOCKED")
  })
})
