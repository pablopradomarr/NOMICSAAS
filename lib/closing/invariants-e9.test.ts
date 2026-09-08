/**
 * E9 · T11 — `lib/closing/invariants-e9.ts` (I-E9-1…26).
 *
 * Fixtures **adversariales**: cada invariante se prueba con el caso que lo hace
 * pasar y con el que lo rompe, y el conjunto vacío se prueba entero —porque el
 * riesgo de una capa de invariantes no es fallar, es **decir PASS sin haber
 * comprobado nada**—.
 */

import { describe, expect, it } from "vitest"

import {
  checkIE910,
  checkIE910b,
  checkIE911,
  checkIE912,
  checkIE913,
  checkIE914,
  checkIE915,
  checkIE916,
  checkIE917,
  checkIE918,
  checkIE919,
  checkIE920,
  checkIE921,
  checkIE922,
  checkIE923,
  checkIE924,
  checkIE925,
  checkIE91a,
  checkIE91b,
  checkIE92,
  checkIE93,
  checkIE94,
  checkIE95,
  checkIE96,
  checkIE97,
  checkIE98b,
  checkIE99,
  closingSealReasons,
  E9_INVARIANT_IDS,
  E9_SEAL_REASONS,
  E9_SEAL_REASON_TEXT,
  isE9SealReason,
  REOPENING_REVERSAL_TEMPLATES,
  runClosingInvariants,
  type ClosingInvariantInput,
} from "@/lib/closing/invariants-e9"
import { familyOf } from "@/lib/audit/families"
import type { ClosingStepResult } from "@/lib/closing/vat"
import type { PostedEntry } from "@/lib/ledger/types"

const CUTOFF = "2026-12-31"

// ─────────────────────────────────────────────────────────────────────────────
// El contrato de la capa
// ─────────────────────────────────────────────────────────────────────────────

describe("contrato: nunca un PASS que no se haya comprobado", () => {
  const vacio = runClosingInvariants({ cutoff: CUTOFF })

  it("devuelve los veintisiete resultados aunque no llegue ni un bloque", () => {
    expect(vacio).toHaveLength(E9_INVARIANT_IDS.length)
    expect(vacio.map((c) => c.id)).toEqual(E9_INVARIANT_IDS)
  })

  it("sin datos ninguno es PASS ni FAIL: todos INFO diciendo qué falta", () => {
    expect(vacio.every((c) => c.status === "INFO")).toBe(true)
    expect(vacio.every((c) => c.evidencia.length > 0)).toBe(true)
  })

  it("todos caen en la familia CIERRE del semáforo", () => {
    for (const id of E9_INVARIANT_IDS) expect(familyOf(id)).toBe("CIERRE")
  })
})

