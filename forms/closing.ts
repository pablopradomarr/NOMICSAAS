/**
 * E9 · T15 — Validación de entrada del cierre, la reapertura y la distribución
 * del resultado (§5.2, ADR-0016 D1, D9 y D10).
 *
 * Dos reglas del ADR viven en estos schemas y no en la pantalla:
 *
 * · **Reabrir exige motivo ≥ 30 caracteres y escribir el código del ejercicio.**
 *   Una confirmación que se responde con «sí» no es una confirmación: la que se
 *   teclea obliga a mirar qué se está reabriendo (D1.2).
 * · **La reserva legal no es editable a la baja** (art. 274 LSC): el formulario
 *   sólo manda destinos voluntarios y la calcula el motor. Aquí se rechaza el
 *   intento de mandarla, en vez de aceptarla y sobreescribirla en silencio.
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { CLOSING_STEP_CODES } from "@/lib/closing/checklist"
import { z } from "zod"

export const closingStepCodeSchema = z.enum(CLOSING_STEP_CODES as unknown as [string, ...string[]], {
  errorMap: () => ({ message: "Paso del cierre desconocido" }),
})

export const manualStepAnswerSchema = z.object({
  step: closingStepCodeSchema,
  status: z.enum(["PASS", "WARN", "FAIL", "NA"]),
  note: z.string().trim().max(512).nullish(),
})
export type ManualStepAnswerFormInput = z.infer<typeof manualStepAnswerSchema>

/** Ejecuta los pasos y crea o actualiza el `ClosingRun`. **No postea nada.** */
export const runClosingChecklistSchema = z.object({
  fiscalYearId: uuidSchema,
  refDate: localDateSchema.nullish(),
  answers: z.array(manualStepAnswerSchema).max(64).default([]),
})
export type RunClosingChecklistFormInput = z.infer<typeof runClosingChecklistSchema>

/** Responder un paso declarado (arqueo, existencias, diferido…) con su nota. */
export const answerClosingStepSchema = z.object({
  fiscalYearId: uuidSchema,
  step: closingStepCodeSchema,
  status: z.enum(["PASS", "WARN", "FAIL", "NA"]),
  note: z.string().trim().max(512).nullish(),
})
export type AnswerClosingStepFormInput = z.infer<typeof answerClosingStepSchema>

/**
 * Postea **un** asiento del cierre, en el orden de O-17 y con vista previa
 * obligatoria: `dryRun: true` devuelve el borrador, `false` lo postea.
 */
export const postClosingStepSchema = z.object({
  fiscalYearId: uuidSchema,
  step: closingStepCodeSchema,
  entryDate: localDateSchema.nullish(),
  dryRun: z.boolean().default(false),
  expectedLedgerHash: z.string().length(64).nullish(),
})
export type PostClosingStepFormInput = z.infer<typeof postClosingStepSchema>

/**
 * Cerrar exige un `ClosingRun` `COMPROBADO` con el **mismo `ledgerHash`** y los
 * nueve bloqueantes en PASS. Las tres cosas se comprueban **en servidor**.
 */
export const closeFiscalYearE9Schema = z.object({
  fiscalYearId: uuidSchema,
  closingRunId: uuidSchema,
  reason: z.string().trim().min(10, "El motivo del cierre debe tener al menos 10 caracteres").max(512),
  refDate: localDateSchema.nullish(),
})
export type CloseFiscalYearE9FormInput = z.infer<typeof closeFiscalYearE9Schema>

/**
 * **D1.2.** Reapertura: ADMIN, motivo ≥ 30 caracteres y confirmación escribiendo
 * el código del ejercicio. `acknowledgeTaxFiling` recoge el aviso del art. 122
 * LGT (Q-1.2) y `acknowledgeNextYear` la segunda confirmación cuando N+1 tiene
 * asientos posteriores a la apertura.
 */
export const reopenFiscalYearSchema = z.object({
  fiscalYearId: uuidSchema,
  reason: z.string().trim().min(30, "Reabrir un ejercicio exige un motivo de al menos 30 caracteres").max(512),
  confirmCode: z.string().trim().min(1, "Escriba el código del ejercicio para confirmar").max(16),
  acknowledgeTaxFiling: z.boolean().default(false),
  acknowledgeNextYear: z.boolean().default(false),
})
export type ReopenFiscalYearFormInput = z.infer<typeof reopenFiscalYearSchema>

export const accountsApprovalStatusSchema = z.enum(["BORRADOR", "FORMULADAS", "APROBADAS", "DEPOSITADAS"])
export const taxFilingStatusSchema = z.enum(["NO_PRESENTADO", "PRESENTADO", "RECTIFICADO"])

/** Al marcar `APROBADAS` la acción devuelve `requiresDistribution` (O-18). */
export const setAccountsApprovalSchema = z.object({
  fiscalYearId: uuidSchema,
  status: accountsApprovalStatusSchema,
  date: localDateSchema,
  reason: z.string().trim().max(512).nullish(),
})
export type SetAccountsApprovalFormInput = z.infer<typeof setAccountsApprovalSchema>

export const setTaxFilingStatusSchema = z.object({
  fiscalYearId: uuidSchema,
  status: taxFilingStatusSchema,
  reason: z.string().trim().max(512).nullish(),
})
export type SetTaxFilingStatusFormInput = z.infer<typeof setTaxFilingStatusSchema>

const centsSchema = z.number().int("Los importes van en céntimos enteros").min(0, "Los importes no pueden ser negativos")

/**
 * **T-35 · O-18.** La junta acuerda reservas voluntarias, remanente y dividendo;
 * la **reserva legal la calcula el motor** con el capital derivado del saldo
 * acreedor de `100` (R2-2) y **no es editable a la baja**. Por eso no hay campo
 * `legalReserveCents`: si lo hubiera, alguien lo pondría a cero.
 */
export const distributeProfitSchema = z.object({
  fiscalYearId: uuidSchema,
  meetingDate: localDateSchema,
  voluntaryReserveCents: centsSchema.default(0),
  carryForwardCents: centsSchema.default(0),
  dividendCents: centsSchema.default(0),
  /** Dividendo a cuenta ya satisfecho (`557`), que esta distribución cancela. */
  interimDividendCents: centsSchema.default(0),
  capitalStockOverrideCents: centsSchema.nullish(),
  dryRun: z.boolean().default(false),
})
export type DistributeProfitFormInput = z.infer<typeof distributeProfitSchema>

export const getClosingRunSchema = z.object({ fiscalYearId: uuidSchema })
export type GetClosingRunFormInput = z.infer<typeof getClosingRunSchema>
