import { describe, expect, it } from "vitest"

import {
  BUDGET_KPIS,
  DEFAULT_KPI_THRESHOLDS,
  E10_SEAL_REASON_RULES,
  SENTINEL,
  budgetReviewReasons,
  checkThresholds,
  reportRunKey,
  shareBps,
  varianceIsPartial,
  type ReviewThresholds,
} from "@/lib/ledger/report-run"

/**
 * E10 · T13 — la familia `EV-11 … EV-17` y el noveno componente de la clave.
 *
 * Cada caso es el fallo concreto que la regla existe para impedir, no una
 * comprobación de que la función «devuelve algo».
 */

const KEY = {
  organizationId: "org",
  type: "PRESUPUESTO_REAL",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  paramsHash: "p",
  ledgerHash: "l",
  analyticsKey: "a",
  gitSha: "g",
}

describe("E10 · `budgetHash` en la clave de caché (M5)", () => {
  it("dos presupuestos distintos con el MISMO diario son informes distintos", () => {
    const uno = reportRunKey({ ...KEY, budgetHash: "b1" })
    const otro = reportRunKey({ ...KEY, budgetHash: "b2" })
    expect(uno).not.toBe(otro)
  })

  it("sin `budgetHash` la clave lleva el centinela, y no cambia para los informes de E6", () => {
    expect(reportRunKey(KEY).endsWith(`|${SENTINEL}`)).toBe(true)
    // Criterio 17 en su mitad pura: añadir un componente CONSTANTE no invalida
    // ninguna caché existente, porque la clave de un BALANCE sigue siendo la
    // misma cadena más el mismo sufijo.
    expect(reportRunKey(KEY)).toBe(`${[KEY.organizationId, KEY.type, KEY.periodStart, KEY.periodEnd, KEY.paramsHash, KEY.ledgerHash, KEY.analyticsKey, KEY.gitSha].join("|")}|${SENTINEL}`)
  })
})

describe("E10 · EV-11 … EV-17", () => {
  it("EV-11 · cambiar de versión de presupuesto REDEFINE la medida y dispara siempre", () => {
    const reasons = budgetReviewReasons({ budgetHash: "b2", lastBudgetHash: "b1" })
    expect(reasons.map((r) => r.code)).toContain("DESVIACION_PRESUPUESTO")
    expect(reasons[0].message).toMatch(/no es una variación del negocio/)
  })

  it("EV-11 · el PRIMER informe del periodo no dispara: no hay medida anterior que comparar", () => {
    expect(budgetReviewReasons({ budgetHash: "b1", lastBudgetHash: null })).toHaveLength(0)
    expect(budgetReviewReasons({ budgetHash: "b1", lastBudgetHash: SENTINEL })).toHaveLength(0)
  })

  it("EV-12 · sin versión vigente para un mes, la columna sale vacía Y el sello se mueve", () => {
    const reasons = budgetReviewReasons({ monthsWithoutBudget: ["2026-03", "2026-04"] })
    expect(reasons).toHaveLength(1)
    expect(reasons[0].code).toBe("PRESUPUESTO_AUSENTE")
    // Lección H-4 de E7: un aviso que no mueve el sello es decorativo.
    expect(reasons[0].message).toMatch(/VACÍAS, nunca a cero/)
  })

  it("EV-13 · un periodo con meses no cerrados NO dispara, pero se declara parcial", () => {
    expect(budgetReviewReasons({ openMonths: ["2026-11", "2026-12"] })).toHaveLength(0)
    expect(varianceIsPartial({ openMonths: ["2026-12"] })).toBe(true)
    expect(varianceIsPartial({ openMonths: [] })).toBe(false)
  })

  it("EV-15 · horas sin aprobar con base NO vacía: el caso que la ronda 0 callaba", () => {
    // 12 000 minutos sin aprobar sobre una base de 36 000: en la ronda 0 el aviso
    // sólo salía con base 0, y los 187 500 c que P-03 dejaba de absorber se
    // publicaban en silencio.
    const reasons = budgetReviewReasons({
      unapprovedMinutes: { minutes: 12_000, baseMinutes: 36_000, targets: ["P-03"] },
    })
    expect(reasons).toHaveLength(1)
    expect(reasons[0].code).toBe("HORAS_SIN_APROBAR")
    expect(reasons[0].deltaBps).toBe(3_333)
    expect(reasons[0].message).toContain("P-03")
  })

  it("EV-16 · un receptor SIN snapshot dispara; un snapshot de 0 FTE NO, porque es un dato", () => {
    const sinDato = budgetReviewReasons({ costCentersWithoutHeadcount: ["CC-SOP"] })
    expect(sinDato.map((r) => r.code)).toEqual(["PLANTILLA_AUSENTE"])
    expect(sinDato[0].message).toMatch(/falta el dato, no porque no haya nadie/)
    // Un 0 declarado no llega nunca a esta lista: lo filtra `fteMonthsByCostCenter`.
    expect(budgetReviewReasons({ costCentersWithoutHeadcount: [] })).toHaveLength(0)
  })

  it("EV-17 · sólo dispara si el informe PUBLICA coste-hora: un margen por hora sin tarifa no es un margen", () => {
    const publica = budgetReviewReasons({
      unpricedTime: { entries: 4, employees: ["E-001"] },
      publishesHourlyCost: true,
    })
    expect(publica.map((r) => r.code)).toEqual(["TARIFA_AUSENTE"])
    const noPublica = budgetReviewReasons({
      unpricedTime: { entries: 4, employees: ["E-001"] },
      publishesHourlyCost: false,
    })
    expect(noPublica).toHaveLength(0)
  })

  it("`shareBps` es ENTERO y nunca `NaN` ni `Infinity`", () => {
    expect(shareBps(12_000, 36_000)).toBe(3_333)
    expect(shareBps(1, 3)).toBe(3_333)
    expect(shareBps(5, 0)).toBeNull()
    expect(shareBps(0, 100)).toBe(0)
  })
})

