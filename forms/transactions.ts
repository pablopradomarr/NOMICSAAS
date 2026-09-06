import { parseCents } from "@/lib/money"
import { z } from "zod"

/**
 * E8 · T19 (cierre de G-07) — un solo parseador de importes en TODO el camino
 * de entrada.
 *
 * `parseFloat(val) * 100` era el patrón heredado: `Math.round` a veces sí y a
 * veces no, ninguna tolerancia a los separadores españoles («1.234,56»), y un
 * `19.99` que llegaba a una columna `Int` como `1998.9999999999998`. Ahora todo
 * pasa por `parseCents` de `lib/money.ts`, que es aritmética entera y entiende
 * es-ES y en-US. Un texto no interpretable **no** vale 0: es un error de
 * validación, porque un importe silenciosamente puesto a cero es peor que un
 * formulario que se queja.
 */
function centsField(label: string, path: string) {
  return z
    .string()
    .optional()
    .transform((val) => {
      if (!val || val.trim() === "") return null
      const cents = parseCents(val)
      if (cents === null) {
        throw new z.ZodError([{ message: `${label} no es un importe válido`, path: [path], code: z.ZodIssueCode.custom }])
      }
      return cents
    })
}

export const transactionFormSchema = z
  .object({
    name: z.string().max(128).optional(),
    merchant: z.string().max(128).optional(),
    description: z.string().max(256).optional(),
    type: z.string().optional(),
    total: centsField("El total", "total"),
    currencyCode: z.string().max(5).optional(),
    convertedTotal: centsField("El total convertido", "convertedTotal"),
    convertedCurrencyCode: z.string().max(5).optional(),
    categoryCode: z.string().optional(),
    projectCode: z.string().optional(),
    issuedAt: z
      .union([
        z.date(),
        z
          .string()
          .refine((val) => !isNaN(Date.parse(val)), {
            message: "Invalid date format",
          })
          .transform((val) => {
            // Transaction dates are calendar dates.
            // Store date-only values at UTC midnight so they are
            // independent of the server/container/browser timezone.
            if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
              return new Date(`${val}T00:00:00.000Z`)
            }
            return new Date(val)
          }),
      ])
      .optional(),
    text: z.string().optional(),
    note: z.string().optional(),
    items: z
      .string()
      .optional()
      .transform((val) => {
        if (!val || val.trim() === "") return []
        try {
          return JSON.parse(val)
        } catch (_e) {
          throw new z.ZodError([{ message: "Invalid items JSON", path: ["items"], code: z.ZodIssueCode.custom }])
        }
      }),
  })
  .catchall(z.string())
