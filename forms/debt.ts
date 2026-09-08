/**
 * E9 · T15 — Validación de entrada de los cuadros de deuda (§5.2, O-6).
 *
 * **G-17** vive aquí y en la base: `Σ principal = principalCents` y `seq`
 * correlativo **sin huecos**. Sin desglose de vencimientos no hay parte
 * corriente que presentar, y la reclasificación del cierre sale **FAIL
 * bloqueante** nombrando la deuda (I-E9-25).
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { z } from "zod"

const accountSchema = z.string().trim().min(1, "Falta la cuenta").max(12)
const centsSchema = z.number().int("Los importes van en céntimos enteros")

export const debtInstallmentSchema = z.object({
  seq: z.number().int().positive("La secuencia empieza en 1"),
  dueDate: localDateSchema,
  principalCents: centsSchema.min(0, "El principal de una cuota no puede ser negativo"),
  interestCents: centsSchema.min(0, "El interés de una cuota no puede ser negativo").default(0),
})
export type DebtInstallmentFormInput = z.infer<typeof debtInstallmentSchema>

export const createDebtScheduleSchema = z
  .object({
    code: z.string().trim().min(1, "El código es obligatorio").max(32),
    name: z.string().trim().min(1, "El nombre es obligatorio").max(160),
    /** El par de la reclasificación: `170`/`520`, `171`/`521`, `173`/`523`… */
    longAccountCode: accountSchema,
    shortAccountCode: accountSchema,
    counterpartyId: uuidSchema.nullish(),
    principalCents: centsSchema.positive("El principal tiene que ser positivo"),
    currency: z.string().trim().length(3, "La divisa va en código ISO de tres letras").default("EUR"),
    monthlyRateMicroBps: z.number().int().min(0).nullish(),
    startDate: localDateSchema,
    entryId: uuidSchema.nullish(),
    installments: z.array(debtInstallmentSchema).min(1, "Un cuadro sin vencimientos no es un cuadro"),
  })
  .refine((v) => v.installments.reduce((a, i) => a + i.principalCents, 0) === v.principalCents, {
    message: "Σ principal del cuadro ≠ principal declarado (G-17): el cuadro no explica la deuda",
    path: ["installments"],
  })
  .refine((v) => v.installments.every((i, idx) => i.seq === idx + 1), {
    message: "La secuencia de vencimientos tiene un hueco (G-17)",
    path: ["installments"],
  })
  .refine((v) => v.installments.every((i, idx) => idx === 0 || i.dueDate >= v.installments[idx - 1].dueDate), {
    message: "Los vencimientos tienen que ir en orden de fecha",
    path: ["installments"],
  })
export type CreateDebtScheduleFormInput = z.infer<typeof createDebtScheduleSchema>

/**
 * **T-37 · alta del préstamo**: una línea de `170`/`520` **por vencimiento**, de
 * modo que la posición nazca ya desglosada y la reclasificación del cierre tenga
 * de dónde leer el corte de los doce meses.
 */
export const postLoanSchema = z.object({
  debtScheduleId: uuidSchema,
  entryDate: localDateSchema,
  cashAccountCode: accountSchema.default("572"),
  description: z.string().trim().max(512).nullish(),
  dryRun: z.boolean().default(false),
})
export type PostLoanFormInput = z.infer<typeof postLoanSchema>

export const listDebtSchedulesSchema = z.object({
  counterpartyId: uuidSchema.nullish(),
  cutoff: localDateSchema.nullish(),
})
export type ListDebtSchedulesFormInput = z.infer<typeof listDebtSchedulesSchema>
