/**
 * E8 · ronda 1 de corrección — la frontera de entrada del camino documental.
 *
 * Un solo asunto, el del **revisor #2**: `simplifiedQualified` no puede viajar
 * en la propuesta que confirma un asiento. Marcar un ticket como factura
 * simplificada cualificada (art. 7.2 RD 1619/2012) convierte una cuota NO
 * deducible en deducible, y el criterio 5 exige que sea un acto humano con
 * `AuditLog` y motivo (`markSimplifiedQualifiedAction`). Con el campo admitido
 * en el `proposal`, un EDITOR —o un POST directo contra la server action—
 * deducía el IVA de un ticket sin pasar por esa puerta y sin dejar rastro.
 */

import { describe, expect, it } from "vitest"

import {
  confirmProposalSchema,
  extractionProposalSchema,
  formatZodError,
  previewProposalSchema,
  submittedProposalSchema,
} from "@/forms/extraction"

const RUN_ID = "00000000-0000-4000-8000-0000000000r1".replace(/r/g, "9")

const ticket = (over: Record<string, unknown> = {}) => ({
  version: 1,
  docKind: "TICKET",
  documentNumber: "T-0001",
  counterparty: { name: "Cafetería del Puerto SL", taxId: "B12345674" },
  documentDate: "2026-03-12",
  receptionDate: "2026-03-12",
  currency: "EUR",
  lines: [{ kind: "OPERACION", baseCents: 1122, taxRateCode: "IVA_10" }],
  taxes: [{ taxRateCode: "IVA_10", baseCents: 1122, quotaCents: 112 }],
  totalCents: 1234,
  ...over,
})

describe("revisor #2 · `simplifiedQualified` no entra por la propuesta", () => {
  it("el esquema INTERNO sigue conociendo el campo: es el que describe la propuesta sellada del run", () => {
    expect(extractionProposalSchema.safeParse(ticket({ simplifiedQualified: true })).success).toBe(true)
  })

  it("el esquema de ENTRADA lo rechaza como clave desconocida", () => {
    const parsed = submittedProposalSchema.safeParse(ticket({ simplifiedQualified: true }))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(formatZodError(parsed.error)).toMatch(/simplifiedQualified/)
  })

  it("`confirmProposalAction` lo rechaza: la marca sólo puede venir del run de revisión", () => {
    const parsed = confirmProposalSchema.safeParse({ runId: RUN_ID, proposal: ticket({ simplifiedQualified: true }) })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(formatZodError(parsed.error)).toMatch(/simplifiedQualified/)
  })

  it("`previewProposalAction` tampoco lo acepta: una previsualización con la marca puesta enseñaría una deducción falsa", () => {
    const parsed = previewProposalSchema.safeParse({ runId: RUN_ID, proposal: ticket({ simplifiedQualified: true }) })
    expect(parsed.success).toBe(false)
  })

  it("sin la marca, la misma propuesta se admite: lo que se cierra es el campo, no el camino", () => {
    expect(confirmProposalSchema.safeParse({ runId: RUN_ID, proposal: ticket() }).success).toBe(true)
    expect(previewProposalSchema.safeParse({ runId: RUN_ID, proposal: ticket() }).success).toBe(true)
  })

  it("las cifras vetadas siguen vetadas: el esquema no se ha relajado por el camino", () => {
    for (const extra of [{ accountCodeOrigin: "llm" }, { deductibilidad: "FULL" }]) {
      const parsed = submittedProposalSchema.safeParse(ticket({ lines: [{ ...ticket().lines[0], ...extra }] }))
      expect(parsed.success).toBe(false)
    }
  })
})
