/**
 * E5 · T11/T12/T13 — Modelos de vista de la liquidación de centros de coste.
 *
 * Mismo contrato que `components/analytics/types.ts`: objetos planos y
 * serializables, importes en **céntimos enteros**, fechas `"YYYY-MM-DD"` y
 * cuotas en **puntos básicos enteros**. El navegador no reparte, no prorratea y
 * no suma ninguna cifra contable: todo llega resuelto de
 * `lib/analytics/allocate.ts` a través de `models/allocations.ts`.
 *
 * Lo único que se calcula en el cliente es la **suma de aviso** de
 * `Σ sourceShareBps` mientras se escribe un conjunto de reglas: no es una cifra
 * contable, es la ayuda del formulario, y va marcada como tal. La validación de
 * verdad la hacen `forms/allocations.ts`, la acción y el trigger de la base.
 */

/** Las cinco políticas de reparto vivas (`HOURS`/`HEADCOUNT` llegan en E10). */
export const ALLOCATION_DRIVERS = [
  "FIXED_PERCENT",
  "REVENUE_SHARE",
  "DIRECT_COST_SHARE",
  "EQUAL",
  "MANUAL",
] as const

export type AllocationDriver = (typeof ALLOCATION_DRIVERS)[number]

export const DRIVER_LABELS: Record<string, string> = {
  FIXED_PERCENT: "Porcentaje fijo",
  REVENUE_SHARE: "Proporcional a ingresos",
  DIRECT_COST_SHARE: "Proporcional a coste directo",
  HOURS: "Horas imputadas",
  HEADCOUNT: "Plantilla",
  EQUAL: "A partes iguales",
  MANUAL: "Importes manuales",
}

/** Explicación contable de cada driver, en español llano. Va en el tooltip. */
export const DRIVER_HELP: Record<string, string> = {
  FIXED_PERCENT:
    "Reparte el saldo del centro de coste según los porcentajes que declares tú. Los destinos tienen que sumar exactamente el 100 %. Es una decisión de política, no un dato observado: úsalo cuando el criterio esté acordado por dirección.",
  REVENUE_SHARE:
    "Reparte en proporción a los ingresos directos de cada receptor en el periodo, leídos del libro diario (se excluyen las subvenciones del 74). Un receptor con ingresos netos negativos pesa cero y queda fuera con un aviso: la estructura nunca se le devuelve como ingreso.",
  DIRECT_COST_SHARE:
    "Reparte en proporción al coste directo (MC1 + MC2) de cada receptor en el periodo, leído del libro diario. Es el criterio habitual para operaciones indirectas: quien más obra consume, más estructura absorbe.",
  HOURS: "Necesita partes de horas (TimeEntry), que llegan en E10. Hoy se rechaza al guardar.",
  HEADCOUNT: "Necesita las asignaciones de personal, que llegan en E10. Hoy se rechaza al guardar.",
  EQUAL:
    "Reparte a partes iguales entre los receptores elegibles. Aviso de método: cobra lo mismo a un proyecto de 2 M€ que a uno de 20 k€. Es una elección de política, no un hecho.",
  MANUAL:
    "Los importes los declaras tú, en euros, y tienen que sumar exactamente la base liquidable del periodo. Si después se contabiliza un asiento tardío del periodo, la liquidación queda caducada y hay que reeditar los importes: no se reescala sola.",
}

export const PERIOD_LABELS: Record<string, string> = {
  MONTH: "Mensual",
  QUARTER: "Trimestral",
  YEAR: "Anual",
}

export const TARGET_KIND_LABELS: Record<string, string> = {
  PROJECTS: "Proyectos",
  BUSINESS_LINES: "Líneas de negocio",
  COST_CENTERS: "Centros de coste (cascada)",
  MIXED: "Mixto",
}

export const FALLBACK_LABELS: Record<string, string> = {
  SKIP_WARN: "No repartir y avisar",
  EQUAL: "Repartir a partes iguales",
  YTD: "Ampliar la base al acumulado del ejercicio",
  PRIOR_PERIOD: "Usar la base del periodo anterior",
}

export const FALLBACK_HELP: Record<string, string> = {
  SKIP_WARN:
    "Si la base del driver es cero, no se emite ninguna línea: el importe se queda en la columna del centro de coste y la matriz lo marca como pendiente de liquidar.",
  EQUAL: "Si la base del driver es cero, se reparte a partes iguales entre los receptores elegibles.",
  YTD: "Si la base del driver es cero en el periodo, se amplía al acumulado del ejercicio hasta el fin del periodo.",
  PRIOR_PERIOD: "Si la base del driver es cero, se usa la base del periodo inmediatamente anterior.",
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  SEALED: "Sellada",
  SUPERSEDED: "Sustituida",
  REVERSED: "Revertida",
}

