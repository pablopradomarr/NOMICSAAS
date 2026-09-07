/**
 * E7 · T5 — `checksHashOf`, `configHashOf` y la foto sellada (criterios 1 y 23).
 */

import { describe, expect, it } from "vitest"

import {
  buildInvariantRun,
  canonicalChecksForm,
  canonicalConfigForm,
  checksHashOf,
  configHashOf,
  E7_SEAL_REASONS,
  type AuditRunInput,
} from "@/lib/audit/run"
import type { AuditConfigSnapshot, CheckResult, CheckStatus, HeadlineFigures } from "@/lib/audit/types"

const check = (id: string, status: CheckStatus, evidencia = `${id} ok`): CheckResult => ({ id, status, evidencia })

const HEADLINE: HeadlineFigures = {
  ACTIVO: { cents: 100000000 },
  PN_MAS_PASIVO: { cents: 100000000 },
  RESULTADO: { cents: 2500000 },
  TESORERIA: { cents: 4500000 },
}

const CONFIG: AuditConfigSnapshot = {
  warnThreshold: 0,
  maxMaterializedEntries: 20000,
  planVariant: "PYMES",
  matchToleranceDays: { "BANCO-1": 3, "BANCO-2": 5 },
  transitWarnDays: { "BANCO-1": 90 },
  ignoredMaterialityCents: { "BANCO-1": 10000 },
}

const INPUT: AuditRunInput = {
  organizationId: "org-1",
  runId: "run-1",
  checks: [check("I1", "PASS"), check("I-E7-1", "PASS")],
  scope: { kind: "FISCAL_YEAR", fiscalYearId: "fy-2026" },
  trigger: "MANUAL",
  hashes: {
    ledgerHash: "a".repeat(64),
    analyticsKey: "∅",
    planHash: "b".repeat(64),
    accountMapHash: "c".repeat(64),
    configHash: configHashOf(CONFIG),
  },
  headline: HEADLINE,
  gitSha: "0ff2a77",
  lastGitSha: "0ff2a77",
  refDate: "2026-12-31",
  manualFlags: [],
  coverage: { evaluated: ["ledger", "bank"], skipped: [] },
  durationMs: 1234,
}

describe("checksHashOf (I-E7-7)", () => {
  it("no depende del orden en que corrieron los bloques", () => {
    const a = [check("I1", "PASS"), check("I2", "FAIL")]
    expect(checksHashOf(a)).toBe(checksHashOf([...a].reverse()))
  })

  it("cambia si cambia el estado…", () => {
    expect(checksHashOf([check("I1", "PASS")])).not.toBe(checksHashOf([check("I1", "FAIL")]))
  })

  it("…y también si sólo cambia la EVIDENCIA (la mentira sin cambiar el estado)", () => {
    expect(checksHashOf([check("I1", "PASS", "diferencia 0,00 €")])).not.toBe(
      checksHashOf([check("I1", "PASS", "diferencia 12,00 €")])
    )
  })

  it("la forma canónica es TSV ordenado, no JSON", () => {
    expect(canonicalChecksForm([check("I2", "FAIL", "x"), check("I1", "PASS", "y")])).toBe("I1\tPASS\ty\nI2\tFAIL\tx")
  })
})

describe("configHashOf (O-20)", () => {
  it("no depende del orden de inserción de las claves", () => {
    const otro: AuditConfigSnapshot = {
      ...CONFIG,
      matchToleranceDays: { "BANCO-2": 5, "BANCO-1": 3 },
    }
    expect(configHashOf(otro)).toBe(configHashOf(CONFIG))
  })

  it("**bajar un umbral cambia el hash**: la caché no puede servir el run viejo", () => {
    expect(configHashOf({ ...CONFIG, matchToleranceDays: { "BANCO-1": 2, "BANCO-2": 5 } })).not.toBe(configHashOf(CONFIG))
    expect(configHashOf({ ...CONFIG, warnThreshold: 1 })).not.toBe(configHashOf(CONFIG))
    expect(configHashOf({ ...CONFIG, planVariant: "NORMAL" })).not.toBe(configHashOf(CONFIG))
  })

  it("la forma canónica ordena por clave", () => {
    expect(canonicalConfigForm(CONFIG).split("\n").slice(0, 4)).toEqual([
      "warnThreshold\t0",
      "maxMaterializedEntries\t20000",
      "planVariant\tPYMES",
      "forceReview\t0",
    ])
  })
})

