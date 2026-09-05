/**
 * E6 — **EV-1, EV-3, EV-5 y EV-6 calculados sobre las líneas**, no declarados.
 *
 * Los umbrales de variación sólo sirven si NO saltan por lo que es estructural.
 * La revisión encontró que `ThresholdContext` se pasaba vacío: los cuatro
 * atenuantes estaban escritos en `checkThresholds` y nadie los alimentaba, así
 * que en el mes del cierre —donde el resultado se desploma por el impuesto y la
 * regularización— el sello saltaba siempre. Un sello que salta siempre es un
 * sello que nadie lee.
 *
 * Módulo PURO.
 */

import type { Cents, EntryKind, LocalDate } from "@/lib/ledger/types"
import type { ThresholdContext } from "@/lib/ledger/report-run"
import { epigraphNumberOf, PYG_SUBTOTALS } from "@/lib/ledger/reports/pyg"
import type { AccountIndex, PgcVariant, ReportEntry, ReportLine } from "@/lib/ledger/reports/types"

/** Los tres `kind` que no son actividad del periodo (EV-1). */
const SYSTEM_KINDS: readonly EntryKind[] = ["OPENING", "CLOSING", "REGULARIZATION"]

export type ThresholdContextInput = {
  lines: readonly ReportLine[]
  /** Cabeceras del periodo: hacen falta para emparejar `REVERSAL` con su original. */
  entries?: readonly ReportEntry[]
  index: AccountIndex
  variant: PgcVariant
  fiscalYearId?: string
  /** Dimensiones vivas en el periodo actual y en el comparado (EV-6). */
  dimensionsCurrent?: readonly string[]
  dimensionsPrevious?: readonly string[]
}

/**
 * El epígrafe del impuesto sobre beneficios: el ÚLTIMO de la lista de A.4, que
 * es el único que A.4 añade sobre A.3. Se deriva de la tabla de subtotales, no
 * se escribe «20» a mano: en PYMES es el 19 y en un modelo futuro podría ser otro.
 */
export function incomeTaxEpigraphNumber(variant: PgcVariant): number {
  const a4 = PYG_SUBTOTALS[variant]["A.4) RESULTADO DEL EJERCICIO"]
  return a4[a4.length - 1]
}

/**
 * Compone el contexto de atenuantes a partir del diario del periodo.
 *
 *  - **EV-1**: si el periodo contiene `OPENING`/`CLOSING`/`REGULARIZATION`. Los
 *    motores ya los excluyen de todo KPI de flujo; el indicador deja constancia
 *    de que la exclusión aplicaba, para que el motivo del sello sea auditable.
 *  - **EV-3**: la parte del `resultado` que viene del epígrafe del impuesto y de
 *    los asientos de `REGULARIZATION`. Se DESCUENTA antes de aplicar el umbral:
 *    el resultado del mes del cierre no cae un 30 % «porque el negocio vaya mal».
 *  - **EV-5**: el neto de los `REVERSAL` cuyo original cae en el MISMO periodo.
 *    El par se neutraliza solo en las cifras, pero sin netearlo aquí el KPI
 *    compara un periodo que incluye una factura y su rectificación contra otro
 *    que no las tuvo.
 *  - **EV-6**: las dimensiones vivas en los dos periodos. Un proyecto nuevo es
 *    un alta, no una variación.
 */
export function buildThresholdContext(input: ThresholdContextInput): ThresholdContext {
  const scoped = input.lines.filter(
    (l) => input.fiscalYearId === undefined || l.fiscalYearId === input.fiscalYearId
  )

  const periodHasSystemEntries = scoped.some((l) => SYSTEM_KINDS.includes(l.entryKind))

  // ── EV-3 ────────────────────────────────────────────────────────────────
  const taxEpigraph = incomeTaxEpigraphNumber(input.variant)
  let structuralResultado = 0
  for (const l of scoped) {
    const isPnl = l.accountCode.startsWith("6") || l.accountCode.startsWith("7")
    if (!isPnl) continue
    // La regularización no está en el universo de la PyG, así que no aporta al
    // KPI: lo que sí aporta —y es estructural— es el asiento del impuesto.
    if (SYSTEM_KINDS.includes(l.entryKind)) continue
    const epigraph = input.index.epigraphOf(l.accountCode, input.variant)
    if (epigraphNumberOf(epigraph ?? "") !== taxEpigraph) continue
    structuralResultado += l.creditCents - l.debitCents
  }

  // ── EV-5 ────────────────────────────────────────────────────────────────
  const net = reversalNet(scoped, input.entries ?? [], input.index, input.variant)

  // ── EV-6 ────────────────────────────────────────────────────────────────
  const dimensionsAliveInBoth =
    input.dimensionsCurrent && input.dimensionsPrevious
      ? input.dimensionsCurrent.filter((d) => input.dimensionsPrevious!.includes(d)).sort()
      : undefined

  return {
    periodHasSystemEntries,
    structuralDeltaByKpi: { resultado: structuralResultado },
    reversalNetByKpi: net,
    ...(dimensionsAliveInBoth ? { dimensionsAliveInBoth } : {}),
  }
}

/**
 * Neto de los pares `REVERSAL` + original que caen los DOS en el periodo, por
 * KPI. Un contra-asiento sin su original dentro del periodo NO se netea: ahí la
 * variación es real y el umbral debe verla.
 */
function reversalNet(
  lines: readonly ReportLine[],
  entries: readonly ReportEntry[],
  index: AccountIndex,
  variant: PgcVariant
): Record<string, Cents> {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const paired = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== "REVERSAL" || !entry.reversesEntryId) continue
    if (!byId.has(entry.reversesEntryId)) continue
    paired.add(entry.id)
    paired.add(entry.reversesEntryId)
  }
  if (paired.size === 0) return {}

  let ingresos = 0
  let resultado = 0
  for (const l of lines) {
    if (!paired.has(l.entryId)) continue
    const isPnl = l.accountCode.startsWith("6") || l.accountCode.startsWith("7")
    if (!isPnl || SYSTEM_KINDS.includes(l.entryKind)) continue
    const aporte = l.creditCents - l.debitCents
    resultado += aporte
    if (epigraphNumberOf(index.epigraphOf(l.accountCode, variant) ?? "") === 1) ingresos += aporte
  }
  // El neto de un par completo es 0 por construcción; se devuelve calculado —no
  // asumido— porque un par mal formado (importes distintos) tiene que notarse.
  return { ingresos, resultado, ebitda: resultado }
}

/** Meses `YYYY-MM` de las líneas, para los KPI que se comparan por trimestre (EV-4). */
export const monthsOf = (lines: readonly ReportLine[]): string[] =>
  [...new Set(lines.map((l) => l.entryDate.slice(0, 7)))].sort()

export type { LocalDate }
