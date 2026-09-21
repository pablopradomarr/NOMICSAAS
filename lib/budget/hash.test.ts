/**
 * E10 · T7 — `lib/budget/hash.ts`.
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md): vacío, un registro,
 * importes negativos, fechas límite y redondeo. Y el que sella la tarea: los
 * dos `budgetHash` del fixture, **byte a byte** contra
 * `docs/design/fixtures/presupuesto-horas-esperado.v1.4.json`.
 */

import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  budgetHash,
  budgetSignAccepted,
  budgetSignOffenders,
  canonicalBudgetForm,
  checkBudgetSign,
  composeBudget,
  detectInvertedSignConvention,
  monthsWithoutBudget,
} from "@/lib/budget/hash"
import type { BudgetCell, BudgetHoursCell, BudgetVersion } from "@/lib/budget/types"
import { fiscalYearMonths } from "@/lib/budget/types"
import { FY_END, FY_MONTHS, FY_START, expected, versionsFromFixture } from "@/lib/budget/fixture.test-support"

const PROJECT = { kind: "PROJECT" as const, id: "p-1", code: "P-01", businessLineCode: "BL-CONS" }
const CECO = { kind: "COST_CENTER" as const, id: "cc-ga", code: "CC-GA" }

const cell = (over: Partial<BudgetCell> = {}): BudgetCell => ({
  month: "2026-03-01",
  accountCode: "705",
  dimension: PROJECT,
  analyticType: "INGRESO_DIRECTO",
  marginLevel: "INGRESOS",
  amountCents: 100_000,
  signException: false,
  ...over,
})

const version = (over: Partial<BudgetVersion> = {}): BudgetVersion => ({
  id: "b-1",
  code: "2026-BASE",
  scenario: "BASE",
  revision: 0,
  status: "VIGENTE",
  fiscalYearId: "fy-2026",
  fiscalYearStart: FY_START,
  fiscalYearEnd: FY_END,
  validFrom: FY_START,
  validTo: null,
  partialFrom: null,
  cells: [],
  hours: [],
  ...over,
})

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex")

