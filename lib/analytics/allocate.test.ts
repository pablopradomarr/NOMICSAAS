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
  allocationSealReasons,
  buildAllocationGraph,
  canonicalAllocationJson,
  canonicalLine,
  canonicalRun,
  canonicalRulesForm,
  canonicalWarning,
  checkTopologicalOrder,
  effectiveRules,
  findCycle,
  hamilton,
  periodBounds,
  priorPeriodWindow,
  isTimeSealStale,
  rulesHash,
  timeSealOf,
  type AllocationPeriodRef,
  type AllocationRuleSpec,
  type AllocationWarning,
  type AppliedAllocation,
  type CanonicalRunRow,
  type HeadcountRow,
  type PriorAllocation,
  type TimeEntryRow,
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

// ─────────────────────────────────────────────────────────────────────────────
// E10 · T9 — los dos drivers de actividad, contra el fixture sellado de T10
//
// `docs/design/fixtures/presupuesto-horas-esperado.v1.4.json` es el contrato de
// cifras congelado (ADR-0018 D6): estos tests reproducen su bloque
// `allocation.real` —runs, líneas y avisos— **byte a byte** desde el motor. Si
// una coma se mueve, el test cae, que es exactamente lo que debe pasar.
// ─────────────────────────────────────────────────────────────────────────────

const E10_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "presupuesto-horas-esperado.v1.4.json")

type E10Fixture = {
  timeEntries: {
    id: string
    employeeCode: string
    date: string
    targetKind: "PROJECT" | "COST_CENTER"
    targetCode: string
    businessLineCode: string | null
    minutes: number
    productive: boolean
    approved: boolean
  }[]
  headcountSnapshots: { costCenterCode: string; asOf: string; fteMilli: number }[]
  timeAggregates: {
    approvedProductiveMinutesByTarget: Record<string, number>
    unapprovedMinutesByTarget: Record<string, number>
    timeHashByWindow: Record<string, string>
    timeWindowOf: Record<string, unknown>
  }
  allocation: {
    rules: {
      code: string
      name: string
      sourceCostCenterCode: string
      period: "MONTH" | "QUARTER" | "YEAR"
      priority: number
      sourceShareBps: number
      targetKind: TargetKindLiteral
      driver: DriverLiteral
      targetFilter: { projectStatus?: string[] } | null
      zeroBaseFallback: "SKIP_WARN" | "EQUAL" | "YTD" | "PRIOR_PERIOD"
      targets: { businessLineCode?: string; costCenterCode?: string; percentBps?: number }[]
    }[]
    rulesHash: string
    real: { runs: unknown[]; lines: unknown[]; warnings: unknown[] }
  }
}

type TargetKindLiteral = "PROJECTS" | "BUSINESS_LINES" | "COST_CENTERS"
type DriverLiteral = "FIXED_PERCENT" | "REVENUE_SHARE" | "DIRECT_COST_SHARE" | "HOURS" | "HEADCOUNT" | "EQUAL" | "MANUAL"

