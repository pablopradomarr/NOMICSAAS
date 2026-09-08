/**
 * E9 · T15 — Validación de entrada de las reglas recurrentes y sus ocurrencias
 * (`docs/design/E9-cierre-recurrentes.md` §5.2).
 *
 * La forma FINA del `templateInput` la valida el schema de su plantilla dentro
 * de `buildFromTemplate` (fuente única, `lib/ledger/templates/schemas.ts`): aquí
 * sólo se comprueba el sobre. Un schema por operación, ninguna cifra derivada.
 */

import { localDateSchema, uuidSchema } from "@/forms/ledger"
import { anyTemplateCodeSchema } from "@/forms/ledger"
import { z } from "zod"

/** `2026-03` (mensual · trimestral · semestral · anual, según la frecuencia). */
export const periodKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4]|S[1-2]|A)$/, "El periodo tiene el formato AAAA-MM, AAAA-Qn, AAAA-Sn o AAAA-A")

export const recurrenceFreqSchema = z.enum(["MENSUAL", "TRIMESTRAL", "SEMESTRAL", "ANUAL"])
export const recurrenceAnchorSchema = z.enum(["PRIMER_DIA", "ULTIMO_DIA", "DIA_DEL_MES"])
export const recurringKindSchema = z.enum(["AMORTIZACION", "PERIODIFICACION", "IMPORTE_FIJO"])
export const recurringStatusSchema = z.enum(["ACTIVA", "PAUSADA", "FINALIZADA"])

const codeSchema = z.string().trim().min(1, "El código es obligatorio").max(32, "El código admite 32 caracteres")
const nameSchema = z.string().trim().min(1, "El nombre es obligatorio").max(160)

/**
 * **G-2.** Sólo `IMPORTE_FIJO` lleva importe tecleado: en `AMORTIZACION` y
 * `PERIODIFICACION` la cuota la aporta un cuadro determinista y una cifra
 * escrita a mano sería una segunda fuente de verdad (ADR-0003).
 */
export const createRecurringSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    kind: recurringKindSchema,
    templateCode: anyTemplateCodeSchema,
    templateInput: z.record(z.unknown()),
    amountCents: z.number().int("Los importes van en céntimos enteros").nullish(),
    freq: recurrenceFreqSchema,
    anchor: recurrenceAnchorSchema.default("ULTIMO_DIA"),
    anchorDay: z.number().int().min(1).max(31).nullish(),
    startPeriod: periodKeySchema,
    endPeriod: periodKeySchema.nullish(),
    fixedAssetId: uuidSchema.nullish(),
    accrualId: uuidSchema.nullish(),
    counterpartyId: uuidSchema.nullish(),
  })
  .refine((v) => v.kind === "IMPORTE_FIJO" || v.amountCents == null, {
    message: "Sólo una regla de IMPORTE_FIJO lleva importe: en amortización y periodificación lo aporta el cuadro (G-2)",
    path: ["amountCents"],
  })
  .refine((v) => v.kind !== "IMPORTE_FIJO" || (v.amountCents != null && v.amountCents > 0), {
    message: "Una regla de IMPORTE_FIJO necesita su importe en céntimos",
    path: ["amountCents"],
  })
  .refine((v) => v.anchor !== "DIA_DEL_MES" || v.anchorDay != null, {
    message: "Con anclaje DIA_DEL_MES hay que decir qué día",
    path: ["anchorDay"],
  })
  .refine((v) => v.endPeriod == null || v.endPeriod >= v.startPeriod, {
    message: "El periodo final no puede ser anterior al inicial",
    path: ["endPeriod"],
  })
export type CreateRecurringFormInput = z.infer<typeof createRecurringSchema>

