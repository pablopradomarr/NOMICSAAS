/**
 * E10 · T14 — Validación de entrada de empleados, tarifas y plantilla (§4.2).
 *
 * La `basis` de una tarifa es **obligatoria y explícita** (Q-1, ADR-0018 D3):
 * `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` difieren en torno al 31,9 %, así que
 * un coste-hora sin su base no es una cifra, es un malentendido. El conflicto de
 * `COSTE_TOTAL_CON_ESTRUCTURA` con reglas de actividad vigentes lo comprueba el
 * modelo (`RATE_BASIS_CONFLICT`): depende de datos, no de la forma.
 */

import { localDateSchema, uuidSchema } from "@/forms/analytics"
import { z } from "zod"

export const employeeRateBasisSchema = z.enum([
  "BRUTO_SIN_SS",
  "COSTE_EMPRESA_CON_SS",
  "COSTE_TOTAL_CON_ESTRUCTURA",
])

export const derivationScopeSchema = z.enum(["COST_CENTER", "EMPLOYEE"])

/** Un FTE se declara en milésimas: 1 000 = jornada completa, 500 = media. */
const fteMilliSchema = z
  .number()
  .int("El FTE se declara en milésimas enteras (1 000 = jornada completa)")
  .min(0)
  .max(10_000)

// ─────────────────────────────────────────────────────────────────────────────
// Empleados
// ─────────────────────────────────────────────────────────────────────────────

export const listEmployeesSchema = z
  .object({
    includeArchived: z.boolean().optional(),
    costCenterId: uuidSchema.optional(),
    rateAt: localDateSchema.optional(),
  })
  .strict()

export const createEmployeeSchema = z
  .object({
    code: z.string().trim().min(1, "El código del empleado es obligatorio").max(24),
    name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
    counterpartyId: uuidSchema.nullish(),
    userId: uuidSchema.nullish(),
    defaultCostCenterId: uuidSchema.nullish(),
    fteMilli: fteMilliSchema.optional(),
    hireDate: localDateSchema.nullish(),
    endDate: localDateSchema.nullish(),
  })
  .strict()
  .refine((v) => !v.hireDate || !v.endDate || v.hireDate <= v.endDate, {
    message: "La fecha de baja no puede ser anterior a la de alta",
    path: ["endDate"],
  })

export const updateEmployeeSchema = createEmployeeSchema
  .innerType()
  .omit({ code: true })
  .partial()
  .extend({ employeeId: uuidSchema })
  .strict()

export const archiveEmployeeSchema = z.object({ employeeId: uuidSchema }).strict()

// ─────────────────────────────────────────────────────────────────────────────
// Tarifas
// ─────────────────────────────────────────────────────────────────────────────

export const listEmployeeRatesSchema = z
  .object({
    employeeId: uuidSchema.optional(),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
  })
  .strict()

export const createEmployeeRateSchema = z
  .object({
    employeeId: uuidSchema,
    hourlyCostCents: z
      .number()
      .int("El coste-hora son céntimos enteros")
      .positive("El coste-hora es > 0: sin tarifa vigente la cifra es NO EVALUABLE, nunca 0"),
    /** Obligatoria y explícita (Q-1): la base viaja con la cifra. */
    basis: employeeRateBasisSchema,
    validFrom: localDateSchema,
    validTo: localDateSchema.nullish(),
    note: z.string().trim().max(500).nullish(),
    /** Con la propuesta de nómina detrás, sus términos viajan a `derivation`. */
    fromProposal: z
      .object({
        scope: derivationScopeSchema,
        costCenterId: uuidSchema.nullish(),
        employeeId: uuidSchema.nullish(),
        periodStart: localDateSchema,
        periodEnd: localDateSchema,
      })
      .strict()
      .nullish(),
  })
  .strict()
  .refine((v) => !v.validTo || v.validFrom <= v.validTo, {
    message: "La vigencia empieza antes de terminar",
    path: ["validTo"],
  })

export const proposeHourlyCostSchema = z
  .object({
    scope: derivationScopeSchema,
    costCenterId: uuidSchema.optional(),
    employeeId: uuidSchema.optional(),
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    basis: employeeRateBasisSchema.optional(),
    minCoverageBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "COST_CENTER" && !v.costCenterId) {
      ctx.addIssue({ code: "custom", path: ["costCenterId"], message: "La derivación por CECO necesita el centro de coste" })
    }
    if (v.scope === "EMPLOYEE" && !v.employeeId) {
      ctx.addIssue({ code: "custom", path: ["employeeId"], message: "La derivación individual necesita el empleado" })
    }
    if (v.periodStart > v.periodEnd) {
      ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "El periodo empieza antes de terminar" })
    }
  })

/**
 * Aplicar una propuesta: el acto es de un **ADMIN** y queda en `AuditLog` con
 * sus términos. La propuesta por sí sola no cambia ninguna tarifa.
 */
export const applyHourlyCostSchema = proposeHourlyCostSchema
  .innerType()
  .extend({
    employeeIds: z.array(uuidSchema).min(1, "No hay ningún empleado al que aplicar la tarifa").max(500),
    validFrom: localDateSchema,
    validTo: localDateSchema.nullish(),
  })
  .strict()

// ─────────────────────────────────────────────────────────────────────────────
// Plantilla (FTE·mes, Q-7)
// ─────────────────────────────────────────────────────────────────────────────

export const listHeadcountSchema = z
  .object({
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    costCenterId: uuidSchema.optional(),
  })
  .strict()

export const upsertHeadcountSchema = z
  .object({
    costCenterId: uuidSchema,
    /** El snapshot es a FIN de mes: el CHECK `headcount_last_day` lo exige. */
    periodEnd: localDateSchema,
    fteMilli: fteMilliSchema,
    headcount: z.number().int("La plantilla se cuenta en personas enteras").min(0).max(100_000),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()

export const deriveHeadcountSchema = z.object({ periodEnd: localDateSchema }).strict()

export type CreateEmployeeRateFormInput = z.infer<typeof createEmployeeRateSchema>
export type ProposeHourlyCostFormInput = z.infer<typeof proposeHourlyCostSchema>
