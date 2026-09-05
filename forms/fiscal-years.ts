/**
 * E3 · T9 — Validación de entrada de ejercicios y bloqueos (§4.2).
 *
 * No hay `reopenFiscalYearSchema`: reabrir un ejercicio cerrado equivale a
 * reformular cuentas ya rendidas (arts. 253, 272 y 279 LSC) y no es una
 * operación de usuario (decisión 4 de §9.2).
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { z } from "zod"

export const createFiscalYearSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, "El código del ejercicio es obligatorio")
      .max(16, "El código del ejercicio admite 16 caracteres"),
    startDate: localDateSchema,
    endDate: localDateSchema,
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "La fecha de fin no puede ser anterior a la de inicio",
    path: ["endDate"],
  })
export type CreateFiscalYearFormInput = z.infer<typeof createFiscalYearSchema>

export const closeFiscalYearSchema = z.object({
  fiscalYearId: uuidSchema,
  reason: z.string().trim().min(10, "El motivo del cierre debe tener al menos 10 caracteres").max(512),
})
export type CloseFiscalYearFormInput = z.infer<typeof closeFiscalYearSchema>

const monthSchema = z.number().int().min(1, "El mes va de 1 a 12").max(12, "El mes va de 1 a 12")

export const lockPeriodSchema = z.object({
  fiscalYearId: uuidSchema,
  month: monthSchema,
  reason: z.string().trim().max(512).nullish(),
})
export type LockPeriodFormInput = z.infer<typeof lockPeriodSchema>

/** Desbloquear arrastra los meses posteriores (B-3): el motivo es obligatorio. */
export const unlockPeriodSchema = z.object({
  fiscalYearId: uuidSchema,
  month: monthSchema,
  reason: z.string().trim().min(10, "El motivo del desbloqueo debe tener al menos 10 caracteres").max(512),
})
export type UnlockPeriodFormInput = z.infer<typeof unlockPeriodSchema>
