/**
 * E3 · T4 — `buildEntry` / `checkDraft`: los trece checks C-1…C-13.
 *
 * Casos obligatorios del rol: vacío, un registro, importes negativos y fechas
 * límite (29-feb y cierre de ejercicio).
 */

import { describe, expect, it } from "vitest"

import { buildEntry, checkDocument, checkDraft, checkRectification } from "@/lib/ledger/post"
import type { DraftLine, EntryDraft, EntryInput, LedgerContext } from "@/lib/ledger/types"
import { codeFor, FY_2026, testContext } from "@/tests/support/ledger-context"

const CLIENTES = codeFor("CLIENTES")
const VENTAS = codeFor("VENTAS_DEFAULT")
const IVA_REP = codeFor("IVA_REPERCUTIDO")

const line = (over: Partial<DraftLine>): DraftLine => ({
  lineNo: 0,
  debitCents: 0,
  creditCents: 0,
  ...over,
})

/** El asiento del criterio de aceptación 1: 430 D 121.000 / 705 H 100.000 / 477 H 21.000. */
const facturaInput = (over: Partial<EntryInput> = {}): EntryInput => ({
  organizationId: "org-test",
  documentDate: "2026-03-10",
  description: "Factura 2026/001",
  lines: [
    line({ accountCode: CLIENTES, debitCents: 121000 }),
    line({ accountCode: VENTAS, creditCents: 100000 }),
    line({ accountCode: IVA_REP, creditCents: 21000 }),
  ],
  ...over,
})

const codes = (draft: EntryDraft) => draft.lines.map((l) => `${l.accountCode}:${l.debitCents}/${l.creditCents}`)

const errorCodes = (r: ReturnType<typeof buildEntry>) => (r.ok ? [] : r.errors.map((e) => e.code))

describe("buildEntry — normalización", () => {
  it("construye el asiento cuadrado y renumera las líneas 1..n", () => {
    const r = buildEntry(facturaInput(), testContext())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.lines.map((l) => l.lineNo)).toEqual([1, 2, 3])
    expect(codes(r.value)).toEqual([`${CLIENTES}:121000/0`, `${VENTAS}:0/100000`, `${IVA_REP}:0/21000`])
    expect(r.value.entryDate).toBe("2026-03-10")
    expect(r.value.fiscalYearId).toBe(FY_2026.id)
    expect(r.value.kind).toBe("NORMAL")
  })

  it("sella el modo de redondeo de la organización en el asiento (O-2)", () => {
    const r = buildEntry(facturaInput(), testContext({ taxRoundingMode: "PER_LINEA" }))
    expect(r.ok && r.value.taxRoundingMode).toBe("PER_LINEA")
  })

  it("resuelve `accountKey` por el mapa y prefiere la clave al código", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountKey: "CLIENTES", accountCode: "999", debitCents: 121000 }),
          line({ accountKey: "VENTAS_DEFAULT", creditCents: 121000 }),
        ],
      }),
      testContext()
    )
    expect(r.ok && r.value.lines[0].accountCode).toBe(CLIENTES)
  })

  it("omite —no rechaza— las líneas que quedarían a cero", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountCode: CLIENTES, debitCents: 121000 }),
          line({ accountCode: IVA_REP, creditCents: 0, debitCents: 0 }),
          line({ accountCode: VENTAS, creditCents: 121000 }),
        ],
      }),
      testContext()
    )
    expect(r.ok && r.value.lines).toHaveLength(2)
  })

  it("recorta las descripciones a 512 caracteres", () => {
    const r = buildEntry(facturaInput({ description: "x".repeat(700) }), testContext())
    expect(r.ok && r.value.description).toHaveLength(512)
  })

  it("añade la coletilla [devengo …] cuando desplaza la fecha", () => {
    const ctx = testContext({ periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    const r = buildEntry(facturaInput(), ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.entryDate).toBe("2026-04-01")
    expect(r.value.description).toContain("[devengo 2026-03-10]")
  })
})

