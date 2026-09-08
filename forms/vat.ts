/**
 * E9 · T15 — Validación de entrada del IVA periódico (§5.2).
 *
 * Nada de lo que se liquida entra por aquí: la acción **recalcula en servidor**
 * desde el libro registro (`readVatBook` → `vatSettlement`) y compara el
 * `ledgerHash` con el de la vista previa. Lo que este fichero valida es el
 * **sobre**: qué periodo, qué año, qué motivo.
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { z } from "zod"

/** `2026-01` … `2026-12` (mensual) o `2026-Q1` … `2026-Q4` (trimestral). */
export const vatPeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/, "El periodo de IVA tiene el formato AAAA-MM o AAAA-Qn")

export const vatYearSchema = z.number().int().min(2000, "Año fuera de rango").max(2100, "Año fuera de rango")

export const vatRegimeSchema = z.enum(["GENERAL", "RECC", "REDEME", "OTRO"])
export const vatPeriodKindSchema = z.enum(["MENSUAL", "TRIMESTRAL"])

/**
 * **D8.** El régimen es un dato **fechado**: entrar en REDEME en 2027 con una
 * columna habría reagrupado los periodos de 2026 ya presentados. El
 * diferimiento del IVA a la importación (art. 167.Dos LIVA) sólo existe con
 * periodo **MENSUAL** (O-16), y aquí se dice antes de que lo diga el CHECK.
 */
export const createVatRegimePeriodSchema = z
  .object({
    regime: vatRegimeSchema,
    periodKind: vatPeriodKindSchema,
    importDeferral: z.boolean().default(false),
    validFrom: localDateSchema,
    validTo: localDateSchema.nullish(),
  })
  .refine((v) => v.validTo == null || v.validTo >= v.validFrom, {
    message: "La fecha de fin de vigencia no puede ser anterior a la de inicio",
    path: ["validTo"],
  })
  .refine((v) => !v.importDeferral || v.periodKind === "MENSUAL", {
    message: "El diferimiento del IVA a la importación exige periodo de liquidación MENSUAL (art. 74.1 RIVA)",
    path: ["importDeferral"],
  })
export type CreateVatRegimePeriodFormInput = z.infer<typeof createVatRegimePeriodSchema>

/**
 * `expectedLedgerHash` es la firma de la vista previa. Si el diario cambió entre
 * la previsualización y el botón, la acción **rechaza y lo dice** (§9.3 de E7):
 * liquidar sobre cifras que ya no son las que el usuario vio es la manera de
 * sellar un número equivocado.
 */
export const settleVatSchema = z.object({
  period: vatPeriodSchema,
  expectedLedgerHash: z.string().length(64, "La firma del diario tiene 64 caracteres").nullish(),
  dryRun: z.boolean().default(false),
})
export type SettleVatFormInput = z.infer<typeof settleVatSchema>

export const reverseVatSettlementSchema = z.object({
  period: vatPeriodSchema,
  reason: z.string().trim().min(10, "La reversión de una liquidación exige un motivo de al menos 10 caracteres").max(512),
})
export type ReverseVatSettlementFormInput = z.infer<typeof reverseVatSettlementSchema>

/**
 * **O-10 / O-11.** La definitiva **se deriva** del libro de emitidas del año por
 * clave de operación: no se teclea un porcentaje. Con documentos sin clasificar,
 * la acción devuelve `INFO` con su lista y **no postea** (criterio 14).
 */
export const closeProrrataYearSchema = z.object({
  year: vatYearSchema,
  dryRun: z.boolean().default(false),
})
export type CloseProrrataYearFormInput = z.infer<typeof closeProrrataYearSchema>

/** La provisional del año (art. 105.Dos): la definitiva de N−1, o la declarada al alta. */
export const setProvisionalProrrataSchema = z.object({
  year: vatYearSchema,
  provisionalBps: z.number().int().min(0).max(10_000, "La prorrata va en puntos básicos: 8 700 son el 87 %"),
  reason: z.string().trim().max(512).nullish(),
})
export type SetProvisionalProrrataFormInput = z.infer<typeof setProvisionalProrrataSchema>

/** **T-36** · barrido del 31/12 del art. 163 *terdecies* (RECC). */
export const reccYearEndSchema = z.object({
  year: vatYearSchema,
  dryRun: z.boolean().default(false),
})
export type ReccYearEndFormInput = z.infer<typeof reccYearEndSchema>

export const vatBookQuerySchema = z.object({
  period: vatPeriodSchema,
  side: z.enum(["EMITIDAS", "RECIBIDAS", "AMBAS"]).default("AMBAS"),
})
export type VatBookQueryFormInput = z.infer<typeof vatBookQuerySchema>

export const model303QuerySchema = z.object({ period: vatPeriodSchema })
export type Model303QueryFormInput = z.infer<typeof model303QuerySchema>

export const listVatSettlementsSchema = z.object({
  period: vatPeriodSchema.nullish(),
  liveOnly: z.boolean().default(false),
})
export type ListVatSettlementsFormInput = z.infer<typeof listVatSettlementsSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Bloqueo de periodos (B-6, B-7, B-8)
// ─────────────────────────────────────────────────────────────────────────────

const monthSchema = z.number().int().min(1, "El mes va de 1 a 12").max(12, "El mes va de 1 a 12")

export const lockMonthSchema = z.object({
  fiscalYearId: uuidSchema,
  month: monthSchema,
  reason: z.string().trim().max(512).nullish(),
})
export type LockMonthFormInput = z.infer<typeof lockMonthSchema>

/**
 * **B-8.** Desbloquear un mes de un periodo de IVA ya liquidado exige revertir
 * antes la liquidación. El motivo es obligatorio porque desbloquear **arrastra**
 * los meses posteriores (B-3) y eso tiene que quedar explicado en `AuditLog`.
 */
export const unlockMonthSchema = z.object({
  fiscalYearId: uuidSchema,
  month: monthSchema,
  reason: z.string().trim().min(10, "El motivo del desbloqueo debe tener al menos 10 caracteres").max(512),
})
export type UnlockMonthFormInput = z.infer<typeof unlockMonthSchema>
