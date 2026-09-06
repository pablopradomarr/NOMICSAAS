/**
 * E8 · T18 — validación de la emisión de facturas.
 *
 * Lo que el cliente puede mandar y **sólo** lo que puede mandar: qué se vende,
 * cuánto, a qué precio y con qué tipo. Ni bases, ni cuotas, ni totales, ni el
 * número de factura: la base la recalcula el servidor (G-21) y el número lo da
 * la serie con `FOR UPDATE` (O-18). Zod **estricto**: una clave de más es un
 * error, no un campo que se ignora en silencio.
 */

import { z } from "zod"

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha va en formato AAAA-MM-DD")

const uuid = z.string().uuid()
const taxRateCode = z.string().min(1).max(24)

export const emitInvoiceLineSchema = z
  .object({
    description: z.string().min(1).max(512),
    /** Cantidad × 1000 (tres decimales). Entero, positivo. */
    quantityMilli: z.number().int().positive().max(1_000_000_000),
    /** Precio unitario en céntimos. Entero, positivo. */
    unitPriceCents: z.number().int().positive().max(1_000_000_000_0),
    taxRateCode,
    /** Cuenta de ingreso del catálogo (700/705…). Origen `usuario`, nunca LLM. */
    revenueAccountCode: z
      .string()
      .regex(/^\d{3,12}$/, "La cuenta de ingreso es un código del plan")
      .optional(),
    projectId: uuid.optional(),
    costCenterId: uuid.optional(),
  })
  .strict()

export const RECTIFICATION_MODES = ["DIFERENCIAS", "SUSTITUCION"] as const
export const RECTIFICATION_REASONS = ["DEVOLUCION", "DESCUENTO_POSTERIOR", "RAPPEL", "ERROR"] as const

export const emitInvoiceSchema = z
  .object({
    /**
     * `RECTIFICATIVA` toma número de la serie rectificativa (art. 15.4 RD
     * 1619/2012); `ORDINARIA`, de la ordinaria. La serie concreta se puede fijar
     * por código si la organización tiene varias del mismo tipo.
     */
    seriesKind: z.enum(["ORDINARIA", "RECTIFICATIVA", "SIMPLIFICADA"]).default("ORDINARIA"),
    seriesCode: z.string().min(1).max(24).optional(),
    counterpartyId: uuid.optional(),
    /** Nombre para la operación heredada cuando no hay ficha de contraparte. */
    customerName: z.string().min(1).max(255).optional(),
    documentDate: localDate,
    accrualDate: localDate.optional(),
    entryDate: localDate.optional(),
    dueDate: localDate.optional(),
    lines: z.array(emitInvoiceLineSchema).min(1).max(200),
    /** Retención practicada por el cliente: la fija la ficha, no el PDF (O-11). */
    withholdingRateCode: taxRateCode.optional(),
    description: z.string().max(512).optional(),
    notes: z.string().max(2000).optional(),
    /** Sólo con `seriesKind = RECTIFICATIVA`. */
    rectifies: z
      .object({
        entryId: uuid,
        reason: z.enum(RECTIFICATION_REASONS),
        mode: z.enum(RECTIFICATION_MODES),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.seriesKind === "RECTIFICATIVA" && !value.rectifies) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rectifies"],
        message: "Una rectificativa referencia la factura que rectifica y declara causa y modo (art. 15 RD 1619/2012)",
      })
    }
    if (value.seriesKind !== "RECTIFICATIVA" && value.rectifies) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seriesKind"],
        message: "Rectificar exige la serie rectificativa: una factura ordinaria no rectifica a otra",
      })
    }
  })

export type EmitInvoiceInput = z.infer<typeof emitInvoiceSchema>
export type EmitInvoiceLineInput = z.infer<typeof emitInvoiceLineSchema>