describe("E10 · los CUATRO KPI de umbral (§5.3)", () => {
  const thresholds: ReviewThresholds = {
    version: 1,
    comparativeBasis: "NONE",
    kpis: DEFAULT_KPI_THRESHOLDS,
  }

  it("los cuatro están declarados con `pctBps` Y `minAbsCents`", () => {
    for (const kpi of BUDGET_KPIS) {
      const limit = DEFAULT_KPI_THRESHOLDS[kpi]
      expect(limit, kpi).toBeDefined()
      expect(limit.pctBps, kpi).not.toBeNull()
      expect(limit.minAbsCents, kpi).not.toBeNull()
    }
    expect(DEFAULT_KPI_THRESHOLDS.desviacionMaxDimension).toEqual({ pctBps: 2000, minAbsCents: 500_000 })
  })

  it("criterio 18 · dispara sólo si supera LOS DOS umbrales", () => {
    // 1 800 bps y 250 000 c: pasa el relativo, falla el absoluto ⇒ NO dispara.
    const cerca = checkThresholds(
      { desviacionEbitda: 1_250_000 },
      { desviacionEbitda: 1_000_000 },
      { ...thresholds, comparativeBasis: "PREVIOUS_PERIOD" },
      { comparativeBasis: "PREVIOUS_PERIOD" }
    )
    expect(cerca.filter((b) => b.kpi === "desviacionEbitda")).toHaveLength(0)

    // 4 000 bps y 400 000 c: supera los dos ⇒ dispara.
    const dispara = checkThresholds(
      { desviacionEbitda: 1_400_000 },
      { desviacionEbitda: 1_000_000 },
      { ...thresholds, comparativeBasis: "PREVIOUS_PERIOD" },
      { comparativeBasis: "PREVIOUS_PERIOD" }
    )
    expect(dispara.filter((b) => b.kpi === "desviacionEbitda")).toHaveLength(1)
  })
})

describe("O-E10-17 / criterio 33 · un motivo, una regla", () => {
  it("cada motivo de E10 tiene al menos una regla que lo emite", () => {
    for (const [code, rules] of Object.entries(E10_SEAL_REASON_RULES)) {
      expect(rules.length, code).toBeGreaterThan(0)
    }
  })

  it("cada regla EV-* de E10 emite un motivo del CÓDIGO CERRADO, y EV-14 no existe", () => {
    const emitted = new Set(Object.values(E10_SEAL_REASON_RULES).flat())
    for (const rule of ["EV-11", "EV-12", "EV-15", "EV-16", "EV-17"]) {
      expect(emitted.has(rule), rule).toBe(true)
    }
    // EV-13 no emite motivo a propósito: marca la desviación como parcial.
    expect(emitted.has("EV-13")).toBe(false)
    // EV-14 está RETIRADA (O-E10-5): un borrador no produce un `ReportRun`, así
    // que `PRESUPUESTO_NO_SELLADO` dejó de ser motivo y pasó a ser rechazo.
    expect(emitted.has("EV-14")).toBe(false)
  })

  it("todos los motivos que las reglas emiten son de los cinco declarados en E10", () => {
    expect(Object.keys(E10_SEAL_REASON_RULES).sort()).toEqual([
      "DESVIACION_PRESUPUESTO",
      "HORAS_SIN_APROBAR",
      "PLANTILLA_AUSENTE",
      "PRESUPUESTO_AUSENTE",
      "TARIFA_AUSENTE",
    ])
  })
})
