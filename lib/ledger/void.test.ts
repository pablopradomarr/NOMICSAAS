/**
 * E3 · T4 — `buildReversal` (T-21) y las comprobaciones CA-1…CA-6.
 */

import { describe, expect, it } from "vitest"

import { buildReversal, reversalNetsToZero } from "@/lib/ledger/void"
import type { EntryKind, PostedEntry } from "@/lib/ledger/types"
import { codeFor, FY_2026, testContext } from "@/tests/support/ledger-context"

const CLIENTES = codeFor("CLIENTES")
const VENTAS = codeFor("VENTAS_DEFAULT")
const IVA_REP = codeFor("IVA_REPERCUTIDO")

const posted = (over: Partial<PostedEntry> = {}): PostedEntry => {
  const kind: EntryKind = over.kind ?? "NORMAL"
  const entryDate = over.entryDate ?? "2026-03-10"
  const lines = over.lines ?? [
    { lineNo: 1, accountCode: CLIENTES, debitCents: 121000, creditCents: 0, entryDate, fiscalYearId: FY_2026.id, entryKind: kind },
    { lineNo: 2, accountCode: VENTAS, debitCents: 0, creditCents: 100000, entryDate, fiscalYearId: FY_2026.id, entryKind: kind },
    {
      lineNo: 3,
      accountCode: IVA_REP,
      debitCents: 0,
      creditCents: 21000,
      taxRateId: "rate-IVA_21",
      taxBaseCents: 100000,
      entryDate,
      fiscalYearId: FY_2026.id,
      entryKind: kind,
    },
  ]
  return {
    id: "entry-1",
    organizationId: "org-test",
    fiscalYearId: FY_2026.id,
    entryNumber: 7,
    documentDate: "2026-03-10",
    entryDate,
    description: "Factura duplicada",
    kind,
    taxRoundingMode: "PER_TIPO",
    sourceType: "INVOICE_OUT",
    templateCode: "FACTURA_EMITIDA_SERVICIOS",
    lines,
    ...over,
  }
}

const REASON = "Factura duplicada del proveedor"

describe("buildReversal — espejo exacto (criterio 5)", () => {
  it("copia e invierte las columnas conservando cuenta, orden y taxRateId", () => {
    const r = buildReversal(posted(), { reason: REASON }, testContext())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const draft = r.value
    expect(draft.kind).toBe("REVERSAL")
    expect(draft.reversesEntryId).toBe("entry-1")
    expect(draft.templateCode).toBe("CONTRA_ASIENTO")
    expect(draft.entryDate).toBe("2026-03-10")
    expect(draft.description).toBe(`Anulación del asiento nº 7 de 2026-03-10 — ${REASON}`)
    expect(draft.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
      [CLIENTES, 0, 121000],
      [VENTAS, 100000, 0],
      [IVA_REP, 21000, 0],
    ])
    expect(draft.lines[2].taxRateId).toBe("rate-IVA_21")
    expect(draft.lines[2].taxBaseCents).toBe(100000)
  })

  it("hereda el modo de redondeo sellado del original (O-2)", () => {
    const r = buildReversal(posted({ taxRoundingMode: "PER_LINEA" }), { reason: REASON }, testContext())
    expect(r.ok && r.value.taxRoundingMode).toBe("PER_LINEA")
  })

  it("con el mes original bloqueado, la fecha es el 1 del primer mes abierto", () => {
    const ctx = testContext({ refDate: "2026-08-20", periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    const r = buildReversal(posted(), { reason: REASON }, ctx)
    expect(r.ok && r.value.entryDate).toBe("2026-04-01")
  })

  it("el par original + contra-asiento cuadra a 0 por cuenta (I-E3-1)", () => {
    const original = posted()
    const r = buildReversal(original, { reason: REASON }, testContext())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(reversalNetsToZero(original.lines, r.value.lines)).toEqual({ ok: true })
  })
})

describe("CA-1 … CA-6", () => {
  it("CA-6: motivo obligatorio de al menos 10 caracteres", () => {
    const r = buildReversal(posted(), { reason: "corto" }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some((e) => e.check === "CA-6")).toBe(true)
  })

  it("CA-2: un contra-asiento no se anula con otro (REVERSAL_OF_REVERSAL)", () => {
    const r = buildReversal(posted({ kind: "REVERSAL", reversesEntryId: "otro" }), { reason: REASON }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("REVERSAL_OF_REVERSAL")
  })

  it("CA-1: apertura, cierre y regularización no se anulan", () => {
    for (const kind of ["OPENING", "CLOSING", "REGULARIZATION"] as const) {
      const r = buildReversal(posted({ kind }), { reason: REASON }, testContext())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("REVERSAL_TARGET_KIND")
    }
  })

  it("CA-3: no se anula dos veces el mismo asiento", () => {
    const r = buildReversal(posted(), { reason: REASON, existingReversals: [{ id: "rev-1" }] }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("ALREADY_REVERSED")
  })

  it("un asiento ya marcado como anulado tampoco se vuelve a anular", () => {
    const r = buildReversal(posted({ voidedAt: "2026-04-01T00:00:00Z" }), { reason: REASON }, testContext())
    expect(r.ok).toBe(false)
  })

  it("C-13: no se anula un asiento de otra organización", () => {
    const r = buildReversal(posted({ organizationId: "org-otra" }), { reason: REASON }, testContext())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("TENANT_MISMATCH")
  })

  it("caso vacío: un asiento sin líneas no genera contra-asiento", () => {
    const r = buildReversal(posted({ lines: [] }), { reason: REASON }, testContext())
    expect(r.ok).toBe(false)
  })
})

describe("reversalNetsToZero", () => {
  it("dos conjuntos vacíos cuadran", () => {
    expect(reversalNetsToZero([], [])).toEqual({ ok: true })
  })

  it("un céntimo de más deja residuo y lo identifica por cuenta", () => {
    const r = reversalNetsToZero(
      [{ accountCode: "430", debitCents: 121000, creditCents: 0 }],
      [{ accountCode: "430", debitCents: 0, creditCents: 120999 }]
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.residuals).toEqual([{ accountCode: "430", diffCents: 1 }])
  })
})
