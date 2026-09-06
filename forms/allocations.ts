/**
 * E5 · T10 — Validación de entrada de la liquidación de CECOs
 * (`docs/design/E5-liquidacion.md` §4.2). Un schema por operación.
 *
 * Los `HOURS` / `HEADCOUNT` **no están en el enum**: se rechazan aquí, en la
 * acción y en la BD (CHECK `allocation_rules_driver_available`). En ningún
 * camino puede quedar una regla inerte repartiendo 0 € en silencio.
 */

import { localDateSchema, uuidSchema } from "@/forms/analytics"
import { z } from "zod"

/** Motivo de una reversión o de un cambio de política: ≥ 10 caracteres. */
export const MIN_ALLOCATION_REASON = 10

export const allocationReasonSchema = z
  .string()
  .trim()
  .min(MIN_ALLOCATION_REASON, `El motivo es obligatorio y debe tener al menos ${MIN_ALLOCATION_REASON} caracteres`)
  .max(1000)

export const allocPeriodSchema = z.enum(["MONTH", "QUARTER", "YEAR"])
export const targetKindSchema = z.enum(["PROJECTS", "BUSINESS_LINES", "COST_CENTERS", "MIXED"])
export const zeroBaseFallbackSchema = z.enum(["SKIP_WARN", "EQUAL", "YTD", "PRIOR_PERIOD"])

/** Los cinco drivers VIVOS. `HOURS` y `HEADCOUNT` llegan en E10 (ADR-0013). */
export const driverSchema = z.enum(["FIXED_PERCENT", "REVENUE_SHARE", "DIRECT_COST_SHARE", "EQUAL", "MANUAL"])

/** Cualquier valor del enum de BD, para poder DAR UN MENSAJE en vez de «no válido». */
export const anyDriverSchema = z.enum([
  "FIXED_PERCENT",
  "REVENUE_SHARE",
  "DIRECT_COST_SHARE",
  "HOURS",
  "HEADCOUNT",
  "EQUAL",
  "MANUAL",
])

const bpsSchema = z.number().int().min(0, "Los puntos básicos no pueden ser negativos").max(10000, "El máximo es 10000 bps (100 %)")

export const allocationTargetFilterSchema = z
  .object({
    projectStatus: z.array(z.enum(["PLANNED", "ACTIVE", "CLOSED"])).optional(),
    businessLineCodes: z.array(z.string().trim().max(24)).optional(),
    costCenterCodes: z.array(z.string().trim().max(24)).optional(),
    excludeProjectCodes: z.array(z.string().trim().max(24)).optional(),
  })
  .strict()

/** Exactamente UN destino y exactamente UN valor (CHECK espejo en la BD). */
export const allocationRuleTargetSchema = z
  .object({
    projectId: uuidSchema.nullish(),
    businessLineId: uuidSchema.nullish(),
    costCenterId: uuidSchema.nullish(),
    percentBps: bpsSchema.nullish(),
    amountCents: z.number().int().nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const destinations = [value.projectId, value.businessLineId, value.costCenterId].filter(
      (v) => v !== null && v !== undefined
    ).length
    if (destinations !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Cada destino apunta a exactamente un proyecto, una línea de negocio o un centro de coste",
      })
    }
    const hasPercent = value.percentBps !== null && value.percentBps !== undefined
    const hasAmount = value.amountCents !== null && value.amountCents !== undefined
    if (hasPercent === hasAmount) {
      ctx.addIssue({
        code: "custom",
        message: "Un destino lleva porcentaje (drivers de reparto) o importe (MANUAL), nunca los dos ni ninguno",
      })
    }
  })

const ruleShape = {
  code: z
    .string()
    .trim()
    .min(1, "El código de la regla es obligatorio")
    .max(24, "El código no puede pasar de 24 caracteres")
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "El código admite letras, dígitos, punto, guion y guion bajo"),
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  sourceCostCenterId: uuidSchema,
  targetKind: targetKindSchema,
  driver: anyDriverSchema,
  period: allocPeriodSchema,
  priority: z.number().int().min(0, "La prioridad no puede ser negativa"),
  sourceShareBps: bpsSchema,
  zeroBaseFallback: zeroBaseFallbackSchema.default("SKIP_WARN"),
  targetFilter: allocationTargetFilterSchema.nullish(),
  validFrom: localDateSchema,
  validTo: localDateSchema.nullish(),
  targets: z.array(allocationRuleTargetSchema).max(200).default([]),
}

/**
 * `Σ percentBps = 10000` (I-E5-2) se valida ya aquí: dejarlo sólo al motor haría
 * que la regla se guardara y el run fallase después, que es el fallo diferido
 * que la capa de fiabilidad prohíbe.
 */
