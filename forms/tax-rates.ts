/**
 * E2 · T9 — Validación de entrada de los tipos impositivos (§4.2).
 *
 * `rateBps` se captura como texto («21», «5,2», «1,75») y se convierte a puntos
 * básicos con `parseBps` (entero, sin `parseFloat` en ningún paso — ADR-0006).
 * Las reglas de vigencia y de cuentas (I-E2-3, RATE_LINK) las aplica
 * `validateTaxRate` en `lib/taxes/`.
 */

import { accountCodeSchema, optionalReasonSchema, reasonSchema } from "@/forms/accounts"
import { parseBps } from "@/lib/taxes/bps"
import { TaxAppliesTo, TaxKind, TaxRoundingMode } from "@/prisma/client"
import { z } from "zod"

/**
 * `"21"` / `"5,2"` / `"1,75"` → 2100 / 520 / 175.
 *
 * El campo llega como TEXTO del formulario. Un `number` se pasa a texto aquí, no
 * dentro de `parseBps`: la conversión ×100 sobre un flotante es justo lo que
 * ADR-0006 prohíbe para una cifra que acabará en un asiento (hallazgo 11).
 */
export const rateBpsSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const bps = parseBps(typeof value === "number" ? (Number.isFinite(value) ? String(value) : null) : value)
    if (bps === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "El tipo debe ser un porcentaje entre 0 y 100 con hasta dos decimales (p. ej. 21 o 1,75)",
      })
      return z.NEVER
    }
    return bps
  })

/** Fecha de vigencia sin hora: `YYYY-MM-DD` interpretado en UTC (`@db.Date`). */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Fecha inválida" })
      return z.NEVER
    }
    return date
  })

export const optionalIsoDateSchema = z
  .union([isoDateSchema, z.literal("")])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : (value as Date)))

const optionalAccountCode = z
  .union([accountCodeSchema, z.literal("")])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : (value as string)))

const optionalUuid = z
  .union([z.string().uuid("Identificador de tipo impositivo inválido"), z.literal("")])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : (value as string)))

export const taxRateCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{2,24}$/, "El código del tipo son letras mayúsculas, dígitos y guiones bajos (2–24)")

export const createTaxRateFormSchema = z.object({
  code: taxRateCodeSchema,
  name: z.string().trim().min(2, "El nombre del tipo es obligatorio").max(128),
  kind: z.nativeEnum(TaxKind, { errorMap: () => ({ message: "Tributo desconocido" }) }),
  rateBps: rateBpsSchema,
  appliesTo: z.nativeEnum(TaxAppliesTo, { errorMap: () => ({ message: "Dirección de aplicación desconocida" }) }),
  accountCode: accountCodeSchema,
  counterAccountCode: optionalAccountCode,
  linkedTaxRateId: optionalUuid,
  validFrom: isoDateSchema,
  validTo: optionalIsoDateSchema,
  reason: optionalReasonSchema,
})

export const updateTaxRateFormSchema = createTaxRateFormSchema
  .omit({ code: true, kind: true })
  .extend({ id: z.string().uuid("Identificador de tipo impositivo inválido") })

/** Cierre de vigencia: nunca borrado. Motivo obligatorio (§7). */
export const closeTaxRateFormSchema = z.object({
  id: z.string().uuid("Identificador de tipo impositivo inválido"),
  validTo: isoDateSchema,
  reason: reasonSchema,
})

/** Política fiscal de la organización (D2-8). Motivo obligatorio (§7). */
export const taxPolicyFormSchema = z.object({
  // O-7 (E3): PUNTOS BÁSICOS, no tanto por mil. `TaxRate.rateBps` ya está en
  // bps y el IVA deducible es `applyBps(cuota, prorrataBps)`: mezclar escalas
  // en la misma fórmula es un error latente.
  prorrataBps: z
    .union([z.string().trim(), z.number()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return null
      const raw = typeof value === "number" ? value : Number(value)
      if (!Number.isInteger(raw) || raw < 0 || raw > 10000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "La prorrata se expresa en puntos básicos: un entero entre 0 y 10000 (90 % = 9000)",
        })
        return z.NEVER
      }
      return raw
    }),
  taxRoundingMode: z.nativeEnum(TaxRoundingMode, {
    errorMap: () => ({ message: "Método de redondeo desconocido" }),
  }),
  redondeoToleranciaCents: z
    .union([z.string().trim(), z.number()])
    .transform((value, ctx) => {
      const raw = typeof value === "number" ? value : Number(value)
      if (!Number.isInteger(raw) || raw < 0 || raw > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "La tolerancia de redondeo son céntimos enteros entre 0 y 100",
        })
        return z.NEVER
      }
      return raw
    }),
  reason: reasonSchema,
})

export type CreateTaxRateForm = z.infer<typeof createTaxRateFormSchema>
export type TaxPolicyForm = z.infer<typeof taxPolicyFormSchema>
