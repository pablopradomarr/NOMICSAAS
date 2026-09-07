/**
 * E7 · T8 — Sugerencias deterministas: puntuación, agrupación por `reference1`,
 * empates sin sugerencia, estabilidad **byte a byte** y el techo de 5 000 × 5 000
 * de §8.
 */

import { describe, expect, it } from "vitest"

import { SCORE, buildMatchIndex, candidatesFor, suggestMatches, suggestionRows } from "@/lib/audit/bank-match"
import type { BankLineRef, LedgerCashLineRef } from "@/lib/bank/types"

let sequence = 0
const line = (over: Partial<BankLineRef> = {}): BankLineRef => {
  sequence += 1
  return {
    id: `bl-${String(sequence).padStart(4, "0")}`,
    statementId: "st-1",
    bankAccountId: "acc-1",
    lineNo: sequence,
    operationDate: "2026-01-10",
    valueDate: "2026-01-10",
    amountCents: -50000,
    currency: "EUR",
    description: "PAGO",
    sha256: `${sequence}`.padStart(64, "0"),
    status: "UNMATCHED",
    ...over,
  }
}

const cash = (over: Partial<LedgerCashLineRef> = {}): LedgerCashLineRef => {
  sequence += 1
  return {
    id: `jl-${String(sequence).padStart(4, "0")}`,
    organizationId: "org-1",
    entryId: `e-${sequence}`,
    entryNumber: sequence,
    entryDate: "2026-01-10",
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "5720001",
    debitCents: 0,
    creditCents: 50000,
    ...over,
  }
}

const CONFIG = { toleranceDays: 3 }

describe("regla 1 · sin importe exacto no hay candidato", () => {
  it("un céntimo de diferencia **no** es «casi»", () => {
    sequence = 0
    const l = line()
    const c = cash({ creditCents: 50001 })
    expect(suggestMatches([l], [c], CONFIG).size).toBe(0)
  })

  it("el signo cuenta: un cargo no casa con un debe del mismo importe", () => {
    sequence = 0
    const l = line({ amountCents: -50000 })
    const c = cash({ debitCents: 50000, creditCents: 0 })
    expect(suggestMatches([l], [c], CONFIG).size).toBe(0)
  })

  it("una línea ya conciliada o ignorada no se sugiere (regla 7)", () => {
    sequence = 0
    const c = cash()
    expect(suggestMatches([line({ status: "MATCHED" })], [c], CONFIG).size).toBe(0)
    expect(suggestMatches([line({ status: "IGNORED" })], [c], CONFIG).size).toBe(0)
  })

  it("un apunte ya conciliado tampoco vuelve a proponerse", () => {
    sequence = 0
    const l = line()
    const c = cash()
    expect(suggestMatches([l], [c], CONFIG, new Set([c.id])).size).toBe(0)
  })
})

describe("regla 2 y 3 · la distancia se mide sobre `operationDate` (O-6)", () => {
  it("misma fecha de operación: 10000 + 2000", () => {
    sequence = 0
    const l = line()
    const c = cash()
    const candidato = suggestMatches([l], [c], CONFIG).get(l.id)?.[0]
    expect(candidato?.scoreBps).toBe(SCORE.EXACT_AMOUNT + SCORE.SAME_OPERATION_DATE)
    expect(candidato?.reasons).toEqual(["IMPORTE_EXACTO", "MISMA_FECHA_OPERACION"])
    expect(candidato?.dateGapDays).toBe(0)
  })

  it("dentro de tolerancia: 1000 − 200·días, y el desfase queda sellado", () => {
    sequence = 0
    const l = line({ operationDate: "2026-01-12", valueDate: "2026-01-12" })
    const c = cash({ entryDate: "2026-01-10" })
    const candidato = suggestMatches([l], [c], CONFIG).get(l.id)?.[0]
    expect(candidato?.scoreBps).toBe(SCORE.EXACT_AMOUNT + 600)
    expect(candidato?.dateGapDays).toBe(2)
    expect(candidato?.reasons).toContain("FECHA_EN_TOLERANCIA")
  })

  it("fuera de tolerancia y sin fecha valor que case: no hay candidato", () => {
    sequence = 0
    const l = line({ operationDate: "2026-02-10", valueDate: "2026-02-10" })
    expect(suggestMatches([l], [cash()], CONFIG).size).toBe(0)
  })

  it("**la fecha valor informa y no decide** (criterio 22): suma 500 y lo declara", () => {
    sequence = 0
    const l = line({ operationDate: "2026-01-20", valueDate: "2026-02-02" })
    const c = cash({ entryDate: "2026-02-02" })
    const candidato = suggestMatches([l], [c], CONFIG).get(l.id)?.[0]
    expect(candidato?.scoreBps).toBe(SCORE.EXACT_AMOUNT + SCORE.VALUE_DATE)
    expect(candidato?.reasons).toContain("FECHA_VALOR")
    expect(candidato?.reasons).not.toContain("MISMA_FECHA_OPERACION")
  })

  it("referencia y contraparte suman lo que dice la tabla", () => {
    sequence = 0
    const l = line({ reference1: "REM-001", reference2: "FRA/2026/9", counterpartyName: "Acme, S.L." })
    const c = cash({ reference: "REM-001", counterpartyName: "ACME,  S.L." })
    const candidato = suggestMatches([l], [c], CONFIG).get(l.id)?.[0]
    expect(candidato?.scoreBps).toBe(
      SCORE.EXACT_AMOUNT + SCORE.SAME_OPERATION_DATE + SCORE.REFERENCE_1 + SCORE.COUNTERPARTY
    )
    expect(candidato?.reasons).toContain("REFERENCIA_1")
    expect(candidato?.reasons).toContain("CONTRAPARTE")
  })
})

