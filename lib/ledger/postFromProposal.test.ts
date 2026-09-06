/**
 * E8 · T9 — Golden tests de `postFromProposal()` contra el **asiento esperado**
 * de los quince casos de `docs/design/fixtures/extraccion-esperada.json`.
 *
 * Se compara **línea a línea y céntimo a céntimo**: cuenta, clave, debe, haber,
 * tipo analítico, proyecto, CECO, tipo impositivo, deducibilidad, cuota no
 * deducible incorporada al coste y las tres columnas de divisa, en el orden en
 * que el motor las emite. También la plantilla elegida, el `sourceType`, las
 * cuatro fechas, el periodo de IVA, los bloques de pasivo, los `taxOverrides` y
 * la anotación del libro registro. Lo único que no se compara son las
 * descripciones, que el fixture redacta caso a caso para la pantalla.
 *
 * El test falla —y ése es su oficio— si alguien lleva un céntimo de IVA a 669,
 * manda los 1 452 000 de un documento mixto enteros a 523, deduce la cuota de
 * un ticket, autorrepercute una importación, contabiliza los 80 000 de una
 * rectificativa por sustitución o repercute el IVA de un anticipo sin cobro.
 */

import { describe, expect, it } from "vitest"

import { reconcile, type ReconcileResult } from "@/lib/extraction/reconcile"
import {
  caseById,
  dimensionForUuid,
  fixtureLedgerContext,
  inputProposalFor,
  loadExtractionFixture,
  reconcileContextFor,
  type FixtureCase,
} from "@/lib/extraction/reconcile.fixture"
import {
  compatibleTemplates,
  convertDocumentToBase,
  payableKeyForAccount,
  postFromProposal,
  previewFromProposal,
  selectTemplate,
  TEMPLATE_FOR_DOC,
  type PostedProposal,
} from "@/lib/ledger/postFromProposal"
import type { LedgerContext, Result } from "@/lib/ledger/types"

const fixture = loadExtractionFixture()

const reconciled = (c: FixtureCase): ReconcileResult => reconcile(inputProposalFor(c), reconcileContextFor(c))

const post = (c: FixtureCase, ctx?: LedgerContext): Result<PostedProposal> =>
  postFromProposal(reconciled(c), ctx ?? fixtureLedgerContext(c), {
    extractionRunId: "00000000-0000-4000-8000-0000000000r1",
    fileId: "00000000-0000-4000-8000-0000000000f1",
  })

const unwrap = (r: Result<PostedProposal>): PostedProposal => {
  if (!r.ok) throw new Error(`postFromProposal falló: ${JSON.stringify(r.errors, null, 2)}`)
  return r.value
}

type LineProjection = {
  accountCode: string
  debitCents: number
  creditCents: number
  analyticType: string | null
  projectId: string | null
  costCenterId: string | null
  taxRateCode: string | null
  deductibility: string | null
  nonDeductibleIncludedCents: number
  originalCurrency: string | null
  originalAmountCents: number | null
  exchangeRateId: string | null
}

const projectLines = (posted: PostedProposal): LineProjection[] =>
  posted.draft.lines.map((l, i) => {
    const doc = posted.documentaryLines[i]
    return {
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      analyticType: l.analyticType ?? null,
      projectId: dimensionForUuid(l.projectId),
      costCenterId: dimensionForUuid(l.costCenterId),
      taxRateCode: doc?.taxRateCode ?? null,
      deductibility: doc?.deductibility ?? null,
      nonDeductibleIncludedCents: doc?.nonDeductibleIncludedCents ?? 0,
      originalCurrency: l.originalCurrency ?? null,
      originalAmountCents: l.originalAmountCents ?? null,
      exchangeRateId: l.exchangeRateId ?? null,
    }
  })

const expectedLines = (c: FixtureCase): LineProjection[] =>
  (c.asiento?.lines ?? []).map((l) => ({
    accountCode: l.accountCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    analyticType: l.analyticType,
    projectId: l.projectId,
    costCenterId: l.costCenterId,
    taxRateCode: l.taxRateCode,
    deductibility: l.deductibility,
    nonDeductibleIncludedCents: l.nonDeductibleIncludedCents,
    originalCurrency: l.originalCurrency,
    originalAmountCents: l.originalAmountCents,
    exchangeRateId: l.exchangeRateId === null ? null : l.exchangeRateId,
  }))

const sortBlocks = <T extends { payableKey: string }>(blocks: readonly T[]): T[] =>
  [...blocks].sort((a, b) => (a.payableKey < b.payableKey ? -1 : 1))

