/**
 * E9 · T8 — `lib/closing/vat.ts` y `lib/closing/model303.map.ts`
 * (R-IVA-8…20, ADR-0016 D4/D8/D12, O-9…O-16 y O-27).
 *
 * Dos bloques: los casos obligatorios de todo módulo puro (CLAUDE.md) —vacío, un
 * registro, importes negativos, fechas límite y redondeo de céntimos— y el que
 * sella la tarea: los diecinueve casos de
 * `docs/design/fixtures/liquidacion-iva-esperada.json`, reconstruidos **byte a
 * byte** contra el JSON que genera `build_liquidacion_iva_esperada.py`, que los
 * calcula sin tocar `lib/`.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  capitalGoodsGuard,
  casillas303,
  checkBox71EqualsSettlement,
  checkBridge15aPrime,
  checkBridge15cPrime,
  checkIE98aPrime,
  checkReccFullyAccrued,
  checkWithholdingByModel,
  duaVatEffect,
  lastVatPeriodOfYear,
  prorrataDefinitivaBps,
  prorrataRegularization,
  prorrataRegularizationLines,
  prorrataSpecialGuard,
  prorrataTerms,
  prorrateableQuotaCents,
  provisionalBpsForNextYear,
  reccAccrualOnCollection,
  reccCollectionLines,
  reccYearEndSweep,
  vatPeriodBounds,
  vatPeriodForDates,
  vatPeriodKindOf,
  vatPeriodOf,
  vatPeriodTotals,
  vatRegimeAt,
  vatSettlement,
  withholdingAccountKey,
  withholdingSettlement,
  type CapitalGoodsInput,
  type IvaRegime,
  type ReccPendingRef,
  type VatBalanceRowE9,
  type VatBookRowE9,
  type VatPeriodKind,
  type VatRegimePeriodRef,
} from "@/lib/closing/vat"
import { model303Box, model303MapAt, notOfferedBoxes, offeredBoxes } from "@/lib/closing/model303.map"

const EXPECTED_PATH = path.join(process.cwd(), "docs", "design", "fixtures", "liquidacion-iva-esperada.json")

type ExpectedLiquidacion = {
  id: string
  titulo: string
  period: string
  periodKind: VatPeriodKind
  regime: IvaRegime
  importDeferral: boolean
  carryForwardCents: number
  previousDeclarationCents: number
  statePct: number
  prorrataAdjustmentCents: number
  book: VatBookRowE9[]
  balance: VatBalanceRowE9
}

type ExpectedProrrata = {
  id: string
  titulo: string
  year: number
  provisionalBps: number
  book: VatBookRowE9[]
}

type ExpectedRecc = {
  id: string
  titulo: string
  tipo: string
  cobro: {
    collectedCents: number
    totalInvoiceCents: number
    totalQuotaCents: number
    alreadyAccruedCents: number
    isFinal: boolean
  } | null
  pendientes: ReccPendingRef[] | null
  cutoff: string | null
}

type ExpectedBienes = { id: string; titulo: string; input: CapitalGoodsInput }

type ExpectedFile = {
  fixture: string
  epica: string
  tarea: string
  reglas: string
  liquidaciones: ExpectedLiquidacion[]
  prorratas: ExpectedProrrata[]
  recc: ExpectedRecc[]
  bienesInversion: ExpectedBienes[]
  checks: { id: string; expected: unknown; actual: unknown; status: string }[]
}

const expectedText = readFileSync(EXPECTED_PATH, "utf8")
const expected = JSON.parse(expectedText) as ExpectedFile

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios (CLAUDE.md): vacío, un registro, negativos, límites
// ─────────────────────────────────────────────────────────────────────────────

const emptyBalance = (period: string): VatBalanceRowE9 => ({
  ivaPeriod: period,
  saldo472Cents: 0,
  saldo477Cents: 0,
  saldo4728Cents: 0,
  saldo4778Cents: 0,
})

const bookRow = (over: Partial<VatBookRowE9> = {}): VatBookRowE9 => ({
  id: "b1",
  entryId: "b1",
  ivaPeriod: "2026-Q1",
  tipo: "EMITIDAS",
  docKind: "FACTURA",
  operationKey: "INTERIOR",
  rateBps: 2100,
  baseCents: 100_000,
  baseEnPeriodoCents: 100_000,
  cuotaTotalCents: 21_000,
  cuotaDeducibleCents: 0,
  cuotaNoDeducibleAlCosteCents: 0,
  cuotaRepercutidaCents: 21_000,
  cuotaDevengadaIspAibCents: 0,
  cuotaDevengadaEnPeriodoCents: 21_000,
  cuotaDeducibleEnPeriodoCents: 0,
  investmentGood: false,
  deductibility: null,
  recc: false,
  importDeferred: false,
  documentDate: "2026-02-10",
  deductionDate: "2026-02-10",
  ...over,
})

describe("R-IVA-8 · el periodo y el régimen fechado", () => {
  it("mensual y trimestral, con los límites del año", () => {
    expect(vatPeriodOf("2026-01-01", "MENSUAL")).toBe("2026-01")
    expect(vatPeriodOf("2026-12-31", "MENSUAL")).toBe("2026-12")
    expect(vatPeriodOf("2026-01-01", "TRIMESTRAL")).toBe("2026-Q1")
    expect(vatPeriodOf("2026-12-31", "TRIMESTRAL")).toBe("2026-Q4")
    // 29-feb: caso límite obligatorio.
    expect(vatPeriodOf("2028-02-29", "MENSUAL")).toBe("2028-02")
    expect(vatPeriodBounds("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" })
    expect(vatPeriodBounds("2026-Q4")).toEqual({ start: "2026-10-01", end: "2026-12-31" })
    expect(vatPeriodKindOf("2026-Q3")).toBe("TRIMESTRAL")
    expect(vatPeriodKindOf("2026-07")).toBe("MENSUAL")
    expect(() => vatPeriodKindOf("2026-Q5")).toThrow(TypeError)
    expect(lastVatPeriodOfYear(2026, "MENSUAL")).toBe("2026-12")
    expect(lastVatPeriodOfYear(2026, "TRIMESTRAL")).toBe("2026-Q4")
  })

  it("el `kind` es el vigente A ESA FECHA, no el de hoy (D8.1)", () => {
    const regimes: VatRegimePeriodRef[] = [
      { regime: "GENERAL", periodKind: "TRIMESTRAL", importDeferral: false, validFrom: "2025-01-01", validTo: "2026-12-31" },
      { regime: "REDEME", periodKind: "MENSUAL", importDeferral: true, validFrom: "2027-01-01", validTo: null },
    ]
    expect(vatRegimeAt(regimes, "2026-06-30")?.periodKind).toBe("TRIMESTRAL")
    expect(vatRegimeAt(regimes, "2027-01-01")?.regime).toBe("REDEME")
    expect(vatRegimeAt(regimes, "2024-12-31")).toBeNull()

    // `max(receptionDate, documentDate)`: un documento de diciembre recibido en
    // enero se deduce en el periodo de enero, y con el régimen de enero.
    const r = vatPeriodForDates("2027-01-08", "2026-12-28", regimes)
    expect(r.ok && r.value).toEqual({
      period: "2027-01",
      date: "2027-01-08",
      regime: regimes[1],
    })
    const sinRegimen = vatPeriodForDates(null, "2024-05-05", regimes)
    expect(sinRegimen.ok).toBe(false)
  })
})

describe("R-IVA-9 · la liquidación sale del libro; el diario verifica", () => {
  it("libro vacío: ni devengado ni deducible, y el asiento vale cero", () => {
    const out = vatSettlement({ period: "2026-Q1", regime: "GENERAL", book: [], balance: emptyBalance("2026-Q1") })
    expect(out.ok && out.value.outputCents).toBe(0)
    expect(out.ok && out.value.inputCents).toBe(0)
    expect(out.ok && out.value.periodStart).toBe("2026-01-01")
    expect(out.ok && out.value.periodEnd).toBe("2026-03-31")
  })

  it("un registro: el periodo declara exactamente esa cuota", () => {
    const book = [bookRow()]
    const out = vatSettlement({
      period: "2026-Q1",
      regime: "GENERAL",
      book,
      balance: { ...emptyBalance("2026-Q1"), saldo477Cents: 21_000 },
    })
    expect(out.ok && out.value.outputCents).toBe(21_000)
    expect(vatPeriodTotals(book, "2026-Q1").bookIssuedCents).toBe(21_000)
  })

  it("una cuota alterada por SQL: no se postea y se nombra el asiento (criterio 12)", () => {
    const book = [bookRow({ entryId: "e-77" })]
    const out = vatSettlement({
      period: "2026-Q1",
      regime: "GENERAL",
      book,
      balance: {
        ...emptyBalance("2026-Q1"),
        saldo477Cents: 20_000,
        byEntry: [{ entryId: "e-77", saldo472Cents: 0, saldo477Cents: 20_000 }],
      },
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.errors[0].code).toBe("DOCUMENT_TOTAL_MISMATCH")
      expect(out.errors[0].message).toContain("asiento e-77")
    }
  })

  it("la guardia de bienes de inversión impide postear el último periodo (O-12)", () => {
    const out = vatSettlement({
      period: "2026-Q4",
      regime: "GENERAL",
      book: [],
      balance: emptyBalance("2026-Q4"),
      capitalGoodsBlocking: true,
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors.some((e) => e.check === "R-IVA-16")).toBe(true)
  })

  it("rectificativas que dejan el periodo en negativo: se declara a mano", () => {
    const book = [
      bookRow({
        id: "neg",
        docKind: "RECTIFICATIVA",
        baseCents: -100_000,
        baseEnPeriodoCents: -100_000,
        cuotaTotalCents: -21_000,
        cuotaRepercutidaCents: -21_000,
        cuotaDevengadaEnPeriodoCents: -21_000,
      }),
    ]
    const out = vatSettlement({
      period: "2026-Q1",
      regime: "GENERAL",
      book,
      balance: { ...emptyBalance("2026-Q1"), saldo477Cents: -21_000 },
    })
    expect(out.ok).toBe(false)
  })
})

describe("O-14 · los puentes reformulados y I-E9-8a′", () => {
  it("15a′/15c′ pasan con RECC donde 15a/15c fallaban por diseño", () => {
    const book: VatBookRowE9[] = [
      bookRow({ id: "v", recc: true, cuotaDevengadaEnPeriodoCents: 86_776 }),
      bookRow({
        id: "c",
        tipo: "RECIBIDAS",
        recc: true,
        cuotaRepercutidaCents: 0,
        cuotaDevengadaEnPeriodoCents: 0,
        cuotaDeducibleCents: 42_000,
        cuotaDeducibleEnPeriodoCents: 0,
        cuotaTotalCents: 42_000,
      }),
    ]
    const balances: VatBalanceRowE9[] = [
      { ivaPeriod: "2026-Q1", saldo472Cents: 0, saldo477Cents: 86_776, saldo4728Cents: 42_000, saldo4778Cents: -65_776 },
    ]
    expect(checkBridge15aPrime(book, balances).status).toBe("PASS")
    expect(checkBridge15cPrime(book, balances).status).toBe("PASS")
  })

  it("I-E9-8a′ exige 472 y 477 a cero tras T-23 y recomputa el resultado", () => {
    const book = [bookRow()]
    const balances: VatBalanceRowE9[] = [emptyBalance("2026-Q1")]
    expect(checkIE98aPrime(book, balances, [{ period: "2026-Q1", resultCents: 21_000 }]).status).toBe("PASS")
    expect(checkIE98aPrime(book, balances, [{ period: "2026-Q1", resultCents: 1 }]).status).toBe("FAIL")
    const sucio: VatBalanceRowE9[] = [{ ...emptyBalance("2026-Q1"), saldo477Cents: 5 }]
    expect(checkIE98aPrime(book, sucio, [{ period: "2026-Q1", resultCents: 21_000 }]).status).toBe("FAIL")
  })
})

describe("R-IVA-11…15 · prorrata", () => {
  it("redondeo AL ALZA y sus bordes (art. 104.Dos.2ª)", () => {
    expect(prorrataDefinitivaBps(8_700_000, 10_000_000)).toBe(8_700)
    expect(prorrataDefinitivaBps(8_700_001, 10_000_000)).toBe(8_800)
    expect(prorrataDefinitivaBps(1, 10_000_000)).toBe(100)
    expect(prorrataDefinitivaBps(0, 10_000_000)).toBe(0)
    expect(prorrataDefinitivaBps(10_000_000, 10_000_000)).toBe(10_000)
    expect(() => prorrataDefinitivaBps(1, 0)).toThrow(RangeError)
  })

  it("la base del ajuste es la PRORRATEABLE, no lo ya deducido (O-9)", () => {
    const positivo = prorrataRegularization({ prorrateableQuotaCents: 100_000, provisionalBps: 8_000, definitiveBps: 8_700 })
    expect(positivo).toEqual({ adjustmentCents: 7_000, accountKey: "AJUSTE_PRORRATA_POSITIVO" })
    // La lectura errónea daba 5 600: 1 400 céntimos de diferencia.
    expect(positivo.adjustmentCents).not.toBe(5_600)
    const negativo = prorrataRegularization({ prorrateableQuotaCents: 100_000, provisionalBps: 8_000, definitiveBps: 7_500 })
    expect(negativo).toEqual({ adjustmentCents: -5_000, accountKey: "AJUSTE_PRORRATA_NEGATIVO" })

    expect(prorrataRegularizationLines(positivo, 2026)).toEqual([
      { lineNo: 1, accountKey: "IVA_SOPORTADO", debitCents: 7_000, creditCents: 0, description: "Regularización de la prorrata definitiva 2026 (art. 105 LIVA)" },
      { lineNo: 2, accountKey: "AJUSTE_PRORRATA_POSITIVO", debitCents: 0, creditCents: 7_000, description: "Regularización de la prorrata definitiva 2026 (art. 105 LIVA)" },
    ])
    expect(prorrataRegularizationLines(negativo, 2026)[0].accountKey).toBe("AJUSTE_PRORRATA_NEGATIVO")
    expect(prorrataRegularizationLines({ adjustmentCents: 0, accountKey: "AJUSTE_PRORRATA_POSITIVO" }, 2026)).toEqual([])
  })

  it("redondeo de céntimos: el ajuste trunca cada término por separado", () => {
    // 33 333 × 87 % = 28 999,71 → 28 999; × 80 % = 26 666,4 → 26 666.
    const reg = prorrataRegularization({ prorrateableQuotaCents: 33_333, provisionalBps: 8_000, definitiveBps: 8_700 })
    expect(reg.adjustmentCents).toBe(28_999 - 26_666)
  })

  it("la provisional de N+1 es la definitiva de N (art. 105.Dos)", () => {
    expect(provisionalBpsForNextYear(8_700)).toBe(8_700)
  })

  it("prorrata especial y sectores diferenciados se bloquean, no se aproximan", () => {
    expect(prorrataSpecialGuard({ specialProrrata: false, differentiatedSectors: false }).status).toBe("PASS")
    const bloqueada = prorrataSpecialGuard({ specialProrrata: true, differentiatedSectors: false })
    expect(bloqueada.status).toBe("FAIL")
    expect(bloqueada.blocking).toBe(true)
  })

  it("libro vacío: INFO por denominador 0, nunca 0 %", () => {
    const terms = prorrataTerms([], 2026)
    expect(terms.status).toBe("INFO")
    expect(terms.definitiveBps).toBeNull()
    expect(prorrateableQuotaCents([], 2026)).toBe(0)
  })
})

describe("R-IVA-16 (O-12) · guardia de bienes de inversión", () => {
  it("sin bienes en ventana, el paso pasa", () => {
    expect(capitalGoodsGuard({ year: 2026, prorrataByYear: [{ year: 2026, bps: 8_500 }], assets: [] }).status).toBe("PASS")
  })
})

describe("R-IVA-18 (O-16) · DUA", () => {
  it("sin diferimiento no genera 477; con diferimiento sí, y exige MENSUAL", () => {
    const ordinaria = duaVatEffect({
      customsValueCents: 12_000_000,
      dutiesCents: 500_000,
      vatQuotaCents: 2_520_000,
      importDeferral: false,
      periodKind: "TRIMESTRAL",
      investmentGood: false,
    })
    expect(ordinaria.ok && ordinaria.value.accruedCents).toBe(0)
    expect(ordinaria.ok && ordinaria.value.generatesOutputVat).toBe(false)
    expect(ordinaria.ok && ordinaria.value.boxes).toEqual({ base: "32", quota: "33", deferred: null })

    const diferida = duaVatEffect({
      customsValueCents: 12_000_000,
      dutiesCents: 500_000,
      vatQuotaCents: 2_520_000,
      importDeferral: true,
      periodKind: "MENSUAL",
      investmentGood: true,
    })
    expect(diferida.ok && diferida.value.accruedCents).toBe(2_520_000)
    expect(diferida.ok && diferida.value.boxes).toEqual({ base: "34", quota: "35", deferred: "77" })

    const trimestral = duaVatEffect({
      customsValueCents: 1,
      dutiesCents: 0,
      vatQuotaCents: 0,
      importDeferral: true,
      periodKind: "TRIMESTRAL",
      investmentGood: false,
    })
    expect(trimestral.ok).toBe(false)
  })
})

describe("R-IVA-19 (O-15) · RECC", () => {
  it("cobro parcial, residuo al último y suma exacta", () => {
    const primero = reccAccrualOnCollection({
      collectedCents: 500_000,
      totalInvoiceCents: 1_210_000,
      totalQuotaCents: 210_000,
      alreadyAccruedCents: 0,
      isFinal: false,
    })
    expect(primero).toBe(86_776)
    const ultimo = reccAccrualOnCollection({
      collectedCents: 710_000,
      totalInvoiceCents: 1_210_000,
      totalQuotaCents: 210_000,
      alreadyAccruedCents: primero,
      isFinal: true,
    })
    expect(primero + ultimo).toBe(210_000)
    expect(reccCollectionLines(primero, "F-1")).toHaveLength(2)
    expect(reccCollectionLines(0, "F-1")).toEqual([])
    expect(() =>
      reccAccrualOnCollection({ collectedCents: 1, totalInvoiceCents: 0, totalQuotaCents: 0, alreadyAccruedCents: 0, isFinal: false })
    ).toThrow(TypeError)
  })

  it("el barrido del 31/12 sólo alcanza al año anterior", () => {
    const pending: ReccPendingRef[] = [
      { id: "1", side: "EMITIDA", documentNumber: "F-1", operationDate: "2026-05-10", totalQuotaCents: 100, accruedCents: 40 },
      { id: "2", side: "EMITIDA", documentNumber: "F-2", operationDate: "2027-05-10", totalQuotaCents: 100, accruedCents: 0 },
    ]
    const lines = reccYearEndSweep(pending, "2027-12-31")
    expect(lines).toHaveLength(2)
    expect(lines[0].debitCents).toBe(60)
    expect(checkReccFullyAccrued(pending, "2027-12-31").status).toBe("FAIL")
    expect(reccYearEndSweep([], "2027-12-31")).toEqual([])
  })
})

describe("D12 (O-27) · retenciones por modelo", () => {
  it("cada modelo va a su subcuenta, por AccountKey y nunca por código", () => {
    expect(withholdingAccountKey("111")).toBe("IRPF_A_PAGAR_111")
    expect(withholdingAccountKey("115")).toBe("IRPF_A_PAGAR_115")
    expect(withholdingAccountKey("123")).toBe("IRPF_A_PAGAR_123")
    const rows = [
      { id: "w1", period: "2026-Q4", model: "111" as const, practicadoCents: 30_000, abonadoCents: 30_000 },
      { id: "w2", period: "2026-Q4", model: "115" as const, practicadoCents: 12_000, abonadoCents: 12_000 },
    ]
    const out = withholdingSettlement(rows, "2026-Q4")
    expect(out.map((o) => o.model)).toEqual(["111", "115"])
    expect(out[0].lines[0].accountKey).toBe("IRPF_A_PAGAR_111")
    expect(checkWithholdingByModel(rows).status).toBe("PASS")
    expect(checkWithholdingByModel([{ ...rows[0], abonadoCents: 1 }]).status).toBe("FAIL")
    expect(withholdingSettlement([], "2026-Q4")).toEqual([])
  })
})

describe("O-13 · el mapa del 303", () => {
  it("ofrece la cadena completa y declara lo que no ofrece, con motivo", () => {
    const map = model303MapAt("2026-12-31")
    const ids = offeredBoxes(map).map((b) => b.box)
    for (const id of ["27", "44", "45", "46", "59", "60", "61", "64", "65", "66", "67", "69", "70", "71", "77"]) {
      expect(ids).toContain(id)
    }
    for (const id of ["16", "20", "26", "42", "47", "58", "68"]) {
      expect(ids).not.toContain(id)
      expect(model303Box("2026-12-31", id)?.notOfferedReason).toBeTruthy()
    }
    expect(notOfferedBoxes(map)).toHaveLength(11 + 12 + 2)
    // Toda casilla ofrecida tiene etiqueta, fórmula, origen y referencia legal.
    for (const b of offeredBoxes(map)) {
      expect(b.label.length).toBeGreaterThan(3)
      expect(b.formula.length).toBeGreaterThan(0)
      expect(b.legal.length).toBeGreaterThan(0)
    }
    expect(() => model303MapAt("2019-01-01")).toThrow(RangeError)
  })

  it("las casillas de RECC y la 77 sólo aparecen con su condición", () => {
    const general = casillas303({ period: "2026-Q1", book: [bookRow()], regime: "GENERAL", importDeferral: false })
    expect(general.cells.map((c) => c.box)).not.toContain("62")
    expect(general.cells.map((c) => c.box)).not.toContain("77")
    const recc = casillas303({ period: "2026-Q1", book: [bookRow({ recc: true })], regime: "RECC", importDeferral: true })
    expect(recc.cells.map((c) => c.box)).toContain("62")
    expect(recc.cells.map((c) => c.box)).toContain("77")
    // Cada celda dice de dónde sale.
    for (const cell of recc.cells) expect(cell.provenance.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// El fixture, byte a byte
// ─────────────────────────────────────────────────────────────────────────────

type Check = { id: string; expected: unknown; actual: unknown; status: "PASS" | "FAIL" }

const checkOf = (id: string, expectedValue: unknown, actual: unknown): Check => ({
  id,
  expected: expectedValue,
  actual,
  status: expectedValue === actual ? "PASS" : "FAIL",
})

describe("liquidacion-iva-esperada.json · los diecinueve casos del diseño", () => {
  it("reproduce el fichero byte a byte", () => {
    const liquidaciones = expected.liquidaciones.map((c) => {
      const totals = vatPeriodTotals(c.book, c.period)
      const settlement = vatSettlement({
        period: c.period,
        regime: c.regime,
        book: c.book,
        balance: c.balance,
        carryForwardCents: c.carryForwardCents,
        prorrataAdjustmentCents: c.prorrataAdjustmentCents,
      })
      const view = casillas303({
        period: c.period,
        book: c.book,
        regime: c.regime,
        importDeferral: c.importDeferral,
        carryForwardCents: c.carryForwardCents,
        previousDeclarationCents: c.previousDeclarationCents,
        statePct: c.statePct,
        prorrataAdjustmentCents: c.prorrataAdjustmentCents,
      })
      const adjustments = { [c.period]: c.prorrataAdjustmentCents }
      const libroDeducible = totals.bookReceivedCents + c.prorrataAdjustmentCents
      const libroDevengado = totals.bookIssuedCents + totals.importDeferredCents
      return {
        id: c.id,
        titulo: c.titulo,
        period: c.period,
        periodKind: c.periodKind,
        regime: c.regime,
        importDeferral: c.importDeferral,
        carryForwardCents: c.carryForwardCents,
        previousDeclarationCents: c.previousDeclarationCents,
        statePct: c.statePct,
        prorrataAdjustmentCents: c.prorrataAdjustmentCents,
        book: c.book,
        balance: c.balance,
        bounds: vatPeriodBounds(c.period),
        totals: {
          outputCents: totals.outputCents,
          inputCents: totals.inputCents,
          nonDeductibleCents: totals.nonDeductibleCents,
          bookIssuedCents: totals.bookIssuedCents,
          bookReceivedCents: totals.bookReceivedCents,
          importDeferredCents: totals.importDeferredCents,
        },
        settlement: {
          ok: settlement.ok,
          periodStart: settlement.ok ? settlement.value.periodStart : null,
          periodEnd: settlement.ok ? settlement.value.periodEnd : null,
          outputCents: settlement.ok ? settlement.value.outputCents : null,
          inputCents: settlement.ok ? settlement.value.inputCents : null,
          carryForwardCents: settlement.ok ? (settlement.value.carryForwardCents ?? 0) : null,
          description: settlement.ok ? (settlement.value.description ?? null) : null,
        },
        boxes: view.cells.map((cell) => ({ box: cell.box, value: cell.value })),
        resultCents: view.resultCents,
        bridges: [
          { id: "I-E8-15a′", status: checkBridge15aPrime(c.book, [c.balance], adjustments).status },
          { id: "I-E8-15c′", status: checkBridge15cPrime(c.book, [c.balance]).status },
          // El enunciado ANTERIOR, sobre el mismo libro (O-14): con RECC falla
          // por hacer lo correcto, y por eso se reformuló.
          { id: "I-E8-15a", status: libroDeducible === c.balance.saldo472Cents ? "PASS" : "FAIL" },
          { id: "I-E8-15c", status: libroDevengado === c.balance.saldo477Cents ? "PASS" : "FAIL" },
        ],
      }
    })

    const prorratas = expected.prorratas.map((c) => {
      const terms = prorrataTerms(c.book, c.year)
      const quota = prorrateableQuotaCents(c.book, c.year)
      const regularization =
        terms.definitiveBps === null
          ? null
          : prorrataRegularization({
              prorrateableQuotaCents: quota,
              provisionalBps: c.provisionalBps,
              definitiveBps: terms.definitiveBps,
            })
      return {
        id: c.id,
        titulo: c.titulo,
        year: c.year,
        provisionalBps: c.provisionalBps,
        book: c.book,
        terms: {
          year: terms.year,
          numeratorCents: terms.numeratorCents,
          denominatorCents: terms.denominatorCents,
          definitiveBps: terms.definitiveBps,
          status: terms.status,
          unclassified: terms.unclassified,
          excluded: terms.excluded,
        },
        prorrateableQuotaCents: quota,
        regularization,
        lines: regularization ? prorrataRegularizationLines(regularization, c.year) : [],
      }
    })

    const recc = expected.recc.map((c) => {
      const devengado = c.cobro ? reccAccrualOnCollection(c.cobro) : null
      const lines = c.pendientes && c.cutoff ? reccYearEndSweep(c.pendientes, c.cutoff) : null
      const verdict = c.pendientes && c.cutoff ? checkReccFullyAccrued(c.pendientes, c.cutoff) : null
      return {
        id: c.id,
        titulo: c.titulo,
        tipo: c.tipo,
        cobro: c.cobro,
        devengadoCents: devengado,
        pendientes: c.pendientes,
        cutoff: c.cutoff,
        lines,
        check: verdict ? { id: verdict.id, status: verdict.status } : null,
      }
    })

    const bienesInversion = expected.bienesInversion.map((c) => {
      const guard = capitalGoodsGuard(c.input)
      return {
        id: c.id,
        titulo: c.titulo,
        input: c.input,
        guard: {
          step: guard.step,
          block: guard.block,
          status: guard.status,
          blocking: guard.blocking,
          sealReason: guard.sealReason ?? null,
        },
      }
    })

    const box = (caseId: string, boxId: string): number =>
      liquidaciones.find((c) => c.id === caseId)!.boxes.find((b) => b.box === boxId)!.value
    const caso = <T extends { id: string }>(cases: T[], id: string): T => cases.find((c) => c.id === id)!

    const checks: Check[] = []
    for (const c of liquidaciones) {
      const t23 = (c.settlement.outputCents ?? 0) - (c.settlement.inputCents ?? 0) - (c.settlement.carryForwardCents ?? 0)
      const b70 = c.boxes.find((b) => b.box === "70")!.value
      checks.push(checkOf(`criterio-16/71=T-23/${c.id}`, t23 - b70, c.resultCents))
      checks.push(
        checkOf(
          `criterio-16/45/${c.id}`,
          ["29", "31", "33", "35", "37", "39", "41", "43", "44"].reduce(
            (acc, k) => acc + c.boxes.find((b) => b.box === k)!.value,
            0
          ),
          c.boxes.find((b) => b.box === "45")!.value
        )
      )
    }
    checks.push(checkOf("criterio-16/27/L1", 312_500, box("L1", "27")))
    checks.push(checkOf("criterio-16/45/L1", 273_000, box("L1", "45")))
    checks.push(checkOf("criterio-16/46/L1", 39_500, box("L1", "46")))
    checks.push(checkOf("criterio-16/71/L1", 39_500, box("L1", "71")))
    checks.push(checkOf("O-16/77/L2", 2_520_000, box("L2", "77")))
    checks.push(checkOf("O-16/33/L2", 2_520_000, box("L2", "33")))
    checks.push(checkOf("O-16/71/L2", 420_000, box("L2", "71")))
    checks.push(checkOf("O-9/44/L3", 7_000, box("L3", "44")))
    checks.push(checkOf("O-11/71/L3", 114_000, box("L3", "71")))
    const l4 = caso(liquidaciones, "L4")
    const st = Object.fromEntries(l4.bridges.map((b) => [b.id, b.status]))
    checks.push(checkOf("O-14/15a′/L4", "PASS", st["I-E8-15a′"]))
    checks.push(checkOf("O-14/15c′/L4", "PASS", st["I-E8-15c′"]))
    checks.push(checkOf("O-14/15a-sin-4728/L4", "FAIL", st["I-E8-15a"]))
    checks.push(checkOf("O-14/15c-sin-4778/L4", "FAIL", st["I-E8-15c"]))
    checks.push(checkOf("O-15/09/L4", 86_776, box("L4", "09")))
    checks.push(checkOf("O-15/63/L4", 210_000, box("L4", "63")))
    const p1 = caso(prorratas, "P1")
    checks.push(checkOf("O-9/definitiva/P1", 8_700, p1.terms.definitiveBps))
    checks.push(checkOf("O-9/prorrateable/P1", 100_000, p1.prorrateableQuotaCents))
    checks.push(checkOf("O-9/ajuste/P1", 7_000, p1.regularization!.adjustmentCents))
    checks.push(checkOf("O-9/cuenta/P1", "AJUSTE_PRORRATA_POSITIVO", p1.regularization!.accountKey))
    const p2 = caso(prorratas, "P2")
    checks.push(checkOf("O-9/ajuste/P2", -5_000, p2.regularization!.adjustmentCents))
    checks.push(checkOf("O-9/cuenta/P2", "AJUSTE_PRORRATA_NEGATIVO", p2.regularization!.accountKey))
    checks.push(checkOf("R-IVA-11/alza/P3", 8_800, caso(prorratas, "P3").terms.definitiveBps))
    const p4 = caso(prorratas, "P4")
    checks.push(checkOf("O-10/info/P4", "INFO", p4.terms.status))
    checks.push(checkOf("O-10/sin-porcentaje/P4", null, p4.terms.definitiveBps))
    checks.push(checkOf("O-10/excluidas/P1", 1, p1.terms.excluded.length))
    checks.push(checkOf("R-IVA-11/denominador-0/P5", "INFO", caso(prorratas, "P5").terms.status))
    checks.push(checkOf("O-15/cobro-parcial/R1", 86_776, caso(recc, "R1").devengadoCents))
    checks.push(checkOf("O-15/residuo/R2", 123_224, caso(recc, "R2").devengadoCents))
    checks.push(
      checkOf("O-15/suma/R1+R2", 210_000, (caso(recc, "R1").devengadoCents ?? 0) + (caso(recc, "R2").devengadoCents ?? 0))
    )
    checks.push(checkOf("D8.4/barrido/R3", 4, caso(recc, "R3").lines!.length))
    checks.push(checkOf("I-E9-26/R3", "FAIL", caso(recc, "R3").check!.status))
    checks.push(checkOf("I-E9-26/R4", "PASS", caso(recc, "R4").check!.status))
    checks.push(checkOf("O-12/B1", "FAIL", caso(bienesInversion, "B1").guard.status))
    checks.push(
      checkOf("O-12/sello/B1", "REGULARIZACION_BIENES_INVERSION_PENDIENTE", caso(bienesInversion, "B1").guard.sealReason)
    )
    checks.push(checkOf("O-12/B2", "PASS", caso(bienesInversion, "B2").guard.status))
    checks.push(checkOf("O-12/umbral/B3", "PASS", caso(bienesInversion, "B3").guard.status))
    checks.push(checkOf("O-12/nueve-anos/B4", "FAIL", caso(bienesInversion, "B4").guard.status))
    checks.push(checkOf("O-12/desconocida/B5", "WARN", caso(bienesInversion, "B5").guard.status))

    const rebuilt = {
      fixture: expected.fixture,
      epica: expected.epica,
      tarea: expected.tarea,
      reglas: expected.reglas,
      liquidaciones,
      prorratas,
      recc,
      bienesInversion,
      checks,
    }
    expect(JSON.stringify(rebuilt, null, 2) + "\n").toBe(expectedText)
    expect(checks.every((c) => c.status === "PASS")).toBe(true)
  })

  it("la casilla 71 es el importe del asiento T-23 en los cuatro periodos", () => {
    for (const c of expected.liquidaciones) {
      const settlement = vatSettlement({
        period: c.period,
        regime: c.regime,
        book: c.book,
        balance: c.balance,
        carryForwardCents: c.carryForwardCents,
        prorrataAdjustmentCents: c.prorrataAdjustmentCents,
      })
      expect(settlement.ok).toBe(true)
      if (!settlement.ok) continue
      const view = casillas303({
        period: c.period,
        book: c.book,
        regime: c.regime,
        importDeferral: c.importDeferral,
        carryForwardCents: c.carryForwardCents,
        previousDeclarationCents: c.previousDeclarationCents,
        statePct: c.statePct,
        prorrataAdjustmentCents: c.prorrataAdjustmentCents,
      })
      expect(checkBox71EqualsSettlement(view, settlement.value).status).toBe("PASS")
    }
  })
})
