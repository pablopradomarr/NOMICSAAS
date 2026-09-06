"use server"

/**
 * E8 · T13 — el camino documental completo: analizar → previsualizar →
 * confirmar (`docs/design/E8-documentos-asientos.md` §4.3, ADR-0014 D1/D5/D9).
 *
 * Cinco reglas gobiernan este fichero, y ninguna es negociable:
 *
 * 1. **Ninguna cifra del cliente llega al diario.** Lo que entra por el
 *    formulario es una PROPUESTA; el veredicto lo da `reconcile()` con el
 *    contexto leído de la base, y el asiento lo construye `postFromProposal()`
 *    con la cuota del documento. Un `reconcile` en FAIL no produce asiento y no
 *    hay forma de forzarlo (R6): el forzado existe para el duplicado, el
 *    `convertedTotal` y el ticket cualificado, los tres auditados.
 * 2. **Un `ExtractionRun` no se modifica jamás.** Editar, forzar un campo o
 *    marcar un ticket como cualificado **crea un run nuevo** `MANUAL` colgado
 *    del anterior por `parentRunId` (D5). El asiento apunta al run de revisión,
 *    y el del modelo queda intacto byte a byte.
 * 3. **`POSTED ⟺ journalEntryId`** (I-E8-4): el asiento y el cambio de estado
 *    de la operación ocurren en la MISMA transacción, corta, con el cálculo
 *    puro hecho fuera.
 * 4. **Matriz de roles**: `VIEWER` ve la bandeja, los runs, las comprobaciones
 *    y la previsualización —es información de auditoría— y no muta nada;
 *    `EDITOR` analiza, confirma, divide, fuerza y rehace; prompts, series,
 *    contrapartes y régimen son de `ADMIN` y viven en `settings/`.
 * 5. **`AuditLog` en todo acto humano** con `before`/`after` y motivo.
 */

import {
  analyzeBatchSchema,
  analyzeFileSchema,
  confirmBatchSchema,
  confirmProposalSchema,
  forceOverrideSchema,
  formatZodError,
  markSimplifiedQualifiedSchema,
  previewProposalSchema,
  revoidAndRedoSchema,
  splitProposalSchema,
} from "@/forms/extraction"
import { transactionFormSchema } from "@/forms/transactions"
import { enqueueExtraction, enqueueExtractionBatch } from "@/ai/queue"
import { ActionState } from "@/lib/actions"
import { requireOrg, withOrg } from "@/lib/authz"
import type { TenantClient } from "@/lib/db"
import { proposalHash } from "@/lib/extraction/hash"
import { reconcile, type ReconcileResult } from "@/lib/extraction/reconcile"
import { applyFieldOverride, documentWarnings, sealedReconcile } from "@/lib/extraction/seal"
import { splitProposal } from "@/lib/extraction/split"
import type { ExtractionProposal } from "@/lib/extraction/types"
import { newRateMemo } from "@/lib/fx/rates"
import { postFromProposal, previewFromProposal, type PostedProposal } from "@/lib/ledger/postFromProposal"
import type { TemplateCode } from "@/lib/ledger/templates/types"
import { getOrganizationUploadsDirectory, getTransactionFileUploadPath, safePathJoin, unsortedFilePath } from "@/lib/files"
import { UploadValidationError, assertAcceptableUpload, sha256OfBuffer, syncOrganizationStorage } from "@/lib/uploads"
import { writeAuditLog } from "@/models/audit-log"
import { createFile, deleteFile, getFileById, updateFile } from "@/models/files"
import { createRevisionRun, getExtractionRun, proposalOf } from "@/models/extraction"
import {
  abort,
  abortWith,
  formatLedgerErrors,
  getLedgerContext,
  modelErr,
  postEntryTx,
  runLedgerTransaction,
  todayLocalDate,
  voidEntry,
} from "@/models/ledger"
import { buildReconcileContext } from "@/models/reconcile-context"
import {
  createTransaction,
  TransactionData,
  updateTransactionFiles,
  findDuplicateTransaction,
} from "@/models/transactions"
import type { ExtractionRun, File, Organization, Transaction } from "@/prisma/client"
import { createHash, randomUUID } from "crypto"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import { revalidatePath } from "next/cache"
import path from "path"

// ─────────────────────────────────────────────────────────────────────────────
// Formas que la pantalla consume (T15-T17)
// ─────────────────────────────────────────────────────────────────────────────

export type CheckView = {
  id: string
  regla: string
  status: "PASS" | "WARN" | "FAIL"
  blocksBatch: boolean
  message: string
  evidence: Record<string, unknown>
  fields: readonly string[]
}

export type EntryLineView = {
  lineNo: number
  accountCode: string
  debitCents: number
  creditCents: number
  description: string | null
  taxRateCode: string | null
  deductibility: string | null
  nonDeductibleIncludedCents: number
  projectId: string | null
  costCenterId: string | null
  originalCurrency: string | null
  originalAmountCents: number | null
}

export type EntryPreview = {
  templateCode: string
  sourceType: string
  entryDate: string
  documentDate: string | null
  receptionDate: string | null
  operationDate: string | null
  ivaPeriod: string | null
  lines: EntryLineView[]
  totalDebitCents: number
  totalCreditCents: number
  /** Σ debe − Σ haber. **Siempre 0**: si no, no habría borrador (I1). */
  descuadreCents: number
  payableBlocks: readonly { payableKey: string; accountCode: string; baseCents: number; quotaCents: number; amountCents: number }[]
  taxOverrides: readonly { taxRateCode: string; quotaCents: number }[]
  ledgerBook: PostedProposal["ledgerBook"]
}

export type ProposalPreview = {
  runId: string
  fileId: string
  runKind: string
  partial: boolean
  status: "PASS" | "WARN" | "FAIL"
  elegibleParaLote: boolean
  sellos: readonly string[]
  ivaPeriod: string | null
  entryDate: string | null
  fiscalYearClosed: boolean
  checks: CheckView[]
  /** Chip de origen y badge de confianza por campo, en los cuatro niveles. */
  fieldOrigins: Record<string, unknown>
  proposal: ExtractionProposal
  warnings: readonly string[]
  conversion: { rateId: string; rateMicro: string; rateDate: string; source: string; convertedTotalCents: number } | null
  asiento: EntryPreview | null
  /** Por qué no hay asiento, en español contable y con su código. */
  asientoError: { code: string; message: string } | null
}

