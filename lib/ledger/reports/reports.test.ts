/**
 * E3 · T7 — Los tres informes derivados del diario: libro diario, mayor y
 * sumas y saldos. Funciones puras `f(lines, accounts, period) → Report`, con
 * provenance por celda (contrato de la skill `fiabilidad`).
 */

import { describe, expect, it } from "vitest"

import { cellProvenance } from "@/lib/ledger/provenance"
import { buildDiario } from "@/lib/ledger/reports/diario"
import { accountBalances, buildMayor } from "@/lib/ledger/reports/mayor"
import { buildSumasSaldos } from "@/lib/ledger/reports/sumas-saldos"
import type { ProvenanceContext, ReportAccount, ReportEntry, ReportLine } from "@/lib/ledger/reports/types"

const PERIOD = { organizationId: "org-test", from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR" }

const accounts: ReportAccount[] = [
  { code: "4300", name: "Clientes (euros)" },
  { code: "572", name: "Bancos c/c" },
  { code: "705", name: "Prestaciones de servicios" },
  { code: "477", name: "Hacienda Pública, IVA repercutido" },
]

const entry = (over: Partial<ReportEntry>): ReportEntry => ({
  id: "e1",
  entryNumber: 1,
  entryDate: "2026-03-10",
  description: "Factura 2026/001",
  kind: "NORMAL",
  sourceType: "INVOICE_OUT",
  ...over,
})

const line = (over: Partial<ReportLine>): ReportLine => ({
  entryId: "e1",
  entryNumber: 1,
  entryDate: "2026-03-10",
  entryKind: "NORMAL",
  fiscalYearId: "fy-2026",
  lineNo: 1,
  accountCode: "4300",
  debitCents: 0,
  creditCents: 0,
  ...over,
})

/** Una factura y su cobro: el caso mínimo con dos asientos. */
const FACTURA: ReportLine[] = [
  line({ lineNo: 1, accountCode: "4300", debitCents: 121000 }),
  line({ lineNo: 2, accountCode: "705", creditCents: 100000 }),
  line({ lineNo: 3, accountCode: "477", creditCents: 21000 }),
]
const COBRO: ReportLine[] = [
  line({ entryId: "e2", entryNumber: 2, entryDate: "2026-04-15", lineNo: 1, accountCode: "572", debitCents: 121000 }),
  line({ entryId: "e2", entryNumber: 2, entryDate: "2026-04-15", lineNo: 2, accountCode: "4300", creditCents: 121000 }),
]
const ENTRIES = [entry({}), entry({ id: "e2", entryNumber: 2, entryDate: "2026-04-15", description: "Cobro" })]
const LINES = [...FACTURA, ...COBRO]

const provenanceCtx: ProvenanceContext = {
  runId: "run-1",
  ledgerHash: "a".repeat(64),
  gitSha: "abc1234",
  baseCurrency: "EUR",
  module: "lib/ledger/reports/sumas-saldos.ts",
}

describe("buildDiario", () => {
  it("caso vacío: sin líneas, totales a 0 y cuadre ✓", () => {
    const report = buildDiario([], [], accounts, PERIOD)
    expect(report.entryCount).toBe(0)
    expect(report.lineCount).toBe(0)
    expect(report.totals).toEqual({
      totalDebitCents: 0,
      totalCreditCents: 0,
      differenceCents: 0,
      balanced: true,
    })
  })

  it("un asiento: sus líneas, sus totales y el nombre de cada cuenta", () => {
    const report = buildDiario([entry({})], FACTURA, accounts, PERIOD)
    expect(report.entryCount).toBe(1)
    expect(report.entries[0].totalDebitCents).toBe(121000)
    expect(report.entries[0].balanced).toBe(true)
    expect(report.entries[0].lines[1].accountName).toBe("Prestaciones de servicios")
  })

  it("ordena por (entryDate, entryNumber): N-5 es presentación, no renumeración", () => {
    const retroactivo = entry({ id: "e3", entryNumber: 3, entryDate: "2026-01-05", description: "Retroactivo" })
    const retroLines = [
      line({ entryId: "e3", entryNumber: 3, entryDate: "2026-01-05", lineNo: 1, accountCode: "572", debitCents: 100 }),
      line({ entryId: "e3", entryNumber: 3, entryDate: "2026-01-05", lineNo: 2, accountCode: "705", creditCents: 100 }),
    ]
    const report = buildDiario([...ENTRIES, retroactivo], [...LINES, ...retroLines], accounts, PERIOD)
    expect(report.entries.map((e) => e.entryNumber)).toEqual([3, 1, 2])
  })

  it("un asiento descuadrado se marca, pero se muestra igual", () => {
    const report = buildDiario([entry({})], FACTURA.slice(0, 2), accounts, PERIOD)
    expect(report.entries[0].balanced).toBe(false)
    expect(report.totals.differenceCents).toBe(21000)
  })

  it("filtra por periodo con `entryDate`, la única fecha que manda", () => {
    const report = buildDiario(ENTRIES, LINES, accounts, { ...PERIOD, to: "2026-03-31" })
    expect(report.entryCount).toBe(1)
    expect(report.lineCount).toBe(3)
  })

  it("NO filtra por `voidedAt`: el anulado y su anulador salen los dos (I-E3-3)", () => {
    const anulado = entry({ voidedAt: "2026-05-01T00:00:00Z" })
    const report = buildDiario([anulado], FACTURA, accounts, PERIOD)
    expect(report.entryCount).toBe(1)
  })

  it("emite provenance de los totales cuando se le da el contexto", () => {
    const report = buildDiario(ENTRIES, LINES, accounts, PERIOD, provenanceCtx)
    expect(report.provenance?.totalDebit.valor).toBe(242000)
    expect(report.provenance?.totalDebit.confianza).toBe("calculado")
  })
})

describe("buildMayor", () => {
  it("caso vacío: sin cuentas", () => {
    const report = buildMayor([], accounts, PERIOD)
    expect(report.accounts).toEqual([])
    expect(report.closingBalanceSumCents).toBe(0)
  })

  it("saldo inicial + movimientos + saldo final por cuenta", () => {
    const report = buildMayor(LINES, accounts, PERIOD)
    const clientes = report.accounts.find((a) => a.accountCode === "4300")!
    expect(clientes.openingBalanceCents).toBe(0)
    expect(clientes.totalDebitCents).toBe(121000)
    expect(clientes.totalCreditCents).toBe(121000)
    expect(clientes.closingBalanceCents).toBe(0)
    expect(clientes.accountName).toBe("Clientes (euros)")
  })

  it("el saldo acumulado avanza línea a línea", () => {
    const report = buildMayor(LINES, accounts, PERIOD)
    const clientes = report.accounts.find((a) => a.accountCode === "4300")!
    expect(clientes.movements.map((m) => m.runningBalanceCents)).toEqual([121000, 0])
  })

  it("lo anterior a `from` va al saldo inicial, no a los movimientos", () => {
    const report = buildMayor(LINES, accounts, { ...PERIOD, from: "2026-04-01" })
    const clientes = report.accounts.find((a) => a.accountCode === "4300")!
    expect(clientes.openingBalanceCents).toBe(121000)
    expect(clientes.movements).toHaveLength(1)
    expect(clientes.closingBalanceCents).toBe(0)
  })

  it("Σ de los saldos finales es 0 en un diario cuadrado", () => {
    expect(buildMayor(LINES, accounts, PERIOD).closingBalanceSumCents).toBe(0)
  })

  it("un saldo acreedor es negativo (Σdebe − Σhaber)", () => {
    const report = buildMayor(LINES, accounts, PERIOD)
    expect(report.accounts.find((a) => a.accountCode === "705")!.closingBalanceCents).toBe(-100000)
  })

  it("filtra por `accountCodes` cuando se le pide", () => {
    const report = buildMayor(LINES, accounts, { ...PERIOD, accountCodes: ["705"] })
    expect(report.accounts.map((a) => a.accountCode)).toEqual(["705"])
  })

  it("emite provenance por cuenta con la consulta parametrizada", () => {
    const report = buildMayor(LINES, accounts, PERIOD, provenanceCtx)
    const clientes = report.accounts.find((a) => a.accountCode === "4300")!
    expect(clientes.provenance?.metrica).toBe("mayor.saldo.4300")
    expect(clientes.provenance?.registros_origen).toContain("account_code = $4")
    expect(clientes.provenance?.parametros).toEqual(["org-test", "2026-01-01", "2026-12-31", "4300"])
  })
})

describe("accountBalances (entrada del bloque C de plantillas)", () => {
  it("agrega Σdebe − Σhaber por cuenta", () => {
    const balances = accountBalances(LINES, { to: "2026-12-31" })
    expect(balances.get("705")).toBe(-100000)
    expect(balances.get("572")).toBe(121000)
    expect(balances.get("4300")).toBe(0)
  })

  it("puede excluir `kind` (la PyG excluye REGULARIZATION/CLOSING/OPENING)", () => {
    const conCierre = [...LINES, line({ entryId: "e9", entryKind: "CLOSING", accountCode: "705", debitCents: 100000 })]
    expect(accountBalances(conCierre, { to: "2026-12-31" }).get("705")).toBe(0)
    expect(accountBalances(conCierre, { to: "2026-12-31", kinds: ["NORMAL"] }).get("705")).toBe(-100000)
  })
})

describe("buildSumasSaldos", () => {
  it("caso vacío: sin filas y cuadre ✓", () => {
    const report = buildSumasSaldos([], accounts, PERIOD)
    expect(report.leaves).toEqual([])
    expect(report.balanceTotals.balanced).toBe(true)
  })

  it("sumas debe/haber y saldo deudor/acreedor por cuenta", () => {
    const report = buildSumasSaldos(LINES, accounts, PERIOD)
    const ventas = report.leaves.find((r) => r.accountCode === "705")!
    expect(ventas.sumCreditCents).toBe(100000)
    expect(ventas.balanceCents).toBe(-100000)
    expect(ventas.creditBalanceCents).toBe(100000)
    expect(ventas.debitBalanceCents).toBe(0)
  })

  it("la fila de cuadre: Σ deudores − Σ acreedores = 0", () => {
    const report = buildSumasSaldos(LINES, accounts, PERIOD)
    expect(report.balanceTotals.differenceCents).toBe(0)
    expect(report.balanceTotals.balanced).toBe(true)
    expect(report.totals.totalDebitCents).toBe(242000)
  })

  it("agrega por prefijo: grupo, subgrupo y cuenta (4300 → 430 → 43 → 4)", () => {
    const report = buildSumasSaldos(LINES, accounts, PERIOD)
    const codes = report.rows.filter((r) => r.isAggregate).map((r) => r.accountCode)
    expect(codes).toContain("4")
    expect(codes).toContain("43")
    expect(codes).toContain("430")
    const grupo4 = report.rows.find((r) => r.accountCode === "430" && r.isAggregate)!
    expect(grupo4.sumDebitCents).toBe(121000)
  })

  it("un descuadre se ve en la fila de cuadre", () => {
    const report = buildSumasSaldos(FACTURA.slice(0, 2), accounts, PERIOD)
    expect(report.balanceTotals.balanced).toBe(false)
    expect(report.balanceTotals.differenceCents).toBe(21000)
  })

  it("provenance por celda, solo en las hojas (no en los agregados)", () => {
    const report = buildSumasSaldos(LINES, accounts, PERIOD, provenanceCtx)
    const hoja = report.leaves.find((r) => r.accountCode === "705")!
    expect(hoja.provenance?.metrica).toBe("sumas_saldos.saldo.705")
    expect(hoja.provenance?.ledgerHash).toBe(`sha256:${"a".repeat(64)}`)
    expect(hoja.provenance?.calculado_por).toBe("lib/ledger/reports/sumas-saldos.ts@abc1234")
    expect(report.rows.filter((r) => r.isAggregate).every((r) => r.provenance === undefined)).toBe(true)
  })
})

describe("provenance (contrato de la skill fiabilidad)", () => {
  it("lleva valor, métrica, run, hash, módulo, consulta y confianza", () => {
    const p = cellProvenance(
      "sumas_saldos.saldo.430",
      1245032,
      { organizationId: "org-test", from: "2026-01-01", to: "2026-12-31", accountCode: "430" },
      provenanceCtx
    )
    expect(p).toMatchObject({
      valor: 1245032,
      moneda: "EUR",
      metrica: "sumas_saldos.saldo.430",
      run_id: "run-1",
      confianza: "calculado",
    })
    expect(p.ledgerHash.startsWith("sha256:")).toBe(true)
  })

  it("la consulta va PARAMETRIZADA: nunca se interpola el valor", () => {
    const p = cellProvenance(
      "sumas_saldos.saldo.430",
      1245032,
      { organizationId: "org-test", from: "2026-01-01", to: "2026-12-31", accountCode: "430" },
      provenanceCtx
    )
    expect(p.registros_origen).not.toContain("org-test")
    expect(p.registros_origen).toContain("$1")
    expect(p.parametros).toEqual(["org-test", "2026-01-01", "2026-12-31", "430"])
  })
})
