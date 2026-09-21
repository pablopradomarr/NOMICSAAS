/**
 * E12 · T19 — **byte a byte contra el fixture sellado v1.4**
 * (`docs/design/fixtures/presupuesto-horas-esperado.v1.4.json`).
 *
 * Lo que aquí se comprueba es lo que la enmienda a ADR-0018 D2 promete y lo que
 * la deuda 11–13 de E12 entrega:
 *
 *  · el **CAPEX entra en el `budgetHash`**, y retirarlo lo cambia;
 *  · una versión **sin** CAPEX sella exactamente el hash de E10 — que es lo que
 *    permite que las fixtures v1.0–v1.3 queden congeladas y sigan siendo
 *    evidencia de lo que se firmó;
 *  · la **dotación derivada** de las inversiones coincide con la del generador
 *    de Python, que la calcula por otro camino y sin importar `lib/`;
 *  · el **desglose mes a mes** suma el acumulado, celda a celda;
 *  · la **descomposición volumen/precio** coincide, y volumen + precio = total.
 *
 * Ninguna cifra esperada sale de llamar al módulo que se prueba: todas vienen
 * del JSON sellado o son literales escritos a mano (regla 7 de §7.3).
 */

import { describe, expect, it } from "vitest"

import { capexDepreciationForFiscalYear, capexDepreciationTotal } from "@/lib/budget/capex"
import { budgetHash, canonicalBudgetForm, composeBudget } from "@/lib/budget/hash"
import { volumePriceSplit } from "@/lib/budget/variance"
import {
  FY_END,
  FY_MONTHS,
  FY_START,
  capexCellOf,
  expected,
  versionsFromFixture,
} from "@/lib/budget/fixture.test-support"

const versions = versionsFromFixture()
const base = versions.find((v) => v.code === "2026-BASE")!

describe("v1.4 · el fixture está sellado con CAPEX", () => {
  it("es la v1.4 y las dos versiones traen inversiones previstas", () => {
    expect(expected.budgets.map((b) => b.capexLineCount)).toEqual([3, 1])
    expect(expected.budgetCapexLinesByVersion["2026-BASE"]).toHaveLength(3)
    expect(expected.budgetCapexLinesByVersion["2026-REV1"]).toHaveLength(1)
  })

  it("las líneas del fixture llegan íntegras al motor", () => {
    expect(base.capex).toHaveLength(3)
    // El orden es el de la lista del generador, no el canónico: lo que importa
    // es que las tres lleguen enteras, con su método y su vida útil.
    expect(base.capex!.map((c) => [c.accountCode, c.amountCents, c.usefulLifeMonths, c.startsAt])).toEqual([
      ["213", 3_000_000, 60, "MES_DE_ALTA"],
      ["217", 1_000_000, 7, "MES_DE_ALTA"],
      ["213", 600_000, 36, "MES_SIGUIENTE"],
    ])
  })
})

describe("ADR-0018 D2 ENMENDADA · el CAPEX está DENTRO del budgetHash", () => {
  it("el hash que sella el motor es el del fixture, para las dos versiones", () => {
    for (const version of versions) {
      const header = expected.budgets.find((b) => b.code === version.code)!
      expect(budgetHash(version, expected.marginConfigHash), version.code).toBe(header.budgetHash)
    }
  })

  it("retirar las líneas de CAPEX CAMBIA el hash: no es decorativo", () => {
    const sinCapex = { ...base, capex: [] }
    expect(budgetHash(sinCapex, expected.marginConfigHash)).not.toBe(
      budgetHash(base, expected.marginConfigHash)
    )
  })

  it("mover un solo céntimo de una inversión CAMBIA el hash", () => {
    const tocado = {
      ...base,
      capex: base.capex!.map((c, i) => (i === 0 ? { ...c, amountCents: c.amountCents + 1 } : c)),
    }
    expect(budgetHash(tocado, expected.marginConfigHash)).not.toBe(budgetHash(base, expected.marginConfigHash))
  })

  it("cambiar la vida útil sin tocar el importe CAMBIA el hash", () => {
    // Es la manipulación sutil: el balance presupuestado no se mueve y el EBIT
    // sí, porque la dotación anual pasa a ser otra.
    const tocado = {
      ...base,
      capex: base.capex!.map((c, i) => (i === 0 ? { ...c, usefulLifeMonths: c.usefulLifeMonths + 12 } : c)),
    }
    expect(budgetHash(tocado, expected.marginConfigHash)).not.toBe(budgetHash(base, expected.marginConfigHash))
  })

  it("una versión SIN CAPEX produce la forma canónica de E10, sin bloque vacío", () => {
    // La compatibilidad hacia atrás no es cortesía: es lo que hace que los
    // presupuestos ya sellados en E10 no cambien de hash y que I-E10-6 no dé
    // FAIL sobre datos íntegros el día del despliegue.
    const sinCapex = { ...base, capex: [] }
    const forma = canonicalBudgetForm(sinCapex, expected.marginConfigHash)
    expect(forma).not.toContain("∅CAPEX")
    const sinCampo = { ...base }
    delete (sinCampo as { capex?: unknown }).capex
    expect(canonicalBudgetForm(sinCampo, expected.marginConfigHash)).toBe(forma)
  })

  it("el bloque de CAPEX va DESPUÉS del de horas, y una sola vez", () => {
    const forma = canonicalBudgetForm(base, expected.marginConfigHash)
    expect(forma.indexOf("∅CAPEX")).toBeGreaterThan(forma.indexOf("∅HORAS"))
    expect(forma.split("∅CAPEX")).toHaveLength(2)
  })
})