describe("forma canónica y budgetHash", () => {
  it("caso vacío: sólo la cabecera, y el hash es el de esa cabecera", () => {
    const form = canonicalBudgetForm(version(), "mch")
    expect(form).toBe("BASE\t0\t2026-01-01\t∅\tmch\n∅HORAS")
    expect(budgetHash(version(), "mch")).toBe(sha256(form))
  })

  it("un registro: mes, dimensión, cuenta, tipo, NIVEL, importe y excepción", () => {
    const form = canonicalBudgetForm(version({ cells: [cell()] }), "mch")
    expect(form.split("\n")[1]).toBe("2026-03-01\tPROJECT\tP-01\t705\tINGRESO_DIRECTO\tINGRESOS\t100000\t0")
  })

  it("la cuenta nula y el mes sin cuenta se escriben con el token ∅, no vacíos", () => {
    const form = canonicalBudgetForm(version({ cells: [cell({ accountCode: null })] }), "mch")
    expect(form.split("\n")[1]).toContain("\t∅\tINGRESO_DIRECTO\t")
  })

  it("importes negativos: el signo viaja en el sello", () => {
    const negative = cell({ analyticType: "INDIRECTO_CECO", marginLevel: "EBITDA", dimension: CECO, amountCents: -1 })
    expect(canonicalBudgetForm(version({ cells: [negative] }), "mch")).toContain("\t-1\t0")
  })

  it("O-E10-7 · mover el CECO de MC3 a EBITDA CAMBIA el hash", () => {
    const mc3 = cell({ analyticType: "INDIRECTO_CECO", dimension: CECO, marginLevel: "MC3", amountCents: -5_000 })
    const ebitda = { ...mc3, marginLevel: "EBITDA" as const }
    expect(budgetHash(version({ cells: [mc3] }), "mch")).not.toBe(budgetHash(version({ cells: [ebitda] }), "mch"))
  })

  it("el orden de entrada NO altera el sello: la forma canónica ordena", () => {
    const a = cell({ month: "2026-01-01" })
    const b = cell({ month: "2026-02-01" })
    expect(budgetHash(version({ cells: [a, b] }), "mch")).toBe(budgetHash(version({ cells: [b, a] }), "mch"))
  })

  it("el marginConfigHash forma parte del sello", () => {
    expect(budgetHash(version({ cells: [cell()] }), "a")).not.toBe(budgetHash(version({ cells: [cell()] }), "b"))
  })

  it("`partialFrom` forma parte del sello; `validTo` NO (auditor H-2)", () => {
    const base = version({ cells: [cell()] })
    expect(budgetHash(base, "mch")).not.toBe(budgetHash({ ...base, partialFrom: "2026-07-01" }, "mch"))
    // `validTo` es MUTABLE POR DISEÑO: `sealBudgetTx` cierra la versión anterior
    // con `validTo = validFrom − 1 día` al sellar la siguiente (O-E10-8) y el
    // trigger `assert_budget_immutable_when_sealed` lo admite expresamente. Si
    // entrase en el sello, el hash de toda versión relevada dejaría de ser
    // reproducible e I-E10-6 daría FAIL sobre datos íntegros.
    expect(budgetHash(base, "mch")).toBe(budgetHash({ ...base, validTo: "2026-06-30" }, "mch"))
    expect(budgetHash(base, "mch")).toBe(budgetHash({ ...base, validTo: null }, "mch"))
  })

  it("H-3 · las líneas de HORAS entran en el sello (ADR-0018 D2, §3.8)", () => {
    const hours: BudgetHoursCell = {
      month: "2026-03-01",
      dimension: PROJECT,
      employeeCode: null,
      minutes: 1_200,
    }
    const sinHoras = version({ cells: [cell()] })
    const conHoras = version({ cells: [cell()], hours: [hours] })
    expect(budgetHash(conHoras, "mch")).not.toBe(budgetHash(sinHoras, "mch"))
    // Y cambiar los minutos de una versión sellada NO pasa desapercibido.
    const otrasHoras = version({ cells: [cell()], hours: [{ ...hours, minutes: 1_201 }] })
    expect(budgetHash(otrasHoras, "mch")).not.toBe(budgetHash(conHoras, "mch"))
    expect(canonicalBudgetForm(conHoras, "mch").split("\n")).toEqual([
      "BASE\t0\t2026-01-01\t∅\tmch",
      "2026-03-01\tPROJECT\tP-01\t705\tINGRESO_DIRECTO\tINGRESOS\t100000\t0",
      "∅HORAS",
      "2026-03-01\tPROJECT\tP-01\t∅\t1200",
    ])
  })

  it("el orden de entrada de las horas tampoco altera el sello", () => {
    const h = (month: string): BudgetHoursCell => ({
      month,
      dimension: PROJECT,
      employeeCode: null,
      minutes: 60,
    })
    const a = version({ hours: [h("2026-01-01"), h("2026-02-01")] })
    const b = version({ hours: [h("2026-02-01"), h("2026-01-01")] })
    expect(budgetHash(a, "mch")).toBe(budgetHash(b, "mch"))
  })

  it("29-feb de un bisiesto se sella como cualquier otro mes", () => {
    const leap = cell({ month: "2024-02-01" })
    expect(canonicalBudgetForm(version({ cells: [leap] }), "mch")).toContain("2024-02-01\tPROJECT")
  })

  it("byte a byte · los dos budgetHash del fixture sellado", () => {
    const versions = versionsFromFixture()
    for (const [index, header] of expected.budgets.entries()) {
      expect(budgetHash(versions[index], expected.marginConfigHash)).toBe(header.budgetHash)
      expect(versions[index].cells).toHaveLength(header.lineCount)
      expect(versions[index].hours).toHaveLength(header.hoursLineCount)
    }
  })
})

