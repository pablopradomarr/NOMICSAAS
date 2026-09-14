/**
 * E9 · T16 — Modelos de vista del asistente de cierre.
 *
 * Todo lo que cruza de la página (Server Component) a los componentes de
 * cliente pasa por aquí: objetos planos y serializables, importes en
 * **céntimos enteros** y fechas como `"YYYY-MM-DD"`. El cliente **no calcula ni
 * una cifra contable**: el semáforo de cada paso, la evidencia, el cuadre de la
 * vista previa, el capital social y la reserva legal llegan resueltos del
 * servidor con su provenance (`ui-erp` §Tablas, CLAUDE.md §Estándar de calidad).
 */

import type { SealView } from "@/components/ui/seal-badge"

export type { SealView }

/**
 * El estado de un paso. Los cuatro primeros son los de `CheckStatus`; `NA` y
 * `PENDIENTE_RECOMPUTO` son propios del cierre: un acto societario que todavía
 * no toca, y un ajuste que la reapertura dejó a reevaluar (O-21).
 */
export type ClosingStepStatus = "PASS" | "FAIL" | "WARN" | "INFO" | "NA" | "PENDIENTE_RECOMPUTO"

export type ClosingStepNature = "DERIVADO" | "DECLARADO" | "POSTERIOR"

/** Un asiento ya resuelto en servidor, para el drill-down en un clic. */
export type EntryRefView = {
  id: string
  entryNumber: number | null
  entryDate: string | null
  description: string | null
}

export type ClosingStepView = {
  step: string
  block: string
  titulo: string
  norma: string | null
  nature: ClosingStepNature
  blocking: boolean
  status: ClosingStepStatus
  /** Lo que el motor vio. Se enseña literal: es la evidencia del paso. */
  evidencia: string
  /** `registros_origen`: la consulta que reproduce el hallazgo. No se ejecuta. */
  query: string | null
  /** Asiento que este paso ha posteado, si lo ha hecho. */
  entry: EntryRefView | null
  answer: { status: string; note: string | null } | null
  /** Plantilla que postea, cuando el asistente lo postea uno a uno (O-17). */
  templateCode: string | null
  orden: number | null
}

export type ClosingBlockView = {
  block: string
  label: string
  steps: readonly ClosingStepView[]
  counts: { PASS: number; FAIL: number; WARN: number; INFO: number; NA: number; PENDIENTE_RECOMPUTO: number }
}

/** Uno de los doce asientos de O-17, con su hueco o con su asiento. */
export type ClosingEntryView = {
  orden: number
  paso: string
  templateCode: string | null
  porQue: string
  entries: readonly EntryRefView[]
}

export type ClosingRunView = {
  id: string
  status: "BORRADOR" | "COMPROBADO" | "CERRADO" | "REABIERTO" | "ABORTADO"
  refDate: string
  seal: SealView
  hashes: { ledgerHash: string; planHash: string; accountMapHash: string; configHash: string; gitSha: string }
  durationMs: number
  createdAt: string
  closedAt: string | null
  reopenedAt: string | null
  reopenReason: string | null
  reopenEntryIds: readonly string[]
}

export type FiscalYearView = {
  id: string
  code: string
  startDate: string
  endDate: string
  status: "OPEN" | "CLOSED"
  accountsApprovalStatus: "BORRADOR" | "FORMULADAS" | "APROBADAS" | "DEPOSITADAS"
  taxFilingStatus: "NO_PRESENTADO" | "PRESENTADO" | "RECTIFICADO"
  closedAt: string | null
}

/** La distribución ya acordada, si la hay: sin ella `129` se arrastra (O-18). */
export type DistributionRowView = {
  id: string
  meetingDate: string
  resultCents: number
  legalReserveCents: number
  voluntaryReserveCents: number
  carryForwardCents: number
  dividendCents: number
  entry: EntryRefView | null
}

export type ClosingPageView = {
  fiscalYears: readonly FiscalYearView[]
  fiscalYear: FiscalYearView
  run: ClosingRunView | null
  blocks: readonly ClosingBlockView[]
  blockers: readonly ClosingStepView[]
  entries: readonly ClosingEntryView[]
  distribution: DistributionRowView | null
  totals: { steps: number; blocking: number; pass: number }
}

export const STEP_STATUS_LABEL: Readonly<Record<ClosingStepStatus, string>> = {
  PASS: "✓ PASS",
  FAIL: "✗ FAIL",
  WARN: "⚠ WARN",
  INFO: "· INFO",
  NA: "— NO PROCEDE",
  PENDIENTE_RECOMPUTO: "↻ PENDIENTE DE RECOMPUTAR",
}

export const NATURE_LABEL: Readonly<Record<ClosingStepNature, string>> = {
  DERIVADO: "Derivado del diario",
  DECLARADO: "Declarado por una persona",
  POSTERIOR: "Acto posterior al cierre",
}

export const APPROVAL_LABEL: Readonly<Record<FiscalYearView["accountsApprovalStatus"], string>> = {
  BORRADOR: "Cuentas en borrador",
  FORMULADAS: "Cuentas formuladas (art. 253 LSC)",
  APROBADAS: "Cuentas aprobadas por la junta (art. 164 LSC)",
  DEPOSITADAS: "Cuentas depositadas (art. 279 LSC)",
}

export const TAX_FILING_LABEL: Readonly<Record<FiscalYearView["taxFilingStatus"], string>> = {
  NO_PRESENTADO: "Modelo 200 sin presentar",
  PRESENTADO: "Modelo 200 presentado",
  RECTIFICADO: "Modelo 200 rectificado",
}

export const RUN_STATUS_LABEL: Readonly<Record<ClosingRunView["status"], string>> = {
  BORRADOR: "Borrador: quedan pasos bloqueantes",
  COMPROBADO: "Comprobado: los nueve bloqueantes en PASS",
  CERRADO: "Cerrado",
  REABIERTO: "Reabierto",
  ABORTADO: "Abortado",
}

/** Abrevia un hash; el valor completo va en el `title`. */
export const short = (value: string | null | undefined, length = 12): string =>
  !value ? "—" : value.length <= length ? value : value.slice(0, length)
