/**
 * E7 · T6 — I-E7-1…17 sobre **los 21 fixtures adversariales de §5.1**.
 *
 * Cada bloque nombra el caso que la validación contable pidió. El fixture base
 * es el de la ronda 2: una cuenta anclada, con la cadena completa, un cheque
 * emitido y no cargado y un movimiento del banco sin asiento — el caso que **la
 * fórmula de la ronda 1 daba en FAIL sin error contable alguno**.
 */

import { describe, expect, it } from "vitest"

import {
  chainCoverage,
  checkIE71,
  checkIE710,
  checkIE711,
  checkIE712,
  checkIE713,
  checkIE714,
  checkIE715,
  checkIE716,
  checkIE717,
  checkIE72,
  checkIE73,
  checkIE75,
  checkIE76a,
  checkIE76b,
  checkIE77,
  checkIE78,
  checkIE79,
  E7_INVARIANT_IDS,
  reconciliationSummary,
  runAuditInvariants,
  statementBalanceAt,
  type BankInvariantInput,
  type ClosingInvariantInput,
} from "@/lib/audit/invariants-e7"
import { checksHashOf } from "@/lib/audit/run"
import type { CheckResult, CheckStatus } from "@/lib/audit/types"
import type {
  BankAccountRef,
  BankLineRef,
  BankMatchGroupRef,
  BankStatementRef,
  LedgerCashLineRef,
} from "@/lib/bank/types"
import type { ReportLine } from "@/lib/ledger/reports/types"

// ─────────────────────────────────────────────────────────────────────────────
// Fábricas
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "org-1"

const account = (over: Partial<BankAccountRef> = {}): BankAccountRef => ({
  id: "acc-1",
  organizationId: ORG,
  code: "BBVA-CORRIENTE",
  accountCode: "5720001",
  currency: "EUR",
  reconciledFromDate: "2026-01-01",
  reconciledOpeningBalanceCents: 0,
  matchToleranceDays: 3,
  transitWarnDays: 90,
  ...over,
})

const statement = (over: Partial<BankStatementRef> = {}): BankStatementRef => ({
  id: "st-1",
  bankAccountId: "acc-1",
  fileSha256: "f".repeat(64),
  currency: "EUR",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  openingBalanceCents: 0,
  closingBalanceCents: -30000,
  declaredLineCount: 3,
  lineCount: 3,
  ...over,
})

let sequence = 0
const line = (over: Partial<BankLineRef> = {}): BankLineRef => {
  sequence += 1
  return {
    id: `bl-${sequence}`,
    statementId: "st-1",
    bankAccountId: "acc-1",
    lineNo: sequence,
    operationDate: "2026-01-05",
    valueDate: "2026-01-05",
    amountCents: -50000,
    currency: "EUR",
    description: "MOVIMIENTO",
    sha256: `${sequence}`.padStart(64, "0"),
    status: "UNMATCHED",
    ...over,
  }
}

const cash = (over: Partial<LedgerCashLineRef> = {}): LedgerCashLineRef => {
  sequence += 1
  return {
    id: `jl-${sequence}`,
    organizationId: ORG,
    entryId: `e-${sequence}`,
    entryNumber: sequence,
    entryDate: "2026-01-05",
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "5720001",
    debitCents: 0,
    creditCents: 50000,
    description: "APUNTE",
    ...over,
  }
}

const group = (members: { statementLineId: string; journalLineId: string }[], over: Partial<BankMatchGroupRef> = {}): BankMatchGroupRef => ({
  id: "g-1",
  organizationId: ORG,
  bankAccountId: "acc-1",
  kind: members.length === 1 ? "SIMPLE" : "N_A_1",
  unmatchedAt: null,
  members: members.map((m) => ({ ...m, dateGapDays: 0 })),
  ...over,
})

/**
 * **El fixture base.** E = −300,00 · B = −400,00 · Ue = −100,00 · Ub = −200,00
 * ⇒ `E − B = 100,00 = Ue − Ub`. Con la fórmula de la ronda 1 salía FAIL.
 */
function baseInput(): BankInvariantInput {
  sequence = 0
  const l1 = line({ id: "bl-1", lineNo: 1, operationDate: "2026-01-05", amountCents: -50000, status: "MATCHED" })
  const l2 = line({ id: "bl-2", lineNo: 2, operationDate: "2026-01-20", amountCents: 30000, status: "MATCHED" })
  const l3 = line({
    id: "bl-3",
    lineNo: 3,
    operationDate: "2026-01-28",
    amountCents: -10000,
    description: "COMISION MANTENIMIENTO",
  })
  const c1 = cash({ id: "jl-1", entryDate: "2026-01-05", debitCents: 0, creditCents: 50000 })
  const c2 = cash({ id: "jl-2", entryDate: "2026-01-20", debitCents: 30000, creditCents: 0 })
  const c3 = cash({
    id: "jl-3",
    entryDate: "2026-01-30",
    debitCents: 0,
    creditCents: 20000,
    pendingKind: "CHEQUE_EMITIDO_NO_CARGADO",
    description: "CHEQUE 0001 A PROVEEDOR",
  })
  return {
    organizationId: ORG,
    cutoff: "2026-01-31",
    baseCurrency: "EUR",
    accounts: [account()],
    statements: [statement()],
    lines: [l1, l2, l3],
    groups: [
      group([{ statementLineId: "bl-1", journalLineId: "jl-1" }], { id: "g-1" }),
      group([{ statementLineId: "bl-2", journalLineId: "jl-2" }], { id: "g-2" }),
    ],
    cashLines: [c1, c2, c3],
  }
}

