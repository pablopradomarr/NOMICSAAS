/**
 * E6 — Reproducción BYTE A BYTE de `docs/design/fixtures/estados-esperados.json`.
 *
 * El fichero está sellado por el experto contable y generado por
 * `build_estados_esperados.py` (Python puro, sin `lib/`, sin BD, sin float). Este
 * test comprueba que el motor de TypeScript llega **al mismo céntimo** por un
 * camino completamente distinto. Es la única forma honesta de afirmar que el
 * balance del producto es el balance que dice la norma: dos implementaciones
 * independientes que coinciden, no una que se compara consigo misma.
 *
 * Cubre: las 4 fotos × 2 modelos del balance, la PyG en los dos modelos, el
 * cashflow directo (anual y mensual) y el indirecto, y los invariantes
 * I2 = 0, I3 = 1 497 322, I6 = 0.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { filterByVariant, parseNpgcCsv } from "@/lib/accounts/csv"
import { defaultAccountMap } from "@/lib/accounts/map"
import { buildPlan } from "@/lib/accounts/codes"
import { seedRowsToPlanAccounts } from "@/lib/accounts/csv"
import type { AccountKey, PgcVariant } from "@/lib/accounts/types"
import { buildBalance, computeI3 } from "@/lib/ledger/reports/balance"
import { buildCashflowDirect, buildCashflowIndirect, buildEfeView, indirectBlockOf } from "@/lib/ledger/reports/cashflow"
import { buildPyg } from "@/lib/ledger/reports/pyg"
import {
  buildAccountIndex,
  type BalanceSnapshot,
  type ReportLine,
  type StatementAccount,
  type StatementRow,
} from "@/lib/ledger/reports/types"
import { loadFixture, toReportLines } from "@/tests/support/fixtures"

// ─────────────────────────────────────────────────────────────────────────────
// Entrada
// ─────────────────────────────────────────────────────────────────────────────

type ExpectedRow = { path: string; depth: number; cents: number; isLeaf: boolean }

const expected = JSON.parse(
  readFileSync(path.join(process.cwd(), "docs", "design", "fixtures", "estados-esperados.json"), "utf8")
) as {
  balance: Record<string, Record<string, { activo: ExpectedRow[]; patrimonioNeto: ExpectedRow[]; pasivo: ExpectedRow[]; totalActivoCents: number; totalPatrimonioNetoCents: number; totalPasivoCents: number; i2DiffCents: number } | unknown>>
  pyg: Record<string, { lines: ExpectedRow[]; byEpigraphNumberCents: Record<string, number>; subtotalsCents: Record<string, number>; resultadoDelEjercicioCents: number; skeleton: { n: number; name: string; cents: number }[] }>
  cashflow: {
    directo: Record<string, unknown>
    indirecto: Record<string, unknown>
  }
  keyFiguresCents: Record<string, number>
  indirectBlocks: { prefix: string; block: string }[]
  bidirectionalMirror: Record<string, Record<string, string>>
  bidirectionalScenarios: Record<string, unknown>[]
}

/**
 * El generador resuelve `estado_financiero`, `epigrafe` y `cashflow_bucket`
 * sobre las **906 filas** del seed (sin filtrar por variante), subiendo por el
 * código. Aquí se hace igual: el índice del motor recibe el seed completo, de
 * modo que las dos implementaciones parten del mismo dato de origen.
 */
