/**
 * E3 — El motor reproduce los fixtures inmutables.
 *
 * `tests/fixtures/ejercicio-{minimo,completo}.json` traen un bloque `expected`
 * calculado por `docs/design/fixtures/build_ejercicio_completo.py`. Este test
 * comprueba que el motor —cargador, informes y hash— llega **a las mismas
 * cifras**, y que dos ejecuciones producen un resultado **byte-idéntico**
 * (C1 de SPEC-FIABILIDAD: mismo input, mismo output, siempre).
 *
 * Los fixtures NO se editan: se regeneran con el script.
 */

import { describe, expect, it } from "vitest"

import { entryHash, type HashableLine, ledgerHash } from "@/lib/ledger/hash"
import { buildDiario } from "@/lib/ledger/reports/diario"
import { buildMayor } from "@/lib/ledger/reports/mayor"
import { buildSumasSaldos } from "@/lib/ledger/reports/sumas-saldos"
import {
  balancesOf,
  checkFixtureSelfConsistency,
  loadFixture,
  toReportAccounts,
  toReportEntries,
  toReportLines,
} from "@/tests/support/fixtures"

/**
 * El `expected` del fixture usa códigos de PRESENTACIÓN (430, 400, 4750…),
 * mientras que el motor postea en la hoja POSTABLE que resuelve el mapa (4300,
 * 4000, 4750…), porque en el plan PYMES 430/400/410 son cuentas padre. La
 * comparación agrega por prefijo, que es exactamente lo que hace la jerarquía de
 * sumas y saldos.
 */
function rollUp(balances: ReadonlyMap<string, number>, reportingCodes: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const code of reportingCodes) {
    let total = 0
    for (const [leaf, value] of balances) {
      if (leaf.startsWith(code)) total += value
    }
    out[code] = total
  }
  return out
}

