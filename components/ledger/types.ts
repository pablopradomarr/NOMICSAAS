/**
 * E3 · T11/T12 — Modelos de vista del libro diario.
 *
 * Todo lo que cruza de un Server Component a un Client Component va por aquí:
 * objetos planos, serializables, con los importes en **céntimos enteros** y las
 * fechas como `"YYYY-MM-DD"`. El cliente NO recalcula ninguna cifra contable;
 * lo único que suma es la diferencia en vivo del editor, y va marcada como
 * vista previa (`ui-erp` §Formularios).
 */

import type { CheckRow } from "@/components/ui/check-status"
import type { SealView } from "@/components/ui/seal-badge"
import type { Provenance } from "@/lib/ledger/provenance"

export type { CheckRow, Provenance, SealView }

export type LineView = {
  id?: string
  lineNo: number
  accountCode: string
  accountName: string
  debitCents: number
  creditCents: number
  description?: string | null
  dueDate?: string | null
  /** E4 — destino analítico persistido en la línea (§7). */
  analyticType?: string | null
  projectId?: string | null
  costCenterId?: string | null
  /** Código de la dimensión de destino, ya resuelto en el servidor. */
  destinationCode?: string | null
  destinationName?: string | null
  /** `true` en las líneas de grupo 6/7, las únicas que llevan destino (R-A1). */
  isPnlLine?: boolean
}

export type EntryView = {
  id: string
  entryNumber: number
  entryDate: string
  documentDate?: string | null
  accrualDate?: string | null
  description: string
  kind: string
  sourceType: string
  sourceId?: string | null
  templateCode?: string | null
  taxRoundingMode?: string | null
  reversesEntryId?: string | null
  /** Número del asiento que ESTE anula, para el badge de contra-asiento. */
  reversesEntryNumber?: number | null
  voidedAt?: string | null
  voidReason?: string | null
  /** Asiento que anula a éste (el contra-asiento), si existe. */
  reversedByEntryId?: string | null
  reversedByEntryNumber?: number | null
  entryHash?: string | null
  postedByName?: string | null
  postedAt?: string | null
  transactionId?: string | null
  fileId?: string | null
  fiscalYearCode?: string | null
  lines: LineView[]
  totalDebitCents: number
  totalCreditCents: number
  balanced: boolean
}

/** Cuenta postable, tal y como la consume el autocompletado. */
export type AccountOption = {
  code: string
  name: string
}

export type FiscalYearView = {
  id: string
  code: string
  startDate: string
  endDate: string
  status: "OPEN" | "CLOSED"
  lastEntryNumber: number
  entryCount?: number
  closedAt?: string | null
  lockedMonths: number[]
}

/** Cabecera común de los informes derivados del diario (`ui-erp` §Tablas). */
export type ReportHeaderView = {
  from: string
  to: string
  baseCurrency: string
  runId: string
  ledgerHash: string
  gitSha: string
  seal: SealView
  checks: CheckRow[]
}

export const ENTRY_KIND_LABELS: Record<string, string> = {
  NORMAL: "Normal",
  OPENING: "Apertura",
  CLOSING: "Cierre",
  REGULARIZATION: "Regularización",
  REVERSAL: "Contra-asiento",
  RECURRING: "Recurrente",
}

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  DOCUMENT: "Documento",
  INVOICE_OUT: "Factura emitida",
  BANK_IMPORT: "Importación bancaria",
  CSV_IMPORT: "Importación CSV",
  RECURRING: "Recurrente",
  SYSTEM: "Sistema",
}

/** `sha256:ab12…` → `ab12cd34` para la cabecera; nunca se enseña entero. */
export function shortHash(hash: string | null | undefined, length = 12): string {
  if (!hash) return "—"
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash
  return bare.slice(0, length)
}
