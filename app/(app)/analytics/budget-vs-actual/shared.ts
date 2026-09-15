import { COST_CENTER_KIND_LABELS } from "@/components/analytics/types"
import type { AnalyticsConfig } from "@/lib/analytics/types"

/**
 * E10 · T16 — Ayudas de SERVIDOR de `/analytics/budget-vs-actual`.
 *
 * Aquí no se calcula ni un céntimo: sólo se pone nombre en español a las claves
 * de columna de la matriz (`PROJ:…`, `CECO:…`, `BL:…` y las cuatro por tipo) y
 * se ordenan para que el informe salga siempre igual. Las cifras vienen ya
 * hechas de `budgetVsActualAction` → `models/reports.ts` → `lib/budget/*`.
 */

const OTHER_COLUMN_LABELS: Record<string, string> = {
  AMORTIZACION_DETERIORO: "Amortización y deterioro",
  FINANCIERO: "Financiero",
  EXTRAORDINARIO: "Extraordinario",
  NO_ANALITICO: "No analítico",
  TOTAL: "Total compañía",
}

export type ColumnLabel = {
  key: string
  label: string
  /** `PROJ` · `CECO` · `BL` · `TIPO` · `TOTAL`. Ordena y agrupa la tabla. */
  kind: "PROJ" | "CECO" | "BL" | "TIPO" | "TOTAL"
  /** Una columna de línea de negocio es un AGREGADO de presentación (E4). */
  aggregate: boolean
}

const KIND_ORDER: Record<ColumnLabel["kind"], number> = { PROJ: 0, BL: 1, CECO: 2, TIPO: 3, TOTAL: 4 }

/** Nombre en español de una clave de columna, con el catálogo analítico vigente. */
export function columnLabel(key: string, config: AnalyticsConfig | null): ColumnLabel {
  if (key.startsWith("PROJ:")) {
    const code = key.slice("PROJ:".length)
    const project = config?.projects.find((p) => p.code === code)
    return { key, label: project ? `${code} · ${project.name}` : code, kind: "PROJ", aggregate: false }
  }
  if (key.startsWith("BL:")) {
    const code = key.slice("BL:".length)
    const line = config?.businessLines.find((b) => b.code === code)
    return { key, label: line ? `${code} · ${line.name}` : code, kind: "BL", aggregate: true }
  }
  if (key.startsWith("CECO:")) {
    const kind = key.slice("CECO:".length)
    return { key, label: COST_CENTER_KIND_LABELS[kind] ?? kind, kind: "CECO", aggregate: false }
  }
  if (key === "TOTAL") return { key, label: OTHER_COLUMN_LABELS.TOTAL, kind: "TOTAL", aggregate: false }
  return { key, label: OTHER_COLUMN_LABELS[key] ?? key, kind: "TIPO", aggregate: false }
}

/** Orden sellado: proyectos, líneas de negocio, CECOs, tipos y el total. */
export function sortColumns(a: ColumnLabel, b: ColumnLabel): number {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label, "es")
}

/** `1234` bps → `12,34 %`; `null` → `—` (presupuesto 0, o celda no publicada). */
export function formatVarianceBps(bps: number | null): string {
  if (bps === null) return "—"
  const sign = bps < 0 ? "−" : ""
  const magnitude = Math.abs(bps)
  return `${sign}${Math.floor(magnitude / 100)},${String(magnitude % 100).padStart(2, "0")} %`
}

/** `ene–jun: 2026-BASE · jul–dic: 2026-REV1` (O-E10-9). */
export function compositionSummary(composition: Record<string, string>): { code: string; months: string[] }[] {
  const out: { code: string; months: string[] }[] = []
  for (const month of Object.keys(composition).sort()) {
    const code = composition[month]
    const last = out.at(-1)
    if (last && last.code === code) last.months.push(month)
    else out.push({ code, months: [month] })
  }
  return out
}

const MONTH_NAMES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

export const monthShort = (month: string): string => MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month
