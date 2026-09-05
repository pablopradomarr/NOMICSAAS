/**
 * E4 · T5 — Semillas analíticas de una organización (`E4-analitica.md` §2.8).
 *
 * Funciones PURAS: devuelven los datos, no los escriben. La siembra
 * transaccional vive en `models/analytics.seedAnalyticsDefaults`.
 */

import type {
  AnalyticType,
  CostCenterKind,
  CostCenterMarginLevel,
  MarginLevel,
} from "@/lib/analytics/types"

export type DefaultCostCenter = {
  code: string
  name: string
  kind: CostCenterKind
  marginLevel: CostCenterMarginLevel
  allocatable: boolean
  isSystem: boolean
  sortOrder: number
}

/** Código del CECO de sistema `SIN_ASIGNAR` (R-A8). Ni se borra ni se archiva. */
export const UNASSIGNED_COST_CENTER_CODE = "CC-NA"

/** Código y nombre de la línea de negocio de sistema (destino del backfill). */
export const DEFAULT_BUSINESS_LINE_CODE = "GENERAL"

/**
 * Los ocho CECOs por defecto (§2.8). `CC-FIN`, `CC-EXT` y `CC-NA` no son
 * imputables, cada uno por una razón distinta y las tres firmes (§8.6).
 */
export function defaultCostCenters(): DefaultCostCenter[] {
  return [
    { code: "CC-OPS", name: "Operaciones indirectas", kind: "OPERACIONES_INDIRECTAS", marginLevel: "MC3", allocatable: true, isSystem: false, sortOrder: 1 },
    { code: "CC-DEV", name: "Desarrollo de producto", kind: "DESARROLLO_PRODUCTO", marginLevel: "MC3", allocatable: true, isSystem: false, sortOrder: 2 },
    { code: "CC-MKT", name: "Marketing y ventas", kind: "MARKETING_VENTAS", marginLevel: "EBITDA", allocatable: true, isSystem: false, sortOrder: 3 },
    { code: "CC-GA", name: "General y administración", kind: "G_A", marginLevel: "EBITDA", allocatable: true, isSystem: false, sortOrder: 4 },
    { code: "CC-FIN", name: "Financiero", kind: "FINANCIERO", marginLevel: "EBITDA", allocatable: false, isSystem: false, sortOrder: 5 },
    { code: "CC-EXT", name: "Otros extraordinarios", kind: "EXTRAORDINARIO", marginLevel: "EBITDA", allocatable: false, isSystem: false, sortOrder: 6 },
    { code: "CC-OTR", name: "Otros", kind: "OTROS", marginLevel: "EBITDA", allocatable: true, isSystem: false, sortOrder: 7 },
    { code: UNASSIGNED_COST_CENTER_CODE, name: "Sin asignar", kind: "SIN_ASIGNAR", marginLevel: "EBITDA", allocatable: false, isSystem: true, sortOrder: 8 },
  ]
}

export type DefaultMarginLevel = {
  level: MarginLevel
  label: string
  analyticTypes: AnalyticType[]
  sortOrder: number
}

/**
 * `MarginLevelConfig` por defecto, idéntica a `marginLevelConfig` del JSON
 * sellado. **MC3 y EBITDA van vacíos** (MLC-2): `INDIRECTO_CECO` se rutea por
 * `CostCenter.marginLevel` (R-A7) y listarlo aquí lo contaría dos veces.
 */
export function defaultMarginLevels(): DefaultMarginLevel[] {
  return [
    { level: "INGRESOS", label: "Ingresos de proyecto", analyticTypes: ["INGRESO_DIRECTO"], sortOrder: 1 },
    { level: "MC1", label: "Margen de contribución 1 (tras aprovisionamiento)", analyticTypes: ["COSTE_DIRECTO_MC1"], sortOrder: 2 },
    { level: "MC2", label: "Margen de contribución 2 (tras costes directos)", analyticTypes: ["COSTE_DIRECTO_MC2"], sortOrder: 3 },
    { level: "MC3", label: "Margen de contribución 3 (tras estructura operativa)", analyticTypes: [], sortOrder: 4 },
    { level: "EBITDA", label: "EBITDA", analyticTypes: [], sortOrder: 5 },
    { level: "EBIT", label: "EBIT (tras amortizaciones y deterioros)", analyticTypes: ["AMORTIZACION_DETERIORO"], sortOrder: 6 },
    { level: "BAI", label: "Resultado antes de impuestos", analyticTypes: ["FINANCIERO", "EXTRAORDINARIO"], sortOrder: 7 },
    { level: "RESULTADO", label: "Resultado del ejercicio", analyticTypes: ["NO_ANALITICO"], sortOrder: 8 },
  ]
}

export type DefaultBusinessLine = { code: string; name: string; sortOrder: number; isSystem: boolean }

export function defaultBusinessLine(): DefaultBusinessLine {
  return { code: DEFAULT_BUSINESS_LINE_CODE, name: "General", sortOrder: 1, isSystem: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de MarginLevelConfig (MLC-1…MLC-5, I-E4-9)
// ─────────────────────────────────────────────────────────────────────────────

export type MarginConfigIssue = { code: "MLC-1" | "MLC-2" | "MLC-3"; message: string }

const ALL_TYPES: readonly AnalyticType[] = [
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "NO_ANALITICO",
]

/**
 * MLC-1: cada `AnalyticType` aparece **exactamente una vez** — salvo
 * `INDIRECTO_CECO`, que no aparece en ninguna lista porque lo rutea el CECO.
 * MLC-2: `MC3`/`EBITDA` nunca listan `INDIRECTO_CECO`.
 * MLC-3: los ocho niveles existen siempre.
 */
export function validateMarginLevels(
  rows: readonly { level: MarginLevel; analyticTypes: readonly AnalyticType[] }[]
): MarginConfigIssue[] {
  const issues: MarginConfigIssue[] = []
  const seen = new Map<AnalyticType, MarginLevel[]>()
  for (const row of rows) {
    for (const type of row.analyticTypes) {
      const list = seen.get(type) ?? []
      list.push(row.level)
      seen.set(type, list)
    }
    if ((row.level === "MC3" || row.level === "EBITDA") && row.analyticTypes.includes("INDIRECTO_CECO")) {
      issues.push({ code: "MLC-2", message: `${row.level} no puede listar INDIRECTO_CECO: lo rutea CostCenter.marginLevel` })
    }
    if (row.level !== "MC3" && row.level !== "EBITDA" && row.analyticTypes.includes("INDIRECTO_CECO")) {
      issues.push({ code: "MLC-2", message: `INDIRECTO_CECO solo se rutea por CECO, no puede listarse en ${row.level}` })
    }
  }
  for (const type of ALL_TYPES) {
    if (type === "INDIRECTO_CECO") continue
    const levels = seen.get(type) ?? []
    if (levels.length === 0) issues.push({ code: "MLC-1", message: `el tipo ${type} no está en ningún nivel` })
    if (levels.length > 1) issues.push({ code: "MLC-1", message: `el tipo ${type} está en ${levels.join(", ")}` })
  }
  const levels = new Set(rows.map((r) => r.level))
  if (levels.size !== 8) issues.push({ code: "MLC-3", message: `los 8 niveles existen siempre (hay ${levels.size})` })
  return issues
}
