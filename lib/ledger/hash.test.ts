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

import {
  canonicalEntryForm,
  canonicalEntryFormV3,
  canonicalForm,
  entryHash,
  HASH_VERSION,
  HASH_VERSION_CURRENT,
  HashableLine,
  isHashVersion,
  ledgerHash,
} from "@/lib/ledger/hash"

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
  it("la v2 sigue siendo la 2: es la de las filas ya escritas y no se toca", () => {
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

// ═════════════════════════════════════════════════════════════════════════════
// E8 · T2b — `hashVersion = 3` y CONVIVENCIA (ADR-0014 D2, ADR-0011)
//
// Riesgo R5 de la épica: «la convivencia se implementa a medias y un asiento v3
// se verifica con v2». Estos tests son la red de esa afirmación.
// ═════════════════════════════════════════════════════════════════════════════

const conDivisa = (over: Partial<HashableLine> = {}): HashableLine =>
  line({ originalCurrency: "USD", originalAmountCents: 130000, exchangeRateId: "fx-1", ...over })

describe("forma canónica v3 (E8 · T2b, ADR-0014 D2)", () => {
  it("la versión que se emite HOY es la 3, y ambas están declaradas", () => {
    expect(HASH_VERSION_CURRENT).toBe(3)
    expect(isHashVersion(2)).toBe(true)
    expect(isHashVersion(3)).toBe(true)
    expect(isHashVersion(1)).toBe(false)
    expect(isHashVersion(4)).toBe(false)
  })

  it("v3 es v2 MÁS las tres columnas de divisa, al final y en ese orden", () => {
    expect(canonicalEntryFormV3([conDivisa()])).toBe(canonicalEntryForm([conDivisa()]) + "\tUSD\t130000\tfx-1")
  })

  it("sin divisa, v3 sólo añade tres `∅`: la convivencia sabe explicar la diferencia", () => {
    expect(canonicalEntryFormV3([line()])).toBe(canonicalEntryForm([line()]) + "\t∅\t∅\t∅")
  })

  it("v2 IGNORA la divisa: una fila v2 sella igual lleve o no las columnas nuevas", () => {
    // Ésta es la propiedad que hace que el histórico no haya que recalcularlo.
    expect(canonicalEntryForm([conDivisa()])).toBe(canonicalEntryForm([line()]))
    expect(entryHash([conDivisa()], 2)).toBe(entryHash([line()], 2))
  })

  it("v3 SÍ sella la divisa: cambiar cualquiera de las tres cambia el hash", () => {
    const base = entryHash([conDivisa()], 3)
    expect(entryHash([conDivisa({ originalCurrency: "GBP" })], 3)).not.toBe(base)
    expect(entryHash([conDivisa({ originalAmountCents: 130001 })], 3)).not.toBe(base)
    expect(entryHash([conDivisa({ exchangeRateId: "fx-2" })], 3)).not.toBe(base)
  })

  it("v2 y v3 dan sellos DISTINTOS para las mismas líneas: por eso hay que despachar", () => {
    expect(entryHash([line()], 2)).not.toBe(entryHash([line()], 3))
    expect(entryHash([line()])).toBe(entryHash([line()], HASH_VERSION_CURRENT))
  })

  it("**`ledgerHash` NO cambia**: v3 no toca la forma canónica FINANCIERA", () => {
    // Consecuencia buscada (ADR-0014 D2): el hecho económico en moneda base es
    // el mismo, así que las cachés de `ReportRun` de E6 no se invalidan
    // (I-E6-18) y el sello de un periodo ya emitido sigue sirviendo.
    expect(ledgerHash([conDivisa()])).toBe(ledgerHash([line()]))
    expect(canonicalForm([conDivisa()])).toBe(canonicalForm([line()]))
  })

  it("una fila v2 verificada con v2 sigue cuadrando después de E8 (byte a byte)", () => {
    // El sello literal de una línea v2, calculado con el código de HEAD ANTES
    // de T2b (34c9f85^). Si este valor
    // cambia, el histórico entero deja de ser verificable.
    const sello = entryHash([line()], 2)
    expect(sello).toBe("e84ef0221d183a57ef9c40e4828e1c19871f94968013388da3ec9b27f5797f1e")
  })
})
