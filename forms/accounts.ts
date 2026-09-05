/**
 * E2 · T9 — Validación de entrada del editor del plan de cuentas (§4.2).
 *
 * Un schema por entidad. Aquí sólo se comprueba la FORMA del dato; las reglas
 * contables (R-01…R-21) viven en `lib/accounts/` y las aplica el modelo.
 */

import { ACCOUNT_CODE_RE } from "@/lib/accounts/codes"
import { AnalyticType, CashflowBucket, PgcVariant, Statement } from "@/prisma/client"
import { z } from "zod"

export const accountCodeSchema = z
  .string()
  .trim()
  .regex(ACCOUNT_CODE_RE, "El código de cuenta son dígitos sin ceros a la izquierda (máximo 12)")

export const accountNameSchema = z
  .string()
  .trim()
  .min(2, "El nombre de la cuenta debe tener al menos 2 caracteres")
  .max(255, "El nombre de la cuenta no puede superar los 255 caracteres")

/** Motivo obligatorio de las mutaciones destructivas (§7). */
export const reasonSchema = z
  .string()
  .trim()
  .min(5, "Indica un motivo de al menos 5 caracteres: queda en el registro de auditoría")
  .max(512, "El motivo no puede superar los 512 caracteres")

export const optionalReasonSchema = z
  .string()
  .trim()
  .max(512, "El motivo no puede superar los 512 caracteres")
  .optional()
  .transform((value) => (value && value !== "" ? value : null))

/** `""` en un `<select>` vacío significa «sin valor», no «cadena vacía». */
const nullableEnum = <T extends Record<string, string>>(enumObject: T, message: string) =>
  z
    .union([z.nativeEnum(enumObject), z.literal("")])
    .optional()
    .transform((value) => (value === "" || value === undefined ? null : (value as T[keyof T])))
    .refine((value) => value === null || Object.values(enumObject).includes(value as string), { message })

export const statementSchema = nullableEnum(Statement, "Estado financiero desconocido")
export const analyticTypeSchema = nullableEnum(AnalyticType, "Tipo analítico desconocido")
export const cashflowBucketSchema = nullableEnum(CashflowBucket, "Bucket de cashflow desconocido")

/** Epígrafe opcional; `""` significa «heredar el del padre», no cadena vacía. */
const epigraphSchema = z
  .string()
  .trim()
  .max(255)
  .optional()
  .transform((value) => (value && value !== "" ? value : null))

/**
 * Alta de subcuenta. El padre se resuelve en el servidor por prefijo (T-6).
 *
 * R-15: el epígrafe se acota al catálogo CERRADO de la variante. El catálogo se
 * deriva del seed, así que no puede vivir en el schema estático: la server
 * action lo inyecta con `createAccountFormSchema(catalogo)`. La variante sin
 * argumento sigue existiendo para los tests de forma pura.
 */
export const createAccountFormSchema = (epigraphCatalog?: ReadonlySet<string>) =>
  z.object({
    code: accountCodeSchema,
    name: accountNameSchema,
    statement: statementSchema,
    epigraph: epigraphSchema.refine(
      (value) => value === null || !epigraphCatalog || epigraphCatalog.has(value),
      "Ese epígrafe no existe en el modelo de cuentas anuales de la organización"
    ),
    analyticType: analyticTypeSchema,
    cashflowBucket: cashflowBucketSchema,
  })

/** R-19: renombrar siempre se permite, incluso en cuentas de sistema. */
export const renameAccountFormSchema = z.object({
  code: accountCodeSchema,
  name: accountNameSchema,
})

/**
 * R-10a: `statement` NO viaja en este formulario. La clasificación editable es
 * epígrafe, tipo analítico y categoría de cashflow; el motivo lo exige el modelo
 * cuando la cuenta viene del seed (R-10b).
 */
export const updateAccountClassificationFormSchema = z.object({
  code: accountCodeSchema,
  epigraph: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((value) => (value && value !== "" ? value : null)),
  analyticType: analyticTypeSchema,
  cashflowBucket: cashflowBucketSchema,
  reason: optionalReasonSchema,
})

/** Desactivar exige motivo; reactivar no (no destruye nada). */
export const setAccountActiveFormSchema = z
  .object({
    code: accountCodeSchema,
    isActive: z.union([z.literal("true"), z.literal("false"), z.boolean()]).transform((v) => v === true || v === "true"),
    reason: z.string().trim().max(512).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.isActive && (value.reason ?? "").trim().length < 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Desactivar una cuenta exige un motivo de al menos 5 caracteres",
      })
    }
  })

export const deleteAccountFormSchema = z.object({
  code: accountCodeSchema,
  reason: reasonSchema,
})

export const reseedPlanFormSchema = z.object({
  variant: z.nativeEnum(PgcVariant, { errorMap: () => ({ message: "La variante del PGC debe ser GENERAL o PYMES" }) }),
  reason: optionalReasonSchema,
})

// ─────────────────────────────────────────────────────────────────────────────
// Import de plan propio (wizard de 3 pasos, §6)
// ─────────────────────────────────────────────────────────────────────────────

const columnSchema = z
  .string()
  .trim()
  .max(128)
  .optional()
  .transform((value) => (value && value !== "" ? value : undefined))

export const importPlanCsvFormSchema = z.object({
  /** Texto del CSV. El fichero lo lee el cliente y lo envía como campo. */
  csv: z.string().min(1, "Sube un fichero CSV con al menos una fila de datos").max(4_000_000),
  fileName: z.string().trim().max(255).optional().default(""),
  delimiter: z.union([z.literal(","), z.literal(";"), z.literal("\t")]).default(","),
  mappingCode: z.string().trim().min(1, "Indica qué columna contiene el código de cuenta"),
  mappingName: z.string().trim().min(1, "Indica qué columna contiene el nombre de la cuenta"),
  mappingStatement: columnSchema,
  mappingEpigraph: columnSchema,
  mappingAnalyticType: columnSchema,
  mappingNature: columnSchema,
  dryRun: z.union([z.literal("true"), z.literal("false"), z.boolean()]).transform((v) => v === true || v === "true"),
  reason: optionalReasonSchema,
})

export type CreateAccountForm = z.infer<ReturnType<typeof createAccountFormSchema>>
export type UpdateAccountClassificationForm = z.infer<typeof updateAccountClassificationFormSchema>
export type ImportPlanCsvForm = z.infer<typeof importPlanCsvFormSchema>
