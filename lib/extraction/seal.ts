/**
 * E8 · T13 — sellado de un `reconcile` en el run, avisos de calidad y forzados.
 *
 * Módulo **PURO**. Tres cosas, las tres con la misma razón de ser: un
 * `ExtractionRun` es inmutable y append-only, así que **todo lo que la
 * Auditoría va a querer saber del documento tiene que quedar escrito en el
 * momento de crearlo**. Después ya no se puede.
 *
 *  1. `sealedReconcile()` — la forma JSON del veredicto que viaja a
 *     `extraction_runs.reconcile`. Sin `normalized` ni `fieldOrigins` (van en
 *     sus propias columnas, y duplicarlos rozaría la cota de 256 KB) y con el
 *     `rateMicro` como cadena, porque un `bigint` no es JSON.
 *  2. `documentWarnings()` — los WARN de calidad que **sólo el documento sabe**
 *     y el asiento no puede reconstruir: deducibilidad pendiente de decisión,
 *     ticket cualificado por un acto humano y contraparte sin régimen. E7 los
 *     pinta; `dataQualityWarnings()` los cuenta desde aquí.
 *  3. `applyFieldOverride()` — el forzado de un campo, por la MISMA ruta con la
 *     que `fieldOrigins` lo nombra. Un forzado no edita el run: produce la
 *     propuesta del run de revisión (D5).
 */

import type { ReconcileResult } from "@/lib/extraction/reconcile"
import type { ExtractionProposal } from "@/lib/extraction/types"

export type SealedWarningCode = "DEDUCIBILIDAD_PENDIENTE" | "TICKET_CUALIFICADO" | "CONTRAPARTE_SIN_REGIMEN"

/**
 * Avisos que el documento aporta y el diario no puede deducir.
 *
 * `CONTRAPARTE_SIN_REGIMEN` mira la ficha, no el PDF: sin ficha nadie ha
 * decidido si ese proveedor lleva retención, y una retención no practicada la
 * paga el pagador (arts. 99 y 101 LIRPF).
 */
export function documentWarnings(
  result: ReconcileResult,
  ctx: { counterpartyEnMaestro: boolean; withholdingRegime: string | null }
): SealedWarningCode[] {
  const out: SealedWarningCode[] = []
  const rc15 = result.checks.find((c) => c.id === "RC-15")
  if (rc15 && rc15.status !== "PASS") out.push("DEDUCIBILIDAD_PENDIENTE")
  if (result.normalized.docKind === "TICKET" && result.normalized.simplifiedQualified === true) {
    out.push("TICKET_CUALIFICADO")
  }
  if (!ctx.counterpartyEnMaestro || ctx.withholdingRegime === null) out.push("CONTRAPARTE_SIN_REGIMEN")
  return out
}

export type SealedReconcile = {
  status: ReconcileResult["status"]
  checks: readonly {
    id: string
    status: string
    blocksBatch: boolean
    message: string
    evidence: Record<string, unknown>
    fields: readonly string[]
  }[]
  quotaDeviationsCents: Readonly<Record<string, number>>
  elegibleParaLote: boolean
  sellos: readonly string[]
  ivaPeriod: string | null
  entryDate: string | null
  fiscalYearClosed: boolean
  withholding: ReconcileResult["withholding"]
  conversion: { rateId: string; rateMicro: string; rateDate: string; source: string; convertedTotalCents: number } | null
  warnings: readonly SealedWarningCode[]
}

/** El veredicto tal como se sella en el run: JSON puro, sin `bigint`. */
export function sealedReconcile(result: ReconcileResult, warnings: readonly SealedWarningCode[]): SealedReconcile {
  return {
    status: result.status,
    checks: result.checks.map((c) => ({
      id: c.id,
      status: c.status,
      blocksBatch: c.blocksBatch,
      message: c.message,
      evidence: c.evidence,
      fields: c.fields,
    })),
    quotaDeviationsCents: result.quotaDeviationsCents,
    elegibleParaLote: result.elegibleParaLote,
    sellos: result.sellos,
    ivaPeriod: result.ivaPeriod,
    entryDate: result.entryDate,
    fiscalYearClosed: result.fiscalYearClosed,
    withholding: result.withholding,
    conversion: result.conversion
      ? {
          rateId: result.conversion.rateId,
          rateMicro: result.conversion.rateMicro.toString(),
          rateDate: result.conversion.rateDate,
          source: result.conversion.source,
          convertedTotalCents: result.conversion.convertedTotalCents,
        }
      : null,
    warnings,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Forzado de un campo
// ─────────────────────────────────────────────────────────────────────────────

export type OverrideError = { code: "FIELD_UNKNOWN" | "FIELD_NOT_FORCEABLE"; message: string }
export type OverrideResult = { ok: true; proposal: ExtractionProposal } | { ok: false; error: OverrideError }

/**
 * Campos que **no** se fuerzan nunca, ni con motivo (R6 del diseño): el forzado
 * existe para el duplicado, el `convertedTotal` y el ticket cualificado; un FAIL
 * aritmético no se puede forzar, porque forzarlo es inventar una factura.
 */
const NO_FORCEABLE = new Set(["totalCents", "version", "counterparty.id"])

/**
 * Aplica un valor a la ruta con la que `fieldOrigins` nombra el campo:
 * `documentNumber`, `counterparty.taxId`, `lines[2].accountCode`,
 * `taxes[IVA_21].quotaCents`, `receptionDate`…
 *
 * No muta la propuesta: devuelve una copia. Las rutas de `taxes` se indexan
 * **por código de tipo**, que es como el motor las nombra: el orden del array no
 * es un identificador estable.
 */
export function applyFieldOverride(proposal: ExtractionProposal, path: string, value: unknown): OverrideResult {
  if (NO_FORCEABLE.has(path)) {
    return {
      ok: false,
      error: {
        code: "FIELD_NOT_FORCEABLE",
        message: `«${path}» no se puede forzar: una cifra que no cuadra se corrige tecleándola, no forzándola (R6)`,
      },
    }
  }

  const lineMatch = /^lines\[(\d+)\]\.(\w+)$/.exec(path)
  if (lineMatch) {
    const index = Number(lineMatch[1])
    if (index >= proposal.lines.length) {
      return { ok: false, error: { code: "FIELD_UNKNOWN", message: `La línea ${index} no existe` } }
    }
    const lines = proposal.lines.map((line, i) => (i === index ? { ...line, [lineMatch[2]]: value } : line))
    return { ok: true, proposal: { ...proposal, lines } }
  }

  const taxMatch = /^taxes\[([^\]]+)\]\.(\w+)$/.exec(path)
  if (taxMatch) {
    const code = taxMatch[1]
    if (!proposal.taxes.some((t) => t.taxRateCode === code)) {
      return { ok: false, error: { code: "FIELD_UNKNOWN", message: `El documento no tiene ningún tipo ${code}` } }
    }
    const taxes = proposal.taxes.map((t) => (t.taxRateCode === code ? { ...t, [taxMatch[2]]: value } : t))
    return { ok: true, proposal: { ...proposal, taxes } }
  }

  const nested = /^counterparty\.(\w+)$/.exec(path)
  if (nested) {
    return { ok: true, proposal: { ...proposal, counterparty: { ...proposal.counterparty, [nested[1]]: value } } }
  }

  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(path) || !(path in proposal)) {
    return { ok: false, error: { code: "FIELD_UNKNOWN", message: `«${path}» no es un campo de la propuesta` } }
  }
  return { ok: true, proposal: { ...proposal, [path]: value } as ExtractionProposal }
}
