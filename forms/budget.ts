/**
 * E10 · T14 — Validación de entrada del presupuesto (`docs/design/
 * E10-presupuesto-horas.md` §4.2). Un schema por operación.
 *
 * Tres reglas que se aplican **aquí** y no en el modelo, porque son del borde:
 *
 *  · **El mes de una celda es siempre el día 1.** El CHECK de la BD lo exige y
 *    el `budgetHash` se calcula sobre esa forma canónica: una celda de
 *    `2026-03-15` rompería la reproducibilidad del sello sin decir por qué.
 *  · **La dimensión es EXCLUYENTE** (O-A6): un proyecto o un centro de coste,
 *    nunca los dos ni ninguno. Se rechaza en zod, en el modelo y en el CHECK.
 *  · **El signo NO se valida aquí**: depende del tipo analítico y de las
 *    excepciones (`signException`), que son reglas contables y viven en
 *    `lib/budget/hash.ts` (`checkBudgetSign`). zod comprueba forma, no doctrina.
 */

import { localDateSchema, uuidSchema } from "@/forms/analytics"
import { z } from "zod"

/** Motivo de verdad: diez caracteres es el mínimo para que diga algo. */
export const MIN_BUDGET_REASON = 10

export const budgetReasonSchema = z
  .string()
  .trim()
  .min(MIN_BUDGET_REASON, `El motivo es obligatorio y debe tener al menos ${MIN_BUDGET_REASON} caracteres`)
  .max(1000)

/** Primer día del mes: la forma canónica de una celda de presupuesto. */
export const monthStartSchema = localDateSchema.refine((v) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(v), {
  message: "El mes de una celda de presupuesto es siempre el día 1 de un mes real (AAAA-MM-01)",
})

export const budgetScenarioSchema = z.enum(["BASE", "REVISADO"])
export const budgetStatusSchema = z.enum(["BORRADOR", "VIGENTE", "SUSTITUIDO"])
export const analyticTypeSchema = z.enum([
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "NO_ANALITICO",
])

const centsSchema = z.number().int("Los importes son céntimos enteros").finite()

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

export const budgetListSchema = z
  .object({
    fiscalYearId: uuidSchema.optional(),
    status: budgetStatusSchema.optional(),
  })
  .strict()

export const budgetIdSchema = z.object({ budgetId: uuidSchema }).strict()

/** Diff entre dos versiones: se comparan versiones DISTINTAS del mismo ejercicio. */
export const budgetDiffSchema = z
  .object({ budgetId: uuidSchema, againstBudgetId: uuidSchema })
  .strict()
  .refine((v) => v.budgetId !== v.againstBudgetId, {
    message: "El diff compara dos versiones distintas",
    path: ["againstBudgetId"],
  })

// ─────────────────────────────────────────────────────────────────────────────
// Versiones
// ─────────────────────────────────────────────────────────────────────────────

export const createBudgetVersionSchema = z
  .object({
    fiscalYearId: uuidSchema,
    scenario: budgetScenarioSchema,
    name: z.string().trim().min(1, "El nombre de la versión es obligatorio").max(120),
    note: z.string().trim().max(1000).nullish(),
    validFrom: localDateSchema,
    /** O-E10-9: con valor, la versión es PARCIAL y sustituye desde ese mes. */
    partialFrom: monthStartSchema.nullish(),
    copyFromBudgetId: uuidSchema.nullish(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scenario === "BASE" && v.partialFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["partialFrom"],
        message: "La versión BASE cubre el ejercicio entero: `partialFrom` es de las revisiones (O-E10-9)",
      })
    }
  })

export const sealBudgetSchema = z
  .object({ budgetId: uuidSchema, validFrom: localDateSchema.optional() })
  .strict()

export const supersedeBudgetSchema = z
  .object({ budgetId: uuidSchema, supersededById: uuidSchema, reason: budgetReasonSchema })
  .strict()
  .refine((v) => v.budgetId !== v.supersededById, {
    message: "Una versión no se sustituye a sí misma",
    path: ["supersededById"],
  })

// ─────────────────────────────────────────────────────────────────────────────
// Celdas
// ─────────────────────────────────────────────────────────────────────────────

