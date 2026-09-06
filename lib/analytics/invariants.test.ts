/**
 * E4 · T8 — I4 y los doce `I-E4-*` sobre el fixture completo, más los sellos
 * `analyticsHash` / `marginConfigHash` (E4-D2) y la ventana de reclasificación.
 */

import { describe, expect, it } from "vitest"

import { EMPTY_RUN_SET_HASH, analyticsHash, marginConfigHash } from "@/lib/analytics/hash"
import {
  checkI4,
  checkIE41,
  checkIE42,
  checkIE43,
  checkIE44,
  checkIE45,
  checkIE47,
  checkIE49,
  checkIE410,
  checkIE411,
  checkIE412,
  runAnalyticInvariants,
  type AnalyticsInvariantInput,
} from "@/lib/analytics/invariants"
import { checkReclassify, type CurrentLine } from "@/lib/analytics/reclassify"
import { defaultCostCenters, defaultMarginLevels, validateMarginLevels } from "@/lib/analytics/seed"
import type { AnalyticLine, AnalyticsConfig, AnalyticType, MarginLevelRow } from "@/lib/analytics/types"
import { INCOME_TAX_PREFIXES } from "@/lib/analytics/types"
import { loadFixture, planForVariant } from "@/tests/support/fixtures"

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

const loaded = loadFixture("ejercicio-completo")

const CONFIG: AnalyticsConfig = {
  organizationId: "org-test",
  levels: LEVELS,
  businessLines: loaded.dimensions.businessLines,
  projects: loaded.dimensions.projects,
  costCenters: loaded.dimensions.costCenters,
  unassignedCostCenterId: loaded.dimensions.unassignedCostCenterId,
  analyticTypeByAccount,
  incomeTaxPrefixes: INCOME_TAX_PREFIXES,
  nonAnalyticLevel: "EBITDA",
  analyticsRequired: true,
}

const entries2026 = loaded.posted.filter((e) => e.fiscalYearId === "fy-2026")

