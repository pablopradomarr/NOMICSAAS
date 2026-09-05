import { describe, expect, it } from "vitest"

import { monthsBetween } from "@/models/fiscal-years"

/**
 * E3 · T8 — La única función pura de `models/fiscal-years.ts`: qué meses hay que
 * bloquear para cerrar un ejercicio (B-4). El resto del módulo es IO y se prueba
 * en `tests/integration/e3-ledger.test.ts`.
 */
describe("monthsBetween", () => {
  it("ejercicio natural: los doce meses", () => {
    expect(monthsBetween("2026-01-01", "2026-12-31")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it("ejercicio irregular corto: sólo los meses que toca", () => {
    expect(monthsBetween("2026-04-15", "2026-12-31")).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(monthsBetween("2026-11-01", "2026-12-31")).toEqual([11, 12])
  })

  it("un solo día y un solo mes", () => {
    expect(monthsBetween("2026-03-10", "2026-03-10")).toEqual([3])
  })

  it("29 de febrero de un año bisiesto entra en el mes 2", () => {
    expect(monthsBetween("2024-02-29", "2024-03-01")).toEqual([2, 3])
  })

  it("ejercicio a caballo entre dos años naturales: no repite el mes", () => {
    // 2026-07-01 … 2027-06-30 toca los doce meses una sola vez cada uno.
    expect(monthsBetween("2026-07-01", "2027-06-30")).toEqual([7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6])
  })
})
