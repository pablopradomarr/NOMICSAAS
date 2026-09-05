/**
 * E6 · T14 — Validación de entrada de los informes (`zod`).
 *
 * Un schema por cosa. Nada llega a `models/reports.ts` sin pasar por aquí: los
 * parámetros del informe entran en `paramsHash` y, por tanto, en la clave de
 * caché, así que un parámetro mal tipado no es un error de formulario, es un
 * informe que se sirve de la caché equivocada.
 */

import { z } from "zod"

import { kpiThresholdSchema, reviewThresholdsSchema } from "@/lib/ledger/report-run"
import { ComparativeBasis, PgcVariant, ReportType, Seal } from "@/prisma/client"

/** `YYYY-MM-DD` real, no «una cadena con guiones». */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser YYYY-MM-DD")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number)
    if (m < 1 || m > 12 || d < 1) return false
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const dim = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31
    return d <= dim
  }, "Esa fecha no existe en el calendario")

const period = {
  periodStart: localDateSchema,
  periodEnd: localDateSchema,
  fiscalYearId: z.string().uuid().optional(),
}

const periodOrder = <T extends { periodStart: string; periodEnd: string }>(schema: z.ZodType<T>) =>
  schema.refine((v) => v.periodEnd >= v.periodStart, {
    message: "La fecha de fin no puede ser anterior a la de inicio",
    path: ["periodEnd"],
  })

export const balanceSnapshotSchema = z.enum(["PRE_REGULARIZACION", "POST_REGULARIZACION", "POST_CIERRE"])

export const balanceParamsSchema = periodOrder(
  z.object({
    ...period,
    // La foto y la variante son PARÁMETROS, no tipos de informe: viajan en
    // `params` y entran en `paramsHash` (O-5).
    snapshot: balanceSnapshotSchema.default("PRE_REGULARIZACION"),
    variant: z.nativeEnum(PgcVariant).optional(),
    comparativeBasis: z.nativeEnum(ComparativeBasis).optional(),
  })
)

export const pygParamsSchema = periodOrder(
  z.object({
    ...period,
    variant: z.nativeEnum(PgcVariant).optional(),
    comparativeBasis: z.nativeEnum(ComparativeBasis).optional(),
  })
)

export const cashflowParamsSchema = periodOrder(
  z.object({
    ...period,
    method: z.enum(["DIRECTO", "INDIRECTO"]).default("DIRECTO"),
    granularity: z.enum(["MENSUAL", "ANUAL"]).default("MENSUAL"),
    view: z.enum(["GESTION", "EFE_OFICIAL"]).default("GESTION"),
  })
)

export const dashboardParamsSchema = periodOrder(
  z.object({
    ...period,
    /** `refDate` decide el aging. Va en `params` → en `paramsHash`. */
    refDate: localDateSchema,
    variant: z.nativeEnum(PgcVariant).optional(),
  })
)

export const listRunsSchema = z.object({
  type: z.nativeEnum(ReportType).optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  seal: z.nativeEnum(Seal).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
})

export const exportReportSchema = z.object({
  runId: z.string().uuid("El informe a exportar no es un identificador válido"),
  format: z.enum(["csv", "xlsx", "pdf"]),
})

/** Motivo de verdad: diez caracteres es el mínimo para que diga algo. */
const reasonSchema = z
  .string()
  .trim()
  .min(10, "El motivo debe tener al menos 10 caracteres")
  .max(1000, "El motivo no puede pasar de 1000 caracteres")

export const forceReviewSchema = periodOrder(
  z.object({
    periodStart: localDateSchema,
    periodEnd: localDateSchema,
    /** Vacío = afecta a TODOS los informes del periodo. */
    scope: z.nativeEnum(ReportType).nullable().optional(),
    reason: reasonSchema,
  })
)

export const clearReviewSchema = z.object({
  id: z.string().uuid(),
  reason: reasonSchema,
})

// ─────────────────────────────────────────────────────────────────────────────
// Umbrales de revisión (ADR-0012 D3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #10 — el schema es UNO y vive en el módulo puro (`lib/ledger/report-run.ts`),
 * que es quien lo aplica al leer la columna. Tener aquí una segunda copia
 * acabaría admitiendo en el formulario lo que el motor rechaza, o al revés.
 */
export { kpiThresholdSchema, reviewThresholdsSchema }

export type BalanceParamsInput = z.infer<typeof balanceParamsSchema>
export type PygParamsInput = z.infer<typeof pygParamsSchema>
export type CashflowParamsInput = z.infer<typeof cashflowParamsSchema>
export type DashboardParamsInput = z.infer<typeof dashboardParamsSchema>
export type ForceReviewInput = z.infer<typeof forceReviewSchema>
export type ClearReviewInput = z.infer<typeof clearReviewSchema>
export type ReviewThresholdsInput = z.infer<typeof reviewThresholdsSchema>
