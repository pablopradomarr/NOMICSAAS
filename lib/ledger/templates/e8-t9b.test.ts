/**
 * E8 · T9b — los tres cambios acotados del motor de E3 (ADR-0014 D3, D6, D8).
 *
 * 1. `taxOverrides`: la cuota que se contabiliza es **la del documento**, con
 *    desviación máxima de un céntimo POR TIPO y techo duro (D3, O-2).
 * 2. `payableBlocks` y `payableKey` ampliado: el pasivo de un documento mixto
 *    se reparte por naturaleza —400 / 410 / 523— y la retención y el anticipo
 *    se distribuyen por mayor resto (Hamilton) con desempate por código
 *    (D6, O-3), más tesorería y 465 para ticket y nota de gasto (D9, O-13).
 * 3. `selectRate` por fecha de **devengo** (art. 90.Dos LIVA, O-14), aplicado a
 *    la vez a las plantillas y a C-10.
 *
 * Y el requisito duro de la tarea: **los fixtures de E3–E6 no cambian ni un
 * byte** y el motor sigue llegando al mismo `ledgerHash` y a las mismas sumas.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { ledgerHash } from "@/lib/ledger/hash"
import { buildDiario } from "@/lib/ledger/reports/diario"
import { buildSumasSaldos } from "@/lib/ledger/reports/sumas-saldos"
import { selectRateForAccrual, taxAccrualDate, TOLERANCIA_CUOTA_IVA_CENTS } from "@/lib/ledger/tax"
import { buildFromTemplate } from "@/lib/ledger/templates"
import { lineTaxes } from "@/lib/ledger/templates/documento"
import type { AccountKey, EntryDraft, LedgerContext, Result, TaxRateRow } from "@/lib/ledger/types"
import { loadFixture, toReportAccounts, toReportEntries, toReportLines } from "@/tests/support/fixtures"
import { codeFor, testContext } from "@/tests/support/ledger-context"

const PROVEEDORES = codeFor("PROVEEDORES")
const ACREEDORES = codeFor("ACREEDORES")
const CAJA = codeFor("CAJA")
const REMUNERACIONES = codeFor("REMUNERACIONES_PENDIENTES")
const IVA_SOP = codeFor("IVA_SOPORTADO")
const IVA_REP = codeFor("IVA_REPERCUTIDO")
const IRPF_PROF = codeFor("IRPF_PROFESIONALES_A_PAGAR")
const ANTICIPOS_PROV = codeFor("ANTICIPOS_PROVEEDORES")
const VENTAS = codeFor("VENTAS_DEFAULT")
const CLIENTES = codeFor("CLIENTES")
const INMOVILIZADO_PROVEEDOR = "523"

const ctx = testContext()

/**
 * El plan de la organización decide qué cuenta es cada clave: el motor no
 * conoce el 523, lo pide. El mapa por defecto de E8 lo siembra (ADR-0014 D6),
 * y aquí se aporta explícitamente para que el test mida el reparto y no la
 * siembra.
 */
const ctxConInmovilizado: LedgerContext = {
  ...ctx,
  map: (key: AccountKey) => (key === "PROVEEDORES_INMOVILIZADO" ? INMOVILIZADO_PROVEEDOR : ctx.map(key)),
}

const rows = (r: Result<EntryDraft>): [string, number, number][] => {
  if (!r.ok) throw new Error(`La plantilla falló: ${JSON.stringify(r.errors, null, 2)}`)
  return r.value.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])
}
const errorsOf = (r: Result<EntryDraft>): { code: string; check?: string }[] =>
  r.ok ? [] : r.errors.map((e) => ({ code: e.code, check: e.check }))

// ─────────────────────────────────────────────────────────────────────────────
// 1 · ADR-0014 D3 — la cuota contabilizada es la del documento
// ─────────────────────────────────────────────────────────────────────────────

