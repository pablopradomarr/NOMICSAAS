/**
 * E6 · T7 — Cuenta de pérdidas y ganancias contable (ADR-0012 D1, R-P1).
 *
 * Dos modelos (NORMAL y PYMES) y los cuatro subtotales oficiales A.1…A.4,
 * calculados **por número de epígrafe, no por rango de cuentas**. La diferencia
 * importa: un motor que metiera `630` en «otros gastos de explotación» acertaría
 * A.4 y fallaría A.1 y A.3, y sólo I-E6-3 (sobre A.3) lo cazaría.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * R-P1: `aporte = haber − debe`. Ingresos +, gastos −.
 *
 * Los signos de las contra-cuentas **salen solos**: `7080` (devoluciones de
 * ventas) se anota en el DEBE de una cuenta del grupo 7 y aporta −100 000 dentro
 * del epígrafe 1; `6080` aporta +50 000 dentro del 4. Un renderizador que
 * «restara las contra-cuentas» además del signo sumaría +100 000 y dejaría
 * aprovisionamientos en −680 000. No se toca `isContra` (R-B3).
 *
 * Y **no hay filtro de anulados**: el contra-asiento se neutraliza con su
 * original (E3 §4.2). Filtrar por `voidedAt`/`reversesEntryId` daría una cifra
 * distinta de la que suma el diario.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Módulo PURO.
 */

import { cellProvenance } from "@/lib/ledger/provenance"
import type { Cents, EntryKind } from "@/lib/ledger/types"
import { registrosOrigen } from "@/lib/ledger/reports/balance"
import { buildEpigraphTree, splitEpigraph, type EpigraphLeaf } from "@/lib/ledger/reports/epigraphs-tree"
import {
  buildAccountIndex,
  type AccountIndex,
  type PgcVariant,
  type ProvenanceContext,
  type ReportLine,
  type ReportPeriod,
  type StatementAccount,
  type StatementRow,
} from "@/lib/ledger/reports/types"

/** Los tres `kind` que NO son resultado del periodo (definición única de I3). */
export const PYG_EXCLUDED_KINDS: readonly EntryKind[] = ["OPENING", "REGULARIZATION", "CLOSING"]

export type PygSubtotal =
  | "A.1) RESULTADO DE EXPLOTACION"
  | "A.2) RESULTADO FINANCIERO"
  | "A.3) RESULTADO ANTES DE IMPUESTOS"
  | "A.4) RESULTADO DEL EJERCICIO"

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * Fórmulas de los subtotales, POR NÚMERO DE EPÍGRAFE. El modelo PYMES no tiene
 * el epígrafe 12 «Diferencia negativa de combinaciones de negocio», así que
 * todos los posteriores bajan uno; no es una regla derivable por regex, es una
 * tabla (§1.3 de la validación contable).
 */
export const PYG_SUBTOTALS: Readonly<Record<PgcVariant, Readonly<Record<PygSubtotal, readonly number[]>>>> = {
  GENERAL: {
    "A.1) RESULTADO DE EXPLOTACION": range(1, 13),
    "A.2) RESULTADO FINANCIERO": range(14, 19),
    "A.3) RESULTADO ANTES DE IMPUESTOS": range(1, 19),
    "A.4) RESULTADO DEL EJERCICIO": range(1, 20),
  },
  PYMES: {
    "A.1) RESULTADO DE EXPLOTACION": range(1, 12),
    "A.2) RESULTADO FINANCIERO": range(13, 18),
    "A.3) RESULTADO ANTES DE IMPUESTOS": range(1, 18),
    "A.4) RESULTADO DEL EJERCICIO": range(1, 19),
  },
}

