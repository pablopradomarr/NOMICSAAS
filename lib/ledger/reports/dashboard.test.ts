/**
 * E6 · T18 — El panel reescrito sobre el diario (G-05 / G-06).
 *
 * Lo que estos tests protegen es que el panel **no vuelva a tener aritmética
 * propia**: sus cuatro KPI tienen que salir bit a bit de los mismos motores que
 * los informes (I-E6-19), y un porcentaje sin base tiene que pintarse `—`, no
 * `NaN` ni `0 %`.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { parseNpgcCsv } from "@/lib/accounts/csv"
import { buildCashflowDirect } from "@/lib/ledger/reports/cashflow"
import { buildDashboard, monthsBetween, UNPOSTED_NOTE } from "@/lib/ledger/reports/dashboard"
import { buildPyg } from "@/lib/ledger/reports/pyg"
import { buildAccountIndex, type StatementAccount } from "@/lib/ledger/reports/types"
import { loadFixture, toReportLines } from "@/tests/support/fixtures"

function seedAccounts(): StatementAccount[] {
  const parsed = parseNpgcCsv(readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8"))
  if (!parsed.ok) throw new Error("El seed no parsea")
  return parsed.value.map((r) => ({
    code: r.code,
    name: r.name,
    level: r.level,
    statement: r.statement,
    epigraph: r.epigraph,
    epigraphPymes: r.epigraphPymes,
    bidirectional: r.bidirectional,
    isContra: r.isContra,
    nature: r.nature,
    cashflowBucket: r.cashflowBucket,
  }))
}

const index = buildAccountIndex(seedAccounts())
const fixture = loadFixture("ejercicio-completo")
const lines = toReportLines(fixture.posted)
const FY_2026 = fixture.fiscalYears.find((fy) => fy.code === "2026")!

const params = {
  organizationId: fixture.ctx.organizationId,
  from: "2026-01-01",
  to: "2026-12-31",
  baseCurrency: "EUR",
  fiscalYearId: FY_2026.id,
  variant: "GENERAL" as const,
  refDate: "2026-12-31",
}

describe("monthsBetween", () => {
  it("devuelve los doce meses del ejercicio, ambos extremos incluidos", () => {
    const months = monthsBetween("2026-01-01", "2026-12-31")
    expect(months).toHaveLength(12)
    expect(months[0]).toBe("2026-01")
    expect(months[11]).toBe("2026-12")
  })

  it("cruza el fin de año", () => {
    expect(monthsBetween("2026-11-01", "2027-02-28")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"])
  })

  it("rango degenerado: un solo mes, no una lista vacía", () => {
    expect(monthsBetween("2026-05-10", "2026-05-20")).toEqual(["2026-05"])
  })
})

describe("buildDashboard — I-E6-19: el panel dice lo MISMO que los informes", () => {
  const report = buildDashboard(lines, index, params)
  const pyg = buildPyg(lines, index, params)
  const cashflow = buildCashflowDirect(lines, index, params)
  const kpi = (key: string) => report.kpis.find((k) => k.key === key)!

  it("ingresos = INCN de la PyG", () => {
    expect(kpi("ingresos").cents).toBe(pyg.byEpigraphNumberCents["1"])
    expect(kpi("ingresos").cents).toBe(6_250_000)
  })

  it("resultado = A.4 = I3", () => {
    expect(kpi("resultado").cents).toBe(pyg.resultadoDelEjercicioCents)
    expect(kpi("resultado").cents).toBe(1_497_322)
  })

  it("tesorería = saldo final de 57x del cashflow", () => {
    expect(kpi("tesoreria").cents).toBe(cashflow.closingCashCents)
    expect(kpi("tesoreria").cents).toBe(2_943_920)
  })

  it("EBITDA = A.1 revirtiendo 8 y 11 = 2 390 430, la cifra de la matriz de E4", () => {
    expect(kpi("ebitda").cents).toBe(pyg.ebitdaCents)
    expect(kpi("ebitda").cents).toBe(2_390_430)
  })
})

describe("G-05 — ningún porcentaje sin base", () => {
  it("sin comparativo, `previousCents` y `deltaBps` son `null`, nunca 0 ni NaN", () => {
    const report = buildDashboard(lines, index, params)
    for (const k of report.kpis) {
      expect(k.previousCents).toBeNull()
      expect(k.deltaBps).toBeNull()
      expect(Number.isNaN(k.deltaBps as number)).toBe(false)
    }
  })

  it("con comparativo a cero, `deltaBps` sigue siendo `null` — no Infinity", () => {
    const report = buildDashboard(lines, index, params, undefined, { lines: [], label: "2025" })
    for (const k of report.kpis) {
      expect(k.deltaBps === null || Number.isFinite(k.deltaBps)).toBe(true)
    }
  })

  it("con comparativo real, `deltaBps` es un entero", () => {
    const report = buildDashboard(lines, index, params, undefined, { lines, label: "mismo periodo" })
    const ingresos = report.kpis.find((k) => k.key === "ingresos")!
    expect(ingresos.previousCents).toBe(6_250_000)
    expect(ingresos.deltaBps).toBe(0)
  })

  it("diario vacío: todo a cero y ningún NaN", () => {
    const report = buildDashboard([], index, params)
    expect(report.kpis.every((k) => k.cents === 0)).toBe(true)
    expect(report.monthly).toHaveLength(12)
    expect(report.monthly.every((m) => m.ingresosCents === 0 && m.tesoreriaCents === 0)).toBe(true)
  })
})

describe("G-06 — los documentos sin contabilizar se DECLARAN, no se suman como 0", () => {
  it("con documentos pendientes, el panel lleva el recuento y la leyenda", () => {
    const report = buildDashboard(lines, index, { ...params, unpostedDocumentCount: 3 })
    expect(report.unposted).toEqual({ count: 3, note: UNPOSTED_NOTE(3) })
    expect(report.unposted?.note).toContain("no entran en ninguna cifra")
  })

  it("sin documentos pendientes, `unposted` es `null` y no se pinta nada", () => {
    expect(buildDashboard(lines, index, params).unposted).toBeNull()
  })

  it("el recuento NO altera ninguna cifra del panel", () => {
    const sin = buildDashboard(lines, index, params)
    const con = buildDashboard(lines, index, { ...params, unpostedDocumentCount: 7 })
    expect(con.kpis.map((k) => k.cents)).toEqual(sin.kpis.map((k) => k.cents))
  })
})

describe("series mensuales y aging del panel", () => {
  it("los doce meses se imprimen, también los que no tienen movimiento", () => {
    const report = buildDashboard(lines, index, params)
    expect(report.monthly.map((m) => m.month)).toEqual(monthsBetween("2026-01-01", "2026-12-31"))
    // Enero, septiembre y diciembre no tienen flujo y aparecen igualmente.
    expect(report.monthly.find((m) => m.month === "2026-09")).toBeDefined()
  })

  it("la tesorería acumulada del último mes es el saldo final de 57x", () => {
    const report = buildDashboard(lines, index, params)
    expect(report.monthly[11].tesoreriaCents).toBe(2_943_920)
  })

  it("el aging de clientes cuadra con el saldo (I-E6-14) y declara su agrupación", () => {
    const report = buildDashboard(lines, index, params)
    expect(report.aging.clientes.checkTotalCents).toBe(0)
    expect(report.aging.proveedores.checkTotalCents).toBe(0)
    // El fixture no trae `dueDate` en ninguna línea: todo cae en SIN_VENCIMIENTO,
    // que es visible y primero, y por eso el total sigue cuadrando.
    expect(report.aging.clientes.rows[0].bucket).toBe("SIN_VENCIMIENTO")
    expect(report.aging.clientes.totalCents).toBe(7_844_900) // 4300 + 436
  })
})
