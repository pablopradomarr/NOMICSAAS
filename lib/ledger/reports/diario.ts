/**
 * E3 · T7 — Libro diario. Función pura sobre las líneas del periodo.
 *
 * Presentación ordenada por `(entryDate, entryNumber)` (N-5): un asiento con
 * fecha retroactiva NO se renumera, se coloca en su sitio al presentarlo.
 *
 * NINGUNA consulta filtra por `voidedAt` (I-E3-3): el asiento anulado y su
 * contra-asiento aparecen los dos y se compensan por importe.
 */

import { cellProvenance } from "@/lib/ledger/provenance"
import type { Cents } from "@/lib/ledger/types"
import {
  balanceCheck,
  BalanceCheck,
  compareLines,
  inPeriod,
  Provenance,
  ProvenanceContext,
  ReportAccount,
  ReportEntry,
  ReportLine,
  ReportPeriod,
} from "@/lib/ledger/reports/types"

export type DiarioLine = ReportLine & { accountName: string }

export type DiarioEntry = ReportEntry & {
  lines: DiarioLine[]
  totalDebitCents: Cents
  totalCreditCents: Cents
  /** I1 por asiento: en un diario bien formado siempre `true`. */
  balanced: boolean
}

export type DiarioReport = {
  period: ReportPeriod
  entries: DiarioEntry[]
  entryCount: number
  lineCount: number
  totals: BalanceCheck
  provenance?: { totalDebit: Provenance; totalCredit: Provenance }
}

export function buildDiario(
  entries: readonly ReportEntry[],
  lines: readonly ReportLine[],
  accounts: readonly ReportAccount[],
  period: ReportPeriod,
  provenanceCtx?: ProvenanceContext
): DiarioReport {
  const names = new Map(accounts.map((a) => [a.code, a.name]))
  const scoped = lines.filter((l) => inPeriod(l, period)).sort(compareLines)

  const byEntry = new Map<string, DiarioLine[]>()
  for (const line of scoped) {
    const list = byEntry.get(line.entryId)
    const decorated: DiarioLine = { ...line, accountName: names.get(line.accountCode) ?? line.accountCode }
    if (list) list.push(decorated)
    else byEntry.set(line.entryId, [decorated])
  }

  const out: DiarioEntry[] = []
  for (const entry of entries) {
    const entryLines = byEntry.get(entry.id)
    if (!entryLines || entryLines.length === 0) continue
    const totalDebitCents = entryLines.reduce((a, l) => a + l.debitCents, 0)
    const totalCreditCents = entryLines.reduce((a, l) => a + l.creditCents, 0)
    out.push({
      ...entry,
      lines: entryLines,
      totalDebitCents,
      totalCreditCents,
      balanced: totalDebitCents === totalCreditCents,
    })
  }
  out.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) || a.entryNumber - b.entryNumber)

  const totalDebit = scoped.reduce((a, l) => a + l.debitCents, 0)
  const totalCredit = scoped.reduce((a, l) => a + l.creditCents, 0)

  const report: DiarioReport = {
    period,
    entries: out,
    entryCount: out.length,
    lineCount: scoped.length,
    totals: balanceCheck(totalDebit, totalCredit),
  }

  if (provenanceCtx) {
    const params = { organizationId: period.organizationId, from: period.from, to: period.to }
    report.provenance = {
      totalDebit: cellProvenance("diario.total.debe", totalDebit, params, provenanceCtx),
      totalCredit: cellProvenance("diario.total.haber", totalCredit, params, provenanceCtx),
    }
  }
  return report
}