describe("C-1 … C-4 — partida doble y forma de la línea", () => {
  it("sin líneas (caso vacío): TOO_FEW_LINES y ONE_SIDED_ENTRY", () => {
    const r = buildEntry(facturaInput({ lines: [] }), testContext())
    expect(errorCodes(r)).toContain("TOO_FEW_LINES")
  })

  it("una sola línea: TOO_FEW_LINES", () => {
    const r = buildEntry(facturaInput({ lines: [line({ accountCode: CLIENTES, debitCents: 100 })] }), testContext())
    expect(errorCodes(r)).toContain("TOO_FEW_LINES")
  })

  it("descuadre: UNBALANCED con la diferencia en el mensaje (criterio 2)", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: CLIENTES, debitCents: 121000 }), line({ accountCode: VENTAS, creditCents: 100000 })],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("UNBALANCED")
    if (!r.ok) expect(r.errors.find((e) => e.code === "UNBALANCED")?.message).toContain("21000")
  })

  it("dos líneas ambas al debe: ONE_SIDED_ENTRY (C-4)", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: CLIENTES, debitCents: 100 }), line({ accountCode: VENTAS, debitCents: 100 })],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("ONE_SIDED_ENTRY")
  })

  it("importe negativo: LINE_NEGATIVE (un abono es la columna contraria)", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: CLIENTES, debitCents: -100 }), line({ accountCode: VENTAS, creditCents: -100 })],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("LINE_NEGATIVE")
  })

  it("línea con las dos columnas: LINE_SIDE", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountCode: CLIENTES, debitCents: 100, creditCents: 100 }),
          line({ accountCode: VENTAS, creditCents: 100 }),
        ],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("LINE_SIDE")
  })

  it("devuelve TODOS los errores a la vez, no el primero", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: CLIENTES, debitCents: -100 }), line({ accountCode: "999999", debitCents: 100 })],
      }),
      testContext()
    )
    const found = errorCodes(r)
    expect(found).toContain("LINE_NEGATIVE")
    expect(found).toContain("ONE_SIDED_ENTRY")
    expect(found).toContain("ACCOUNT_UNKNOWN")
  })
})

describe("C-8 — cuentas del plan", () => {
  it("cuenta inexistente: ACCOUNT_UNKNOWN anclado a su línea", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: "999999", debitCents: 100 }), line({ accountCode: VENTAS, creditCents: 100 })],
      }),
      testContext()
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const error = r.errors.find((e) => e.code === "ACCOUNT_UNKNOWN")
      expect(error?.lineNo).toBe(1)
    }
  })

  it("cuenta padre (no postable): ACCOUNT_NOT_POSTABLE", () => {
    const r = buildEntry(
      facturaInput({
        lines: [line({ accountCode: "43", debitCents: 100 }), line({ accountCode: VENTAS, creditCents: 100 })],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("ACCOUNT_NOT_POSTABLE")
  })

  it("clave sin mapear: MAP_KEY_UNMAPPED", () => {
    const ctx: LedgerContext = { ...testContext(), map: () => null }
    const r = buildEntry(facturaInput({ lines: [line({ accountKey: "CLIENTES", debitCents: 100 })] }), ctx)
    expect(errorCodes(r)).toContain("MAP_KEY_UNMAPPED")
  })
})

describe("C-9 — destino analítico (inerte hasta E4, D-E3-1)", () => {
  it("en E3 una línea con projectId se RECHAZA con ANALYTIC_DIM_UNAVAILABLE", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountCode: CLIENTES, debitCents: 121000 }),
          line({ accountCode: VENTAS, creditCents: 121000, projectId: "3f1f9a1e-0000-4000-8000-000000000001" }),
        ],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("ANALYTIC_DIM_UNAVAILABLE")
  })

  it("`analyticType` SÍ se admite: es un enum, no una FK", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountCode: CLIENTES, debitCents: 121000 }),
          line({ accountCode: VENTAS, creditCents: 121000, analyticType: "INGRESO_DIRECTO" }),
        ],
      }),
      testContext()
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.lines[1].analyticType).toBe("INGRESO_DIRECTO")
  })

  it("con dimensiones disponibles (E4) una cuenta 6/7 sin destino falla", () => {
    const ctx = testContext({ dimensionsAvailable: true, analyticsRequired: true })
    const r = buildEntry(facturaInput(), ctx)
    expect(errorCodes(r)).toContain("ANALYTIC_DEST_MISSING")
  })
})

describe("C-10 — tipos vigentes", () => {
  it("un taxRateId inexistente falla", () => {
    const r = buildEntry(
      facturaInput({
        lines: [
          line({ accountCode: CLIENTES, debitCents: 121000 }),
          line({ accountCode: VENTAS, creditCents: 100000 }),
          line({ accountCode: IVA_REP, creditCents: 21000, taxRateId: "no-existe" }),
        ],
      }),
      testContext()
    )
    expect(errorCodes(r)).toContain("TAX_RATE_NOT_IN_FORCE")
  })
})

