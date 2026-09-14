import { describe, expect, it } from "vitest"

import { BUDGET_EXPORT_NOTES, budgetRunToDocument, exportBudgetRun, minutesToHhMm, type BudgetExportRun } from "@/lib/export/budget-export"

/**
 * E10 · T13 — el export de presupuesto vs real.
 *
 * Lo que se comprueba aquí es lo que distingue este export de los de E6, y cada
 * cosa por una razón contable, no estética:
 *
 *  · una celda **sin presupuesto** o **no comparable** sale VACÍA con su
 *    leyenda, nunca a cero (I-E10-18 y la regla del comparativo de ADR-0012);
 *  · la hoja de **Procedencia lleva las TRES consultas** y los TRES sellos: una
 *    celda de desviación no se reproduce con una sola (P6);
 *  · el `sha256` del fichero es **estable** entre dos exports del mismo run —si
 *    no lo fuera, el hash no acreditaría nada—;
 *  · los minutos se presentan en `hh:mm` exacto (Q-2): 440 minutos son `7:20`.
 */

const run: BudgetExportRun = {
  id: "run-1",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  ledgerHash: "a".repeat(64),
  budgetHash: "b".repeat(64),
  analyticsKey: "c|d|e",
  gitSha: "abc1234",
  seal: "REQUIERE_REVISION",
  sealReasons: [{ code: "PRESUPUESTO_AUSENTE", message: "marzo sin versión vigente" }],
  validation: { checks: [{ id: "I-E10-1", status: "PASS", evidencia: "todas las celdas situadas" }] },
  params: { budgetId: "b-1", granularity: "YTD", forecastCutoff: "2026-04" },
  result: {
    granularity: "YTD",
    withAllocations: true,
    budgetComposition: { "2026-01": "2026-BASE", "2026-08": "2026-REV1" },
    budgetAllocationState: "NONE",
    notSettleableReason: "la regla AL-OPS reparte por HORAS y el presupuesto no declara ni un minuto",
    variance: [
      {
        level: "INGRESOS",
        column: "PROJ:P-01",
        month: null,
        actualCents: 600_000,
        budgetCents: 500_000,
        varianceCents: 100_000,
        varianceBps: 2000,
        forecastCents: 620_000,
        notComparable: false,
      },
      {
        level: "MC3",
        column: "PROJ:P-01",
        month: null,
        actualCents: 180_000,
        budgetCents: null,
        varianceCents: null,
        varianceBps: null,
        forecastCents: null,
        notComparable: true,
      },
      {
        level: "MC2",
        column: "PROJ:P-02",
        month: null,
        actualCents: 40_000,
        budgetCents: null,
        varianceCents: null,
        varianceBps: null,
        forecastCents: null,
        notComparable: false,
      },
    ],
    profitability: [
      {
        projectCode: "P-01",
        actualMinutes: 19_200,
        budgetMinutes: 18_000,
        minutesVariance: 1_200,
        hourlyCostCents: 3_517,
        basis: "COSTE_EMPRESA_CON_SS",
        notEvaluableReason: null,
        marginPerHourMc2Cents: 1_200,
        marginPerHourMc3Cents: 560,
        billedRatePerHourCents: 4_500,
      },
      {
        projectCode: "P-03",
        actualMinutes: 0,
        budgetMinutes: null,
        minutesVariance: null,
        hourlyCostCents: null,
        basis: null,
        notEvaluableReason: "SIN_MINUTOS",
        marginPerHourMc2Cents: null,
        marginPerHourMc3Cents: null,
        billedRatePerHourCents: null,
      },
    ],
    absorption: { absorptionCents: -500, absorptionBps: -9, direction: "INFRAABSORCION" },
    monthsWithoutBudget: ["2026-03"],
    openMonths: ["2026-05", "2026-06"],
  },
}