export const WARNING_LABELS: Record<string, string> = {
  "W-E5-ZERO-BASE": "Base del driver a cero",
  "W-E5-NEG-BASE": "Base negativa: receptor excluido",
  "W-E5-ARCHIVED-TARGET": "Receptor archivado",
}

/** Nombre legible de un destino, ya resuelto en el servidor. */
export type AllocationTargetView = {
  kind: "PROJECT" | "BUSINESS_LINE" | "COST_CENTER"
  id: string
  code: string
  name: string
}

/** Una regla tal y como la pinta la tabla de `/analytics/allocations`. */
export type AllocationRuleView = {
  id: string
  code: string
  name: string
  sourceCostCenterId: string
  sourceCostCenterCode: string
  sourceCostCenterName: string
  targetKind: string
  driver: string
  period: string
  priority: number
  sourceShareBps: number
  zeroBaseFallback: string
  validFrom: string
  validTo: string | null
  isActive: boolean
  lineCount: number
  targets: { label: string; percentBps: number | null; amountCents: number | null }[]
}

/** Aviso de conjunto: `Σ sourceShareBps` por `(centro de coste, periodicidad)`. */
export type SourceShareGroup = {
  sourceCostCenterCode: string
  sourceCostCenterName: string
  period: string
  totalBps: number
  ruleCodes: string[]
}

/** Opción de destino para el formulario de reglas. */
export type AllocationDimensionOption = { id: string; code: string; name: string }

export type AllocationDimensions = {
  /** Sólo los centros de coste **imputables**: el resto no puede ser fuente. */
  allocatableCostCenters: AllocationDimensionOption[]
  projects: AllocationDimensionOption[]
  businessLines: AllocationDimensionOption[]
}

/** Una línea de la tabla de simulación / del detalle de un run. */
export type AllocationLineView = {
  ruleCode: string
  sourceCostCenterCode: string
  targetKind: string
  targetCode: string
  targetLabel: string
  marginLevel: string
  amountCents: number
  driverBase: number
  driverBaseTotal: number
  driverShareBps: number
  fallbackApplied: string | null
  eligibilityReason: string | null
}

export type AllocationBalanceView = {
  sourceCostCenterCode: string
  marginLevel: string
  baseCents: number
  liquidatedCents: number
  allocatedCents: number
  residualCents: number
  pendingCents: number
}

export type AllocationWarningView = {
  code: string
  ruleCode: string
  period: string
  detail: string
  targets?: string[]
  fallback?: string | null
  unallocatedCents?: number | null
}

/** Lo que devuelve una simulación, listo para pintar. */
export type AllocationPreviewView = {
  periodKind: string
  periodStart: string
  periodEnd: string
  periodLabel: string
  lines: AllocationLineView[]
  balances: AllocationBalanceView[]
  warnings: AllocationWarningView[]
  rulesApplied: string[]
  totalAllocatedCents: number
  seals: { ledgerHash: string; dimensionsHash: string; rulesHash: string }
}

export type AllocationRunView = {
  id: string
  periodKind: string
  periodStart: string
  periodEnd: string
  periodLabel: string
  status: string
  lineCount: number
  totalAllocatedCents: number
  ledgerHash: string
  analyticsHash: string
  rulesHash: string
  gitSha: string
  runAt: string
  supersededById: string | null
  reversedAt: string | null
  reversalReason: string | null
  isStale: boolean
  staleReasons: string[]
}

export type AllocationDiffView = {
  key: string
  ruleCode: string
  sourceCostCenterCode: string
  targetCode: string
  marginLevel: string
  beforeCents: number
  afterCents: number
  deltaCents: number
}

/** `3000` bps → `30,00 %`. Formato, no cálculo contable. */
export function formatShareBps(bps: number): string {
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(bps / 100)
    .replace("-", "−")} %`
}

/** Etiqueta del periodo: `2026-03` · `2026-Q2` · `2026`. Sin cálculo. */
export function periodLabelOf(kind: string, start: string): string {
  const [year, month] = start.split("-")
  if (kind === "YEAR") return year
  if (kind === "QUARTER") return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`
  return `${year}-${month}`
}

/** Extremos del periodo elegido en el selector. Fechas, no importes. */
export function periodRange(kind: string, year: number, index: number): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, "0")
  if (kind === "YEAR") return { start: `${year}-01-01`, end: `${year}-12-31` }
  if (kind === "QUARTER") {
    const firstMonth = index * 3 + 1
    const lastMonth = firstMonth + 2
    return { start: `${year}-${pad(firstMonth)}-01`, end: `${year}-${pad(lastMonth)}-${pad(lastDay(year, lastMonth))}` }
  }
  const month = index + 1
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay(year, month))}` }
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export const MONTH_NAMES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const
