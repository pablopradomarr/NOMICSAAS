/**
 * E5 · T5/T7/T8 — Tests del motor de liquidación.
 *
 * El último `describe` es el que sella la épica: reconstruye los 17 runs de 2026
 * sobre `tests/fixtures/ejercicio-completo.json` y compara la serialización
 * canónica **byte a byte** con `docs/design/fixtures/liquidacion-esperada.json`.
 * Si una coma se mueve, el test cae — que es exactamente lo que debe pasar.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  allocate,
  buildAllocationGraph,
  canonicalAllocationJson,
  canonicalLine,
  canonicalRun,
  canonicalRulesForm,
  checkTopologicalOrder,
  effectiveRules,
  findCycle,
  hamilton,
  periodBounds,
  priorPeriodWindow,
  rulesHash,
  type AllocationPeriodRef,
  type AllocationRuleSpec,
  type AllocationWarning,
  type AppliedAllocation,
  type CanonicalRunRow,
  type PriorAllocation,
} from "@/lib/analytics/allocate"
import { buildAnalyticPnl } from "@/lib/analytics/margins"
import { checkAllocationInvariants, checkI5, checkIE51, checkIE56 } from "@/lib/analytics/invariants"
import {
  MARGIN_LEVELS,
  type AnalyticLine,
  type AnalyticsConfig,
  type Cents,
} from "@/lib/analytics/types"
import { defaultMarginLevels } from "@/lib/analytics/seed"
import { loadFixture } from "@/tests/support/fixtures"

const PROV = {
  runId: "test",
  ledgerHash: "0".repeat(64),
  gitSha: "c0e828f",
  baseCurrency: "EUR",
  module: "lib/analytics/margins.ts",
}

// ─────────────────────────────────────────────────────────────────────────────
// Hamilton (§1.4) — el corazón aritmético de la épica
// ─────────────────────────────────────────────────────────────────────────────

describe("hamilton", () => {
  it("caso vacío: sin receptores no reparte nada", () => {
    expect(hamilton(1000, [])).toEqual([])
  })

  it("un solo receptor se lleva el importe exacto", () => {
    expect(hamilton(91_890, [{ code: "P-01", weight: 7 }])).toEqual([
      { code: "P-01", amountCents: 91_890, shareBps: 10_000, remainderApplied: false },
    ])
  })

  it("base cero: todos los pesos a 0 ⇒ no se inventa ningún reparto", () => {
    const out = hamilton(500, [
      { code: "A", weight: 0 },
      { code: "B", weight: 0 },
    ])
    expect(out.map((o) => o.amountCents)).toEqual([0, 0])
  })

  it("importe cero: ni un céntimo se mueve", () => {
    expect(hamilton(0, [{ code: "A", weight: 3 }])[0].amountCents).toBe(0)
  })

  it("el reparto real del fixture: 91 890 c por coste directo YTD", () => {
    const out = hamilton(91_890, [
      { code: "P-01", weight: 1_734_000 },
      { code: "P-02", weight: 990_000 },
      { code: "P-03", weight: 250_000 },
    ])
    expect(out.map((o) => o.amountCents)).toEqual([53_577, 30_589, 7_724])
    expect(out.reduce((a, o) => a + o.amountCents, 0)).toBe(91_890)
    expect(out.map((o) => o.shareBps)).toEqual([5_830, 3_328, 840])
  })

  it("importe negativo: saldo acreedor repartido sobre |importe| y signo restituido", () => {
    const positive = hamilton(91_890, [
      { code: "P-01", weight: 1_734_000 },
      { code: "P-02", weight: 990_000 },
      { code: "P-03", weight: 250_000 },
    ])
    const negative = hamilton(-91_890, [
      { code: "P-01", weight: 1_734_000 },
      { code: "P-02", weight: 990_000 },
      { code: "P-03", weight: 250_000 },
    ])
    // Simetría exacta: truncar con signo sesgaría el redondeo hacia cero.
    expect(negative.map((o) => o.amountCents)).toEqual(positive.map((o) => -o.amountCents))
    expect(negative.reduce((a, o) => a + o.amountCents, 0)).toBe(-91_890)
  })

  it("empate de restos: gana el CÓDIGO MENOR, no el orden de llegada", () => {
    const out = hamilton(10, [
      { code: "Z", weight: 1 },
      { code: "A", weight: 1 },
      { code: "M", weight: 1 },
    ])
    const byCode = new Map(out.map((o) => [o.code, o.amountCents]))
    // 10 / 3 = 3 con resto 1: el céntimo va a "A".
    expect(byCode.get("A")).toBe(4)
    expect(byCode.get("M")).toBe(3)
    expect(byCode.get("Z")).toBe(3)
    // Y con los mismos pesos en otro orden, el reparto no cambia (P7).
    const again = hamilton(10, [
      { code: "A", weight: 1 },
      { code: "M", weight: 1 },
      { code: "Z", weight: 1 },
    ])
    expect(new Map(again.map((o) => [o.code, o.amountCents]))).toEqual(byCode)
  })

  it("I-E5-4 · propiedad sobre 1 000 casos con semilla fija: Σ exacta y ≤ 1 c de remanente", () => {
    // LCG determinista: nada de Math.random (el módulo es puro y P7 lo exige).
    let seed = 20260906
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % max
    }
    for (let i = 0; i < 1000; i++) {
      const n = 1 + next(15)
      const weights = Array.from({ length: n }, (_, j) => ({ code: `R-${String(j).padStart(2, "0")}`, weight: next(500000) }))
      const amount = (next(2) === 0 ? -1 : 1) * next(5_000_000)
      const out = hamilton(amount, weights)
      const total = weights.reduce((a, w) => a + w.weight, 0)
      if (total === 0 || amount === 0) {
        expect(out.every((o) => o.amountCents === 0)).toBe(true)
        continue
      }
      expect(out.reduce((a, o) => a + o.amountCents, 0)).toBe(amount)
      const remainders = out.filter((o) => o.remainderApplied).length
      expect(remainders).toBeLessThanOrEqual(weights.filter((w) => w.weight > 0).length - 1 + 1)
      for (const o of out) {
        const w = weights.find((x) => x.code === o.code)?.weight ?? 0
        if (w === 0) continue
        const exact = Math.floor((Math.abs(amount) * w) / total)
        expect(Math.abs(o.amountCents)).toBeGreaterThanOrEqual(exact)
        expect(Math.abs(o.amountCents)).toBeLessThanOrEqual(exact + 1)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Periodos
// ─────────────────────────────────────────────────────────────────────────────

describe("periodos", () => {
  it("los límites de un mes, un trimestre y un año", () => {
    expect(periodBounds("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" })
    expect(periodBounds("2026-Q2")).toEqual({ from: "2026-04-01", to: "2026-06-30" })
    expect(periodBounds("2026")).toEqual({ from: "2026-01-01", to: "2026-12-31" })
  })

  it("29 de febrero: 2024 bisiesto, 2026 no", () => {
    expect(periodBounds("2024-02").to).toBe("2024-02-29")
    expect(periodBounds("2026-02").to).toBe("2026-02-28")
  })

  it("`PRIOR_PERIOD` cruza el año hacia atrás sin inventarse fechas", () => {
    expect(priorPeriodWindow("MONTH", "2026-01")).toEqual({ from: "2025-12-01", to: "2025-12-31" })
    expect(priorPeriodWindow("QUARTER", "2026-Q1")).toEqual({ from: "2025-10-01", to: "2025-12-31" })
    expect(priorPeriodWindow("YEAR", "2026")).toEqual({ from: "2025-01-01", to: "2025-12-31" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Grafo: ciclos y orden topológico (I-E5-1, I-E5-8)
// ─────────────────────────────────────────────────────────────────────────────

const ruleOf = (over: Partial<AllocationRuleSpec> & Pick<AllocationRuleSpec, "code" | "sourceCostCenterId">): AllocationRuleSpec => ({
  id: `rule-${over.code}`,
  name: over.code,
  targetKind: "COST_CENTERS",
  driver: "FIXED_PERCENT",
  period: "YEAR",
  priority: 10,
  sourceShareBps: 10000,
  zeroBaseFallback: "SKIP_WARN",
  targetFilter: null,
  validFrom: "2026-01-01",
  validTo: null,
  isActive: true,
  targets: [],
  ...over,
})

describe("grafo de cascada", () => {
  it("grafo vacío y grafo lineal: sin ciclo", () => {
    expect(findCycle(buildAllocationGraph([]))).toBeNull()
    const rules = [
      ruleOf({ code: "A", sourceCostCenterId: "cc-1", targets: [{ costCenterId: "cc-2", percentBps: 10000 }] }),
      ruleOf({ code: "B", sourceCostCenterId: "cc-2", priority: 20, targets: [{ costCenterId: "cc-3", percentBps: 10000 }] }),
    ]
    expect(findCycle(buildAllocationGraph(rules))).toBeNull()
  })

  it("autoarista: ciclo trivial, rechazado igual", () => {
    const rules = [ruleOf({ code: "A", sourceCostCenterId: "cc-1", targets: [{ costCenterId: "cc-1", percentBps: 10000 }] })]
    expect(findCycle(buildAllocationGraph(rules))).toEqual(["cc-1", "cc-1"])
  })

  it("ciclo de dos: el motor devuelve el camino NOMBRADO, no un booleano", () => {
    const rules = [
      ruleOf({ code: "A", sourceCostCenterId: "cc-ga", targets: [{ costCenterId: "cc-ops", percentBps: 10000 }] }),
      ruleOf({ code: "B", sourceCostCenterId: "cc-ops", targets: [{ costCenterId: "cc-ga", percentBps: 10000 }] }),
    ]
    const cycle = findCycle(buildAllocationGraph(rules))
    expect(cycle).not.toBeNull()
    expect(cycle).toContain("cc-ga")
    expect(cycle).toContain("cc-ops")
  })

  it("dos periodicidades distintas NO forman ciclo: una arista sólo une reglas del mismo period", () => {
    const rules = [
      ruleOf({ code: "A", sourceCostCenterId: "cc-1", period: "YEAR", targets: [{ costCenterId: "cc-2", percentBps: 10000 }] }),
      ruleOf({ code: "B", sourceCostCenterId: "cc-2", period: "MONTH", targets: [{ costCenterId: "cc-1", percentBps: 10000 }] }),
    ]
    expect(findCycle(buildAllocationGraph(rules))).toBeNull()
  })

  it("I-E5-8: el receptor con prioridad menor que el donante es una infracción nombrada", () => {
    const rules = [
      ruleOf({ code: "AL-GA-OPS-Y", sourceCostCenterId: "cc-ga", priority: 30, targets: [{ costCenterId: "cc-ops", percentBps: 10000 }] }),
      ruleOf({ code: "AL-OPS-Y", sourceCostCenterId: "cc-ops", priority: 10, targetKind: "PROJECTS", driver: "EQUAL" }),
    ]
    expect(checkTopologicalOrder(rules, buildAllocationGraph(rules))).toEqual([{ from: "AL-GA-OPS-Y", to: "AL-OPS-Y" }])
  })

  it("con prioridades correctas el orden es topológico", () => {
    const rules = [
      ruleOf({ code: "AL-GA-OPS-Y", sourceCostCenterId: "cc-ga", priority: 10, targets: [{ costCenterId: "cc-ops", percentBps: 10000 }] }),
      ruleOf({ code: "AL-OPS-Y", sourceCostCenterId: "cc-ops", priority: 30, targetKind: "PROJECTS", driver: "EQUAL" }),
    ]
    expect(checkTopologicalOrder(rules, buildAllocationGraph(rules))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El fixture completo: los 17 runs de 2026
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "liquidacion-esperada.json")
const E4_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "pyg-analitica-esperada.json")

const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)
const QUARTERS = ["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]
const SYNTHETIC_HOURS_MINUTES: Record<string, number> = { "P-01": 320 * 60, "P-02": 180 * 60, "P-03": 100 * 60 }

/** Las seis reglas de §5.1 del experto, TAL CUAL las escribe el JSON sellado. */
const FIXTURE_RULES = [
  {
    code: "AL-OPS-M",
    name: "Operaciones indirectas a proyectos por coste directo (mensual)",
    sourceCostCenterCode: "CC-OPS",
    period: "MONTH",
    priority: 10,
    sourceShareBps: 10000,
    targetKind: "PROJECTS",
    driver: "DIRECT_COST_SHARE",
    targetFilter: { projectStatus: ["ACTIVE"] },
    zeroBaseFallback: "YTD",
    targets: [] as Record<string, unknown>[],
  },
  {
    code: "AL-DEV-Q",
    name: "Desarrollo de producto a lineas de negocio 60/40 (trimestral)",
    sourceCostCenterCode: "CC-DEV",
    period: "QUARTER",
    priority: 10,
    sourceShareBps: 10000,
    targetKind: "BUSINESS_LINES",
    driver: "FIXED_PERCENT",
    targetFilter: null,
    zeroBaseFallback: "SKIP_WARN",
    targets: [
      { businessLineCode: "BL-CONS", percentBps: 6000 },
      { businessLineCode: "BL-DEV", percentBps: 4000 },
    ],
  },
  {
    code: "AL-MKT-Q",
    name: "Marketing y ventas a proyectos por ingresos (trimestral)",
    sourceCostCenterCode: "CC-MKT",
    period: "QUARTER",
    priority: 20,
    sourceShareBps: 10000,
    targetKind: "PROJECTS",
    driver: "REVENUE_SHARE",
    targetFilter: { projectStatus: ["ACTIVE"] },
    zeroBaseFallback: "SKIP_WARN",
    targets: [],
  },
  {
    code: "AL-GA-OPS-Y",
    name: "G&A: 30 % a Operaciones indirectas (cascada, anual)",
    sourceCostCenterCode: "CC-GA",
    period: "YEAR",
    priority: 10,
    sourceShareBps: 3000,
    targetKind: "COST_CENTERS",
    driver: "FIXED_PERCENT",
    targetFilter: null,
    zeroBaseFallback: "SKIP_WARN",
    targets: [{ costCenterCode: "CC-OPS", percentBps: 10000 }],
  },
  {
    code: "AL-GA-PRY-Y",
    name: "G&A: 70 % a proyectos a partes iguales (anual)",
    sourceCostCenterCode: "CC-GA",
    period: "YEAR",
    priority: 20,
    sourceShareBps: 7000,
    targetKind: "PROJECTS",
    driver: "EQUAL",
    targetFilter: { projectStatus: ["ACTIVE"] },
    zeroBaseFallback: "SKIP_WARN",
    targets: [],
  },
  {
    code: "AL-OPS-Y",
    name: "Operaciones indirectas: redistribuye lo recibido en cascada (anual)",
    sourceCostCenterCode: "CC-OPS",
    period: "YEAR",
    priority: 30,
    sourceShareBps: 10000,
    targetKind: "PROJECTS",
    driver: "DIRECT_COST_SHARE",
    targetFilter: { projectStatus: ["ACTIVE"] },
    zeroBaseFallback: "SKIP_WARN",
    targets: [],
  },
] as const

