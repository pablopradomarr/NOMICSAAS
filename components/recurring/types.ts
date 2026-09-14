import type { AccrualSummary } from "@/app/(app)/ledger/recurring/actions"
import type { AccrualRow as AccrualScheduleRow } from "@/lib/closing/accrual"
import type { RecurringOccurrenceRow } from "@/models/recurring"

/**
 * E9 · T17 — Tipos que la pantalla de recurrentes comparte entre sus piezas.
 *
 * No hay ni una cifra derivada aquí: todo llega ya calculado de las server
 * actions de `app/(app)/ledger/recurring/actions.ts` (C1). Este fichero sólo
 * pone nombre a lo que viaja del Server Component al Client Component.
 */

/** Estado de una celda del calendario de 12 columnas × N reglas (§7). */
export type CellStatus = "GENERADA" | "OMITIDA" | "FALLIDA" | "PENDIENTE" | "NO_VENCIDO" | "FUERA_DE_VIGENCIA"

export type CalendarCell = {
  period: string
  status: CellStatus
  reason: string | null
  entryId: string | null
  occurrenceId: string | null
}

export const CELL_LABEL: Record<CellStatus, string> = {
  GENERADA: "generada",
  OMITIDA: "omitida",
  FALLIDA: "fallida",
  PENDIENTE: "pendiente",
  NO_VENCIDO: "no vencido",
  FUERA_DE_VIGENCIA: "fuera de vigencia",
}

/** Glifo de la celda. Sin rojo/verde semáforo: la marca es negro, gris y ámbar. */
export const CELL_GLYPH: Record<CellStatus, string> = {
  GENERADA: "●",
  OMITIDA: "○",
  FALLIDA: "⚠",
  PENDIENTE: "·",
  NO_VENCIDO: "",
  FUERA_DE_VIGENCIA: "",
}

export const CELL_CLASS: Record<CellStatus, string> = {
  GENERADA: "bg-[#0A0A0A] text-white",
  OMITIDA: "border border-dashed border-muted-foreground/60 text-muted-foreground",
  FALLIDA: "border border-[#F5A623] bg-[#F5A623]/15 text-[#1A202C]",
  PENDIENTE: "bg-muted text-muted-foreground",
  NO_VENCIDO: "text-muted-foreground/40",
  FUERA_DE_VIGENCIA: "text-muted-foreground/30",
}

export type OccurrenceRow = RecurringOccurrenceRow

/** Periodificación con su cuadro ya derivado en el servidor (§7, O-25). */
export type AccrualView = AccrualSummary & { rows: AccrualScheduleRow[] }