describe("regla 4 · agrupación N-a-1 por `reference1` (O-15)", () => {
  it("catorce recibos con la misma referencia contra un abono se ofrecen **como grupo**", () => {
    sequence = 0
    const abono = line({ amountCents: 842000, reference1: "REM000000001" })
    const recibos = Array.from({ length: 14 }, (_, i) =>
      cash({ debitCents: i === 13 ? 62000 : 60000, creditCents: 0, reference: "REM000000001" })
    )
    const candidatos = suggestMatches([abono], recibos, CONFIG).get(abono.id) ?? []
    expect(candidatos).toHaveLength(1)
    expect(candidatos[0]?.kind).toBe("N_A_1")
    expect(candidatos[0]?.journalLineIds).toHaveLength(14)
    expect(candidatos[0]?.reasons).toContain("REFERENCIA_1")
  })

  it("si la suma del grupo **no** cuadra, no se ofrece (I-E7-11 manda)", () => {
    sequence = 0
    const abono = line({ amountCents: 842001, reference1: "REM000000001" })
    const recibos = Array.from({ length: 14 }, (_, i) =>
      cash({ debitCents: i === 13 ? 62000 : 60000, creditCents: 0, reference: "REM000000001" })
    )
    expect(suggestMatches([abono], recibos, CONFIG).size).toBe(0)
  })

  it("**sin `reference1` la agrupación no se ofrece**, aunque las sumas casen", () => {
    sequence = 0
    const abono = line({ amountCents: 120000, reference1: null })
    const recibos = [cash({ debitCents: 60000, creditCents: 0 }), cash({ debitCents: 60000, creditCents: 0 })]
    expect(suggestMatches([abono], recibos, CONFIG).size).toBe(0)
  })
})

describe("regla 5 · **empate ⇒ ninguna sugerencia**", () => {
  it("dos candidatos idénticos salen los dos y no se elige por el usuario", () => {
    sequence = 0
    const l = line()
    const c1 = cash()
    const c2 = cash()
    const candidatos = suggestMatches([l], [c1, c2], CONFIG).get(l.id) ?? []
    expect(candidatos).toHaveLength(2)
    expect(suggestionRows(suggestMatches([l], [c1, c2], CONFIG))[0]?.ambiguous).toBe(true)
  })

  it("con un desempate real (referencia) sí hay una sugerencia", () => {
    sequence = 0
    const l = line({ reference1: "REM-77" })
    const c1 = cash({ reference: "REM-77" })
    const c2 = cash()
    const candidatos = suggestMatches([l], [c1, c2], CONFIG).get(l.id) ?? []
    expect(candidatos).toHaveLength(1)
    expect(candidatos[0]?.journalLineIds).toEqual([c1.id])
  })
})

