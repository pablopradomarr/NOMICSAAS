/**
 * E4 · T12 — Validación de entrada de la analítica
 * (`docs/design/E4-analitica.md` §4). Un schema por operación.
 */

import { MIN_RECLASSIFY_REASON } from "@/lib/analytics/reclassify"
import { z } from "zod"

export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
export const uuidSchema = z.string().uuid("Identificador no válido")

const codeSchema = z
  .string()
  .trim()
  .min(1, "El código es obligatorio")
  .max(24, "El código no puede pasar de 24 caracteres")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "El código admite letras, dígitos, punto, guion y guion bajo")

const nameSchema = z.string().trim().min(1, "El nombre es obligatorio").max(120)
const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "El color debe ser hexadecimal (#RRGGBB)")

/** Motivo obligatorio de toda operación que reescribe analítica histórica. */
export const reasonSchema = z
  .string()
  .trim()
  .min(MIN_RECLASSIFY_REASON, `El motivo es obligatorio y debe tener al menos ${MIN_RECLASSIFY_REASON} caracteres`)
  .max(512)

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

export const marginLevelSchema = z.enum(["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"])

/** CHECK `cost_centers_margin_level`: un CECO se descuenta en MC3 o en EBITDA. */
export const costCenterMarginLevelSchema = z.enum(["MC3", "EBITDA"])

/** MLC-5: `nonAnalyticLevel` nunca contamina los márgenes de proyecto. */
export const nonAnalyticLevelSchema = z.enum(["EBITDA", "EBIT", "BAI"])

/** `SIN_ASIGNAR` NO está: ese kind sólo lo crea la semilla (R-A8). */
export const costCenterKindSchema = z.enum([
  "MARKETING_VENTAS",
  "OPERACIONES_INDIRECTAS",
  "G_A",
  "DESARROLLO_PRODUCTO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "OTROS",
])

// ── Líneas de negocio ────────────────────────────────────────────────────────

export const businessLineCreateSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  color: colorSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const businessLineUpdateSchema = z.object({
  id: uuidSchema,
  name: nameSchema.optional(),
  color: colorSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
})

// ── Proyectos ────────────────────────────────────────────────────────────────

export const projectCreateSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    businessLineId: uuidSchema,
    counterpartyId: uuidSchema.nullish(),
    status: z.enum(["PLANNED", "ACTIVE"]).optional(),
    startDate: localDateSchema.nullish(),
    endDate: localDateSchema.nullish(),
    budgetRevenueCents: z.number().int().min(0).nullish(),
    budgetCostCents: z.number().int().min(0).nullish(),
    color: colorSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((p) => !p.startDate || !p.endDate || p.endDate >= p.startDate, {
    message: "La fecha de fin no puede ser anterior a la de inicio",
    path: ["endDate"],
  })

export const projectUpdateSchema = z.object({
  id: uuidSchema,
  name: nameSchema.optional(),
  businessLineId: uuidSchema.optional(),
  counterpartyId: uuidSchema.nullish(),
  startDate: localDateSchema.nullish(),
  endDate: localDateSchema.nullish(),
  budgetRevenueCents: z.number().int().min(0).nullish(),
  budgetCostCents: z.number().int().min(0).nullish(),
  color: colorSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const projectCloseSchema = z.object({ id: uuidSchema, closedAt: localDateSchema })
export const projectReopenSchema = z.object({ id: uuidSchema, reason: reasonSchema })

// ── Centros de coste ─────────────────────────────────────────────────────────

export const costCenterCreateSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  kind: costCenterKindSchema,
  marginLevel: costCenterMarginLevelSchema,
  allocatable: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const costCenterUpdateSchema = z.object({
  id: uuidSchema,
  name: nameSchema.optional(),
  /** `kind`, `marginLevel` y `allocatable` mueven importe: sólo ADMIN. */
  kind: costCenterKindSchema.optional(),
  marginLevel: costCenterMarginLevelSchema.optional(),
  allocatable: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const archiveDimensionSchema = z.object({
  kind: z.enum(["BusinessLine", "Project", "CostCenter"]),
  id: uuidSchema,
  reason: reasonSchema,
})

// ── Configuración ────────────────────────────────────────────────────────────

export const marginLevelConfigSchema = z.object({
  validFrom: localDateSchema,
  rows: z
    .array(
      z.object({
        level: marginLevelSchema,
        label: z.string().trim().min(1).max(60),
        analyticTypes: z.array(analyticTypeSchema),
        isVisible: z.boolean().optional(),
      })
    )
    .length(8, "Los 8 niveles existen siempre (MLC-3)"),
})

export const analyticsPolicySchema = z.object({
  analyticsRequired: z.boolean().optional(),
  nonAnalyticLevel: nonAnalyticLevelSchema.optional(),
})

export const accountAnalyticTypeSchema = z.object({
  accountCode: z.string().trim().min(1).max(12),
  analyticType: analyticTypeSchema.nullable(),
  reason: reasonSchema,
})

// ── Reclasificación (ADR-0010) ───────────────────────────────────────────────

export const reclassifySchema = z.object({
  reason: reasonSchema,
  targets: z
    .array(
      z
        .object({
          lineId: uuidSchema,
          projectId: uuidSchema.nullish(),
          costCenterId: uuidSchema.nullish(),
          analyticType: analyticTypeSchema.nullish(),
        })
        .refine((t) => !(t.projectId && t.costCenterId), {
          message: "Una línea lleva proyecto O centro de coste, nunca los dos",
          path: ["costCenterId"],
        })
    )
    .min(1, "No hay ninguna línea que reclasificar")
    .max(500, "Como máximo 500 líneas por reclasificación"),
})

// ── Informe ──────────────────────────────────────────────────────────────────

export const analyticPnlSchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    fiscalYearId: uuidSchema.optional(),
  })
  .refine((p) => p.to >= p.from, { message: "El periodo termina antes de empezar", path: ["to"] })

export const dimensionListSchema = z.object({ includeArchived: z.boolean().optional() })