describe("D3 · cuota del documento (`taxOverrides`)", () => {
  const factura = (quotaCents: number | null, totalCents: number) =>
    buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "P-2026/44",
        documentDate: "2026-03-10",
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21", expenseAccountCode: "600" }],
        ...(quotaCents === null ? {} : { taxOverrides: [{ taxRateCode: "IVA_21", quotaCents }] }),
        totalCents,
      },
      ctx
    )

  it("la tolerancia es una constante del motor de UN céntimo, no una política", () => {
    expect(TOLERANCIA_CUOTA_IVA_CENTS).toBe(1)
  })

  it("sin override el comportamiento es el de E3: la cuota recalculada (21.000)", () => {
    expect(rows(factura(null, 121000))).toEqual([
      ["600", 100000, 0],
      [IVA_SOP, 21000, 0],
      [PROVEEDORES, 0, 121000],
    ])
  })

  it("un céntimo ARRIBA: se contabiliza 21.001, que es lo que dice la factura", () => {
    expect(rows(factura(21001, 121001))).toEqual([
      ["600", 100000, 0],
      [IVA_SOP, 21001, 0],
      [PROVEEDORES, 0, 121001],
    ])
  })

  it("un céntimo ABAJO: se contabiliza 20.999", () => {
    expect(rows(factura(20999, 120999))).toEqual([
      ["600", 100000, 0],
      [IVA_SOP, 20999, 0],
      [PROVEEDORES, 0, 120999],
    ])
  })

  it("dos céntimos: no hay asiento (techo duro, tipo mal leído o factura defectuosa)", () => {
    const r = factura(21002, 121002)
    expect(r.ok).toBe(false)
    expect(errorsOf(r)).toContainEqual({ code: "TAX_BASE_MISMATCH", check: "D3" })
  })

  it("dos céntimos POR DEBAJO tampoco pasan: la desviación se mide en valor absoluto", () => {
    expect(errorsOf(factura(20998, 120998))).toContainEqual({ code: "TAX_BASE_MISMATCH", check: "D3" })
  })

  it("la identidad interna del documento tiene tolerancia 0: el total lleva la cuota del documento", () => {
    // Cuota del documento 21.001 con un total de 121.000: el documento no cuadra
    // consigo mismo (art. 6 RD 1619/2012) y se pide factura corregida.
    const r = factura(21001, 121000)
    expect(r.ok).toBe(false)
    expect(errorsOf(r)).toContainEqual({ code: "DOCUMENT_TOTAL_MISMATCH", check: "C-5" })
  })

  it("la desviación se mide POR TIPO: un +1 y un −1 no se compensan entre sí", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "P-2026/45",
        documentDate: "2026-03-10",
        payableKey: "PROVEEDORES",
        lines: [
          { baseCents: 100000, taxRateCode: "IVA_21", expenseAccountCode: "600" },
          { baseCents: 100000, taxRateCode: "IVA_10", expenseAccountCode: "600" },
        ],
        taxOverrides: [
          { taxRateCode: "IVA_21", quotaCents: 21002 },
          { taxRateCode: "IVA_10", quotaCents: 9998 },
        ],
        totalCents: 231000,
      },
      ctx
    )
    // Σ cuotas = 31.000 = Σ recalculadas, así que C-7 y C-5 pasarían; D3 no.
    expect(errorsOf(r).filter((e) => e.check === "D3")).toHaveLength(2)
  })

  it("la factura EMITIDA también contabiliza la cuota del documento", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        documentNumber: "2026/007",
        documentDate: "2026-03-10",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21" }],
        taxOverrides: [{ taxRateCode: "IVA_21", quotaCents: 20999 }],
        totalCents: 120999,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 120999, 0],
      [VENTAS, 0, 100000],
      [IVA_REP, 0, 20999],
    ])
  })

  it("`lineTaxes` reparte la cuota del documento entre las líneas del tipo", () => {
    const lines = [
      { baseCents: 60000, taxRateCode: "IVA_21" },
      { baseCents: 40000, taxRateCode: "IVA_21" },
    ]
    const withDoc = lineTaxes(lines, ctx, { documentDate: "2026-03-10" }, "PURCHASE", [
      { taxRateCode: "IVA_21", quotaCents: 21001 },
    ])
    expect(withDoc.errors).toEqual([])
    expect(withDoc.perLine).toEqual([12600, 8401])
    expect(withDoc.totalCents).toBe(21001)
    // Y sin documento, la recalculada.
    expect(lineTaxes(lines, ctx, { documentDate: "2026-03-10" }, "PURCHASE").perLine).toEqual([12600, 8400])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · ADR-0014 D6 / D9 — bloques de pasivo y `payableKey` ampliado
// ─────────────────────────────────────────────────────────────────────────────

describe("D6 · reparto del pasivo por bloques", () => {
  /**
   * Documento mixto: mercadería (600 → 400), un servicio (623 → 410) y un
   * equipo (216 → 523), con retención del 15 % que reparte un céntimo huérfano.
   */
  const mixta = (extra: Record<string, unknown> = {}) =>
    buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "MIX-2026/1",
        documentDate: "2026-04-02",
        payableKey: "PROVEEDORES",
        lines: [
          { baseCents: 100000, taxRateCode: "IVA_21", expenseAccountCode: "600" },
          { baseCents: 50000, taxRateCode: "IVA_21", expenseAccountCode: "623" },
          { baseCents: 33333, taxRateCode: "IVA_21", expenseAccountCode: "216" },
        ],
        payableBlocks: [
          { payableKey: "PROVEEDORES", amountCents: 121000 },
          { payableKey: "ACREEDORES", amountCents: 60500 },
          { payableKey: "PROVEEDORES_INMOVILIZADO", amountCents: 40333 },
        ],
        withholdingRateCode: "IRPF_PROF_15",
        totalCents: 194333,
        ...extra,
      },
      ctxConInmovilizado
    )

  it("una línea de pasivo por bloque, con su base y su cuota, y el céntimo huérfano al mayor resto", () => {
    // Retención 27.500 repartida sobre 121.000 / 60.500 / 40.333 (Σ 221.833):
    // cocientes 15.000 / 7.500 / 4.999 y el céntimo sobrante al tercero.
    expect(rows(mixta())).toEqual([
      ["600", 100000, 0],
      ["623", 50000, 0],
      ["216", 33333, 0],
      [IVA_SOP, 38500, 0],
      [PROVEEDORES, 0, 106000],
      [ACREEDORES, 0, 53000],
      [INMOVILIZADO_PROVEEDOR, 0, 35333],
      [IRPF_PROF, 0, 27500],
    ])
  })

  it("Σ líneas de pasivo = pasivo del documento, con tolerancia 0", () => {
    const payable = rows(mixta())
      .filter(([code]) => [PROVEEDORES, ACREEDORES, INMOVILIZADO_PROVEEDOR].includes(code))
      .reduce((a, [, , credit]) => a + credit, 0)
    expect(payable).toBe(183333 + 38500 - 27500)
  })

  it("el inmovilizado va a 523 SIEMPRE en el alta: la separación 523/173 es un asiento de cierre (E9)", () => {
    expect(rows(mixta()).some(([code]) => code === "173")).toBe(false)
    expect(rows(mixta()).some(([code]) => code === INMOVILIZADO_PROVEEDOR)).toBe(true)
  })

  it("empate de restos: el céntimo va al bloque de MENOR código de cuenta", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "MIX-2026/2",
        documentDate: "2026-04-02",
        payableKey: "PROVEEDORES",
        lines: [
          { baseCents: 50000, taxRateCode: "IVA_21", expenseAccountCode: "600" },
          { baseCents: 50000, taxRateCode: "IVA_21", expenseAccountCode: "623" },
        ],
        payableBlocks: [
          { payableKey: "ACREEDORES", amountCents: 60500 },
          { payableKey: "PROVEEDORES", amountCents: 60500 },
        ],
        appliedAdvanceCents: 1,
        totalCents: 121000,
      },
      ctx
    )
    // Dos bloques idénticos y un céntimo que repartir: se lo lleva el 4000, no
    // el que llegue primero en el array.
    expect(rows(r)).toEqual([
      ["600", 50000, 0],
      ["623", 50000, 0],
      [IVA_SOP, 21000, 0],
      [ANTICIPOS_PROV, 0, 1],
      [ACREEDORES, 0, 60500],
      [PROVEEDORES, 0, 60499],
    ])
  })

  it("bloques que no suman base + cuotas: no hay asiento", () => {
    const r = mixta({ payableBlocks: [{ payableKey: "PROVEEDORES", amountCents: 221832 }] })
    expect(r.ok).toBe(false)
    expect(errorsOf(r)).toContainEqual({ code: "DOCUMENT_TOTAL_MISMATCH", check: "D6" })
  })

  it("varios bloques y calendario de vencimientos a la vez: se rechaza en vez de inventar el reparto", () => {
    const r = mixta({
      dueSchedule: [
        { dueDate: "2026-05-02", amountCents: 100000 },
        { dueDate: "2026-06-02", amountCents: 94333 },
      ],
    })
    expect(errorsOf(r).map((e) => e.code)).toContain("TEMPLATE_INPUT")
  })

  it("una clave de pasivo sin mapear no se inventa: MAP_KEY_UNMAPPED", () => {
    // El motor no conoce el 523: lo pide al mapa de la organización. Sin él
    // —una organización cuyo plan no tenga 523 postable— no hay asiento.
    const sinInmovilizado: LedgerContext = {
      ...ctx,
      map: (key: AccountKey) => (key === "PROVEEDORES_INMOVILIZADO" ? null : ctx.map(key)),
    }
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "MIX-2026/3",
        documentDate: "2026-04-02",
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 33333, taxRateCode: "IVA_21", expenseAccountCode: "216" }],
        payableBlocks: [{ payableKey: "PROVEEDORES_INMOVILIZADO", amountCents: 40333 }],
        totalCents: 40333,
      },
      sinInmovilizado
    )
    expect(errorsOf(r).map((e) => e.code)).toContain("MAP_KEY_UNMAPPED")
  })

  it("523 es una cuenta postable del plan PYMES: el bloque de inmovilizado no necesita subcuenta", () => {
    const account = ctx.plan.byCode.get(INMOVILIZADO_PROVEEDOR)
    expect([account?.isPostable, account?.isActive]).toEqual([true, true])
  })

  it("D9 · ticket: contrapartida de tesorería y cuota NO deducible como mayor coste", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "TICKET-77",
        documentDate: "2026-04-02",
        payableKey: "CAJA",
        lines: [{ baseCents: 10000, taxRateCode: "IVA_21", expenseAccountCode: "629", deductibility: "NONE" }],
        totalCents: 12100,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["629", 12100, 0],
      [CAJA, 0, 12100],
    ])
  })

  it("O-13 · nota de gasto de un empleado: 465, nunca 400 ni 410", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "NG-2026/9",
        documentDate: "2026-04-02",
        payableKey: "REMUNERACIONES_PENDIENTES",
        lines: [{ baseCents: 10000, taxRateCode: "IVA_21", expenseAccountCode: "629" }],
        totalCents: 12100,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["629", 10000, 0],
      [IVA_SOP, 2100, 0],
      [REMUNERACIONES, 0, 12100],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · ADR-0014 D8 / O-14 — el tipo, por fecha de devengo (art. 90.Dos LIVA)
// ─────────────────────────────────────────────────────────────────────────────

describe("O-14 · `selectRate` por fecha de devengo", () => {
  /** Subida del tipo general a mitad de 2026: dos filas con el MISMO código. */
  const rateHasta: TaxRateRow = {
    ...(ctx.rates.find((r) => r.code === "IVA_21") as TaxRateRow),
    id: "rate-IVA_21-v1",
    validTo: new Date("2026-06-30T00:00:00.000Z"),
  }
  const rateDesde: TaxRateRow = {
    ...rateHasta,
    id: "rate-IVA_21-v2",
    rateBps: 2300,
    validFrom: new Date("2026-07-01T00:00:00.000Z"),
    validTo: null,
  }
  const ctxCambio: LedgerContext = {
    ...ctx,
    rates: [...ctx.rates.filter((r) => r.code !== "IVA_21"), rateHasta, rateDesde],
  }

  it("prioridad de fechas: operación → devengo contable → expedición", () => {
    expect(taxAccrualDate({ documentDate: "2026-06-25" })).toBe("2026-06-25")
    expect(taxAccrualDate({ accrualDate: "2026-07-05", documentDate: "2026-06-25" })).toBe("2026-07-05")
    expect(
      taxAccrualDate({ operationDate: "2026-08-01", accrualDate: "2026-07-05", documentDate: "2026-06-25" })
    ).toBe("2026-08-01")
  })

  it("`selectRateForAccrual` elige el tipo vigente al DEVENGO, no al expedir (RC-06)", () => {
    const porExpedicion = selectRateForAccrual(ctxCambio, "IVA_21", { documentDate: "2026-06-25" }, "PURCHASE")
    const porDevengo = selectRateForAccrual(
      ctxCambio,
      "IVA_21",
      { operationDate: "2026-07-05", documentDate: "2026-06-25" },
      "PURCHASE"
    )
    expect("rate" in porExpedicion && porExpedicion.rate.rateBps).toBe(2100)
    expect("rate" in porDevengo && porDevengo.rate.rateBps).toBe(2300)
  })

  it("la plantilla aplica el tipo del devengo, y C-10 lo valida con esa misma fecha", () => {
    const conDevengo = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "P-2026/90",
        documentDate: "2026-06-25",
        operationDate: "2026-07-05",
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21", expenseAccountCode: "600" }],
        totalCents: 123000,
      },
      ctxCambio
    )
    expect(rows(conDevengo)).toEqual([
      ["600", 100000, 0],
      [IVA_SOP, 23000, 0],
      [PROVEEDORES, 0, 123000],
    ])
  })

  it("sin fecha de operación, el criterio es el de siempre: el tipo de la expedición", () => {
    const sinDevengo = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        supplierDocumentNumber: "P-2026/91",
        documentDate: "2026-06-25",
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21", expenseAccountCode: "600" }],
        totalCents: 121000,
      },
      ctxCambio
    )
    expect(rows(sinDevengo)).toEqual([
      ["600", 100000, 0],
      [IVA_SOP, 21000, 0],
      [PROVEEDORES, 0, 121000],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · R10 del diseño — los fixtures de E3–E6 no cambian NI UN BYTE
// ─────────────────────────────────────────────────────────────────────────────

describe("R10 · los fixtures de E3–E6 siguen byte a byte", () => {
  /**
   * Sha256 de los ficheros tal cual están en disco. Si una tarea del motor
   * «arregla» un fixture para que sus cifras encajen, este test lo dice antes
   * que ningún informe: los fixtures NO se editan, se regeneran con el script
   * de `docs/design/fixtures/`.
   */
  const SHA_FIXTURES: Record<string, string> = {
    "ejercicio-minimo": "eaed906797630986e96c1602c3ee02978d99c75d0a763d7e8a3a91cd69bb6fc0",
    "ejercicio-completo": "b114ee76ba81648349383bf525b5f1aacceed2c9fa3b37ad7c461c57462c740b",
  }

  /** Sello financiero del diario cargado por el motor (forma canónica v2). */
  const LEDGER_HASH: Record<string, string> = {
    "ejercicio-minimo": "a23576f7193ac0b29d6ad29d8cc78ff5cae102e9822b0e7dcd1a8a5afe22cccc",
    "ejercicio-completo": "cb9c874479ffc2e7e7acc4e9cc49e0cea6dc49090c360cdd327e07d98660769e",
  }

  const hashOfFile = (name: string): string =>
    createHash("sha256")
      .update(readFileSync(resolve(process.cwd(), "tests/fixtures", `${name}.json`)))
      .digest("hex")

  const hashOfLedger = (name: string): string => {
    const { posted } = loadFixture(name)
    return ledgerHash(
      posted.flatMap((e) =>
        e.lines.map((l) => ({
          entryDate: e.entryDate,
          entryNumber: e.entryNumber,
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          entryKind: e.kind,
        }))
      )
    )
  }

  it.each(["ejercicio-minimo", "ejercicio-completo"] as const)("%s: el fichero no se ha tocado", (name) => {
    expect(hashOfFile(name)).toBe(SHA_FIXTURES[name])
  })

  it.each(["ejercicio-minimo", "ejercicio-completo"] as const)(
    "%s: el motor llega al mismo `ledgerHash` y a las mismas sumas",
    (name) => {
      const loaded = loadFixture(name)
      const period = {
        organizationId: loaded.ctx.organizationId,
        from: "2000-01-01",
        to: "2099-12-31",
        baseCurrency: loaded.file.organization.baseCurrency,
      }
      const lines = toReportLines(loaded.posted)
      const diario = buildDiario(toReportEntries(loaded.posted), lines, toReportAccounts(loaded.plan), period)
      const sumasSaldos = buildSumasSaldos(lines, toReportAccounts(loaded.plan), period)

      expect(hashOfLedger(name)).toBe(LEDGER_HASH[name])
      expect(diario.totals.totalDebitCents).toBe(loaded.file.expected.totalDebitCents)
      expect(diario.totals.totalCreditCents).toBe(loaded.file.expected.totalCreditCents)
      expect(diario.entryCount).toBe(loaded.file.expected.entryCount)
      expect(sumasSaldos.balanceTotals.differenceCents).toBe(0)
    }
  )
})
