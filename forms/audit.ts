/**
 * E7 · T11 — Validación de entrada de la pestaña Auditoría (`zod`).
 *
 * Nada llega a `models/audit.ts` ni a `models/store-sweep.ts` sin pasar por
 * aquí. Dos cosas que este fichero decide y que no son cosmética:
 *
 *  · **El alcance es coherente o no existe**: un barrido `FISCAL_YEAR` sin
 *    ejercicio y un `PERIOD` sin fechas son las dos formas de sellar una foto
 *    que luego nadie sabe interpretar (y la base tiene el mismo CHECK).
 *  · **Los motivos de gobierno llevan ≥ 10 caracteres**: forzar o levantar una
 *    revisión sin explicar por qué no es gobierno, es ruido.
 */

import { z } from "zod"

import { localDateSchema } from "@/forms/reports"
import { CheckFamily, ReportType } from "@/prisma/client"

export const auditScopeKindSchema = z.enum(["ORGANIZATION", "FISCAL_YEAR", "PERIOD"])
export const auditTriggerSchema = z.enum(["MANUAL", "SCHEDULED", "POST_CLOSE", "POST_IMPORT"])

export const runInvariantsAuditSchema = z
  .object({
    scopeKind: auditScopeKindSchema.default("FISCAL_YEAR"),
    fiscalYearId: z.string().uuid().optional(),
    periodStart: localDateSchema.optional(),
    periodEnd: localDateSchema.optional(),
    refDate: localDateSchema.optional(),
    /** Sin `persist` es una consulta; con él, una foto sellada (P3). */
    persist: z.boolean().default(true),
  })
  .refine((v) => v.scopeKind !== "FISCAL_YEAR" || v.fiscalYearId !== undefined, {
    message: "Un barrido de ejercicio necesita el ejercicio",
    path: ["fiscalYearId"],
  })
  .refine((v) => v.scopeKind !== "PERIOD" || (v.periodStart !== undefined && v.periodEnd !== undefined), {
    message: "Un barrido de periodo necesita las dos fechas",
    path: ["periodEnd"],
  })
  .refine((v) => v.periodStart === undefined || v.periodEnd === undefined || v.periodEnd >= v.periodStart, {
    message: "La fecha de fin no puede ser anterior a la de inicio",
    path: ["periodEnd"],
  })

export const invariantRunIdSchema = z.object({ id: z.string().uuid() })

export const diffRunsSchema = z.object({ a: z.string().uuid(), b: z.string().uuid() })

export const listInvariantRunsSchema = z.object({
  scopeKind: auditScopeKindSchema.optional(),
  fiscalYearId: z.string().uuid().optional(),
  take: z.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
})

/** Forzar revisión (E6) con lo que E7 le añade: el run y la familia (O-21). */
export const forceReviewAuditSchema = z.object({
  periodStart: localDateSchema,
  periodEnd: localDateSchema,
  scope: z.nativeEnum(ReportType).nullish(),
  reason: z.string().trim().min(10, "Forzar la revisión de un periodo exige un motivo de al menos 10 caracteres"),
  invariantRunId: z.string().uuid().optional(),
  checkFamily: z.nativeEnum(CheckFamily).optional(),
})

export const clearReviewAuditSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(10, "Levantar la revisión de un periodo exige un motivo de al menos 10 caracteres"),
})

export const cancelSweepSchema = z.object({ id: z.string().uuid() })

/**
 * Prueba de detección (§7). El alcance es el mismo que el del barrido, y **no
 * escribe nada**: por eso no lleva ni motivo ni idempotencia.
 */
export const detectionTestSchema = z.object({
  fiscalYearId: z.string().uuid().optional(),
  refDate: localDateSchema.optional(),
})

export const auditLogFilterSchema = z.object({
  entity: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  userId: z.string().uuid().optional(),
  since: localDateSchema.optional(),
  until: localDateSchema.optional(),
  take: z.number().int().min(1).max(200).default(50),
})