/** Esqueleto oficial: se imprime completo, con los epígrafes a cero incluidos. */
export const PYG_SKELETON: Readonly<Record<PgcVariant, readonly { n: number; name: string }[]>> = {
  GENERAL: [
    { n: 1, name: "Importe neto de la cifra de negocios" },
    { n: 2, name: "Variación de existencias de productos terminados y en curso de fabricación" },
    { n: 3, name: "Trabajos realizados por la empresa para su activo" },
    { n: 4, name: "Aprovisionamientos" },
    { n: 5, name: "Otros ingresos de explotación" },
    { n: 6, name: "Gastos de personal" },
    { n: 7, name: "Otros gastos de explotación" },
    { n: 8, name: "Amortización del inmovilizado" },
    { n: 9, name: "Imputación de subvenciones de inmovilizado no financiero y otras" },
    { n: 10, name: "Excesos de provisiones" },
    { n: 11, name: "Deterioro y resultado por enajenaciones del inmovilizado" },
    { n: 12, name: "Diferencia negativa de combinaciones de negocio" },
    { n: 13, name: "Otros resultados" },
    { n: 14, name: "Ingresos financieros" },
    { n: 15, name: "Gastos financieros" },
    { n: 16, name: "Variación de valor razonable en instrumentos financieros" },
    { n: 17, name: "Diferencias de cambio" },
    { n: 18, name: "Deterioro y resultado por enajenaciones de instrumentos financieros" },
    { n: 19, name: "Otros ingresos y gastos de carácter financiero" },
    { n: 20, name: "Impuestos sobre beneficios" },
  ],
  PYMES: [
    { n: 1, name: "Importe neto de la cifra de negocios" },
    { n: 2, name: "Variación de existencias de productos terminados y en curso de fabricación" },
    { n: 3, name: "Trabajos realizados por la empresa para su activo" },
    { n: 4, name: "Aprovisionamientos" },
    { n: 5, name: "Otros ingresos de explotación" },
    { n: 6, name: "Gastos de personal" },
    { n: 7, name: "Otros gastos de explotación" },
    { n: 8, name: "Amortización del inmovilizado" },
    { n: 9, name: "Imputación de subvenciones de inmovilizado no financiero y otras" },
    { n: 10, name: "Excesos de provisiones" },
    { n: 11, name: "Deterioro y resultado por enajenaciones del inmovilizado" },
    { n: 12, name: "Otros resultados" },
    { n: 13, name: "Ingresos financieros" },
    { n: 14, name: "Gastos financieros" },
    { n: 15, name: "Variación de valor razonable en instrumentos financieros" },
    { n: 16, name: "Diferencias de cambio" },
    { n: 17, name: "Deterioro y resultado por enajenaciones de instrumentos financieros" },
    { n: 18, name: "Otros ingresos y gastos de carácter financiero" },
    { n: 19, name: "Impuestos sobre beneficios" },
  ],
}

/**
 * Número de epígrafe de una ruta («7. Otros gastos de explotación / a) …» → 7).
 * `null` si el primer segmento no empieza por un número: no se adivina.
 */
export function epigraphNumberOf(path: string): number | null {
  const head = splitEpigraph(path)[0]
  if (!head) return null
  const m = /^(\d+)\./.exec(head)
  return m ? Number(m[1]) : null
}

/** Epígrafes de amortización (8) y de deterioro de inmovilizado (11) por modelo. */
export const EBITDA_REVERSED_EPIGRAPHS: Readonly<Record<PgcVariant, readonly number[]>> = {
  GENERAL: [8, 11],
  PYMES: [8, 11],
}

export type PygParams = ReportPeriod & {
  variant: PgcVariant
  comparative?: { lines: readonly ReportLine[]; label: string; basis: string }
}

export type PygLineDetail = {
  entryId: string
  entryNumber: number
  lineNo: number
  accountCode: string
  epigraph: string
  cents: Cents
}

export type PygReport = {
  model: PgcVariant
  skeleton: { n: number; name: string; cents: Cents }[]
  lines: StatementRow[]
  byEpigraphNumberCents: Record<string, Cents>
  subtotalsCents: Record<PygSubtotal, Cents>
  /** A.4 = I3. Tolerancia 0. */
  resultadoDelEjercicioCents: Cents
  /** A.1 revirtiendo los epígrafes 8 y 11, y nada más (§8.5). */
  ebitdaCents: Cents
  lineCount: number
  lineDetail: PygLineDetail[]
  /** Cuentas sin epígrafe: quedarían fuera de la PyG en silencio (I-E6-2). */
  unmappedAccounts: { code: string; cents: Cents }[]
  comparativeLabel?: string
}

/**
 * PyG contable.
 *
 * O-1/O-3 (desglose a/b de las rectificativas `706`/`708`/`709` y
 * `606`/`608`/`609`): el motor imputa la rectificación al **mismo subepígrafe
 * que la cuenta rectificada**, resuelta por el asiento origen cuando el llamante
 * aporta `rectificationTargets`; si no la puede resolver, la deja en el
 * subepígrafe del seed y lo hace constar. Nunca la reparte «a ojo».
 */