function seedAccounts(): StatementAccount[] {
  const csv = readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8")
  const parsed = parseNpgcCsv(csv)
  if (!parsed.ok) throw new Error(`El seed no parsea: ${JSON.stringify(parsed.errors.slice(0, 3))}`)
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
const fixture = loadFixture("ejercicio-completo")
const allLines = toReportLines(fixture.posted)

const FY_2026 = fixture.fiscalYears.find((fy) => fy.code === "2026")!
const FY_2027 = fixture.fiscalYears.find((fy) => fy.code === "2027")!

/** Cuenta mapeada a `RESULTADO_EJERCICIO` (129). No se escribe a mano. */
const resultAccountCode = (() => {
  const plan = buildPlan(
    seedRowsToPlanAccounts(
      (() => {
        const parsed = parseNpgcCsv(readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8"))
        if (!parsed.ok) throw new Error("seed")
        const filtered = filterByVariant(parsed.value, "PYMES")
        if (!filtered.ok) throw new Error("variant")
        return filtered.value
      })()
    )
  )
  const { entries } = defaultAccountMap(plan, { useSubaccounts: false, createSoftwareAccounts: false })
  const found = entries.find((e) => e.key === ("RESULTADO_EJERCICIO" as AccountKey))
  return found?.accountCode ?? "129"
})()

const balanceParams = (snapshot: BalanceSnapshot, variant: PgcVariant, fiscalYearId: string, to: string) => ({
  organizationId: fixture.ctx.organizationId,
  from: "2026-01-01",
  to,
  baseCurrency: "EUR",
  fiscalYearId,
  variant,
  snapshot,
  resultAccountCode,
})

/** El JSON trae `{path, depth, cents, isLeaf}`; el motor añade metadatos. */
const toExpectedShape = (rows: readonly StatementRow[]): ExpectedRow[] =>
  rows.map((r) => ({ path: r.path, depth: r.depth, cents: r.cents, isLeaf: r.isLeaf }))

// Las cuatro fotos. `APERTURA_2027` no es una foto distinta: es `POST_CIERRE`
// sobre el ejercicio siguiente, cuyo único asiento es la apertura.
const SNAPSHOTS: { name: string; snapshot: BalanceSnapshot; fiscalYearId: string; to: string }[] = [
  { name: "PRE_REGULARIZACION", snapshot: "PRE_REGULARIZACION", fiscalYearId: FY_2026.id, to: "2026-12-31" },
  { name: "POST_REGULARIZACION", snapshot: "POST_REGULARIZACION", fiscalYearId: FY_2026.id, to: "2026-12-31" },
  { name: "POST_CIERRE", snapshot: "POST_CIERRE", fiscalYearId: FY_2026.id, to: "2026-12-31" },
  { name: "APERTURA_2027", snapshot: "POST_CIERRE", fiscalYearId: FY_2027.id, to: "2027-12-31" },
]

const MODELS: { name: string; variant: PgcVariant }[] = [
  { name: "NORMAL", variant: "GENERAL" },
  { name: "PYMES", variant: "PYMES" },
]

// ─────────────────────────────────────────────────────────────────────────────

describe("E6 · balance byte a byte contra estados-esperados.json", () => {
  for (const snap of SNAPSHOTS) {
    for (const model of MODELS) {
      it(`${snap.name} / ${model.name} reproduce el fixture al céntimo`, () => {
        const exp = (expected.balance[snap.name] as Record<string, ExpectedRow[] & Record<string, number>>)[
          model.name
        ] as unknown as { activo: ExpectedRow[]; patrimonioNeto: ExpectedRow[]; pasivo: ExpectedRow[]; totalActivoCents: number; totalPatrimonioNetoCents: number; totalPasivoCents: number; i2DiffCents: number }

        const report = buildBalance(
          allLines,
          index,
          balanceParams(snap.snapshot, model.variant, snap.fiscalYearId, snap.to)
        )

        expect(toExpectedShape(report.activo)).toEqual(exp.activo)
        expect(toExpectedShape(report.patrimonioNeto)).toEqual(exp.patrimonioNeto)
        expect(toExpectedShape(report.pasivo)).toEqual(exp.pasivo)
        expect(report.totalActivoCents).toBe(exp.totalActivoCents)
        expect(report.totalPatrimonioNetoCents).toBe(exp.totalPatrimonioNetoCents)
        expect(report.totalPasivoCents).toBe(exp.totalPasivoCents)
        // I2 con tolerancia CERO.
        expect(report.i2DiffCents).toBe(0)
      })
    }
  }

  it("I-E6-1: los dos modelos cuadran al mismo total en las cuatro fotos", () => {
    for (const snap of SNAPSHOTS) {
      const normal = buildBalance(allLines, index, balanceParams(snap.snapshot, "GENERAL", snap.fiscalYearId, snap.to))
      const pymes = buildBalance(allLines, index, balanceParams(snap.snapshot, "PYMES", snap.fiscalYearId, snap.to))
      expect(pymes.totalActivoCents).toBe(normal.totalActivoCents)
      expect(pymes.totalPasivoYPatrimonioNetoCents).toBe(normal.totalPasivoYPatrimonioNetoCents)
    }
  })

  it("I-E6-11: pre y post regularización dan el mismo total y el mismo PN (R-B5 es neutra)", () => {
    const pre = buildBalance(allLines, index, balanceParams("PRE_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    const post = buildBalance(allLines, index, balanceParams("POST_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    expect(post.totalActivoCents).toBe(pre.totalActivoCents)
    expect(post.totalPatrimonioNetoCents).toBe(pre.totalPatrimonioNetoCents)
    // Y lo importante: el resultado sale de UNA fuente, no de las dos.
    expect(pre.resultado.source).toBe("INYECTADO_I3")
    expect(post.resultado.source).toBe("LEIDO_129")
    expect(pre.resultado.cents).toBe(post.resultado.cents)
  })

  it("I-E6-8: tras el CLOSING ninguna cuenta de balance conserva saldo", () => {
    const cierre = buildBalance(allLines, index, balanceParams("POST_CIERRE", "GENERAL", FY_2026.id, "2026-12-31"))
    expect(cierre.totalActivoCents).toBe(0)
    expect(cierre.totalPasivoYPatrimonioNetoCents).toBe(0)
    expect(cierre.accountDetail).toEqual([])
  })

  it("I-E6-9: la apertura de 2027 reproduce el balance formulado, 129 incluida", () => {
    const formulado = buildBalance(allLines, index, balanceParams("POST_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    const apertura = buildBalance(allLines, index, balanceParams("POST_CIERRE", "GENERAL", FY_2027.id, "2027-12-31"))
    const saldos = (r: typeof formulado) =>
      Object.fromEntries(r.accountDetail.map((a) => [a.code, a.saldoCents]))
    expect(saldos(apertura)).toEqual(saldos(formulado))
    expect(apertura.resultado.saldo129Cents).toBe(formulado.resultado.saldo129Cents)
  })

  it("criterio 5: las contra-cuentas NO se restan dos veces (R-B3)", () => {
    const report = buildBalance(allLines, index, balanceParams("PRE_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    const row = report.activo.find((r) => r.path.endsWith("2. Instalaciones técnicas y otro inmovilizado material"))
    // 216 + 217 = 3 300 000 · 2816 + 2817 = −635 000 → 2 665 000.
    // Restar `isContra` ADEMÁS del signo daría 3 935 000.
    expect(row?.cents).toBe(2_665_000)
  })

  it("I-E6-10 / I-E6-12: no hay anomalías de signo en el fixture", () => {
    const report = buildBalance(allLines, index, balanceParams("PRE_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    expect(report.contraSignAnomalies).toEqual([])
    expect(report.ivaSignAnomalies).toEqual([])
    expect(report.bridgeAccountWarnings).toEqual([])
  })

  it("I-E6-5b: la tabla de bidireccionales reproduce `bidirectionalMirror`", () => {
    for (const scenario of expected.bidirectionalScenarios as unknown as {
      code: string
      NORMAL: Record<string, { saldoCents: number; side: string | null; epigraph: string | null; presentedCents: number }>
      PYMES: Record<string, { saldoCents: number; side: string | null; epigraph: string | null; presentedCents: number }>
    }[]) {
      for (const [model, variant] of [["NORMAL", "GENERAL"], ["PYMES", "PYMES"]] as const) {
        for (const key of ["saldoDeudor", "saldoAcreedor", "saldoCero"] as const) {
          const c = scenario[model][key]
          const synthetic: ReportLine[] = c.saldoCents === 0 ? [] : [
            {
              entryId: "sint", entryNumber: 1, entryDate: "2026-06-30", entryKind: "MANUAL",
              fiscalYearId: FY_2026.id, lineNo: 1, accountCode: scenario.code,
              debitCents: Math.max(c.saldoCents, 0), creditCents: Math.max(-c.saldoCents, 0),
            },
          ]
          const report = buildBalance(synthetic, index, balanceParams("PRE_REGULARIZACION", variant, FY_2026.id, "2026-12-31"))
          const detail = report.accountDetail.filter((a) => a.code === scenario.code)
          if (c.side === null) {
            // Saldo 0: no se presenta en NINGÚN lado.
            expect(detail).toEqual([])
            continue
          }
          expect(detail).toHaveLength(1) // I-E6-5: nunca en los dos lados
          expect(detail[0].side).toBe(c.side)
          expect(detail[0].epigraph).toBe(c.epigraph)
          expect(detail[0].presentedCents).toBe(c.presentedCents)
        }
      }
    }
  })

  it("diario vacío: PASS, no error de división", () => {
    const report = buildBalance([], index, balanceParams("PRE_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    expect(report.i2DiffCents).toBe(0)
    expect(report.totalActivoCents).toBe(0)
    expect(report.resultado.source).toBe("NINGUNO")
  })

  it("129 con pérdidas: PN negativo con I2 = 0 y sin reclasificar al activo", () => {
    const perdidas: ReportLine[] = [
      // Capital 3 000 000 contra tesorería, y un gasto de 5 000 000 a crédito.
      { entryId: "e1", entryNumber: 1, entryDate: "2026-01-01", entryKind: "OPENING", fiscalYearId: FY_2026.id, lineNo: 1, accountCode: "572", debitCents: 3_000_000, creditCents: 0 },
      { entryId: "e1", entryNumber: 1, entryDate: "2026-01-01", entryKind: "OPENING", fiscalYearId: FY_2026.id, lineNo: 2, accountCode: "100", debitCents: 0, creditCents: 3_000_000 },
      { entryId: "e2", entryNumber: 2, entryDate: "2026-06-30", entryKind: "MANUAL", fiscalYearId: FY_2026.id, lineNo: 1, accountCode: "621", debitCents: 5_000_000, creditCents: 0 },
      { entryId: "e2", entryNumber: 2, entryDate: "2026-06-30", entryKind: "MANUAL", fiscalYearId: FY_2026.id, lineNo: 2, accountCode: "4100", debitCents: 0, creditCents: 5_000_000 },
    ]
    const report = buildBalance(perdidas, index, balanceParams("PRE_REGULARIZACION", "GENERAL", FY_2026.id, "2026-12-31"))
    expect(report.resultado.cents).toBe(-5_000_000)
    expect(report.totalPatrimonioNetoCents).toBe(-2_000_000) // PN negativo: es información, no un descuadre
    expect(report.i2DiffCents).toBe(0)
  })
})

describe("E6 · PyG byte a byte", () => {
  for (const model of MODELS) {
    it(`${model.name} reproduce el fixture al céntimo`, () => {
      const exp = expected.pyg[model.name]
      const report = buildPyg(allLines, index, {
        organizationId: fixture.ctx.organizationId,
        from: "2026-01-01",
        to: "2026-12-31",
        baseCurrency: "EUR",
        fiscalYearId: FY_2026.id,
        variant: model.variant,
      })
      expect(toExpectedShape(report.lines)).toEqual(exp.lines)
      expect(report.byEpigraphNumberCents).toEqual(exp.byEpigraphNumberCents)
      expect(report.subtotalsCents).toEqual(exp.subtotalsCents)
      expect(report.resultadoDelEjercicioCents).toBe(exp.resultadoDelEjercicioCents)
      expect(report.skeleton).toEqual(exp.skeleton)
    })
  }

  it("I3 = 1 497 322 y coincide con −saldo(129) tras la regularización (I-E6-13)", () => {
    const scoped = allLines.filter((l) => l.fiscalYearId === FY_2026.id)
    const i3 = computeI3(scoped)
    expect(i3).toBe(1_497_322)
    const saldo129 = scoped
      .filter((l) => l.accountCode === resultAccountCode && l.entryKind !== "CLOSING")
      .reduce((a, l) => a + l.debitCents - l.creditCents, 0)
    expect(-saldo129).toBe(i3)
  })

  it("I-E6-3 / I-E6-4: A.3 = BAI de E4 · A.4 = I3 · A.1 + A.2 = A.3, en los dos modelos", () => {
    for (const model of MODELS) {
      const r = buildPyg(allLines, index, {
        organizationId: fixture.ctx.organizationId,
        from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR",
        fiscalYearId: FY_2026.id, variant: model.variant,
      })
      const s = r.subtotalsCents
      expect(s["A.3) RESULTADO ANTES DE IMPUESTOS"]).toBe(1_996_430)
      expect(s["A.1) RESULTADO DE EXPLOTACION"] + s["A.2) RESULTADO FINANCIERO"]).toBe(s["A.3) RESULTADO ANTES DE IMPUESTOS"])
      expect(s["A.4) RESULTADO DEL EJERCICIO"]).toBe(1_497_322)
      expect(r.resultadoDelEjercicioCents).toBe(1_497_322)
      // §8.5: EBITDA = A.1 revirtiendo 8 y 11, la misma cifra que la matriz de E4.
      expect(r.ebitdaCents).toBe(2_390_430)
    }
  })

  it("los signos de las contra-cuentas salen SOLOS (R-P1): 7080 −100 000 y 6080 +50 000", () => {
    const r = buildPyg(allLines, index, {
      organizationId: fixture.ctx.organizationId,
      from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR",
      fiscalYearId: FY_2026.id, variant: "GENERAL",
    })
    expect(r.lines.find((l) => l.path === "1. Importe neto de la cifra de negocios / a) Ventas")?.cents).toBe(-100_000)
    expect(r.lines.find((l) => l.path === "4. Aprovisionamientos / a) Consumo de mercaderías")?.cents).toBe(50_000)
    // Y el INCN total no se resiente: 6 350 000 − 100 000.
    expect(r.byEpigraphNumberCents["1"]).toBe(6_250_000)
  })

  it("diario vacío: PyG a cero, sin NaN", () => {
    const r = buildPyg([], index, {
      organizationId: fixture.ctx.organizationId,
      from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR", variant: "GENERAL",
    })
    expect(r.resultadoDelEjercicioCents).toBe(0)
    expect(r.lines).toEqual([])
    expect(r.skeleton.every((s) => s.cents === 0)).toBe(true)
  })
})

describe("E6 · cashflow byte a byte", () => {
  const cfParams = {
    organizationId: fixture.ctx.organizationId,
    from: "2026-01-01",
    to: "2026-12-31",
    baseCurrency: "EUR",
    fiscalYearId: FY_2026.id,
    // R-CF-8: las cuentas del IS se resuelven por clave, no por código literal.
    incomeTaxAccountCodes: incomeTaxCodes(),
  }

  it("directo: anual, mensual y saldo acumulado, al céntimo", () => {
    const exp = expected.cashflow.directo as Record<string, never>
    const r = buildCashflowDirect(allLines, index, cfParams)
    expect(r.openingCashCents).toBe(exp.openingCashCents)
    expect(r.closingCashCents).toBe(exp.closingCashCents)
    expect(r.deltaCashCents).toBe(exp.deltaCashCents)
    expect(r.annualCents).toEqual(exp.annualCents)
    expect(r.byCategoryCents).toEqual(exp.byCategoryCents)
    expect(r.monthlyCents).toEqual(exp.monthlyCents)
    expect(r.monthlyTotalCents).toEqual(exp.monthlyTotalCents)
    expect(r.monthlyRunningCashCents).toEqual(exp.monthlyRunningCashCents)
    expect(r.efeImpuestoBeneficiosCents).toBe(exp.efeImpuestoBeneficiosCents)
    expect(r.efeOtrosImpuestosCents).toBe(exp.efeOtrosImpuestosCents)
    expect(r.totalFlowsCents).toBe(exp.totalFlowsCents)
    expect(r.unbucketedAccounts).toEqual([])
    // I6 directo, tolerancia 0.
    expect(r.checkI6DirectCents).toBe(0)
  })

  it("R-CF-4: el traspaso 570↔572 se excluye y se lista en `internalTransfers`", () => {
    const r = buildCashflowDirect(allLines, index, cfParams)
    const refs = r.internalTransfers.map(refOf)
    expect(refs).toEqual((expected.cashflow.directo as { internalTransfers: string[] }).internalTransfers)
  })

  it("R-CF-3: CO-003 da +300 000 y −500 exactos, no 299 001 / 499", () => {
    const r = buildCashflowDirect(allLines, index, cfParams)
    const co003 = r.lineDetail.filter((d) => refOf(d.entryId) === "CO-003")
    expect(co003.map((d) => d.cents).sort((a, b) => a - b)).toEqual([-500, 300_000])
  })

  it("R-CF-7: el IVA de ANT-C-01 va al bloque comercial, no a impuestos", () => {
    const r = buildCashflowDirect(allLines, index, cfParams)
    const ant = r.lineDetail.filter((d) => refOf(d.entryId) === "ANT-C-01")
    expect(ant.every((d) => d.bucket === "COBROS_CLIENTES")).toBe(true)
    expect(ant.reduce((a, d) => a + d.cents, 0)).toBe(242_000)
    expect(r.ambiguousVatEntries).toEqual([])
  })

  it("indirecto: bloques al céntimo, `RESULTADO` = I3 sin ajuste (I-E6-7)", () => {
    const exp = expected.cashflow.indirecto as Record<string, never>
    const r = buildCashflowIndirect(allLines, cfParams)
    expect(r.blockCents).toEqual(exp.blockCents)
    expect(r.blockAccountCents).toEqual(exp.blockAccountCents)
    expect(r.totalCents).toBe(exp.totalCents)
    expect(r.blockCents.RESULTADO).toBe(1_497_322)
    expect(r.unpartitionedAccounts).toEqual([])
    // I6 indirecto: Σ bloques = Δ57x, por álgebra y sin partida de cuadre.
    expect(r.checkI6IndirectCents).toBe(0)
  })

  it("R-CF-6: `nonCashEntries` = AJ-002 y R-009", () => {
    const r = buildCashflowIndirect(allLines, cfParams)
    expect(r.nonCashEntries.map(refOf)).toEqual(
      (expected.cashflow.indirecto as { nonCashEntries: string[] }).nonCashEntries
    )
  })

  it("I6: directo == indirecto == 4 000 000 − 1 056 080 = 2 943 920", () => {
    const direct = buildCashflowDirect(allLines, index, cfParams)
    const indirect = buildCashflowIndirect(allLines, cfParams)
    expect(direct.totalFlowsCents).toBe(indirect.totalCents)
    expect(direct.openingCashCents + direct.totalFlowsCents).toBe(2_943_920)
    expect(direct.closingCashCents).toBe(2_943_920)
    // I-E6-6: el acumulado del último mes con flujo es el saldo final.
    const months = Object.keys(direct.monthlyRunningCashCents).sort()
    expect(direct.monthlyRunningCashCents[months[months.length - 1]]).toBe(2_943_920)
  })

  it("vista oficial A–E: E = Δ57x y D = 0 documentado", () => {
    const efe = buildEfeView(buildCashflowDirect(allLines, index, cfParams), buildCashflowIndirect(allLines, cfParams))
    expect(efe.tipoCambioCents).toBe(0)
    expect(efe.checkCents).toBe(0)
    expect(efe.deltaCashCents).toBe(-1_056_080)
    expect(efe.closingCashCents).toBe(2_943_920)
    expect(efe.header).toContain("Informe de gestión")
  })

  it("el cashflow NO depende del estado de cierre", () => {
    const base = buildCashflowDirect(allLines, index, cfParams)
    // Quitar la regularización y el cierre no cambia una sola cifra: ya estaban
    // excluidos por R-CF-2.
    const sinCierre = allLines.filter((l) => l.entryKind !== "CLOSING" && l.entryKind !== "REGULARIZATION")
    expect(buildCashflowDirect(sinCierre, index, cfParams).annualCents).toEqual(base.annualCents)
  })

  it("diario vacío: inicial 0, Δ 0, final 0", () => {
    const r = buildCashflowDirect([], index, cfParams)
    expect([r.openingCashCents, r.deltaCashCents, r.closingCashCents]).toEqual([0, 0, 0])
    expect(r.checkI6DirectCents).toBe(0)
  })

  it("criterio 10: la partición del indirecto es exhaustiva sobre las 906 cuentas del seed", () => {
    const accounts = seedAccounts()
    expect(accounts).toHaveLength(906)
    // Los grupos 8 y 9 son cuentas de ECPN y de contabilidad analítica interna:
    // no pueden ser contrapartida de un movimiento de tesorería y quedan fuera
    // de la partición a propósito (son también las que el seed deja sin bucket).
    // R-CF-5 habla de «toda cuenta **no-57x**»: la tesorería es el sujeto del
    // informe, no una contrapartida, y por eso no tiene bloque.
    // Sólo las HOJAS reciben líneas de asiento (I-E2-2): los contenedores de
    // nivel 1 (`1`…`5`) y los mixtos como `46` no son postables y no pueden
    // aparecer en el diario.
    const codes = new Set(accounts.map((a) => a.code))
    const postable = accounts.filter((a) => ![...codes].some((c) => c !== a.code && c.startsWith(a.code)))
    const enBalanceOPyg = postable.filter(
      (a) => !a.code.startsWith("8") && !a.code.startsWith("9") && !a.code.startsWith("57")
    )
    expect(enBalanceOPyg.filter((a) => indirectBlockOf(a.code) === null).map((a) => a.code)).toEqual([])
    // Y ninguna cae en dos bloques: `indirectBlockOf` resuelve por el prefijo MÁS
    // LARGO que case, así que la asignación es única por construcción.
    expect(new Set(expected.indirectBlocks.map((b) => b.prefix)).size).toBe(expected.indirectBlocks.length)
    for (const { prefix, block } of expected.indirectBlocks) {
      expect(indirectBlockOf(prefix)).toBe(block)
    }
  })

  it("R-18′: toda cuenta postable salvo 57x tiene bucket de cashflow", () => {
    const accounts = seedAccounts()
    const codes = new Set(accounts.map((a) => a.code))
    const postable = accounts.filter((a) => ![...codes].some((c) => c !== a.code && c.startsWith(a.code)))
    const sinBucket = postable.filter((a) => !a.code.startsWith("57") && index.bucketOf(a.code) === null)
    // Los grupos 8 y 9 (ECPN) no son contrapartida de tesorería: no llevan bucket.
    expect(sinBucket.filter((a) => !a.code.startsWith("8") && !a.code.startsWith("9")).map((a) => a.code)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades del test
// ─────────────────────────────────────────────────────────────────────────────

/** El fixture identifica los asientos por `ref`; el motor, por `entryId`. */
function refOf(entryId: string): string {
  return entryId.startsWith("entry-") ? entryId.slice("entry-".length) : entryId
}

function incomeTaxCodes(): string[] {
  const parsed = parseNpgcCsv(readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8"))
  if (!parsed.ok) throw new Error("seed")
  const filtered = filterByVariant(parsed.value, "PYMES")
  if (!filtered.ok) throw new Error("variant")
  const plan = buildPlan(seedRowsToPlanAccounts(filtered.value))
  const { entries } = defaultAccountMap(plan, { useSubaccounts: false, createSoftwareAccounts: false })
  return entries
    .filter((e) => e.key === ("HP_ACREEDORA_IS" as AccountKey) || e.key === ("HP_DEUDORA_IS" as AccountKey))
    .map((e) => e.accountCode)
}
