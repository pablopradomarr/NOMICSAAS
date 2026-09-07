/**
 * E7 · T5 — El diff entre dos barridos (criterio 4): causa y Δ de las cuatro
 * cifras, y **nunca `NINGUNA` con deltas**.
 */

import { describe, expect, it } from "vitest"

import { diffRuns } from "@/lib/audit/diff"
import type { CheckResult, CheckStatus, HeadlineFigures, InvariantRunRef } from "@/lib/audit/types"

const check = (id: string, status: CheckStatus, evidencia = `${id} ok`): CheckResult => ({ id, status, evidencia })

const headline = (activo: number, resultado = 2500000, tesoreria = 4500000): HeadlineFigures => ({
  ACTIVO: { cents: activo },
  PN_MAS_PASIVO: { cents: activo },
  RESULTADO: { cents: resultado },
  TESORERIA: { cents: tesoreria },
})

const RUN: InvariantRunRef = {
  id: "run-a",
  gitSha: "0ff2a77",
  ledgerHash: "a".repeat(64),
  analyticsKey: "∅",
  planHash: "b".repeat(64),
  accountMapHash: "c".repeat(64),
  configHash: "d".repeat(64),
  checks: [check("I1", "PASS"), check("I2", "PASS")],
  headline: headline(100000000),
}

describe("diffRuns · la causa sale de los sellos, no de una adivinanza", () => {
  it("mismo estado y distinto gitSha ⇒ MOTOR", () => {
    const diff = diffRuns(RUN, { ...RUN, id: "run-b", gitSha: "962330e" })
    expect(diff.cause).toBe("MOTOR")
    expect(diff.hashChanges).toEqual([{ hash: "gitSha", from: "0ff2a77", to: "962330e" }])
  })

  it("mismo gitSha y distinto ledgerHash ⇒ DATOS", () => {
    expect(diffRuns(RUN, { ...RUN, id: "run-b", ledgerHash: "e".repeat(64) }).cause).toBe("DATOS")
  })

  it("sólo un umbral cambiado ⇒ CONFIGURACION (O-20)", () => {
    const diff = diffRuns(RUN, { ...RUN, id: "run-b", configHash: "f".repeat(64) })
    expect(diff.cause).toBe("CONFIGURACION")
    expect(diff.hashChanges[0]?.hash).toBe("configHash")
  })

  it("el plan y el mapa de cuentas también son configuración", () => {
    expect(diffRuns(RUN, { ...RUN, id: "run-b", planHash: "f".repeat(64) }).cause).toBe("CONFIGURACION")
    expect(diffRuns(RUN, { ...RUN, id: "run-b", accountMapHash: "f".repeat(64) }).cause).toBe("CONFIGURACION")
  })

  it("más de una causa ⇒ VARIOS", () => {
    expect(diffRuns(RUN, { ...RUN, id: "run-b", gitSha: "962330e", ledgerHash: "e".repeat(64) }).cause).toBe("VARIOS")
  })

  it("nada cambió ⇒ NINGUNA, sin deltas", () => {
    const diff = diffRuns(RUN, { ...RUN, id: "run-b" })
    expect(diff.cause).toBe("NINGUNA")
    expect(diff.deltas).toEqual([])
    expect(diff.figures.every((f) => f.deltaCents === 0)).toBe(true)
  })

  it("**nunca devuelve NINGUNA con deltas**: si nada se movió y los checks sí, es I-E7-7", () => {
    const diff = diffRuns(RUN, { ...RUN, id: "run-b", checks: [check("I1", "FAIL"), check("I2", "PASS")] })
    expect(diff.cause).not.toBe("NINGUNA")
    expect(diff.deltas).toHaveLength(1)
    expect(diff.hashChanges.some((h) => h.hash === "checksHash")).toBe(true)
  })
})

describe("diffRuns · qué cambió", () => {
  it("nombra el check, su familia, los dos estados y las dos evidencias", () => {
    const diff = diffRuns(RUN, {
      ...RUN,
      id: "run-b",
      ledgerHash: "e".repeat(64),
      checks: [check("I1", "PASS"), check("I2", "FAIL", "activo − (pn + pasivo) = 12,00 €")],
    })
    expect(diff.deltas).toEqual([
      {
        id: "I2",
        family: "ESTADOS",
        from: "PASS",
        to: "FAIL",
        evidenciaFrom: "I2 ok",
        evidenciaTo: "activo − (pn + pasivo) = 12,00 €",
      },
    ])
  })

  it("un check que aparece o desaparece se declara con `null` al otro lado", () => {
    const diff = diffRuns(RUN, {
      ...RUN,
      id: "run-b",
      ledgerHash: "e".repeat(64),
      checks: [check("I1", "PASS"), check("I2", "PASS"), check("I-E7-1", "PASS")],
    })
    expect(diff.deltas.map((d) => [d.id, d.from, d.to])).toEqual([["I-E7-1", null, "PASS"]])
  })

  it("un cambio sólo de evidencia también es un delta", () => {
    const diff = diffRuns(RUN, {
      ...RUN,
      id: "run-b",
      ledgerHash: "e".repeat(64),
      checks: [check("I1", "PASS", "otra cosa"), check("I2", "PASS")],
    })
    expect(diff.deltas.map((d) => d.id)).toEqual(["I1"])
  })

  it("**las cuatro cifras** con su Δ, que es lo que mira quien firma (O-19)", () => {
    const diff = diffRuns(RUN, {
      ...RUN,
      id: "run-b",
      ledgerHash: "e".repeat(64),
      headline: headline(100001200, 2500000, 4499000),
    })
    expect(diff.figures).toEqual([
      { metric: "ACTIVO", fromCents: 100000000, toCents: 100001200, deltaCents: 1200 },
      { metric: "PN_MAS_PASIVO", fromCents: 100000000, toCents: 100001200, deltaCents: 1200 },
      { metric: "RESULTADO", fromCents: 2500000, toCents: 2500000, deltaCents: 0 },
      { metric: "TESORERIA", fromCents: 4500000, toCents: 4499000, deltaCents: -1000 },
    ])
  })
})
