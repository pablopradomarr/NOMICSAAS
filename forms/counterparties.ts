/**
 * E8 · T23 — Validación de entrada del maestro de terceros y de la calificación
 * fiscal (`docs/design/E8-documentos-asientos.md` §4.2, ADR-0014 D11).
 *
 * Aquí sólo hay validación de **forma**. La comprobación fiscal de fondo —el
 * dígito de control del NIF por ramas (RC-11), VIES, la coherencia entre
 * régimen y tipo de retención (RC-19)— es de `lib/extraction/reconcile.ts`
 * (T7): es determinista, tiene que dar el mismo veredicto desde el formulario y
 * desde el lote, y por tanto no puede vivir en un schema de pantalla.
 */

import { optionalReasonSchema } from "@/forms/accounts"
import { DefaultDeductibility, IvaRegime, WithholdingRegime } from "@/prisma/client"
import { z } from "zod"

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal("")])
    .optional()
    .transform((value) => (value === "" || value === undefined ? null : (value as string)))

/** Casilla HTML: llega `"on"` cuando está marcada y no llega cuando no lo está. */
const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal(""), z.boolean()])
  .optional()
  .transform((value) => value === "on" || value === "true" || value === true)

export const counterpartyCodeSchema = z
  .string()
  .trim()
  .min(1, "El código es obligatorio")
  .max(24, "El código no puede pasar de 24 caracteres")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "El código admite letras, números, punto, guion y guion bajo")

/**
 * ISO-3166-1 alfa-2. Decide la RAMA de RC-11 —España, UE o tercer país—, y de
 * ahí que se valide su forma aquí: un país mal escrito manda una factura por la
 * rama equivocada y puede bloquear una importación perfectamente correcta.
 */
export const countryCodeSchema = z
  .union([z.string().trim().toUpperCase().length(2, "El país es un código ISO de dos letras"), z.literal("")])
  .optional()
  .transform((value) => (value === "" || value === undefined ? null : (value as string)))

export const counterpartyBaseSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(255),
  taxId: optionalText(20),
  countryCode: countryCodeSchema,
  vatNumber: optionalText(20),
  withholdingRegime: z.nativeEnum(WithholdingRegime).default(WithholdingRegime.NINGUNO),
  withholdingRateCode: optionalText(24),
  surchargeRegime: checkbox,
  isEmployee: checkbox,
  isActive: checkbox,
  notes: optionalText(512),
})

export const createCounterpartyFormSchema = counterpartyBaseSchema.extend({
  code: counterpartyCodeSchema,
})

export const updateCounterpartyFormSchema = counterpartyBaseSchema.extend({
  id: z.string().uuid("Identificador inválido"),
  reason: optionalReasonSchema,
})

/**
 * D11 (O-4, O-21). `ivaRegime ≠ GENERAL` **bloquea** la contabilización
 * automática (RC-24) y lo dice en pantalla: con criterio de caja el devengo y la
 * deducción siguen al cobro y al pago, y todo el circuito de E8 sería
 * incorrecto. Un producto que no dice qué no soporta es peor que uno que no lo
 * soporta.
 */
export const organizationFiscalFormSchema = z.object({
  roiRegistered: checkbox,
  ivaRegime: z.nativeEnum(IvaRegime).default(IvaRegime.GENERAL),
})

/**
 * O-10 / O-17. La cuenta por defecto de una categoría es origen `catalogo`, y
 * **nunca** del subgrupo 64 (las nóminas entran por T-10, no por una plantilla
 * de compra); el CHECK de la base lo repite, porque una regla que sólo vive en
 * un schema de formulario no protege a la fila que llega por otro camino.
 */
export const categoryFiscalFormSchema = z.object({
  code: z.string().trim().min(1),
  defaultAccountCode: z
    .union([z.string().trim().regex(/^[1-9][0-9]{2,11}$/, "Código de cuenta inválido"), z.literal("")])
    .optional()
    .transform((value) => (value === "" || value === undefined ? null : (value as string)))
    .refine((value) => value === null || !value.startsWith("64"), {
      message: "Una categoría no puede apuntar al subgrupo 64: las nóminas se contabilizan con T-10 (O-13)",
    }),
  defaultDeductibility: z.nativeEnum(DefaultDeductibility).default(DefaultDeductibility.FULL),
})
