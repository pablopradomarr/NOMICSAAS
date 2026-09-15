/**
 * E11 · ola C · T14 — esquemas del asistente de alta y de las preferencias de
 * organización (docs/design/E11-plataforma-saas.md §6.2 y §6.4).
 */

import {
  currencyCodeSchema,
  organizationNameSchema,
  pgcVariantSchema,
  taxIdSchema,
  timezoneSchema,
} from "@/forms/organizations"
import { DepreciationStart, OnboardingStep, Role } from "@/prisma/client"
import { z } from "zod"

/** Prefijo de serie: lo que va delante del número en la factura expedida. */
export const seriesPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "El prefijo de la serie no puede estar vacío")
  .max(16, "El prefijo no puede superar los 16 caracteres")
  .regex(/^[A-Z0-9\-/]+$/, "El prefijo sólo admite letras, números, guion y barra")

/** Paso 1 · Empresa. Es el único paso que crea algo irreversible. */
export const onboardingCompanySchema = z.object({
  name: organizationNameSchema,
  taxId: taxIdSchema,
  baseCurrency: currencyCodeSchema.default("EUR"),
  timezone: timezoneSchema.default("Europe/Madrid"),
  pgcVariant: pgcVariantSchema,
  seriesPrefix: seriesPrefixSchema.default("FAC"),
})

export const onboardingRenamePrefixSchema = z.object({
  seriesId: z.string().uuid("Identificador de serie inválido"),
  prefix: seriesPrefixSchema,
})

const localDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD")

/** Paso 3 · Ejercicio. EDITA el provisional; nunca crea otro (O-7b). */
export const onboardingFiscalYearSchema = z
  .object({
    code: z.string().trim().min(1).max(16).optional(),
    startDate: localDateSchema,
    endDate: localDateSchema,
  })
  .refine((v) => v.endDate > v.startDate, {
    message: "La fecha de fin tiene que ser posterior a la de inicio",
    path: ["endDate"],
  })

/** Paso 4 · Equipo. Emails separados por coma, espacio o salto de línea. */
export const onboardingInviteSchema = z.object({
  emails: z.string().trim().max(2000, "Demasiados correos de una vez"),
  role: z.nativeEnum(Role).default(Role.EDITOR),
})

export const onboardingStepSchema = z.object({
  step: z.nativeEnum(OnboardingStep),
})

/** Código del `Setting` donde vive el destinatario de los avisos de plataforma. */
export const PLATFORM_NOTICE_EMAIL_SETTING = "platform_notice_email"

/**
 * §6.4 — preferencias del MOTOR que viven en la organización (D-3). El mes de
 * arranque de la amortización no es una etiqueta: decide la primera cuota del
 * cuadro de todo activo que se dé de alta a partir de ahora.
 */
export const organizationPreferencesSchema = z.object({
  depreciationStartsOn: z.nativeEnum(DepreciationStart),
  backupRetentionDays: z.coerce
    .number()
    .int("La retención se expresa en días enteros")
    .min(1, "La retención mínima es de un día")
    .max(3650, "La retención máxima es de 3650 días"),
  platformNoticeEmail: z
    .string()
    .trim()
    .max(160)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : ""))
    .refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
      message: "El destinatario de los avisos debe ser un correo válido",
    }),
})

export type OnboardingCompanyForm = z.infer<typeof onboardingCompanySchema>
export type OrganizationPreferencesForm = z.infer<typeof organizationPreferencesSchema>
