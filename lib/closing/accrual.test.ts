/**
 * E9 · T7 — `lib/closing/accrual.ts` (R-PE-1…6).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md) y el que sella la tarea: los
 * nueve casos de `docs/design/fixtures/periodificaciones-esperadas.json`,
 * reconstruidos **byte a byte** contra el JSON que genera
 * `build_periodificaciones_esperadas.py` (§4.3).
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  accrualForPeriod,
  accrualPeriodLines,
  accrualSchedule,
  accrualScheduleHashOf,
  isInterestAccrual,
  totalAccruedCents,
  type AccrualRef,
  type DebtInstallmentRef,
} from "@/lib/closing/accrual"
import type { RecurrenceFreq } from "@/lib/recurring/schedule"

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "periodificaciones-esperadas.json")

type ExpectedCase = { id: string; titulo: string; freq: RecurrenceFreq; accrual: AccrualRef }
type ExpectedFile = { fixture: string; epica: string; tarea: string; reglas: string; cases: ExpectedCase[]; checks: unknown[] }

const expectedText = readFileSync(EXPECTED_PATH, "utf8")
const expected = JSON.parse(expectedText) as ExpectedFile

const accrual = (over: Partial<AccrualRef> = {}): AccrualRef => ({
  id: "ac-1",
  code: "PE-1",
  name: "Seguro",
  kind: "GASTO_ANTICIPADO",
  accrualAccountCode: "480",
  pnlAccountCode: "625",
  totalCents: 120_000,
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  basis: "MESES",
  ...over,
})

const PRESTAMO: DebtInstallmentRef[] = [
  { seq: 1, dueDate: "2026-03-31", principalCents: 2_500_000, interestCents: 100_000 },
  { seq: 2, dueDate: "2026-06-30", principalCents: 2_500_000, interestCents: 75_000 },
  { seq: 3, dueDate: "2026-09-30", principalCents: 2_500_000, interestCents: 50_000 },
  { seq: 4, dueDate: "2026-12-31", principalCents: 2_500_000, interestCents: 25_000 },
]

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios
// ─────────────────────────────────────────────────────────────────────────────

describe("R-PE-1 · MESES y DIAS", () => {
  it("un solo periodo: toda la cuota y pendiente 0", () => {
    const { rows } = accrualSchedule(accrual({ periodStart: "2026-03-01", periodEnd: "2026-03-31" }), "MENSUAL")
    expect(rows).toHaveLength(1)
    expect(rows[0].quotaCents).toBe(120_000)
    expect(rows[0].pendingCents).toBe(0)
    expect(rows[0].days).toBe(31)
  })

  it("MESES: pesos iguales y residuo a la última fila (R-PE-2)", () => {
    const { rows } = accrualSchedule(accrual({ totalCents: 100_000 }), "MENSUAL")
    expect(rows.map((r) => r.quotaCents).slice(0, 11)).toEqual(Array(11).fill(8_333))
    expect(rows[11].quotaCents).toBe(8_337)
    expect(totalAccruedCents(rows)).toBe(100_000)
    expect(rows[11].pendingCents).toBe(0)
  })

  it("criterio 9 / Q-6: prima de 100.000 a caballo de dos ejercicios ⇒ 12.876 y 87.124", () => {
    const { rows } = accrualSchedule(
      accrual({ totalCents: 100_000, periodStart: "2026-11-15", periodEnd: "2027-11-14", basis: "DIAS" }),
      "ANUAL"
    )
    expect(rows.map((r) => [r.period, r.days, r.quotaCents])).toEqual([
      ["2026", 47, 12_876],
      ["2027", 318, 87_124],
    ])
    expect(rows[1].pendingCents).toBe(0)
  })

  it("ACT/ACT con extremos incluidos y el 29-feb dentro", () => {
    const { rows } = accrualSchedule(
      accrual({ totalCents: 366_000, periodStart: "2028-01-01", periodEnd: "2028-12-31", basis: "DIAS" }),
      "MENSUAL"
    )
    expect(rows.find((r) => r.period === "2028-02")?.days).toBe(29)
    expect(rows.reduce((acc, r) => acc + r.days, 0)).toBe(366)
    expect(totalAccruedCents(rows)).toBe(366_000)
  })

  it("O-22: total menor que el número de periodos ⇒ cuotas 0 y aviso CUOTA_CERO", () => {
    const { rows, warnings } = accrualSchedule(
      accrual({ totalCents: 20, periodStart: "2026-01-01", periodEnd: "2028-12-31" }),
      "MENSUAL"
    )
    expect(rows.filter((r) => r.quotaCents === 0)).toHaveLength(35)
    expect(rows[35].quotaCents).toBe(20)
    expect(warnings.map((w) => w.code)).toContain("CUOTA_CERO")
  })

  it("importe cero: cuadro sin devengo y cuenta en cero", () => {
    const { rows } = accrualSchedule(accrual({ totalCents: 0 }), "MENSUAL")
    expect(totalAccruedCents(rows)).toBe(0)
    expect(rows[rows.length - 1].pendingCents).toBe(0)
  })

  it("rechaza un intervalo invertido y un importe negativo", () => {
    expect(() => accrualSchedule(accrual({ periodStart: "2026-12-31", periodEnd: "2026-01-01" }), "MENSUAL")).toThrow()
    expect(() => accrualSchedule(accrual({ totalCents: -1 }), "MENSUAL")).toThrow()
  })
})

describe("R-PE-4 · cancelación anticipada", () => {
  it("devenga el pendiente EN el periodo de la cancelación, sin recalcular el pasado", () => {
    const { rows, warnings } = accrualSchedule(accrual({ totalCents: 120_000, cancelledAtPeriod: "2026-05" }), "MENSUAL")
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.quotaCents)).toEqual([10_000, 10_000, 10_000, 10_000, 80_000])
    expect(rows[4].pendingCents).toBe(0)
    const w = warnings.find((x) => x.code === "CANCELACION_ANTICIPADA")
    expect(w?.deviationCents).toBe(70_000)
  })

  it("una cancelación posterior al fin no recorta nada", () => {
    const { rows, warnings } = accrualSchedule(accrual({ cancelledAtPeriod: "2027-05" }), "MENSUAL")
    expect(rows).toHaveLength(12)
    expect(warnings.map((w) => w.code)).not.toContain("CANCELACION_ANTICIPADA")
  })
})

describe("R-PE-6 · 567/568 (O-25)", () => {
  const intereses = (over: Partial<AccrualRef> = {}) =>
    accrual({
      code: "PE-INT",
      kind: "INTERESES_PAGADOS_ANTICIPADO",
      accrualAccountCode: "567",
      pnlAccountCode: "662",
      totalCents: 250_000,
      basis: "DIAS",
      debtInstallments: PRESTAMO,
      ...over,
    })

  it("WARN con la desviación cuando el principal es decreciente", () => {
    const { warnings } = accrualSchedule(intereses(), "TRIMESTRAL")
    const w = warnings.find((x) => x.code === "DIAS_SOBRE_INTERESES")
    expect(w?.severity).toBe("WARN")
    expect(w?.deviationCents).toBeGreaterThan(0)
    expect(w?.message).toContain("tipo de interés efectivo")
  })

  it("WARN también con horizonte > 12 meses aunque no haya cuadro", () => {
    const { warnings } = accrualSchedule(
      intereses({ debtInstallments: undefined, periodStart: "2026-01-01", periodEnd: "2027-12-31" }),
      "TRIMESTRAL"
    )
    const w = warnings.find((x) => x.code === "DIAS_SOBRE_INTERESES")
    expect(w).toBeDefined()
    // Sin cuadro, la desviación no es computable: no se inventa (P1).
    expect(w?.deviationCents).toBeUndefined()
  })

  it("sin WARN con principal constante y horizonte ≤ 12 meses", () => {
    const { warnings } = accrualSchedule(intereses({ debtInstallments: undefined }), "TRIMESTRAL")
    expect(warnings.map((w) => w.code)).not.toContain("DIAS_SOBRE_INTERESES")
  })

  it("TIPO_EFECTIVO: la cuota la aporta el cuadro del préstamo", () => {
    const { rows, warnings } = accrualSchedule(intereses({ basis: "TIPO_EFECTIVO" }), "TRIMESTRAL")
    expect(rows.map((r) => r.quotaCents)).toEqual([100_000, 75_000, 50_000, 25_000])
    expect(warnings).toEqual([])
  })

  it("TIPO_EFECTIVO sin cuadro es un ERROR, no una aproximación", () => {
    const { rows, warnings } = accrualSchedule(intereses({ basis: "TIPO_EFECTIVO", debtInstallments: undefined }), "TRIMESTRAL")
    expect(rows).toEqual([])
    expect(warnings[0]).toMatchObject({ code: "SIN_CUADRO_DE_DEUDA", severity: "ERROR" })
  })

  it("avisa si el cuadro no cubre el importe declarado", () => {
    const { warnings } = accrualSchedule(intereses({ basis: "TIPO_EFECTIVO", totalCents: 300_000 }), "TRIMESTRAL")
    const w = warnings.find((x) => x.code === "CUADRO_NO_CUBRE_EL_INTERVALO")
    expect(w?.deviationCents).toBe(50_000)
  })

  it("clasifica las cuatro clases", () => {
    expect(isInterestAccrual("INTERESES_PAGADOS_ANTICIPADO")).toBe(true)
    expect(isInterestAccrual("INTERESES_COBRADOS_ANTICIPADO")).toBe(true)
    expect(isInterestAccrual("GASTO_ANTICIPADO")).toBe(false)
    expect(isInterestAccrual("INGRESO_ANTICIPADO")).toBe(false)
  })
})

describe("R-PE-3 · líneas del devengo periodo a periodo", () => {
  it("gasto anticipado: 6xx (D) / 480 (H) con el destino analítico en la línea de PyG", () => {
    const a = accrual({ projectId: "p-1", costCenterId: "cc-1" })
    const { rows } = accrualSchedule(a, "MENSUAL")
    const out = accrualPeriodLines(a, rows[0])
    if (!out.ok) throw new Error("esperaba líneas")
    expect(out.value.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
      ["625", 10_000, 0],
      ["480", 0, 10_000],
    ])
    expect(out.value[0].projectId).toBe("p-1")
    expect(out.value[1].projectId).toBeUndefined()
  })

  it("ingreso anticipado: 485 (D) / 7xx (H)", () => {
    const a = accrual({ kind: "INGRESO_ANTICIPADO", accrualAccountCode: "485", pnlAccountCode: "705" })
    const { rows } = accrualSchedule(a, "MENSUAL")
    const out = accrualPeriodLines(a, rows[0])
    if (!out.ok) throw new Error("esperaba líneas")
    expect(out.value.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
      ["485", 10_000, 0],
      ["705", 0, 10_000],
    ])
  })

  it("intereses cobrados: 568 (D) / 762 (H)", () => {
    const a = accrual({ kind: "INTERESES_COBRADOS_ANTICIPADO", accrualAccountCode: "568", pnlAccountCode: "762" })
    const { rows } = accrualSchedule(a, "MENSUAL")
    const out = accrualPeriodLines(a, rows[0])
    if (!out.ok) throw new Error("esperaba líneas")
    expect(out.value.map((l) => l.accountCode)).toEqual(["568", "762"])
  })

  it("R-REC-8: una cuota de 0 no produce asiento", () => {
    const a = accrual({ totalCents: 20, periodStart: "2026-01-01", periodEnd: "2028-12-31" })
    const { rows } = accrualSchedule(a, "MENSUAL")
    const out = accrualPeriodLines(a, rows[0])
    if (out.ok) throw new Error("esperaba error")
    expect(out.errors[0].check).toBe("R-REC-8")
  })
})

describe("sello del cuadro", () => {
  it("es estable y cambia con el cuadro", () => {
    const { rows } = accrualSchedule(accrual(), "MENSUAL")
    const otro = accrualSchedule(accrual({ totalCents: 120_001 }), "MENSUAL").rows
    expect(accrualScheduleHashOf(rows)).toBe(accrualScheduleHashOf(rows))
    expect(accrualScheduleHashOf(rows)).toMatch(/^[0-9a-f]{64}$/)
    expect(accrualScheduleHashOf(rows)).not.toBe(accrualScheduleHashOf(otro))
  })

  it("accrualForPeriod no interpola", () => {
    const { rows } = accrualSchedule(accrual(), "MENSUAL")
    expect(accrualForPeriod(rows, "2026-02")?.quotaCents).toBe(10_000)
    expect(accrualForPeriod(rows, "2027-02")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El test que sella la tarea: los nueve casos, byte a byte
// ─────────────────────────────────────────────────────────────────────────────

type Check = { id: string; expected: number; actual: number; status: string }
const checkOf = (id: string, expectedValue: number, actual: number): Check => ({
  id,
  expected: expectedValue,
  actual,
  status: expectedValue === actual ? "PASS" : "FAIL",
})

const daysInclusive = (from: string, to: string): number => {
  const rows = accrualSchedule(
    { ...accrual({ totalCents: 0, periodStart: from, periodEnd: to, basis: "DIAS" }) },
    "ANUAL"
  ).rows
  return rows.reduce((acc, r) => acc + r.days, 0)
}

describe("periodificaciones-esperadas.json · los nueve casos del diseño", () => {
  it("reproduce el fichero byte a byte", () => {
    const cases = expected.cases.map((c) => {
      const { rows, warnings } = accrualSchedule(c.accrual, c.freq)
      const first = rows.length > 0 ? accrualPeriodLines(c.accrual, rows[0]) : null
      return {
        id: c.id,
        titulo: c.titulo,
        freq: c.freq,
        accrual: c.accrual,
        rows,
        warnings,
        totals: {
          quotaCents: totalAccruedCents(rows),
          rowCount: rows.length,
          zeroQuotaRows: rows.filter((r) => r.quotaCents === 0).length,
          lastPendingCents: rows.length > 0 ? rows[rows.length - 1].pendingCents : c.accrual.totalCents,
          totalDays: daysInclusive(c.accrual.periodStart, c.accrual.periodEnd),
        },
        scheduleHash: accrualScheduleHashOf(rows),
        firstEntryLines: first?.ok ? first.value : [],
      }
    })

    const checks: Check[] = []
    for (const c of cases) {
      if (c.rows.length > 0 && c.accrual.basis !== "TIPO_EFECTIVO") {
        checks.push(checkOf(`R-PE-2/${c.id}`, 0, c.rows[c.rows.length - 1].pendingCents))
        checks.push(checkOf(`Sigma/${c.id}`, c.accrual.totalCents, c.totals.quotaCents))
      }
    }
    const p1 = cases.find((c) => c.id === "P1")
    checks.push(checkOf("criterio-9/2026", 12_876, p1?.rows[0].quotaCents ?? 0))
    checks.push(checkOf("criterio-9/2027", 87_124, p1?.rows[1].quotaCents ?? 0))
    checks.push(checkOf("Q-6/365-dias", 365, p1?.totals.totalDays ?? 0))
    const p5 = cases.find((c) => c.id === "P5")
    checks.push(
      checkOf("O-25/warn-dias-sobre-intereses", 1, p5?.warnings.filter((w) => w.code === "DIAS_SOBRE_INTERESES").length ?? 0)
    )
    const p7 = cases.find((c) => c.id === "P7")
    checks.push(checkOf("O-22/cuota-cero", 35, p7?.totals.zeroQuotaRows ?? 0))
    const p9 = cases.find((c) => c.id === "P9")
    checks.push(checkOf("bisiesto/29-feb", 29, p9?.rows.find((r) => r.period === "2028-02")?.days ?? 0))

    const rebuilt = {
      fixture: expected.fixture,
      epica: expected.epica,
      tarea: expected.tarea,
      reglas: expected.reglas,
      cases,
      checks,
    }
    expect(JSON.stringify(rebuilt, null, 2) + "\n").toBe(expectedText)
    expect(checks.every((c) => c.status === "PASS")).toBe(true)
  })
})
