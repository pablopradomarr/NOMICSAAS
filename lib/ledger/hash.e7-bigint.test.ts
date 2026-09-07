/**
 * E7 · T4 — **Criterio de aceptación 24**: `bigint` sin mover un céntimo, y el
 * borde de JavaScript (ADR-0015 D1, observación O-23 de la validación contable).
 *
 * La migración M4 es DDL puro y `ALTER COLUMN … TYPE bigint` preserva el valor
 * exacto de todo `integer`. **El riesgo real no está en el DDL: está aquí.**
 * Prisma devuelve `BigInt`, `JSON.stringify(BigInt)` LANZA, y el arreglo
 * apresurado —serializarlo como cadena `"1234"`— sí cambiaría `entryHash` y
 * `ledgerHash` sin cambiar una sola cifra. Las tres aserciones del criterio:
 *
 *   (a) `canonicalEntryForm` recibe `number`, **nunca** `BigInt` ni `string`,
 *       con test de tipo y de forma canónica byte a byte idéntica antes y
 *       después de M4;
 *   (b) el borde comprueba `Number.isSafeInteger` y **lanza** por encima de
 *       2^53 − 1 en vez de perder precisión en silencio;
 *   (c) una línea de 25 000 000,00 € recorre postear → agregar → hash →
 *       informe (la parte que toca la base vive en
 *       `tests/integration/e7-esquema.test.ts`).
 *
 * La cuarta pata —los fixtures no se mueven— la sostiene
 * `lib/ledger/fixtures.test.ts`, que congela los dos `ledgerHash` de
 * `ejercicio-{minimo,completo}`.
 */

import { describe, expect, it } from "vitest"

import { canonicalEntryForm, canonicalEntryFormV3, canonicalForm, entryHash, type HashableLine, ledgerHash } from "@/lib/ledger/hash"
import { centsFromDb, centsFromDbNullable, centsToDb, MAX_SAFE_CENTS } from "@/lib/money"

const linea = (extra: Partial<HashableLine> = {}): HashableLine => ({
  entryId: "11111111-1111-4111-8111-111111111111",
  entryNumber: 7,
  lineNo: 1,
  accountCode: "5720",
  debitCents: 2_500_000_000,
  creditCents: 0,
  entryDate: "2026-06-30",
  fiscalYearId: "22222222-2222-4222-8222-222222222222",
  entryKind: "NORMAL",
  taxBaseCents: 1_000,
  ...extra,
})

describe("E7 · criterio 24 (a) — la forma canónica sólo admite `number`", () => {
  /**
   * Literales calculados con el código ANTERIOR a M4 (`journal_lines` en
   * `integer`). Si alguno se moviera, todo informe sellado de E3–E6 dejaría de
   * servirse de caché (I-E6-18) y el criterio 15 de E3 —dos organizaciones con
   * el mismo diario, el mismo `ledgerHash`— dejaría de ser cierto sin que se
   * haya movido un céntimo.
   */
  const lineas = [linea(), linea({ lineNo: 2, accountCode: "626", debitCents: 0, creditCents: 2_500_000_000 })]

  it("la forma canónica de un importe grande es su decimal, sin notación científica", () => {
    expect(canonicalForm(lineas)).toContain("\t2500000000\t")
    expect(canonicalEntryForm(lineas)).toContain("\t2500000000\t")
    expect(canonicalEntryFormV3(lineas)).toContain("\t2500000000\t")
  })

  it("BYTE A BYTE: `number` y el `BigInt` equivalente NO son intercambiables — el BigInt LANZA", () => {
    const conBigInt = [
      { ...lineas[0], debitCents: BigInt(2_500_000_000) as unknown as number },
      lineas[1],
    ]
    expect(() => canonicalEntryFormV3(conBigInt)).toThrow(/entero seguro en céntimos/)
    expect(() => ledgerHash(conBigInt)).toThrow(/debitCents/)
  })

  it("…y la cadena `\"2500000000\"` tampoco: es justo el arreglo que cambiaría el hash", () => {
    const conCadena = [{ ...lineas[0], debitCents: "2500000000" as unknown as number }, lineas[1]]
    expect(() => canonicalEntryFormV3(conCadena)).toThrow(/recibido string/)
  })

  it("un `number` que no es entero seguro se rechaza (`1e21` se serializaría como `1e+21`)", () => {
    expect(() => canonicalEntryFormV3([linea({ debitCents: 1e21 })])).toThrow(/entero seguro/)
    expect(() => canonicalEntryFormV3([linea({ creditCents: 12.5 })])).toThrow(/entero seguro/)
  })

  it("el sello de un asiento de 25 M€ es estable y no depende de por dónde llegó el número", () => {
    const desdeLaBase = lineas.map((l) => ({
      ...l,
      debitCents: centsFromDb(BigInt(l.debitCents), "debe"),
      creditCents: centsFromDb(BigInt(l.creditCents), "haber"),
      taxBaseCents: centsFromDbNullable(l.taxBaseCents === null ? null : BigInt(l.taxBaseCents ?? 0), "base"),
    }))
    expect(entryHash(desdeLaBase)).toBe(entryHash(lineas))
    expect(ledgerHash(desdeLaBase)).toBe(ledgerHash(lineas))
    // Y el hash es reproducible entre ejecuciones (C1 de SPEC-FIABILIDAD).
    expect(entryHash(lineas)).toBe(entryHash(lineas))
  })
})

describe("E7 · criterio 24 (b) — el borde lanza en vez de perder precisión", () => {
  it("el techo del borde es 2^53 − 1 céntimos ≈ 90 mil millones de euros", () => {
    expect(MAX_SAFE_CENTS).toBe(Number.MAX_SAFE_INTEGER)
    expect(centsFromDb(BigInt(MAX_SAFE_CENTS))).toBe(MAX_SAFE_CENTS)
  })

  it("un céntimo por encima **lanza**, no redondea", () => {
    const desbordado = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    expect(() => centsFromDb(desbordado, "debe")).toThrow(RangeError)
    expect(() => centsFromDb(desbordado, "debe")).toThrow(/supera el entero seguro/)
    // El silencio es el fallo que se está evitando: `Number(2n**53n + 1n)`
    // devuelve 9007199254740992 sin avisar de nada.
    expect(Number(desbordado)).toBe(9_007_199_254_740_992)
  })

  it("25 000 000,00 € —imposible en `integer`— cruza el borde en los dos sentidos", () => {
    const veinticinco = 2_500_000_000
    expect(veinticinco).toBeGreaterThan(2_147_483_647) // el techo que M4 retira
    expect(centsFromDb(BigInt(veinticinco))).toBe(veinticinco)
    expect(centsToDb(veinticinco)).toBe(BigInt(veinticinco))
  })

  it("el lado escritura rechaza lo que no es un entero en céntimos", () => {
    expect(() => centsToDb(Number.NaN, "debe")).toThrow(TypeError)
    expect(() => centsToDb(12.5, "debe")).toThrow(TypeError)
  })

  it("`null` de una columna opcional sigue siendo `null`, no 0", () => {
    expect(centsFromDbNullable(null)).toBeNull()
    expect(centsFromDbNullable(undefined)).toBeNull()
    expect(centsFromDbNullable(BigInt(0))).toBe(0)
  })
})
