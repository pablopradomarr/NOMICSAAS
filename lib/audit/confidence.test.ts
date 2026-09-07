/**
 * E7 · T6 — El badge `✓ validado contra fuente` (criterio 19): por composición,
 * con la caja excluida, con `explicado` verificable y **retirado en lectura**.
 */

import { describe, expect, it } from "vitest"

import { badgeByBankAccount, badgeForFigure, explainPending } from "@/lib/audit/confidence"
import { reconciliationSummary, type BankInvariantInput, type PendingItem } from "@/lib/audit/invariants-e7"
import type { BankAccountRef, BankLineRef, LedgerCashLineRef } from "@/lib/bank/types"

const ACCOUNT: BankAccountRef = {
  id: "acc-1",
  organizationId: "org-1",
  code: "BBVA",
  accountCode: "5720001",
  currency: "EUR",
  reconciledFromDate: "2026-01-01",
  reconciledOpeningBalanceCents: 0,
  matchToleranceDays: 3,
  transitWarnDays: 90,
}

/** Cuenta conciliada de punta a punta: sin pendientes y con la cadena completa. */
function conciliada(over: Partial<BankInvariantInput> = {}): BankInvariantInput {
  const l1: BankLineRef = {
    id: "bl-1",
    statementId: "st-1",
    bankAccountId: "acc-1",
    lineNo: 1,
    operationDate: "2026-01-05",
    valueDate: "2026-01-05",
    amountCents: -50000,
    currency: "EUR",
    description: "PAGO",
    sha256: "1".padStart(64, "0"),
    status: "MATCHED",
  }
  const c1: LedgerCashLineRef = {
    id: "jl-1",
    organizationId: "org-1",
    entryId: "e-1",
    entryNumber: 1,
    entryDate: "2026-01-05",
    entryKind: "NORMAL",
    fiscalYearId: "fy-2026",
    lineNo: 1,
    accountCode: "5720001",
    debitCents: 0,
    creditCents: 50000,
  }
  return {
    organizationId: "org-1",
    cutoff: "2026-01-31",
    baseCurrency: "EUR",
    accounts: [ACCOUNT],
    statements: [
      {
        id: "st-1",
        bankAccountId: "acc-1",
        fileSha256: "f".repeat(64),
        currency: "EUR",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        openingBalanceCents: 0,
        closingBalanceCents: -50000,
        declaredLineCount: 1,
        lineCount: 1,
      },
    ],
    lines: [l1],
    cashLines: [c1],
    groups: [
      {
        id: "g-1",
        organizationId: "org-1",
        bankAccountId: "acc-1",
        kind: "SIMPLE",
        unmatchedAt: null,
        members: [{ statementLineId: "bl-1", journalLineId: "jl-1", dateGapDays: 0 }],
      },
    ],
    ...over,
  }
}

const summariesOf = (input: BankInvariantInput) => input.accounts.map((a) => reconciliationSummary(a, input))

const pending = (over: Partial<PendingItem> = {}): PendingItem => ({
  side: "BANCO",
  id: "bl-9",
  date: "2026-01-28",
  amountCents: -10000,
  kind: "MOVIMIENTO_BANCO_SIN_ASIENTO",
  ageDays: 3,
  description: "COMISION",
  ...over,
})

describe("explainPending · el criterio verificable de O-17", () => {
  const opts = { transitWarnDays: 90, resolvedLaterIds: new Set<string>() }

  it("lo recoge un movimiento posterior ya conciliado ⇒ explicado", () => {
    const result = explainPending(pending(), { ...opts, resolvedLaterIds: new Set(["bl-9"]) })
    expect(result.explicado).toBe(true)
    expect(result.motivo).toContain("posterior ya conciliado")
  })

  it("tipado y más joven que el plazo declarado ⇒ explicado", () => {
    expect(explainPending(pending({ kind: "CHEQUE_EMITIDO_NO_CARGADO", ageDays: 10 }), opts).explicado).toBe(true)
  })

  it("tipado pero **más viejo** que el plazo ⇒ sin explicar", () => {
    const result = explainPending(pending({ kind: "CHEQUE_EMITIDO_NO_CARGADO", ageDays: 120 }), opts)
    expect(result.explicado).toBe(false)
    expect(result.motivo).toContain("por encima del plazo")
  })

  it("**sin tipar ⇒ sin explicar**: enumerar no es explicar (anti-patrón spec §5)", () => {
    const result = explainPending(pending({ kind: null, ageDays: 1 }), opts)
    expect(result.explicado).toBe(false)
    expect(result.motivo).toContain("sin tipar")
  })
})