describe("buildInvariantRun", () => {
  it("compone la foto con los cinco hashes, las cuatro cifras y las siete familias", () => {
    const draft = buildInvariantRun(INPUT)
    expect(draft.checksHash).toBe(checksHashOf(INPUT.checks))
    expect(draft.configHash).toBe(configHashOf(CONFIG))
    expect(draft.counts.byFamily).toHaveLength(7)
    expect(draft.counts.global).toEqual({ PASS: 2, FAIL: 0, WARN: 0, INFO: 0, total: 2 })
    expect(Object.keys(draft.headline).sort()).toEqual(["ACTIVO", "PN_MAS_PASIVO", "RESULTADO", "TESORERIA"])
    expect(draft.scopeKind).toBe("FISCAL_YEAR")
    expect(draft.fiscalYearId).toBe("fy-2026")
    expect(draft.durationMs).toBe(1234)
  })

  it("es reproducible: dos barridos del mismo estado dan el mismo checksHash (criterio 1)", () => {
    expect(buildInvariantRun(INPUT).checksHash).toBe(buildInvariantRun({ ...INPUT, durationMs: 999 }).checksHash)
  })

  it("sella VALIDADO AUTOMÁTICAMENTE sin FAIL, sin WARN y sin marca de revisión", () => {
    expect(buildInvariantRun(INPUT).seal.sello).toBe("VALIDADO AUTOMÁTICAMENTE")
  })

  it("un FAIL sella REQUIERE REVISIÓN nombrando el invariante", () => {
    const draft = buildInvariantRun({ ...INPUT, checks: [check("I-E7-1", "FAIL")] })
    expect(draft.seal.sello).toBe("REQUIERE REVISIÓN")
    expect(draft.seal.motivos.join(" ")).toContain("I-E7-1")
  })

  it("una marca de revisión viva fuerza la revisión; una levantada no", () => {
    const flag = { id: "f1", reason: "revisión del cierre", checkFamily: "CONCILIACION" as const }
    expect(buildInvariantRun({ ...INPUT, manualFlags: [flag] }).seal.sello).toBe("REQUIERE REVISIÓN")
    expect(buildInvariantRun({ ...INPUT, manualFlags: [{ ...flag, clearedAt: "2026-12-31T10:00:00Z" }] }).seal.sello).toBe(
      "VALIDADO AUTOMÁTICAMENTE"
    )
  })

  it("cambiar el motor sella el primer run como revisable (ENTORNO)", () => {
    const draft = buildInvariantRun({ ...INPUT, lastGitSha: "962330e" })
    expect(draft.seal.sello).toBe("REQUIERE REVISIÓN")
    expect(draft.seal.razones[0]?.kind).toBe("ENTORNO")
  })

  it("los cuatro motivos de E7 se registran **sin** convertir un informe correcto en sospechoso (§5.3)", () => {
    const draft = buildInvariantRun({ ...INPUT, auditReasons: ["CONCILIACION_PENDIENTE", "ALMACEN_NO_BARRIDO"] })
    expect(draft.seal.sello).toBe("VALIDADO AUTOMÁTICAMENTE")
    expect(draft.sealReasons.map((r) => r.code)).toEqual(["ALMACEN_NO_BARRIDO", "CONCILIACION_PENDIENTE"])
    expect(draft.sealReasons.map((r) => r.kind)).toEqual(["ENTORNO", "AVISO"])
    expect(E7_SEAL_REASONS).toHaveLength(4)
  })

  it("declara los ids sin familia en vez de tragárselos", () => {
    expect(buildInvariantRun({ ...INPUT, checks: [check("I-E99-1", "PASS")] }).unknownIds).toEqual(["I-E99-1"])
  })
})
