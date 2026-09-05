/**
 * E3 · T7 — Tipos comunes de los tres informes derivados del diario.
 *
 * Los informes reciben las líneas **ya leídas** (`models/ledger.ts` hace el
 * SQL) y son funciones puras `f(lines, accounts, params) → Report`. No hay
 * cifras "de informe" almacenadas: ADR-0003, P2.
 */

import type { Cents, EntryKind, LocalDate, SourceType, TaxRoundingMode } from "@/lib/ledger/types"
import type { Provenance, ProvenanceContext } from "@/lib/ledger/provenance"

export type { Provenance, ProvenanceContext }

/** Línea del diario tal y como la ven los informes. */
export type ReportLine = {
  id?: string
  entryId: string
  entryNumber: number
  entryDate: LocalDate
  entryKind: EntryKind
  fiscalYearId: string
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  dueDate?: LocalDate | null
}

/** Cabecera del asiento, para el libro diario. */
export type ReportEntry = {
  id: string
  entryNumber: number
  entryDate: LocalDate
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  description: string
  kind: EntryKind
  sourceType: SourceType
  sourceId?: string | null
  templateCode?: string | null
  taxRoundingMode?: TaxRoundingMode
  reversesEntryId?: string | null
  voidedAt?: string | null
}

/** Cuenta del plan, con lo que los informes necesitan de ella. */
export type ReportAccount = {
  code: string
  name: string
  level?: number
  isContra?: boolean
}

export type ReportPeriod = {
  organizationId: string
  from: LocalDate
  to: LocalDate
  baseCurrency: string
}

/** Fila de cuadre común a los tres informes. */
export type BalanceCheck = {
  totalDebitCents: Cents
  totalCreditCents: Cents
  differenceCents: Cents
  balanced: boolean
}

export const balanceCheck = (debit: Cents, credit: Cents): BalanceCheck => ({
  totalDebitCents: debit,
  totalCreditCents: credit,
  differenceCents: debit - credit,
  balanced: debit === credit,
})

/** Filtra al periodo. `entryDate` es la ÚNICA fecha que manda en un informe. */
export const inPeriod = (line: { entryDate: LocalDate }, period: { from: LocalDate; to: LocalDate }): boolean =>
  line.entryDate >= period.from && line.entryDate <= period.to

/** Orden de presentación del diario: `(entryDate, entryNumber, lineNo)` (N-5). */
export function compareLines(a: ReportLine, b: ReportLine): number {
  return (
    (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
    a.entryNumber - b.entryNumber ||
    a.lineNo - b.lineNo
  )
}
