/**
 * E6 · T11 — Aging de la cartera (§8.8 de la validación contable).
 *
 * El aging mide **mora**, no antigüedad: los tramos se cuentan desde el
 * **vencimiento** (`dueDate`), no desde la fecha de factura. Una factura a 90
 * días emitida hace 80 **no está vencida** y no debe aparecer en «61–90»;
 * mezclar las dos bases hace que una empresa con plazos largos parezca morosa.
 * La antigüedad desde factura es otra métrica (DSO) y va en otra columna.
 *
 * `refDate` entra **por parámetro** y viaja en `paramsHash`: dos ejecuciones del
 * mismo informe con el mismo `ledgerHash` tienen que dar el mismo aging, y
 * `lib/ledger/` tiene prohibido `Date.now()`.
 *
 * Módulo PURO.
 */

import type { Cents, LocalDate } from "@/lib/ledger/types"
import type { ReportLine } from "@/lib/ledger/reports/types"

/**
 * Siete tramos. `SIN_VENCIMIENTO` es **visible y va primero**: es la única
 * opción que mantiene `Σ tramos = saldo de la cuenta` (I-E6-14). Las tres
 * alternativas son peores —tratarlas como vencidas inventa una mora, como no
 * vencidas esconde deuda real, y excluirlas descuadra el total—.
 */
export type AgingBucket =
  | "SIN_VENCIMIENTO"
  | "A_APLICAR"
  | "NO_VENCIDO"
  | "D_1_30"
  | "D_31_60"
  | "D_61_90"
  | "D_MAS_90"

export const AGING_BUCKET_ORDER: readonly AgingBucket[] = [
  "SIN_VENCIMIENTO",
  "A_APLICAR",
  "NO_VENCIDO",
  "D_1_30",
  "D_31_60",
  "D_61_90",
  "D_MAS_90",
]

export const AGING_BUCKET_LABELS: Readonly<Record<AgingBucket, string>> = {
  SIN_VENCIMIENTO: "Sin vencimiento",
  A_APLICAR: "Pendiente de aplicar",
  NO_VENCIDO: "No vencido",
  D_1_30: "1–30 días",
  D_31_60: "31–60 días",
  D_61_90: "61–90 días",
  // El corte de 90 días es además el umbral del art. 13.1.a LIS para la
  // deducibilidad del deterioro de créditos: hay que poder señalarlo.
  D_MAS_90: "Más de 90 días",
}

export type AgingParams = {
  /** «Hoy» del informe. NUNCA `Date.now()`. */
  refDate: LocalDate
  /** Cuentas a envejecer: clientes (`43x`) o proveedores (`40x`). */
  accountPrefixes: readonly string[]
  /**
   * Signo natural del saldo: `DEUDOR` para clientes, `ACREEDOR` para
   * proveedores. Una línea del signo contrario (un cobro sin aplicar, un abono)
   * va a `A_APLICAR` y **no se compensa** con las vencidas: compensar un
   * anticipo contra una factura vencida hace desaparecer la mora del informe.
   */
  naturalSide: "DEUDOR" | "ACREEDOR"
}

export type AgingRow = {
  bucket: AgingBucket
  label: string
  cents: Cents
  lineCount: number
}

export type AgingReport = {
  refDate: LocalDate
  rows: AgingRow[]
  totalCents: Cents
  /** Por cuenta: hasta que exista `Counterparty` (E8) es la única agrupación. */
  byAccountCents: Record<string, Cents>
  /** Nota obligatoria en pantalla: el detalle por cliente no existe todavía. */
  groupingNote: string
  /** WARN de calidad de datos: líneas 43x/40x sin `dueDate`. */
  linesWithoutDueDate: number
  /** I-E6-14: `Σ tramos − saldo de las cuentas` a `refDate`. Debe ser 0. */
  checkTotalCents: Cents
}

export const AGING_GROUPING_NOTE =
  "Agrupado por cuenta contable, no por cliente: el ERP no tiene todavía ficha de contraparte. " +
  "El drill-down a las líneas del diario es el detalle disponible."

/** Días naturales entre dos fechas ISO, sin construir `Date` con hora. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const toUtc = (d: LocalDate): number => {
    const [y, m, day] = d.split("-").map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000)
}

/**
 * Tramo de una línea. `dueDate` ausente → `SIN_VENCIMIENTO`, con tramo propio y
 * visible. Nunca dos tramos para la misma línea (I-E6-15): la función devuelve
 * exactamente uno.
 */
export function agingBucketOf(
  dueDate: LocalDate | null | undefined,
  refDate: LocalDate,
  amountCents: Cents
): AgingBucket {
  if (amountCents < 0) return "A_APLICAR"
  if (!dueDate) return "SIN_VENCIMIENTO"
  const overdue = daysBetween(dueDate, refDate)
  if (overdue <= 0) return "NO_VENCIDO"
  if (overdue <= 30) return "D_1_30"
  if (overdue <= 60) return "D_31_60"
  if (overdue <= 90) return "D_61_90"
  return "D_MAS_90"
}

/**
 * Aging por línea viva. Se calcula sobre el **saldo por línea**, no por factura:
 * E3 guarda el `dueDate` en la línea `43x`/`40x` y ésa es la unidad que se puede
 * pinchar en el drill-down.
 */
export function buildAging(lines: readonly ReportLine[], params: AgingParams): AgingReport {
  const sign = params.naturalSide === "DEUDOR" ? 1 : -1
  const totals = new Map<AgingBucket, { cents: Cents; lineCount: number }>()
  const byAccount = new Map<string, Cents>()
  let withoutDueDate = 0
  let total = 0

  for (const l of lines) {
    if (l.entryDate > params.refDate) continue
    if (!params.accountPrefixes.some((p) => l.accountCode.startsWith(p))) continue
    // El importe se presenta SIEMPRE en positivo en su lado natural.
    const amount = sign * (l.debitCents - l.creditCents)
    if (amount === 0) continue
    if (!l.dueDate && amount > 0) withoutDueDate++

    const bucket = agingBucketOf(l.dueDate, params.refDate, amount)
    const cell = totals.get(bucket) ?? { cents: 0, lineCount: 0 }
    cell.cents += amount
    cell.lineCount += 1
    totals.set(bucket, cell)
    byAccount.set(l.accountCode, (byAccount.get(l.accountCode) ?? 0) + amount)
    total += amount
  }

  const rows = AGING_BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: AGING_BUCKET_LABELS[bucket],
    cents: totals.get(bucket)?.cents ?? 0,
    lineCount: totals.get(bucket)?.lineCount ?? 0,
  }))

  return {
    refDate: params.refDate,
    rows,
    totalCents: total,
    byAccountCents: Object.fromEntries([...byAccount.entries()].sort()),
    groupingNote: AGING_GROUPING_NOTE,
    linesWithoutDueDate: withoutDueDate,
    // I-E6-14: `Σ tramos = saldo de la cuenta`, tolerancia 0. Como los tramos se
    // construyen particionando las MISMAS líneas que suman el saldo, el check es
    // estructural; que exista igualmente es lo que caza un filtro mal puesto.
    checkTotalCents: rows.reduce((a, r) => a + r.cents, 0) - total,
  }
}
