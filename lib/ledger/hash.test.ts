/**
 * E3 · T4 — `lib/ledger/hash.ts`. La forma canónica es **v1 y no cambia**: si
 * este test se rompe, todos los hashes emitidos dejan de ser verificables.
 */

import { describe, expect, it } from "vitest"

import { canonicalForm, entryHash, HashableLine, ledgerHash } from "@/lib/ledger/hash"

const line = (over: Partial<HashableLine> = {}): HashableLine => ({
  entryDate: "2026-03-10",
  entryNumber: 1,
  lineNo: 1,
  accountCode: "430",
  debitCents: 121000,
  creditCents: 0,
  entryKind: "NORMAL",
  projectId: null,
  costCenterId: null,
  businessLineId: null,
  ...over,
})

describe("forma canónica v1", () => {
  it("sin líneas (caso vacío) el hash es el del texto vacío, estable", () => {
    expect(canonicalForm([])).toBe("")
    expect(ledgerHash([])).toBe(ledgerHash([]))
    expect(ledgerHash([])).toHaveLength(64)
  })

  it("una línea: TSV de diez columnas con ∅ para los nulos", () => {
    expect(canonicalForm([line()])).toBe("2026-03-10\t1\t1\t430\t121000\t0\tNORMAL\t∅\t∅\t∅")
  })

  it("las columnas analíticas entran en la forma desde E3 (§2.3)", () => {
    const withDimensions = canonicalForm([line({ projectId: "P-01", costCenterId: "CC-GA" })])
    expect(withDimensions).toContain("\tP-01\tCC-GA\t∅")
  })

  it("ordena por (entryDate, entryNumber, lineNo), no por el orden de entrada", () => {
    const a = line({ entryDate: "2026-03-10", entryNumber: 2, lineNo: 1, accountCode: "572" })
    const b = line({ entryDate: "2026-01-05", entryNumber: 1, lineNo: 2, accountCode: "705" })
    expect(canonicalForm([a, b])).toBe(canonicalForm([b, a]))
    expect(canonicalForm([a, b]).split("\n")[0]).toContain("2026-01-05")
  })

  it("un céntimo de diferencia cambia el hash", () => {
    expect(ledgerHash([line()])).not.toBe(ledgerHash([line({ debitCents: 121001 })]))
  })

  it("cambiar la cuenta cambia el hash", () => {
    expect(ledgerHash([line()])).not.toBe(ledgerHash([line({ accountCode: "431" })]))
  })

  it("es determinista entre ejecuciones (C1 de SPEC-FIABILIDAD)", () => {
    const lines = [line(), line({ lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 121000 })]
    expect(ledgerHash(lines)).toBe(ledgerHash(lines))
    expect(entryHash(lines)).toBe(ledgerHash(lines))
  })

  it("un borrador sin numerar usa 0 como entryNumber", () => {
    expect(canonicalForm([line({ entryNumber: null })])).toContain("2026-03-10\t0\t1\t")
  })
})
