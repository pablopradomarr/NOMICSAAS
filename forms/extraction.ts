/**
 * E8 · T13 — validación de todo lo que entra por el camino documental.
 *
 * Tres reglas gobiernan este fichero:
 *
 * 1. **Zod estricto, sin `.catchall`** (§4.3 y G-17). Una clave de más es un
 *    error, no un campo que se cuela hasta `Transaction.extra`. La propuesta
 *    que se confirma es dato hostil aunque venga de nuestra propia pantalla:
 *    entre el `ExtractionRun` sellado y el `INSERT` hay un navegador.
 * 2. **Aquí no se calcula nada.** Ningún esquema deriva bases, cuotas ni
 *    totales: lo que llega se recalcula en `reconcile()` y se contabiliza con
 *    la cuota del documento (ADR-0014 D3). Lo único que este fichero decide es
 *    si la forma es admisible.
 * 3. **Los motivos son de verdad**: ≥ 10 caracteres en todo forzado, en la
 *    marca de ticket cualificado y en anular-y-rehacer. Un «ok» no es un
 *    motivo, y estos actos quedan en `AuditLog` para siempre.
 *
 * `forms/transactions.ts` ya usa `parseCents()` en todo el camino de entrada
 * (G-07, cerrado en T19): aquí los importes llegan **en céntimos enteros**
 * desde el formulario tipado, nunca como texto.
 */

import { DOC_KINDS } from "@/lib/extraction/types"
import { z } from "zod"

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha va en formato AAAA-MM-DD")
const uuid = z.string().uuid()
const cents = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00)
const positiveCents = z.number().int().min(0).max(1_000_000_000_00)
const taxRateCode = z.string().min(1).max(24)
const accountCode = z.string().regex(/^\d{3,12}$/, "La cuenta es un código del plan")

/** Motivo auditable. Diez caracteres es el mínimo que distingue una razón de un «ok». */
export const MOTIVO_MIN = 10
const reason = z.string().trim().min(MOTIVO_MIN, `El motivo debe tener al menos ${MOTIVO_MIN} caracteres`).max(512)

export const LINE_KINDS = ["OPERACION", "SUPLIDO", "NO_SUJETO"] as const
export const DEDUCTIBILITIES = ["FULL", "NONE", "PRORRATA"] as const
export const OPERATION_KEYS = ["GENERAL", "ISP", "AIB", "EXENTA_25", "EXPORTACION", "NO_SUJETA"] as const
export const PAYMENT_KEYS = ["BANCO_DEFAULT", "CAJA"] as const

export const proposalLineSchema = z
  .object({
    kind: z.enum(LINE_KINDS).default("OPERACION"),
    baseCents: cents,
    discountCents: positiveCents.optional(),
    taxRateCode: taxRateCode.nullable(),
    surchargeRateCode: taxRateCode.optional(),
    description: z.string().max(512).optional(),
    qty: z.number().finite().optional(),
    unitPriceCents: cents.optional(),
    accountCode: accountCode.optional(),
    /**
     * **O-10.** `llm` no es un valor admisible: que un modelo elija entre 607 y
     * 623 es que un modelo decide MC1 y MC2. El enum lo impide en la frontera,
     * no sólo en el tipo de TypeScript.
     */
    accountCodeOrigin: z.enum(["usuario", "catalogo", "importado"]).optional(),
    projectId: uuid.optional(),
    costCenterId: uuid.optional(),
    deductibility: z.enum(DEDUCTIBILITIES).optional(),
  })
  .strict()

export const proposalTaxSchema = z
  .object({
    taxRateCode,
    baseCents: cents,
    /** ADR-0014 D3: la cuota del documento es la que se contabiliza. */
    quotaCents: cents,
    operationKey: z.enum(OPERATION_KEYS).optional(),
  })
  .strict()

