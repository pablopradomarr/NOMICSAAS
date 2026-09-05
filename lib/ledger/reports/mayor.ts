/**
 * E3 · T7 — Libro mayor. Función pura.
 *
 * Por cuenta: saldo inicial (Σ de todo lo anterior a `from`), movimientos del
 * periodo con saldo acumulado, y saldo final. Convención de signo del proyecto:
 * `saldo = Σdebe − Σhaber` (negativo = acreedor).
 */

import { cellProvenance } from "@/lib/ledger/provenance"
import type { Cents } from "@/lib/ledger/types"
import {
  balanceCheck,
  BalanceCheck,
  compareLines,
  Provenance,
  ProvenanceContext,
  ReportAccount,
  ReportLine,
  ReportPeriod,
} from "@/lib/ledger/reports/types"

export type MayorMovement = ReportLine & {
  /** Saldo acumulado tras aplicar esta línea. */
  runningBalanceCents: Cents
}

export type MayorAccount = {
  accountCode: string
  accountName: string
  openingBalanceCents: Cents
  movements: MayorMovement[]
  totalDebitCents: Cents
  totalCreditCents: Cents
  closingBalanceCents: Cents
  provenance?: Provenance
}

export type MayorReport = {
  period: ReportPeriod
  accounts: MayorAccount[]
  totals: BalanceCheck
  /** Σ de los saldos finales: debe ser 0 en un diario cuadrado. */
  closingBalanceSumCents: Cents
}

export type MayorParams = ReportPeriod & {
  /** Si se indica, solo estas cuentas; si no, todas las que tengan movimiento. */
  accountCodes?: readonly string[]
}

export function buildMayor(
  lines: readonly ReportLine[],
  accounts: readonly ReportAccount[],
  params: MayorParams,
  provenanceCtx?: ProvenanceContext
): MayorReport {
  const names = new Map(accounts.map((a) => [a.code, a.name]))
  const wanted = params.accountCodes ? new Set(params.accountCodes) : null

  const opening = new Map<string, Cents>()
  const period = new Map<string, ReportLine[]>()

  for (const line of lines) {
    if (wanted && !wanted.has(line.accountCode)) continue
    if (line.entryDate < params.from) {
      opening.set(line.accountCode, (opening.get(line.accountCode) ?? 0) + line.debitCents - line.creditCents)
      continue
    }
    if (line.entryDate > params.to) continue
    const list = period.get(line.accountCode)
    if (list) list.push(line)
    else period.set(line.accountCode, [line])
  }

  const codes = new Set<string>([...opening.keys(), ...period.keys()])
  const out: MayorAccount[] = []

  for (const code of [...codes].sort()) {
    const openingBalanceCents = opening.get(code) ?? 0
    const movements0 = (period.get(code) ?? []).slice().sort(compareLines)
    let running = openingBalanceCents
    const movements: MayorMovement[] = movements0.map((l) => {
      running += l.debitCents - l.creditCents
      return { ...l, runningBalanceCents: running }
    })
    const totalDebitCents = movements.reduce((a, l) => a + l.debitCents, 0)
    const totalCreditCents = movements.reduce((a, l) => a + l.creditCents, 0)
    const account: MayorAccount = {
      accountCode: code,
      accountName: names.get(code) ?? code,
      openingBalanceCents,
      movements,
      totalDebitCents,
      totalCreditCents,
      closingBalanceCents: running,
    }
    if (provenanceCtx) {
      account.provenance = cellProvenance(
        `mayor.saldo.${code}`,
        running,
        {
          organizationId: params.organizationId,
          from: params.from,
          to: params.to,
          accountCode: code,
          // #10: si el informe se acota a un ejercicio, la provenance también.
          ...(params.fiscalYearId ? { fiscalYearId: params.fiscalYearId } : {}),
        },
        provenanceCtx
      )
    }
    out.push(account)
  }

  const totalDebit = out.reduce((a, x) => a + x.totalDebitCents, 0)
  const totalCredit = out.reduce((a, x) => a + x.totalCreditCents, 0)

  return {
    period: { organizationId: params.organizationId, from: params.from, to: params.to, baseCurrency: params.baseCurrency },
    accounts: out,
    totals: balanceCheck(totalDebit, totalCredit),
    closingBalanceSumCents: out.reduce((a, x) => a + x.closingBalanceCents, 0),
  }
}

/** Saldos por cuenta al final del periodo: entrada de T-23 y del bloque C. */
export function accountBalances(
  lines: readonly ReportLine[],
  params: { from?: string; to: string; kinds?: readonly string[] }
): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const line of lines) {
    if (params.from && line.entryDate < params.from) continue
    if (line.entryDate > params.to) continue
    if (params.kinds && !params.kinds.includes(line.entryKind)) continue
    out.set(line.accountCode, (out.get(line.accountCode) ?? 0) + line.debitCents - line.creditCents)
  }
  return out
}