describe.each(["ejercicio-minimo", "ejercicio-completo"] as const)("fixture %s", (name) => {
  const loaded = loadFixture(name)
  const { file, posted, plan } = loaded
  const expected = file.expected

  const lines = toReportLines(posted)
  const entries = toReportEntries(posted)
  const accounts = toReportAccounts(plan)
  const period = {
    organizationId: loaded.ctx.organizationId,
    from: "2000-01-01",
    to: "2099-12-31",
    baseCurrency: file.organization.baseCurrency,
  }

  it("carga el número de asientos declarado", () => {
    expect(posted).toHaveLength(expected.entryCount)
  })

  it("Σdebe = Σhaber y coinciden con `expected.total*Cents`", () => {
    const diario = buildDiario(entries, lines, accounts, period)
    expect(diario.totals.totalDebitCents).toBe(expected.totalDebitCents)
    expect(diario.totals.totalCreditCents).toBe(expected.totalCreditCents)
    expect(diario.totals.balanced).toBe(true)
    expect(diario.entryCount).toBe(expected.entryCount)
  })

  it("todos los asientos cuadran uno a uno (I1)", () => {
    const diario = buildDiario(entries, lines, accounts, period)
    expect(diario.entries.filter((e) => !e.balanced)).toEqual([])
  })

  it("los saldos por cuenta antes del cierre coinciden con `expected`", () => {
    // Antes del cierre = todo salvo el asiento de cierre (y la apertura del
    // ejercicio siguiente, que ya es del año que viene).
    const beforeClosing = posted.filter((e) => e.kind !== "CLOSING" && e.kind !== "OPENING")
    const openings = posted.filter((e) => e.kind === "OPENING" && e.entryDate <= file.fiscalYear.endDate)
    const balances = balancesOf([...openings, ...beforeClosing])
    const reportingCodes = Object.keys(expected.balancesBeforeClosingCents)
    expect(rollUp(balances, reportingCodes)).toEqual(expected.balancesBeforeClosingCents)
  })

  it("el saldo de la 129 tras la regularización es el resultado del ejercicio (I3)", () => {
    const balances = balancesOf(posted.filter((e) => e.kind !== "CLOSING" && e.entryDate <= file.fiscalYear.endDate))
    // Convención del fixture: saldo = Σdebe − Σhaber, acreedor negativo.
    expect(-(balances.get("129") ?? 0)).toBe(expected.saldo129Cents)
  })

  it("sumas y saldos cuadra: Σ deudores = Σ acreedores", () => {
    const report = buildSumasSaldos(lines, accounts, period)
    expect(report.totals.totalDebitCents).toBe(expected.totalDebitCents)
    expect(report.balanceTotals.balanced).toBe(true)
    expect(report.balanceTotals.differenceCents).toBe(0)
  })

  it("el mayor cuadra contra sumas y saldos (Σ saldos finales = 0)", () => {
    const mayor = buildMayor(lines, accounts, period)
    expect(mayor.closingBalanceSumCents).toBe(0)
    const sumasSaldos = buildSumasSaldos(lines, accounts, period)
    const byCode = new Map(sumasSaldos.leaves.map((r) => [r.accountCode, r.balanceCents]))
    for (const account of mayor.accounts) {
      expect(account.closingBalanceCents).toBe(byCode.get(account.accountCode))
    }
  })

  it("E4 · T9 (invierte D-E3-1): el cargador RESUELVE proyecto, CECO y línea de negocio", () => {
    // El día que E4 activó las dimensiones, este test se invirtió a propósito:
    // antes exigía que las tres columnas fueran NULL.
    if (name === "ejercicio-completo") {
      expect(loaded.resolvedDimensions.projectCodes + loaded.resolvedDimensions.costCenterCodes).toBeGreaterThan(0)
      expect(loaded.dimensions.projects.length).toBeGreaterThan(0)
      expect(loaded.dimensions.costCenters.length).toBeGreaterThan(0)
      expect(loaded.ctx.dimensions.available).toBe(true)
    }

    const blOfProject = new Map(loaded.dimensions.projects.map((p) => [p.id, p.businessLineId]))
    let withDestination = 0
    for (const entry of posted) {
      for (const line of entry.lines) {
        // R-A1 / I-E4-5: los grupos 1–5 nunca llevan dimensión.
        if (!line.accountCode.startsWith("6") && !line.accountCode.startsWith("7")) {
          expect(line.projectId).toBeNull()
          expect(line.costCenterId).toBeNull()
          expect(line.businessLineId).toBeNull()
          continue
        }
        // I-E4-2: nunca las dos dimensiones a la vez.
        expect(line.projectId !== null && line.costCenterId !== null).toBe(false)
        if (line.projectId || line.costCenterId) withDestination++
        // I-E4-3 / R-A9: la línea de negocio es la del proyecto, y NULL sin él.
        expect(line.businessLineId).toBe(line.projectId ? (blOfProject.get(line.projectId) ?? null) : null)
      }
    }
    if (name === "ejercicio-completo") expect(withDestination).toBeGreaterThan(0)
  })

  it("dos ejecuciones producen un resultado BYTE-IDÉNTICO (C1)", () => {
    const first = loadFixture(name)
    const second = loadFixture(name)

    // 1. El hash canónico del diario entero es el mismo.
    const hashOf = (p: typeof posted) =>
      ledgerHash(
        p.flatMap((e) =>
          e.lines.map((l) => ({
            entryDate: e.entryDate,
            entryNumber: e.entryNumber,
            lineNo: l.lineNo,
            accountCode: l.accountCode,
            debitCents: l.debitCents,
            creditCents: l.creditCents,
            entryKind: e.kind,
            projectId: l.projectId ?? null,
            costCenterId: l.costCenterId ?? null,
            businessLineId: l.businessLineId ?? null,
          }))
        )
      )
    expect(hashOf(first.posted)).toBe(hashOf(second.posted))

    // 2. Y los informes serializados también, carácter a carácter.
    const render = (p: typeof first) =>
      JSON.stringify({
        diario: buildDiario(toReportEntries(p.posted), toReportLines(p.posted), toReportAccounts(p.plan), period),
        sumasSaldos: buildSumasSaldos(toReportLines(p.posted), toReportAccounts(p.plan), period),
        mayor: buildMayor(toReportLines(p.posted), toReportAccounts(p.plan), period),
      })
    expect(render(first)).toBe(render(second))
  })

  it("el `entryHash` de cada asiento es estable entre cargas", () => {
    const again = loadFixture(name)
    expect(posted.map((e) => e.entryHash)).toEqual(again.posted.map((e) => e.entryHash))
  })

  /**
   * **E8 · T2b — el test explícito de que `hashVersion = 3` no mueve nada.**
   *
   * `entryHash` estrena forma canónica v3 (ADR-0014 D2) y esa es *toda* la
   * novedad: el sello FINANCIERO no la conoce. Si este valor cambiara, todo
   * informe sellado de E3–E6 dejaría de servirse de caché (I-E6-18) y el
   * criterio 15 de E3 —dos organizaciones con el mismo diario, el mismo
   * `ledgerHash`— dejaría de ser cierto sin que se haya movido un céntimo.
   *
   * Los literales se calcularon con el código ANTERIOR a T2b (34c9f85^).
   */
  it("E8 · T2b: el `ledgerHash` del fixture NO cambia con `hashVersion = 3` (byte a byte)", () => {
    const congelado: Record<string, string> = {
      "ejercicio-minimo": "a23576f7193ac0b29d6ad29d8cc78ff5cae102e9822b0e7dcd1a8a5afe22cccc",
      "ejercicio-completo": "cb9c874479ffc2e7e7acc4e9cc49e0cea6dc49090c360cdd327e07d98660769e",
    }
    expect(ledgerHash(toReportLines(posted) as unknown as Parameters<typeof ledgerHash>[0])).toBe(congelado[name])
  })

  it("E8 · T2b: los asientos del fixture nacen en v3 y lo DECLARAN (convivencia)", () => {
    // Sin la versión declarada, I-E3-7 verificaría con v2 y daría un FAIL que no
    // existe. Es el riesgo R5 de la épica, y aquí está su red.
    expect(posted.every((e) => e.hashVersion === 3)).toBe(true)
    for (const e of posted) {
      expect(entryHash(hashableOf(e), 3)).toBe(e.entryHash)
      // …y con la forma equivocada, NO cuadra: la convivencia es real.
      expect(entryHash(hashableOf(e), 2)).not.toBe(e.entryHash)
    }
  })
})

