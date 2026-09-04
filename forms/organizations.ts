import { PgcVariant } from "@/prisma/client"
import { z } from "zod"

/** ISO-4217: tres letras mayúsculas. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "La moneda debe ser un código ISO-4217 de tres letras")

/** IANA: `Área/Ciudad` (admite un tercer segmento, p. ej. `America/Argentina/Salta`). */
export const timezoneSchema = z
  .string()
  .trim()
  .regex(/^(UTC|[A-Za-z]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?)$/, "La zona horaria debe ser un identificador IANA")

export const pgcVariantSchema = z.nativeEnum(PgcVariant, {
  errorMap: () => ({ message: "La variante del PGC debe ser GENERAL o PYMES" }),
})

export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres")
  .max(128, "El nombre no puede superar los 128 caracteres")

export const taxIdSchema = z
  .string()
  .trim()
  .max(32, "El NIF/CIF no puede superar los 32 caracteres")
  .optional()
  .transform((value) => (value ? value.toUpperCase() : null))

export const createOrganizationFormSchema = z.object({
  name: organizationNameSchema,
  taxId: taxIdSchema,
  baseCurrency: currencyCodeSchema.default("EUR"),
  timezone: timezoneSchema.default("Europe/Madrid"),
  pgcVariant: pgcVariantSchema.default(PgcVariant.PYMES),
})

export const updateOrganizationFormSchema = z.object({
  name: organizationNameSchema,
  taxId: taxIdSchema,
  baseCurrency: currencyCodeSchema,
  timezone: timezoneSchema,
  pgcVariant: pgcVariantSchema,
})

export const switchOrganizationSchema = z.object({
  organizationId: z.string().uuid("Identificador de organización inválido"),
})

export type CreateOrganizationForm = z.infer<typeof createOrganizationFormSchema>
export type UpdateOrganizationForm = z.infer<typeof updateOrganizationFormSchema>