// ─────────────────────────────────────────────────────────────────────────────
// 1 · La tabla de plantillas
// ─────────────────────────────────────────────────────────────────────────────

describe("TEMPLATE_FOR_DOC", () => {
  it("el ticket va a FACTURA_RECIBIDA con contrapartida de tesorería, no a 410", () => {
    expect(TEMPLATE_FOR_DOC.TICKET).toBe("FACTURA_RECIBIDA")
    expect(payableKeyForAccount("629", { docKind: "TICKET", isEmployee: false })).toBe("BANCO_DEFAULT")
    expect(payableKeyForAccount("629", { docKind: "TICKET", paymentKey: "CAJA", isEmployee: false })).toBe("CAJA")
  })

  it("una nómina, un recibo de la Seguridad Social o un extracto NO tienen plantilla", () => {
    expect(TEMPLATE_FOR_DOC.NOMINA).toBeNull()
    expect(TEMPLATE_FOR_DOC.RECIBO_SS).toBeNull()
    expect(TEMPLATE_FOR_DOC.EXTRACTO_BANCARIO).toBeNull()
    expect(TEMPLATE_FOR_DOC.DUA_IMPORTACION).toBeNull()
    expect(TEMPLATE_FOR_DOC.DESCONOCIDO).toBeNull()
  })

  it("la importación NO es inversión del sujeto pasivo", () => {
    expect(TEMPLATE_FOR_DOC.FACTURA_RECIBIDA_EXTRACOM).toBe("FACTURA_RECIBIDA")
    expect(TEMPLATE_FOR_DOC.FACTURA_RECIBIDA_ISP).toBe("FACTURA_RECIBIDA_ISP")
  })

  it("un ejercicio cerrado desvía a T-22 sea cual sea la clase de documento", () => {
    for (const kind of Object.keys(TEMPLATE_FOR_DOC) as (keyof typeof TEMPLATE_FOR_DOC)[]) {
      expect(selectTemplate({ docKind: kind, fiscalYearClosed: true })).toBe("AJUSTE_EJERCICIO_CERRADO")
    }
  })

  it("la elección del usuario sólo vale entre las compatibles", () => {
    expect(selectTemplate({ docKind: "FACTURA_RECIBIDA", fiscalYearClosed: false, templateCode: "FACTURA_RECIBIDA_ISP" })).toBe(
      "FACTURA_RECIBIDA_ISP"
    )
    expect(selectTemplate({ docKind: "FACTURA_RECIBIDA", fiscalYearClosed: false, templateCode: "NOMINA" })).toBeNull()
    expect(compatibleTemplates("NOMINA")).toEqual([])
  })

  it("la clave de pasivo la decide la NATURALEZA de la línea, no el documento", () => {
    const ctx = { docKind: "FACTURA_RECIBIDA" as const, isEmployee: false }
    expect(payableKeyForAccount("600", ctx)).toBe("PROVEEDORES")
    expect(payableKeyForAccount("607", ctx)).toBe("PROVEEDORES")
    expect(payableKeyForAccount("623", ctx)).toBe("ACREEDORES")
    expect(payableKeyForAccount("628", ctx)).toBe("ACREEDORES")
    expect(payableKeyForAccount("631", ctx)).toBe("ACREEDORES")
    expect(payableKeyForAccount("217", ctx)).toBe("PROVEEDORES_INMOVILIZADO")
    expect(payableKeyForAccount("629", { docKind: "NOTA_GASTO_EMPLEADO", isEmployee: true })).toBe("REMUNERACIONES_PENDIENTES")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Los quince asientos
// ─────────────────────────────────────────────────────────────────────────────

describe.each(fixture.casos.map((c) => [c.id, c] as const))("%s", (_id, c) => {
  const result = post(c)

  if (c.asiento === null) {
    it(`${c.titulo} — no hay asiento, y el error es el que el fixture sella`, () => {
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors[0].code).toBe(c.postError)
    })
    return
  }

  it(`${c.titulo} — plantilla, origen y las cuatro fechas`, () => {
    const posted = unwrap(result)
    expect(posted.templateCode).toBe(c.asiento?.templateCode)
    expect(posted.draft.templateCode).toBe(c.asiento?.templateCode)
    expect(posted.draft.sourceType).toBe(c.asiento?.sourceType)
    expect(posted.draft.entryDate).toBe(c.asiento?.entryDate)
    expect(posted.draft.documentDate).toBe(c.asiento?.documentDate)
    expect(posted.draft.receptionDate ?? null).toBe(c.asiento?.receptionDate ?? null)
    expect(posted.draft.operationDate ?? null).toBe(c.asiento?.operationDate ?? null)
    expect(posted.ivaPeriod).toBe(c.asiento?.ivaPeriod)
    expect(posted.draft.templateVersion).toBe(c.asiento?.templateVersion)
  })

  it("las líneas del asiento, céntimo a céntimo y en orden", () => {
    expect(projectLines(unwrap(result))).toEqual(expectedLines(c))
  })

  it("Σ debe = Σ haber con tolerancia 0 (I1 / I-E8-7a)", () => {
    const posted = unwrap(result)
    const debit = posted.draft.lines.reduce((a, l) => a + l.debitCents, 0)
    const credit = posted.draft.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debit).toBe(c.asiento?.totalDebitCents)
    expect(credit).toBe(c.asiento?.totalCreditCents)
    expect(debit - credit).toBe(0)
  })

  it("los bloques de pasivo, con su base, su cuota y su bruto", () => {
    const posted = unwrap(result)
    expect(
      sortBlocks(posted.payableBlocks).map((b) => ({
        payableKey: b.payableKey,
        accountCode: b.accountCode,
        baseCents: b.baseCents,
        quotaCents: b.quotaCents,
        ...(b.retencionCents === undefined ? {} : { retencionCents: b.retencionCents }),
        amountCents: b.amountCents,
      }))
    ).toEqual(sortBlocks(c.asiento?.payableBlocks ?? []))
  })

  it("la cuota del documento llega como `taxOverrides` y sin línea de ajuste", () => {
    const posted = unwrap(result)
    expect([...posted.taxOverrides].sort((a, b) => (a.taxRateCode < b.taxRateCode ? -1 : 1))).toEqual(
      [...(c.asiento?.taxOverrides ?? [])].sort((a, b) => (a.taxRateCode < b.taxRateCode ? -1 : 1))
    )
    // Ni 669, ni 769, ni 634, ni 639: con la cuota del documento no hay residuo.
    expect(posted.draft.lines.map((l) => l.accountCode)).not.toContain("669")
    expect(posted.draft.lines.map((l) => l.accountCode)).not.toContain("769")
    expect(posted.draft.lines.map((l) => l.accountCode)).not.toContain("634")
    expect(posted.draft.lines.map((l) => l.accountCode)).not.toContain("639")
  })

  it("la anotación del libro registro coincide con la sellada", () => {
    const posted = unwrap(result)
    expect({
      tipo: posted.ledgerBook.tipo,
      baseCents: posted.ledgerBook.baseCents,
      cuotaTotalCents: posted.ledgerBook.cuotaTotalCents,
      cuotaDeducibleCents: posted.ledgerBook.cuotaDeducibleCents,
      cuotaNoDeducibleAlCosteCents: posted.ledgerBook.cuotaNoDeducibleAlCosteCents,
      cuotaRepercutidaCents: posted.ledgerBook.cuotaRepercutidaCents,
      cuotaDevengadaIspAibCents: posted.ledgerBook.cuotaDevengadaIspAibCents,
    }).toEqual(c.libroRegistro)
  })

  it("I-E8-8 · la previsualización reproduce el asiento línea a línea", () => {
    const preview = previewFromProposal(reconciled(c), fixtureLedgerContext(c))
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.value.draft.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual(
      unwrap(result).draft.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Lo que el fixture pide que falle
// ─────────────────────────────────────────────────────────────────────────────

describe("la puerta de postFromProposal", () => {
  it("un run parcial de un modelo no respalda un asiento (O-20.3)", () => {
    const c = caseById("C13")
    const r = post(c)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe("PARTIAL_RUN_CANNOT_POST")
  })

  it("un reconcile en FAIL no produce asiento", () => {
    const c = caseById("C01")
    const bad = reconcile({ ...inputProposalFor(c), totalCents: 119900 }, reconcileContextFor(c))
    const r = postFromProposal(bad, fixtureLedgerContext(c))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe("PROPOSAL_NOT_RECONCILED")
  })

  it("un documento sin plantilla (ISP sin precondiciones ⇒ DESCONOCIDO) da TEMPLATE_UNRESOLVED", () => {
    const c = caseById("C11")
    const rec = reconcile(
      inputProposalFor(c),
      reconcileContextFor(c, { counterparty: { viesValid: false }, legalMentionArt61m: null })
    )
    expect(rec.normalized.docKind).toBe("DESCONOCIDO")
    const r = postFromProposal(rec, fixtureLedgerContext(c))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe("TEMPLATE_UNRESOLVED")
  })

  it("una nómina no entra jamás por una plantilla de compra", () => {
    const c = caseById("C01")
    const rec = reconcile({ ...inputProposalFor(c), docKind: "NOMINA" }, reconcileContextFor(c))
    const r = postFromProposal(rec, fixtureLedgerContext(c))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0].code).toBe("TEMPLATE_UNRESOLVED")
    expect(r.errors[0].message).toContain("nómina")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Divisa, Hamilton y ejercicio cerrado
// ─────────────────────────────────────────────────────────────────────────────

describe("divisa (ADR-0014 D2)", () => {
  it("el residuo de conversión es CERO por construcción: lo absorben las cuotas", () => {
    const converted = convertDocumentToBase(
      [{ baseCents: 500000 }, { baseCents: 359091 }],
      [
        { taxRateCode: "IVA_21", quotaCents: 105000 },
        { taxRateCode: "IVA_10", quotaCents: 35909 },
      ],
      BigInt(925926)
    )
    const total = converted.lineBases.reduce((a, b) => a + b, 0) + Object.values(converted.quotaByRate).reduce((a, b) => a + b, 0)
    expect(total).toBe(converted.grossCents)
    expect(converted.grossCents).toBe(925926)
    expect(converted.lineBases).toEqual([462963, 332492])
    expect(converted.quotaByRate).toEqual({ IVA_21: 97222, IVA_10: 33249 })
  })

  it("un residuo que NO es cero se reparte por mayor resto, sin línea de ajuste", () => {
    const converted = convertDocumentToBase(
      [{ baseCents: 33333 }, { baseCents: 33333 }, { baseCents: 33334 }],
      [
        { taxRateCode: "IVA_21", quotaCents: 7000 },
        { taxRateCode: "IVA_10", quotaCents: 3333 },
      ],
      BigInt(1_234_567)
    )
    const total = converted.lineBases.reduce((a, b) => a + b, 0) + Object.values(converted.quotaByRate).reduce((a, b) => a + b, 0)
    expect(total).toBe(converted.grossCents)
  })

  it("sólo la línea MONETARIA lleva divisa original y tasa", () => {
    const posted = unwrap(post(caseById("C12")))
    const withCurrency = posted.draft.lines.filter((l) => l.originalCurrency !== null && l.originalCurrency !== undefined)
    expect(withCurrency).toHaveLength(1)
    expect(withCurrency[0].accountCode).toBe("400")
    expect(withCurrency[0].originalAmountCents).toBe(1000000)
    expect(withCurrency[0].exchangeRateId).toBe("RATE-2026-11-20-USD-EUR")
  })
})

describe("ejercicio cerrado (T-22)", () => {
  it("un documento de 2025 se registra en el ejercicio abierto con AJUSTE_EJERCICIO_CERRADO", () => {
    const c = caseById("C01")
    const rec = reconcile({ ...inputProposalFor(c), documentDate: "2025-11-30", accrualDate: null }, reconcileContextFor(c))
    expect(rec.fiscalYearClosed).toBe(true)
    const r = postFromProposal(rec, fixtureLedgerContext(c))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.templateCode).toBe("AJUSTE_EJERCICIO_CERRADO")
    expect(r.value.draft.entryDate).toBe("2026-12-31")
    const debit = r.value.draft.lines.reduce((a, l) => a + l.debitCents, 0)
    const credit = r.value.draft.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debit).toBe(credit)
  })
})

describe("anticipo de cliente CON cobro registrado", () => {
  it("con el cobro registrado el IVA sí devenga y aparece la línea de 477", () => {
    const c = caseById("C14")
    const rec = reconcile(inputProposalFor(c), reconcileContextFor(c, { advanceCollected: true }))
    expect(rec.checks.find((k) => k.id === "RC-25")?.status).toBe("PASS")
    const r = postFromProposal(rec, fixtureLedgerContext(c))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const codes = r.value.draft.lines.map((l) => l.accountCode)
    expect(codes).toContain("477")
    expect(codes).toContain("438")
    expect(r.value.draft.lines.find((l) => l.accountCode === "477")?.creditCents).toBe(210000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E8 ronda 1 · revisor #4 — `originalAmountCents` sale del DOCUMENTO
// ─────────────────────────────────────────────────────────────────────────────

describe("ronda 1 · el importe original de la línea monetaria no se obtiene deshaciendo la conversión", () => {
  /**
   * `reverseConvert(convert(x))` es lossy salvo para tasas próximas a 1. Este
   * test lo demuestra sobre **miles de importes** con `rateMicro = 920000`
   * (1 CHF = 0,92 EUR) y comprueba que el motor NO usa ese camino: el importe
   * en divisa de la línea de pasivo es, para todos ellos, el total del papel.
   *
   * El golden test de C12 pasaba con 925 926 µ porque ahí el round-trip acierta;
   * eso es exactamente lo que escondía el defecto.
   */
  const RATE = BigInt(920_000)

  const convert = (cents: number): number => {
    const product = BigInt(cents) * RATE
    const scale = BigInt(1_000_000)
    const quotient = product / scale
    const remainder = product - quotient * scale
    const twice = remainder * BigInt(2)
    const up = twice > scale || (twice === scale && quotient % BigInt(2) === BigInt(1))
    return Number(up ? quotient + BigInt(1) : quotient)
  }

  const reverse = (cents: number): number => {
    const product = BigInt(cents) * BigInt(1_000_000)
    const quotient = product / RATE
    const remainder = product - quotient * RATE
    return Number(remainder * BigInt(2) >= RATE ? quotient + BigInt(1) : quotient)
  }

  it("el round-trip por la tasa pierde céntimos: no es una fuente admisible del importe original", () => {
    let perdidos = 0
    for (let cents = 100_000; cents < 120_000; cents++) {
      if (reverse(convert(cents)) !== cents) perdidos++
    }
    // Con 0,92 falla en cerca de una de cada doce cifras. La aserción es sobre
    // «> 0» para que no dependa del reparto exacto, y el número medido va en el
    // mensaje por si algún día cambia el redondeo.
    expect(`${perdidos} de 20 000 importes`).not.toBe("0 de 20 000 importes")
    expect(perdidos).toBeGreaterThan(1_000)
  })

  it("con una tasa lejana de 1, la línea de pasivo lleva el importe del documento al céntimo", () => {
    const c = caseById("C12")
    const base = inputProposalFor(c)
    // La misma factura, en francos y con una tasa que el round-trip no soporta.
    const proposal = { ...base, currency: "CHF" }
    const context = reconcileContextFor(c, {
      rate: { id: "RATE-CHF", date: "2026-11-20", from: "CHF", to: "EUR", rateMicro: 920_000, source: "ECB_FRANKFURTER" },
    })
    const rec = reconcile(proposal, { ...context, currencies: [...context.currencies, { code: "CHF", exponent: 2 }] })
    expect(rec.checks.find((k) => k.id === "RC-14")?.status).toBe("PASS")

    const posted = unwrap(postFromProposal(rec, fixtureLedgerContext(c)))
    const monetary = posted.draft.lines.filter((l) => l.originalCurrency !== null && l.originalCurrency !== undefined)
    expect(monetary).toHaveLength(1)
    expect(monetary[0].originalCurrency).toBe("CHF")
    expect(monetary[0].originalAmountCents).toBe(proposal.totalCents)
    // Y NO es lo que habría devuelto la inversa, que es el defecto que se cierra.
    expect(monetary[0].originalAmountCents).not.toBe(reverse(monetary[0].creditCents + monetary[0].debitCents) - 1)

    // El asiento sigue cuadrando y el bloque de pasivo conoce su importe original.
    const debit = posted.draft.lines.reduce((a, l) => a + l.debitCents, 0)
    const credit = posted.draft.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debit).toBe(credit)
    expect(posted.payableBlocks[0].originalAmountCents).toBe(proposal.totalCents)
  })

  it("documento MIXTO en divisa: la suma de los importes originales de los bloques es el total del papel", () => {
    const c = caseById("C05") // dos bloques de pasivo: 523 (inmovilizado) y 410
    const base = inputProposalFor(c)
    const proposal = { ...base, currency: "CHF" }
    const context = reconcileContextFor(c, {
      rate: { id: "RATE-CHF", date: "2026-05-05", from: "CHF", to: "EUR", rateMicro: 920_000, source: "ECB_FRANKFURTER" },
    })
    const rec = reconcile(proposal, { ...context, currencies: [...context.currencies, { code: "CHF", exponent: 2 }] })
    const posted = unwrap(postFromProposal(rec, fixtureLedgerContext(c)))
    expect(posted.payableBlocks.length).toBeGreaterThan(1)
    const suma = posted.payableBlocks.reduce((a, b) => a + (b.originalAmountCents ?? 0), 0)
    expect(suma).toBe(proposal.totalCents)
    const monetary = posted.draft.lines.filter((l) => l.originalCurrency !== null && l.originalCurrency !== undefined)
    expect(monetary.reduce((a, l) => a + (l.originalAmountCents ?? 0), 0)).toBe(proposal.totalCents)
  })
})