describe("ejercicio-completo — cifras concretas del §4.3 del experto", () => {
  const loaded = loadFixture("ejercicio-completo")
  const { file, posted, plan } = loaded
  const lines = toReportLines(posted)
  const accounts = toReportAccounts(plan)

  it("84 asientos, 326 líneas, Σdebe = Σhaber = 67.193.629", () => {
    expect(posted).toHaveLength(84)
    expect(lines).toHaveLength(326)
    expect(lines.reduce((a, l) => a + l.debitCents, 0)).toBe(67193629)
    expect(lines.reduce((a, l) => a + l.creditCents, 0)).toBe(67193629)
  })

  it("solo el ejercicio 2026: Σdebe = Σhaber = 52.884.809 en 83 asientos", () => {
    const of2026 = posted.filter((e) => e.entryDate <= "2026-12-31")
    expect(of2026).toHaveLength(file.expected.entryCount2026 as number)
    const lines2026 = toReportLines(of2026)
    expect(lines2026.reduce((a, l) => a + l.debitCents, 0)).toBe(file.expected.totalDebitCents2026)
  })

  it("resultado 1.497.322 = saldo acreedor de 129, e IS de 499.108", () => {
    expect(file.expected.saldo129Cents).toBe(1497322)
    expect(file.expected.impuestoBeneficiosCents).toBe(499108)
    const balances = balancesOf(posted.filter((e) => e.kind !== "CLOSING" && e.entryDate <= "2026-12-31"))
    expect(-(balances.get("129") ?? 0)).toBe(1497322)
  })

  it("los seis saldos de referencia (430, 400, 472, 477, 4750, 572)", () => {
    const beforeClosing = posted.filter((e) => e.kind !== "CLOSING" && e.entryDate <= "2026-12-31")
    const balances = balancesOf(beforeClosing)
    const check = (reportingCode: string) => {
      let total = 0
      for (const [leaf, value] of balances) if (leaf.startsWith(reportingCode)) total += value
      return total
    }
    expect(check("430")).toBe(7723900)
    expect(check("400")).toBe(-1959800)
    expect(check("472")).toBe(0)
    expect(check("477")).toBe(0)
    expect(check("4750")).toBe(-245490)
    expect(check("572")).toBe(2913920)
  })

  it("la cobertura de plantillas del fixture es 28/28", () => {
    const used = new Set(posted.map((e) => e.templateCode))
    expect(used.size).toBe(28)
    expect(Object.keys(file.expected.templateCoverage as Record<string, number>).sort()).toEqual([...used].sort())
  })

  it("las liquidaciones de IVA del §4.3 salen del diario", () => {
    const quarters = file.expected.ivaQuarters as { quarter: number; resultadoCents: number }[]
    expect(quarters.map((q) => q.resultadoCents)).toEqual([297180, 225600, -100800, 245490])
  })

  it("un asiento anulado y su contra-asiento SIGUEN los dos en el diario (ADR-0003)", () => {
    const reversal = posted.find((e) => e.kind === "REVERSAL")
    expect(reversal).toBeDefined()
    expect(reversal?.reversesEntryId).toBeTruthy()
    const original = posted.find((e) => e.id === reversal?.reversesEntryId)
    expect(original).toBeDefined()
    // Ninguna consulta de informe los excluye: los dos aparecen y se compensan.
    const report = buildSumasSaldos(lines, accounts, {
      organizationId: loaded.ctx.organizationId,
      from: "2000-01-01",
      to: "2099-12-31",
      baseCurrency: "EUR",
    })
    expect(report.balanceTotals.balanced).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Auditoría de fiabilidad (ronda 1): el fixture es coherente CONSIGO MISMO
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-consistencia de los fixtures (saldos 6/7 incluidos)", () => {
  it.each(["ejercicio-minimo", "ejercicio-completo"] as const)(
    "%s: los saldos declarados salen de sus propias líneas, y la PyG cuadra con la 129",
    (name) => {
      const check = checkFixtureSelfConsistency(name)
      expect(check.mismatches).toEqual([])
      // I3: el resultado de los grupos 6/7 es exactamente el saldo de la 129.
      expect(check.resultadoCents).toBe(check.saldo129Cents)
      expect(check.pnlAccountCount).toBeGreaterThan(0)
    }
  )
})

/** Las líneas de un asiento en la forma que `entryHash` espera (E4-D2 + T2b). */
function hashableOf(e: {
  id: string
  entryNumber: number
  entryDate: string
  kind: string
  lines: readonly Record<string, unknown>[]
}): HashableLine[] {
  return e.lines.map((l) => ({
    entryId: e.id,
    entryNumber: e.entryNumber,
    entryDate: e.entryDate,
    entryKind: e.kind,
    lineNo: l.lineNo,
    accountCode: l.accountCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    fiscalYearId: l.fiscalYearId,
    taxRateId: l.taxRateId ?? null,
    taxBaseCents: l.taxBaseCents ?? null,
    counterpartyId: l.counterpartyId ?? null,
    dueDate: l.dueDate ?? null,
    description: l.description ?? null,
    analyticType: l.analyticType ?? null,
    projectId: l.projectId ?? null,
    costCenterId: l.costCenterId ?? null,
    businessLineId: l.businessLineId ?? null,
    originalCurrency: l.originalCurrency ?? null,
    originalAmountCents: l.originalAmountCents ?? null,
    exchangeRateId: l.exchangeRateId ?? null,
  })) as HashableLine[]
}