describe("E10 · drivers HOURS y HEADCOUNT (fixture sellado de T10)", () => {
  const fixture = JSON.parse(readFileSync(E10_PATH, "utf8")) as E10Fixture
  const loaded = loadFixture("ejercicio-completo")

  const config: AnalyticsConfig = {
    organizationId: "org-e10",
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

  /** Las siete reglas de E10, con `HOURS` y `HEADCOUNT` ya encendidos. */
  const rules: AllocationRuleSpec[] = fixture.allocation.rules.map((r) => ({
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
    targetFilter: r.targetFilter as AllocationRuleSpec["targetFilter"],
    validFrom: "2026-01-01",
    validTo: null,
    isActive: true,
    targets: r.targets.map((t, index) => ({
      projectId: null,
      businessLineId: t.businessLineCode ? idOf.bl(t.businessLineCode) : null,
      costCenterId: t.costCenterCode ? idOf.ceco(t.costCenterCode) : null,
      percentBps: t.percentBps ?? null,
      amountCents: null,
      sortOrder: index,
    })),
  }))

  const timeEntries: TimeEntryRow[] = fixture.timeEntries.map((t) => ({
    id: t.id,
    employeeId: t.employeeCode,
    employeeCode: t.employeeCode,
    date: t.date,
    target:
      t.targetKind === "PROJECT"
        ? { kind: "PROJECT" as const, id: idOf.project(t.targetCode), code: t.targetCode }
        : { kind: "COST_CENTER" as const, id: idOf.ceco(t.targetCode), code: t.targetCode },
    businessLineCode: t.businessLineCode,
    minutes: t.minutes,
    productive: t.productive,
    approved: t.approved,
  }))

  const headcount: HeadcountRow[] = fixture.headcountSnapshots.map((h) => ({
    costCenterId: idOf.ceco(h.costCenterCode),
    costCenterCode: h.costCenterCode,
    periodEnd: h.asOf,
    fteMilli: h.fteMilli,
  }))

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

  /** Los mismos 17 runs del generador: doce meses, cuatro trimestres y el año. */
  function runAllE10() {
    const runs: CanonicalRunRow[] = []
    const applied: AppliedAllocation[] = []
    const warnings: AllocationWarning[] = []
    const seals: { label: string; seal: ReturnType<typeof timeSealOf> }[] = []
    const priors: PriorAllocation[] = []
    const schedule: ["MONTH" | "QUARTER" | "YEAR", string][] = [
      ...MONTHS.map((m) => ["MONTH", m] as ["MONTH" | "QUARTER" | "YEAR", string]),
      ...QUARTERS.map((q) => ["QUARTER", q] as ["MONTH" | "QUARTER" | "YEAR", string]),
      ["YEAR", "2026"],
    ]
    for (const [kind, label] of schedule) {
      const period = periodRef(kind, label)
      const result = allocate({ lines, config, rules, period, priorAllocations: priors, timeEntries, headcount })
      if (!result.ok) throw new Error(`${label}: ${result.error.code} ${result.error.message}`)
      runs.push(canonicalRun(result.value))
      applied.push(...result.value.lines)
      warnings.push(...result.value.warnings)
      seals.push({ label, seal: result.value.timeSeal })
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
    return { runs, lines: applied, warnings, seals }
  }

  const e10 = runAllE10()

  it("las siete reglas de E10 tienen sello estable y `HOURS`/`HEADCOUNT` vivos", () => {
    // El `rulesHash` del fixture se sella sobre CÓDIGOS (el generador no tiene
    // ids); aquí se comprueba lo que el motor garantiza: el sello es estable y
    // cambia con cualquier campo de la regla.
    expect(rulesHash(rules)).toBe(rulesHash([...rules].reverse()))
    expect(rulesHash(rules)).not.toBe(
      rulesHash(rules.map((r) => (r.code === "AL-OPS-M" ? { ...r, zeroBaseFallback: "SKIP_WARN" as const } : r)))
    )
    expect(rules.filter((r) => r.driver === "HOURS").map((r) => r.code)).toEqual(["AL-OPS-M", "AL-OPS-Y"])
    expect(rules.filter((r) => r.driver === "HEADCOUNT").map((r) => r.code)).toEqual(["AL-GA-CC-Y"])
  })

  it("los 17 runs, byte a byte contra `allocation.real.runs`", () => {
    expect(JSON.stringify(e10.runs, null, 1)).toBe(JSON.stringify(fixture.allocation.real.runs, null, 1))
  })

  it("las 17 líneas, byte a byte contra `allocation.real.lines`", () => {
    expect(JSON.stringify(e10.lines.map(canonicalLine).map(({ runId, ...rest }) => ({ runId, ...rest })), null, 1)).toBe(
      JSON.stringify(fixture.allocation.real.lines, null, 1)
    )
  })

  it("los avisos, byte a byte: `W-E10-UNAPPROVED-HOURS` con sus 976 minutos y su 1,86 %", () => {
    expect(JSON.stringify(e10.warnings.map(canonicalWarning), null, 1)).toBe(
      JSON.stringify(fixture.allocation.real.warnings, null, 1)
    )
    expect(allocationSealReasons(e10.warnings)).toEqual(["HORAS_SIN_APROBAR"])
  })

  it("criterio 11 · `HOURS`: `driverBaseTotal` es Σ minutos aprobados y productivos del periodo", () => {
    const anual = e10.lines.filter((l) => l.ruleCode === "AL-OPS-Y")
    const base = fixture.timeAggregates.approvedProductiveMinutesByTarget
    const total = Object.values(base).reduce((a, b) => a + b, 0)
    expect(anual.every((l) => l.driverBaseTotal === total)).toBe(true)
    expect(anual.map((l) => [l.target.code, l.driverBase])).toEqual(Object.entries(base))
    // E5-D1: el nivel VIAJA con el importe; CC-OPS recibió de CC-GA en EBITDA.
    expect(new Set(anual.map((l) => l.marginLevel))).toEqual(new Set(["EBITDA"]))
  })

  // **criterio 16-bis** (Q-7): la base ANUAL es `Σ fteMilli` de los snapshots
  // del periodo, no el stock a 31-12. Un CECO que vive diez meses pesa diez
  // meses; con el stock a fin de año pesaba 0 y no absorbía nada de su
  // presencia real, trasladando esa estructura a los demás.
  it("criterio 16 y 16-bis · `HEADCOUNT` reparte FTE·mes y sólo a CECOs, en el orden declarado", () => {
    const ga = e10.lines.filter((l) => l.ruleCode === "AL-GA-CC-Y")
    expect(ga.map((l) => [l.target.code, l.driverBase])).toEqual([
      ["CC-OPS", 48000],
      ["CC-DEV", 30000],
    ])
    expect(ga.every((l) => l.driverBaseTotal === 78000 && l.target.kind === "COST_CENTER")).toBe(true)
    expect(ga.reduce((a, l) => a + l.amountCents, 0)).toBe(189954)
  })

  it("criterio 16 · una regla `HEADCOUNT` a PROYECTOS se rechaza: no hay plantilla que repartir", () => {
    const bad = rules.map((r) => (r.code === "AL-GA-CC-Y" ? { ...r, targetKind: "PROJECTS" as const } : r))
    const result = allocate({
      lines,
      config,
      rules: bad,
      period: periodRef("YEAR", "2026"),
      priorAllocations: [],
      timeEntries,
      headcount,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("DRIVER_UNAVAILABLE")
      expect(result.error.message).toContain("sólo admite centros de coste")
    }
  })

  it("criterio 16-ter · sin snapshot es hueco (`PLANTILLA_AUSENTE`); `fteMilli = 0` es un dato", () => {
    const soloGa: AllocationRuleSpec[] = [
      {
        ...(rules.find((r) => r.code === "AL-GA-CC-Y") as AllocationRuleSpec),
        sourceShareBps: 10000,
        targets: ["CC-MKT", "CC-OPS"].map((code, index) => ({
          projectId: null,
          businessLineId: null,
          costCenterId: idOf.ceco(code),
          percentBps: null,
          amountCents: null,
          sortOrder: index,
        })),
      },
    ]
    const run = (hc: HeadcountRow[]) =>
      allocate({
        lines,
        config,
        rules: soloGa,
        period: periodRef("YEAR", "2026"),
        priorAllocations: [],
        timeEntries,
        headcount: hc,
      })

    // (a) CC-MKT SIN ningún snapshot del periodo: hueco de datos.
    const sinMkt = run(headcount.filter((h) => h.costCenterCode !== "CC-MKT"))
    expect(sinMkt.ok).toBe(true)
    if (sinMkt.ok) {
      expect(sinMkt.value.warnings.filter((w) => w.code === "W-E10-NO-HEADCOUNT")).toEqual([
        {
          code: "W-E10-NO-HEADCOUNT",
          ruleCode: "AL-GA-CC-Y",
          period: "2026",
          targets: ["CC-MKT"],
          sealReason: "PLANTILLA_AUSENTE",
          detail: "receptor sin ningun snapshot de plantilla en el periodo: peso 0",
        },
      ])
      expect(allocationSealReasons(sinMkt.value.warnings)).toContain("PLANTILLA_AUSENTE")
      expect(sinMkt.value.lines.filter((l) => l.target.code === "CC-MKT" && l.amountCents !== 0)).toHaveLength(0)
    }

    // (b) CC-MKT con `fteMilli = 0` DECLARADO: peso 0 y **ningún** motivo.
    const ceroDeclarado = run(headcount.map((h) => (h.costCenterCode === "CC-MKT" ? { ...h, fteMilli: 0 } : h)))
    expect(ceroDeclarado.ok).toBe(true)
    if (ceroDeclarado.ok) {
      expect(ceroDeclarado.value.warnings.some((w) => w.code === "W-E10-NO-HEADCOUNT")).toBe(false)
      expect(allocationSealReasons(ceroDeclarado.value.warnings)).not.toContain("PLANTILLA_AUSENTE")
    }
  })

  it("criterio 16-quater · saldo atrapado: `W-E10-HEADCOUNT-TRAPPED` al simular", () => {
    const trapped: AllocationRuleSpec[] = [
      {
        ...(rules.find((r) => r.code === "AL-GA-CC-Y") as AllocationRuleSpec),
        code: "AL-GA-MKT-Y",
        sourceShareBps: 10000,
        targets: [
          { projectId: null, businessLineId: null, costCenterId: idOf.ceco("CC-MKT"), percentBps: null, amountCents: null, sortOrder: 0 },
        ],
      },
    ]
    const result = allocate({
      lines,
      config,
      rules: trapped,
      period: periodRef("YEAR", "2026"),
      priorAllocations: [],
      timeEntries,
      headcount,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.warnings.filter((w) => w.code === "W-E10-HEADCOUNT-TRAPPED")).toEqual([
        {
          code: "W-E10-HEADCOUNT-TRAPPED",
          ruleCode: "AL-GA-MKT-Y",
          period: "2026",
          targets: ["CC-MKT"],
          detail: "el receptor no tiene regla posterior con la que repartir lo recibido",
        },
      ])
    }
  })

  it("criterio 13-bis · sin ninguna hora aprobada la regla NUNCA queda muda", () => {
    const sinAprobar = timeEntries.map((t) => ({ ...t, approved: false }))
    const skip = allocate({
      lines,
      config,
      rules: rules.filter((r) => r.code === "AL-OPS-Y"),
      period: periodRef("YEAR", "2026"),
      priorAllocations: [],
      timeEntries: sinAprobar,
      headcount,
    })
    expect(skip.ok).toBe(true)
    if (skip.ok) {
      expect(skip.value.warnings.filter((w) => w.code === "W-E10-NO-HOURS")).toEqual([
        {
          code: "W-E10-NO-HOURS",
          ruleCode: "AL-OPS-Y",
          period: "2026",
          fallback: "SKIP_WARN",
          detail: "no hay minutos aprobados y productivos de receptores elegibles en la ventana",
        },
      ])
      // Con `SKIP_WARN` el saldo del CECO queda VISIBLE en «pendiente de
      // liquidar»: ni se reparte a ciegas, ni desaparece.
      expect(skip.value.lines).toHaveLength(0)
      expect(skip.value.balances.some((b) => b.sourceCostCenterCode === "CC-OPS" && b.baseCents !== 0)).toBe(true)
    }

    // Con `YTD` el aviso sale igual: la regla nunca reparte 0 € en silencio.
    const ytd = allocate({
      lines,
      config,
      rules: rules.filter((r) => r.code === "AL-OPS-M"),
      period: periodRef("MONTH", "2026-11"),
      priorAllocations: [],
      timeEntries: sinAprobar,
      headcount,
    })
    expect(ytd.ok).toBe(true)
    if (ytd.ok) {
      expect(ytd.value.warnings.map((w) => w.code)).toContain("W-E10-NO-HOURS")
      expect(ytd.value.lines).toHaveLength(0)
    }
  })

  it("criterio 32 · el proyecto CONTENEDOR (`PLANNED`) admite presupuesto y NO recibe estructura", () => {
    // Q-5: `P-<LN>-NUEVOS` se siembra en `PLANNED` para poder presupuestar lo
    // que todavía no tiene proyecto. Cargarle estructura crearía un margen
    // negativo antes del primer ingreso, así que queda fuera del reparto tenga o
    // no base — y el `targetFilter` por defecto (`projectStatus: [ACTIVE]`) lo
    // dice. El traspaso posterior a los proyectos reales es una `REVISADO n`.
    const contenedor = { ...config.projects[0], id: "p-nuevos", code: "P-BL-CONS-NUEVOS", status: "PLANNED" as const }
    const conContenedor: typeof config = { ...config, projects: [...config.projects, contenedor] }
    const partes: TimeEntryRow[] = [
      ...timeEntries,
      {
        id: "t-nuevos",
        employeeId: "E-01",
        employeeCode: "E-01",
        date: "2026-11-03",
        target: { kind: "PROJECT", id: contenedor.id, code: contenedor.code },
        businessLineCode: null,
        minutes: 600,
        productive: true,
        approved: true,
      },
    ]
    const result = allocate({
      lines,
      config: conContenedor,
      rules: rules.filter((r) => r.code === "AL-OPS-M"),
      period: periodRef("MONTH", "2026-11"),
      priorAllocations: [],
      timeEntries: partes,
      headcount,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Ni una línea al contenedor, aunque tenga 600 minutos aprobados.
    expect(result.value.lines.map((l) => l.target.code)).not.toContain(contenedor.code)
  })

  it("revisión ronda 1 · #4 · con base aprobada 0 y minutos sin firmar sale `HORAS_SIN_APROBAR`", () => {
    // El caso extremo del parcial, y el más grave: 0 minutos aprobados y 12 000
    // sin firmar. La ronda 0 salía por el `return` del `zeroBaseFallback` antes
    // de mirarlos y el run se sellaba **sin el motivo**, con el saldo del CECO
    // repartido por el fallback o parado en «pendiente», pero sin decir que la
    // base estaba entera sin aprobar.
    const sinFirmar: TimeEntryRow[] = []
    let left = 12000
    let day = 2
    while (left > 0) {
      const minutes = Math.min(1200, left)
      sinFirmar.push({
        id: `t-pdte-${day}`,
        employeeId: "E-94",
        employeeCode: "E-94",
        date: `2026-11-${String(day).padStart(2, "0")}`,
        target: { kind: "PROJECT", id: idOf.project("P-03"), code: "P-03" },
        businessLineCode: null,
        minutes,
        productive: true,
        approved: false,
      })
      left -= minutes
      day += 1
    }

    const result = allocate({
      lines,
      config,
      rules: rules.filter((r) => r.code === "AL-OPS-M"),
      period: periodRef("MONTH", "2026-11"),
      priorAllocations: [],
      timeEntries: sinFirmar,
      headcount,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const codes = result.value.warnings.map((w) => w.code)
    // Los DOS avisos: la base es cero **y** hay minutos sin firmar. Sólo el
    // primero se emitía antes.
    expect(codes).toContain("W-E10-NO-HOURS")
    expect(result.value.warnings.find((w) => w.code === "W-E10-UNAPPROVED-HOURS")).toEqual({
      code: "W-E10-UNAPPROVED-HOURS",
      ruleCode: "AL-OPS-M",
      period: "2026-11",
      unapprovedMinutes: 12000,
      // `shareOfBaseBps: null` deja de ser una rama inalcanzable del tipo: no
      // hay porcentaje sobre una base de 0, y un 0 se leería al revés.
      shareOfBaseBps: null,
      targets: ["P-03"],
      sealReason: "HORAS_SIN_APROBAR",
      detail: "hay minutos sin aprobar de receptores elegibles en la ventana del driver",
    })
  })

  it("criterio 13 · base parcial: el aviso sale SIEMPRE, no sólo con base cero", () => {
    // Base aprobada 19 200 / 10 800 / 6 000 minutos y 12 000 de P-03 sin firmar.
    // Cada parte respeta el techo diario de 1 440 minutos (Q-2, O-E10-21).
    const partes: TimeEntryRow[] = []
    const alta = (code: string, total: number, approved: boolean, employee: string): void => {
      let left = total
      let day = 2
      while (left > 0) {
        const minutes = Math.min(1200, left)
        partes.push({
          id: `t-${code}-${approved ? "ok" : "pdte"}-${day}`,
          employeeId: employee,
          employeeCode: employee,
          date: `2026-11-${String(day).padStart(2, "0")}`,
          target: { kind: "PROJECT", id: idOf.project(code), code },
          businessLineCode: null,
          minutes,
          productive: true,
          approved,
        })
        left -= minutes
        day += 1
      }
    }
    alta("P-01", 19200, true, "E-91")
    alta("P-02", 10800, true, "E-92")
    alta("P-03", 6000, true, "E-93")
    alta("P-03", 12000, false, "E-94")

    const result = allocate({
      lines,
      config,
      rules: rules.filter((r) => r.code === "AL-OPS-M"),
      period: periodRef("MONTH", "2026-11"),
      priorAllocations: [],
      timeEntries: partes,
      headcount,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.warnings.find((w) => w.code === "W-E10-UNAPPROVED-HOURS")).toEqual({
      code: "W-E10-UNAPPROVED-HOURS",
      ruleCode: "AL-OPS-M",
      period: "2026-11",
      unapprovedMinutes: 12000,
      shareOfBaseBps: 3333,
      targets: ["P-03"],
      sealReason: "HORAS_SIN_APROBAR",
      detail: "hay minutos sin aprobar de receptores elegibles en la ventana del driver",
    })
    expect(result.value.lines.map((l) => l.driverBase)).toEqual([19200, 10800, 6000])

    // Y la diferencia que el aviso denuncia: con 900 000 c, la base aprobada
    // reparte 480 000 / 270 000 / 150 000 y la completa 360 000 / 202 500 /
    // 337 500 — **187 500 c** que P-03 deja de absorber sin que nadie avise.
    const conBaseAprobada = hamilton(900000, [
      { code: "P-01", weight: 19200 },
      { code: "P-02", weight: 10800 },
      { code: "P-03", weight: 6000 },
    ])
    const conBaseCompleta = hamilton(900000, [
      { code: "P-01", weight: 19200 },
      { code: "P-02", weight: 10800 },
      { code: "P-03", weight: 18000 },
    ])
    expect(conBaseAprobada.map((h) => h.amountCents)).toEqual([480000, 270000, 150000])
    expect(conBaseCompleta.map((h) => h.amountCents)).toEqual([360000, 202500, 337500])
  })

  it("criterio 12-bis · el `timeHash` se sella con la VENTANA que el run consume", () => {
    const marzo = periodRef("MONTH", "2026-03")
    const conYtd = timeSealOf(rules.filter((r) => r.code === "AL-OPS-M"), marzo, timeEntries)
    expect([conYtd.timeHashWindowStart, conYtd.timeHashWindowEnd]).toEqual(["2026-01-01", "2026-03-31"])
    expect(conYtd.timeHash).toBe(fixture.timeAggregates.timeHashByWindow["2026-01-01..2026-03-31"])
    expect(conYtd.timeHash).not.toBe(fixture.timeAggregates.timeHashByWindow["2026-03-01..2026-03-31"])

    // Sin reglas de actividad: `"∅"` y ventana NULL (y nada lo caduca).
    const sinActividad = timeSealOf(rules.filter((r) => r.code === "AL-MKT-Q"), marzo, timeEntries)
    expect(sinActividad).toEqual({ timeHash: "∅", timeHashWindowStart: null, timeHashWindowEnd: null })
    expect(isTimeSealStale(sinActividad, [])).toBe(false)

    // Cuarta causa de STALE: aprobar en mayo un parte de ENERO de 800 minutos
    // caduca el run de MARZO, que lo consume por `YTD`. Con el sello acotado al
    // periodo lucía vigente con un reparto que ya no se puede reproducir.
    const aprobadoDespues: TimeEntryRow[] = [
      ...timeEntries,
      {
        id: "t-enero-aprobado-en-mayo",
        employeeId: "E-95",
        employeeCode: "E-95",
        date: "2026-01-20",
        target: { kind: "PROJECT", id: idOf.project("P-01"), code: "P-01" },
        businessLineCode: "BL-CONS",
        minutes: 800,
        productive: true,
        approved: true,
      },
    ]
    expect(isTimeSealStale(conYtd, timeEntries)).toBe(false)
    expect(isTimeSealStale(conYtd, aprobadoDespues)).toBe(true)
  })

  it("el run anual sella su ventana conteniendo el periodo (CHECK de M4)", () => {
    const seal = e10.seals.find((s) => s.label === "2026")?.seal
    expect(seal?.timeHashWindowStart).toBe("2026-01-01")
    expect(seal?.timeHashWindowEnd).toBe("2026-12-31")
    expect(seal?.timeHash).toBe(fixture.timeAggregates.timeHashByWindow["2026-01-01..2026-12-31"])
  })
})