const statusOf = (result: CheckResult): CheckStatus => result.status

// ─────────────────────────────────────────────────────────────────────────────

describe("I-E7-1 · la identidad E − B = Ue − Ub (criterios 9 y 11)", () => {
  it("cuenta anclada, cadena completa y cheque en tránsito ⇒ PASS con el pendiente tipado", () => {
    const input = baseInput()
    const summary = reconciliationSummary(input.accounts[0] as BankAccountRef, input)
    expect(summary.saldoExtracto).toBe(-30000)
    expect(summary.saldoContable).toBe(-40000)
    expect(summary.ue).toBe(-10000)
    expect(summary.ub).toBe(-20000)
    expect(summary.diferencia).toBe(0)
    expect(summary.pendientesLibros[0]?.kind).toBe("CHEQUE_EMITIDO_NO_CARGADO")
    expect(statusOf(checkIE71(input))).toBe("PASS")
  })

  it("**alterar un céntimo por SQL** en un apunte CONCILIADO lo delata (criterio 9)", () => {
    const input = baseInput()
    const tocada = [...input.cashLines]
    tocada[0] = { ...(tocada[0] as LedgerCashLineRef), creditCents: 50001 }
    const result = checkIE71({ ...input, cashLines: tocada })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("0,01 €")
  })

  it("alterar el saldo inicial que declara el banco también lo delata", () => {
    // Dentro del extracto, `E` es el saldo inicial DECLARADO más los movimientos
    // hasta el corte; que el saldo final declarado cuadre con ellos lo comprueba
    // I-E7-6a, que es su sitio.
    const input = baseInput()
    const result = checkIE71({ ...input, statements: [statement({ openingBalanceCents: -1 })] })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("0,01 €")
  })

  it("un apunte NO conciliado alterado mueve los dos lados por igual: lo coge I-E7-2/11, no el cuadre", () => {
    // La identidad es ciega a un pendiente alterado —cambia `B` y `Ub` en lo
    // mismo— y decirlo aquí es más honesto que fingir que lo detecta: quien lo
    // detecta es el sello de fila (I-E3-7) y la igualdad del grupo.
    const input = baseInput()
    const tocada = [...input.cashLines]
    tocada[2] = { ...(tocada[2] as LedgerCashLineRef), creditCents: 20001 }
    expect(checkIE71({ ...input, cashLines: tocada }).status).toBe("PASS")
  })

  it("**sin anclaje sale INFO, jamás PASS** (criterio 10)", () => {
    const input = baseInput()
    const result = checkIE71({ ...input, accounts: [account({ reconciledFromDate: null })] })
    expect(result.status).toBe("INFO")
    expect(result.evidencia).toContain("anclaje")
  })

  it("con hueco en la cadena, I-E7-1 sale INFO y I-E7-6b FAIL (criterio 10)", () => {
    const input = baseInput()
    const conHueco: BankInvariantInput = {
      ...input,
      accounts: [account({ reconciledFromDate: "2025-11-01" })],
    }
    expect(checkIE71(conHueco).status).toBe("INFO")
    expect(checkIE76b(conHueco).status).toBe("FAIL")
    expect(checkIE76b(conHueco).evidencia).toContain("hueco")
  })

  it("**`OPENING` cuenta y `CLOSING` no** (criterio 11)", () => {
    const input = baseInput()
    const apertura = cash({ id: "jl-open", entryDate: "2026-01-01", entryKind: "OPENING", debitCents: 70000, creditCents: 0 })
    const cierre = cash({ id: "jl-close", entryDate: "2026-01-31", entryKind: "CLOSING", debitCents: 0, creditCents: 99999 })
    const conApertura = reconciliationSummary(input.accounts[0] as BankAccountRef, {
      ...input,
      cashLines: [...input.cashLines, apertura],
    })
    expect(conApertura.saldoContable).toBe(-40000 + 70000)
    const conCierre = reconciliationSummary(input.accounts[0] as BankAccountRef, {
      ...input,
      cashLines: [...input.cashLines, cierre],
    })
    expect(conCierre.saldoContable).toBe(-40000)
  })

  it("una REGULARIZACIÓN sobre la 57x se **delata**, no se absorbe", () => {
    const input = baseInput()
    const regular = cash({ id: "jl-reg", entryKind: "REGULARIZATION", entryDate: "2026-01-31", debitCents: 500, creditCents: 0 })
    const result = checkIE71({ ...input, cashLines: [...input.cashLines, regular] })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("REGULARIZACIÓN")
  })

  it("**extracto vacío**: sin cuentas no hay cuadre que afirmar (INFO, no PASS)", () => {
    const vacío: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [],
      statements: [],
      lines: [],
      groups: [],
      cashLines: [],
    }
    expect(checkIE71(vacío).status).toBe("INFO")
    expect(checkIE75(vacío).status).toBe("INFO")
    expect(checkIE76a(vacío).status).toBe("INFO")
  })

  it("**un solo movimiento**, conciliado, cuadra", () => {
    sequence = 100
    const input: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [account()],
      statements: [statement({ closingBalanceCents: -50000, declaredLineCount: 1, lineCount: 1 })],
      lines: [line({ id: "bl-1", lineNo: 1, amountCents: -50000, status: "MATCHED" })],
      cashLines: [cash({ id: "jl-1" })],
      groups: [group([{ statementLineId: "bl-1", journalLineId: "jl-1" }])],
    }
    expect(checkIE71(input).status).toBe("PASS")
    expect(checkIE76a(input).status).toBe("PASS")
  })

  it("**importes negativos y saldo final negativo** (descubierto) cuadran igual", () => {
    const input = baseInput()
    const summary = reconciliationSummary(input.accounts[0] as BankAccountRef, input)
    expect(summary.saldoExtracto).toBeLessThan(0)
    expect(summary.saldoContable).toBeLessThan(0)
    expect(summary.diferencia).toBe(0)
  })

  it("los pendientes se **envejecen**: pasado `transitWarnDays` se declaran", () => {
    const input = baseInput()
    const summary = reconciliationSummary(account({ transitWarnDays: 0 }), input)
    expect(summary.pendientesAntiguos.map((p) => p.id).sort()).toEqual(["bl-3", "jl-3"])
    expect(reconciliationSummary(account(), input).pendientesAntiguos).toEqual([])
  })

  it("un efecto en gestión de cobro **no entra en el cuadre**: vive en 4312", () => {
    const input = baseInput()
    const efecto = cash({
      id: "jl-efecto",
      entryDate: "2026-01-25",
      debitCents: 15000,
      creditCents: 0,
      pendingKind: "EFECTO_EN_GESTION_DE_COBRO",
    })
    const summary = reconciliationSummary(input.accounts[0] as BankAccountRef, {
      ...input,
      cashLines: [...input.cashLines, efecto],
    })
    expect(summary.ub).toBe(-20000)
  })
})

