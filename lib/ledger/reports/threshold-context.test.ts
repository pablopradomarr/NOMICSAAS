/**
 * E6 · revisión #2 — EV-1, EV-3, EV-5 y EV-6 **calculados**, no declarados.
 *
 * Lo que protegen: que el mes del cierre —donde el resultado se desploma por el
 * impuesto y la regularización— NO dispare `VARIACION_KPI`. Un sello que salta
 * en cada cierre es un sello que nadie lee.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { parseNpgcCsv } from "@/lib/accounts/csv"
import { checkThresholds, DEFAULT_REVIEW_THRESHOLDS } from "@/lib/ledger/report-run"
import { buildThresholdContext, incomeTaxEpigraphNumber } from "@/lib/ledger/reports/threshold-context"
import { buildAccountIndex, type ReportEntry, type ReportLine, type StatementAccount } from "@/lib/ledger/reports/types"

function seedAccounts(): StatementAccount[] {
  const parsed = parseNpgcCsv(readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8"))
  if (!parsed.ok) throw new Error("El seed no parsea")
  return parsed.value.map((r) => ({
    code: r.code,
    name: r.name,
    level: r.level,
    statement: r.statement,
    epigraph: r.epigraph,
    epigraphPymes: r.epigraphPymes,
    bidirectional: r.bidirectional,
    isContra: r.isContra,
    nature: r.nature,
    cashflowBucket: r.cashflowBucket,
  }))
}

const index = buildAccountIndex(seedAccounts())
const FY = "fy-2026"

const line = (
  over: Partial<ReportLine> & { accountCode: string; debitCents: number; creditCents: number }
): ReportLine => ({
  entryId: "e1",
  entryNumber: 1,
  entryDate: "2026-12-31",
  entryKind: "MANUAL",
  fiscalYearId: FY,
  lineNo: 1,
  ...over,
})

const entry = (over: Partial<ReportEntry> & { id: string }): ReportEntry => ({
  entryNumber: 1,
  entryDate: "2026-06-01",
  description: "x",
  kind: "MANUAL",
  sourceType: "MANUAL",
  ...over,
})

describe("incomeTaxEpigraphNumber — se DERIVA de la tabla de subtotales", () => {
  it("es el 20 en el modelo normal y el 19 en PYMES", () => {
    // Escribirlo a mano rompería el día que cambie el modelo; sale de A.4.
    expect(incomeTaxEpigraphNumber("GENERAL")).toBe(20)
    expect(incomeTaxEpigraphNumber("PYMES")).toBe(19)
  })
})

describe("EV-1 — el periodo con asientos de sistema se marca", () => {
  it("detecta OPENING, CLOSING y REGULARIZATION", () => {
    for (const kind of ["OPENING", "CLOSING", "REGULARIZATION"] as const) {
      const ctx = buildThresholdContext({
        lines: [line({ accountCode: "705", debitCents: 0, creditCents: 100, entryKind: kind })],
        index,
        variant: "PYMES",
      })
      expect(ctx.periodHasSystemEntries).toBe(true)
    }
  })

  it("un periodo normal no se marca", () => {
    const ctx = buildThresholdContext({
      lines: [line({ accountCode: "705", debitCents: 0, creditCents: 100 })],
      index,
      variant: "PYMES",
    })
    expect(ctx.periodHasSystemEntries).toBe(false)
  })
})

describe("EV-3 — el impuesto sobre beneficios se descuenta del `resultado`", () => {
  const lines = [
    line({ accountCode: "705", debitCents: 0, creditCents: 1_000_000 }),
    // El asiento del IS: epígrafe 19 en PYMES, estructural.
    line({ accountCode: "6300", debitCents: 400_000, creditCents: 0, entryId: "is" }),
  ]

  it("aísla el aporte del epígrafe del impuesto", () => {
    const ctx = buildThresholdContext({ lines, index, variant: "PYMES" })
    expect(ctx.structuralDeltaByKpi?.resultado).toBe(-400_000)
  })

  it("el mes del cierre NO dispara VARIACION_KPI gracias al descuento", () => {
    const current = { resultado: 1_000_000 - 400_000 }
    const previous = { resultado: 1_000_000 }
    // Sin el atenuante, −400 000 sobre 1 000 000 es −40 % y −4 000,00 €: dispara
    // (umbrales de `resultado`: 3000 bps Y 300 000 céntimos).
    expect(checkThresholds(current, previous, DEFAULT_REVIEW_THRESHOLDS)).toHaveLength(1)
    // Con él, la variación real del negocio es cero.
    const ctx = buildThresholdContext({ lines, index, variant: "PYMES" })
    expect(checkThresholds(current, previous, DEFAULT_REVIEW_THRESHOLDS, ctx)).toEqual([])
  })

  it("no toca los ingresos: el impuesto no está en el epígrafe 1", () => {
    const ctx = buildThresholdContext({ lines, index, variant: "PYMES" })
    expect(ctx.structuralDeltaByKpi?.ingresos).toBeUndefined()
  })
})

describe("EV-5 — un REVERSAL y su original en el mismo periodo se netean", () => {
  const original = entry({ id: "o1" })
  const reversal = entry({ id: "r1", kind: "REVERSAL", reversesEntryId: "o1" })
  const lines = [
    line({ entryId: "o1", accountCode: "705", debitCents: 0, creditCents: 500_000 }),
    line({ entryId: "r1", accountCode: "705", debitCents: 500_000, creditCents: 0 }),
  ]

  it("el neto del par es 0 y se calcula, no se asume", () => {
    const ctx = buildThresholdContext({ lines, entries: [original, reversal], index, variant: "PYMES" })
    expect(ctx.reversalNetByKpi).toEqual({ ingresos: 0, resultado: 0, ebitda: 0 })
  })

  it("un contra-asiento SIN su original en el periodo no se netea: la variación es real", () => {
    const ctx = buildThresholdContext({
      lines: [line({ entryId: "r1", accountCode: "705", debitCents: 500_000, creditCents: 0 })],
      entries: [reversal], // el original cayó en otro periodo
      index,
      variant: "PYMES",
    })
    expect(ctx.reversalNetByKpi).toEqual({})
  })

  it("un par MAL FORMADO (importes distintos) no se neutraliza en silencio", () => {
    const ctx = buildThresholdContext({
      lines: [
        line({ entryId: "o1", accountCode: "705", debitCents: 0, creditCents: 500_000 }),
        line({ entryId: "r1", accountCode: "705", debitCents: 400_000, creditCents: 0 }),
      ],
      entries: [original, reversal],
      index,
      variant: "PYMES",
    })
    expect(ctx.reversalNetByKpi?.ingresos).toBe(100_000)
  })
})

describe("EV-6 — sólo se comparan dimensiones vivas en los dos periodos", () => {
  it("intersecta y ordena", () => {
    const ctx = buildThresholdContext({
      lines: [],
      index,
      variant: "PYMES",
      dimensionsCurrent: ["p-b", "p-a", "p-nuevo"],
      dimensionsPrevious: ["p-a", "p-b", "p-viejo"],
    })
    expect(ctx.dimensionsAliveInBoth).toEqual(["p-a", "p-b"])
  })

  it("sin datos de dimensiones no se inventa la lista (el KPI se compara igual)", () => {
    const ctx = buildThresholdContext({ lines: [], index, variant: "PYMES" })
    expect(ctx.dimensionsAliveInBoth).toBeUndefined()
  })
})

describe("cierre y apertura completos", () => {
  it("un periodo con apertura, regularización y cierre no dispara nada", () => {
    const lines = [
      line({ accountCode: "572", debitCents: 4_000_000, creditCents: 0, entryKind: "OPENING", entryId: "ap" }),
      line({ accountCode: "705", debitCents: 0, creditCents: 2_000_000, entryId: "v1" }),
      line({ accountCode: "705", debitCents: 2_000_000, creditCents: 0, entryKind: "REGULARIZATION", entryId: "rg" }),
      line({ accountCode: "129", debitCents: 0, creditCents: 2_000_000, entryKind: "REGULARIZATION", entryId: "rg" }),
      line({ accountCode: "129", debitCents: 2_000_000, creditCents: 0, entryKind: "CLOSING", entryId: "ci" }),
    ]
    const ctx = buildThresholdContext({ lines, index, variant: "PYMES" })
    expect(ctx.periodHasSystemEntries).toBe(true)
    // Los tres `kind` están fuera del universo de la PyG, así que el resultado
    // del periodo es el de la venta y nada más: no hay variación que explicar.
    expect(ctx.structuralDeltaByKpi?.resultado).toBe(0)
    expect(
      checkThresholds({ resultado: 2_000_000 }, { resultado: 2_000_000 }, DEFAULT_REVIEW_THRESHOLDS, ctx)
    ).toEqual([])
  })
})