export const updateRecurringSchema = z.object({
  id: uuidSchema,
  name: nameSchema.optional(),
  templateInput: z.record(z.unknown()).optional(),
  amountCents: z.number().int().nullish(),
  endPeriod: periodKeySchema.nullish(),
  reason: z.string().trim().max(512).nullish(),
})
export type UpdateRecurringFormInput = z.infer<typeof updateRecurringSchema>

export const pauseRecurringSchema = z.object({
  id: uuidSchema,
  status: recurringStatusSchema,
  reason: z.string().trim().min(10, "El motivo debe tener al menos 10 caracteres").max(512),
})
export type PauseRecurringFormInput = z.infer<typeof pauseRecurringSchema>

/**
 * `dryRun` previsualiza **con el mismo código** que postea (§5.2): no hay una
 * ruta de simulación aparte que pueda divergir de la real.
 */
export const generateOccurrencesSchema = z.object({
  upToPeriod: periodKeySchema,
  recurringEntryId: uuidSchema.nullish(),
  dryRun: z.boolean().default(false),
})
export type GenerateOccurrencesFormInput = z.infer<typeof generateOccurrencesSchema>

/** R-REC-7: revertir es contra-asiento, nunca borrado; el motivo es obligatorio. */
export const revertOccurrenceSchema = z.object({
  occurrenceId: uuidSchema,
  reason: z.string().trim().min(10, "El motivo de la reversión debe tener al menos 10 caracteres").max(512),
  entryDate: localDateSchema.nullish(),
})
export type RevertOccurrenceFormInput = z.infer<typeof revertOccurrenceSchema>

export const listOccurrencesSchema = z.object({
  recurringEntryId: uuidSchema.nullish(),
  fromPeriod: periodKeySchema.nullish(),
  toPeriod: periodKeySchema.nullish(),
})
export type ListOccurrencesFormInput = z.infer<typeof listOccurrencesSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Periodificaciones (`Accrual`) — viven en la pestaña de /ledger/recurring
// ─────────────────────────────────────────────────────────────────────────────

export const accrualBasisSchema = z.enum(["DIAS", "MESES", "TIPO_EFECTIVO"])
export const accrualKindSchema = z.enum([
  "GASTO_ANTICIPADO",
  "INGRESO_ANTICIPADO",
  "INTERESES_PAGADOS_ANTICIPADO",
  "INTERESES_COBRADOS_ANTICIPADO",
])

/**
 * **O-25.** `TIPO_EFECTIVO` exige el `DebtSchedule` del que sale el devengo: sin
 * cuadro no hay tipo efectivo que aplicar, y repartir por días un interés con
 * principal decreciente es la desviación que el WARN denuncia.
 */
export const createAccrualSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    kind: accrualKindSchema,
    accrualAccountCode: z.string().trim().min(1, "Falta la cuenta de periodificación").max(12),
    pnlAccountCode: z.string().trim().min(1, "Falta la cuenta de gasto o ingreso").max(12),
    totalCents: z.number().int().positive("El importe a periodificar tiene que ser positivo"),
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    basis: accrualBasisSchema.default("MESES"),
    debtScheduleId: uuidSchema.nullish(),
    counterpartyId: uuidSchema.nullish(),
    entryId: uuidSchema.nullish(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: "La fecha de fin no puede ser anterior a la de inicio",
    path: ["periodEnd"],
  })
  .refine((v) => v.basis !== "TIPO_EFECTIVO" || v.debtScheduleId != null, {
    message: "La base TIPO_EFECTIVO exige el cuadro de la deuda del que sale el devengo (O-25)",
    path: ["debtScheduleId"],
  })
export type CreateAccrualFormInput = z.infer<typeof createAccrualSchema>

export const setAccrualStatusSchema = z.object({
  id: uuidSchema,
  status: z.enum(["VIVA", "AGOTADA", "CANCELADA"]),
  reason: z.string().trim().min(10, "El motivo debe tener al menos 10 caracteres").max(512),
})
export type SetAccrualStatusFormInput = z.infer<typeof setAccrualStatusSchema>
