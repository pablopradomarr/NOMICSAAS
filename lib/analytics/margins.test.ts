/**
 * E4 · T5/T7/T8 — `lib/analytics/margins.ts`.
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md): vacío, un registro,
 * importes negativos, fechas límite y redondeo. Y el que sella la épica: la
 * matriz del fixture completo, **byte a byte** contra
 * `docs/design/fixtures/pyg-analitica-esperada.json` (criterio 8 de §8.1).
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { defaultMarginLevels } from "@/lib/analytics/seed"
import {
  buildAnalyticPnl,
  buildMatrixView,
  canonicalAnalyticPnlJson,
  cellQuery,
  classifyLine,
  contribution,
  marginBps,
  pnlContableCents,
  resolveColumn,
  resolveDestination,
  resolveEffectiveAnalyticType,
  resolveLevel,
} from "@/lib/analytics/margins"
import type { AnalyticLine, AnalyticsConfig, AnalyticType, MarginLevelRow } from "@/lib/analytics/types"
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import type { ProvenanceContext } from "@/lib/ledger/provenance"
import { loadFixture, planForVariant } from "@/tests/support/fixtures"

const PROV: ProvenanceContext = {
  runId: "run-test",
  ledgerHash: "0".repeat(64),
  gitSha: "c0e828f",
  baseCurrency: "EUR",
  module: "lib/analytics/margins.ts",
}

const LEVELS: MarginLevelRow[] = defaultMarginLevels().map((l) => ({
  level: l.level,
  label: l.label,
  analyticTypes: l.analyticTypes,
  sortOrder: l.sortOrder,
  isVisible: true,
  validFrom: "1970-01-01",
  validTo: null,
}))

const plan = planForVariant("PYMES")
const analyticTypeByAccount = new Map<string, AnalyticType | null>(
  [...plan.byCode.entries()].map(([code, a]) => [code, a.analyticType])
)

function configOf(over: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    organizationId: "org-test",
    levels: LEVELS,
    businessLines: [{ id: "bl-1", code: "BL-CONS", name: "Consultoría", sortOrder: 1, isActive: true }],
    projects: [
      { id: "p-1", code: "P-01", name: "Alfa", businessLineId: "bl-1", status: "ACTIVE", sortOrder: 1, isActive: true },
    ],
    costCenters: [
      { id: "cc-ga", code: "CC-GA", name: "G&A", kind: "G_A", marginLevel: "EBITDA", allocatable: true, sortOrder: 1, isActive: true },
      { id: "cc-ops", code: "CC-OPS", name: "Ops", kind: "OPERACIONES_INDIRECTAS", marginLevel: "MC3", allocatable: true, sortOrder: 2, isActive: true },
      { id: "cc-fin", code: "CC-FIN", name: "Financiero", kind: "FINANCIERO", marginLevel: "EBITDA", allocatable: false, sortOrder: 3, isActive: true },
      { id: "cc-na", code: "CC-NA", name: "Sin asignar", kind: "SIN_ASIGNAR", marginLevel: "EBITDA", allocatable: false, sortOrder: 4, isActive: true, isSystem: true },
    ],
    unassignedCostCenterId: "cc-na",
    analyticTypeByAccount,
    incomeTaxPrefixes: INCOME_TAX_PREFIXES,
    nonAnalyticLevel: "EBITDA",
    analyticsRequired: true,
    ...over,
  }
}

function lineOf(over: Partial<AnalyticLine> = {}): AnalyticLine {
  return {
    entryId: "e-1",
    entryNumber: 1,
    entryDate: "2026-03-10",
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "705",
    debitCents: 0,
    creditCents: 100000,
    analyticType: "INGRESO_DIRECTO",
    projectId: "p-1",
    costCenterId: null,
    businessLineId: "bl-1",
    ...over,
  }
}

const PERIOD = { from: "2026-01-01", to: "2026-12-31" }

// ─────────────────────────────────────────────────────────────────────────────

describe("resolveEffectiveAnalyticType (R-A2/R-A3/R-A4)", () => {
  const config = { analyticTypeByAccount }

  it("el override explícito manda sobre todo", () => {
    expect(
      resolveEffectiveAnalyticType({ accountCode: "705", analyticType: "NO_ANALITICO", projectId: "p-1" }, config)
    ).toBe("NO_ANALITICO")
  })

  it("herencia de hoja: 6080 hereda de 608 y 6300 de 630", () => {
    expect(resolveEffectiveAnalyticType({ accountCode: "6080" }, config)).toBe("COSTE_DIRECTO_MC1")
    expect(resolveEffectiveAnalyticType({ accountCode: "6300" }, config)).toBe("NO_ANALITICO")
  })

  it("R-A3: INDIRECTO_CECO + projectId ⇒ COSTE_DIRECTO_MC2, nunca MC3", () => {
    expect(resolveEffectiveAnalyticType({ accountCode: "623" }, config)).toBe("INDIRECTO_CECO")
    expect(resolveEffectiveAnalyticType({ accountCode: "623", projectId: "p-1" }, config)).toBe("COSTE_DIRECTO_MC2")
  })

  it("R-A4: tipo directo + costCenterId ⇒ INDIRECTO_CECO", () => {
    expect(resolveEffectiveAnalyticType({ accountCode: "640" }, config)).toBe("COSTE_DIRECTO_MC2")
    expect(resolveEffectiveAnalyticType({ accountCode: "640", costCenterId: "cc-ga" }, config)).toBe("INDIRECTO_CECO")
  })

  it("una cuenta sin tipo ni ancestro con tipo devuelve null", () => {
    expect(resolveEffectiveAnalyticType({ accountCode: "572" }, config)).toBeNull()
  })
})

describe("resolveLevel (R-A5/R-A6/R-A7/R-A11)", () => {
  const config = configOf()

  it("INDIRECTO_CECO cae en el marginLevel de SU CECO", () => {
    expect(resolveLevel(lineOf({ analyticType: "INDIRECTO_CECO", projectId: null, businessLineId: null, costCenterId: "cc-ops" }), config)).toBe("MC3")
    expect(resolveLevel(lineOf({ analyticType: "INDIRECTO_CECO", projectId: null, businessLineId: null, costCenterId: "cc-ga" }), config)).toBe("EBITDA")
  })

  it("R-A6: un 668 en CC-FIN (marginLevel EBITDA) cae en BAI — manda el tipo", () => {
    const line = lineOf({ accountCode: "668", analyticType: "FINANCIERO", projectId: null, businessLineId: null, costCenterId: "cc-fin" })
    expect(resolveLevel(line, config)).toBe("BAI")
    expect(resolveColumn(line, config)).toBe("FINANCIERO")
  })

  it("R-A11: 630 va a RESULTADO y no es configurable; 74x a nonAnalyticLevel", () => {
    const tax = lineOf({ accountCode: "6300", analyticType: "NO_ANALITICO", projectId: null, businessLineId: null })
    expect(resolveLevel(tax, config)).toBe("RESULTADO")
    const subsidy = lineOf({ accountCode: "740", analyticType: "NO_ANALITICO", projectId: null, businessLineId: null })
    expect(resolveLevel(subsidy, config)).toBe("EBITDA")
    expect(resolveLevel(subsidy, configOf({ nonAnalyticLevel: "BAI" }))).toBe("BAI")
  })

  it("un CECO con marginLevel fuera de {MC3, EBITDA} bloquea el informe", () => {
    const broken = configOf({
      costCenters: [{ id: "cc-x", code: "CC-X", name: "X", kind: "OTROS", marginLevel: "MC1" as never, allocatable: true, sortOrder: 1, isActive: true }],
    })
    expect(() =>
      resolveLevel(lineOf({ analyticType: "INDIRECTO_CECO", projectId: null, businessLineId: null, costCenterId: "cc-x" }), broken)
    ).toThrow(/marginLevel/)
  })
})

describe("resolveColumn (R-A5)", () => {
  const config = configOf()

  it("AMORTIZACION_DETERIORO con proyecto va a la columna del proyecto, nivel EBIT", () => {
    const line = lineOf({ accountCode: "681", analyticType: "AMORTIZACION_DETERIORO" })
    expect(resolveColumn(line, config)).toBe("PROJ:P-01")
    expect(resolveLevel(line, config)).toBe("EBIT")
  })

  it("AMORTIZACION_DETERIORO con CECO va a su columna propia, no a la del CECO", () => {
    const line = lineOf({ accountCode: "681", analyticType: "AMORTIZACION_DETERIORO", projectId: null, businessLineId: null, costCenterId: "cc-ga" })
    expect(resolveColumn(line, config)).toBe("AMORTIZACION_DETERIORO")
    expect(resolveLevel(line, config)).toBe("EBIT")
  })

  it("los CECOs se agrupan por kind, no uno por CECO", () => {
    const line = lineOf({ analyticType: "INDIRECTO_CECO", projectId: null, businessLineId: null, costCenterId: "cc-ops" })
    expect(resolveColumn(line, config)).toBe("CECO:OPERACIONES_INDIRECTAS")
  })
})

describe("aporte, PyG contable y márgenes", () => {
  it("aporte = haber − debe: ingreso +, gasto −", () => {
    expect(contribution({ debitCents: 0, creditCents: 100000 })).toBe(100000)
    expect(contribution({ debitCents: 100000, creditCents: 0 })).toBe(-100000)
  })

  it("caso vacío: PyG contable 0 y matriz de ceros, sin error", () => {
    expect(pnlContableCents([])).toBe(0)
    const pnl = buildAnalyticPnl([], configOf(), PERIOD, PROV)
    expect(pnl.levelTotalsCents.RESULTADO).toBe(0)
    expect(pnl.lineCount67).toBe(0)
    expect(pnl.checks.every((c) => c.status === "PASS")).toBe(true)
  })

  it("un registro: la única celda con importe es la suya", () => {
    const pnl = buildAnalyticPnl([lineOf()], configOf(), PERIOD, PROV)
    expect(pnl.matrixCents.INGRESOS["PROJ:P-01"]).toBe(100000)
    expect(pnl.levelTotalsCents.INGRESOS).toBe(100000)
    // La matriz es cumulativa: el ingreso sigue ahí en RESULTADO.
    expect(pnl.levelTotalsCents.RESULTADO).toBe(100000)
  })

  it("importes negativos (gasto) restan y la matriz cuadra con I3", () => {
    const lines = [lineOf(), lineOf({ lineNo: 2, accountCode: "607", analyticType: "COSTE_DIRECTO_MC1", debitCents: 30000, creditCents: 0 })]
    const pnl = buildAnalyticPnl(lines, configOf(), PERIOD, PROV)
    expect(pnl.matrixCents.MC1["PROJ:P-01"]).toBe(70000)
    expect(pnl.levelTotalsCents.RESULTADO).toBe(pnlContableCents(lines))
  })

  it("los asientos de regularización, cierre y apertura quedan fuera (I3)", () => {
    for (const kind of ["REGULARIZATION", "CLOSING", "OPENING"] as const) {
      expect(pnlContableCents([lineOf({ entryKind: kind })])).toBe(0)
    }
  })

  it("un contra-asiento del mismo periodo se compensa solo", () => {
    const lines = [lineOf(), lineOf({ entryId: "e-2", entryKind: "REVERSAL", debitCents: 100000, creditCents: 0 })]
    const pnl = buildAnalyticPnl(lines, configOf(), PERIOD, PROV)
    expect(pnl.levelTotalsCents.RESULTADO).toBe(0)
    expect(pnl.matrixCents.INGRESOS["PROJ:P-01"]).toBe(0)
  })

  it("el agregado > 2³¹ se conserva exacto en `levelTotalsBig`", () => {
    const big = lineOf({ creditCents: 2_000_000_000 })
    const pnl = buildAnalyticPnl([big, { ...big, lineNo: 2 }], configOf(), PERIOD, PROV)
    expect(pnl.levelTotalsBig.INGRESOS).toBe(BigInt(4_000_000_000))
    expect(pnl.levelTotalsCents.INGRESOS).toBe(4_000_000_000)
  })

  it("marginBps: 1 decimal en bps enteros, `null` con ingresos 0 (I-E4-6)", () => {
    expect(marginBps(50000, 100000)).toBe(5000)
    expect(marginBps(33333, 100000)).toBe(3330)
    expect(marginBps(-25000, 100000)).toBe(-2500)
    expect(marginBps(1000, 0)).toBeNull()
    expect(marginBps(0, 0)).toBeNull()
  })

  it("marginBps redondea SIMÉTRICAMENTE: el signo no cambia la décima (#9)", () => {
    // ±0,05 pp: antes, `Math.round` daba +0,1 % y −0,0 %; el mismo margen en
    // valor absoluto se presentaba distinto según el signo.
    expect(marginBps(5, 10000)).toBe(10)
    expect(marginBps(-5, 10000)).toBe(-10)
    expect(marginBps(1666, 10000)).toBe(1670)
    expect(marginBps(-1666, 10000)).toBe(-1670)
    for (const [margin, revenue] of [
      [12345, 100000],
      [7, 3000],
      [999999, 1000000],
    ] as const) {
      expect(marginBps(-margin, revenue)).toBe(-(marginBps(margin, revenue) as number))
    }
  })

  it("cellQuery: la celda es CUMULATIVA y su filtro acota los niveles ≤ (#3)", () => {
    const config = configOf()
    const period = { from: "2026-01-01", to: "2026-12-31" }

    // Columna de proyecto: en INGRESOS sólo entra el tipo de ingreso; en MC2 ya
    // entran los tres directos, porque la celda acumula.
    const ingresos = cellQuery("INGRESOS", "PROJ:P-01", config, period)
    expect(ingresos.params[4]).toEqual(["INGRESO_DIRECTO"])
    const mc2 = cellQuery("MC2", "PROJ:P-01", config, period)
    expect(mc2.params[4]).toEqual(["INGRESO_DIRECTO", "COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2"])
    // Incremental: sólo el tipo de ESE nivel.
    expect(cellQuery("MC2", "PROJ:P-01", config, period, { incremental: true }).params[4]).toEqual([
      "COSTE_DIRECTO_MC2",
    ])

    // Columna de CECO: entran los CECOs cuyo `marginLevel` alcanza la celda.
    expect(cellQuery("MC2", "CECO:OPERACIONES_INDIRECTAS", config, period).params[3]).toEqual([])
    expect(cellQuery("MC3", "CECO:OPERACIONES_INDIRECTAS", config, period).params[3]).toEqual(["cc-ops"])
    expect(cellQuery("MC3", "CECO:G_A", config, period).params[3]).toEqual([])
    expect(cellQuery("EBITDA", "CECO:G_A", config, period).params[3]).toEqual(["cc-ga"])

    // `NO_ANALITICO` se parte por R-A11: el impuesto sólo en RESULTADO.
    expect(cellQuery("EBIT", "NO_ANALITICO", config, period).query).toContain("<> ALL($4::text[])")
    expect(cellQuery("RESULTADO", "NO_ANALITICO", config, period).query).not.toContain("$4")
    expect(cellQuery("MC1", "NO_ANALITICO", config, period).query).toContain("AND false")

    // Nunca se interpola: los tres primeros parámetros son org y periodo.
    expect(mc2.params.slice(0, 3)).toEqual(["org-test", "2026-01-01", "2026-12-31"])
    expect(mc2.query).not.toContain("P-01")
  })

  it("classifyLine devuelve celda e importe sin sumar nada", () => {
    expect(classifyLine(lineOf(), configOf())).toEqual({ level: "INGRESOS", column: "PROJ:P-01", amountCents: 100000 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E4-UI-1.b — el motor no lanza por una línea con el tipo sin poblar
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveDestination: tipo NULL o desconocido (E4-UI-1.b)", () => {
  const config = configOf()

  it("línea 6/7 con CECO y `analyticType` NULL: default de la cuenta, sin excepción", () => {
    const line = lineOf({ accountCode: "621", analyticType: null, projectId: null, businessLineId: null, costCenterId: "cc-ops", debitCents: 50000, creditCents: 0 })
    expect(() => resolveLevel(line, config)).not.toThrow()
    const dest = resolveDestination(line, config)
    expect(dest.analyticType).toBe("INDIRECTO_CECO")
    expect(dest.level).toBe("MC3")
    expect(dest.column).toBe("CECO:OPERACIONES_INDIRECTAS")
    expect(dest.fallback).toBeNull()
  })

  it("R-A4: cuenta de tipo directo con CECO y `analyticType` NULL cae en el CECO", () => {
    const line = lineOf({ accountCode: "705", analyticType: null, projectId: null, businessLineId: null, costCenterId: "cc-ga" })
    const dest = resolveDestination(line, config)
    expect(dest.analyticType).toBe("INDIRECTO_CECO")
    expect(dest.level).toBe("EBITDA")
    expect(dest.column).toBe("CECO:G_A")
  })

  it("línea con proyecto y `analyticType` NULL: default de la cuenta (R-A2)", () => {
    const line = lineOf({ accountCode: "705", analyticType: null })
    const dest = resolveDestination(line, config)
    expect(dest.analyticType).toBe("INGRESO_DIRECTO")
    expect(dest.level).toBe("INGRESOS")
    expect(dest.column).toBe("PROJ:P-01")
    expect(dest.fallback).toBeNull()
  })

  it("un `AnalyticType` desconocido se rehace por el default de la cuenta, no lanza", () => {
    const line = lineOf({ accountCode: "621", analyticType: "BASURA" as AnalyticType, projectId: null, businessLineId: null, costCenterId: "cc-ops" })
    expect(() => resolveColumn(line, config)).not.toThrow()
    expect(resolveDestination(line, config).analyticType).toBe("INDIRECTO_CECO")
    expect(resolveDestination(line, config).column).toBe("CECO:OPERACIONES_INDIRECTAS")
  })

  it("sin tipo y sin default de cuenta: columna NO_ANALITICO con motivo, nunca excepción", () => {
    const sinPlan = configOf({ analyticTypeByAccount: new Map() })
    const line = lineOf({ accountCode: "621", analyticType: null, projectId: null, businessLineId: null, costCenterId: "cc-ops", debitCents: 50000, creditCents: 0 })
    const dest = resolveDestination(line, sinPlan)
    expect(dest.analyticType).toBeNull()
    expect(dest.column).toBe("NO_ANALITICO")
    expect(dest.level).toBe("EBITDA")
    expect(dest.fallback?.code).toBe("TYPE_UNKNOWN")
  })

  it("la matriz se construye igual: I4 en PASS e I-E4-1 en FAIL/WARN, no una excepción", () => {
    const sinPlan = configOf({ analyticTypeByAccount: new Map() })
    const lines = [lineOf(), lineOf({ lineNo: 2, accountCode: "621", analyticType: null, projectId: null, businessLineId: null, costCenterId: "cc-ops", debitCents: 50000, creditCents: 0 })]
    const pnl = buildAnalyticPnl(lines, sinPlan, PERIOD, PROV)
    expect(pnl.levelTotalsCents.RESULTADO).toBe(pnlContableCents(lines))
    expect(pnl.checks.find((c) => c.id === "I4")?.status).toBe("PASS")
    expect(pnl.checks.find((c) => c.id === "I-E4-1")?.status).toBe("FAIL")
    expect(pnl.unresolved).toHaveLength(1)
    expect(pnl.unresolved[0].code).toBe("TYPE_UNKNOWN")
    expect(pnl.matrixCents.EBITDA.NO_ANALITICO).toBe(-50000)

    const noRequerido = buildAnalyticPnl(lines, configOf({ analyticTypeByAccount: new Map(), analyticsRequired: false }), PERIOD, PROV)
    expect(noRequerido.checks.find((c) => c.id === "I-E4-1")?.status).toBe("WARN")
  })

  it("CECO o proyecto inexistente: NO_ANALITICO con motivo, sin tumbar la matriz", () => {
    const cecoFantasma = lineOf({ accountCode: "621", analyticType: "INDIRECTO_CECO", projectId: null, businessLineId: null, costCenterId: "cc-zzz", debitCents: 1000, creditCents: 0 })
    expect(resolveDestination(cecoFantasma, config).column).toBe("NO_ANALITICO")
    expect(resolveDestination(cecoFantasma, config).fallback?.code).toBe("CECO_UNKNOWN")

    const proyectoFantasma = lineOf({ projectId: "p-zzz" })
    expect(resolveDestination(proyectoFantasma, config).column).toBe("NO_ANALITICO")
    expect(resolveDestination(proyectoFantasma, config).fallback?.code).toBe("PROJECT_UNKNOWN")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El test que sella la épica
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "pyg-analitica-esperada.json")

describe("PyG analítica del fixture completo", () => {
  const loaded = loadFixture("ejercicio-completo")
  const expectedText = readFileSync(EXPECTED_PATH, "utf8")
  const expected = JSON.parse(expectedText) as {
    levelTotalsCents: Record<string, number>
    pygContableCents: number
    lineCount67: number
  }

  const config = configOf({
    businessLines: loaded.dimensions.businessLines,
    projects: loaded.dimensions.projects,
    costCenters: loaded.dimensions.costCenters,
    unassignedCostCenterId: loaded.dimensions.unassignedCostCenterId,
  })

  // Sólo el ejercicio 2026, como el generador Python.
  const refByEntryId = new Map(loaded.posted.map((e) => [e.id, e.sourceId ?? e.id]))
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

  const pnl = buildAnalyticPnl(lines, config, { from: "2026-01-01", to: "2026-12-31" }, PROV, {
    entryRefOf: (l) => refByEntryId.get(l.entryId) ?? l.entryId,
  })

  it.each(Object.keys(expected.levelTotalsCents))("I4 · nivel %s cuadra con el esperado sellado", (level) => {
    expect(pnl.levelTotalsCents[level]).toBe(expected.levelTotalsCents[level])
  })

  it("I4.b · RESULTADO = PyG contable = 1 497 322 c", () => {
    expect(pnl.levelTotalsCents.RESULTADO).toBe(1_497_322)
    expect(pnl.pygContableCents).toBe(1_497_322)
    expect(pnlContableCents(lines)).toBe(1_497_322)
  })

  it("BAI = 1 996 430 c (antes de impuesto) y MC3 = 3 084 110 c", () => {
    expect(pnl.levelTotalsCents.BAI).toBe(1_996_430)
    expect(pnl.levelTotalsCents.MC3).toBe(3_084_110)
  })

  it("I4.c · 85/85 líneas 6/7 cubiertas", () => {
    expect(pnl.lineCount67).toBe(85)
    expect(pnl.lineDetail).toHaveLength(85)
    expect(pnl.coveredLineIds.size).toBe(85)
  })

  it("R-A3 sobre el caso real: el 623 de P-02 aporta −150 000 c en MC2", () => {
    const line = pnl.lineDetail.find((d) => d.accountCode === "623" && d.projectCode === "P-02")
    expect(line).toBeDefined()
    expect(line?.analyticType).toBe("COSTE_DIRECTO_MC2")
    expect(line?.level).toBe("MC2")
    expect(line?.amountCents).toBe(-150_000)
  })

  it("I-E4-11 sobre el fixture: MC1 de P-01 es −150 000 y no −250 000", () => {
    expect(pnl.contributionByLevelCents.MC1["PROJ:P-01"]).toBe(-150_000)
  })

  it("las columnas de línea de negocio son agregados y NO entran en el total", () => {
    expect(pnl.businessLineMatrixCents.INGRESOS["BL-CONS"]).toBe(4_600_000)
    expect(pnl.businessLineMatrixCents.INGRESOS["BL-DEV"]).toBe(1_650_000)
    expect(pnl.levelTotalsCents.INGRESOS).toBe(6_250_000)
  })

  it("byte a byte contra `docs/design/fixtures/pyg-analitica-esperada.json`", () => {
    const canonical = canonicalAnalyticPnlJson(pnl, config, {
      schemaVersion: "1.0",
      generatedBy: "docs/design/fixtures/build_pyg_analitica_esperada.py",
      note:
        "PyG analitica esperada del fixture tests/fixtures/ejercicio-completo.json. " +
        "Centimos enteros. Signo: positivo suma al margen, negativo resta. " +
        "Matriz CUMULATIVA por nivel. Las columnas businessLines son agregados " +
        "de las columnas de proyecto y NO entran en el total.",
      sourceFixture: "tests/fixtures/ejercicio-completo.json",
      fiscalYear: "2026",
    })
    expect(canonical).toBe(expectedText)
  })

  it("I-E4-8 · reproducibilidad: dos ejecuciones dan la misma matriz", () => {
    const again = buildAnalyticPnl(lines, config, { from: "2026-01-01", to: "2026-12-31" }, PROV, {
      entryRefOf: (l) => refByEntryId.get(l.entryId) ?? l.entryId,
    })
    expect(JSON.stringify(again.matrixCents)).toBe(JSON.stringify(pnl.matrixCents))
  })

  it("#5 · `buildMatrixView` indexa por celda en O(1) y no lleva líneas dentro", () => {
    const view = buildMatrixView(pnl, config)
    expect(view.cellAt("MC2", "PROJ:P-01")?.amountCents).toBe(316_000)
    expect(view.cellAt("MC2", "PROJ:P-01")?.contributionCents).toBe(-1_584_000)
    expect(view.cellAt("EBITDA", "CECO:G_A")?.amountCents).toBe(-633_180)
    expect(view.cellAt("RESULTADO", "NO_ANALITICO")?.amountCents).toBe(-499_108)
    expect(view.totalAt("RESULTADO")).toBe(1_497_322)
    // Ni una línea del diario dentro de la vista: el drill-down las pide aparte.
    expect(JSON.stringify([...view.cells.values()])).not.toContain("entryRef")
    // Las columnas de proyecto saben bajo qué línea de negocio se agrupan.
    expect(view.columns.find((c) => c.key === "PROJ:P-01")?.businessLineCode).toBe("BL-CONS")
    expect(view.columns.find((c) => c.key === "CECO:G_A")?.kind).toBe("COST_CENTER")
  })

  it("cada celda lleva provenance con métrica y consulta parametrizada", () => {
    const cell = pnl.provenance.get("MC3|PROJ:P-01")
    expect(cell?.metrica).toBe("mc3.proyecto.P-01")
    expect(cell?.registros_origen).toContain("project_id = $4")
    expect(cell?.registros_origen).not.toContain("P-01'")
    expect(cell?.calculado_por).toBe("lib/analytics/margins.ts@c0e828f")
  })
})