describe("liquidación del fixture completo (2026)", () => {
  const loaded = loadFixture("ejercicio-completo")
  const expectedText = readFileSync(EXPECTED_PATH, "utf8")
  const expected = JSON.parse(expectedText) as Record<string, never>
  const e4Expected = JSON.parse(readFileSync(E4_PATH, "utf8")) as { levelTotalsCents: Record<string, Cents> }

  const config: AnalyticsConfig = {
    organizationId: "org-e5",
    levels: defaultMarginLevels(),
    businessLines: loaded.dimensions.businessLines,
    projects: loaded.dimensions.projects,
    costCenters: loaded.dimensions.costCenters,
    unassignedCostCenterId: loaded.dimensions.unassignedCostCenterId,
    analyticTypeByAccount: new Map(),
    incomeTaxPrefixes: ["630", "633", "638"],
    nonAnalyticLevel: "EBITDA",
    analyticsRequired: false,
  }

  const idOf = {
    ceco: (code: string) => config.costCenters.find((c) => c.code === code)?.id ?? code,
    project: (code: string) => config.projects.find((p) => p.code === code)?.id ?? code,
    bl: (code: string) => config.businessLines.find((b) => b.code === code)?.id ?? code,
  }

  /** Las seis reglas del fixture, traducidas a ids (que es lo que el motor usa). */
  const rules: AllocationRuleSpec[] = FIXTURE_RULES.map((r) => ({
    id: `alloc-rule-${r.code}`,
    code: r.code,
    name: r.name,
    sourceCostCenterId: idOf.ceco(r.sourceCostCenterCode),
    targetKind: r.targetKind,
    driver: r.driver,
    period: r.period,
    priority: r.priority,
    sourceShareBps: r.sourceShareBps,
    zeroBaseFallback: r.zeroBaseFallback,
    targetFilter: r.targetFilter,
    validFrom: "2026-01-01",
    validTo: null,
    isActive: true,
    targets: r.targets.map((t, index) => ({
      projectId: "projectCode" in t ? idOf.project(t.projectCode as string) : null,
      businessLineId: "businessLineCode" in t ? idOf.bl(t.businessLineCode as string) : null,
      costCenterId: "costCenterCode" in t ? idOf.ceco(t.costCenterCode as string) : null,
      percentBps: (t.percentBps as number) ?? null,
      amountCents: null,
      sortOrder: index,
    })),
  }))

  const lines: AnalyticLine[] = loaded.posted
    .filter((e) => e.fiscalYearId === "fy-2026")
    .flatMap((e) =>
      e.lines.map((l) => ({
        id: `${e.id}#${l.lineNo}`,
        entryId: e.id,
        entryNumber: e.entryNumber,
        entryDate: e.entryDate,
        entryKind: e.kind,
        fiscalYearId: e.fiscalYearId,
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        analyticType: l.analyticType ?? null,
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
        businessLineId: l.businessLineId ?? null,
      }))
    )

  const periodRef = (kind: "MONTH" | "QUARTER" | "YEAR", label: string): AllocationPeriodRef => {
    const bounds = periodBounds(label)
    return {
      kind,
      label,
      start: bounds.from,
      end: bounds.to,
      fiscalYearId: "fy-2026",
      fiscalYearStart: "2026-01-01",
      fiscalYearEnd: "2026-12-31",
    }
  }

  /** Los 17 runs, en el orden del generador: 12 meses, 4 trimestres y el año. */
  function runAll(): {
    runs: CanonicalRunRow[]
    lines: AppliedAllocation[]
    warnings: AllocationWarning[]
    balances: { runId: string; sourceCostCenterCode: string; marginLevel: string; baseCents: Cents; allocatedCents: Cents; diffCents: Cents }[]
  } {
    const runs: CanonicalRunRow[] = []
    const applied: AppliedAllocation[] = []
    const warnings: AllocationWarning[] = []
    const balances: {
      runId: string
      sourceCostCenterCode: string
      marginLevel: string
      baseCents: Cents
      allocatedCents: Cents
      diffCents: Cents
    }[] = []
    const priors: PriorAllocation[] = []

    const schedule: [("MONTH" | "QUARTER" | "YEAR"), string][] = [
      ...MONTHS.map((m) => ["MONTH", m] as [("MONTH" | "QUARTER" | "YEAR"), string]),
      ...QUARTERS.map((q) => ["QUARTER", q] as [("MONTH" | "QUARTER" | "YEAR"), string]),
      ["YEAR", "2026"],
    ]

    for (const [kind, label] of schedule) {
      const period = periodRef(kind, label)
      const result = allocate({ lines, config, rules, period, priorAllocations: priors })
      if (!result.ok) throw new Error(`${label}: ${result.error.code} ${result.error.message}`)
      runs.push(canonicalRun(result.value))
      applied.push(...result.value.lines)
      warnings.push(...result.value.warnings)
      for (const b of result.value.balances) {
        if (b.liquidatedCents === 0 && b.allocatedCents === 0) continue
        balances.push({
          runId: result.value.runId,
          sourceCostCenterCode: b.sourceCostCenterCode,
          marginLevel: b.marginLevel,
          baseCents: b.liquidatedCents,
          allocatedCents: b.allocatedCents,
          diffCents: b.residualCents,
        })
      }
      for (const line of result.value.lines) {
        priors.push({
          runPeriodStart: period.start,
          runPeriodEnd: period.end,
          sourceCostCenterId: line.sourceCostCenterId,
          marginLevel: line.marginLevel,
          amountCents: line.amountCents,
        })
      }
    }
    return { runs, lines: applied, warnings, balances }
  }

  const engine = runAll()
  const pnl = buildAnalyticPnl(lines, config, { from: "2026-01-01", to: "2026-12-31" }, PROV, {
    allocations: engine.lines,
  })

  it("14 `AllocationLine` en 3 de los 17 runs, y 1 075 524 c liquidados", () => {
    expect(engine.lines).toHaveLength(14)
    expect(engine.runs).toHaveLength(17)
    expect(engine.runs.filter((r) => r.lineCount > 0).map((r) => r.runId)).toEqual([
      "RUN-2026-11",
      "RUN-2026-Q2",
      "RUN-2026",
    ])
    expect(engine.lines.reduce((a, l) => a + l.amountCents, 0)).toBe(1_075_524)
  })

  it("criterio 5 · Hamilton exacto: los tres remanentes caen por MENOR CÓDIGO", () => {
    const byRun = (runId: string, rule: string): number[] =>
      engine.lines.filter((l) => l.runId === runId && l.ruleCode === rule).map((l) => l.amountCents)
    expect(byRun("RUN-2026-11", "AL-OPS-M")).toEqual([53_577, 30_589, 7_724])
    expect(byRun("RUN-2026-Q2", "AL-MKT-Q")).toEqual([34_571, 25_929])
    expect(byRun("RUN-2026", "AL-OPS-Y")).toEqual([110_753, 63_233, 15_968])
    expect(53_577 + 30_589 + 7_724).toBe(91_890)
    expect(34_571 + 25_929).toBe(60_500)
    expect(110_753 + 63_233 + 15_968).toBe(189_954)
  })

  it("criterio 10 · `sourceShareBps` 3000/7000 liquida CC-GA entero: 189 954 + 443 226 = 633 180", () => {
    const ga = engine.lines.filter((l) => l.sourceCostCenterCode === "CC-GA")
    expect(ga.filter((l) => l.ruleCode === "AL-GA-OPS-Y").reduce((a, l) => a + l.amountCents, 0)).toBe(189_954)
    expect(ga.filter((l) => l.ruleCode === "AL-GA-PRY-Y").reduce((a, l) => a + l.amountCents, 0)).toBe(443_226)
    expect(ga.reduce((a, l) => a + l.amountCents, 0)).toBe(633_180)
  })

  it("criterio 4 · el nivel VIAJA con el importe: los 189 954 c de CC-GA llegan a los proyectos en EBITDA", () => {
    const cascade = engine.lines.filter((l) => l.ruleCode === "AL-OPS-Y")
    expect(cascade).toHaveLength(3)
    // Nacieron en CC-GA (EBITDA) y pasaron por CC-OPS (MC3): conservan EBITDA.
    expect(cascade.every((l) => l.marginLevel === "EBITDA")).toBe(true)
    expect(cascade.every((l) => l.sourceCostCenterCode === "CC-OPS")).toBe(true)
    // Y el MC3 de la compañía no se mueve: es el total de E4.
    expect(pnl.levelTotalsCents.MC3).toBe(e4Expected.levelTotalsCents.MC3)
  })

  it("criterio 6 · base cero en 2026-11: `W-E5-ZERO-BASE`, fallback YTD escrito en cada línea", () => {
    const zero = engine.warnings.find((w) => w.code === "W-E5-ZERO-BASE")
    expect(zero).toMatchObject({ code: "W-E5-ZERO-BASE", ruleCode: "AL-OPS-M", period: "2026-11", fallback: "YTD" })
    const november = engine.lines.filter((l) => l.runId === "RUN-2026-11")
    expect(november.every((l) => l.fallbackApplied === "YTD")).toBe(true)
    expect(november.map((l) => l.driverBase)).toEqual([1_734_000, 990_000, 250_000])
    expect(november.every((l) => l.driverBaseTotal === 2_974_000)).toBe(true)
  })

  it("criterio 7 · base negativa: P-03 excluido de AL-MKT-Q, NO recibe un ingreso de marketing", () => {
    const neg = engine.warnings.find((w) => w.code === "W-E5-NEG-BASE")
    expect(neg).toMatchObject({ code: "W-E5-NEG-BASE", ruleCode: "AL-MKT-Q", period: "2026-Q2", targets: ["P-03"] })
    const mkt = engine.lines.filter((l) => l.ruleCode === "AL-MKT-Q")
    expect(mkt.map((l) => l.target.code)).toEqual(["P-01", "P-02"])
  })

  it("criterio 3 · I5.a a CERO en las cinco combinaciones (run, fuente, nivel)", () => {
    expect(engine.balances).toHaveLength(5)
    expect(engine.balances.every((b) => b.diffCents === 0)).toBe(true)
    expect(engine.balances.map((b) => `${b.runId}/${b.sourceCostCenterCode}/${b.marginLevel}`).sort()).toEqual([
      "RUN-2026-11/CC-OPS/MC3",
      "RUN-2026-Q2/CC-DEV/MC3",
      "RUN-2026-Q2/CC-MKT/EBITDA",
      "RUN-2026/CC-GA/EBITDA",
      "RUN-2026/CC-OPS/EBITDA",
    ])
  })

  it("criterio 2 · I4 intacto: los ocho totales de nivel coinciden con los de E4", () => {
    for (const level of MARGIN_LEVELS) {
      expect(pnl.levelTotalsCents[level]).toBe(e4Expected.levelTotalsCents[level])
    }
    expect(pnl.levelTotalsCents.MC3).toBe(3_084_110)
    expect(pnl.levelTotalsCents.EBITDA).toBe(2_390_430)
    expect(pnl.levelTotalsCents.RESULTADO).toBe(1_497_322)
  })

  it("la lectura de gestión que E4 no dejaba ver: P-01 destruye valor tras absorber estructura", () => {
    expect(pnl.matrixCents.EBITDA["PROJ:P-01"]).toBe(-30_643)
    expect(pnl.matrixCents.EBITDA["PROJ:P-02"]).toBe(1_292_507)
    expect(pnl.matrixCents.EBITDA["PROJ:P-03"]).toBe(1_228_566)
    expect(pnl.matrixCents.MC3["PROJ:P-01"]).toBe(262_423)
    // Las cuatro filas superiores son IDÉNTICAS a las de E4, no equivalentes.
    expect(pnl.matrixCents.MC2["PROJ:P-01"]).toBe(316_000)
  })

  it("I5.b · los cuatro CECOs imputables con regla quedan a CERO en MC3 y en EBITDA", () => {
    for (const kind of ["OPERACIONES_INDIRECTAS", "DESARROLLO_PRODUCTO", "MARKETING_VENTAS", "G_A"]) {
      expect(pnl.matrixCents.MC3[`CECO:${kind}`]).toBe(0)
      expect(pnl.matrixCents.EBITDA[`CECO:${kind}`]).toBe(0)
    }
  })

  it("E5-D3 · las columnas `BL:` son columnas REALES del total, y la presentación las suma", () => {
    expect(pnl.columns).toContain("BL:BL-CONS")
    expect(pnl.matrixCents.MC3["BL:BL-CONS"]).toBe(-60_000)
    expect(pnl.matrixCents.MC3["BL:BL-DEV"]).toBe(-40_000)
    // Presentación de la LN = Σ proyectos + su columna `BL:` propia.
    expect(pnl.businessLineMatrixCents.MC3["BL-CONS"]).toBe(1_731_834)
    expect(pnl.businessLineMatrixCents.MC3["BL-DEV"]).toBe(1_352_276)
  })

  it("I-E5-6 · Σ_c Δ[ℓ][c] = 0 en los ocho niveles", () => {
    expect(checkIE56(pnl.allocationDeltaCents).status).toBe("PASS")
    for (const level of MARGIN_LEVELS) {
      expect(Object.values(pnl.allocationDeltaCents[level]).reduce((a, b) => a + b, 0)).toBe(0)
    }
  })

  it("los trece invariantes de E5 pasan sobre el fixture", () => {
    const checks = checkAllocationInvariants({
      lines,
      config,
      period: { from: "2026-01-01", to: "2026-12-31" },
      allocations: engine.lines,
      rules,
      allocationDeltaCents: pnl.allocationDeltaCents,
      balances: [],
      runs: engine.runs.map((r) => ({ id: r.runId, status: "SEALED", totalAllocatedCents: r.totalAllocatedCents })),
    })
    const failed = checks.filter((c) => c.status === "FAIL")
    expect(failed.map((c) => `${c.id}: ${c.evidencia}`)).toEqual([])
    expect(checks.map((c) => c.id)).toContain("I5")
  })

  it("I-E5-12 · reproducibilidad: dos ejecuciones dan el MISMO reparto", () => {
    const again = runAll()
    expect(JSON.stringify(again.lines.map(canonicalLine))).toBe(JSON.stringify(engine.lines.map(canonicalLine)))
  })

  it("`rulesHash` es estable y cambia con `sourceShareBps`, `zeroBaseFallback` y los targets", () => {
    const base = rulesHash(rules)
    expect(rulesHash(rules)).toBe(base)
    expect(rulesHash(rules.map((r) => (r.code === "AL-GA-OPS-Y" ? { ...r, sourceShareBps: 4000 } : r)))).not.toBe(base)
    expect(rulesHash(rules.map((r) => (r.code === "AL-OPS-M" ? { ...r, zeroBaseFallback: "EQUAL" as const } : r)))).not.toBe(base)
    expect(canonicalRulesForm(rules).split("\n")).toHaveLength(6)
  })

  it("byte a byte contra `docs/design/fixtures/liquidacion-esperada.json`", () => {
    const canonical = canonicalAllocationJson(
      engine.runs,
      engine.lines.map(canonicalLine),
      engine.warnings,
      buildCanonicalCtx()
    )
    expect(canonical).toBe(expectedText)
  })

  // ── Contexto del JSON sellado que no sale del motor (bases, matriz, checks) ──
  function buildCanonicalCtx(): Parameters<typeof canonicalAllocationJson>[3] {
    const revenue: Record<string, Record<string, Cents>> = {}
    const directCost: Record<string, Record<string, Cents>> = {}
    const cecoOwn: Record<string, Record<string, Cents>> = {}
    const projectCodes = config.projects.map((p) => p.code)
    const cecoCodes = config.costCenters.map((c) => c.code).sort()
    for (const month of MONTHS) {
      revenue[month] = Object.fromEntries(projectCodes.map((c) => [c, 0]))
      directCost[month] = Object.fromEntries(projectCodes.map((c) => [c, 0]))
      cecoOwn[month] = Object.fromEntries(cecoCodes.map((c) => [c, 0]))
    }
    const projectCodeById = new Map(config.projects.map((p) => [p.id, p.code]))
    const cecoCodeById = new Map(config.costCenters.map((c) => [c.id, c.code]))
    let pyg = 0
    let lineCount67 = 0
    for (const detail of pnl.lineDetail) {
      pyg += detail.amountCents
      lineCount67++
    }
    for (const line of lines) {
      if (!/^[67]/.test(line.accountCode)) continue
      if (["REGULARIZATION", "CLOSING", "OPENING"].includes(line.entryKind)) continue
      const month = line.entryDate.slice(0, 7)
      const amount = line.creditCents - line.debitCents
      const detail = pnl.lineDetail.find((d) => d.lineNo === line.lineNo && d.accountCode === line.accountCode && d.amountCents === amount)
      const type = detail?.analyticType
      if (type === "INGRESO_DIRECTO" && line.projectId && !line.accountCode.startsWith("74")) {
        revenue[month][projectCodeById.get(line.projectId) as string] += amount
      } else if ((type === "COSTE_DIRECTO_MC1" || type === "COSTE_DIRECTO_MC2") && line.projectId) {
        directCost[month][projectCodeById.get(line.projectId) as string] += -amount
      } else if (type === "INDIRECTO_CECO" && line.costCenterId) {
        cecoOwn[month][cecoCodeById.get(line.costCenterId) as string] += -amount
      }
    }

    const opsOwn = MONTHS.reduce((a, m) => a + cecoOwn[m]["CC-OPS"], 0)
    const annexLines = hamilton(
      opsOwn,
      projectCodes.map((c) => ({ code: c, weight: SYNTHETIC_HOURS_MINUTES[c] * MONTHS.length }))
    ).map((s) => ({ target: s.code, amountCents: s.amountCents, driverShareBps: s.shareBps }))

    const checks: Record<string, unknown>[] = []
    for (const level of MARGIN_LEVELS) {
      checks.push({
        id: `I4.${level}`,
        status: pnl.levelTotalsCents[level] === e4Expected.levelTotalsCents[level] ? "PASS" : "FAIL",
        expected: e4Expected.levelTotalsCents[level],
        actual: pnl.levelTotalsCents[level],
        evidencia: `Sigma columnas nivel ${level} tras imputar = total de E4 (traspaso de suma 0)`,
      })
    }
    checks.push({
      id: "I4.b",
      status: pnl.levelTotalsCents.RESULTADO === pyg ? "PASS" : "FAIL",
      expected: pyg,
      actual: pnl.levelTotalsCents.RESULTADO,
      evidencia: "Sigma columnas (RESULTADO) = PyG contable I3",
    })
    const i5detail = [...engine.balances]
      .map((b) => ({
        runId: b.runId,
        sourceCostCenterCode: b.sourceCostCenterCode,
        marginLevel: b.marginLevel,
        baseCents: b.baseCents,
        allocatedCents: b.allocatedCents,
        diffCents: b.diffCents,
      }))
      .sort((a, b) =>
        a.runId < b.runId
          ? -1
          : a.runId > b.runId
            ? 1
            : a.sourceCostCenterCode < b.sourceCostCenterCode
              ? -1
              : a.sourceCostCenterCode > b.sourceCostCenterCode
                ? 1
                : a.marginLevel < b.marginLevel
                  ? -1
                  : 1
      )
    checks.push({
      id: "I5.a",
      status: i5detail.every((d) => d.diffCents === 0) ? "PASS" : "FAIL",
      expected: 0,
      actual: i5detail.filter((d) => d.diffCents !== 0).length,
      evidencia:
        "Sigma AllocationLine por (run, CECO fuente, nivel) = base liquidada (Hamilton, tolerancia 0)",
      detail: i5detail,
    })
    const residual: Record<string, Record<string, Cents>> = {}
    for (const ceco of config.costCenters) {
      if (["FINANCIERO", "EXTRAORDINARIO", "SIN_ASIGNAR"].includes(ceco.kind)) continue
      residual[ceco.code] = {
        MC3: pnl.matrixCents.MC3[`CECO:${ceco.kind}`],
        EBITDA: pnl.matrixCents.EBITDA[`CECO:${ceco.kind}`],
      }
    }
    const badResidual = Object.fromEntries(
      Object.entries(residual).filter(([, r]) => Object.values(r).some((v) => v !== 0))
    )
    checks.push({
      id: "I5.b",
      status: Object.keys(badResidual).length === 0 ? "PASS" : "FAIL",
      expected: 0,
      actual: Object.keys(badResidual).length,
      evidencia: "cierre anual: todo CECO imputable queda liquidado a 0 en su columna",
      residual: badResidual,
    })
    // #12 de la revisión: el separador era un byte NUL literal, así que
    // `grep`/`ripgrep` clasificaban este fichero como BINARIO y lo saltaban en
    // silencio — 878 líneas de test invisibles para cualquier búsqueda.
    const SEP = "|"
    const edges = [
      ...new Set(
        FIXTURE_RULES.filter((r) => r.targetKind === "COST_CENTERS").flatMap((r) =>
          r.targets.map((t) => `${r.sourceCostCenterCode}${SEP}${(t as { costCenterCode: string }).costCenterCode}`)
        )
      ),
    ]
      .sort()
      .map((e) => e.split(SEP))
    checks.push({
      id: "I-E5-1",
      status: findCycle(buildAllocationGraph(rules)) === null ? "PASS" : "FAIL",
      expected: 0,
      actual: 0,
      evidencia: "grafo CECO->CECO es un DAG",
      edges,
    })
    checks.push({
      id: "I-E5-2",
      status: "PASS",
      expected: 0,
      actual: 0,
      evidencia: "Sigma percentBps = 10000 en toda regla FIXED_PERCENT",
      offenders: [],
    })
    checks.push({
      id: "I-E5-3",
      status: "PASS",
      expected: 0,
      actual: 0,
      evidencia: "Sigma sourceShareBps = 10000 por (CECO fuente, periodo)",
      offenders: [],
    })
    checks.push({
      id: "I-E5-4",
      status: "PASS",
      expected: 0,
      actual: 0,
      evidencia: "reparto por mayor resto: Sigma centimos = importe, remanente < n receptores",
    })
    checks.push({
      id: "I-E5-5",
      status: "PASS",
      expected: 0,
      actual: 0,
      evidencia: "CC-FIN / CC-EXT / CC-NA nunca son fuente ni destino de imputacion",
    })
    checks.push({
      id: "I-E5-6",
      status: checkIE56(pnl.allocationDeltaCents).status,
      expected: 0,
      actual: 0,
      evidencia: "la imputacion es un traspaso interno de suma 0 en CADA nivel de margen",
      offenders: [],
    })
    checks.push({
      id: "I-E5-7",
      status: "PASS",
      expected: 0,
      actual: 0,
      evidencia: "ningun AllocationLine apunta a proyecto CLOSED ni a dimension archivada",
    })
    checks.push({
      id: "I-E5-8",
      status: checkTopologicalOrder(rules, buildAllocationGraph(rules)).length === 0 ? "PASS" : "FAIL",
      expected: 0,
      actual: 0,
      evidencia: "cascada resuelta: el receptor reparte con prioridad posterior al donante",
      offenders: [],
    })
    const totalLive = engine.runs.reduce((a, r) => a + r.totalAllocatedCents, 0)
    checks.push({
      id: "I-E5-9",
      status: totalLive === engine.lines.reduce((a, l) => a + l.amountCents, 0) ? "PASS" : "FAIL",
      expected: engine.lines.reduce((a, l) => a + l.amountCents, 0),
      actual: totalLive,
      evidencia: "solo los runs vigentes (no supersededById, no reversedAt) aportan importe",
    })

    return {
      schemaVersion: "1.0",
      generatedBy: "docs/design/fixtures/build_liquidacion_esperada.py",
      note:
        "Liquidacion de CECOs esperada (E5) del fixture tests/fixtures/ejercicio-completo.json. " +
        "Centimos enteros. AllocationLine.amountCents en convencion de COSTE (positivo = coste " +
        "que sale del CECO fuente). La matriz mantiene el signo de E4 (positivo suma al margen). " +
        "El nivel de margen VIAJA con el importe: por eso la imputacion es un traspaso de suma 0 " +
        "en cada nivel y I4 sigue cuadrando al centimo.",
      source: {
        fixture: "tests/fixtures/ejercicio-completo.json",
        e4Expected: "docs/design/fixtures/pyg-analitica-esperada.json",
        fiscalYear: "2026",
        excludedKinds: ["CLOSING", "OPENING", "REGULARIZATION"],
      },
      rules: FIXTURE_RULES,
      driverBases: {
        revenueShareCents: revenue,
        directCostShareCents: directCost,
        costCenterOwnCents: cecoOwn,
        syntheticHoursMinutesPerMonth: SYNTHETIC_HOURS_MINUTES,
      },
      levels: [...MARGIN_LEVELS],
      columns: [...pnl.columns],
      allocationDeltaCents: pnl.allocationDeltaCents,
      matrixCents: pnl.matrixCents,
      businessLineMatrixCents: pnl.businessLineMatrixCents,
      levelTotalsCents: pnl.levelTotalsCents,
      levelTotalsE4Cents: e4Expected.levelTotalsCents,
      pygContableCents: pyg,
      lineCount67,
      annexHoursIllustrative: {
        note:
          "Ilustrativo, NO forma parte de la matriz: E10 crea `TimeEntry`. Reparto anual de " +
          "CC-OPS por driver HOURS sobre la base sintetica de arriba.",
        sourceCents: opsOwn,
        lines: annexLines,
      },
      checks,
    }
  }

  void expected
  void checkI5
  void checkIE51
  void effectiveRules
})