describe("O-E10-9 · composición de versiones", () => {
  it("BASE(ene-jun) + REV1(jul-dic): la procedencia mes a mes es la del fixture", () => {
    const composed = composeBudget(versionsFromFixture(), FY_MONTHS)
    const labels = Object.fromEntries(Object.entries(composed.provenanceByMonth).map(([m, p]) => [m, p.label]))
    expect(labels).toEqual(expected.budgetComposition.provenanceByMonth)
    expect(composed.effective.cells).toHaveLength(expected.budgetComposition.effectiveLineCount)
    expect(monthsWithoutBudget(composed, FY_MONTHS)).toEqual([])
  })

  it("sin ninguna versión parcial, la efectiva es la última completa", () => {
    const only = version({ cells: [cell()] })
    const composed = composeBudget([only], FY_MONTHS)
    expect(composed.effective.cells).toHaveLength(1)
    expect(new Set(Object.values(composed.provenanceByMonth).map((p) => p.label))).toEqual(new Set(["2026-BASE"]))
  })

  it("una parcial que NO declara partialFrom deja el año a la mitad (I-E10-16 lo caza)", () => {
    const base = version({ cells: [cell({ month: "2026-01-01" })] })
    const halfYear = version({
      id: "b-2",
      code: "2026-REV1",
      scenario: "REVISADO",
      revision: 1,
      validFrom: "2026-07-01",
      partialFrom: null,
      cells: [cell({ month: "2026-07-01" })],
    })
    // Sin `partialFrom`, la REV1 es la versión completa: enero desaparece.
    const composed = composeBudget([base, halfYear], FY_MONTHS)
    expect(composed.effective.cells).toHaveLength(1)
    expect(composed.effective.cells[0].month).toBe("2026-07-01")
  })

  it("el ejercicio de doce meses se enumera de enero a diciembre", () => {
    expect(fiscalYearMonths(FY_START, FY_END)).toEqual(FY_MONTHS)
    expect(fiscalYearMonths("2026-04-01", "2027-03-31")).toHaveLength(12)
  })
})

describe("O-E10-6 · coherencia de signo", () => {
  it("un ingreso en negativo sin excepción es WRONG_SIGN", () => {
    const check = checkBudgetSign(cell({ amountCents: -1 }))
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.kind).toBe("WRONG_SIGN")
  })

  it("un gasto en positivo sin excepción es WRONG_SIGN y nombra el signo correcto", () => {
    const check = checkBudgetSign(
      cell({ accountCode: "6400", analyticType: "INDIRECTO_CECO", dimension: CECO, marginLevel: "EBITDA", amountCents: 1_200_000 })
    )
    expect(check.ok === false && check.kind).toBe("WRONG_SIGN")
    expect(check.ok === false && check.message).toContain("negativo")
  })

  it("`7080` en negativo es EXCEPTION_ALLOWED y se admite si se declara", () => {
    const devolucion = cell({ accountCode: "7080", amountCents: -50_000 })
    const check = checkBudgetSign(devolucion)
    expect(check.ok === false && check.kind).toBe("EXCEPTION_ALLOWED")
    expect(budgetSignAccepted(devolucion)).toBe(false)
    expect(budgetSignAccepted({ ...devolucion, signException: true })).toBe(true)
  })

  it("FINANCIERO, EXTRAORDINARIO y NO_ANALITICO no tienen restricción de signo", () => {
    for (const analyticType of ["FINANCIERO", "EXTRAORDINARIO", "NO_ANALITICO"] as const) {
      expect(checkBudgetSign(cell({ analyticType, amountCents: -1 })).ok).toBe(true)
      expect(checkBudgetSign(cell({ analyticType, amountCents: 1 })).ok).toBe(true)
    }
  })

  it("importe 0 es admisible en todos los tipos", () => {
    expect(checkBudgetSign(cell({ amountCents: 0 })).ok).toBe(true)
    expect(checkBudgetSign(cell({ analyticType: "COSTE_DIRECTO_MC1", amountCents: 0 })).ok).toBe(true)
  })

  it("R-B-6 · el 95 % de las líneas de grupo 6 en positivo rechaza el fichero entero", () => {
    const inverted = Array.from({ length: 20 }, (_, i) =>
      cell({
        accountCode: "6400",
        analyticType: "INDIRECTO_CECO",
        dimension: CECO,
        marginLevel: "EBITDA",
        amountCents: i === 0 ? -1_000 : 1_000,
      })
    )
    expect(detectInvertedSignConvention(inverted)).toBe(true)
    expect(detectInvertedSignConvention([])).toBe(false)
  })

  it("exactamente el 90 % en positivo NO dispara: el umbral es estricto", () => {
    const cells = Array.from({ length: 10 }, (_, i) =>
      cell({
        accountCode: "6400",
        analyticType: "INDIRECTO_CECO",
        dimension: CECO,
        marginLevel: "EBITDA",
        amountCents: i < 9 ? 1_000 : -1_000,
      })
    )
    expect(detectInvertedSignConvention(cells)).toBe(false)
  })

  it("el presupuesto sellado del fixture no tiene ni una sola celda con signo indebido", () => {
    for (const version of versionsFromFixture()) {
      expect(budgetSignOffenders(version.cells)).toEqual([])
      expect(detectInvertedSignConvention(version.cells)).toBe(false)
    }
  })
})
