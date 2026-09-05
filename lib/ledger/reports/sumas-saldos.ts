/**
 * E3 · T7 — Balance de sumas y saldos. Función pura.
 *
 * Sumas debe/haber y saldo deudor/acreedor por cuenta, con jerarquía por
 * prefijo (grupo → subgrupo → cuenta) y fila de cuadre `Σdeudor − Σacreedor = 0`.
 */

import { cellProvenance } from "@/lib/ledger/provenance"
import type { Cents } from "@/lib/ledger/types"
import {
  balanceCheck,
  BalanceCheck,
  inPeriod,
  Provenance,
  ProvenanceContext,
  ReportAccount,
  ReportLine,
  ReportPeriod,
} from "@/lib/ledger/reports/types"

export type SumasSaldosRow = {
  accountCode: string
  accountName: string
  /** 1 = grupo, 2 = subgrupo, 3 = cuenta de tres dígitos, 0 = hoja real. */
  level: number
  isAggregate: boolean
  sumDebitCents: Cents
  sumCreditCents: Cents
  /** Saldo con signo: `Σdebe − Σhaber`. */
  balanceCents: Cents
  /** Presentación en dos columnas: solo una de las dos es > 0. */
  debitBalanceCents: Cents
  creditBalanceCents: Cents
  provenance?: Provenance
}

export type SumasSaldosReport = {
  period: ReportPeriod
  rows: SumasSaldosRow[]
  /** Solo las cuentas con movimiento, sin las filas de agregación. */
  leaves: SumasSaldosRow[]
  totals: BalanceCheck
  /** Fila de cuadre: Σ saldos deudores − Σ saldos acreedores = 0. */
  balanceTotals: BalanceCheck
}

export type SumasSaldosParams = ReportPeriod & {
  /** Niveles de agregación por prefijo. Por defecto grupo, subgrupo y cuenta. */
  hierarchyLevels?: readonly number[]
  accountCodes?: readonly string[]
}

export function buildSumasSaldos(
  lines: readonly ReportLine[],
  accounts: readonly ReportAccount[],
  params: SumasSaldosParams,
  provenanceCtx?: ProvenanceContext
): SumasSaldosReport {
  const names = new Map(accounts.map((a) => [a.code, a.name]))
  const wanted = params.accountCodes ? new Set(params.accountCodes) : null
  const period: ReportPeriod = {
    organizationId: params.organizationId,
    from: params.from,
    to: params.to,
    baseCurrency: params.baseCurrency,
  }

  const acc = new Map<string, { debit: Cents; credit: Cents }>()
  for (const line of lines) {
    if (!inPeriod(line, params)) continue
    if (wanted && !wanted.has(line.accountCode)) continue
    const cur = acc.get(line.accountCode) ?? { debit: 0, credit: 0 }
    cur.debit += line.debitCents
    cur.credit += line.creditCents
    acc.set(line.accountCode, cur)
  }

  const makeRow = (code: string, sums: { debit: Cents; credit: Cents }, level: number, isAggregate: boolean) => {
    const balanceCents = sums.debit - sums.credit
    const row: SumasSaldosRow = {
      accountCode: code,
      accountName: names.get(code) ?? code,
      level,
      isAggregate,
      sumDebitCents: sums.debit,
      sumCreditCents: sums.credit,
      balanceCents,
      debitBalanceCents: balanceCents > 0 ? balanceCents : 0,
      creditBalanceCents: balanceCents < 0 ? -balanceCents : 0,
    }
    if (provenanceCtx && !isAggregate) {
      row.provenance = cellProvenance(
        `sumas_saldos.saldo.${code}`,
        balanceCents,
        { organizationId: params.organizationId, from: params.from, to: params.to, accountCode: code },
        provenanceCtx
      )
    }
    return row
  }

  const leaves = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, sums]) => makeRow(code, sums, 0, false))

  // Agregación jerárquica por prefijo (1, 2 y 3 dígitos por defecto).
  const levels = params.hierarchyLevels ?? [1, 2, 3]
  const aggregates = new Map<string, { debit: Cents; credit: Cents; level: number }>()
  for (const leaf of leaves) {
    for (const n of levels) {
      if (leaf.accountCode.length <= n) continue
      const prefix = leaf.accountCode.slice(0, n)
      const cur = aggregates.get(prefix) ?? { debit: 0, credit: 0, level: n }
      cur.debit += leaf.sumDebitCents
      cur.credit += leaf.sumCreditCents
      aggregates.set(prefix, cur)
    }
  }

  const rows = [
    ...leaves,
    ...[...aggregates.entries()].map(([code, sums]) => makeRow(code, sums, sums.level, true)),
  ].sort((a, b) =>
    a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : a.isAggregate ? -1 : 1
  )

  const totalDebit = leaves.reduce((a, r) => a + r.sumDebitCents, 0)
  const totalCredit = leaves.reduce((a, r) => a + r.sumCreditCents, 0)
  const totalDebitBalance = leaves.reduce((a, r) => a + r.debitBalanceCents, 0)
  const totalCreditBalance = leaves.reduce((a, r) => a + r.creditBalanceCents, 0)

  return {
    period,
    rows,
    leaves,
    totals: balanceCheck(totalDebit, totalCredit),
    balanceTotals: balanceCheck(totalDebitBalance, totalCreditBalance),
  }
}
