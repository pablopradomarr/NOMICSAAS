/**
 * E11 · ola A · T3 — catálogo de planes: resolución por vigencia y sello.
 */

import { describe, expect, it } from "vitest"

import { isSellable, limitsOf, planCatalogHash, PlanResolutionError, publicPlansAt, resolvePlanAt } from "./plan"
import type { PlanRow } from "./types"

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

function plan(over: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "p-1",
    code: "STARTER",
    name: "Starter",
    listPriceCents: 4900,
    currency: "EUR",
    interval: "MONTH",
    stripePriceId: "price_starter",
    isPublic: true,
    validFrom: D("2026-01-01"),
    validTo: null,
    maxMembers: 5,
    maxOcrDocsMonth: 300,
    maxStorageBytes: 10_737_418_240n,
    maxExportsMonth: 100,
    maxBackupsMonth: 10,
    maxOrganizations: 3,
    softMaxEntriesMonth: 2000,
    graceDays: 14,
    backupRetentionDays: 30,
    ...over,
  }
}

describe("resolvePlanAt", () => {
  it("catálogo vacío: lanza y dice qué falta, no devuelve undefined", () => {
    expect(() => resolvePlanAt([], "FREE", D("2026-09-15"))).toThrow(PlanResolutionError)
    expect(() => resolvePlanAt([], "FREE", D("2026-09-15"))).toThrow(/vigente el 2026-09-15/)
  })

  it("una sola versión abierta: la devuelve", () => {
    const p = plan()
    expect(resolvePlanAt([p], "STARTER", D("2026-09-15"))).toBe(p)
  })

  it("la vigencia es cerrada por ambos extremos", () => {
    const p = plan({ validFrom: D("2026-03-01"), validTo: D("2026-06-30") })
    expect(resolvePlanAt([p], "STARTER", D("2026-03-01"))).toBe(p)
    expect(resolvePlanAt([p], "STARTER", D("2026-06-30"))).toBe(p)
    expect(() => resolvePlanAt([p], "STARTER", D("2026-02-28"))).toThrow(PlanResolutionError)
    expect(() => resolvePlanAt([p], "STARTER", D("2026-07-01"))).toThrow(PlanResolutionError)
  })

  it("dos versiones consecutivas: elige por la fecha, no por el orden de la lista", () => {
    const v1 = plan({ id: "v1", validFrom: D("2026-01-01"), validTo: D("2026-06-30"), listPriceCents: 3900 })
    const v2 = plan({ id: "v2", validFrom: D("2026-07-01"), listPriceCents: 4900 })
    expect(resolvePlanAt([v2, v1], "STARTER", D("2026-05-01")).id).toBe("v1")
    expect(resolvePlanAt([v2, v1], "STARTER", D("2026-08-01")).id).toBe("v2")
  })

  it("dos vigentes a la vez: LANZA. Nunca «la primera que aparezca»", () => {
    const a = plan({ id: "a" })
    const b = plan({ id: "b", validFrom: D("2026-05-01") })
    expect(() => resolvePlanAt([a, b], "STARTER", D("2026-09-15"))).toThrow(/2 versiones vigentes/)
  })

  it("no confunde códigos distintos", () => {
    const free = plan({ id: "f", code: "FREE", listPriceCents: 0, stripePriceId: null })
    expect(resolvePlanAt([free, plan()], "FREE", D("2026-09-15")).id).toBe("f")
  })
})

describe("planCatalogHash", () => {
  it("catálogo vacío: hash estable de la cadena vacía", () => {
    expect(planCatalogHash([])).toBe(planCatalogHash([]))
    expect(planCatalogHash([])).toHaveLength(64)
  })

  it("no depende del orden de entrada (forma canónica, ADR-0011)", () => {
    const a = plan({ id: "a", code: "FREE", listPriceCents: 0, stripePriceId: null })
    const b = plan({ id: "b" })
    expect(planCatalogHash([a, b])).toBe(planCatalogHash([b, a]))
  })

  it("cambia si cambia un límite: una fila tocada por SQL se ve", () => {
    const base = planCatalogHash([plan()])
    expect(planCatalogHash([plan({ maxMembers: 6 })])).not.toBe(base)
    expect(planCatalogHash([plan({ maxStorageBytes: 10_737_418_241n })])).not.toBe(base)
    expect(planCatalogHash([plan({ softMaxEntriesMonth: 2001 })])).not.toBe(base)
  })

  it("no cambia con el id ni con las marcas de tiempo: no son el catálogo", () => {
    expect(planCatalogHash([plan({ id: "otro" })])).toBe(planCatalogHash([plan()]))
  })
})

describe("publicPlansAt e isSellable — P-1", () => {
  const free = plan({ id: "f", code: "FREE", listPriceCents: 0, stripePriceId: null })
  const starter = plan()
  const oculto = plan({ id: "x", code: "LEGACY", isPublic: false })

  it("ordena por precio y oculta los no públicos", () => {
    expect(publicPlansAt([starter, free, oculto], D("2026-09-15")).map((p) => p.code)).toEqual(["FREE", "STARTER"])
  })

  it("FREE se ofrece pero NO es vendible: sin precio en Stripe no hay checkout", () => {
    expect(isSellable(free)).toBe(false)
    expect(isSellable(starter)).toBe(true)
  })

  it("un plan de pago todavía sin precio en Stripe tampoco es vendible", () => {
    expect(isSellable(plan({ stripePriceId: null }))).toBe(false)
  })
})

describe("limitsOf", () => {
  it("extrae los límites sin la ficha comercial", () => {
    expect(limitsOf(plan())).toEqual({
      maxMembers: 5,
      maxOcrDocsMonth: 300,
      maxStorageBytes: 10_737_418_240n,
      maxExportsMonth: 100,
      maxBackupsMonth: 10,
      maxOrganizations: 3,
      softMaxEntriesMonth: 2000,
      graceDays: 14,
      backupRetentionDays: 30,
    })
  })
})
