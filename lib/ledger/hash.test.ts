/**
 * E3 · T4 / E4 · T4 — `lib/ledger/hash.ts`.
 *
 * La forma canónica es la **v2** de E4-D2: `ledgerHash` (financiero) EXCLUYE las
 * cuatro columnas analíticas y `entryHash` (de fila) las incluye junto al resto
 * de columnas. Es la única reescritura de forma admitida —no había datos en
 * producción— y `hashVersion = 2` la documenta. Si este test se rompe, todos los
 * hashes emitidos dejan de ser verificables.
 */

import { describe, expect, it } from "vitest"

import { canonicalEntryForm, canonicalForm, entryHash, HASH_VERSION, HashableLine, ledgerHash } from "@/lib/ledger/hash"

const line = (over: Partial<HashableLine> = {}): HashableLine => ({
  entryId: "e-1",
  fiscalYearId: "fy-2026",
  taxRateId: null,
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

describe("forma canónica v2 (E4-D2)", () => {
  it("la versión que emite el módulo es la 2 y no vuelve a cambiar", () => {
    expect(HASH_VERSION).toBe(2)
  })

  it("sin líneas (caso vacío) el hash es el del texto vacío, estable", () => {
    expect(canonicalForm([])).toBe("")
    expect(ledgerHash([])).toBe(ledgerHash([]))
    expect(ledgerHash([])).toHaveLength(64)
  })

  it("una línea financiera: TSV de siete columnas, sin ids y sin analítica", () => {
    expect(canonicalForm([line()])).toBe("2026-03-10\t1\t1\t430\t121000\t0\tNORMAL")
  })

  it("el sello financiero no depende de uuid: dos organizaciones con el mismo diario coinciden", () => {
    expect(ledgerHash([line({ entryId: "e-A", fiscalYearId: "fy-A", taxRateId: "r-A" })])).toBe(
      ledgerHash([line({ entryId: "e-B", fiscalYearId: "fy-B", taxRateId: "r-B" })])
    )
  })

  it("E4-D2: las columnas analíticas NO entran en `ledgerHash`", () => {
    const plain = canonicalForm([line()])
    const withDimensions = canonicalForm([line({ projectId: "P-01", costCenterId: "CC-GA" })])
    expect(withDimensions).toBe(plain)
    expect(ledgerHash([line({ projectId: "P-01" })])).toBe(ledgerHash([line()]))
  })

  it("E4-D2: las columnas analíticas SÍ entran en `entryHash`", () => {
    const withDimensions = canonicalEntryForm([line({ projectId: "P-01", analyticType: "COSTE_DIRECTO_MC2" })])
    expect(withDimensions).toContain("\tCOSTE_DIRECTO_MC2\tP-01\t∅\t∅")
    expect(entryHash([line({ projectId: "P-01" })])).not.toBe(entryHash([line()]))
  })

  it("`taxRateId` entra en el sello DE FILA, no en el financiero (v2)", () => {
    expect(ledgerHash([line({ taxRateId: "r-21" })])).toBe(ledgerHash([line()]))
    expect(entryHash([line({ taxRateId: "r-21" })])).not.toBe(entryHash([line()]))
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
    expect(entryHash(lines)).toBe(entryHash(lines))
    // Ya NO son el mismo sello: `entryHash` cubre más columnas (E4-D2).
    expect(entryHash(lines)).not.toBe(ledgerHash(lines))
  })

  it("un borrador sin numerar usa 0 como entryNumber", () => {
    expect(canonicalForm([line({ entryNumber: null })])).toContain("2026-03-10\t0\t1\t")
  })
})