export const budgetCellSchema = z
  .object({
    month: monthStartSchema,
    accountCode: z.string().trim().min(1).max(20).nullish(),
    projectId: uuidSchema.nullish(),
    costCenterId: uuidSchema.nullish(),
    businessLineId: uuidSchema.nullish(),
    analyticType: analyticTypeSchema,
    amountCents: centsSchema,
    signException: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // O-A6: la dimensión es EXCLUYENTE, y se dice aquí para que el usuario lea
    // un mensaje en vez de un 23514 del CHECK.
    if ((v.projectId == null) === (v.costCenterId == null)) {
      ctx.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Una celda de presupuesto es de UN proyecto o de UN centro de coste, nunca de los dos ni de ninguno",
      })
    }
  })

/** §9: el guardado es POR LOTES. 5 000 celdas por llamada es el techo del import. */
export const upsertBudgetCellsSchema = z
  .object({
    budgetId: uuidSchema,
    cells: z.array(budgetCellSchema).min(1, "No hay ninguna celda que guardar").max(5000),
  })
  .strict()

export const deleteBudgetCellsSchema = z
  .object({
    budgetId: uuidSchema,
    cellIds: z.array(uuidSchema).min(1, "No hay ninguna celda que borrar").max(5000),
  })
  .strict()

export const budgetHoursSchema = z
  .object({
    month: monthStartSchema,
    projectId: uuidSchema.nullish(),
    costCenterId: uuidSchema.nullish(),
    employeeId: uuidSchema.nullish(),
    minutes: z.number().int("Las horas presupuestadas se guardan en MINUTOS enteros (D6)").min(0).max(10_000_000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.projectId == null) === (v.costCenterId == null)) {
      ctx.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Las horas presupuestadas van a UN proyecto o a UN centro de coste",
      })
    }
  })

export const upsertBudgetHoursSchema = z
  .object({ budgetId: uuidSchema, rows: z.array(budgetHoursSchema).min(1).max(5000) })
  .strict()

// ─────────────────────────────────────────────────────────────────────────────
// Import CSV — el fichero se parsea EN SERVIDOR (§10)
// ─────────────────────────────────────────────────────────────────────────────

/** Cabecera del CSV de presupuesto. Lista blanca: nada fuera de aquí se lee. */
export const BUDGET_CSV_COLUMNS = [
  "mes",
  "cuenta",
  "tipo_analitico",
  "proyecto",
  "centro_coste",
  "importe_centimos",
  "excepcion_signo",
  "nota",
] as const

/** 5 MB de texto: el mismo endurecimiento que las subidas de E1. */
export const MAX_BUDGET_CSV_BYTES = 5 * 1024 * 1024

export const importBudgetCsvSchema = z
  .object({
    budgetId: uuidSchema,
    csv: z
      .string()
      .min(1, "El fichero está vacío")
      .max(MAX_BUDGET_CSV_BYTES, "El fichero pasa de 5 MB: pártelo en lotes"),
    delimiter: z.enum([",", ";"]).default(";"),
    /** Con `true` se valida y se informa, y **no se escribe nada**. */
    dryRun: z.boolean().default(false),
  })
  .strict()

// ─────────────────────────────────────────────────────────────────────────────
// Amortización presupuestada (Q-4) e informe
// ─────────────────────────────────────────────────────────────────────────────

export const proposeDepreciationBudgetSchema = z.object({ fiscalYearId: uuidSchema }).strict()

export const budgetGranularitySchema = z.enum(["MONTH", "QUARTER", "YEAR", "YTD"])

export const budgetVsActualSchema = z
  .object({
    fiscalYearId: uuidSchema,
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    granularity: budgetGranularitySchema.optional(),
    withAllocations: z.boolean().optional(),
    budgetId: uuidSchema.optional(),
    comparative: z.boolean().optional(),
    noCache: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.periodStart <= v.periodEnd, {
    message: "El periodo empieza antes de terminar",
    path: ["periodEnd"],
  })

/** El drill-down de una celda de desviación: nivel, columna y, si acota, mes. */
export const budgetCellDetailSchema = z
  .object({
    budgetId: uuidSchema,
    level: z.enum(["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"]),
    column: z.string().trim().min(1).max(64),
    month: monthStartSchema.nullish(),
  })
  .strict()

export const exportBudgetRunSchema = z
  .object({ runId: uuidSchema, format: z.enum(["csv", "xlsx", "pdf"]) })
  .strict()

export type BudgetCellFormInput = z.infer<typeof budgetCellSchema>
export type BudgetVsActualFormInput = z.infer<typeof budgetVsActualSchema>
export type ImportBudgetCsvFormInput = z.infer<typeof importBudgetCsvSchema>
