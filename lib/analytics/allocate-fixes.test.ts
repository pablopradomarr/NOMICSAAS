/**
 * E5 · ronda 1 de corrección — tests del motor puro.
 *
 * Un test por corrección, con el nombre del hallazgo que cierra:
 *  · BLOQUEA #1 — `TARGETS_REQUIRED` / `RULE_INERT`: **no existe regla inerte y
 *    silenciosa** (ADR-0013 D4).
 *  · #11 / auditoría 4 — Hamilton en `BigInt`: exactitud y desempate correctos
 *    con magnitudes que superan 2^53.
 *  · Auditoría 1 — `linesHash`: mover el céntimo de remanente entre dos
 *    receptores cambia el hash.
 *  · Auditoría 2 — `reconstructBalances`: I5.a evaluable fuera del motor.
 */

import { describe, expect, it } from "vitest"

import {
  allocate,
  hamilton,
  linesHash,
  reconstructBalances,
  type AllocationInput,
  type AllocationPeriodRef,
  type AllocationRuleSpec,
  type AppliedAllocation,
} from "@/lib/analytics/allocate"
import { checkI5, checkIE512 } from "@/lib/analytics/invariants"
import { defaultMarginLevels } from "@/lib/analytics/seed"
import type { AnalyticLine, AnalyticsConfig } from "@/lib/analytics/types"

// ─────────────────────────────────────────────────────────────────────────────
// Andamio mínimo: dos CECOs imputables, dos proyectos, una línea de negocio
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG: AnalyticsConfig = {
  organizationId: "org-fix",
  levels: defaultMarginLevels(),
  businessLines: [
    { id: "bl-1", code: "BL-CONS", name: "Consultoría", sortOrder: 1, isActive: true },
    { id: "bl-2", code: "BL-DEV", name: "Producto", sortOrder: 2, isActive: true },
  ],
  projects: [
    { id: "p-1", code: "P-01", name: "P-01", businessLineId: "bl-1", status: "ACTIVE", isActive: true, sortOrder: 1 },
    { id: "p-2", code: "P-02", name: "P-02", businessLineId: "bl-1", status: "ACTIVE", isActive: true, sortOrder: 2 },
  ],
  costCenters: [
    { id: "cc-ga", code: "CC-GA", name: "Estructura", kind: "G_A", marginLevel: "EBITDA", allocatable: true, isActive: true, sortOrder: 1 },
    { id: "cc-ops", code: "CC-OPS", name: "Operaciones", kind: "OPERACIONES", marginLevel: "MC3", allocatable: true, isActive: true, sortOrder: 2 },
    { id: "cc-na", code: "CC-NA", name: "Sin asignar", kind: "NO_ASIGNADO", marginLevel: "EBITDA", allocatable: false, isActive: true, sortOrder: 9 },
  ],
  unassignedCostCenterId: "cc-na",
  analyticTypeByAccount: new Map(),
  incomeTaxPrefixes: ["630", "633", "638"],
  nonAnalyticLevel: "EBITDA",
  analyticsRequired: false,
}

const YEAR: AllocationPeriodRef = {
  kind: "YEAR",
  label: "2026",
  start: "2026-01-01",
  end: "2026-12-31",
  fiscalYearId: "fy-2026",
  fiscalYearStart: "2026-01-01",
  fiscalYearEnd: "2026-12-31",
}

let lineSeq = 0
const gasto = (costCenterId: string, cents: number, entryDate = "2026-03-15"): AnalyticLine => {
  lineSeq += 1
  return {
    id: `l-${lineSeq}`,
    entryId: `e-${lineSeq}`,
    entryNumber: lineSeq,
    entryDate,
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "621",
    debitCents: cents,
    creditCents: 0,
    analyticType: "INDIRECTO_CECO",
    projectId: null,
    costCenterId,
    businessLineId: null,
  }
}

const ingreso = (projectId: string, cents: number, entryDate = "2026-03-15"): AnalyticLine => {
  lineSeq += 1
  return {
    id: `l-${lineSeq}`,
    entryId: `e-${lineSeq}`,
    entryNumber: lineSeq,
    entryDate,
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "705",
    debitCents: 0,
    creditCents: cents,
    analyticType: "INGRESO_DIRECTO",
    projectId,
    costCenterId: null,
    businessLineId: null,
  }
}

