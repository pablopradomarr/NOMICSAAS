/**
 * E3 · T5 — Contrato de las 28 plantillas de asiento
 * (`docs/design/E3-asientos-tipo.md` §0 y §1). Módulo PURO.
 *
 * Una plantilla es una función pura `build(input, ctx) → Result<EntryDraft>`.
 * No lee la BD, no hace IO y **no conoce ningún código de cuenta**: pide una
 * `AccountKey` y `ctx.map` resuelve. Las cuentas que decide el usuario o el
 * documento (621, 628, 681, 216…) llegan como `accountCode` en el input.
 */

import type { z } from "zod"

import type { Cents, DraftLine, EntryDraft, EntryKind, LedgerContext, Result, SourceType } from "@/lib/ledger/types"

export const TEMPLATE_CODES = [
  // Bloque A — documento con impuestos (T-01…T-07)
  "FACTURA_EMITIDA_SERVICIOS",
  "ABONO_EMITIDO",
  "FACTURA_RECIBIDA",
  "FACTURA_RECIBIDA_ISP",
  "ABONO_RECIBIDO",
  "ANTICIPO_CLIENTE",
  "ANTICIPO_PROVEEDOR",
  // Bloque B — tesorería, personal y periodificación (T-08…T-18)
  "COBRO_CLIENTE",
  "PAGO_PROVEEDOR",
  "NOMINA",
  "PAGO_NOMINA",
  "PAGO_SEGURIDAD_SOCIAL",
  "PAGO_RETENCIONES",
  "AMORTIZACION_MENSUAL",
  "PERIODIFICACION_GASTO",
  "DEVENGO_PERIODIFICACION_GASTO",
  "PERIODIFICACION_INGRESO",
  "DEVENGO_PERIODIFICACION_INGRESO",
  // Bloque C — estructurales y de cierre (T-19…T-28)
  "TRASPASO_TESORERIA",
  "ASIENTO_MANUAL",
  "CONTRA_ASIENTO",
  "AJUSTE_EJERCICIO_CERRADO",
  "REGULARIZACION_IVA",
  "PAGO_IMPUESTO",
  "IMPUESTO_BENEFICIOS",
  "REGULARIZACION_RESULTADO",
  "CIERRE_EJERCICIO",
  "APERTURA_EJERCICIO",
] as const

export type TemplateCode = (typeof TEMPLATE_CODES)[number]

/** Las 24 de operativa corriente son las que E3 expone al usuario (§1). */
export const OPERATIONAL_TEMPLATE_CODES: readonly TemplateCode[] = TEMPLATE_CODES.filter(
  (c) =>
    c !== "IMPUESTO_BENEFICIOS" &&
    c !== "REGULARIZACION_RESULTADO" &&
    c !== "CIERRE_EJERCICIO" &&
    c !== "APERTURA_EJERCICIO"
)

export type TemplateBlock = "A" | "B" | "C"

export type TemplateDefinition<I = unknown> = {
  code: TemplateCode
  label: string
  block: TemplateBlock
  kind: EntryKind
  sourceType: SourceType
  /** Sin acción de usuario en E3: solo tests y `scripts/` (T-25…T-28, §1). */
  systemOnly: boolean
  /**
   * Zod, sin IO: valida la forma del input antes de construir nada. El tipo de
   * ENTRADA es `unknown` a propósito — los schemas usan `.default()`, así que
   * lo que se parsea y lo que sale no son el mismo tipo.
   */
  schema: z.ZodType<I, z.ZodTypeDef, unknown>
  build: (input: I, ctx: LedgerContext) => Result<EntryDraft>
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers compartidos por las tres tareas de plantillas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructor de línea. `lineNo` se pone a 0 y lo renumera `buildEntry` 1..n
 * tras descartar las líneas a cero: así una plantilla puede emitir líneas
 * condicionales sin ramificar (retención, anticipo, recargo, redondeo).
 */
export function line(l: Omit<DraftLine, "lineNo"> & { lineNo?: number }): DraftLine {
  return { lineNo: l.lineNo ?? 0, ...l }
}

export const debit = (
  amount: Cents,
  rest: Omit<DraftLine, "lineNo" | "debitCents" | "creditCents">
): DraftLine => line({ ...rest, debitCents: amount, creditCents: 0 })

export const credit = (
  amount: Cents,
  rest: Omit<DraftLine, "lineNo" | "debitCents" | "creditCents">
): DraftLine => line({ ...rest, debitCents: 0, creditCents: amount })

/** Importe con signo → línea del lado que le corresponde (positivo = debe). */
export const sided = (
  amount: number,
  rest: Omit<DraftLine, "lineNo" | "debitCents" | "creditCents">
): DraftLine => (amount >= 0 ? debit(amount, rest) : credit(-amount, rest))

export const sumCents = (values: readonly Cents[]): Cents => values.reduce((a, b) => a + b, 0)
