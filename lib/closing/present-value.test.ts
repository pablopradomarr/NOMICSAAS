/**
 * E9 · T9 — `lib/closing/present-value.ts` (R-VA-1…6).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md) y el que sella la tarea:
 * los siete casos de `docs/design/fixtures/valor-actual-esperado.json`,
 * reconstruidos **byte a byte** contra el JSON que genera
 * `build_valor_actual_esperado.py` (§4.7), más el **caso A** del criterio 22.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { FixedAssetRef } from "@/lib/closing/depreciation"
import {
  annualEquivalentMicroBps,
  compoundFactorScaled,
  defaultPvMaterialityCents,
  discountCents,
  implicitInterestLines,
  implicitInterestSchedule,
  lateRecognitionPlan,
  presentValueCents,
  PV_SCALE,
  requiresPresentValue,
  totalImplicitInterestCents,
  TEMPLATE_AJUSTE_EJERCICIOS_ANTERIORES,
  type ImplicitInterestRow,
} from "@/lib/closing/present-value"

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "valor-actual-esperado.json")

type ExpectedCase = {
  id: string
  titulo: string
  input: {
    nominalCents: number
    monthlyRateMicroBps: number
    months: number
    firstPeriod: string
    side: "PASIVO" | "ACTIVO"
    materialityCents: number
  }
  presentValueCents: number
  discountCents: number
  annualEquivalentMicroBps: number
  requiresPresentValue: boolean
  interestAccount: string
  rows: ImplicitInterestRow[]
  totals: { rowCount: number; interestCents: number; finalCarryingCents: number }
}

type ExpectedFile = {
  fixture: string
  escala: number
  cases: ExpectedCase[]
  casoA: {
    assetCostCents: number
    usefulLifeMonths: number
    postedMonths: number
    discountCents: number
    correctedCostCents: number
    excessDepreciationCents: number
    accruedInterestCents: number
  }
  checks: { id: string; status: string }[]
}

const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as ExpectedFile

// ─────────────────────────────────────────────────────────────────────────────
// Byte a byte contra el fixture Python
// ─────────────────────────────────────────────────────────────────────────────

describe("R-VA-4 · el fixture Python, byte a byte", () => {
  it("la escala del punto fijo es la misma en los dos lados", () => {
    expect(PV_SCALE).toBe(BigInt(expected.escala))
  })

  it("el propio fixture tiene sus cinco comprobaciones en PASS", () => {
    expect(expected.checks.map((c) => c.status)).toEqual(expected.checks.map(() => "PASS"))
  })

  for (const c of expected.cases) {
    describe(`${c.id} · ${c.titulo}`, () => {
      const { nominalCents, monthlyRateMicroBps, months, firstPeriod } = c.input

      it("el valor actual y el descuento coinciden", () => {
        const pv = presentValueCents(nominalCents, monthlyRateMicroBps, months)
        expect(pv).toBe(c.presentValueCents)
        expect(discountCents(nominalCents, pv)).toBe(c.discountCents)
      })

      it("el equivalente anual coincide", () => {
        expect(annualEquivalentMicroBps(monthlyRateMicroBps)).toBe(c.annualEquivalentMicroBps)
      })

      it("el cuadro de interés implícito coincide fila a fila", () => {
        const rows = implicitInterestSchedule({
          nominalCents,
          presentValueCents: c.presentValueCents,
          months,
          monthlyRateMicroBps,
          firstPeriod,
        })
        expect(rows).toEqual(c.rows)
        expect(rows).toHaveLength(c.totals.rowCount)
      })

      it("I-E9-19: Σ intereses = descuento y a vencimiento vale el nominal", () => {
        const rows = implicitInterestSchedule({
          nominalCents,
          presentValueCents: c.presentValueCents,
          months,
          monthlyRateMicroBps,
          firstPeriod,
        })
        expect(totalImplicitInterestCents(rows)).toBe(c.discountCents)
        expect(rows[rows.length - 1].carryingCents).toBe(nominalCents)
      })

      it("la decisión de descontar coincide con la del fixture (R-VA-2)", () => {
        expect(
          requiresPresentValue({
            months,
            nominalCents,
            presentValueCents: c.presentValueCents,
            materialityCents: c.input.materialityCents,
          })
        ).toBe(c.requiresPresentValue)
      })
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios y bordes
// ─────────────────────────────────────────────────────────────────────────────

describe("casos obligatorios", () => {
  it("nominal 0 da valor actual 0 y cuadro de ceros", () => {
    expect(presentValueCents(0, 48_675_506, 24)).toBe(0)
    const rows = implicitInterestSchedule({
      nominalCents: 0,
      presentValueCents: 0,
      months: 3,
      monthlyRateMicroBps: 48_675_506,
      firstPeriod: "2026-01",
    })
    expect(totalImplicitInterestCents(rows)).toBe(0)
  })

  it("tipo 0 deja el factor en la unidad y el valor actual en el nominal", () => {
    expect(compoundFactorScaled(0, 36)).toBe(PV_SCALE)
    expect(presentValueCents(1_234_567, 0, 36)).toBe(1_234_567)
  })

  it("cero meses no descuenta nada", () => {
    expect(presentValueCents(500_000, 48_675_506, 0)).toBe(500_000)
  })

  it("rechaza entradas que no son enteros no negativos", () => {
    expect(() => presentValueCents(-1, 10, 12)).toThrow(TypeError)
    expect(() => compoundFactorScaled(-1, 12)).toThrow(TypeError)
    expect(() => implicitInterestSchedule({ nominalCents: 10, presentValueCents: 9, months: 0, monthlyRateMicroBps: 1, firstPeriod: "2026-01" })).toThrow(
      TypeError
    )
    expect(() =>
      implicitInterestSchedule({ nominalCents: 10, presentValueCents: 9, months: 2, monthlyRateMicroBps: 1, firstPeriod: "2026-13" })
    ).toThrow(TypeError)
  })

  it("el cuadro cruza el fin de año sin saltarse un mes", () => {
    const rows = implicitInterestSchedule({
      nominalCents: 1_000_000,
      presentValueCents: 950_000,
      months: 3,
      monthlyRateMicroBps: 17_000_000,
      firstPeriod: "2026-11",
    })
    expect(rows.map((r) => r.period)).toEqual(["2026-11", "2026-12", "2027-01"])
  })

  it("un céntimo de descuento acaba entero en la última cuota (redondeo)", () => {
    const rows = implicitInterestSchedule({
      nominalCents: 1_000_001,
      presentValueCents: 1_000_000,
      months: 4,
      monthlyRateMicroBps: 1,
      firstPeriod: "2026-01",
    })
    expect(rows.map((r) => r.interestCents)).toEqual([0, 0, 0, 1])
    expect(rows[3].carryingCents).toBe(1_000_001)
  })
})

describe("R-VA-2 · materialidad derivada", () => {
  it("es el menor entre el 0,5 % del activo del año anterior y el tope declarado", () => {
    expect(defaultPvMaterialityCents(200_000_000, 5_000_000)).toBe(1_000_000)
    expect(defaultPvMaterialityCents(200_000_000, 500_000)).toBe(500_000)
    expect(defaultPvMaterialityCents(0, 500_000)).toBe(0)
  })

  it("doce meses justos NO se descuentan: la frontera es > 12", () => {
    expect(requiresPresentValue({ months: 12, nominalCents: 1_000_000, presentValueCents: 900_000, materialityCents: 1 })).toBe(false)
    expect(requiresPresentValue({ months: 13, nominalCents: 1_000_000, presentValueCents: 900_000, materialityCents: 1 })).toBe(true)
  })
})

describe("R-VA-5 (O-3) · el lado del interés", () => {
  const row: ImplicitInterestRow = { period: "2026-03", interestCents: 4_000, carryingCents: 900_000 }

  it("el lado PASIVO carga 662", () => {
    const lines = implicitInterestLines(row, "PASIVO", "173")
    expect(lines[0]).toMatchObject({ accountKey: "INTERESES_DEUDAS", debitCents: 4_000, analyticType: "FINANCIERO" })
    expect(lines[1]).toMatchObject({ accountCode: "173", creditCents: 4_000 })
  })

  it("el lado ACTIVO abona 762: un 253 descontado devenga INGRESO", () => {
    const lines = implicitInterestLines(row, "ACTIVO", "253")
    expect(lines[0]).toMatchObject({ accountCode: "253", debitCents: 4_000 })
    expect(lines[1]).toMatchObject({ accountKey: "INGRESOS_CREDITOS", creditCents: 4_000, analyticType: "FINANCIERO" })
  })

  it("un interés de cero céntimos no genera asiento", () => {
    expect(implicitInterestLines({ ...row, interestCents: 0 }, "PASIVO", "173")).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Criterio 22 · los tres casos del reconocimiento tardío
// ─────────────────────────────────────────────────────────────────────────────

const ASSET: FixedAssetRef = {
  id: "fa-1",
  code: "IM-001",
  method: "LINEAL",
  inServiceDate: "2026-03-01",
  acquisitionCostCents: 10_000_000,
  residualValueCents: 0,
  usefulLifeMonths: 60,
  assetAccountCode: "2131",
  accumulatedAccountCode: "2813",
  expenseAccountCode: "6813",
}

describe("criterio 22 · caso A (ejercicio en curso)", () => {
  const plan = lateRecognitionPlan({
    currentFiscalYear: true,
    fixedAsset: true,
    debtAccountCode: "173",
    counterpartyId: "cp-1",
    nominalCents: 10_000_000,
    monthlyRateMicroBps: 48_675_506,
    months: 24,
    refDate: "2026-12-31",
    firstPeriod: "2026-03",
    asset: ASSET,
    postedThroughPeriod: "2026-12",
  })

  it("es el caso A y va por T-31", () => {
    expect(plan.case).toBe("A")
    expect(plan.templateCode).toBe("T-31")
  })

  it("valor actual 8 899 964 y descuento 1 100 036, como el fixture", () => {
    expect(plan.presentValueCents).toBe(expected.cases[0].presentValueCents)
    expect(plan.discountCents).toBe(expected.casoA.discountCents)
  })

  it("reduce el coste: 173 (D) 1 100 036 / 2131 (H) 1 100 036", () => {
    expect(plan.lines[0]).toMatchObject({ accountCode: "173", debitCents: 1_100_036 })
    expect(plan.lines[1]).toMatchObject({ accountCode: "2131", creditCents: 1_100_036 })
  })

  it("revierte el exceso dotado de 183 340 (2813 D / 6813 H) tras diez meses", () => {
    expect(plan.excessDepreciationCents).toBe(expected.casoA.excessDepreciationCents)
    expect(plan.excessDepreciationCents).toBe(183_340)
    expect(plan.lines[2]).toMatchObject({ accountCode: "2813", debitCents: 183_340 })
    expect(plan.lines[3]).toMatchObject({ accountCode: "6813", creditCents: 183_340 })
  })

  it("recalcula el cuadro desde la puesta en servicio y NO crea AssetRevision", () => {
    expect(plan.recalculatedSchedule[0].period).toBe("2026-03")
    expect(plan.recalculatedSchedule).toHaveLength(60)
    expect(plan.recalculatedSchedule.reduce((a, r) => a + r.quotaCents, 0)).toBe(10_000_000 - 1_100_036)
    expect(plan.notas.join(" ")).toContain("No se crea AssetRevision")
  })

  it("devenga el interés implícito de los diez meses contra 662, y el asiento cuadra", () => {
    expect(plan.accruedInterestCents).toBe(expected.casoA.accruedInterestCents)
    const debe = plan.lines.reduce((a, l) => a + l.debitCents, 0)
    const haber = plan.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debe).toBe(haber)
  })

  it("I-E9-5 no queda en FAIL: la acumulada corregida no supera la base amortizable", () => {
    const acumuladaCorregida = plan.recalculatedSchedule
      .filter((r) => r.period <= "2026-12")
      .reduce((a, r) => a + r.quotaCents, 0)
    expect(acumuladaCorregida).toBeLessThanOrEqual(10_000_000 - 1_100_036)
  })
})

describe("criterio 22 · casos B y C", () => {
  const base = {
    fixedAsset: true,
    debtAccountCode: "173",
    nominalCents: 10_000_000,
    monthlyRateMicroBps: 48_675_506,
    months: 24,
    refDate: "2026-12-31",
    firstPeriod: "2026-03",
  }

  it("caso B: ejercicio cerrado ⇒ T-22 contra 113", () => {
    const plan = lateRecognitionPlan({ ...base, currentFiscalYear: false })
    expect(plan.case).toBe("B")
    expect(plan.templateCode).toBe(TEMPLATE_AJUSTE_EJERCICIOS_ANTERIORES)
    expect(plan.lines[1].accountKey).toBe("RESERVAS_VOLUNTARIAS")
    expect(plan.notas.join(" ")).toContain("113")
  })

  it("caso C: origen no inmovilizado del mismo ejercicio ⇒ a su cuenta de gasto", () => {
    const plan = lateRecognitionPlan({
      ...base,
      currentFiscalYear: true,
      fixedAsset: false,
      originalPnlAccountCode: "629",
    })
    expect(plan.case).toBe("C")
    expect(plan.lines[1].accountCode).toBe("629")
  })

  it("el caso A sin activo es un error de programación, no un asiento silencioso", () => {
    expect(() => lateRecognitionPlan({ ...base, currentFiscalYear: true })).toThrow(TypeError)
  })
})