const LINES: AnalyticLine[] = entries2026.flatMap((e) =>
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

const INPUT: AnalyticsInvariantInput = {
  lines: LINES,
  config: CONFIG,
  period: { from: "2026-01-01", to: "2026-12-31" },
  entries: entries2026,
}

describe("I4 sobre el fixture completo", () => {
  it("PASS con diferencia 0 en los ocho niveles", () => {
    const result = checkI4(INPUT)
    expect(result.status).toBe("PASS")
    expect(result.evidencia).toContain("1497322")
  })

  it("FAIL si un total esperado no cuadra, con la diferencia exacta", () => {
    const result = checkI4({ ...INPUT, expectedLevelTotalsCents: { RESULTADO: 1_497_323 } })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("1497323")
  })

  it("periodo sin líneas 6/7: matriz de ceros y PASS, no error", () => {
    expect(checkI4({ ...INPUT, lines: [], entries: [] }).status).toBe("PASS")
  })
})

describe("I-E4-1 … I-E4-12 sobre el fixture completo", () => {
  it("los trece checks salen en PASS (o INFO en I-E4-6)", () => {
    const checks = runAnalyticInvariants(INPUT)
    const bad = checks.filter((c) => c.status !== "PASS" && c.status !== "INFO")
    expect(bad.map((c) => `${c.id}: ${c.evidencia}`)).toEqual([])
    expect(checks.map((c) => c.id)).toContain("I-E4-11")
    expect(checks.map((c) => c.id)).toContain("I-E4-12")
  })

  it("I-E4-1: sin destino y con `analyticsRequired` es FAIL; con `false`, WARN", () => {
    const orphan: AnalyticLine[] = [{ ...LINES.find((l) => l.projectId)!, projectId: null, businessLineId: null }]
    expect(checkIE41({ ...INPUT, lines: orphan }).status).toBe("FAIL")
    expect(checkIE41({ ...INPUT, lines: orphan, config: { ...CONFIG, analyticsRequired: false } }).status).toBe("WARN")
  })

  it("I-E4-1: líneas en CC-NA producen WARN con importe y recuento", () => {
    const routed: AnalyticLine[] = [
      { ...LINES.find((l) => l.projectId)!, projectId: null, businessLineId: null, costCenterId: CONFIG.unassignedCostCenterId },
    ]
    const result = checkIE41({ ...INPUT, lines: routed })
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("SIN_ASIGNAR")
  })

  it("I-E4-1: línea con CECO y `analyticType` NULL sin default de cuenta es WARN/FAIL, no excepción (E4-UI-1.b)", () => {
    const rota: AnalyticLine[] = [
      { ...LINES.find((l) => l.costCenterId)!, analyticType: null },
    ]
    const sinPlan = { ...CONFIG, analyticTypeByAccount: new Map<string, null>() }
    expect(() => checkIE41({ ...INPUT, lines: rota, config: sinPlan })).not.toThrow()
    const requerido = checkIE41({ ...INPUT, lines: rota, config: sinPlan })
    expect(requerido.status).toBe("FAIL")
    expect(requerido.evidencia).toContain("NO_ANALITICO")
    expect(checkIE41({ ...INPUT, lines: rota, config: { ...sinPlan, analyticsRequired: false } }).status).toBe("WARN")
    // Y con el plan real la línea se resuelve por el default de la cuenta (R-A4).
    expect(checkIE41({ ...INPUT, lines: rota }).status).toBe("PASS")
  })

  it("los trece checks no lanzan nunca: una línea con el tipo sin poblar da FAIL/WARN", () => {
    const rota: AnalyticLine[] = [{ ...LINES.find((l) => l.costCenterId)!, analyticType: null }]
    const sinPlan = { ...CONFIG, analyticTypeByAccount: new Map<string, null>() }
    let checks: ReturnType<typeof runAnalyticInvariants> = []
    expect(() => {
      checks = runAnalyticInvariants({ ...INPUT, lines: rota, config: sinPlan })
    }).not.toThrow()
    expect(checks.find((c) => c.id === "I4")?.status).toBe("PASS")
    expect(checks.find((c) => c.id === "I-E4-1")?.status).toBe("FAIL")
  })

  it("I-E4-2: proyecto y CECO a la vez es FAIL", () => {
    const both: AnalyticLine[] = [{ ...LINES.find((l) => l.projectId)!, costCenterId: "cc-CC-GA" }]
    expect(checkIE42({ ...INPUT, lines: both }).status).toBe("FAIL")
  })

  it("I-E4-3: una línea de negocio que no es la del proyecto es FAIL", () => {
    const wrong: AnalyticLine[] = [{ ...LINES.find((l) => l.projectId)!, businessLineId: "bl-OTRA" }]
    expect(checkIE43({ ...INPUT, lines: wrong }).status).toBe("FAIL")
  })

  it("I-E4-4: NO_ANALITICO con dimensión es FAIL (el caso del 630)", () => {
    const tax = LINES.find((l) => l.accountCode.startsWith("630"))
    expect(tax).toBeDefined()
    expect(checkIE44({ ...INPUT, lines: [{ ...tax!, costCenterId: "cc-CC-GA" }] }).status).toBe("FAIL")
  })

  it("I-E4-5: una línea de grupo 4 o 5 con dimensión es FAIL", () => {
    const bank = LINES.find((l) => l.accountCode.startsWith("57")) ?? { ...LINES[0], accountCode: "572" }
    expect(checkIE45({ ...INPUT, lines: [{ ...bank, accountCode: "572", projectId: "p-x" }] }).status).toBe("FAIL")
  })

  it("I-E4-7: una dimensión de otro tenant es FAIL", () => {
    expect(checkIE47({ ...INPUT, lines: [{ ...LINES[0], projectId: "proj-de-otra-org" }] }).status).toBe("FAIL")
  })

  it("I-E4-9: MLC-1 y MLC-2 se comprueban sobre la configuración vigente", () => {
    expect(checkIE49(INPUT).status).toBe("PASS")
    const broken = LEVELS.map((l) => (l.level === "MC3" ? { ...l, analyticTypes: ["INDIRECTO_CECO" as AnalyticType] } : l))
    expect(checkIE49({ ...INPUT, config: { ...CONFIG, levels: broken } }).status).toBe("FAIL")
  })

  it("I-E4-10: WARN con una línea posterior al cierre del proyecto; el REVERSAL está exento", () => {
    const project = CONFIG.projects[0]
    const closed = { ...CONFIG, projects: [{ ...project, status: "CLOSED" as const, closedAt: "2026-01-01" }, ...CONFIG.projects.slice(1)] }
    const late: AnalyticLine = { ...LINES.find((l) => l.projectId === project.id)!, entryDate: "2026-06-30" }
    expect(checkIE410({ ...INPUT, config: closed, lines: [late] }).status).toBe("WARN")
    expect(checkIE410({ ...INPUT, config: closed, lines: [{ ...late, entryKind: "REVERSAL" }] }).status).toBe("PASS")
  })

  it("I-E4-11: un contra-asiento que cambia de destino descuadra, aunque la PyG cuadre", () => {
    const rev = entries2026.find((e) => e.kind === "REVERSAL")
    expect(rev).toBeDefined()
    expect(checkIE411(entries2026).status).toBe("PASS")
    const moved = entries2026.map((e) =>
      e.id === rev!.id ? { ...e, lines: e.lines.map((l) => ({ ...l, projectId: l.projectId ? "proj-P-03" : null })) } : e
    )
    expect(checkIE411(moved).status).toBe("FAIL")
  })

  it("I-E4-12: la rectificativa del fixture lleva el destino del rectificado", () => {
    const rectifying = entries2026.find((e) => e.lines.some((l) => l.accountCode.startsWith("708")))
    expect(rectifying).toBeDefined()
    expect(checkIE412(entries2026).status).toBe("PASS")
  })

  it("I-E4-12: FAIL cuando el abono y su línea de ingreso apuntan a proyectos distintos", () => {
    const rectifying = entries2026.find((e) => e.lines.some((l) => l.accountCode.startsWith("708")))!
    const broken = [
      {
        ...rectifying,
        lines: [
          ...rectifying.lines,
          // Línea de ingreso rectificada en el MISMO asiento, con otro destino.
          { ...rectifying.lines[0], lineNo: 9, accountCode: "705", projectId: "proj-P-03", businessLineId: "bl-BL-DEV" },
        ],
      },
    ]
    expect(checkIE412(broken).status).toBe("FAIL")
  })
})

describe("hashes analíticos (E4-D2)", () => {
  const hashable = LINES.map((l) => ({
    entryId: l.entryId,
    lineNo: l.lineNo,
    projectId: l.projectId,
    costCenterId: l.costCenterId,
    businessLineId: l.businessLineId,
    analyticType: l.analyticType,
  }))

  it("`marginConfigHash` es determinista y cambia con el marginLevel de un CECO", () => {
    expect(marginConfigHash(CONFIG)).toBe(marginConfigHash(CONFIG))
    const moved = {
      ...CONFIG,
      costCenters: CONFIG.costCenters.map((c) => (c.code === "CC-OPS" ? { ...c, marginLevel: "EBITDA" as const } : c)),
    }
    expect(marginConfigHash(moved)).not.toBe(marginConfigHash(CONFIG))
  })

  it("`marginConfigHash` cambia con `nonAnalyticLevel` (MLC-5)", () => {
    expect(marginConfigHash({ ...CONFIG, nonAnalyticLevel: "BAI" })).not.toBe(marginConfigHash(CONFIG))
  })

  it("`analyticsHash` cambia al reclasificar una línea y no cambia sin tocar nada", () => {
    const base = analyticsHash(hashable, marginConfigHash(CONFIG), EMPTY_RUN_SET_HASH)
    expect(analyticsHash(hashable, marginConfigHash(CONFIG), EMPTY_RUN_SET_HASH)).toBe(base)
    const moved = hashable.map((l, i) => (i === 0 ? { ...l, projectId: "otro" } : l))
    expect(analyticsHash(moved, marginConfigHash(CONFIG), EMPTY_RUN_SET_HASH)).not.toBe(base)
  })

  it("`analyticsHash` cambia con la configuración y con el `allocationRunSetHash` (O-E5-7)", () => {
    const base = analyticsHash(hashable, marginConfigHash(CONFIG), EMPTY_RUN_SET_HASH)
    expect(analyticsHash(hashable, marginConfigHash({ ...CONFIG, nonAnalyticLevel: "EBIT" }), EMPTY_RUN_SET_HASH)).not.toBe(base)
    expect(analyticsHash(hashable, marginConfigHash(CONFIG), "run-1")).not.toBe(base)
  })
})

describe("MarginLevelConfig por defecto (MLC-1…MLC-3)", () => {
  it("la configuración de fábrica es válida", () => {
    expect(validateMarginLevels(defaultMarginLevels())).toEqual([])
  })

  it("MLC-2: listar INDIRECTO_CECO en MC3 o EBITDA se rechaza", () => {
    const rows = defaultMarginLevels().map((l) => (l.level === "EBITDA" ? { ...l, analyticTypes: ["INDIRECTO_CECO" as AnalyticType] } : l))
    expect(validateMarginLevels(rows).some((i) => i.code === "MLC-2")).toBe(true)
  })

  it("MLC-1: un tipo en dos niveles se rechaza", () => {
    const rows = defaultMarginLevels().map((l) => (l.level === "MC3" ? { ...l, analyticTypes: ["FINANCIERO" as AnalyticType] } : l))
    expect(validateMarginLevels(rows).some((i) => i.code === "MLC-1")).toBe(true)
  })

  it("los ocho CECOs de fábrica: tres no imputables y `CC-NA` de sistema", () => {
    const seeds = defaultCostCenters()
    expect(seeds).toHaveLength(8)
    expect(seeds.filter((c) => !c.allocatable).map((c) => c.code)).toEqual(["CC-FIN", "CC-EXT", "CC-OTR"].slice(0, 2).concat("CC-NA"))
    expect(seeds.find((c) => c.code === "CC-NA")?.isSystem).toBe(true)
    expect(seeds.every((c) => c.marginLevel === "MC3" || c.marginLevel === "EBITDA")).toBe(true)
  })
})

describe("ventana de reclasificación (C-R2/C-R3/C-R4, ADR-0010)", () => {
  const line: CurrentLine = {
    id: "l-1",
    entryId: "e-1",
    entryNumber: 7,
    lineNo: 2,
    accountCode: "621",
    entryDate: "2026-03-10",
    fiscalYearId: "fy-2026",
    entryKind: "NORMAL",
    projectId: null,
    costCenterId: loaded.dimensions.costCenters[0].id,
    businessLineId: null,
    analyticType: "INDIRECTO_CECO",
  }
  const target = { lineId: "l-1", projectId: loaded.dimensions.projects[0].id }
  const base = {
    config: CONFIG,
    fiscalYears: [{ id: "fy-2026", code: "2026", status: "OPEN" as const }],
    periodLocks: [],
  }

  it("EDITOR con el mes abierto puede, y el tipo efectivo pasa a MC2 (R-A3)", () => {
    const result = checkReclassify({ reason: "El gasto era del proyecto Alfa", targets: [target] }, [line], {
      ...base,
      role: "EDITOR",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0].after.analyticType).toBe("COSTE_DIRECTO_MC2")
    expect(result.value[0].after.businessLineId).toBe(loaded.dimensions.projects[0].businessLineId)
  })

  it("motivo de menos de 10 caracteres: rechazado (C-R3)", () => {
    const result = checkReclassify({ reason: "error", targets: [target] }, [line], { ...base, role: "EDITOR" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.check === "C-R3")).toBe(true)
  })

  it("mes bloqueado: EDITOR no, ADMIN sí (C-R2)", () => {
    const locked = { ...base, periodLocks: [{ fiscalYearId: "fy-2026", month: 3 }] }
    const asEditor = checkReclassify({ reason: "Imputación tardía del jefe de proyecto", targets: [target] }, [line], {
      ...locked,
      role: "EDITOR",
    })
    expect(asEditor.ok).toBe(false)
    const asAdmin = checkReclassify({ reason: "Imputación tardía del jefe de proyecto", targets: [target] }, [line], {
      ...locked,
      role: "ADMIN",
    })
    expect(asAdmin.ok).toBe(true)
  })

  it("ejercicio cerrado: nadie, tampoco ADMIN (C-R2, frontera absoluta)", () => {
    const closed = { ...base, fiscalYears: [{ id: "fy-2026", code: "2026", status: "CLOSED" as const }] }
    for (const role of ["EDITOR", "ADMIN"] as const) {
      const result = checkReclassify({ reason: "Imputación tardía del jefe de proyecto", targets: [target] }, [line], {
        ...closed,
        role,
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.errors[0].code).toBe("FY_CLOSED")
    }
  })

  it("C-R4: proyecto destino cerrado o CECO archivado, rechazados", () => {
    const closedProject = {
      ...CONFIG,
      projects: CONFIG.projects.map((p, i) => (i === 0 ? { ...p, status: "CLOSED" as const, closedAt: "2026-02-01" } : p)),
    }
    const result = checkReclassify({ reason: "Imputación tardía del jefe de proyecto", targets: [target] }, [line], {
      ...base,
      config: closedProject,
      role: "ADMIN",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].code).toBe("ANALYTIC_PROJECT_CLOSED")
  })

  it("una línea de grupo 1–5 no se reclasifica (R-A1)", () => {
    const bank: CurrentLine = { ...line, accountCode: "572", costCenterId: null, analyticType: null }
    const result = checkReclassify({ reason: "Imputación tardía del jefe de proyecto", targets: [target] }, [bank], {
      ...base,
      role: "ADMIN",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].code).toBe("ANALYTIC_DIM_ON_NON_PNL")
  })
})