export const extractionProposalSchema = z
  .object({
    version: z.literal(1),
    docKind: z.enum(DOC_KINDS as unknown as [string, ...string[]]),
    documentNumber: z.string().max(64).nullable(),
    counterparty: z
      .object({
        name: z.string().max(256).nullable(),
        taxId: z.string().max(24).nullable(),
        id: uuid.nullable().optional(),
      })
      .strict(),
    documentDate: localDate.nullable(),
    accrualDate: localDate.nullable().optional(),
    /** O-6: origen `usuario`, nunca `llm`. Decide el trimestre de IVA soportado. */
    receptionDate: localDate.nullable(),
    operationDate: localDate.nullable().optional(),
    dueSchedule: z.array(z.object({ dueDate: localDate, amountCents: cents }).strict()).max(120).optional(),
    currency: z.string().length(3),
    lines: z.array(proposalLineSchema).min(1).max(500),
    taxes: z.array(proposalTaxSchema).max(20),
    withholding: z.object({ rateCode: taxRateCode, quotaCents: cents }).strict().nullable().optional(),
    readWithholding: z.object({ rateBps: z.number().int(), quotaCents: cents }).strict().nullable().optional(),
    appliedAdvanceCents: cents.optional(),
    appliedAdvanceTaxCents: cents.optional(),
    advanceEntryId: uuid.optional(),
    rectifies: z
      .object({
        documentNumber: z.string().min(1).max(64),
        entryId: uuid.optional(),
        reason: z.enum(["DEVOLUCION", "DESCUENTO_POSTERIOR", "RAPPEL", "ERROR"]),
        mode: z.enum(["DIFERENCIAS", "SUSTITUCION"]),
      })
      .strict()
      .optional(),
    paymentKey: z.enum(PAYMENT_KEYS).optional(),
    /** Art. 7.2 RD 1619/2012: se marca por `markSimplifiedQualifiedAction`, no aquí. */
    simplifiedQualified: z.boolean().optional(),
    totalCents: cents,
    description: z.string().max(1024).nullable().optional(),
  })
  .strict()

export type ExtractionProposalInput = z.infer<typeof extractionProposalSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Entradas de cada acción
// ─────────────────────────────────────────────────────────────────────────────

export const analyzeFileSchema = z
  .object({
    fileId: uuid,
    /** Origen `usuario`; sin ella, la fecha de subida del fichero. */
    receptionDate: localDate.optional(),
    promptCode: z.string().max(64).optional(),
  })
  .strict()

export const analyzeBatchSchema = z
  .object({
    fileIds: z.array(uuid).min(1).max(100),
    receptionDate: localDate.optional(),
  })
  .strict()

export const previewProposalSchema = z
  .object({
    runId: uuid,
    /** Ediciones de la pantalla. Sin ellas se previsualiza la propuesta sellada. */
    proposal: extractionProposalSchema.optional(),
    templateCode: z.string().max(48).optional(),
    closedYearAdjustmentKind: z.enum(["MATERIAL", "NO_SIGNIFICATIVO"]).optional(),
  })
  .strict()

export const confirmProposalSchema = z
  .object({
    runId: uuid,
    proposal: extractionProposalSchema,
    templateCode: z.string().max(48).optional(),
    /** Sólo duplicado y `convertedTotal`: un FAIL aritmético NO se puede forzar (R6). */
    forceReason: reason.optional(),
    closedYearAdjustmentKind: z.enum(["MATERIAL", "NO_SIGNIFICATIVO"]).optional(),
    /** Doble envío del formulario ⇒ un solo asiento. */
    idempotencyKey: z.string().min(8).max(128).optional(),
    transactionId: uuid.optional(),
  })
  .strict()

export const confirmBatchSchema = z
  .object({
    runIds: z.array(uuid).min(1).max(100),
  })
  .strict()

export const splitGroupSchema = z
  .object({
    /** Índices de `run.proposal.lines`. **Del run, nunca de una caché** (G-03). */
    lineIndexes: z.array(z.number().int().min(0).max(499)).min(1),
    description: z.string().max(512).optional(),
  })
  .strict()

export const splitProposalSchema = z
  .object({
    runId: uuid,
    groups: z.array(splitGroupSchema).min(2).max(50),
  })
  .strict()

export const revoidAndRedoSchema = z.object({ transactionId: uuid, reason }).strict()

export const forceOverrideSchema = z
  .object({
    runId: uuid,
    /** Ruta del campo tal como la sella `fieldOrigins` (`taxes[IVA_21].quotaCents`). */
    field: z.string().min(1).max(128),
    value: z.unknown(),
    reason,
  })
  .strict()

export const markSimplifiedQualifiedSchema = z.object({ runId: uuid, reason }).strict()

export type AnalyzeFileInput = z.infer<typeof analyzeFileSchema>
export type AnalyzeBatchInput = z.infer<typeof analyzeBatchSchema>
export type PreviewProposalInput = z.infer<typeof previewProposalSchema>
export type ConfirmProposalInput = z.infer<typeof confirmProposalSchema>
export type ConfirmBatchInput = z.infer<typeof confirmBatchSchema>
export type SplitProposalInput = z.infer<typeof splitProposalSchema>
export type RevoidAndRedoInput = z.infer<typeof revoidAndRedoSchema>
export type ForceOverrideInput = z.infer<typeof forceOverrideSchema>
export type MarkSimplifiedQualifiedInput = z.infer<typeof markSimplifiedQualifiedSchema>

/** Mensaje de error de zod legible en pantalla, en el orden de los campos. */
export const formatZodError = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "entrada"}: ${issue.message}`).join(" · ")