const ruleOf = (over: Partial<AllocationRuleSpec> = {}): AllocationRuleSpec => ({
  id: "r-1",
  code: "AL-1",
  name: "Regla",
  sourceCostCenterId: "cc-ga",
  targetKind: "PROJECTS",
  driver: "EQUAL",
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

const inputOf = (rules: AllocationRuleSpec[], lines: AnalyticLine[]): AllocationInput => ({
  lines,
  config: CONFIG,
  rules,
  period: YEAR,
  priorAllocations: [],
  runId: "run-1",
})

// ─────────────────────────────────────────────────────────────────────────────
// BLOQUEA #1 — ninguna regla reparte 0 € en silencio (ADR-0013 D4)
// ─────────────────────────────────────────────────────────────────────────────

describe("BLOQUEA #1 · contrato targetKind × driver", () => {
  it("COST_CENTERS con un driver calculado se RECHAZA (antes repartía 0 € sin avisar)", () => {
    const out = allocate(
      inputOf(
        [ruleOf({ targetKind: "COST_CENTERS", driver: "DIRECT_COST_SHARE" })],
        [gasto("cc-ga", 100_000)]
      )
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe("TARGETS_REQUIRED")
    expect(out.error.message).toContain("centros de coste")
  })

  it("BUSINESS_LINES con un driver calculado se RECHAZA por el mismo motivo", () => {
    const out = allocate(
      inputOf([ruleOf({ targetKind: "BUSINESS_LINES", driver: "EQUAL" })], [gasto("cc-ga", 100_000)])
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe("TARGETS_REQUIRED")
  })

  it("COST_CENTERS con FIXED_PERCENT y destinos declarados SÍ es válido", () => {
    const out = allocate(
      inputOf(
        [
          ruleOf({
            targetKind: "COST_CENTERS",
            driver: "FIXED_PERCENT",
            targets: [{ costCenterId: "cc-ops", percentBps: 10000, sortOrder: 0 }],
          }),
          ruleOf({ id: "r-2", code: "AL-2", sourceCostCenterId: "cc-ops", priority: 20, driver: "EQUAL" }),
        ],
        [gasto("cc-ga", 100_000)]
      )
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // El nivel VIAJA: el gasto nació en CC-GA (EBITDA) y llega a los proyectos
    // en EBITDA, aunque el intermedio CC-OPS sea MC3 (E5-D1).
    expect(out.value.lines.every((l) => l.marginLevel === "EBITDA")).toBe(true)
    expect(out.value.lines.filter((l) => l.target.kind === "PROJECT").reduce((a, l) => a + l.amountCents, 0)).toBe(100_000)
  })

  it("FIXED_PERCENT sin ningún destino se RECHAZA con TARGETS_REQUIRED", () => {
    const out = allocate(inputOf([ruleOf({ driver: "FIXED_PERCENT", targets: [] })], [gasto("cc-ga", 100_000)]))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe("TARGETS_REQUIRED")
  })

  it("RULE_INERT: con saldo y sin ningún receptor con peso, el motor PARA (no reparte 0 en silencio)", () => {
    // `excludeProjectCodes` deja la regla sin receptores: no es un caso de base
    // cero declarado (no hay `W-E5-ZERO-BASE`), es una regla inerte.
    const out = allocate(
      inputOf(
        [ruleOf({ driver: "EQUAL", targetFilter: { excludeProjectCodes: ["P-01", "P-02"] } })],
        [gasto("cc-ga", 100_000)]
      )
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe("RULE_INERT")
    expect(out.error.ruleCodes).toEqual(["AL-1"])
  })

  it("base del driver a 0 con SKIP_WARN NO es una regla inerte: es configuración declarada", () => {
    const out = allocate(
      inputOf([ruleOf({ driver: "REVENUE_SHARE", zeroBaseFallback: "SKIP_WARN" })], [gasto("cc-ga", 100_000)])
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.lines).toEqual([])
    expect(out.value.warnings.map((w) => w.code)).toContain("W-E5-ZERO-BASE")
  })

  it("con base del driver, REVENUE_SHARE reparte y no hay aviso de base cero", () => {
    const out = allocate(
      inputOf([ruleOf({ driver: "REVENUE_SHARE" })], [gasto("cc-ga", 100_000), ingreso("p-1", 300_000), ingreso("p-2", 100_000)])
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.lines.map((l) => [l.target.code, l.amountCents])).toEqual([
      ["P-01", 75_000],
      ["P-02", 25_000],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #11 / auditoría 4 — Hamilton en BigInt
// ─────────────────────────────────────────────────────────────────────────────

describe("#11 · Hamilton exacto POR CONSTRUCCIÓN (BigInt)", () => {
  it("con A·wᵢ por encima de 2^53 la suma sigue siendo exacta y el desempate es el real", () => {
    // 25 M€ repartidos entre bases de 700 M€ y 700 M€ + 1 c: el producto es
    // 1,75e16 > 2^53. En coma flotante los dos restos quedaban cuantizados al
    // MISMO valor y el céntimo iba al de menor código; con BigInt gana el que
    // de verdad tiene mayor resto.
    const out = hamilton(2_500_000_001, [
      { code: "B-MAYOR-BASE", weight: 700_000_000_01 },
      { code: "A-MENOR-BASE", weight: 700_000_000_00 },
    ])
    expect(out.reduce((a, o) => a + o.amountCents, 0)).toBe(2_500_000_001)
    const winner = out.find((o) => o.remainderApplied)
    expect(winner?.code).toBe("B-MAYOR-BASE")
  })

  it("empate real de restos: gana el MENOR código (P7), también en BigInt", () => {
    const out = hamilton(1, [
      { code: "P-03", weight: 1_000_000_000_000 },
      { code: "P-01", weight: 1_000_000_000_000 },
      { code: "P-02", weight: 1_000_000_000_000 },
    ])
    expect(out.filter((o) => o.amountCents === 1).map((o) => o.code)).toEqual(["P-01"])
  })

  it("importes negativos: el signo se restituye y Σ es exacta", () => {
    const out = hamilton(-100_000_000_001, [
      { code: "A", weight: 3 },
      { code: "B", weight: 7 },
    ])
    expect(out.reduce((a, o) => a + o.amountCents, 0)).toBe(-100_000_000_001)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Auditoría 1 — `linesHash` sella la SALIDA del run
// ─────────────────────────────────────────────────────────────────────────────

describe("auditoría 1 · linesHash", () => {
  const base = allocate(
    inputOf([ruleOf({ driver: "REVENUE_SHARE" })], [gasto("cc-ga", 100_001), ingreso("p-1", 300_000), ingreso("p-2", 100_000)])
  )

  it("dos ejecuciones del mismo reparto dan el mismo hash", () => {
    expect(base.ok).toBe(true)
    if (!base.ok) return
    expect(linesHash(base.value.lines)).toBe(linesHash(base.value.lines))
  })

  it("el orden de lectura NO cambia el hash (forma canónica ordenada)", () => {
    if (!base.ok) return
    expect(linesHash([...base.value.lines].reverse())).toBe(linesHash(base.value.lines))
  })

  it("CASO B del auditor: mover el céntimo de remanente entre dos receptores CAMBIA el hash", () => {
    if (!base.ok) return
    const moved = base.value.lines.map((l, i) =>
      i === 0 ? { ...l, amountCents: l.amountCents - 1 } : i === 1 ? { ...l, amountCents: l.amountCents + 1 } : l
    )
    // La alteración es de suma cero: el total del run NO se mueve, que es
    // justamente por lo que ningún otro invariante la veía.
    expect(moved.reduce((a, l) => a + l.amountCents, 0)).toBe(base.value.totalAllocatedCents)
    expect(linesHash(moved)).not.toBe(linesHash(base.value.lines))
  })

  it("I-E5-12 pasa a FAIL con el hash sellado del run cuando las líneas ya no son las suyas", () => {
    if (!base.ok) return
    const sealed = linesHash(base.value.lines)
    const moved: AppliedAllocation[] = base.value.lines.map((l, i) =>
      i === 0 ? { ...l, amountCents: l.amountCents - 1 } : i === 1 ? { ...l, amountCents: l.amountCents + 1 } : l
    )
    const ok = checkIE512({
      lines: [],
      config: CONFIG,
      period: { from: "2026-01-01", to: "2026-12-31", fiscalYearId: "fy-2026" },
      allocations: base.value.lines,
      runLinesHashes: [{ id: "run-1", linesHash: sealed }],
    })
    expect(ok.status).toBe("PASS")
    const bad = checkIE512({
      lines: [],
      config: CONFIG,
      period: { from: "2026-01-01", to: "2026-12-31", fiscalYearId: "fy-2026" },
      allocations: moved,
      runLinesHashes: [{ id: "run-1", linesHash: sealed }],
    })
    expect(bad.status).toBe("FAIL")
  })

  it("un run anterior a la migración (sin linesHash) se declara INFO, no PASS", () => {
    const info = checkIE512({
      lines: [],
      config: CONFIG,
      period: { from: "2026-01-01", to: "2026-12-31", fiscalYearId: "fy-2026" },
      allocations: [],
      runLinesHashes: [{ id: "run-viejo", linesHash: null }],
    })
    expect(info.status).toBe("INFO")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Auditoría 2 — I5.a evaluable fuera del motor
// ─────────────────────────────────────────────────────────────────────────────

describe("auditoría 2 · reconstructBalances (I5.a en producción)", () => {
  const lines = [gasto("cc-ga", 100_000), ingreso("p-1", 300_000), ingreso("p-2", 100_000)]
  const computed = allocate(inputOf([ruleOf({ driver: "REVENUE_SHARE" })], lines))
  const runs = [{ id: "run-1", periodStart: "2026-01-01", periodEnd: "2026-12-31" }]

  it("reconstruye la base desde el DIARIO y da residual 0 con el reparto real", () => {
    expect(computed.ok).toBe(true)
    if (!computed.ok) return
    const balances = reconstructBalances({ lines, config: CONFIG, runs, allocations: computed.value.lines })
    expect(balances).toHaveLength(1)
    expect(balances[0]).toMatchObject({
      runId: "run-1",
      sourceCostCenterCode: "CC-GA",
      marginLevel: "EBITDA",
      baseCents: 100_000,
      allocatedCents: 100_000,
      residualCents: 0,
    })
  })

  it("I5 PASA con esas balances, y ya no declara «0 combinación(es)»", () => {
    if (!computed.ok) return
    const check = checkI5({
      lines,
      config: CONFIG,
      period: { from: "2026-01-01", to: "2026-12-31", fiscalYearId: "fy-2026" },
      allocations: computed.value.lines,
      rules: [ruleOf({ driver: "REVENUE_SHARE" })],
      balances: reconstructBalances({ lines, config: CONFIG, runs, allocations: computed.value.lines }),
    })
    expect(check.status).toBe("PASS")
    expect(check.evidencia).toContain("1 combinación(es)")
  })

  it("CASO A del auditor: subir el importe de una línea por SQL pone I5.a en FAIL", () => {
    if (!computed.ok) return
    const tampered = computed.value.lines.map((l, i) => (i === 0 ? { ...l, amountCents: l.amountCents + 100 } : l))
    const balances = reconstructBalances({ lines, config: CONFIG, runs, allocations: tampered })
    expect(balances[0].residualCents).toBe(100)
    const check = checkI5({
      lines,
      config: CONFIG,
      period: { from: "2026-01-01", to: "2026-12-31", fiscalYearId: "fy-2026" },
      allocations: tampered,
      rules: [ruleOf({ driver: "REVENUE_SHARE" })],
      balances,
    })
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("I5.a")
  })

  it("un run de periodo más fino se descuenta como `yaRepartido` en el run que lo contiene", () => {
    // Marzo reparte 40 000 y el anual reparte el resto: la base del anual es
    // 100 000 − 40 000, no 100 000.
    const monthLines: AppliedAllocation[] = [
      {
        runId: "run-mes",
        ruleId: "r-m",
        ruleCode: "AL-M",
        sourceCostCenterId: "cc-ga",
        sourceCostCenterCode: "CC-GA",
        targetKind: "PROJECTS",
        target: { kind: "PROJECT", id: "p-1", code: "P-01" },
        marginLevel: "EBITDA",
        amountCents: 40_000,
        driverBase: 1,
        driverBaseTotal: 1,
        driverShareBps: 10_000,
        fallbackApplied: null,
        eligibilityReason: null,
      },
    ]
    const yearLines: AppliedAllocation[] = [{ ...monthLines[0], runId: "run-1", ruleCode: "AL-1", amountCents: 60_000 }]
    const balances = reconstructBalances({
      lines,
      config: CONFIG,
      runs: [
        { id: "run-1", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
        { id: "run-mes", periodStart: "2026-03-01", periodEnd: "2026-03-31" },
      ],
      allocations: [...monthLines, ...yearLines],
    })
    const annual = balances.find((b) => b.runId === "run-1")
    expect(annual?.baseCents).toBe(60_000)
    expect(annual?.residualCents).toBe(0)
  })
})