describe("statementBalanceAt · el saldo lo declara el banco", () => {
  it("dentro del extracto: saldo inicial declarado + movimientos hasta el corte", () => {
    const input = baseInput()
    expect(statementBalanceAt(input.statements, input.lines, "2026-01-20")?.cents).toBe(-20000)
  })

  it("después del último extracto: su saldo final declarado", () => {
    const input = baseInput()
    expect(statementBalanceAt(input.statements, input.lines, "2026-02-15")?.cents).toBe(-30000)
  })

  it("sin extracto que lo declare, `null`: no se reconstruye un saldo inventado", () => {
    expect(statementBalanceAt([], [], "2026-01-31")).toBeNull()
  })
})

describe("I-E7-2 · igualdad de importe con signo (criterio 13, O-9)", () => {
  it("una conciliación correcta pasa y describe el signo", () => {
    expect(checkIE72(baseInput()).status).toBe("PASS")
  })

  it("**100,00 € contra 1.000,00 € se rechaza** — la ronda 1 lo dejaba pasar", () => {
    const input = baseInput()
    const cashLines = [...input.cashLines]
    cashLines[0] = { ...(cashLines[0] as LedgerCashLineRef), creditCents: 500000 }
    const result = checkIE72({ ...input, cashLines })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("tolerancia 0")
  })

  it("**signo invertido**: un cargo del banco contra un debe de la 57x", () => {
    const input = baseInput()
    const cashLines = [...input.cashLines]
    cashLines[0] = { ...(cashLines[0] as LedgerCashLineRef), debitCents: 50000, creditCents: 0 }
    const result = checkIE72({ ...input, cashLines })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("cargo")
  })

  it("una cuenta que no es 572–575 no es conciliable", () => {
    const input = baseInput()
    const cashLines = [...input.cashLines]
    cashLines[0] = { ...(cashLines[0] as LedgerCashLineRef), accountCode: "5700001" }
    expect(checkIE72({ ...input, cashLines }).status).toBe("FAIL")
  })

  it("la tolerancia de FECHAS no forma parte del invariante (O-10)", () => {
    const input = baseInput()
    const cashLines = [...input.cashLines]
    cashLines[0] = { ...(cashLines[0] as LedgerCashLineRef), entryDate: "2025-06-01" }
    expect(checkIE72({ ...input, cashLines }).status).toBe("PASS")
  })
})