export type ConfirmedProposal = {
  transactionId: string
  entryId: string
  entryNumber: number
  /** El run que respalda el asiento: el de revisión, si hubo ediciones (D5). */
  extractionRunId: string
  /** `true` si la confirmación ya estaba hecha: el asiento no se duplicó. */
  yaEstaba: boolean
}

export type BatchConfirmation = {
  confirmados: ConfirmedProposal[]
  /** Los que el lote NO toca, **con el porqué** (§6, `/unsorted/batch`). */
  noElegibles: { runId: string; motivo: string }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Analizar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encola una extracción con `reconcile` **cableado**: el run nace ya juzgado,
 * con su estado, sus 25 comprobaciones y sus avisos de calidad sellados. Un run
 * sin veredicto obligaría a recalcularlo en cada pintado de la bandeja y a
 * confiar en que el contexto no ha cambiado entre medias.
 */
const analyzeFileActionImpl = withOrg(
  "EDITOR",
  async ({ db, org, user }, rawInput: unknown): Promise<ActionState<{ runId: string; status: string | null }>> => {
    const parsed = analyzeFileSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    try {
      const file = await getFileById(db, parsed.data.fileId)
      if (!file) return { success: false, error: "El fichero no existe en esta organización" }

      const run = await enqueueExtraction(db, org, parsed.data.fileId, { id: user.id }, {
        ...(parsed.data.receptionDate ? { receptionDate: parsed.data.receptionDate } : {}),
        ...(parsed.data.promptCode ? { promptCode: parsed.data.promptCode as never } : {}),
        reconcile: reconcileHook(db, org),
      })

      await writeAuditLogSolo(org.id, user.id, {
        entity: "ExtractionRun",
        entityId: run.id,
        action: "EXTRACT",
        after: { fileId: file.id, provider: run.provider, model: run.model, reconcileStatus: run.reconcileStatus },
      })

      revalidatePath("/unsorted")
      return { success: true, data: { runId: run.id, status: run.reconcileStatus } }
    } catch (error) {
      return { success: false, error: messageOf(error) }
    }
  }
)

const analyzeBatchActionImpl = withOrg(
  "EDITOR",
  async (
    { db, org, user },
    rawInput: unknown
  ): Promise<ActionState<{ progressId: string; runIds: string[]; failures: { fileId: string; error: string }[] }>> => {
    const parsed = analyzeBatchSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    try {
      const memo = newRateMemo()
      const outcome = await enqueueExtractionBatch(db, org, parsed.data.fileIds, { id: user.id }, {
        ...(parsed.data.receptionDate ? { receptionDate: parsed.data.receptionDate } : {}),
        reconcile: reconcileHook(db, org, memo),
      })
      revalidatePath("/unsorted")
      return {
        success: true,
        data: { progressId: outcome.progressId, runIds: outcome.runs.map((r) => r.id), failures: outcome.failures },
      }
    } catch (error) {
      return { success: false, error: messageOf(error) }
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Previsualizar (VIEWER: es información de auditoría)
// ─────────────────────────────────────────────────────────────────────────────

const previewProposalActionImpl = withOrg(
  "VIEWER",
  async ({ db, org }, rawInput: unknown): Promise<ActionState<ProposalPreview>> => {
    const parsed = previewProposalSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const loaded = await loadRun(db, parsed.data.runId)
    if ("error" in loaded) return { success: false, error: loaded.error }

    const proposal = parsed.data.proposal ? (parsed.data.proposal as unknown as ExtractionProposal) : loaded.proposal
    if (!proposal) return { success: false, error: "El run no tiene propuesta que previsualizar" }

    const edited = parsed.data.proposal !== undefined && proposalHash(proposal) !== loaded.run.proposalSha
    const judged = await judge(db, org, loaded.run, loaded.file, proposal, { asRevision: edited })

    const view = await previewOf(org, loaded, judged, {
      ...(parsed.data.templateCode ? { templateCode: parsed.data.templateCode as TemplateCode } : {}),
      ...(parsed.data.closedYearAdjustmentKind ? { closedYearAdjustmentKind: parsed.data.closedYearAdjustmentKind } : {}),
    })
    return { success: true, data: view }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Confirmar
// ─────────────────────────────────────────────────────────────────────────────

const confirmProposalActionImpl = withOrg(
  "EDITOR",
  async ({ db, org, user }, rawInput: unknown): Promise<ActionState<ConfirmedProposal>> => {
    const parsed = confirmProposalSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const outcome = await confirmOne(db, org, user.id, {
      runId: parsed.data.runId,
      proposal: parsed.data.proposal as unknown as ExtractionProposal,
      ...(parsed.data.templateCode ? { templateCode: parsed.data.templateCode as TemplateCode } : {}),
      ...(parsed.data.forceReason ? { forceReason: parsed.data.forceReason } : {}),
      ...(parsed.data.closedYearAdjustmentKind ? { closedYearAdjustmentKind: parsed.data.closedYearAdjustmentKind } : {}),
      ...(parsed.data.idempotencyKey ? { idempotencyKey: parsed.data.idempotencyKey } : {}),
      ...(parsed.data.transactionId ? { transactionId: parsed.data.transactionId } : {}),
    })
    if ("error" in outcome) return { success: false, error: outcome.error }

    revalidatePath("/unsorted")
    revalidatePath("/transactions")
    revalidatePath("/ledger")
    return { success: true, data: outcome.value }
  }
)

/**
 * Lote: **sólo los elegibles**, y los demás se devuelven con su motivo.
 *
 * Elegible = `reconcile` en PASS, run no parcial y **ningún check con
 * `blocksBatch`**, que es la categoría que O-19 inventó precisamente para esto:
 * un WARN de retención no practicada o de deducibilidad pendiente no es un
 * error aritmético, pero contabilizar cincuenta documentos así de golpe es
 * exactamente lo que nadie quiere descubrir en una inspección.
 */
const confirmBatchActionImpl = withOrg(
  "EDITOR",
  async ({ db, org, user }, rawInput: unknown): Promise<ActionState<BatchConfirmation>> => {
    const parsed = confirmBatchSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const confirmados: ConfirmedProposal[] = []
    const noElegibles: { runId: string; motivo: string }[] = []

    for (const runId of parsed.data.runIds) {
      const loaded = await loadRun(db, runId)
      if ("error" in loaded) {
        noElegibles.push({ runId, motivo: loaded.error })
        continue
      }
      if (!loaded.proposal) {
        noElegibles.push({ runId, motivo: "el run no tiene propuesta (importado sin origen o extracción fallida)" })
        continue
      }
      const judged = await judge(db, org, loaded.run, loaded.file, loaded.proposal, { asRevision: false })
      const motivo = batchIneligibility(loaded.run, judged.result)
      if (motivo !== null) {
        noElegibles.push({ runId, motivo })
        continue
      }
      // Una transacción POR DOCUMENTO (§4.3): un fallo no arrastra al lote.
      const outcome = await confirmOne(db, org, user.id, { runId, proposal: loaded.proposal })
      if ("error" in outcome) noElegibles.push({ runId, motivo: outcome.error })
      else confirmados.push(outcome.value)
    }

    revalidatePath("/unsorted")
    revalidatePath("/transactions")
    return { success: true, data: { confirmados, noElegibles } }
  }
)

/** Motivo por el que un documento NO entra en el lote, o `null` si entra. */
function batchIneligibility(run: ExtractionRun, result: ReconcileResult): string | null {
  if (run.partial) return "extracción parcial: hay que revisar y teclear las cifras (D5)"
  if (result.status === "FAIL") {
    const failed = result.checks.filter((c) => c.status === "FAIL").map((c) => c.id)
    return `la propuesta no está reconciliada (${failed.join(", ")})`
  }
  const blocking = result.checks.filter((c) => c.blocksBatch)
  if (blocking.length > 0) {
    return `hay comprobaciones que bloquean el lote: ${blocking.map((c) => `${c.id} (${c.message})`).join(" · ")}`
  }
  if (!result.elegibleParaLote) return "el documento exige una decisión individual"
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Split N-a-1 (O-9.iii)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Divide un documento en N operaciones **sobre el mismo `File`**: mismo
 * fichero, mismo `sha256`, N `Transaction` enlazadas por
 * `splitParentTransactionId` y N asientos distintos (I-E8-4, criterio 22).
 *
 * La fuente de las N propuestas es **el run**, nunca una caché del formulario:
 * `cachedParseResult` desapareció con G-03 y con ella la idea de que una
 * memoria pueda ser fuente de cifras (P4).
 */
const splitProposalActionImpl = withOrg(
  "EDITOR",
  async (
    { db, org, user },
    rawInput: unknown
  ): Promise<ActionState<{ transactionIds: string[]; runIds: string[]; parentTransactionId: string }>> => {
    const parsed = splitProposalSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const loaded = await loadRun(db, parsed.data.runId)
    if ("error" in loaded) return { success: false, error: loaded.error }
    if (!loaded.proposal) return { success: false, error: "El run no tiene propuesta que dividir" }

    const split = splitProposal(loaded.proposal, parsed.data.groups)
    if (!split.ok) return { success: false, error: split.errors.map((e) => e.message).join(" · ") }

    const transactionIds: string[] = []
    const runIds: string[] = []
    let parentTransactionId: string | null = null

    for (const [index, proposal] of split.proposals.entries()) {
      const outcome = await confirmOne(db, org, user.id, {
        runId: parsed.data.runId,
        proposal,
        // Las N partes comparten fichero y número: no son duplicados entre sí.
        skipDuplicateCheck: true,
        forceRevision: true,
        splitPart: { index, total: split.proposals.length, parentTransactionId },
      })
      if ("error" in outcome) {
        return {
          success: false,
          error: `La parte ${index + 1} de ${split.proposals.length} no se pudo contabilizar: ${outcome.error}`,
        }
      }
      transactionIds.push(outcome.value.transactionId)
      runIds.push(outcome.value.extractionRunId)
      parentTransactionId ??= outcome.value.transactionId
    }

    revalidatePath("/unsorted")
    revalidatePath("/transactions")
    return {
      success: true,
      data: { transactionIds, runIds, parentTransactionId: parentTransactionId as string },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Anular y rehacer (ADR-0014 D1, O-9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contra-asiento exacto y la operación de vuelta a `PROPOSED`, **sin volver a
 * subir el fichero** y sin disparar RC-12: el documento es el mismo y su
 * `sha256` también, así que re-subirlo sería un duplicado de manual.
 *
 * El asiento anulado no desaparece: el trigger de D1 lo traslada a
 * `voided_entry_id` y lo apila en `voided_entry_ids`, que es append-only.
 */
const revoidAndRedoActionImpl = withOrg(
  "EDITOR",
  async (
    { db, org, user },
    rawInput: unknown
  ): Promise<ActionState<{ transactionId: string; reversalEntryId: string | null; voidedEntryId: string | null }>> => {
    const parsed = revoidAndRedoSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const transaction = await db.transaction.findFirst({ where: { id: parsed.data.transactionId } })
    if (!transaction) return { success: false, error: "La operación no existe en esta organización" }
    if (transaction.status === "DRAFT" || transaction.status === "PROPOSED") {
      return { success: false, error: "La operación no está contabilizada: no hay nada que anular" }
    }

    let reversalEntryId: string | null = null
    if (transaction.status === "POSTED" && transaction.journalEntryId) {
      const voided = await voidEntry(org.id, transaction.journalEntryId, parsed.data.reason, { userId: user.id })
      if (!voided.ok) return { success: false, error: formatLedgerErrors(voided.errors) }
      reversalEntryId = voided.value.reversal.id
    }

    const reopened = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const current = await tx.transaction.findFirst({ where: { id: parsed.data.transactionId } })
      if (!current) abort(modelErr("TRANSACTION_NOT_FOUND", "transactionId", "La operación desapareció durante la anulación"))
      const updated = await tx.transaction.update({
        where: { id: parsed.data.transactionId },
        data: { status: "PROPOSED" },
      })
      await writeAuditLog(tx, {
        entity: "Transaction",
        entityId: parsed.data.transactionId,
        action: "REVOID_AND_REDO",
        before: { status: current.status, journalEntryId: current.journalEntryId },
        after: { status: "PROPOSED", voidedEntryId: updated.voidedEntryId, reversalEntryId },
        reason: parsed.data.reason,
        userId: user.id,
      })
      return updated
    })
    if (!reopened.ok) return { success: false, error: formatLedgerErrors(reopened.errors) }

    revalidatePath("/transactions")
    revalidatePath("/unsorted")
    return {
      success: true,
      data: {
        transactionId: parsed.data.transactionId,
        reversalEntryId,
        voidedEntryId: reopened.value.voidedEntryId,
      },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Forzados y actos auditados sobre la propuesta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forzar un campo **no edita el run**: crea uno de revisión con el valor
 * puesto a mano, el campo marcado `no_verificado` y el motivo en `AuditLog`.
 * Las cifras del pie —el total— no son forzables: eso lo decide
 * `applyFieldOverride`, no la pantalla.
 */
const forceOverrideActionImpl = withOrg(
  "EDITOR",
  async ({ db, org, user }, rawInput: unknown): Promise<ActionState<{ runId: string; field: string }>> => {
    const parsed = forceOverrideSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const loaded = await loadRun(db, parsed.data.runId)
    if ("error" in loaded) return { success: false, error: loaded.error }
    if (!loaded.proposal) return { success: false, error: "El run no tiene propuesta que forzar" }

    const overridden = applyFieldOverride(loaded.proposal, parsed.data.field, parsed.data.value)
    if (!overridden.ok) return { success: false, error: overridden.error.message }

    const created = await createRevisionWithAudit(db, org, user.id, loaded, overridden.proposal, {
      action: "FORCE_FIELD",
      reason: parsed.data.reason,
      before: { field: parsed.data.field, value: valueAt(loaded.proposal, parsed.data.field) },
      after: { field: parsed.data.field, value: parsed.data.value, confidence: "no_verificado" },
      forcedFields: [parsed.data.field],
    })
    if ("error" in created) return { success: false, error: created.error }

    revalidatePath("/unsorted")
    return { success: true, data: { runId: created.runId, field: parsed.data.field } }
  }
)

/**
 * Pasar un ticket a deducible es un **acto explícito y auditado** (art. 7.2 RD
 * 1619/2012, D9): la factura simplificada sólo da derecho a deducir si lleva el
 * NIF y el domicilio del destinatario y la cuota repercutida por separado, y eso
 * lo comprueba una persona mirando el papel, no un modelo.
 */
const markSimplifiedQualifiedActionImpl = withOrg(
  "EDITOR",
  async ({ db, org, user }, rawInput: unknown): Promise<ActionState<{ runId: string }>> => {
    const parsed = markSimplifiedQualifiedSchema.safeParse(rawInput)
    if (!parsed.success) return { success: false, error: formatZodError(parsed.error) }

    const loaded = await loadRun(db, parsed.data.runId)
    if ("error" in loaded) return { success: false, error: loaded.error }
    if (!loaded.proposal) return { success: false, error: "El run no tiene propuesta" }
    if (loaded.proposal.docKind !== "TICKET") {
      return { success: false, error: "Sólo una factura simplificada (ticket) se marca como cualificada" }
    }

    const proposal: ExtractionProposal = {
      ...loaded.proposal,
      simplifiedQualified: true,
      lines: loaded.proposal.lines.map((line) => ({ ...line, deductibility: "FULL" as const })),
    }

    const created = await createRevisionWithAudit(db, org, user.id, loaded, proposal, {
      action: "MARK_SIMPLIFIED_QUALIFIED",
      reason: parsed.data.reason,
      before: { simplifiedQualified: loaded.proposal.simplifiedQualified ?? false, deductibility: "NONE" },
      after: { simplifiedQualified: true, deductibility: "FULL" },
      forcedFields: [],
    })
    if ("error" in created) return { success: false, error: created.error }

    revalidatePath("/unsorted")
    return { success: true, data: { runId: created.runId } }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Las server actions exportadas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un fichero `"use server"` sólo puede exportar funciones async: los cuerpos
 * viven arriba envueltos en `withOrg(<rol>)` —que es quien aplica la matriz de
 * roles y traduce el `AuthzError` a «Sin permiso»— y aquí se exponen con la
 * misma forma que el resto de módulos de acciones del producto.
 */

export async function analyzeFileAction(input: unknown): Promise<Awaited<ReturnType<typeof analyzeFileActionImpl>>> {
  return await analyzeFileActionImpl(input)
}

export async function analyzeBatchAction(input: unknown): Promise<Awaited<ReturnType<typeof analyzeBatchActionImpl>>> {
  return await analyzeBatchActionImpl(input)
}

export async function previewProposalAction(input: unknown): Promise<Awaited<ReturnType<typeof previewProposalActionImpl>>> {
  return await previewProposalActionImpl(input)
}

export async function confirmProposalAction(input: unknown): Promise<Awaited<ReturnType<typeof confirmProposalActionImpl>>> {
  return await confirmProposalActionImpl(input)
}

export async function confirmBatchAction(input: unknown): Promise<Awaited<ReturnType<typeof confirmBatchActionImpl>>> {
  return await confirmBatchActionImpl(input)
}

export async function splitProposalAction(input: unknown): Promise<Awaited<ReturnType<typeof splitProposalActionImpl>>> {
  return await splitProposalActionImpl(input)
}

export async function revoidAndRedoAction(input: unknown): Promise<Awaited<ReturnType<typeof revoidAndRedoActionImpl>>> {
  return await revoidAndRedoActionImpl(input)
}

export async function forceOverrideAction(input: unknown): Promise<Awaited<ReturnType<typeof forceOverrideActionImpl>>> {
  return await forceOverrideActionImpl(input)
}

export async function markSimplifiedQualifiedAction(input: unknown): Promise<Awaited<ReturnType<typeof markSimplifiedQualifiedActionImpl>>> {
  return await markSimplifiedQualifiedActionImpl(input)
}

// ─────────────────────────────────────────────────────────────────────────────
// Núcleo compartido
// ─────────────────────────────────────────────────────────────────────────────

type LoadedRun = { run: ExtractionRun; file: File; proposal: ExtractionProposal | null }

async function loadRun(db: TenantClient, runId: string): Promise<LoadedRun | { error: string }> {
  const run = await getExtractionRun(db, runId)
  if (!run) return { error: "La extracción no existe en esta organización" }
  const file = await getFileById(db, run.fileId)
  if (!file) return { error: "El fichero de la extracción no existe en esta organización" }
  return { run, file, proposal: proposalOf(run) }
}

type Judged = {
  result: ReconcileResult
  warnings: readonly string[]
  counterpartyEnMaestro: boolean
}

/**
 * El veredicto, con el contexto leído de la base. `asRevision` describe el run
 * que va a respaldar el asiento: una revisión humana **no** es parcial —la
 * persona vio el documento entero— y es `MANUAL`, que es lo que abre la puerta
 * que RC-09 le cierra a un run parcial de un modelo (O-20.3).
 */
async function judge(
  db: TenantClient,
  org: Organization,
  run: ExtractionRun,
  file: File,
  proposal: ExtractionProposal,
  opts: { asRevision: boolean; skipDuplicateCheck?: boolean; categoryCode?: string | null }
): Promise<Judged> {
  const ctx = await buildReconcileContext(
    db,
    org,
    {
      proposal,
      run: opts.asRevision
        ? { ...run, kind: "MANUAL", partial: false, pagesSent: run.pagesTotal }
        : run,
      file,
    },
    {
      refDate: todayLocalDate(),
      ...(opts.categoryCode === undefined ? {} : { categoryCode: opts.categoryCode }),
      ...(opts.skipDuplicateCheck ? { skipDuplicateCheck: true } : {}),
    }
  )
  const result = reconcile(proposal, ctx)
  const warnings = documentWarnings(result, {
    counterpartyEnMaestro: ctx.counterparty?.enMaestro ?? false,
    withholdingRegime: ctx.counterparty?.withholdingRegime ?? null,
  })
  return { result, warnings, counterpartyEnMaestro: ctx.counterparty?.enMaestro ?? false }
}

/** El veredicto y el borrador, sin persistir nada (I-E8-8: el MISMO camino). */
async function previewOf(
  org: Organization,
  loaded: LoadedRun,
  judged: Judged,
  opts: { templateCode?: TemplateCode; closedYearAdjustmentKind?: "MATERIAL" | "NO_SIGNIFICATIVO" }
): Promise<ProposalPreview> {
  const sealed = sealedReconcile(judged.result, judged.warnings as never)
  const ledgerContext = await getLedgerContextOutside(org.id, judged.result.entryDate ?? todayLocalDate())
  const draft = previewFromProposal(judged.result, ledgerContext, {
    extractionRunId: loaded.run.id,
    fileId: loaded.file.id,
    ...opts,
  })

  return {
    runId: loaded.run.id,
    fileId: loaded.file.id,
    runKind: loaded.run.kind,
    partial: loaded.run.partial,
    status: judged.result.status,
    elegibleParaLote: judged.result.elegibleParaLote,
    sellos: judged.result.sellos,
    ivaPeriod: judged.result.ivaPeriod,
    entryDate: judged.result.entryDate,
    fiscalYearClosed: judged.result.fiscalYearClosed,
    checks: judged.result.checks.map((c) => ({
      id: c.id,
      regla: c.regla,
      status: c.status,
      blocksBatch: c.blocksBatch,
      message: c.message,
      evidence: c.evidence,
      fields: c.fields,
    })),
    fieldOrigins: judged.result.fieldOrigins as unknown as Record<string, unknown>,
    proposal: judged.result.normalized,
    warnings: judged.warnings,
    conversion: sealed.conversion,
    asiento: draft.ok ? entryPreviewOf(draft.value) : null,
    asientoError: draft.ok ? null : { code: draft.errors[0].code, message: draft.errors[0].message },
  }
}

function entryPreviewOf(posted: PostedProposal): EntryPreview {
  const lines: EntryLineView[] = posted.draft.lines.map((line, index) => {
    const doc = posted.documentaryLines[index]
    return {
      lineNo: line.lineNo ?? index + 1,
      accountCode: line.accountCode,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      description: line.description ?? null,
      taxRateCode: doc?.taxRateCode ?? null,
      deductibility: doc?.deductibility ?? null,
      nonDeductibleIncludedCents: doc?.nonDeductibleIncludedCents ?? 0,
      projectId: line.projectId ?? null,
      costCenterId: line.costCenterId ?? null,
      originalCurrency: line.originalCurrency ?? null,
      originalAmountCents: line.originalAmountCents ?? null,
    }
  })
  const totalDebitCents = lines.reduce((a, l) => a + l.debitCents, 0)
  const totalCreditCents = lines.reduce((a, l) => a + l.creditCents, 0)
  return {
    templateCode: posted.templateCode,
    sourceType: posted.draft.sourceType,
    entryDate: posted.draft.entryDate,
    documentDate: posted.draft.documentDate ?? null,
    receptionDate: posted.draft.receptionDate ?? null,
    operationDate: posted.draft.operationDate ?? null,
    ivaPeriod: posted.ivaPeriod,
    lines,
    totalDebitCents,
    totalCreditCents,
    descuadreCents: totalDebitCents - totalCreditCents,
    payableBlocks: posted.payableBlocks.map((b) => ({
      payableKey: b.payableKey,
      accountCode: b.accountCode,
      baseCents: b.baseCents,
      quotaCents: b.quotaCents,
      amountCents: b.amountCents,
    })),
    taxOverrides: posted.taxOverrides,
    ledgerBook: posted.ledgerBook,
  }
}

type ConfirmOptions = {
  runId: string
  proposal: ExtractionProposal
  templateCode?: TemplateCode
  forceReason?: string
  closedYearAdjustmentKind?: "MATERIAL" | "NO_SIGNIFICATIVO"
  idempotencyKey?: string
  transactionId?: string
  categoryCode?: string | null
  skipDuplicateCheck?: boolean
  /** El split siempre crea run de revisión: su propuesta no es la del run. */
  forceRevision?: boolean
  splitPart?: { index: number; total: number; parentTransactionId: string | null }
}

/**
 * Confirmar un documento, de principio a fin. El orden importa:
 *
 *  1. **Fuera de la transacción**: veredicto y borrador. Es donde está el
 *     cálculo, y donde puede tardar; una transacción abierta mientras tanto
 *     serializaría el ejercicio entero (§9).
 *  2. **Puertas**: FAIL ⇒ no hay asiento. Run parcial de un modelo ⇒ tampoco.
 *     Duplicado ⇒ hace falta motivo, y el motivo va a `AuditLog`.
 *  3. **Dentro de la transacción**: run de revisión si hubo ediciones, asiento,
 *     `Transaction` a `POSTED` con su `journalEntryId` y `AuditLog`. Todo o
 *     nada.
 */
async function confirmOne(
  db: TenantClient,
  org: Organization,
  userId: string,
  opts: ConfirmOptions
): Promise<{ value: ConfirmedProposal } | { error: string }> {
  const loaded = await loadRun(db, opts.runId)
  if ("error" in loaded) return { error: loaded.error }

  const edited = opts.forceRevision === true || proposalHash(opts.proposal) !== loaded.run.proposalSha

  // Idempotencia de negocio: si esta extracción (o su revisión) ya tiene
  // asiento vivo, se devuelve el que hay. Confirmar dos veces no contabiliza
  // dos veces (criterio de I-E8-4 y del test de doble ejecución).
  if (!opts.splitPart) {
    const already = await alreadyPosted(db, loaded.run.id)
    if (already) {
      return {
        value: {
          transactionId: already.transactionId,
          entryId: already.entryId,
          entryNumber: already.entryNumber,
          extractionRunId: already.extractionRunId,
          yaEstaba: true,
        },
      }
    }
  }

  const judged = await judge(db, org, loaded.run, loaded.file, opts.proposal, {
    asRevision: edited,
    ...(opts.skipDuplicateCheck ? { skipDuplicateCheck: true } : {}),
    ...(opts.categoryCode === undefined ? {} : { categoryCode: opts.categoryCode }),
  })

  if (judged.result.status === "FAIL") {
    const failed = judged.result.checks.filter((c) => c.status === "FAIL")
    return {
      error:
        "La propuesta no está reconciliada y por tanto no hay asiento: " +
        failed.map((c) => `${c.id} — ${c.message}`).join(" · "),
    }
  }

  // RC-12: un duplicado se confirma **con motivo**, y el motivo se audita
  // (I-E8-13). Es el vector clásico del doble pago y de la doble deducción.
  const duplicate = judged.result.checks.find((c) => c.id === "RC-12" && c.status !== "PASS")
  if (duplicate && !opts.forceReason) {
    return { error: `${duplicate.message}. Para contabilizarlo igualmente hace falta un motivo (queda en el registro de auditoría)` }
  }

  const refDate = todayLocalDate()
  const posted = await runLedgerTransaction(org.id, userId, async (tx) => {
    const ledgerContext = await getLedgerContext(tx, refDate)

    // 1 · Run de revisión (D5): el asiento apunta a ÉSTE, no al del modelo.
    const runId = edited
      ? (
          await createRevisionRun(tx, {
            parentRunId: loaded.run.id,
            proposal: judged.result.normalized,
            fieldOrigins: judged.result.fieldOrigins,
            reconcile: {
              status: judged.result.status,
              detail: sealedReconcile(judged.result, judged.warnings as never),
            },
            actorId: userId,
          })
        ).id
      : loaded.run.id

    // 2 · Operación: la que venga, o una nueva. Nunca dos para un documento.
    const transaction = opts.transactionId
      ? await tx.transaction.findFirst({ where: { id: opts.transactionId } })
      : null
    if (opts.transactionId && !transaction) {
      abort(modelErr("TRANSACTION_NOT_FOUND", "transactionId", "La operación indicada no existe en esta organización"))
    }

    const conversion = judged.result.conversion
    const transactionData = {
      name: judged.result.normalized.documentNumber ?? loaded.file.filename,
      merchant: judged.result.normalized.counterparty.name,
      description: judged.result.normalized.description ?? null,
      total: judged.result.normalized.totalCents,
      currencyCode: judged.result.normalized.currency,
      convertedTotal: conversion?.convertedTotalCents ?? null,
      convertedCurrencyCode: conversion ? org.baseCurrency : null,
      exchangeRateMicro: conversion?.rateMicro ?? null,
      rateDate: conversion ? new Date(`${conversion.rateDate}T00:00:00.000Z`) : null,
      rateSource: conversion?.source ?? null,
      extractionRunId: runId,
      issuedAt: judged.result.normalized.documentDate
        ? new Date(`${judged.result.normalized.documentDate}T00:00:00.000Z`)
        : null,
      type: isIncome(judged.result) ? "income" : "expense",
      files: [{ id: loaded.file.id, filename: loaded.file.filename }] as unknown as object,
      ...(opts.splitPart?.parentTransactionId ? { splitParentTransactionId: opts.splitPart.parentTransactionId } : {}),
    }

    const operation = transaction
      ? await tx.transaction.update({ where: { id: transaction.id }, data: transactionData })
      : await tx.transaction.create({
          data: { organizationId: org.id, createdById: userId, status: "DRAFT", ...transactionData },
        })

    // 3 · Asiento. La puerta de `postFromProposal` vuelve a comprobarlo todo:
    //     es pura y barata, y es la única que el motor reconoce.
    const draft = postFromProposal(judged.result, ledgerContext, {
      extractionRunId: runId,
      fileId: loaded.file.id,
      transactionId: operation.id,
      ...(opts.templateCode ? { templateCode: opts.templateCode } : {}),
      ...(opts.forceReason ? { forceReason: opts.forceReason } : {}),
      ...(opts.closedYearAdjustmentKind ? { closedYearAdjustmentKind: opts.closedYearAdjustmentKind } : {}),
    })
    // La puerta del motor aborta la transacción con sus errores TIPADOS: sin
    // `abortWith`, un `return` dejaría el COMMIT hecho y la operación creada.
    if (!draft.ok) abortWith(draft.errors)

    /**
     * Idempotencia de formulario: el doble clic no contabiliza dos veces. La
     * clave incluye **la propuesta** y **el número de anulaciones previas** de
     * la operación, porque `journal_entries.idempotency_key` es único: sin la
     * segunda, «anular y rehacer» con las mismas cifras devolvería el asiento
     * anulado en vez de crear el nuevo.
     */
    const entry = await postEntryTx(tx, draft.value.draft, { userId }, {
      idempotencyKey:
        opts.idempotencyKey ??
        idempotencyKeyFor(
          loaded.run.id,
          proposalHash(judged.result.normalized),
          operation.voidedEntryIds.length,
          opts.splitPart?.index ?? 0
        ),
    })

    // 4 · `POSTED ⟺ journalEntryId`, en la MISMA transacción (I-E8-4).
    await tx.transaction.update({
      where: { id: operation.id },
      data: { status: "POSTED", journalEntryId: entry.id },
    })

    await writeAuditLog(tx, {
      entity: "ExtractionRun",
      entityId: runId,
      action: "CONFIRM_PROPOSAL",
      before: { runId: loaded.run.id, reconcileStatus: loaded.run.reconcileStatus, edited },
      after: {
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        transactionId: operation.id,
        templateCode: draft.value.templateCode,
        ivaPeriod: draft.value.ivaPeriod,
        sellos: judged.result.sellos,
        warnings: judged.warnings,
      },
      reason: opts.forceReason ?? null,
      userId,
    })

    if (opts.forceReason && duplicate) {
      await writeAuditLog(tx, {
        entity: "Transaction",
        entityId: operation.id,
        action: "FORCE_DUPLICATE",
        before: { check: duplicate.id, evidence: duplicate.evidence },
        after: { entryId: entry.id, fileSha256: loaded.file.sha256 },
        reason: opts.forceReason,
        userId,
      })
    }

    await tx.file.update({ where: { id: loaded.file.id }, data: { isReviewed: true } })

    return { transactionId: operation.id, entryId: entry.id, entryNumber: entry.entryNumber, extractionRunId: runId }
  })

  if (!posted.ok) return { error: formatLedgerErrors(posted.errors) }
  return { value: { ...posted.value, yaEstaba: false } }
}

/** El asiento que esta extracción (o su revisión) ya produjo, si existe. */
async function alreadyPosted(
  db: TenantClient,
  runId: string
): Promise<{ transactionId: string; entryId: string; entryNumber: number; extractionRunId: string } | null> {
  const revisions = await db.extractionRun.findMany({ where: { parentRunId: runId }, select: { id: true } })
  const ids = [runId, ...revisions.map((r) => r.id)]
  const transaction = await db.transaction.findFirst({
    where: { extractionRunId: { in: ids }, status: "POSTED", journalEntryId: { not: null } },
    select: { id: true, journalEntryId: true, extractionRunId: true },
  })
  if (!transaction?.journalEntryId) return null
  const entry = await db.journalEntry.findFirst({
    where: { id: transaction.journalEntryId },
    select: { id: true, entryNumber: true },
  })
  if (!entry) return null
  return {
    transactionId: transaction.id,
    entryId: entry.id,
    entryNumber: entry.entryNumber,
    extractionRunId: transaction.extractionRunId ?? runId,
  }
}

const SALE_KINDS = new Set(["FACTURA_EMITIDA", "ABONO_EMITIDO", "FACTURA_ANTICIPO_CLIENTE"])
const isIncome = (result: ReconcileResult): boolean => SALE_KINDS.has(result.normalized.docKind)

/**
 * Un run de revisión con su `AuditLog`, para los actos que **no** contabilizan
 * (forzar un campo, marcar un ticket): el run nace juzgado y con sus avisos
 * sellados, y el acto queda registrado con su motivo.
 */
async function createRevisionWithAudit(
  db: TenantClient,
  org: Organization,
  userId: string,
  loaded: LoadedRun,
  proposal: ExtractionProposal,
  audit: {
    action: "FORCE_FIELD" | "MARK_SIMPLIFIED_QUALIFIED"
    reason: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    forcedFields: readonly string[]
  }
): Promise<{ runId: string } | { error: string }> {
  const judged = await judge(db, org, loaded.run, loaded.file, proposal, { asRevision: true })

  // El campo forzado pierde su confianza: es la marca que la pantalla pinta con
  // borde discontinuo y la que obliga a un motivo al confirmar.
  const fieldOrigins = { ...judged.result.fieldOrigins }
  for (const field of audit.forcedFields) {
    fieldOrigins[field] = {
      ...(fieldOrigins[field] ?? { value: null, origin: "usuario" as const }),
      origin: "usuario",
      confidence: "no_verificado",
    }
  }

  const created = await runLedgerTransaction(org.id, userId, async (tx) => {
    const run = await createRevisionRun(tx, {
      parentRunId: loaded.run.id,
      proposal: judged.result.normalized,
      fieldOrigins,
      reconcile: {
        status: judged.result.status,
        detail: sealedReconcile(judged.result, judged.warnings as never),
      },
      actorId: userId,
    })
    await writeAuditLog(tx, {
      entity: "ExtractionRun",
      entityId: run.id,
      action: audit.action,
      before: { parentRunId: loaded.run.id, ...audit.before },
      after: { runId: run.id, ...audit.after },
      reason: audit.reason,
      userId,
    })
    return run
  })
  if (!created.ok) return { error: formatLedgerErrors(created.errors) }
  return { runId: created.value.id }
}

/** Valor actual de un campo por su ruta, para el `before` del `AuditLog`. */
function valueAt(proposal: ExtractionProposal, path: string): unknown {
  const line = /^lines\[(\d+)\]\.(\w+)$/.exec(path)
  if (line) return (proposal.lines[Number(line[1])] as unknown as Record<string, unknown>)?.[line[2]]
  const tax = /^taxes\[([^\]]+)\]\.(\w+)$/.exec(path)
  if (tax) {
    const found = proposal.taxes.find((t) => t.taxRateCode === tax[1])
    return (found as unknown as Record<string, unknown>)?.[tax[2]]
  }
  const nested = /^counterparty\.(\w+)$/.exec(path)
  if (nested) return (proposal.counterparty as unknown as Record<string, unknown>)[nested[1]]
  return (proposal as unknown as Record<string, unknown>)[path]
}

/**
 * `reconcile` **cableado** para `runExtraction`: el run nace ya juzgado, con su
 * estado, sus 25 comprobaciones, sus desviaciones de cuota y sus avisos de
 * calidad sellados. El contexto lo aporta el documento que la extracción acaba
 * de leer —el mismo fichero, su sha y las páginas vistas—, de modo que una sola
 * función sirve para el análisis individual y para el lote.
 */
function reconcileHook(db: TenantClient, org: Organization, memo = newRateMemo()) {
  return async (
    proposal: ExtractionProposal,
    fieldOrigins: Record<string, unknown>,
    context: { file: File; fileSha256: string; pagesSent: number; pagesTotal: number }
  ) => {
    const ctx = await buildReconcileContext(
      db,
      org,
      {
        proposal,
        run: {
          kind: "LLM",
          partial: context.pagesSent < context.pagesTotal,
          pagesSent: context.pagesSent,
          pagesTotal: context.pagesTotal,
          fileSha256: context.fileSha256,
          rawOutput: {},
          fieldOrigins,
        } as never,
        file: context.file,
      },
      { refDate: todayLocalDate(), rateMemo: memo }
    )
    const result = reconcile(proposal, ctx)
    const warnings = documentWarnings(result, {
      counterpartyEnMaestro: ctx.counterparty?.enMaestro ?? false,
      withholdingRegime: ctx.counterparty?.withholdingRegime ?? null,
    })
    return {
      status: result.status,
      detail: sealedReconcile(result, warnings as never) as unknown,
      proposal: result.normalized,
      fieldOrigins: result.fieldOrigins,
    }
  }
}

/** Contexto del motor fuera de una transacción, para la previsualización. */
async function getLedgerContextOutside(organizationId: string, refDate: string) {
  const { getLedgerContextFor } = await import("@/models/ledger")
  return await getLedgerContextFor(organizationId, refDate)
}

/** `AuditLog` suelto, para los actos que no abren transacción del diario. */
async function writeAuditLogSolo(
  organizationId: string,
  userId: string,
  input: Parameters<typeof writeAuditLog>[1]
): Promise<void> {
  const { recordAuditLog } = await import("@/models/audit-log")
  await recordAuditLog(organizationId, { ...input, userId })
}

/**
 * Clave de idempotencia de 43 caracteres: `journal_entries.idempotency_key` es
 * `VarChar(64)` y la concatenación literal de dos uuid y un sha no cabe.
 */
function idempotencyKeyFor(runId: string, proposalSha: string, attempt: number, part: number): string {
  const digest = createHash("sha256").update(`${runId}|${proposalSha}|${attempt}|${part}`).digest("hex")
  return `e8-${digest.slice(0, 40)}`
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ─────────────────────────────────────────────────────────────────────────────
// Heredado de TaxHacker: alta manual y borrado. Se conservan (§8)
// ─────────────────────────────────────────────────────────────────────────────

export async function saveFileAsTransactionAction(
  _prevState: ActionState<Transaction> | null,
  formData: FormData
): Promise<ActionState<Transaction>> {
  try {
    const { db, org, user } = await requireOrg("EDITOR")
    const validatedForm = transactionFormSchema.safeParse(Object.fromEntries(formData.entries()))

    if (!validatedForm.success) {
      return { success: false, error: validatedForm.error.message }
    }

    // Get the file record
    const fileId = formData.get("fileId") as string
    const file = await getFileById(db, fileId)
    if (!file) throw new Error("File not found")

    const forceSave = formData.get("forceSave") === "true"
    const transactionData = validatedForm.data

    // --- Deduplication Check ---
    if (!forceSave) {
      const existingTransaction = await findDuplicateTransaction(db, transactionData)

      if (existingTransaction) {
        return {
          success: false,
          error: "DUPLICATE_FOUND",
          duplicateData: {
            existingTransaction: existingTransaction,
            newTransactionData: transactionData,
            resumeIndex: 0,
          },
        }
      }
    }

    const transaction = await createTransaction(db, validatedForm.data, { createdById: user.id })

    // Move file to processed location
    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)
    const originalFileName = path.basename(file.path)
    const newRelativeFilePath = getTransactionFileUploadPath(file.id, originalFileName, transaction)

    // Move file to new location and name
    const oldFullFilePath = safePathJoin(organizationUploadsDirectory, file.path)
    const newFullFilePath = safePathJoin(organizationUploadsDirectory, newRelativeFilePath)
    await mkdir(path.dirname(newFullFilePath), { recursive: true })
    await rename(path.resolve(oldFullFilePath), path.resolve(newFullFilePath))

    // Update file record
    await updateFile(db, file.id, {
      path: newRelativeFilePath,
      isReviewed: true,
    })

    await updateTransactionFiles(db, transaction.id, [file.id])
    await syncOrganizationStorage(org.id)

    revalidatePath("/unsorted")
    revalidatePath("/transactions")

    return { success: true, data: transaction }
  } catch (error) {
    console.error("Failed to save transaction:", error)
    return { success: false, error: `Failed to save transaction: ${error}` }
  }
}

export async function deleteUnsortedFileAction(
  _prevState: ActionState<Transaction> | null,
  fileId: string
): Promise<ActionState<Transaction>> {
  try {
    const { db, org } = await requireOrg("EDITOR")
    await deleteFile(db, fileId, getOrganizationUploadsDirectory(org))
    await syncOrganizationStorage(org.id)
    revalidatePath("/unsorted")
    return { success: true }
  } catch (error) {
    console.error("Failed to delete file:", error)
    return { success: false, error: "Failed to delete file" }
  }
}

/**
 * Partir el binario en N ficheros. **No es el split de E8**: eso es
 * `splitProposalAction`, que deja UN fichero y crea N operaciones sobre él
 * (O-9.iii). Esto se conserva para el caso en que un PDF traiga de verdad
 * varios documentos distintos, y por eso cada parte se vuelve a validar y se
 * sella con su propio `sha256`.
 */
export async function splitFileIntoItemsAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  try {
    const { db, org, user } = await requireOrg("EDITOR")
    const fileId = formData.get("fileId") as string
    const items = JSON.parse(formData.get("items") as string) as TransactionData[]

    if (!fileId || !items || items.length === 0) {
      return { success: false, error: "File ID and items are required" }
    }

    const originalFile = await getFileById(db, fileId)
    if (!originalFile) {
      return { success: false, error: "Original file not found" }
    }

    const organizationUploadsDirectory = getOrganizationUploadsDirectory(org)
    const originalFilePath = safePathJoin(organizationUploadsDirectory, originalFile.path)
    const fileContent = await readFile(originalFilePath)

    // Ronda 2 (#7): el nombre de la parte conserva la EXTENSIÓN del original (si
    // no, `unsortedFilePath` derivaba una extensión del nombre del item) y el
    // contenido vuelve a pasar por la validación, que además devuelve el
    // mimetype real: nunca se persiste el declarado por el cliente.
    const originalExtension = path.extname(originalFile.filename)
    const originalBaseName = path.basename(originalFile.filename, originalExtension)

    for (const item of items) {
      const fileUuid = randomUUID()
      const fileName = `${originalBaseName}-part-${item.name}${originalExtension}`
      const mimetype = assertAcceptableUpload(fileName, fileContent)
      const relativeFilePath = unsortedFilePath(fileUuid, fileName)
      const fullFilePath = safePathJoin(organizationUploadsDirectory, relativeFilePath)

      await mkdir(path.dirname(fullFilePath), { recursive: true })
      await writeFile(fullFilePath, fileContent)

      await createFile(db, {
        id: fileUuid,
        organizationId: org.id,
        uploadedById: user.id,
        filename: fileName,
        path: relativeFilePath,
        mimetype,
        sha256: sha256OfBuffer(fileContent),
        sizeBytes: fileContent.length,
        metadata: originalFile.metadata ?? undefined,
        isSplitted: true,
      })
    }

    await deleteFile(db, fileId, organizationUploadsDirectory)
    await syncOrganizationStorage(org.id)

    revalidatePath("/unsorted")
    return { success: true }
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return { success: false, error: error.message }
    }
    console.error("Failed to split file into items:", error)
    return { success: false, error: `Failed to split file into items: ${error}` }
  }
}
