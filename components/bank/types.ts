/**
 * E7 · T16 — Modelos de vista de la conciliación bancaria.
 *
 * Objetos planos y serializables: importes en **céntimos enteros**, fechas como
 * `"YYYY-MM-DD"`. El navegador no calcula ni un cuadre: `E`, `B`, `Ue`, `Ub`, la
 * diferencia, los pendientes tipados y su antigüedad llegan resueltos de
 * `reconciliationSummary()`, que es la MISMA derivación que usa I-E7-1 (no hay
 * una segunda). Lo único que el cliente suma es la **Σ de la selección** de las
 * dos columnas, y va marcada como vista previa.
 */

import type { FigureConfidence } from "@/lib/audit/confidence"
import type { IgnoreReason, MatchGroupKind, PendingKind } from "@/lib/bank/types"

export type { FigureConfidence, IgnoreReason, MatchGroupKind, PendingKind }

export type BankAccountView = {
  id: string
  code: string
  name: string
  accountCode: string
  currency: string
  iban: string | null
  isActive: boolean
  matchToleranceDays: number
  transitWarnDays: number
  anchorDate: string | null
  anchorBalanceCents: number | null
  hasCsvMapping: boolean
}

export type PendingView = {
  side: "BANCO" | "LIBROS"
  id: string
  date: string
  amountCents: number
  kind: PendingKind | null
  ageDays: number
  description: string
  /** Del criterio verificable de §3.6: enumerar no es explicar. */
  explicado: boolean
  motivo: string
}

export type SummaryView = {
  bankAccountId: string
  accountCode: string
  currency: string
  cutoff: string
  anchored: boolean
  chainCovered: boolean
  chainGaps: readonly { from: string; to: string }[]
  saldoExtractoCents: number | null
  saldoContableCents: number
  ueCents: number
  ubCents: number
  diferenciaCents: number | null
  pendientesBanco: readonly PendingView[]
  pendientesLibros: readonly PendingView[]
  ignoradosCents: number
  ignoradosCount: number
  importeCeroCount: number
  pendientesAntiguosCount: number
  regularizationLineIds: readonly string[]
  evaluable: boolean
  motivoNoEvaluable: string | null
  badge: FigureConfidence
  /** Diferencia de cambio pendiente de reconocer, cuando la cuenta es en divisa. */
  diferenciaDeCambioCents: number | null
}

export type StatementLineView = {
  id: string
  lineNo: number
  operationDate: string
  valueDate: string
  amountCents: number
  currency: string
  description: string
  reference1: string | null
  reference2: string | null
  counterpartyName: string | null
  status: "UNMATCHED" | "MATCHED" | "IGNORED"
  ignoreReason: IgnoreReason | null
  sha256: string
  /** `null` si la línea no está en ningún grupo vivo. */
  groupId: string | null
}

export type JournalCashLineView = {
  id: string
  entryId: string
  entryNumber: number
  entryDate: string
  entryKind: string
  lineNo: number
  accountCode: string
  /** `debe − haber`: con signo, como el importe del extracto. */
  signedCents: number
  description: string
  groupId: string | null
}

export type SuggestionView = {
  statementLineId: string
  ambiguous: boolean
  candidates: readonly {
    journalLineIds: readonly string[]
    scoreBps: number
    kind: MatchGroupKind
    reasons: readonly string[]
  }[]
}

export type MatchGroupView = {
  id: string
  kind: MatchGroupKind
  statementLineIds: readonly string[]
  journalLineIds: readonly string[]
  sumCents: number
}

export type StatementView = {
  id: string
  fileName: string
  periodStart: string
  periodEnd: string
  lineCount: number
  declaredLineCount: number | null
  openingBalanceCents: number
  closingBalanceCents: number
}

export const PENDING_KIND_LABEL: Readonly<Record<string, string>> = {
  CHEQUE_EMITIDO_NO_CARGADO: "Cheque emitido y no cargado",
  REMESA_NO_ABONADA: "Remesa no abonada",
  TRASPASO_ENTRE_CUENTAS_EN_CAMINO: "Traspaso entre cuentas en camino",
  MOVIMIENTO_BANCO_SIN_ASIENTO: "Movimiento del banco sin asiento",
  APUNTE_SIN_MOVIMIENTO: "Apunte sin movimiento en el banco",
  EFECTO_EN_GESTION_DE_COBRO: "Efecto en gestión de cobro (fuera del cuadre)",
}

export const IGNORE_REASON_LABEL: Readonly<Record<IgnoreReason, string>> = {
  ERROR_BANCO_REVERSADO: "Error del banco, ya reversado",
  NO_ES_NUESTRA_CUENTA: "No es nuestra cuenta",
  YA_CONTABILIZADO_EN_OTRA_CUENTA: "Ya contabilizado en otra cuenta",
  IMPORTE_CERO: "Importe cero",
}

export const MATCH_REASON_LABEL: Readonly<Record<string, string>> = {
  IMPORTE_EXACTO: "importe exacto",
  MISMA_FECHA_OPERACION: "misma fecha de operación",
  FECHA_EN_TOLERANCIA: "fecha dentro de la tolerancia",
  FECHA_VALOR: "casa por fecha valor",
  REFERENCIA_1: "misma referencia de remesa",
  REFERENCIA_2: "misma referencia secundaria",
  CONTRAPARTE: "misma contraparte",
}

export const GROUP_KIND_LABEL: Readonly<Record<MatchGroupKind, string>> = {
  SIMPLE: "1 a 1",
  N_A_1: "N a 1 (remesa)",
  UNO_A_N: "1 a N (devolución parcial)",
  N_A_N: "N a M",
}

/** Las seis claves del mapa que puede usar una propuesta desde el extracto. */
export const PROPOSAL_ACCOUNT_LABEL: Readonly<Record<string, string>> = {
  COMISIONES_BANCARIAS: "Comisiones bancarias (626)",
  INTERESES_DEUDAS: "Intereses de deudas (662)",
  OTROS_GASTOS_FINANCIEROS: "Otros gastos financieros (669)",
  INTERESES_DESCUENTO_EFECTOS: "Intereses por descuento de efectos (665)",
  DIFERENCIA_CAMBIO_NEGATIVA: "Diferencia de cambio negativa (668)",
  DIFERENCIA_CAMBIO_POSITIVA: "Diferencia de cambio positiva (768)",
}