describe("I-E7-3 · nada pertenece a dos grupos vivos", () => {
  it("pasa con un grupo por línea", () => {
    expect(checkIE73(baseInput()).status).toBe("PASS")
  })

  it("falla si dos grupos vivos reclaman el mismo apunte", () => {
    const input = baseInput()
    const duplicado = group([{ statementLineId: "bl-3", journalLineId: "jl-1" }], { id: "g-3" })
    const result = checkIE73({ ...input, groups: [...input.groups, duplicado] })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("jl-1")
  })

  it("un grupo desconciliado no cuenta: no está vivo", () => {
    const input = baseInput()
    const muerto = group([{ statementLineId: "bl-3", journalLineId: "jl-1" }], {
      id: "g-3",
      unmatchedAt: "2026-02-01T10:00:00Z",
    })
    expect(checkIE73({ ...input, groups: [...input.groups, muerto] }).status).toBe("PASS")
  })
})

describe("I-E7-5 · integridad de lo importado", () => {
  it("pasa con fichero único, sha256 único y lineNo correlativo", () => {
    expect(checkIE75(baseInput()).status).toBe("PASS")
  })

  it("**extracto solapado reimportado**: el mismo fichero dos veces se delata", () => {
    const input = baseInput()
    const otra = statement({ id: "st-2", periodStart: "2026-01-15", periodEnd: "2026-02-15" })
    const result = checkIE75({ ...input, statements: [...input.statements, otra] })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("importado 2 veces")
  })

  it("un hueco en `lineNo` se delata (lo que pasaría si se rechazara el 0,00 €)", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = { ...(lines[2] as BankLineRef), lineNo: 4 }
    expect(checkIE75({ ...input, lines }).status).toBe("FAIL")
  })

  it("dos líneas con el mismo sha256 en la misma cuenta se delatan", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = { ...(lines[2] as BankLineRef), sha256: (lines[1] as BankLineRef).sha256 }
    expect(checkIE75({ ...input, lines }).status).toBe("FAIL")
  })
})

describe("I-E7-6a/6b · el extracto consigo mismo y la cadena", () => {
  it("opening + Σ = closing y `lineCount` = registro 33", () => {
    expect(checkIE76a(baseInput()).status).toBe("PASS")
  })

  it("un céntimo de más en el extracto lo delata", () => {
    const input = baseInput()
    const result = checkIE76a({ ...input, statements: [statement({ closingBalanceCents: -30001 })] })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("saldo final declarado")
  })

  it("si el banco declara 4 apuntes y hay 3, es FAIL (registro 33)", () => {
    const input = baseInput()
    expect(checkIE76a({ ...input, statements: [statement({ declaredLineCount: 4 })] }).status).toBe("FAIL")
  })

  it("sin saldos declarados sale INFO, nunca PASS", () => {
    const input = baseInput()
    const sinSaldos = statement({ openingBalanceCents: null, closingBalanceCents: null })
    expect(checkIE76a({ ...input, statements: [sinSaldos] }).status).toBe("INFO")
  })

  it("**hueco en la cadena** entre dos extractos ⇒ FAIL", () => {
    const input = baseInput()
    const segundo = statement({
      id: "st-2",
      fileSha256: "a".repeat(64),
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      closingBalanceCents: -30000,
      declaredLineCount: 0,
      lineCount: 0,
    })
    const result = checkIE76b({ ...input, statements: [...input.statements, segundo], cutoff: "2026-03-31" })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("2026-02-01…2026-03-01")
  })

  it("un solape que declara dos saldos distintos al mismo cierre es contradictorio", () => {
    const input = baseInput()
    const gemelo = statement({ id: "st-2", fileSha256: "a".repeat(64), closingBalanceCents: -31000 })
    const chain = chainCoverage(account(), [...input.statements, gemelo], "2026-01-31")
    expect(chain.contradictoryOverlaps).toHaveLength(1)
    expect(chain.covered).toBe(false)
  })

  it("una cadena continua cubre el corte", () => {
    const input = baseInput()
    const febrero = statement({
      id: "st-2",
      fileSha256: "a".repeat(64),
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      openingBalanceCents: -30000,
      closingBalanceCents: -30000,
      declaredLineCount: 0,
      lineCount: 0,
    })
    expect(checkIE76b({ ...input, statements: [...input.statements, febrero], cutoff: "2026-02-28" }).status).toBe("PASS")
  })
})

describe("I-E7-7 · **`checks` alterados por SQL** (criterio 18)", () => {
  const checks: CheckResult[] = [
    { id: "I1", status: "PASS", evidencia: "84 asientos cuadrados" },
    { id: "I2", status: "PASS", evidencia: "activo = pn + pasivo" },
  ]

  it("un run íntegro pasa", () => {
    expect(checkIE77([{ id: "run-1", checksHash: checksHashOf(checks), checks }]).status).toBe("PASS")
  })

  it("editar la evidencia sin tocar el estado **también** lo delata, nombrando el run", () => {
    const alterados: CheckResult[] = [{ ...(checks[0] as CheckResult), evidencia: "todo bien" }, checks[1] as CheckResult]
    const result = checkIE77([{ id: "run-1", checksHash: checksHashOf(checks), checks: alterados }])
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("run-1")
  })

  it("sin runs anteriores sale INFO", () => {
    expect(checkIE77([]).status).toBe("INFO")
  })
})