describe("E10 · export de presupuesto vs real", () => {
  it("`hh:mm` exacto, con signo y sin decimales (Q-2)", () => {
    expect(minutesToHhMm(440)).toBe("7:20")
    expect(minutesToHhMm(60)).toBe("1:00")
    expect(minutesToHhMm(-250)).toBe("-4:10")
    expect(minutesToHhMm(0)).toBe("0:00")
    // Sin dato no hay cero: hay hueco.
    expect(minutesToHhMm(null)).toBe("—")
  })

  it("una celda sin presupuesto o no comparable sale VACÍA con su leyenda, nunca a cero", () => {
    const doc = budgetRunToDocument(run)
    const sheet = doc.sheets.find((s) => s.name === "Presupuesto vs real")
    expect(sheet).toBeDefined()
    const [conPresupuesto, noComparable, sinPresupuesto] = sheet!.rows

    expect(conPresupuesto[4]).toBe(500_000)
    expect(conPresupuesto[5]).toBe(100_000)

    // I-E10-18: ni 0 ni "0", y el motivo escrito en la fila.
    expect(noComparable[4]).toBe("—")
    expect(noComparable[5]).toBe("—")
    expect(noComparable[6]).toBe("—")
    expect(String(noComparable[8])).toContain("no comparable")

    expect(sinPresupuesto[4]).toBe("—")
    expect(String(sinPresupuesto[8])).toContain("sin presupuesto")
  })

  it("la hoja de Procedencia lleva las TRES consultas y los TRES sellos (P6)", () => {
    const doc = budgetRunToDocument(run)
    const sheet = doc.sheets.find((s) => s.name === "Procedencia")
    const campos = new Map(sheet!.rows.map((r) => [String(r[0]), String(r[1])]))
    expect(campos.get("Sello del diario (ledgerHash)")).toContain("sha256:")
    expect(campos.get("Sello del presupuesto (budgetHash)")).toContain("sha256:")
    expect(campos.get("Sello analítico (analyticsKey)")).toBe("c|d|e")
    expect(campos.get("Consulta · real")).toContain("journal_lines")
    expect(campos.get("Consulta · imputado")).toContain("allocation_lines")
    expect(campos.get("Consulta · presupuesto")).toContain("budget_lines")
  })

  it("O-E10-9 · la procedencia del presupuesto se publica mes a mes", () => {
    const doc = budgetRunToDocument(run)
    const sheet = doc.sheets.find((s) => s.name === "Procedencia del presupuesto")
    expect(sheet?.rows).toEqual([
      ["2026-01", "2026-BASE"],
      ["2026-08", "2026-REV1"],
    ])
  })

  it("la `basis` viaja JUNTO al coste-hora, y lo no evaluable se nombra (Q-1, O-E10-15)", () => {
    const doc = budgetRunToDocument(run)
    const sheet = doc.sheets.find((s) => s.name === "Rentabilidad con horas")
    const [p01, p03] = sheet!.rows
    expect(p01[1]).toBe("320:00")
    expect(p01[4]).toBe(3_517)
    expect(p01[5]).toBe("COSTE_EMPRESA_CON_SS")
    // Sin minutos, el coste-hora NO es 0: no es evaluable, y se dice por qué.
    expect(p03[4]).toBe("—")
    expect(p03[9]).toBe("SIN_MINUTOS")
  })

  it("la validación declara el estado de imputación y los meses abiertos (I-E10-18, EV-13)", () => {
    const doc = budgetRunToDocument(run)
    const sheet = doc.sheets.find((s) => s.name === "Validación")
    const filas = new Map(sheet!.rows.map((r) => [String(r[0]), [String(r[1]), String(r[2])]]))
    expect(filas.get("ESTADO DE IMPUTACIÓN")?.[0]).toBe("NONE")
    expect(filas.get("ESTADO DE IMPUTACIÓN")?.[1]).toContain("HORAS")
    expect(filas.get("MESES SIN PRESUPUESTO")?.[0]).toBe("WARN")
    expect(filas.get("MESES NO CERRADOS")?.[0]).toBe("INFO")
    expect(filas.get("SELLO")?.[1]).toContain("PRESUPUESTO_AUSENTE")
  })

  it("las notas al pie del informe de gestión van SIEMPRE", () => {
    const doc = budgetRunToDocument(run)
    expect(doc.notes).toEqual(BUDGET_EXPORT_NOTES)
    expect(doc.notes.join(" ")).toContain("NO son márgenes de proyecto")
  })

  it("el `sha256` del fichero es ESTABLE entre dos exports del mismo run", async () => {
    const a = await exportBudgetRun(run, "csv")
    const b = await exportBudgetRun(run, "csv")
    expect(a.sha256).toBe(b.sha256)
    expect(a.filename).toBe("presupuesto-real-2026-01-01-2026-12-31.zip")

    const x = await exportBudgetRun(run, "xlsx")
    const y = await exportBudgetRun(run, "xlsx")
    expect(x.sha256).toBe(y.sha256)

    // Y cambia cuando cambia una cifra: si no, el hash no acreditaría nada.
    const otro = await exportBudgetRun(
      { ...run, result: { ...run.result, monthsWithoutBudget: [] } },
      "csv"
    )
    expect(otro.sha256).not.toBe(a.sha256)
  })
})