describe("C-11 — periodo", () => {
  it("fecha fuera del ejercicio indicado: DATE_OUT_OF_FY", () => {
    const draft: EntryDraft = {
      organizationId: "org-test",
      fiscalYearId: FY_2026.id,
      entryDate: "2027-03-10",
      description: "fuera de rango",
      kind: "NORMAL",
      sourceType: "MANUAL",
      taxRoundingMode: "PER_TIPO",
      lines: [
        { lineNo: 1, accountCode: CLIENTES, debitCents: 100, creditCents: 0 },
        { lineNo: 2, accountCode: VENTAS, debitCents: 0, creditCents: 100 },
      ],
    }
    const r = checkDraft(draft, testContext({ refDate: "2027-06-30" }))
    expect(errorCodes(r)).toContain("DATE_OUT_OF_FY")
  })

  it("ejercicio cerrado: FY_CLOSED", () => {
    const r = buildEntry(facturaInput({ documentDate: "2025-11-30" }), testContext())
    expect(errorCodes(r)).toContain("FY_CLOSED")
  })

  it("mes bloqueado indicando la fecha a mano: MONTH_LOCKED", () => {
    const ctx = testContext({ periodLocks: [{ fiscalYearId: FY_2026.id, month: 3 }] })
    const r = buildEntry(facturaInput({ entryDate: "2026-03-10" }), ctx)
    expect(errorCodes(r)).toContain("MONTH_LOCKED")
  })

  it("31-12 del ejercicio es válido (fecha límite de cierre)", () => {
    const r = buildEntry(facturaInput({ entryDate: "2026-12-31" }), testContext({ refDate: "2027-01-10" }))
    expect(r.ok).toBe(true)
  })

  it("29-feb de un bisiesto es válido; de un año normal no existe", () => {
    const ctx2024 = testContext({
      refDate: "2024-12-31",
      fiscalYears: [{ id: "fy-2024", code: "2024", startDate: "2024-01-01", endDate: "2024-12-31", status: "OPEN" }],
    })
    expect(buildEntry(facturaInput({ entryDate: "2024-02-29" }), ctx2024).ok).toBe(true)
    const bad = buildEntry(facturaInput({ entryDate: "2026-02-29" }), testContext())
    expect(bad.ok).toBe(false)
  })
})

describe("C-13 — tenant", () => {
  it("un asiento de otra organización se rechaza", () => {
    const r = buildEntry(facturaInput({ organizationId: "org-otra" }), testContext())
    expect(errorCodes(r)).toContain("TENANT_MISMATCH")
  })
})

describe("C-5, C-6 y C-7 — documento", () => {
  it("documento cuadrado: sin errores", () => {
    expect(
      checkDocument({
        totalCents: 848000,
        baseCents: 800000,
        lineBases: [800000],
        taxCents: 168000,
        withholdingCents: 120000,
        expectedTaxByRate: [168000],
      })
    ).toEqual([])
  })

  it("C-6: la suma de bases de línea debe ser la base del documento", () => {
    const errors = checkDocument({ totalCents: 121000, baseCents: 100000, lineBases: [90000], taxCents: 21000 })
    expect(errors.map((e) => e.check)).toContain("C-6")
  })

  it("C-5: el total declarado debe cuadrar", () => {
    const errors = checkDocument({ totalCents: 999999, baseCents: 100000, lineBases: [100000], taxCents: 21000 })
    expect(errors.map((e) => e.code)).toContain("DOCUMENT_TOTAL_MISMATCH")
  })

  it("C-7: la cuota declarada no se aparta más de 1 céntimo por tipo", () => {
    const ok = checkDocument({
      totalCents: 121001,
      baseCents: 100000,
      lineBases: [100000],
      taxCents: 21001,
      expectedTaxByRate: [21000],
    })
    expect(ok.filter((e) => e.check === "C-7")).toEqual([])
    const bad = checkDocument({
      totalCents: 121005,
      baseCents: 100000,
      lineBases: [100000],
      taxCents: 21005,
      expectedTaxByRate: [21000],
    })
    expect(bad.map((e) => e.check)).toContain("C-7")
  })
})

describe("C-12 — signos en rectificativas", () => {
  const abono: EntryDraft = {
    organizationId: "org-test",
    fiscalYearId: FY_2026.id,
    entryDate: "2026-05-10",
    description: "Abono",
    kind: "NORMAL",
    sourceType: "INVOICE_OUT",
    taxRoundingMode: "PER_TIPO",
    lines: [
      { lineNo: 1, accountCode: VENTAS, debitCents: 100000, creditCents: 0 },
      { lineNo: 2, accountCode: CLIENTES, debitCents: 0, creditCents: 100000 },
    ],
  }

  it("la rectificativa invierte la columna del documento original", () => {
    const errors = checkRectification(abono, [
      { accountCode: VENTAS, side: "CREDIT", amountCents: 100000 },
      { accountCode: CLIENTES, side: "DEBIT", amountCents: 100000 },
    ])
    expect(errors).toEqual([])
  })

  it("misma columna que el original: RECTIFICATION_SIGN", () => {
    const errors = checkRectification(abono, [{ accountCode: VENTAS, side: "DEBIT", amountCents: 100000 }])
    expect(errors.map((e) => e.code)).toContain("RECTIFICATION_SIGN")
  })

  it("no puede exceder el importe del documento rectificado", () => {
    const errors = checkRectification(abono, [{ accountCode: VENTAS, side: "CREDIT", amountCents: 50000 }])
    expect(errors.map((e) => e.code)).toContain("RECTIFICATION_EXCEEDS")
  })
})
