/**
 * E8 · T11 — De la salida cruda del modelo a una `ExtractionProposal` tipada.
 *
 * Esta capa **no calcula ni califica**: normaliza formas. Traduce lo que el
 * modelo escribió a los tipos del dominio (céntimos enteros, `LocalDate`
 * "YYYY-MM-DD", ISO 4217 en mayúsculas) y descarta lo que no encaja, dejando el
 * campo a `null` para que `reconcile` (T7) lo trate como no verificado.
 *
 * Lo que **añade y el modelo no pudo decir**, con su origen explícito
 * (ADR-0014 D4, D8, D11): `receptionDate` (origen `usuario`, default la fecha
 * de subida), `kind = OPERACION` en cada línea, y la ausencia deliberada de
 * cuenta, dimensiones, deducibilidad, retención aplicable, medio de pago y
 * calificación de ISP. Ninguno de esos campos se rellena aquí ni se inventa:
 * los decide la organización.
 */

import type { ExtractionOutput } from "@/ai/schema"
import type {
  DocKind,
  ExtractionProposal,
  FieldOrigins,
  LineKind,
  ProposalLine,
  ProposalTax,
  Provenanced,
} from "@/lib/extraction/types"
import { DOC_KINDS } from "@/lib/extraction/types"

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_CURRENCY = /^[A-Za-z]{3}$/

export type NormalizeOptions = {
  /** Moneda de la organización, para cuando el documento no la declara (G-19). */
  defaultCurrency: string
  /** Fecha de recepción. Origen `usuario`; default, la fecha de subida (O-6). */
  receptionDate: string | null
}

export type NormalizedExtraction = {
  proposal: ExtractionProposal
  fieldOrigins: FieldOrigins
}

const llm = <T,>(value: T | null): Provenanced<unknown> => ({
  value: value as unknown,
  origin: "llm",
  confidence: "interpretacion_ia",
})

const user = <T,>(value: T | null): Provenanced<unknown> => ({
  value: value as unknown,
  origin: "usuario",
  confidence: "no_verificado",
})

function localDate(value: unknown): string | null {
  return typeof value === "string" && LOCAL_DATE.test(value.trim()) ? value.trim() : null
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function docKind(value: unknown): DocKind {
  return typeof value === "string" && (DOC_KINDS as readonly string[]).includes(value)
    ? (value as DocKind)
    : "DESCONOCIDO"
}

function currency(value: unknown, fallback: string): string {
  return typeof value === "string" && ISO_CURRENCY.test(value.trim())
    ? value.trim().toUpperCase()
    : fallback.toUpperCase()
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

export function normalizeExtractionOutput(
  output: ExtractionOutput,
  options: NormalizeOptions
): NormalizedExtraction {
  const lines: ProposalLine[] = (output.lines ?? [])
    .map((line): ProposalLine | null => {
      const baseCents = cents(line.baseCents)
      if (baseCents === null) return null
      const kind: LineKind = "OPERACION"
      return {
        kind,
        baseCents,
        ...(cents(line.discountCents) !== null ? { discountCents: cents(line.discountCents)! } : {}),
        taxRateCode: text(line.taxRateCode),
        ...(text(line.description) ? { description: text(line.description)! } : {}),
        ...(typeof line.qty === "number" && Number.isFinite(line.qty) ? { qty: line.qty } : {}),
        ...(cents(line.unitPriceCents) !== null ? { unitPriceCents: cents(line.unitPriceCents)! } : {}),
      }
    })
    .filter((line): line is ProposalLine => line !== null)

  const taxes: ProposalTax[] = (output.taxes ?? [])
    .map((tax): ProposalTax | null => {
      const baseCents = cents(tax.baseCents)
      const quotaCents = cents(tax.quotaCents)
      const taxRateCode = text(tax.taxRateCode)
      if (baseCents === null || quotaCents === null || taxRateCode === null) return null
      return { taxRateCode, baseCents, quotaCents }
    })
    .filter((tax): tax is ProposalTax => tax !== null)

  const dueSchedule = (output.dueSchedule ?? [])
    .map((due) => {
      const dueDate = localDate(due.dueDate)
      const amountCents = cents(due.amountCents)
      return dueDate !== null && amountCents !== null ? { dueDate, amountCents } : null
    })
    .filter((due): due is { dueDate: string; amountCents: number } => due !== null)

  const readWithholding =
    output.readWithholding && cents(output.readWithholding.quotaCents) !== null
      ? {
          rateBps: cents(output.readWithholding.rateBps) ?? 0,
          quotaCents: cents(output.readWithholding.quotaCents)!,
        }
      : null

  const documentNumber = text(output.documentNumber)
  const documentDate = localDate(output.documentDate)
  const counterpartyName = text(output.counterparty?.name)
  const counterpartyTaxId = text(output.counterparty?.taxId)?.replace(/[\s.-]/g, "").toUpperCase() ?? null
  const resolvedCurrency = currency(output.currency, options.defaultCurrency)
  const totalCents = cents(output.totalCents) ?? 0

  const proposal: ExtractionProposal = {
    version: 1,
    docKind: docKind(output.docKind),
    documentNumber,
    counterparty: { name: counterpartyName, taxId: counterpartyTaxId, id: null },
    documentDate,
    // O-6 / D8: NUNCA la propone el modelo.
    receptionDate: options.receptionDate,
    currency: resolvedCurrency,
    lines,
    taxes,
    ...(dueSchedule.length > 0 ? { dueSchedule } : {}),
    readWithholding,
    ...(output.rectifies?.documentNumber
      ? {
          rectifies: {
            documentNumber: output.rectifies.documentNumber,
            // La causa y el modo los decide el usuario (ADR-0014 D12); el
            // default es el que NO duplica la operación.
            reason: "ERROR" as const,
            mode: "DIFERENCIAS" as const,
          },
        }
      : {}),
    totalCents,
    description: text(output.description),
  }

  const fieldOrigins: FieldOrigins = {
    docKind: llm(proposal.docKind),
    documentNumber: llm(documentNumber),
    "counterparty.name": llm(counterpartyName),
    "counterparty.taxId": llm(counterpartyTaxId),
    documentDate: llm(documentDate),
    currency: output.currency ? llm(resolvedCurrency) : user(resolvedCurrency),
    totalCents: llm(totalCents),
    lines: llm(lines.length),
    taxes: llm(taxes.length),
    readWithholding: llm(readWithholding),
    receptionDate: user(options.receptionDate),
    description: llm(proposal.description),
  }

  if (output.legalMentions && output.legalMentions.length > 0) {
    fieldOrigins.legalMentions = llm(output.legalMentions)
  }
  for (const entry of output.extra ?? []) {
    fieldOrigins[`extra.${entry.code}`] = llm(entry.value)
  }

  return { proposal, fieldOrigins }
}