describe("los diez motivos de sello", () => {
  it("son diez, con código cerrado y texto para pantalla", () => {
    expect(E9_SEAL_REASONS).toHaveLength(10)
    for (const code of E9_SEAL_REASONS) {
      expect(E9_SEAL_REASON_TEXT[code].length).toBeGreaterThan(10)
      expect(isE9SealReason(code)).toBe(true)
    }
    expect(isE9SealReason("INVENTADO")).toBe(false)
  })

  it("H-4: se componen desde los pasos, y un paso en PASS no aporta motivo", () => {
    const steps: ClosingStepResult[] = [
      { step: "IVA_LIQUIDADO", block: "Fiscal", status: "PASS", blocking: true, evidencia: "ok", sealReason: "IVA_NO_LIQUIDADO" },
      { step: "RECLASIFICACION_VENCIMIENTOS", block: "Presentación", status: "FAIL", blocking: true, evidencia: "x", sealReason: "DEUDA_SIN_DESGLOSE" },
      { step: "RECURRENTES_AL_DIA", block: "Devengo", status: "WARN", blocking: false, evidencia: "x", sealReason: "RECURRENTES_PENDIENTES" },
      { step: "DEPOSITO_CUENTAS", block: "Societario", status: "NA", blocking: false, evidencia: "x", sealReason: "RESULTADO_SIN_DISTRIBUIR" },
      { step: "OTRO", block: "Fiscal", status: "FAIL", blocking: false, evidencia: "x", sealReason: "PRORRATA_NO_SOPORTADA" },
    ]
    expect(closingSealReasons(steps)).toEqual(["DEUDA_SIN_DESGLOSE", "RECURRENTES_PENDIENTES"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Recurrentes y activos
// ─────────────────────────────────────────────────────────────────────────────

describe("I-E9-1a/1b/2 · recurrentes", () => {
  const rules = [{ id: "r1", code: "REG-1", kind: "AMORTIZACION" as const }]

  it("1a pasa con ocurrencias únicas, con asiento y con motivo", () => {
    const r = checkIE91a({
      rules,
      occurrences: [
        { ruleId: "r1", ruleCode: "REG-1", period: "2026-01", status: "GENERADA", entryId: "e1" },
        { ruleId: "r1", ruleCode: "REG-1", period: "2026-02", status: "OMITIDA", entryId: null, reason: "CUOTA_CERO" },
      ],
    })
    expect(r.status).toBe("PASS")
  })

  it("1a delata la ocurrencia duplicada, la GENERADA sin asiento y la OMITIDA sin motivo", () => {
    const r = checkIE91a({
      rules,
      occurrences: [
        { ruleId: "r1", ruleCode: "REG-1", period: "2026-01", status: "GENERADA", entryId: null },
        { ruleId: "r1", ruleCode: "REG-1", period: "2026-01", status: "OMITIDA", entryId: null },
      ],
    })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("duplicada")
    expect(r.evidencia).toContain("sin asiento")
    expect(r.evidencia).toContain("sin motivo")
  })

  it("1b avisa cuando la ocurrencia nació con otra versión de la regla", () => {
    const occ = { ruleId: "r1", ruleCode: "REG-1", period: "2026-01", status: "GENERADA" as const, entryId: "e1" }
    expect(checkIE91b({ rules, occurrences: [{ ...occ, inputHash: "a", recomputedInputHash: "a" }] }).status).toBe("PASS")
    expect(checkIE91b({ rules, occurrences: [{ ...occ, inputHash: "a", recomputedInputHash: "b" }] }).status).toBe("WARN")
    expect(checkIE91b({ rules, occurrences: [occ] }).status).toBe("INFO")
  })

  it("2 compara lo posteado con el cuadro, tolerancia 0", () => {
    const totals = [{ ruleId: "r1", ruleCode: "REG-1", periods: ["2026-01"], postedCents: 166_666, scheduleCents: 166_666 }]
    expect(checkIE92({ rules, occurrences: [], depreciationTotals: totals }).status).toBe("PASS")
    expect(
      checkIE92({ rules, occurrences: [], depreciationTotals: [{ ...totals[0], postedCents: 166_667 }] }).status
    ).toBe("FAIL")
  })
})

describe("I-E9-3/4/5 · activos", () => {
  it("3 delata un cuadro persistido que el motor no reproduce", () => {
    expect(checkIE93([{ id: "a", code: "IM-1", scheduleHash: "x", recomputedScheduleHash: "x" }]).status).toBe("PASS")
    expect(checkIE93([{ id: "a", code: "IM-1", scheduleHash: "x", recomputedScheduleHash: "y" }]).status).toBe("FAIL")
  })

  it("4 (O-28) exige Σ cuotas = base y ninguna cuota negativa", () => {
    expect(checkIE94([{ id: "a", code: "IM-1", scheduleTotalCents: 900_000, amortizableBaseCents: 900_000 }]).status).toBe("PASS")
    expect(checkIE94([{ id: "a", code: "IM-1", scheduleTotalCents: 900_001, amortizableBaseCents: 900_000 }]).status).toBe("FAIL")
    expect(
      checkIE94([{ id: "a", code: "IM-1", scheduleTotalCents: 900_000, amortizableBaseCents: 900_000, hasNegativeQuota: true }]).status
    ).toBe("FAIL")
  })

  it("5 (O-19, criterio 8): el sobreamortizado compensado por otro sale FAIL, no PASS", () => {
    const sobre = { id: "a", code: "IM-1", expensePostedCents: 700_000, accumulatedCents: 600_000, amortizableBaseCents: 900_000 }
    const infra = { id: "b", code: "IM-2", expensePostedCents: 500_000, accumulatedCents: 600_000, amortizableBaseCents: 900_000 }
    const r = checkIE95([sobre, infra])
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("IM-1")
    expect(r.evidencia).toContain("IM-2")
  })

  it("5 sin atribución por activo es INFO nombrando los activos, JAMÁS PASS", () => {
    const r = checkIE95([{ id: "a", code: "IM-1", fullyAttributed: false }])
    expect(r.status).toBe("INFO")
    expect(r.evidencia).toContain("IM-1")
  })

  it("5 delata la acumulada por encima de la base amortizable", () => {
    const r = checkIE95([{ id: "a", code: "IM-1", expensePostedCents: 950_000, accumulatedCents: 950_000, amortizableBaseCents: 900_000 }])
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("base amortizable")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Periodificaciones
// ─────────────────────────────────────────────────────────────────────────────

describe("I-E9-6/7 · periodificaciones", () => {
  const agotada = {
    id: "ac1",
    code: "PE-1",
    periodEnd: "2026-11-30",
    totalCents: 100_000,
    accruedCents: 100_000,
    status: "AGOTADA" as const,
    pendingCents: 0,
  }

  it("6 exige devengo completo y saldo 0 en lo vencido", () => {
    expect(checkIE96({ accruals: [agotada] }, CUTOFF).status).toBe("PASS")
    expect(checkIE96({ accruals: [{ ...agotada, accruedCents: 90_000, pendingCents: 10_000 }] }, CUTOFF).status).toBe("FAIL")
  })

  it("6 no juzga lo que aún no ha vencido ni lo cancelado", () => {
    expect(checkIE96({ accruals: [{ ...agotada, periodEnd: "2027-06-30", accruedCents: 50_000, pendingCents: 50_000 }] }, CUTOFF).status).toBe("PASS")
  })

  it("7 cuadra el saldo de 480/485/567/568 con lo pendiente de las vivas", () => {
    const viva = { ...agotada, id: "ac2", code: "PE-2", periodEnd: "2027-06-30", status: "VIVA" as const, accruedCents: 40_000, pendingCents: 60_000 }
    expect(checkIE97({ accruals: [viva], accountBalanceCents: 60_000 }).status).toBe("PASS")
    expect(checkIE97({ accruals: [viva], accountBalanceCents: 59_999 }).status).toBe("FAIL")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IVA
// ─────────────────────────────────────────────────────────────────────────────

describe("I-E9-8b/9/10/10b/11/22 · IVA", () => {
  it("8b compara el periodo persistido con el recomputado", () => {
    const linea = { lineId: "l1", accountCode: "477", storedPeriod: "2026-Q4", recomputedPeriod: "2026-Q4", entryNumber: 12 }
    expect(checkIE98b({ vatLines: [linea] }).status).toBe("PASS")
    expect(checkIE98b({ vatLines: [{ ...linea, recomputedPeriod: "2027-Q1" }] }).status).toBe("FAIL")
  })

  it("9 (criterio 37) delata un `resultCents` alterado por SQL nombrando el periodo", () => {
    const lines = [
      { accountCode: "477", debitCents: 210_000, creditCents: 0 },
      { accountCode: "472", debitCents: 0, creditCents: 100_000 },
      { accountCode: "4750", debitCents: 0, creditCents: 110_000 },
    ]
    expect(checkIE99({ settlements: [{ period: "2026-Q4", resultCents: 110_000, entryLines: lines, recomputedLines: lines }] }).status).toBe("PASS")
    const r = checkIE99({
      settlements: [
        {
          period: "2026-Q4",
          resultCents: 110_000,
          entryLines: lines,
          recomputedLines: [...lines.slice(0, 2), { accountCode: "4750", debitCents: 0, creditCents: 120_000 }],
        },
      ],
    })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("2026-Q4")
  })

  const prorrata = {
    year: 2026,
    definitiveBps: 8_700,
    recomputedBps: 8_700,
    provisionalBps: 8_000,
    numeratorCents: 8_700_000,
    denominatorCents: 10_000_000,
    adjustmentCents: 7_000,
    prorrateableQuotaCents: 100_000,
  }

  it("10 (criterio 13) recomputa el ajuste sobre la cuota prorrateable: +7 000, no 5 600", () => {
    expect(checkIE910({ prorrata }).status).toBe("PASS")
    expect(checkIE910({ prorrata: { ...prorrata, adjustmentCents: 5_600 } }).status).toBe("FAIL")
  })

  it("10 exige múltiplo de 100 bps y la definitiva sellada = recomputada", () => {
    expect(checkIE910({ prorrata: { ...prorrata, definitiveBps: 8_712, recomputedBps: 8_712 } }).status).toBe("FAIL")
    expect(checkIE910({ prorrata: { ...prorrata, recomputedBps: 8_800 } }).status).toBe("FAIL")
  })

  it("10 (criterio 14) con documentos sin clave no da porcentaje: INFO con su lista", () => {
    const r = checkIE910({ prorrata: { ...prorrata, unclassifiedDocuments: ["F-2026/17"] } })
    expect(r.status).toBe("INFO")
    expect(r.evidencia).toContain("F-2026/17")
  })

  const prorrata10b = {
    ...prorrata,
    adjustmentPeriod: "2026-Q4",
    lastPeriodOfYear: "2026-Q4",
    postedBeforeSettlement: true,
    adjustment634639Cents: 7_000,
    adjustment472Cents: 7_000,
    nextYearProvisionalBps: 8_700,
  }

  it("10b exige último periodo, antes de su T-23, importes iguales y la provisional de N+1", () => {
    expect(checkIE910b({ prorrata: prorrata10b }).status).toBe("PASS")
    expect(checkIE910b({ prorrata: { ...prorrata10b, adjustmentPeriod: "2026-Q3" } }).status).toBe("FAIL")
    expect(checkIE910b({ prorrata: { ...prorrata10b, postedBeforeSettlement: false } }).status).toBe("FAIL")
    expect(checkIE910b({ prorrata: { ...prorrata10b, adjustment472Cents: 6_000 } }).status).toBe("FAIL")
    expect(checkIE910b({ prorrata: { ...prorrata10b, nextYearProvisionalBps: 8_000 } }).status).toBe("FAIL")
  })

  it("11 (B-6) rechaza una línea de IVA en un periodo ya liquidado", () => {
    const linea = { lineId: "l1", accountCode: "477", storedPeriod: "2026-Q3", recomputedPeriod: "2026-Q3", entryNumber: 40 }
    expect(checkIE911({ vatLines: [linea], settledPeriods: ["2026-Q2"] }).status).toBe("PASS")
    expect(checkIE911({ vatLines: [linea], settledPeriods: ["2026-Q3"] }).status).toBe("FAIL")
  })

  const dua = {
    documentNumber: "DUA-1",
    customsValueCents: 12_000_000,
    invoiceBaseCents: 11_500_000,
    bookedBaseCents: 12_000_000,
    vatQuotaCents: 2_520_000,
    importDeferral: false,
    outputVatCents: 0,
  }

  it("22 (criterio 18): sin diferimiento no hay 477; con diferimiento sí, y casilla 77", () => {
    expect(checkIE922({ dua: [dua] }).status).toBe("PASS")
    expect(checkIE922({ dua: [{ ...dua, outputVatCents: 2_520_000 }] }).status).toBe("FAIL")
    expect(
      checkIE922({ dua: [{ ...dua, importDeferral: true, outputVatCents: 2_520_000, box77Cents: 2_520_000 }] }).status
    ).toBe("PASS")
    expect(checkIE922({ dua: [{ ...dua, importDeferral: true, outputVatCents: 0 }] }).status).toBe("FAIL")
  })

  it("22 delata la base de la FACTURA anotada en vez de la del DUA", () => {
    const r = checkIE922({ dua: [{ ...dua, bookedBaseCents: 11_500_000 }] })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("base del DUA")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cierre, apertura y reapertura
// ─────────────────────────────────────────────────────────────────────────────

const entry = (over: Partial<PostedEntry> = {}): PostedEntry => ({
  id: "e1",
  organizationId: "org",
  fiscalYearId: "fy1",
  entryNumber: 100,
  entryDate: "2026-12-31",
  description: "Cierre",
  kind: "CLOSING",
  taxRoundingMode: "PER_LINE",
  sourceType: "MANUAL",
  lines: [
    {
      lineNo: 1,
      accountCode: "100",
      debitCents: 300_000,
      creditCents: 0,
      entryDate: "2026-12-31",
      fiscalYearId: "fy1",
      entryKind: "CLOSING",
    },
    {
      lineNo: 2,
      accountCode: "572",
      debitCents: 0,
      creditCents: 300_000,
      entryDate: "2026-12-31",
      fiscalYearId: "fy1",
      entryKind: "CLOSING",
    },
  ],
  ...over,
})

describe("I-E9-12/13/14/15 · regularización, cierre y apertura", () => {
  it("12 exige los grupos 6 y 7 a cero, 6300 incluida", () => {
    expect(checkIE912({ balancesAfterRegularization: { "6300": 0, "705": 0, "129": -500_000 } }).status).toBe("PASS")
    const r = checkIE912({ balancesAfterRegularization: { "6300": 500_000, "705": 0 } })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("6300")
  })

  it("13 compara 129 con el resultado I3", () => {
    expect(checkIE913({ balance129Cents: -1_497_322, resultI3Cents: -1_497_322 }).status).toBe("PASS")
    expect(checkIE913({ balance129Cents: -1_497_322, resultI3Cents: -1_497_000 }).status).toBe("FAIL")
  })

  it("14 compara cierre y apertura línea a línea y vigila el orden de O-8", () => {
    const closing = entry()
    const opening = entry({
      id: "e2",
      kind: "OPENING",
      entryNumber: 1,
      entryDate: "2027-01-01",
      lines: closing.lines.map((l) => ({
        ...l,
        debitCents: l.creditCents,
        creditCents: l.debitCents,
        entryDate: "2027-01-01",
        entryKind: "OPENING" as const,
      })),
    })
    expect(
      checkIE914({
        entries: [closing, opening],
        nextYearEntries: [
          { entryNumber: 1, kind: "OPENING" },
          { entryNumber: 2, kind: "REVERSAL", templateCode: "T-32", reversesEntryId: "e-32" },
        ],
      }).status
    ).toBe("PASS")

    const r = checkIE914({
      entries: [closing, opening],
      nextYearEntries: [
        { entryNumber: 1, kind: "REVERSAL", templateCode: "T-32", reversesEntryId: "e-32" },
        { entryNumber: 2, kind: "OPENING" },
      ],
    })
    expect(r.status).toBe("FAIL")
  })

  it("15 admite el contra-asiento de una reapertura registrada y sólo ése", () => {
    const base = { entryNumber: 7, fiscalYearCode: "2026", postedAt: "2027-05-01T10:00:00Z", kind: "REVERSAL" }
    expect(checkIE915({ postedAfterClose: [{ ...base, isReopeningReversal: true }] }).status).toBe("PASS")
    expect(checkIE915({ postedAfterClose: [{ ...base, isReopeningReversal: false }] }).status).toBe("FAIL")
  })
})

describe("I-E9-20/21 · ClosingRun y reapertura", () => {
  const run = {
    id: "cr1",
    fiscalYearCode: "2026",
    status: "CERRADO" as const,
    ledgerHash: "abcdef0123",
    configHash: "0123456789",
    stepsHash: "h",
    recomputedStepsHash: "h",
  }

  it("20 exige un solo CERRADO por ejercicio y el veredicto reproducible", () => {
    expect(checkIE920([run]).status).toBe("PASS")
    expect(checkIE920([run, { ...run, id: "cr2" }]).status).toBe("FAIL")
    expect(checkIE920([{ ...run, recomputedStepsHash: "otro" }]).status).toBe("FAIL")
  })

  it("21 (O-21) exige los CUATRO contra-asientos, con T-25 entre ellos", () => {
    const ok = {
      fiscalYearCode: "2026",
      reversedTemplates: REOPENING_REVERSAL_TEMPLATES,
      driftedAccounts: [],
      balance129Cents: 0,
      balance6300Cents: 0,
      pendingRecompute: ["VALOR_ACTUAL_APLAZAMIENTO", "DIFERENCIAS_DE_CAMBIO", "RECLASIFICACION_VENCIMIENTOS"],
    }
    expect(checkIE921(ok).status).toBe("PASS")
    const sinT25 = checkIE921({ ...ok, reversedTemplates: ["T-28", "T-27", "T-26"] })
    expect(sinT25.status).toBe("FAIL")
    expect(sinT25.evidencia).toContain("T-25")
    expect(checkIE921({ ...ok, balance6300Cents: 500_000 }).status).toBe("FAIL")
    expect(checkIE921({ ...ok, driftedAccounts: [{ accountCode: "572", beforeCents: 1, afterCents: 2 }] }).status).toBe("FAIL")
    expect(checkIE921(null).status).toBe("INFO")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reclasificación, divisa, valor actual y distribución
// ─────────────────────────────────────────────────────────────────────────────

describe("I-E9-16/25 · reclasificación", () => {
  const pairs = [{ longCode: "173", shortCode: "523" }]
  const base = { cutoff: CUTOFF, pairs }

  it("16 pasa cuando la suma por contraparte no cambia y todo está bien clasificado", () => {
    const r = checkIE916({
      ...base,
      positionsBefore: [{ accountCode: "523", counterpartyId: "cp", currency: "EUR", dueDate: "2028-06-30", openCents: -500_000, entryNumber: 1 }],
      positionsAfter: [{ accountCode: "173", counterpartyId: "cp", currency: "EUR", dueDate: "2028-06-30", openCents: -500_000, entryNumber: 1 }],
    })
    expect(r.status).toBe("PASS")
  })

  it("16 delata el total movido por la reclasificación", () => {
    const r = checkIE916({
      ...base,
      positionsBefore: [{ accountCode: "523", counterpartyId: "cp", currency: "EUR", dueDate: "2028-06-30", openCents: -500_000, entryNumber: 1 }],
      positionsAfter: [{ accountCode: "173", counterpartyId: "cp", currency: "EUR", dueDate: "2028-06-30", openCents: -400_000, entryNumber: 1 }],
    })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("no puede mover el total")
  })

  it("16 (lo que faltaba) delata el vencimiento dentro del año que sigue en la cuenta de largo", () => {
    const p = { accountCode: "173", counterpartyId: "cp", currency: "EUR", dueDate: "2027-03-31", openCents: -500_000, entryNumber: 1 }
    const r = checkIE916({ ...base, positionsBefore: [p], positionsAfter: [p] })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("sigue en la cuenta de largo")
  })

  it("16 delata la posición reclasificada sin vencimiento", () => {
    const p = { accountCode: "523", counterpartyId: "cp", currency: "EUR", dueDate: null, openCents: -500_000, entryNumber: 1 }
    const r = checkIE916({ ...base, positionsBefore: [p], positionsAfter: [p] })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("sin vencimiento")
  })

  it("25 (O-6) es FAIL sin declaración y WARN con motivo escrito", () => {
    expect(checkIE925({ ...base, positionsBefore: [], positionsAfter: [], debtsWithoutSchedule: [] }).status).toBe("PASS")
    expect(
      checkIE925({
        ...base,
        positionsBefore: [],
        positionsAfter: [],
        debtsWithoutSchedule: [{ reference: "PR-1", accountCode: "170", openCents: -3_000_000 }],
      }).status
    ).toBe("FAIL")
    expect(
      checkIE925({
        ...base,
        positionsBefore: [],
        positionsAfter: [],
        debtsWithoutSchedule: [{ reference: "PR-1", accountCode: "170", openCents: -3_000_000, declaredReason: "póliza sin cuadro, declarada por dirección" }],
      }).status
    ).toBe("WARN")
  })
})

describe("I-E9-17/18/24 · diferencias de cambio", () => {
  const rates = [{ currency: "USD", rateMicro: BigInt(900_000), rateDate: "2026-12-31" }]
  const ajustada = {
    accountCode: "400",
    counterpartyId: "cp",
    currency: "USD",
    baseBalanceCents: -450_000,
    currencyBalanceCents: -500_000,
    isMonetary: true,
  }

  it("17 pasa cuando D × r − S = 0 con la tasa sellada", () => {
    expect(checkIE917({ cutoff: CUTOFF, rates, positionsAfter: [ajustada], sealedRates: rates }).status).toBe("PASS")
  })

  it("17 delata la diferencia que sigue viva tras T-30", () => {
    const r = checkIE917({ cutoff: CUTOFF, rates, positionsAfter: [{ ...ajustada, baseBalanceCents: -460_000 }], sealedRates: rates })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("10000")
  })

  it("17 delata una tasa sellada que no es la efectiva del cierre", () => {
    const r = checkIE917({
      cutoff: CUTOFF,
      rates: [...rates, { currency: "USD", rateMicro: BigInt(910_000), rateDate: "2026-12-30" }],
      positionsAfter: [ajustada],
      sealedRates: [{ currency: "USD", rateMicro: BigInt(910_000), rateDate: "2026-12-30" }],
    })
    expect(r.status).toBe("FAIL")
  })

  it("18 exige Σ originalAmountCents = 0 por divisa", () => {
    expect(
      checkIE918({
        cutoff: CUTOFF,
        rates,
        positionsAfter: [],
        adjustmentLines: [{ accountCode: "400", originalCurrency: "USD", originalAmountCents: 0 }],
      }).status
    ).toBe("PASS")
    expect(
      checkIE918({
        cutoff: CUTOFF,
        rates,
        positionsAfter: [],
        adjustmentLines: [{ accountCode: "400", originalCurrency: "USD", originalAmountCents: 500 }],
      }).status
    ).toBe("FAIL")
  })

  it("24 delata una cuenta no monetaria dentro del barrido", () => {
    expect(checkIE924({ cutoff: CUTOFF, rates, positionsAfter: [ajustada] }).status).toBe("PASS")
    const r = checkIE924({
      cutoff: CUTOFF,
      rates,
      positionsAfter: [ajustada],
      nonMonetaryInSweep: [{ accountCode: "407", currency: "USD" }],
    })
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toContain("407")
  })
})

describe("I-E9-19 · valor actual", () => {
  const item = { reference: "PR-1", nominalCents: 10_000_000, presentValueCents: 8_899_964, scheduledInterestCents: 1_100_036, finalCarryingCents: 10_000_000 }

  it("pasa cuando el descuento se devenga íntegro y a vencimiento vale el nominal", () => {
    expect(checkIE919([item]).status).toBe("PASS")
  })

  it("delata el descuento que no se devenga entero y el pasivo que no llega al nominal", () => {
    expect(checkIE919([{ ...item, scheduledInterestCents: 1_100_000 }]).status).toBe("FAIL")
    expect(checkIE919([{ ...item, finalCarryingCents: 9_999_999 }]).status).toBe("FAIL")
  })

  it("sin aplazamientos descontados es INFO, no PASS", () => {
    expect(checkIE919([]).status).toBe("INFO")
  })
})

describe("I-E9-23 · distribución del resultado", () => {
  const aprobado = {
    fiscalYearCode: "2026",
    approvalStatus: "APROBADAS" as const,
    pending129Cents: 0,
    profitCents: 1_497_322,
    destinationsCents: 1_497_322,
    legalReserveCents: 149_732,
    legalReserveRequiredCents: 149_732,
    capitalSource: "DIARIO" as const,
  }

  it("pasa con 129 a cero, Σ destinos = resultado y la reserva legal dotada", () => {
    expect(checkIE923([aprobado]).status).toBe("PASS")
  })

  it("delata el 129 vivo, los destinos que no suman y la reserva legal corta", () => {
    expect(checkIE923([{ ...aprobado, pending129Cents: 1_497_322 }]).status).toBe("FAIL")
    expect(checkIE923([{ ...aprobado, destinationsCents: 1_000_000 }]).status).toBe("FAIL")
    expect(checkIE923([{ ...aprobado, legalReserveCents: 100_000 }]).status).toBe("FAIL")
  })

  it("R2-2: el capital declarado en vez de derivado del saldo de 100 sale WARN", () => {
    const r = checkIE923([{ ...aprobado, capitalSource: "DECLARADO" }])
    expect(r.status).toBe("WARN")
    expect(r.evidencia).toContain("100")
  })

  it("un ejercicio en BORRADOR no se juzga", () => {
    expect(checkIE923([{ ...aprobado, approvalStatus: "BORRADOR", pending129Cents: 1_497_322 }]).status).toBe("INFO")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La ejecución completa, con bloques reales
// ─────────────────────────────────────────────────────────────────────────────

describe("runClosingInvariants con bloques parciales", () => {
  const input: ClosingInvariantInput = {
    cutoff: CUTOFF,
    assets: [{ id: "a", code: "IM-1", scheduleHash: "x", recomputedScheduleHash: "x" }],
    presentValue: [
      { reference: "PR-1", nominalCents: 10_000_000, presentValueCents: 8_899_964, scheduledInterestCents: 1_100_036, finalCarryingCents: 10_000_000 },
    ],
  }
  const checks = runClosingInvariants(input)

  it("evalúa lo que puede y deja el resto en INFO, sin perder ningún id", () => {
    expect(checks.map((c) => c.id)).toEqual(E9_INVARIANT_IDS)
    expect(checks.find((c) => c.id === "I-E9-3")?.status).toBe("PASS")
    expect(checks.find((c) => c.id === "I-E9-19")?.status).toBe("PASS")
    expect(checks.find((c) => c.id === "I-E9-11")?.status).toBe("INFO")
    expect(checks.find((c) => c.id === "I-E9-11")?.evidencia).toContain("no evaluable")
  })
})