describe("I-E7-8 · cobertura del almacén (criterio 6)", () => {
  const files = [
    { id: "f1", ingestedAt: "2026-01-01T00:00:00Z" },
    { id: "f2", ingestedAt: "2026-01-02T00:00:00Z" },
  ]

  it("PASS sólo tras un barrido DONE posterior al último fichero ingerido", () => {
    const result = checkIE78({
      files,
      lastSweep: { id: "s1", status: "DONE", finishedAt: "2026-01-03T00:00:00Z", sweptFileIds: ["f1", "f2"] },
    })
    expect(result.status).toBe("PASS")
  })

  it("sin barrido terminado, INFO", () => {
    expect(checkIE78({ files, lastSweep: null }).status).toBe("INFO")
    expect(
      checkIE78({ files, lastSweep: { id: "s1", status: "RUNNING", finishedAt: null, sweptFileIds: [] } }).status
    ).toBe("INFO")
  })

  it("un fichero ingerido después del barrido pide rebarrer (WARN)", () => {
    const result = checkIE78({
      files,
      lastSweep: { id: "s1", status: "DONE", finishedAt: "2026-01-01T12:00:00Z", sweptFileIds: ["f1"] },
    })
    expect(result.status).toBe("WARN")
  })

  it("un fichero sin veredicto es FAIL", () => {
    const result = checkIE78({
      files,
      lastSweep: { id: "s1", status: "DONE", finishedAt: "2026-01-03T00:00:00Z", sweptFileIds: ["f1"] },
    })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("f2")
  })
})

describe("I-E7-9 / I-E7-10 · **`AllocationRun` sin `linesHash`** y líneas alteradas", () => {
  const run = {
    id: "ar-1",
    status: "SEALED",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    sealedAt: "2026-09-01T00:00:00Z",
    linesHash: null,
  }

  it("los anteriores a la migración salen WARN enumerados con periodo y fecha", () => {
    const result = checkIE79([run])
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("2026-01-01…2026-01-31")
  })

  it("uno sellado DESPUÉS sin `linesHash` es FAIL", () => {
    expect(checkIE79([{ ...run, sealedAt: "2026-09-20T00:00:00Z" }]).status).toBe("FAIL")
  })

  it("todos con sello pasan", () => {
    expect(checkIE79([{ ...run, linesHash: "a".repeat(64) }]).status).toBe("PASS")
  })

  it("I-E7-10 delata líneas alteradas bajo un informe vigente", () => {
    const sellado = { ...run, linesHash: "a".repeat(64), linesHashExpected: "b".repeat(64) }
    const report = {
      id: "rr-1",
      reportType: "PYG_ANALITICA",
      allocationRunSetHash: "8b8f5d1e79c14ab0d1a2b8f24bb0e6b0a2a4f6f0f37b0f7d9a2f2b7f8e0a1c3d",
      allocationRunIds: ["ar-1"],
    }
    const result = checkIE710([report], [sellado])
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("han cambiado")
  })

  it("sin `linesHash` recomputado, INFO: no se afirma lo que no se ha mirado", () => {
    const report = { id: "rr-1", reportType: "PYG_ANALITICA", allocationRunSetHash: "x", allocationRunIds: ["ar-1"] }
    const result = checkIE710([report], [{ ...run, linesHash: "a".repeat(64) }])
    expect(result.status).toBe("FAIL") // el setHash tampoco cuadra
    expect(result.evidencia).toContain("allocationRunSetHash")
  })
})