export function buildPyg(
  lines: readonly ReportLine[],
  accounts: readonly StatementAccount[] | AccountIndex,
  params: PygParams,
  ctx?: ProvenanceContext,
  opts: { rectificationTargets?: ReadonlyMap<string, string> } = {}
): PygReport {
  const index = "byCode" in accounts ? (accounts as AccountIndex) : buildAccountIndex(accounts as StatementAccount[])
  const detail: PygLineDetail[] = []
  const unmapped = new Map<string, Cents>()

  const aggregate = (source: readonly ReportLine[], collect: boolean): { leaves: Map<string, EpigraphLeaf>; byNumber: Map<number, Cents>; total: Cents } => {
    const leaves = new Map<string, EpigraphLeaf>()
    const byNumber = new Map<number, Cents>()
    let total = 0
    for (const l of source) {
      if (params.fiscalYearId !== undefined && l.fiscalYearId !== params.fiscalYearId) continue
      if (PYG_EXCLUDED_KINDS.includes(l.entryKind)) continue
      if (index.statementOf(l.accountCode) !== "PYG") continue

      // R-P1 — el signo lo pone la convención, no la cuenta.
      const aporte = l.creditCents - l.debitCents
      const epigraph = opts.rectificationTargets?.get(l.accountCode) ?? index.epigraphOf(l.accountCode, params.variant)
      if (!epigraph) {
        if (collect) unmapped.set(l.accountCode, (unmapped.get(l.accountCode) ?? 0) + aporte)
        continue
      }
      const previous = leaves.get(epigraph)
      const codes = new Set(previous?.accountCodes ?? [])
      codes.add(l.accountCode)
      leaves.set(epigraph, {
        path: epigraph,
        cents: (previous?.cents ?? 0) + aporte,
        accountCodes: [...codes].sort(),
        isContraCell: (previous?.isContraCell ?? true) && index.isContra(l.accountCode),
      })
      const n = epigraphNumberOf(epigraph)
      if (n !== null) byNumber.set(n, (byNumber.get(n) ?? 0) + aporte)
      total += aporte
      if (collect) {
        detail.push({
          entryId: l.entryId,
          entryNumber: l.entryNumber,
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          epigraph,
          cents: aporte,
        })
      }
    }
    return { leaves, byNumber, total }
  }

  const current = aggregate(lines, true)

  const previousByPath = params.comparative
    ? new Map([...aggregate(params.comparative.lines, false).leaves].map(([path, leaf]) => [path, leaf.cents]))
    : undefined

  const formulas = PYG_SUBTOTALS[params.variant]
  const sumOf = (numbers: readonly number[]): Cents =>
    numbers.reduce((a, n) => a + (current.byNumber.get(n) ?? 0), 0)

  const subtotals = {
    "A.1) RESULTADO DE EXPLOTACION": sumOf(formulas["A.1) RESULTADO DE EXPLOTACION"]),
    "A.2) RESULTADO FINANCIERO": sumOf(formulas["A.2) RESULTADO FINANCIERO"]),
    "A.3) RESULTADO ANTES DE IMPUESTOS": sumOf(formulas["A.3) RESULTADO ANTES DE IMPUESTOS"]),
    "A.4) RESULTADO DEL EJERCICIO": sumOf(formulas["A.4) RESULTADO DEL EJERCICIO"]),
  } as Record<PygSubtotal, Cents>

  // §8.5 — EBITDA = A.1 revirtiendo los epígrafes 8 y 11, **y nada más**.
  //
  // «Otros resultados» (13/12) SÍ entra: el PGC 2007 suprimió el resultado
  // extraordinario y `678`/`778` están dentro del resultado de explotación.
  // Los deterioros de circulante (`694`/`794`) también entran: son gasto
  // operativo recurrente. Excluirlos daría un EBITDA distinto del que se deduce
  // de las cuentas depositadas, que es la vía clásica de maquillaje.
  const ebitda =
    subtotals["A.1) RESULTADO DE EXPLOTACION"] -
    EBITDA_REVERSED_EPIGRAPHS[params.variant].reduce((a, n) => a + (current.byNumber.get(n) ?? 0), 0)

  const treeOpts = previousByPath ? { previousByPath } : {}
  const report: PygReport = {
    model: params.variant,
    skeleton: PYG_SKELETON[params.variant].map((s) => ({ ...s, cents: current.byNumber.get(s.n) ?? 0 })),
    lines: buildEpigraphTree([...current.leaves.values()], treeOpts),
    byEpigraphNumberCents: Object.fromEntries(
      [...current.byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => [String(n), c])
    ),
    subtotalsCents: subtotals,
    resultadoDelEjercicioCents: current.total,
    ebitdaCents: ebitda,
    lineCount: detail.length,
    lineDetail: detail,
    unmappedAccounts: [...unmapped.entries()].sort().map(([code, cents]) => ({ code, cents })),
    ...(params.comparative ? { comparativeLabel: params.comparative.label } : {}),
  }

  if (ctx) {
    for (const row of report.lines) {
      const extra: (string | readonly string[])[] = []
      if (params.fiscalYearId) extra.push(params.fiscalYearId)
      if (row.accountCodes.length > 0) extra.push(row.accountCodes)
      extra.push(PYG_EXCLUDED_KINDS as readonly string[])
      row.provenance = cellProvenance(
        `pyg.${params.variant}.${row.path}`,
        row.cents,
        {
          organizationId: params.organizationId,
          from: params.from,
          to: params.to,
          query: registrosOrigen({
            withFiscalYear: Boolean(params.fiscalYearId),
            withAccounts: row.accountCodes.length > 0,
            withExcludedKinds: true,
          }),
          extraParams: extra,
        },
        ctx
      )
    }
  }

  return report
}
