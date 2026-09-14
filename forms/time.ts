/**
 * E10 · T14 — Validación de entrada de los partes de horas (§4.2).
 *
 * La unidad es el **minuto entero** (D6): ni horas decimales ni `hh:mm` en el
 * transporte. La pantalla enseña `7:20`; lo que viaja son 440.
 *
 * Un parte de 0 minutos no existe —no dice nada— y el techo por fila es 1 440
 * (un día). El techo **agregado** del día (O-E10-21) no se puede comprobar aquí
 * porque exige mirar los demás partes: lo avisa el modelo y lo impide el
 * trigger.
 */

import { localDateSchema, uuidSchema } from "@/forms/analytics"
import { z } from "zod"

export const MIN_TIME_REASON = 10

export const timeReasonSchema = z
  .string()
  .trim()
  .min(MIN_TIME_REASON, `El motivo es obligatorio y debe tener al menos ${MIN_TIME_REASON} caracteres`)
  .max(1000)

export const timeStatusSchema = z.enum(["BORRADOR", "APROBADO"])

/** Minutos de un parte: entero, distinto de 0 y ≤ 1 440 por fila (D6). */
export const minutesSchema = z
  .number()
  .int("Los partes se registran en MINUTOS enteros")
  .refine((v) => v !== 0, "Un parte de 0 minutos no dice nada")
  .refine((v) => Math.abs(v) <= 1440, "Un parte no puede pasar de 1 440 minutos (24 h) en una sola línea")

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

export const listTimeEntriesSchema = z
  .object({
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    employeeId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    costCenterId: uuidSchema.optional(),
    status: timeStatusSchema.optional(),
    productiveOnly: z.boolean().optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "El periodo empieza antes de terminar",
    path: ["to"],
  })

/** El calendario del mes: un mes concreto y, si se quiere, un solo empleado. */
export const timeCalendarSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, "El mes tiene el formato AAAA-MM"),
    employeeId: uuidSchema.optional(),
  })
  .strict()

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras
// ─────────────────────────────────────────────────────────────────────────────

export const timeEntrySchema = z
  .object({
    employeeId: uuidSchema,
    date: localDateSchema,
    projectId: uuidSchema.nullish(),
    costCenterId: uuidSchema.nullish(),
    businessLineId: uuidSchema.nullish(),
    minutes: minutesSchema,
    productive: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.projectId == null) === (v.costCenterId == null)) {
      ctx.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Un parte de horas va a UN proyecto o a UN centro de coste, nunca a los dos ni a ninguno",
      })
    }
  })

export const createTimeEntriesSchema = z
  .object({ rows: z.array(timeEntrySchema).min(1, "No hay ningún parte que registrar").max(1000) })
  .strict()

export const approveTimeEntriesSchema = z
  .object({ ids: z.array(uuidSchema).min(1, "No hay ningún parte seleccionado").max(2000) })
  .strict()

/**
 * La corrección es un **contra-apunte**: los minutos que se restan del parte
 * aprobado, con su motivo. El signo lo decide el modelo a partir del original.
 */
export const correctTimeEntrySchema = z
  .object({
    entryId: uuidSchema,
    minutes: z
      .number()
      .int("Los minutos del contra-apunte son enteros")
      .refine((v) => v !== 0, "Un contra-apunte de 0 minutos no corrige nada"),
    reason: timeReasonSchema,
  })
  .strict()

/** Cabecera del CSV de partes. Lista blanca: nada fuera de aquí se lee. */
export const TIME_CSV_COLUMNS = [
  "empleado",
  "fecha",
  "proyecto",
  "centro_coste",
  "minutos",
  "productivo",
  "nota",
] as const

export const MAX_TIME_CSV_BYTES = 5 * 1024 * 1024

export const importTimeCsvSchema = z
  .object({
    csv: z.string().min(1, "El fichero está vacío").max(MAX_TIME_CSV_BYTES, "El fichero pasa de 5 MB"),
    delimiter: z.enum([",", ";"]).default(";"),
    dryRun: z.boolean().default(false),
  })
  .strict()

export type TimeEntryFormInput = z.infer<typeof timeEntrySchema>