describe("La versión EFECTIVA compone el CAPEX por el mes de alta (O-E10-9)", () => {
  const composed = composeBudget(versions, FY_MONTHS)

  it("las tres líneas efectivas son las del fixture, en su orden canónico", () => {
    expect(composed.effective.capex?.map((c) => [c.month, c.dimension.code, c.amountCents])).toEqual(
      expected.budgetCapexLines.map((c) => [c.month, c.dimensionCode, c.amountCents])
    )
  })

  it("la REV1 sustituye la alta de diciembre: 900.000 c, no 600.000 c", () => {
    const diciembre = composed.effective.capex!.filter((c) => c.month === "2026-12-01")
    expect(diciembre).toHaveLength(1)
    expect(diciembre[0]!.amountCents).toBe(900_000)
    // Y la de abril, que la REV1 no repite, SIGUE ahí: lo que se sustituye es
    // la decisión de invertir de los meses que la revisión cubre.
    expect(composed.effective.capex!.some((c) => c.month === "2026-04-01")).toBe(true)
  })
})

describe("Q-4 · la dotación derivada coincide con la de Python, céntimo a céntimo", () => {
  const cells = expected.budgetCapexLines.map(capexCellOf)
  const dotations = capexDepreciationForFiscalYear(cells, FY_START, FY_END)

  it("el total del ejercicio es el del fixture", () => {
    expect(capexDepreciationTotal(dotations)).toBe(expected.capexDepreciation.totalCents)
  })

  it("mes a mes y dimensión a dimensión, la misma lista", () => {
    expect(dotations.map((d) => ({ month: d.month, dimensionCode: d.dimension.code, amountCents: d.amountCents }))).toEqual(
      expected.capexDepreciation.byMonthAndDimension
    )
  })

  it("y el agregado por mes también", () => {
    const byMonth: Record<string, number> = {}
    for (const d of dotations) byMonth[d.month] = (byMonth[d.month] ?? 0) + d.amountCents
    expect(byMonth).toEqual(expected.capexDepreciation.byMonthCents)
  })

  it("el ejemplo literal de Q-4 está dentro: 450.000 c de abril a diciembre", () => {
    const abril = dotations.filter((d) => d.dimension.code === "CC-OPS" && d.month >= "2026-04")
    expect(abril.reduce((a, d) => a + d.amountCents, 0)).toBe(450_000)
  })
})

describe("Deuda 12 · el desglose mes a mes suma el acumulado, celda a celda", () => {
  it("la Σ de los doce meses es la matriz anual, en real y en presupuesto", () => {
    const descuadres: string[] = []
    for (const [level, columns] of Object.entries(expected.varianceByMonthCents)) {
      for (const [column, points] of Object.entries(columns)) {
        const real = points.reduce((a, p) => a + p.actualCents, 0)
        const ppto = points.reduce((a, p) => a + p.budgetCents, 0)
        if (real !== expected.realMatrixCents[level]![column]!) descuadres.push(`${level}/${column}/real`)
        if (ppto !== expected.budgetMatrixCents[level]![column]!) descuadres.push(`${level}/${column}/ppto`)
      }
    }
    expect(descuadres).toEqual([])
  })

  it("cada serie tiene los DOCE meses: un mes sin movimiento sale a 0 y no se omite", () => {
    for (const columns of Object.values(expected.varianceByMonthCents)) {
      for (const points of Object.values(columns)) {
        expect(points.map((p) => p.month)).toEqual(FY_MONTHS)
      }
    }
  })

  it("`varianceCents` de cada punto es `real − presupuesto`, exacto", () => {
    for (const columns of Object.values(expected.varianceByMonthCents)) {
      for (const points of Object.values(columns)) {
        for (const p of points) expect(p.varianceCents).toBe(p.actualCents - p.budgetCents)
      }
    }
  })
})

describe("Q-6 / D6 · volumen y precio, contra el fixture", () => {
  it("el motor reproduce las tres filas del fixture", () => {
    for (const row of expected.volumePrice) {
      const budgetCents = expected.budgetMatrixCents["INGRESOS"]![row.column]!
      const actualCents = expected.realMatrixCents["INGRESOS"]![row.column]!
      const split = volumePriceSplit({
        budgetQuantity: row.budgetQuantity,
        actualQuantity: row.actualQuantity,
        budgetCents,
        actualCents,
      })
      expect({ ...split }, row.column).toEqual({
        totalCents: row.totalCents,
        volumeCents: row.volumeCents,
        priceCents: row.priceCents,
        allVolume: row.allVolume,
        notMeasurable: row.notMeasurable,
      })
    }
  })

  it("volumen + precio = total en TODAS las filas, tolerancia 0", () => {
    for (const row of expected.volumePrice) {
      if (row.notMeasurable) continue
      expect(row.volumeCents + row.priceCents, row.column).toBe(row.totalCents)
    }
  })
})
