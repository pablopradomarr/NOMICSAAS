/**
 * E7 · T12/T13 — Modelos de vista de la pestaña Auditoría.
 *
 * Todo lo que cruza de un Server Component a un Client Component va por aquí:
 * objetos planos y serializables, con los importes en **céntimos enteros** y
 * las fechas como `"YYYY-MM-DD"` (o ISO cuando son de auditoría). El cliente no
 * calcula ni una cifra contable: el semáforo, los recuentos, los Δ y el cuadre
 * llegan ya resueltos del motor puro por medio de los `models/`.
 */

import type { CheckFamily, CheckStatus, FamilyStatus, HeadlineMetric } from "@/lib/audit/types"
import type { CheckStatusValue } from "@/components/ui/check-status"
import type { SealView } from "@/components/ui/seal-badge"

export type { CheckFamily, CheckStatus, FamilyStatus, HeadlineMetric, SealView }

/** Un check tal como lo pinta la pantalla, con su evidencia literal. */
export type CheckView = {
  id: string
  family: CheckFamily
  status: CheckStatusValue
  evidencia: string
  /** La consulta que reproduce el hallazgo. Se enseña literal, no se ejecuta. */
  query?: string | null
  /** Asientos nombrados en la evidencia, ya resueltos en servidor (drill-down). */
  registros: readonly OriginRecordView[]
}

/** Un registro de origen: el asiento y, si lo tiene, su documento. */
export type OriginRecordView = {
  entryId: string
  entryNumber: number
  entryDate: string
  description: string
  fileId: string | null
}

export type FamilyCardView = {
  family: CheckFamily
  label: string
  status: FamilyStatus
  counts: { PASS: number; FAIL: number; WARN: number; INFO: number; total: number }
  checks: readonly CheckView[]
}

/** Los cinco hashes del sello, abreviados en pantalla y completos en el título. */
export type HashesView = {
  ledgerHash: string
  analyticsKey: string
  planHash: string
  accountMapHash: string
  configHash: string
  gitSha: string
}

export type HeadlineView = { metric: HeadlineMetric; label: string; cents: number }

export type RunSummaryView = {
  id: string | null
  seal: SealView
  scopeKind: string
  fiscalYearCode: string | null
  periodStart: string | null
  periodEnd: string | null
  refDate: string
  trigger: string
  durationMs: number
  createdAt: string | null
  hashes: HashesView
  headline: readonly HeadlineView[]
  counts: { PASS: number; FAIL: number; WARN: number; INFO: number; total: number }
  /** Bloques que NO se evaluaron, con el motivo: la honestidad del semáforo. */
  skipped: readonly { block: string; reason: string }[]
  unknownCheckIds: readonly string[]
}

export type RunHistoryRow = {
  id: string
  createdAt: string
  scopeKind: string
  trigger: string
  seal: "VALIDADO_AUTOMATICAMENTE" | "REQUIERE_REVISION"
  refDate: string
  counts: { PASS: number; FAIL: number; WARN: number; INFO: number; total: number }
  ledgerHashShort: string
  gitShaShort: string
}

/** §Cuadres de cierre: la vista curada, en lenguaje de cierre y no por id. */
export type ClosingBlockView = {
  key: string
  title: string
  legal: string
  checks: readonly CheckView[]
}

export type DataQualityRow = {
  code: string
  count: number
  message: string
  /** Dónde se resuelve. `null` cuando no hay pantalla que lo resuelva. */
  href: string | null
  hrefLabel: string
}

export type StaleAllocationRow = {
  id: string
  periodLabel: string
  runAt: string
  reason: string
}

export type SweepView = {
  id: string
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED"
  filesTotal: number
  filesOk: number
  filesMissing: number
  filesAltered: number
  bytesRead: number
  findings: readonly { kind: string; fileId: string; path: string; expected: string | null; actual: string | null }[]
  findingsOverflow: number
  startedAt: string
  finishedAt: string | null
}

/** Abrevia un hash para pantalla; el valor completo va en el `title`. */
export const short = (value: string | null | undefined, length = 12): string =>
  !value ? "—" : value.length <= length ? value : value.slice(0, length)

export const FAMILY_HELP: Readonly<Record<CheckFamily, string>> = {
  PARTIDA_DOBLE: "Σdebe = Σhaber en cada asiento, numeración y sello de fila.",
  ESTADOS: "Balance, resultado y los cuatro cuadres de cierre del libro.",
  ANALITICA: "La matriz analítica cuadra con la cuenta de pérdidas y ganancias.",
  LIQUIDACION: "Reparto de centros de coste y su sello de líneas.",
  DOCUMENTAL: "Cada asiento se sostiene en un documento y en sus bytes.",
  CONCILIACION: "El extracto del banco contra el diario, cuenta a cuenta.",
  INTEGRIDAD: "Trazabilidad, aislamiento entre organizaciones y reproducibilidad.",
}

export const SCOPE_LABEL: Readonly<Record<string, string>> = {
  ORGANIZATION: "Toda la organización",
  FISCAL_YEAR: "Ejercicio",
  PERIOD: "Periodo",
}

export const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  MANUAL: "Manual",
  SCHEDULED: "Programado",
  POST_CLOSE: "Tras el cierre",
  POST_IMPORT: "Tras una importación",
}

export const HEADLINE_LABEL: Readonly<Record<HeadlineMetric, string>> = {
  ACTIVO: "Activo",
  PN_MAS_PASIVO: "Patrimonio neto + pasivo",
  RESULTADO: "Resultado del ejercicio",
  TESORERIA: "Tesorería",
}

export const FAMILY_STATUS_LABEL: Readonly<Record<FamilyStatus, string>> = {
  OK: "Comprobado",
  AVISO: "Con avisos",
  FALLO: "Con fallos",
  SIN_EVALUAR: "Sin evaluar",
}