describe("badgeForFigure · por composición (O-16)", () => {
  it("una 572 íntegramente conciliada y sin caja ⇒ `validado`", () => {
    const input = conciliada()
    const result = badgeForFigure({
      accountCodes: ["5720001"],
      bankAccounts: [ACCOUNT],
      summaries: summariesOf(input),
      invariantsPass: true,
    })
    expect(result.badge).toBe("validado")
    expect(result.motivos).toEqual([])
  })

  it("**con caja en la composición, nunca**: la caja no tiene extracto", () => {
    const input = conciliada()
    const result = badgeForFigure({
      accountCodes: ["5720001", "5700000"],
      bankAccounts: [ACCOUNT],
      summaries: summariesOf(input),
      invariantsPass: true,
    })
    expect(result.badge).toBe("comprobado")
    expect(result.cuentasSinFuente).toEqual(["5700000"])
    expect(result.motivos.join(" ")).toContain("caja")
  })

  it("sin anclaje, el badge no se concede (criterio 10)", () => {
    const input = conciliada({ accounts: [{ ...ACCOUNT, reconciledFromDate: null }] })
    const result = badgeForFigure({
      accountCodes: ["5720001"],
      bankAccounts: input.accounts,
      summaries: summariesOf(input),
      invariantsPass: true,
    })
    expect(result.badge).toBe("comprobado")
    expect(result.motivos.join(" ")).toContain("anclaje")
  })

  it("un pendiente **sin explicar** retira el badge", () => {
    const input = conciliada()
    const suelta: BankLineRef = { ...(input.lines[0] as BankLineRef), id: "bl-2", lineNo: 2, amountCents: -1, status: "UNMATCHED" }
    const conPendiente = { ...input, lines: [...input.lines, suelta] }
    const result = badgeForFigure({
      accountCodes: ["5720001"],
      bankAccounts: [{ ...ACCOUNT, transitWarnDays: 0 }],
      summaries: summariesOf(conPendiente),
      invariantsPass: true,
    })
    expect(result.badge).toBe("comprobado")
    expect(result.pendientesSinExplicar).toHaveLength(1)
  })

  it("**retirada retroactiva**: un movimiento de diciembre importado en febrero descuadra y el badge se cae", () => {
    const input = conciliada()
    const retroactiva: BankLineRef = {
      ...(input.lines[0] as BankLineRef),
      id: "bl-retro",
      lineNo: 2,
      operationDate: "2026-01-15",
      amountCents: -700,
      status: "UNMATCHED",
    }
    const despues = { ...input, lines: [...input.lines, retroactiva] }
    expect(
      badgeForFigure({
        accountCodes: ["5720001"],
        bankAccounts: [ACCOUNT],
        summaries: summariesOf(despues),
        invariantsPass: true,
      }).badge
    ).toBe("comprobado")
  })

  it("si los invariantes del diario no pasan, la cifra es sólo `calculado`", () => {
    const input = conciliada()
    expect(
      badgeForFigure({
        accountCodes: ["5720001"],
        bankAccounts: [ACCOUNT],
        summaries: summariesOf(input),
        invariantsPass: false,
      }).badge
    ).toBe("calculado")
  })

  it("una cuenta 57x sin `BankAccount` declarada no se valida contra nada", () => {
    const input = conciliada()
    const result = badgeForFigure({
      accountCodes: ["5720001", "5730009"],
      bankAccounts: [ACCOUNT],
      summaries: summariesOf(input),
      invariantsPass: true,
    })
    expect(result.badge).toBe("comprobado")
    expect(result.cuentasNoValidadas).toEqual(["5730009"])
  })
})

describe("badgeByBankAccount · el detalle por cuenta sí lo lleva", () => {
  it("la organización con caja ve el badge en la cuenta bancaria, no en el total", () => {
    const input = conciliada()
    const rows = badgeByBankAccount({ bankAccounts: [ACCOUNT], summaries: summariesOf(input), invariantsPass: true })
    expect(rows).toEqual([
      { accountCode: "5720001", badge: "validado", diferenciaCents: 0, ignoradosCents: 0, cutoff: "2026-01-31" },
    ])
  })
})
