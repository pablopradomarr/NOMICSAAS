/**
 * E8 · T13 — sellado del veredicto, avisos de calidad y forzados.
 */

import { describe, expect, it } from "vitest"

import { caseById, inputProposalFor, reconcileContextFor } from "@/lib/extraction/reconcile.fixture"
import { reconcile } from "@/lib/extraction/reconcile"
import { applyFieldOverride, documentWarnings, sealedReconcile } from "@/lib/extraction/seal"

const run = (id: string) => {
  const c = caseById(id)
  return reconcile(inputProposalFor(c), reconcileContextFor(c))
}

describe("sealedReconcile", () => {
  it("es JSON puro: el `rateMicro` viaja como cadena y no queda ningún bigint", () => {
    const sealed = sealedReconcile(run("C12"), [])
    expect(() => JSON.stringify(sealed)).not.toThrow()
    expect(sealed.conversion?.rateMicro).toBe("925926")
    expect(sealed.checks).toHaveLength(25)
  })

  it("no duplica la propuesta ni las procedencias: van en sus propias columnas", () => {
    const sealed = sealedReconcile(run("C01"), []) as unknown as Record<string, unknown>
    expect(sealed.normalized).toBeUndefined()
    expect(sealed.fieldOrigins).toBeUndefined()
  })
})

describe("documentWarnings", () => {
  it("un ticket cualificado y una contraparte sin ficha se sellan como aviso", () => {
    const warnings = documentWarnings(run("C04"), { counterpartyEnMaestro: false, withholdingRegime: null })
    expect(warnings).toContain("TICKET_CUALIFICADO")
    expect(warnings).toContain("CONTRAPARTE_SIN_REGIMEN")
  })

  it("el ticket NO cualificado no lleva marca alguna: NONE es el estado legal por defecto", () => {
    const warnings = documentWarnings(run("C03"), { counterpartyEnMaestro: true, withholdingRegime: "NINGUNO" })
    expect(warnings).toEqual([])
  })

  it("la deducibilidad pendiente de decisión se sella cuando RC-15 no pasa", () => {
    const result = run("C03")
    const pendiente = {
      ...result,
      checks: result.checks.map((c) => (c.id === "RC-15" ? { ...c, status: "WARN" as const, blocksBatch: true } : c)),
    }
    expect(documentWarnings(pendiente, { counterpartyEnMaestro: true, withholdingRegime: "NINGUNO" })).toEqual([
      "DEDUCIBILIDAD_PENDIENTE",
    ])
  })
})

describe("applyFieldOverride", () => {
  const proposal = run("C01").normalized

  it("fuerza un campo simple sin mutar la propuesta original", () => {
    const result = applyFieldOverride(proposal, "documentNumber", "F-2026-9999")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.documentNumber).toBe("F-2026-9999")
    expect(proposal.documentNumber).not.toBe("F-2026-9999")
  })

  it("indexa las líneas por posición y los tipos por código", () => {
    const line = applyFieldOverride(proposal, "lines[0].accountCode", "621")
    expect(line.ok && line.proposal.lines[0].accountCode).toBe("621")
    const code = proposal.taxes[0].taxRateCode
    const tax = applyFieldOverride(proposal, `taxes[${code}].quotaCents`, 1)
    expect(tax.ok && tax.proposal.taxes[0].quotaCents).toBe(1)
  })

  it("el total NO se puede forzar: una cifra que no cuadra se teclea, no se fuerza", () => {
    const result = applyFieldOverride(proposal, "totalCents", 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("FIELD_NOT_FORCEABLE")
  })

  it("una ruta inventada es un error, no un campo nuevo en la propuesta", () => {
    expect(applyFieldOverride(proposal, "loQueSea", 1).ok).toBe(false)
    expect(applyFieldOverride(proposal, "lines[9].accountCode", "621").ok).toBe(false)
    expect(applyFieldOverride(proposal, "taxes[NO_EXISTE].quotaCents", 1).ok).toBe(false)
  })
})