const withRuleInvariants = <T extends z.ZodTypeAny>(schema: T): T =>
  schema.superRefine((value: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const driver = value.driver as string | undefined
    const targets = (value.targets ?? []) as { percentBps?: number | null; amountCents?: number | null }[]
    if (driver === "HOURS" || driver === "HEADCOUNT") {
      ctx.addIssue({
        code: "custom",
        path: ["driver"],
        message:
          driver === "HOURS"
            ? "El driver HORAS necesita partes de horas, que llegan en E10. Elige otro driver o deja el centro de coste sin liquidar"
            : "El driver PLANTILLA necesita las asignaciones de personal, que llegan en E10. Elige otro driver o deja el centro de coste sin liquidar",
      })
    }
    if (driver === "FIXED_PERCENT") {
      const sum = targets.reduce((a, t) => a + (t.percentBps ?? 0), 0)
      if (sum !== 10000) {
        ctx.addIssue({
          code: "custom",
          path: ["targets"],
          message: `Los destinos suman el ${(sum / 100).toFixed(2)} %: una regla de porcentaje fijo tiene que repartir exactamente el 100 %`,
        })
      }
    }
    if (driver === "MANUAL" && targets.length === 0) {
      ctx.addIssue({ code: "custom", path: ["targets"], message: "Una regla manual necesita al menos un importe declarado" })
    }
    if (driver !== "FIXED_PERCENT" && driver !== "MANUAL" && targets.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Los drivers calculados no llevan destinos explícitos: el conjunto de receptores sale del filtro y la base, del diario",
      })
    }
    const validTo = value.validTo as string | null | undefined
    const validFrom = value.validFrom as string
    if (validTo && validTo < validFrom) {
      ctx.addIssue({ code: "custom", path: ["validTo"], message: "La fecha de fin de vigencia no puede ser anterior a la de inicio" })
    }
  }) as unknown as T

export const allocationRuleCreateSchema = withRuleInvariants(z.object(ruleShape).strict())

export const allocationRuleSupersedeSchema = z
  .object({
    ruleId: uuidSchema,
    /** La sucesora empieza aquí; la vigente se cierra el día anterior. */
    validFrom: localDateSchema,
    reason: allocationReasonSchema,
    changes: z
      .object({
        name: ruleShape.name.optional(),
        sourceCostCenterId: uuidSchema.optional(),
        targetKind: targetKindSchema.optional(),
        driver: driverSchema.optional(),
        period: allocPeriodSchema.optional(),
        priority: ruleShape.priority.optional(),
        sourceShareBps: bpsSchema.optional(),
        zeroBaseFallback: zeroBaseFallbackSchema.optional(),
        targetFilter: allocationTargetFilterSchema.nullish(),
        validTo: localDateSchema.nullish(),
        targets: z.array(allocationRuleTargetSchema).max(200).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export const allocationRuleCloseSchema = z
  .object({ ruleId: uuidSchema, validTo: localDateSchema, reason: allocationReasonSchema })
  .strict()

export const allocationRuleListSchema = z
  .object({ includeClosed: z.boolean().optional(), period: allocPeriodSchema.optional() })
  .strict()
  .default({})

/** Un periodo de liquidación: el mismo objeto para simular, sellar y listar. */
export const allocationPeriodSchema = z
  .object({ periodKind: allocPeriodSchema, periodStart: localDateSchema, periodEnd: localDateSchema })
  .strict()
  .refine((v) => v.periodEnd >= v.periodStart, { message: "El periodo termina antes de empezar", path: ["periodEnd"] })

export const allocationSealSchema = z
  .object({
    periodKind: allocPeriodSchema,
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    /** Los tres sellos que el usuario vio en la simulación (§4.1). */
    expectedHashes: z
      .object({
        ledgerHash: z.string().length(64),
        dimensionsHash: z.string().length(64),
        rulesHash: z.string().length(64),
      })
      .strict()
      .nullish(),
    /** Rerun: el run vigente del periodo pasa a `SUPERSEDED`. */
    supersede: z.boolean().default(false),
    reason: allocationReasonSchema.nullish(),
  })
  .strict()
  .refine((v) => v.periodEnd >= v.periodStart, { message: "El periodo termina antes de empezar", path: ["periodEnd"] })

export const allocationRunListSchema = z
  .object({ fiscalYearId: uuidSchema.optional(), periodKind: allocPeriodSchema.optional() })
  .strict()
  .default({})

export const allocationRunIdSchema = z.object({ runId: uuidSchema }).strict()

export const allocationReverseSchema = z.object({ runId: uuidSchema, reason: allocationReasonSchema }).strict()

export const allocationDiffSchema = z.object({ runId: uuidSchema, againstRunId: uuidSchema }).strict()

/**
 * El CONJUNTO de reglas de un CECO fuente. Un reparto fraccionado (30/70) se
 * declara entero: `Σ sourceShareBps = 10000` se juzga sobre el conjunto, nunca
 * sobre una regla suelta.
 */
export const allocationRuleSetCreateSchema = z
  .array(allocationRuleCreateSchema)
  .min(1, "Declara al menos una regla")
  .max(20, "Un centro de coste no reparte su saldo en más de veinte reglas")

export type AllocationRuleCreateInput = z.infer<typeof allocationRuleCreateSchema>
export type AllocationSealInput = z.infer<typeof allocationSealSchema>
