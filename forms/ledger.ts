/**
 * E3 · T9 — Validación de entrada del libro diario (`docs/design/E3-libro-diario.md` §4.2).
 *
 * Un schema por operación. La forma FINA del input de cada plantilla la valida
 * su propio schema dentro de `buildFromTemplate` (`lib/ledger/templates/schemas.ts`),
 * que es la fuente única: aquí sólo se comprueba que el código de plantilla es
 * uno de los **24 de operativa** y que el sobre viene bien formado.
 */

import { OPERATIONAL_TEMPLATE_CODES, TEMPLATE_CODES } from "@/lib/ledger/templates/types"
import { z } from "zod"

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")

export const uuidSchema = z.string().uuid("Identificador no válido")

const centsSchema = z.number().int("Los importes van en céntimos enteros").min(0, "Los importes no pueden ser negativos")

/** Sólo T-01…T-24: las cuatro de cierre no tienen acción de usuario en E3 (§1). */
export const operationalTemplateCodeSchema = z.enum(
  OPERATIONAL_TEMPLATE_CODES as unknown as [string, ...string[]],
  { errorMap: () => ({ message: "Plantilla no disponible para el usuario" }) }
)

export const anyTemplateCodeSchema = z.enum(TEMPLATE_CODES as unknown as [string, ...string[]])

// ─────────────────────────────────────────────────────────────────────────────
// T-20 · Asiento manual
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La línea admite el importe en **céntimos** (`debitCents`, lo que envía un
 * cliente programático) o como **texto en euros** (`debit`, lo que teclea el
 * usuario: «1.234,56»). La conversión la hace el SERVIDOR con
 * `lib/money.parseCents`; el navegador nunca decide céntimos (§6).
 */
export const manualEntryLineSchema = z
  .object({
    accountCode: z.string().min(1, "Falta la cuenta").max(12),
    debitCents: centsSchema.optional(),
    creditCents: centsSchema.optional(),
    debit: z.string().nullish(),
    credit: z.string().nullish(),
    description: z.string().max(512).nullish(),
    dueDate: localDateSchema.nullish(),
    counterpartyId: uuidSchema.nullish(),
  })
  .refine((l) => l.debitCents !== undefined || l.creditCents !== undefined || l.debit != null || l.credit != null, {
    message: "La línea necesita un importe al debe o al haber",
  })

/**
 * `kind` NO es parámetro: el asiento manual es siempre `NORMAL`. Apertura,
 * cierre, regularización y contra-asiento sólo los produce el motor (§4.2).
 */
export const manualEntrySchema = z.object({
  documentDate: localDateSchema.nullish(),
  accrualDate: localDateSchema.nullish(),
  description: z.string().min(1, "El concepto es obligatorio").max(512),
  sourceId: z.string().max(128).nullish(),
  fileId: uuidSchema.nullish(),
  lines: z.array(manualEntryLineSchema).min(2, "Un asiento tiene al menos dos líneas"),
})
export type ManualEntryFormInput = z.infer<typeof manualEntrySchema>

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas
// ─────────────────────────────────────────────────────────────────────────────

export const templatePostSchema = z.object({
  templateCode: operationalTemplateCodeSchema,
  /** Lo valida el schema de la plantilla; aquí sólo se exige que sea un objeto. */
  input: z.record(z.unknown()),
  /** Fecha de referencia («hoy») del cliente; el servidor la acota. */
  refDate: localDateSchema.optional(),
})
export type TemplatePostFormInput = z.infer<typeof templatePostSchema>

export const templatePreviewSchema = templatePostSchema
export type TemplatePreviewFormInput = TemplatePostFormInput

export const postTransactionSchema = z.object({
  transactionId: uuidSchema,
  templateCode: operationalTemplateCodeSchema,
  input: z.record(z.unknown()),
  refDate: localDateSchema.optional(),
})
export type PostTransactionFormInput = z.infer<typeof postTransactionSchema>

// ─────────────────────────────────────────────────────────────────────────────
// T-21 · Anulación
// ─────────────────────────────────────────────────────────────────────────────

export const voidEntrySchema = z.object({
  entryId: uuidSchema,
  reason: z.string().trim().min(10, "El motivo de la anulación debe tener al menos 10 caracteres").max(512),
  /** Sólo puede RETRASAR la fecha que calcula el motor, nunca adelantarla. */
  requestedDate: localDateSchema.nullish(),
})
export type VoidEntryFormInput = z.infer<typeof voidEntrySchema>

// ─────────────────────────────────────────────────────────────────────────────
// Consulta
// ─────────────────────────────────────────────────────────────────────────────

export const entryFilterSchema = z.object({
  fiscalYearId: uuidSchema.optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  accountCode: z.string().max(12).optional(),
  templateCode: anyTemplateCodeSchema.optional(),
  search: z.string().max(200).optional(),
  voided: z.boolean().optional(),
  onlyReversals: z.boolean().optional(),
  skip: z.number().int().min(0).optional(),
  take: z.number().int().min(1).max(200).optional(),
})
export type EntryFilterFormInput = z.infer<typeof entryFilterSchema>

export const runInvariantsSchema = z.object({
  fiscalYearId: uuidSchema.optional(),
  refDate: localDateSchema.optional(),
})
export type RunInvariantsFormInput = z.infer<typeof runInvariantsSchema>
