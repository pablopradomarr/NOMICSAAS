/**
 * E7 · T5 — El semáforo por familia, y el criterio 2: **ningún INFO se pinta
 * como OK**.
 */

import { describe, expect, it } from "vitest"

import {
  CHECK_FAMILIES,
  countsOf,
  familyOf,
  familyStatus,
  groupByFamily,
  isKnownCheckId,
  unknownCheckIds,
} from "@/lib/audit/families"
import type { CheckResult, CheckStatus } from "@/lib/audit/types"

const check = (id: string, status: CheckStatus): CheckResult => ({ id, status, evidencia: `${id} · ${status}` })

describe("familyOf", () => {
  it("reparte los invariantes históricos por su familia", () => {
    expect(familyOf("I1")).toBe("PARTIDA_DOBLE")
    expect(familyOf("N-5")).toBe("PARTIDA_DOBLE")
    expect(familyOf("I-E3-7")).toBe("PARTIDA_DOBLE")
    expect(familyOf("I2")).toBe("ESTADOS")
    expect(familyOf("I-E6-14")).toBe("ESTADOS")
    expect(familyOf("I4")).toBe("ANALITICA")
    expect(familyOf("I-E4-12")).toBe("ANALITICA")
    expect(familyOf("I5")).toBe("LIQUIDACION")
    expect(familyOf("I-E5-3")).toBe("LIQUIDACION")
    expect(familyOf("I-E8-15a")).toBe("DOCUMENTAL")
    expect(familyOf("I10")).toBe("INTEGRIDAD")
  })

  it("los I-E7-* no caen todos en CONCILIACION: cada uno audita lo suyo", () => {
    expect(familyOf("I-E7-1")).toBe("CONCILIACION")
    expect(familyOf("I-E7-6b")).toBe("CONCILIACION")
    expect(familyOf("I-E7-7")).toBe("INTEGRIDAD")
    expect(familyOf("I-E7-8")).toBe("DOCUMENTAL")
    expect(familyOf("I-E7-9")).toBe("LIQUIDACION")
    expect(familyOf("I-E7-10")).toBe("LIQUIDACION")
    expect(familyOf("I-E7-14")).toBe("ESTADOS")
    expect(familyOf("I-E7-17")).toBe("ESTADOS")
  })

  it("un check nuevo sin clasificar cae en INTEGRIDAD **y se declara**", () => {
    expect(familyOf("I-E9-1")).toBe("INTEGRIDAD")
    expect(isKnownCheckId("I-E9-1")).toBe(false)
    expect(unknownCheckIds([check("I-E9-1", "PASS"), check("I1", "PASS")])).toEqual(["I-E9-1"])
  })
})

describe("familyStatus · la composición del semáforo, escrita una vez", () => {
  it("un solo FAIL pinta FALLO aunque todo lo demás esté en PASS", () => {
    expect(familyStatus([check("a", "PASS"), check("b", "WARN"), check("c", "FAIL")])).toBe("FALLO")
  })

  it("sin FAIL, un WARN pinta AVISO", () => {
    expect(familyStatus([check("a", "PASS"), check("b", "WARN")])).toBe("AVISO")
  })

  it("**sólo INFO ⇒ SIN_EVALUAR, jamás OK** (criterio 2)", () => {
    expect(familyStatus([check("a", "INFO"), check("b", "INFO")])).toBe("SIN_EVALUAR")
  })

  it("una familia vacía es SIN_EVALUAR, no OK", () => {
    expect(familyStatus([])).toBe("SIN_EVALUAR")
  })

  it("OK exige al menos un PASS comprobado", () => {
    expect(familyStatus([check("a", "PASS"), check("b", "INFO")])).toBe("OK")
  })
})

describe("groupByFamily", () => {
  it("devuelve SIEMPRE las siete familias en orden fijo", () => {
    const summaries = groupByFamily([check("I1", "PASS")])
    expect(summaries.map((s) => s.family)).toEqual(CHECK_FAMILIES)
    expect(summaries).toHaveLength(7)
  })

  it("las familias sin checks salen SIN_EVALUAR y no desaparecen", () => {
    const summaries = groupByFamily([check("I1", "PASS")])
    expect(summaries.find((s) => s.family === "PARTIDA_DOBLE")?.status).toBe("OK")
    expect(summaries.find((s) => s.family === "CONCILIACION")?.status).toBe("SIN_EVALUAR")
    expect(summaries.find((s) => s.family === "CONCILIACION")?.counts.total).toBe(0)
  })

  it("un barrido entero de INFO no pinta ni una familia en verde (R3)", () => {
    const checks = ["I1", "I2", "I4", "I5", "I-E8-1", "I-E7-1", "I10"].map((id) => check(id, "INFO"))
    expect(groupByFamily(checks).every((s) => s.status === "SIN_EVALUAR")).toBe(true)
  })

  it("cuenta por estado y por familia", () => {
    const checks = [check("I1", "PASS"), check("I-E3-1", "FAIL"), check("I-E7-1", "WARN"), check("I-E7-7", "INFO")]
    expect(countsOf(checks)).toEqual({ PASS: 1, FAIL: 1, WARN: 1, INFO: 1, total: 4 })
    const partida = groupByFamily(checks).find((s) => s.family === "PARTIDA_DOBLE")
    expect(partida?.checkIds).toEqual(["I1", "I-E3-1"])
    expect(partida?.status).toBe("FALLO")
  })
})
