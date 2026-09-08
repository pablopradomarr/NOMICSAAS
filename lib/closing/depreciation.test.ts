/**
 * E9 · T6 — `lib/closing/depreciation.ts` (R-AM-1…10).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md) y el que sella la tarea: los
 * **ocho** casos de `docs/design/fixtures/cuadros-esperados.json`, reconstruidos
 * **byte a byte** contra el JSON que genera `build_cuadros_esperados.py` (§4.2).
 *
 * El fichero se compara entero —cuadros, sellos, líneas de baja y venta, avisos
 * y checks—: dos implementaciones independientes (Python y TypeScript) tienen
 * que dar exactamente los mismos céntimos, o el fixture no vale nada.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  accumulatedThrough,
  depreciationForPeriod,
  depreciationLines,
  depreciationSchedule,
  disposalLines,
  disposalWarnings,
  scheduleHashOf,
  totalQuotaCents,
  type AssetRevisionRef,
  type DisposalInput,
  type FixedAssetRef,
} from "@/lib/closing/depreciation"

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "cuadros-esperados.json")

type ExpectedCase = {
  id: string
  titulo: string
  asset: FixedAssetRef
  revisions: AssetRevisionRef[]
  disposal: DisposalInput | null
}
type ExpectedFile = {
  fixture: string
  epica: string
  tarea: string
  reglas: string
  cases: ExpectedCase[]
  checks: unknown[]
}

const expectedText = readFileSync(EXPECTED_PATH, "utf8")
const expected = JSON.parse(expectedText) as ExpectedFile

const asset = (over: Partial<FixedAssetRef> = {}): FixedAssetRef => ({
  id: "fa-1",
  code: "AM-1",
  name: "Equipo",
  method: "LINEAL",
  inServiceDate: "2026-01-01",
  acquisitionCostCents: 1_200_000,
  residualValueCents: 0,
  usefulLifeMonths: 12,
  assetAccountCode: "2131",
  accumulatedAccountCode: "2811",
  expenseAccountCode: "6813",
  status: "EN_USO",
  disposalDate: null,
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios
// ─────────────────────────────────────────────────────────────────────────────

describe("R-AM-2 · reparto lineal en céntimos", () => {
  it("un solo mes de vida útil: la cuota es toda la base", () => {
    const rows = depreciationSchedule(asset({ acquisitionCostCents: 999, usefulLifeMonths: 1 }))
    expect(rows).toHaveLength(1)
    expect(rows[0].quotaCents).toBe(999)
    expect(rows[0].netBookValueCents).toBe(0)
  })

  it("el residuo va a la ÚLTIMA cuota, nunca a la primera (Q-2)", () => {
    const rows = depreciationSchedule(
      asset({ acquisitionCostCents: 1_000_000, residualValueCents: 100_000, usefulLifeMonths: 7 })
    )
    expect(rows.map((r) => r.quotaCents)).toEqual([128_571, 128_571, 128_571, 128_571, 128_571, 128_571, 128_574])
    expect(totalQuotaCents(rows)).toBe(900_000)
    expect(rows[rows.length - 1].netBookValueCents).toBe(100_000)
  })

  it("R-AM-4: ninguna cuota negativa y la acumulada no supera la base", () => {
    const rows = depreciationSchedule(asset({ acquisitionCostCents: 100, residualValueCents: 100, usefulLifeMonths: 4 }))
    expect(rows.every((r) => r.quotaCents >= 0)).toBe(true)
    expect(totalQuotaCents(rows)).toBe(0)
  })

  it("O-22: base menor que la vida útil ⇒ cuotas de 0 y la última con todo", () => {
    const rows = depreciationSchedule(asset({ acquisitionCostCents: 20, usefulLifeMonths: 36 }))
    expect(rows.filter((r) => r.quotaCents === 0)).toHaveLength(35)
    expect(rows[35].quotaCents).toBe(20)
    expect(totalQuotaCents(rows)).toBe(20)
  })
})

describe("R-AM-3 / R-AM-8 · mes entero", () => {
  it("empieza el mes de la puesta en servicio, sea qué día sea", () => {
    const rows = depreciationSchedule(asset({ inServiceDate: "2026-03-31", usefulLifeMonths: 3 }))
    expect(rows.map((r) => r.period)).toEqual(["2026-03", "2026-04", "2026-05"])
    expect(rows[0].from).toBe("2026-03-01")
    expect(rows[0].to).toBe("2026-03-31")
  })

  it("O-30: alta el 31/01 y baja el 01/02 amortizan DOS meses", () => {
    const rows = depreciationSchedule(asset({ inServiceDate: "2026-01-31", disposalDate: "2026-02-01", usefulLifeMonths: 24 }))
    expect(rows.map((r) => r.period)).toEqual(["2026-01", "2026-02"])
  })

  it("febrero bisiesto se acota bien", () => {
    const rows = depreciationSchedule(asset({ inServiceDate: "2028-02-15", usefulLifeMonths: 1 }))
    expect(rows[0].to).toBe("2028-02-29")
  })
})

describe("R-AM-5 · revisión prospectiva (NRV 22ª)", () => {
  it("el pasado no se toca y el VNC se reparte entre la vida residual", () => {
    const a = asset({ acquisitionCostCents: 1_200_000, usefulLifeMonths: 12 })
    const sin = depreciationSchedule(a)
    const con = depreciationSchedule(a, [{ effectiveFrom: "2026-07-01", newUsefulLifeMonths: 24 }])
    expect(con.slice(0, 6).map((r) => r.quotaCents)).toEqual(sin.slice(0, 6).map((r) => r.quotaCents))
    expect(con).toHaveLength(24)
    expect(totalQuotaCents(con)).toBe(1_200_000)
    expect(scheduleHashOf(con)).not.toBe(scheduleHashOf(sin))
  })

  it("I-E9-4 (O-28): Σ cuotas = coste + mejoras − residual vigente", () => {
    const rows = depreciationSchedule(asset({ acquisitionCostCents: 1_000_000, usefulLifeMonths: 10 }), [
      { effectiveFrom: "2026-04-01", addedCostCents: 250_000 },
      { effectiveFrom: "2026-08-01", newResidualValueCents: 30_000 },
    ])
    expect(totalQuotaCents(rows)).toBe(1_000_000 + 250_000 - 30_000)
  })

  it("una vida revisada ya agotada dota el pendiente en el mes de la revisión", () => {
    const rows = depreciationSchedule(asset({ acquisitionCostCents: 1_200_000, usefulLifeMonths: 24 }), [
      { effectiveFrom: "2026-07-01", newUsefulLifeMonths: 6 },
    ])
    expect(rows).toHaveLength(7)
    expect(totalQuotaCents(rows)).toBe(1_200_000)
  })
})

describe("D2.1 · sólo LINEAL se contabiliza", () => {
  it("rechaza los métodos degresivos en vez de aproximarlos", () => {
    for (const method of ["SUMA_DIGITOS", "PORCENTAJE_CONSTANTE", "UNIDADES_PRODUCCION"] as const) {
      expect(() => depreciationSchedule(asset({ method }))).toThrow(/no resuelto/)
    }
  })

  it("rechaza vida útil y coste imposibles", () => {
    expect(() => depreciationSchedule(asset({ usefulLifeMonths: 0 }))).toThrow()
    expect(() => depreciationSchedule(asset({ acquisitionCostCents: -1 }))).toThrow()
    expect(() => depreciationSchedule(asset({ residualValueCents: -1 }))).toThrow()
  })
})

describe("líneas del asiento", () => {
  it("O-19: la dotación lleva el activo en la línea", () => {
    const a = asset({ acquisitionCostCents: 1_200_000, usefulLifeMonths: 12, projectId: "p-1", costCenterId: "cc-1" })
    const rows = depreciationSchedule(a)
    const out = depreciationLines(a, rows[0])
    if (!out.ok) throw new Error("esperaba líneas")
    expect(out.value.map((l) => [l.accountCode, l.debitCents, l.creditCents, l.fixedAssetId])).toEqual([
      ["6813", 100_000, 0, a.id],
      ["2811", 0, 100_000, a.id],
    ])
    expect(out.value[0].projectId).toBe("p-1")
  })

  it("R-REC-8: una cuota de 0 no produce asiento", () => {
    const a = asset({ acquisitionCostCents: 20, usefulLifeMonths: 36 })
    const rows = depreciationSchedule(a)
    const out = depreciationLines(a, rows[0])
    if (out.ok) throw new Error("esperaba error")
    expect(out.errors[0].check).toBe("R-REC-8")
  })

  it("R-AM-7: la contrapartida de la venta NUNCA es 430", () => {
    const a = asset({ acquisitionCostCents: 1_000_000, usefulLifeMonths: 25, disposalDate: "2027-04-20" })
    const rows = depreciationSchedule(a)
    const out = disposalLines(a, rows, {
      kind: "VENTA",
      date: "2027-04-20",
      priceCents: 500_000,
      vatCents: 105_000,
      receivableAccountCode: "430",
      vatAccountCode: "477",
      gainAccountCode: "771",
      lossAccountCode: "671",
    })
    if (out.ok) throw new Error("esperaba error")
    expect(out.errors[0].check).toBe("R-AM-7")
  })

  it("criterio 7: baja con 2811 / 671 / 2131 y venta con 543 y beneficio en 771", () => {
    const a = asset({ acquisitionCostCents: 1_000_000, usefulLifeMonths: 25, disposalDate: "2027-04-20" })
    const rows = depreciationSchedule(a)
    expect(accumulatedThrough(rows, "2027-04")).toBe(640_000)

    const baja = disposalLines(a, rows, { kind: "BAJA", date: "2027-04-20", lossAccountCode: "671" })
    if (!baja.ok) throw new Error("esperaba líneas")
    expect(baja.value.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
      ["2811", 640_000, 0],
      ["671", 360_000, 0],
      ["2131", 0, 1_000_000],
    ])

    const venta = disposalLines(a, rows, {
      kind: "VENTA",
      date: "2027-04-20",
      priceCents: 500_000,
      vatCents: 105_000,
      receivableAccountCode: "543",
      vatAccountCode: "477",
      gainAccountCode: "771",
      lossAccountCode: "671",
    })
    if (!venta.ok) throw new Error("esperaba líneas")
    expect(venta.value.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
      ["543", 605_000, 0],
      ["2811", 640_000, 0],
      ["2131", 0, 1_000_000],
      ["477", 0, 105_000],
      ["771", 0, 140_000],
    ])
    const debe = venta.value.reduce((acc, l) => acc + l.debitCents, 0)
    const haber = venta.value.reduce((acc, l) => acc + l.creditCents, 0)
    expect(debe).toBe(haber)
  })

  it("venta con pérdida: el resultado va a 671", () => {
    const a = asset({ acquisitionCostCents: 1_000_000, usefulLifeMonths: 25, disposalDate: "2027-04-20" })
    const rows = depreciationSchedule(a)
    const venta = disposalLines(a, rows, {
      kind: "VENTA",
      date: "2027-04-20",
      priceCents: 100_000,
      vatCents: 21_000,
      receivableAccountCode: "543",
      vatAccountCode: "477",
      gainAccountCode: "771",
      lossAccountCode: "671",
    })
    if (!venta.ok) throw new Error("esperaba líneas")
    expect(venta.value.find((l) => l.accountCode === "671")?.debitCents).toBe(260_000)
  })

  it("R-AM-7: el aviso del art. 110 LIVA sale cuando toca, y no cuando no", () => {
    const bien = asset({ inServiceDate: "2026-01-01", isCapitalGood: true })
    const disposal: DisposalInput = {
      kind: "VENTA",
      date: "2027-04-20",
      receivableAccountCode: "543",
      lossAccountCode: "671",
    }
    expect(disposalWarnings(bien, disposal).map((w) => w.code)).toEqual(["ART_110_LIVA_BIEN_INVERSION"])
    expect(disposalWarnings(bien, { ...disposal, date: "2032-04-20" })).toEqual([])
    expect(disposalWarnings(asset({ isCapitalGood: false }), disposal)).toEqual([])
    const edificio = asset({ inServiceDate: "2026-01-01", isCapitalGood: true, isBuilding: true })
    expect(disposalWarnings(edificio, disposal).map((w) => w.code)).toEqual([
      "ART_110_LIVA_BIEN_INVERSION",
      "ART_20_UNO_22_EDIFICACION",
    ])
  })
})

describe("sello del cuadro", () => {
  it("es estable y cambia con el cuadro (I-E9-3)", () => {
    const a = asset()
    expect(scheduleHashOf(depreciationSchedule(a))).toBe(scheduleHashOf(depreciationSchedule(a)))
    expect(scheduleHashOf(depreciationSchedule(a))).toMatch(/^[0-9a-f]{64}$/)
    expect(scheduleHashOf(depreciationSchedule(a))).not.toBe(
      scheduleHashOf(depreciationSchedule(asset({ acquisitionCostCents: 1_200_001 })))
    )
  })

  it("depreciationForPeriod no interpola", () => {
    const rows = depreciationSchedule(asset({ usefulLifeMonths: 3 }))
    expect(depreciationForPeriod(rows, "2026-02")?.quotaCents).toBe(400_000)
    expect(depreciationForPeriod(rows, "2027-02")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El test que sella la tarea: los ocho casos, byte a byte
// ─────────────────────────────────────────────────────────────────────────────

type Check = { id: string; expected: number; actual: number; status: string }

const checkOf = (id: string, expectedValue: number, actual: number): Check => ({
  id,
  expected: expectedValue,
  actual,
  status: expectedValue === actual ? "PASS" : "FAIL",
})

describe("cuadros-esperados.json · los ocho casos del diseño", () => {
  it("reproduce el fichero byte a byte", () => {
    const cases = expected.cases.map((c) => {
      const rows = depreciationSchedule(c.asset, c.revisions)
      const added = c.revisions.reduce((acc, r) => acc + (r.addedCostCents ?? 0), 0)
      const residual = [...c.revisions]
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
        .reduce<number>(
          (acc, r) => (r.newResidualValueCents !== null && r.newResidualValueCents !== undefined ? r.newResidualValueCents : acc),
          c.asset.residualValueCents
        )
      const lines = c.disposal ? disposalLines(c.asset, rows, c.disposal) : null
      if (lines && !lines.ok) throw new Error(`el caso ${c.id} no produjo líneas de baja`)
      return {
        id: c.id,
        titulo: c.titulo,
        asset: c.asset,
        revisions: c.revisions,
        rows,
        totals: {
          quotaCents: totalQuotaCents(rows),
          rowCount: rows.length,
          zeroQuotaRows: rows.filter((r) => r.quotaCents === 0).length,
          lastQuotaCents: rows.length > 0 ? rows[rows.length - 1].quotaCents : 0,
          amortizableBaseCents: c.asset.acquisitionCostCents + added - residual,
        },
        scheduleHash: scheduleHashOf(rows),
        disposal: c.disposal,
        disposalLines: lines?.ok ? lines.value : [],
        disposalWarnings: c.disposal ? disposalWarnings(c.asset, c.disposal) : [],
      }
    })

    const checks: Check[] = []
    for (const c of cases) {
      if (!c.asset.disposalDate) {
        checks.push(checkOf(`I-E9-4/${c.id}`, c.totals.amortizableBaseCents, c.totals.quotaCents))
      }
      checks.push(checkOf(`R-AM-4/${c.id}`, 0, c.rows.filter((r) => r.quotaCents < 0).length))
      if (c.disposalLines.length > 0) {
        const debe = c.disposalLines.reduce((acc, l) => acc + l.debitCents, 0)
        const haber = c.disposalLines.reduce((acc, l) => acc + l.creditCents, 0)
        checks.push(checkOf(`I1/${c.id}`, debe, haber))
      }
    }
    const c2 = cases.find((c) => c.id === "C2")
    checks.push(checkOf("Q-2/ultima-cuota-128574", 128_574, c2?.totals.lastQuotaCents ?? 0))
    const c7 = cases.find((c) => c.id === "C7")
    checks.push(checkOf("criterio-7/acumulada-640000", 640_000, accumulatedThrough(c7?.rows ?? [], "2027-04")))
    checks.push(
      checkOf("criterio-7/beneficio-140000", 140_000, c7?.disposalLines.find((l) => l.accountCode === "771")?.creditCents ?? 0)
    )
    const c8 = cases.find((c) => c.id === "C8")
    checks.push(checkOf("O-22/cuota-cero", 35, c8?.totals.zeroQuotaRows ?? 0))

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