describe("I-E7-11 · el grupo cuadra (criterio 12)", () => {
  it("**remesa de 14 recibos contra un abono**", () => {
    sequence = 200
    const abono = line({ id: "bl-rem", lineNo: 1, operationDate: "2026-01-20", amountCents: 842000, status: "MATCHED" })
    const recibos = Array.from({ length: 14 }, (_, i) =>
      cash({
        id: `jl-rec-${i + 1}`,
        entryDate: "2026-01-20",
        debitCents: i === 13 ? 62000 : 60000,
        creditCents: 0,
        reference: "REM000000001",
      })
    )
    const input: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [account()],
      statements: [statement({ closingBalanceCents: 842000, declaredLineCount: 1, lineCount: 1 })],
      lines: [abono],
      cashLines: recibos,
      groups: [
        group(
          recibos.map((r) => ({ statementLineId: "bl-rem", journalLineId: r.id })),
          { kind: "N_A_1" }
        ),
      ],
    }
    expect(checkIE711(input).status).toBe("PASS")
    expect(checkIE71(input).status).toBe("PASS")
    expect(checkIE72(input).status).toBe("PASS")
  })

  it("**descuento de efectos**: el grupo cuadra contra el ABONO NETO (nominal − 665 − 626)", () => {
    sequence = 300
    // El asiento lleva 4311, 665 y 626; lo ÚNICO conciliable es la línea de 572.
    const neto = line({ id: "bl-desc", lineNo: 1, operationDate: "2026-01-15", amountCents: 480000, status: "MATCHED" })
    const cash572 = cash({ id: "jl-572", entryDate: "2026-01-15", debitCents: 480000, creditCents: 0 })
    const input: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [account()],
      statements: [statement({ closingBalanceCents: 480000, declaredLineCount: 1, lineCount: 1 })],
      lines: [neto],
      cashLines: [cash572],
      groups: [group([{ statementLineId: "bl-desc", journalLineId: "jl-572" }])],
    }
    expect(checkIE711(input).status).toBe("PASS")
    expect(checkIE71(input).status).toBe("PASS")
  })

  it("**devolución parcial 1-a-N**: una línea contra dos apuntes", () => {
    sequence = 400
    const cargo = line({ id: "bl-dev", lineNo: 1, operationDate: "2026-01-10", amountCents: -30000, status: "MATCHED" })
    const c1 = cash({ id: "jl-d1", entryDate: "2026-01-10", debitCents: 0, creditCents: 20000 })
    const c2 = cash({ id: "jl-d2", entryDate: "2026-01-11", debitCents: 0, creditCents: 10000 })
    const input: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [account()],
      statements: [statement({ closingBalanceCents: -30000, declaredLineCount: 1, lineCount: 1 })],
      lines: [cargo],
      cashLines: [c1, c2],
      groups: [
        group(
          [
            { statementLineId: "bl-dev", journalLineId: "jl-d1" },
            { statementLineId: "bl-dev", journalLineId: "jl-d2" },
          ],
          { kind: "UNO_A_N" }
        ),
      ],
    }
    expect(checkIE711(input).status).toBe("PASS")
    expect(checkIE71(input).status).toBe("PASS")
  })

  it("un grupo descuadrado por un céntimo es FAIL con tolerancia 0", () => {
    sequence = 500
    const cargo = line({ id: "bl-x", lineNo: 1, amountCents: -30000, status: "MATCHED" })
    const c1 = cash({ id: "jl-x1", debitCents: 0, creditCents: 20000 })
    const c2 = cash({ id: "jl-x2", debitCents: 0, creditCents: 10001 })
    const input: BankInvariantInput = {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [account()],
      statements: [statement({ closingBalanceCents: -30000, declaredLineCount: 1, lineCount: 1 })],
      lines: [cargo],
      cashLines: [c1, c2],
      groups: [
        group(
          [
            { statementLineId: "bl-x", journalLineId: "jl-x1" },
            { statementLineId: "bl-x", journalLineId: "jl-x2" },
          ],
          { kind: "UNO_A_N" }
        ),
      ],
    }
    const result = checkIE711(input)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("0,01 €")
  })
})

describe("I-E7-12 · **cuenta en USD** (criterio 20)", () => {
  function usdInput(over: Partial<BankInvariantInput> = {}): BankInvariantInput {
    sequence = 600
    const acc = account({ id: "acc-usd", accountCode: "5730001", currency: "USD" })
    const l1 = line({
      id: "bl-usd",
      lineNo: 1,
      bankAccountId: "acc-usd",
      statementId: "st-usd",
      amountCents: 100000,
      currency: "USD",
      status: "MATCHED",
    })
    const c1 = cash({ id: "jl-usd", accountCode: "5730001", debitCents: 100000, creditCents: 0 })
    return {
      organizationId: ORG,
      cutoff: "2026-01-31",
      baseCurrency: "EUR",
      accounts: [acc],
      statements: [
        statement({ id: "st-usd", bankAccountId: "acc-usd", currency: "USD", closingBalanceCents: 100000, declaredLineCount: 1, lineCount: 1 }),
      ],
      lines: [l1],
      cashLines: [c1],
      groups: [group([{ statementLineId: "bl-usd", journalLineId: "jl-usd" }], { bankAccountId: "acc-usd" })],
      ...over,
    }
  }

  it("el cuadre se hace **en la divisa de la cuenta**, con tolerancia 0", () => {
    const input = usdInput()
    expect(checkIE71(input).status).toBe("PASS")
    expect(reconciliationSummary(input.accounts[0] as BankAccountRef, input).currency).toBe("USD")
  })

  it("una línea en otra divisa significa que el cuadre está en la divisa equivocada", () => {
    const input = usdInput()
    const lines = [{ ...(input.lines[0] as BankLineRef), currency: "EUR" }]
    const result = checkIE712({ ...input, lines })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("divisa equivocada")
  })

  it("la diferencia de cambio no reconocida sale **WARN con su importe**, nunca como pendiente", () => {
    const input = usdInput({
      fx: [
        {
          bankAccountId: "acc-usd",
          closingDate: "2026-01-31",
          rateMicro: BigInt(900000), // 1 USD = 0,90 EUR
          baseBalanceCents: 95000, // contravalores históricos
          recognizedDifferenceCents: 0,
        },
      ],
    })
    const result = checkIE712(input)
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("diferencia de cambio")
    expect(result.evidencia).toContain("-50,00 €")
    // Y no se cuela como partida en tránsito.
    expect(reconciliationSummary(input.accounts[0] as BankAccountRef, input).pendientesBanco).toEqual([])
  })

  it("reconocida en 768/668, ya no avisa", () => {
    const input = usdInput({
      fx: [
        {
          bankAccountId: "acc-usd",
          closingDate: "2026-01-31",
          rateMicro: BigInt(900000),
          baseBalanceCents: 95000,
          recognizedDifferenceCents: -5000,
        },
      ],
    })
    expect(checkIE712(input).status).toBe("PASS")
  })

  it("sin cuentas en divisa, INFO", () => {
    expect(checkIE712(baseInput()).status).toBe("INFO")
  })
})

