/**
 * E8 · T6 — El esquema que se le pide al modelo, y el que se le exige a la vuelta.
 *
 * Dos caras del mismo contrato:
 *
 *  · `EXTRACTION_SCHEMA_V1` es el JSON-Schema que viaja en la petición
 *    (`withStructuredOutput`). Vive en `ai/schemas/extraction.v1.json`,
 *    versionado en git, y su `schemaSha` va a `ExtractionRun`: una salida sólo
 *    es válida contra el esquema con el que se pidió (G-17).
 *  · `extractionOutputSchema` es el zod **estricto** con el que se valida la
 *    respuesta ANTES de tocar nada. La salida de un modelo es dato hostil
 *    (§10): sin `.strict()`, un proveedor que devuelva `accountCode: "607"` de
 *    su cosecha colaría una calificación contable por la puerta de atrás.
 *
 * **Lo que este esquema NO tiene, y no es un olvido** (O-10, O-11, ADR-0014 D4,
 * D8, D11): `accountCode`, `projectId`, `costCenterId`, `deductibility`,
 * `withholding`, `receptionDate`, `paymentKey`, `simplifiedQualified`,
 * `rectifies.reason` y `rectifies.mode`. Hay un test que falla si alguno
 * reaparece. Un modelo que elige entre 607 y 623 está decidiendo MC1 y MC2 de
 * un proyecto; la retención es obligación del pagador, no un dato del papel.
 *
 * Los `Field` personalizados de TaxHacker siguen existiendo, pero sólo aportan
 * campos **no económicos** y viajan por `extra[]`, fuera de toda cifra contable.
 */

import { z } from "zod"

import EXTRACTION_SCHEMA_V1_JSON from "@/ai/schemas/extraction.v1.json"
import { schemaHash } from "@/lib/extraction/hash"
import { DOC_KINDS } from "@/lib/extraction/types"

export const EXTRACTION_SCHEMA_VERSION = "v1"

export const EXTRACTION_SCHEMA_V1: Readonly<Record<string, unknown>> = EXTRACTION_SCHEMA_V1_JSON as Record<
  string,
  unknown
>

/**
 * Campos que el modelo **no puede** proponer. La lista es el enunciado de
 * ADR-0014 D4 y D11 en forma ejecutable: el test recorre el JSON-Schema y el
 * zod y falla si alguno aparece como nombre de propiedad.
 */
export const FORBIDDEN_MODEL_FIELDS: readonly string[] = [
  "accountCode",
  "projectId",
  "costCenterId",
  "deductibility",
  "withholding",
  "receptionDate",
  "operationDate",
  "accrualDate",
  "paymentKey",
  "simplifiedQualified",
  "reason",
  "mode",
  "surchargeRateCode",
  "operationKey",
  "appliedAdvanceCents",
  "appliedAdvanceTaxCents",
  "advanceEntryId",
] as const

/** Sello del esquema tal y como se envía. Va a `ExtractionRun.schemaSha`. */
export function extractionSchemaSha(): string {
  return schemaHash(EXTRACTION_SCHEMA_V1)
}

const nullableInt = z.number().int().nullable()
const nullableString = z.string().nullable()

const lineSchema = z
  .object({
    baseCents: z.number().int(),
    discountCents: nullableInt.optional(),
    taxRateCode: nullableString.optional(),
    description: nullableString.optional(),
    qty: z.number().finite().nullable().optional(),
    unitPriceCents: nullableInt.optional(),
  })
  .strict()

const taxSchema = z
  .object({
    taxRateCode: nullableString,
    baseCents: z.number().int(),
    quotaCents: z.number().int(),
  })
  .strict()

const dueSchema = z
  .object({
    dueDate: nullableString,
    amountCents: z.number().int(),
  })
  .strict()

/**
 * Validación **estricta** de la salida del modelo, `openai_compatible`
 * incluido (G-17). Los `.optional()` existen porque un proveedor puede omitir
 * una clave que el JSON-Schema marca `required`; lo que NO se tolera es una
 * clave de más, que es por donde entraría una calificación fiscal inventada.
 */
export const extractionOutputSchema = z
  .object({
    docKind: z.enum(DOC_KINDS as unknown as [string, ...string[]]).optional(),
    documentNumber: nullableString.optional(),
    counterparty: z
      .object({ name: nullableString, taxId: nullableString })
      .strict()
      .nullable()
      .optional(),
    documentDate: nullableString.optional(),
    dueSchedule: z.array(dueSchema).nullable().optional(),
    currency: nullableString.optional(),
    lines: z.array(lineSchema).nullable().optional(),
    taxes: z.array(taxSchema).nullable().optional(),
    readWithholding: z
      .object({ rateBps: z.number().int(), quotaCents: z.number().int() })
      .strict()
      .nullable()
      .optional(),
    rectifies: z.object({ documentNumber: z.string() }).strict().nullable().optional(),
    totalCents: z.number().int().optional(),
    description: nullableString.optional(),
    legalMentions: z.array(z.string()).nullable().optional(),
    extra: z
      .array(z.object({ code: z.string(), value: nullableString }).strict())
      .nullable()
      .optional(),
  })
  .strict()

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>

/**
 * Parsea la salida cruda. Devuelve el error en texto en lugar de lanzar: en
 * `requestLLM` un fallo de validación es **un intento fallido** que dispara el
 * siguiente proveedor de la cadena, no una excepción que rompa el run.
 */
export function parseExtractionOutput(raw: unknown): { ok: true; value: ExtractionOutput } | { ok: false; error: string } {
  const result = extractionOutputSchema.safeParse(raw)
  if (result.success) return { ok: true, value: result.data }
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("; ")
  return { ok: false, error: `salida no conforme al esquema ${EXTRACTION_SCHEMA_VERSION}: ${detail}` }
}
