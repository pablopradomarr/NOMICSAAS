/**
 * E8 · T13 — split N-a-1: **una** `File`, N propuestas, N `Transaction`
 * (O-9.iii, §8 «Split de items»).
 *
 * Módulo **PURO**. Lo que TaxHacker hacía —clonar el binario y sembrar el
 * formulario desde `cachedParseResult`— dejaba N ficheros con N sha distintos
 * para un solo documento y N cifras sin origen. Aquí la fuente es siempre
 * `run.proposal`: el fichero no se toca, su `sha256` es el mismo para las N
 * operaciones y la cadena de trazabilidad sigue llegando a los mismos bytes.
 *
 * **Lo único que este módulo calcula es el reparto de la cuota**, y lo hace por
 * mayor resto sobre la base de cada grupo: la cuota del documento es la que se
 * contabiliza (ADR-0014 D3), así que repartirla es lo contrario de recalcularla
 * —`Σ cuotas de los grupos = cuota del documento`, tolerancia 0—.
 */

import { hamilton } from "@/lib/analytics/allocate"
import type { Cents, ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"

export type SplitGroup = {
  /** Índices de `proposal.lines`, en el orden del documento. */
  lineIndexes: readonly number[]
  description?: string
}

export type SplitError = { code: SplitErrorCode; message: string }
export type SplitErrorCode =
  | "SPLIT_INDEX_OUT_OF_RANGE"
  | "SPLIT_LINE_REPEATED"
  | "SPLIT_NOT_A_PARTITION"
  | "SPLIT_NOT_SPLITTABLE"

export type SplitResult = { ok: true; proposals: ExtractionProposal[] } | { ok: false; errors: SplitError[] }

const netBase = (line: ProposalLine): Cents => line.baseCents - (line.discountCents ?? 0)

/**
 * Divide una propuesta en N, una por grupo de líneas.
 *
 * Exige una **partición**: cada línea del documento cae en un grupo y sólo en
 * uno. Un split que se deja líneas fuera contabilizaría menos de lo que la
 * factura dice y nadie lo notaría hasta la conciliación.
 */
export function splitProposal(proposal: ExtractionProposal, groups: readonly SplitGroup[]): SplitResult {
  const errors: SplitError[] = []
  const seen = new Set<number>()

  for (const group of groups) {
    for (const index of group.lineIndexes) {
      if (index < 0 || index >= proposal.lines.length) {
        errors.push({
          code: "SPLIT_INDEX_OUT_OF_RANGE",
          message: `La línea ${index} no existe en el documento (tiene ${proposal.lines.length})`,
        })
        continue
      }
      if (seen.has(index)) {
        errors.push({ code: "SPLIT_LINE_REPEATED", message: `La línea ${index} está en dos grupos a la vez` })
        continue
      }
      seen.add(index)
    }
  }
  if (seen.size !== proposal.lines.length && errors.length === 0) {
    const missing = proposal.lines.map((_, i) => i).filter((i) => !seen.has(i))
    errors.push({
      code: "SPLIT_NOT_A_PARTITION",
      message: `El split deja ${missing.length} línea(s) sin grupo (${missing.join(", ")}): el documento entero tiene que quedar contabilizado`,
    })
  }

  /**
   * Retención, anticipo aplicado y rectificación son hechos **del documento**,
   * no de una línea: no hay reparto con lectura legal (la base de retención del
   * art. 99 LIRPF es la del documento, y una rectificativa rectifica una
   * factura, no un tercio de ella). Se declara y se rechaza en vez de inventar
   * un criterio.
   */
  if (proposal.withholding || (proposal.appliedAdvanceCents ?? 0) !== 0 || proposal.rectifies) {
    errors.push({
      code: "SPLIT_NOT_SPLITTABLE",
      message:
        "Un documento con retención, anticipo aplicado o rectificación no se divide: la base de la retención y el " +
        "documento rectificado son del documento entero. Confírmelo completo",
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  // Cuota de cada tipo repartida entre los grupos por su base, mayor resto.
  const quotaShares = new Map<string, number[]>()
  for (const tax of proposal.taxes) {
    const weights = groups.map((group, gi) => ({
      code: String(gi).padStart(4, "0"),
      weight: sumOf(group.lineIndexes.map((i) => (proposal.lines[i].taxRateCode === tax.taxRateCode ? netBase(proposal.lines[i]) : 0))),
    }))
    const shares = hamilton(tax.quotaCents, weights)
    quotaShares.set(tax.taxRateCode, shares.map((s) => s.amountCents))
  }

  const proposals = groups.map((group, gi) => {
    const lines = group.lineIndexes.map((i) => proposal.lines[i])
    const codes = new Set(lines.map((l) => l.taxRateCode).filter((c): c is string => c !== null))
    const taxes: ProposalTax[] = proposal.taxes
      .filter((tax) => codes.has(tax.taxRateCode))
      .map((tax) => ({
        ...tax,
        baseCents: sumOf(lines.filter((l) => l.taxRateCode === tax.taxRateCode).map(netBase)),
        quotaCents: quotaShares.get(tax.taxRateCode)?.[gi] ?? 0,
      }))
    const totalCents = sumOf(lines.map(netBase)) + sumOf(taxes.map((t) => t.quotaCents))
    return {
      ...proposal,
      lines,
      taxes,
      totalCents,
      ...(group.description === undefined ? {} : { description: group.description }),
      // El vencimiento del documento entero no es el de un tercio de él.
      ...(proposal.dueSchedule ? { dueSchedule: undefined } : {}),
    } as ExtractionProposal
  })

  return { ok: true, proposals }
}

const sumOf = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)