describe("I-E7-13 · **`IGNORED` sin evidencia** y Σ ignorado (criterio 16)", () => {
  it("YA_CONTABILIZADO_EN_OTRA_CUENTA sin evidencia se rechaza", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = { ...(lines[2] as BankLineRef), status: "IGNORED", ignoreReason: "YA_CONTABILIZADO_EN_OTRA_CUENTA" }
    const result = checkIE713({ ...input, lines })
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("sin la evidencia")
  })

  it("con evidencia, pasa y presenta Σ ignorado como línea propia", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = {
      ...(lines[2] as BankLineRef),
      status: "IGNORED",
      ignoreReason: "YA_CONTABILIZADO_EN_OTRA_CUENTA",
      ignoreEvidenceId: "jl-otra",
    }
    const result = checkIE713({ ...input, lines })
    expect(result.status).toBe("PASS")
    expect(result.evidencia).toContain("-100,00 €")
    const summary = reconciliationSummary(input.accounts[0] as BankAccountRef, { ...input, lines })
    expect(summary.ignoradosCents).toBe(-10000)
    // El ignorado sigue dentro de Ue: la identidad no se mueve (O-12).
    expect(summary.diferencia).toBe(0)
  })

  it("por encima del umbral de materialidad, WARN con la lista", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = {
      ...(lines[2] as BankLineRef),
      status: "IGNORED",
      ignoreReason: "NO_ES_NUESTRA_CUENTA",
    }
    const result = checkIE713({ ...input, lines, accounts: [account({ ignoredMaterialityCents: 5000 })] })
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("umbral de materialidad")
  })

  it("**el apunte de 0,00 €** no exige evidencia y **nunca** dispara el WARN (m2)", () => {
    const input = baseInput()
    const cero = line({ id: "bl-0", lineNo: 4, amountCents: 0, status: "IGNORED", ignoreReason: "IMPORTE_CERO" })
    const result = checkIE713({
      ...input,
      lines: [...input.lines, cero],
      accounts: [account({ ignoredMaterialityCents: 0 })],
    })
    expect(result.status).toBe("PASS")
    expect(result.evidencia).toContain("1 de importe cero")
  })

  it("un motivo fuera del vocabulario cerrado se rechaza", () => {
    const input = baseInput()
    const lines = [...input.lines]
    lines[2] = { ...(lines[2] as BankLineRef), status: "IGNORED", ignoreReason: null }
    expect(checkIE713({ ...input, lines }).status).toBe("FAIL")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Los cuadres de cierre (O-18)
// ─────────────────────────────────────────────────────────────────────────────

let reportSequence = 0
const rl = (over: Partial<ReportLine> = {}): ReportLine => {
  reportSequence += 1
  return {
    entryId: `e-${reportSequence}`,
    entryNumber: reportSequence,
    entryDate: "2026-06-30",
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "5720001",
    debitCents: 0,
    creditCents: 0,
    ...over,
  }
}

const closingInput = (lines: ReportLine[], over: Partial<ClosingInvariantInput> = {}): ClosingInvariantInput => ({
  lines,
  fiscalYears: [
    { id: "fy-2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    { id: "fy-2026", startDate: "2026-01-01", endDate: "2026-12-31" },
  ],
  from: "2026-01-01",
  to: "2026-12-31",
  ...over,
})

describe("I-E7-14 · **apertura de N ≠ cierre de N−1** (criterio 25)", () => {
  const cierre2025 = [
    rl({ fiscalYearId: "fy-2025", entryDate: "2025-06-01", accountCode: "5720001", debitCents: 100000 }),
    rl({ fiscalYearId: "fy-2025", entryDate: "2025-06-01", accountCode: "1000000", creditCents: 100000 }),
  ]

  it("una apertura que cuadra cuenta a cuenta pasa", () => {
    const apertura = [
      rl({ fiscalYearId: "fy-2026", entryDate: "2026-01-01", entryKind: "OPENING", accountCode: "5720001", debitCents: 100000 }),
      rl({ fiscalYearId: "fy-2026", entryDate: "2026-01-01", entryKind: "OPENING", accountCode: "1000000", creditCents: 100000 }),
    ]
    expect(checkIE714(closingInput([...cierre2025, ...apertura])).status).toBe("PASS")
  })

  it("un céntimo de diferencia se delata nombrando la cuenta", () => {
    const apertura = [
      rl({ fiscalYearId: "fy-2026", entryDate: "2026-01-01", entryKind: "OPENING", accountCode: "5720001", debitCents: 100001 }),
      rl({ fiscalYearId: "fy-2026", entryDate: "2026-01-01", entryKind: "OPENING", accountCode: "1000000", creditCents: 100001 }),
    ]
    const result = checkIE714(closingInput([...cierre2025, ...apertura]))
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("5720001")
  })

  it("sin asiento de apertura, INFO", () => {
    expect(checkIE714(closingInput(cierre2025)).status).toBe("INFO")
  })
})

describe("I-E7-15 · saldos contrarios a su naturaleza", () => {
  it("marca un **430 acreedor** (criterio 25)", () => {
    const result = checkIE715(closingInput([rl({ accountCode: "4300001", creditCents: 15000 })]))
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("4300001")
    expect(result.evidencia).toContain("acreedor")
  })

  it("marca un 400 deudor y un 473 acreedor", () => {
    const result = checkIE715(
      closingInput([rl({ accountCode: "4000001", debitCents: 5000 }), rl({ accountCode: "4730001", creditCents: 900 })])
    )
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("4000001")
    expect(result.evidencia).toContain("4730001")
  })

  it("una 572 acreedora **con póliza declarada** no es un hallazgo", () => {
    const lines = [rl({ accountCode: "5720001", creditCents: 30000 })]
    expect(checkIE715(closingInput(lines)).status).toBe("WARN")
    expect(checkIE715(closingInput(lines, { accountsWithCreditFacility: ["5720001"] })).status).toBe("PASS")
  })
})

describe("I-E7-16 · **`555` con saldo al cierre** (criterio 25)", () => {
  const lines = [rl({ accountCode: "5550000", debitCents: 12345, entryDate: "2026-12-31" })]

  it("a fecha de cierre es un **hallazgo** (FAIL)", () => {
    const result = checkIE716(closingInput(lines, { isFiscalYearEnd: true }))
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("5550000")
  })

  it("intraperiodo es WARN", () => {
    expect(checkIE716(closingInput(lines)).status).toBe("WARN")
  })

  it("a cero, PASS", () => {
    expect(checkIE716(closingInput([rl({ accountCode: "6000000", debitCents: 100 })])).status).toBe("PASS")
  })
})

describe("I-E7-17 · sumas y saldos **mes a mes** (art. 28.1 CCom)", () => {
  it("cuadra el periodo y cada mes", () => {
    const lines = [
      rl({ entryDate: "2026-01-15", accountCode: "6000000", debitCents: 10000 }),
      rl({ entryDate: "2026-01-15", accountCode: "4000001", creditCents: 10000 }),
      rl({ entryDate: "2026-02-15", accountCode: "5720001", debitCents: 5000 }),
      rl({ entryDate: "2026-02-15", accountCode: "7000000", creditCents: 5000 }),
    ]
    const result = checkIE717(closingInput(lines))
    expect(result.status).toBe("PASS")
    expect(result.evidencia).toContain("2 mes(es)")
  })

  it("dos meses que se compensan entre sí **no** cuadran el libro: falla el mes", () => {
    const lines = [
      rl({ entryDate: "2026-01-15", accountCode: "6000000", debitCents: 10000 }),
      rl({ entryDate: "2026-01-15", accountCode: "4000001", creditCents: 9000 }),
      rl({ entryDate: "2026-02-15", accountCode: "5720001", debitCents: 5000 }),
      rl({ entryDate: "2026-02-15", accountCode: "7000000", creditCents: 6000 }),
    ]
    const result = checkIE717(closingInput(lines))
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("2026-01")
    expect(result.evidencia).toContain("2026-02")
  })

  it("sin líneas en el periodo, INFO", () => {
    expect(checkIE717(closingInput([])).status).toBe("INFO")
  })
})

describe("runAuditInvariants", () => {
  it("los diecisiete ids salen SIEMPRE, y sin datos son INFO (nunca PASS ni FAIL)", () => {
    const checks = runAuditInvariants({})
    expect(checks.map((c) => c.id)).toEqual(E7_INVARIANT_IDS)
    expect(checks.every((c) => c.status === "INFO")).toBe(true)
    expect(checks.every((c) => c.evidencia.startsWith("no evaluado:"))).toBe(true)
  })

  it("con el bloque bancario, los de conciliación se evalúan de verdad", () => {
    const checks = runAuditInvariants({ bank: baseInput() })
    const byId = new Map(checks.map((c) => [c.id, c.status]))
    expect(byId.get("I-E7-1")).toBe("PASS")
    expect(byId.get("I-E7-11")).toBe("PASS")
    expect(byId.get("I-E7-7")).toBe("INFO")
    expect(byId.get("I-E7-14")).toBe("INFO")
  })
})