describe("regla 6 · pasadas deterministas y estabilidad byte a byte", () => {
  it("dos ejecuciones sobre el mismo estado dan **la misma lista**", () => {
    sequence = 0
    const lines = [line({ amountCents: -1000 }), line({ amountCents: -2000 }), line({ amountCents: -1000 })]
    const ledger = [
      cash({ creditCents: 1000 }),
      cash({ creditCents: 2000 }),
      cash({ creditCents: 1000 }),
      cash({ creditCents: 3000 }),
    ]
    const a = JSON.stringify([...suggestMatches(lines, ledger, CONFIG)])
    const b = JSON.stringify([...suggestMatches(lines, ledger, CONFIG)])
    expect(a).toBe(b)
  })

  it("el orden de LECTURA de la base no cambia el resultado (P7)", () => {
    sequence = 0
    const lines = [line({ amountCents: -1000 }), line({ amountCents: -2000 })]
    const ledger = [cash({ creditCents: 1000 }), cash({ creditCents: 2000 }), cash({ creditCents: 1000 })]
    const directo = JSON.stringify([...suggestMatches(lines, ledger, CONFIG)])
    const alReves = JSON.stringify([...suggestMatches([...lines].reverse(), [...ledger].reverse(), CONFIG)])
    expect(alReves).toBe(directo)
  })

  it("un apunte no se asigna a dos líneas: la primera pasada se lo queda", () => {
    sequence = 0
    const unico = cash({ creditCents: 5000 })
    const l1 = line({ id: "bl-a", amountCents: -5000, operationDate: "2026-01-10" })
    const l2 = line({ id: "bl-b", amountCents: -5000, operationDate: "2026-01-11" })
    const result = suggestMatches([l1, l2], [unico], CONFIG)
    const asignados = [...result.values()].flatMap((cs) => (cs.length === 1 ? cs[0]?.journalLineIds ?? [] : []))
    expect(asignados).toEqual([unico.id])
  })

  it("el mapa se devuelve ordenado por id de línea", () => {
    sequence = 0
    const l1 = line({ id: "bl-zzz", amountCents: -1000 })
    const l2 = line({ id: "bl-aaa", amountCents: -2000 })
    const result = suggestMatches([l1, l2], [cash({ creditCents: 1000 }), cash({ creditCents: 2000 })], CONFIG)
    expect([...result.keys()]).toEqual(["bl-aaa", "bl-zzz"])
  })
})

describe("rendimiento · 5 000 × 5 000 (§8, techo 700 ms)", () => {
  it("resuelve sin producto cartesiano y en tiempo", () => {
    const lines: BankLineRef[] = []
    const ledger: LedgerCashLineRef[] = []
    for (let i = 0; i < 5000; i++) {
      const amount = -(100000 + i)
      lines.push({
        id: `bl-${String(i).padStart(5, "0")}`,
        statementId: "st-1",
        bankAccountId: "acc-1",
        lineNo: i + 1,
        operationDate: "2026-01-10",
        valueDate: "2026-01-10",
        amountCents: amount,
        currency: "EUR",
        description: `MOVIMIENTO ${i}`,
        reference1: `REM${String(i).padStart(9, "0")}`,
        sha256: `${i}`.padStart(64, "0"),
        status: "UNMATCHED",
      })
      ledger.push({
        id: `jl-${String(i).padStart(5, "0")}`,
        organizationId: "org-1",
        entryId: `e-${i}`,
        entryNumber: i + 1,
        entryDate: "2026-01-10",
        entryKind: "NORMAL",
        fiscalYearId: "fy-2026",
        lineNo: 1,
        accountCode: "5720001",
        debitCents: 0,
        creditCents: -amount,
        reference: `REM${String(i).padStart(9, "0")}`,
      })
    }
    const start = performance.now()
    const result = suggestMatches(lines, ledger, CONFIG)
    const ms = performance.now() - start
    expect(result.size).toBe(5000)
    expect([...result.values()].every((cs) => cs.length === 1)).toBe(true)
    console.log(`suggestMatches 5 000 × 5 000: ${ms.toFixed(0)} ms`)
    expect(ms).toBeLessThan(700)
  })

  it("el índice agrupa por importe y por referencia, no compara todo con todo", () => {
    sequence = 0
    const index = buildMatchIndex([cash({ creditCents: 1000, reference: "R1" }), cash({ creditCents: 1000 })])
    expect(index.byAmount.get(-1000)).toHaveLength(2)
    expect(index.byReference.get("R1")).toHaveLength(1)
    expect(candidatesFor(line({ amountCents: -1000 }), index, CONFIG)).toHaveLength(2)
  })
})
