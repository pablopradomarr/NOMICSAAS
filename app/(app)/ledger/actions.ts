"use server"

/**
 * E3 · T9 — Server actions del libro diario (`docs/design/E3-libro-diario.md` §4.2).
 *
 * Todas empiezan por `withOrg(<rol>)` y devuelven `ActionState`. Ninguna calcula
 * nada: componen el contexto, llaman al motor puro a través de `models/ledger.ts`
 * y traducen el `Result` a mensajes en español anclados a su línea.
 *
 * `refDate` («hoy») se decide AQUÍ, en el borde, nunca dentro de `lib/ledger/`.
 */

import {
  entryFilterSchema,
  manualEntrySchema,
  postTransactionSchema,
  runInvariantsSchema,
  templatePostSchema,
  templatePreviewSchema,
  voidEntrySchema,
} from "@/forms/ledger"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { buildEntry } from "@/lib/ledger/post"
import { parseCents } from "@/lib/money"
import type { Seal, Validacion } from "@/lib/ledger/invariants"
import type { EntryDraft, LocalDate, PostedEntry } from "@/lib/ledger/types"
import { tenantTransaction } from "@/lib/db"
import {
  formatLedgerErrors,
  getEntries,
  getEntry,
  getLedgerContext,
  listTemplates,
  LedgerModelError,
  LedgerResult,
  postEntry,
  todayLocalDate,
  postFromTemplate,
  postTransactionWithTemplate,
  previewTemplate,
  runLedgerInvariants,
  TemplateSummary,
  voidEntry,
} from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const LEDGER_PATH = "/ledger"

/** «Hoy» en la zona de la organización. El motor puro no lo calcula nunca. */
const today = (): LocalDate => todayLocalDate()

function toActionState<T>(result: LedgerResult<T>): ActionState<T> {
  return result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }
}

function invalid(error: z.ZodError): ActionState<never> {
  const issue = error.issues[0]
  return { success: false, error: issue ? `${issue.message}` : "Datos inválidos" }
}

/** Lo que la UI necesita de un asiento recién posteado. */
export type PostedEntrySummary = {
  entryId: string
  entryNumber: number
  entryDate: LocalDate
  fiscalYearId: string
  description: string
}

/**
 * Resultado del asiento manual: en el fallo devuelve los errores **anclados a
 * su línea**, para que el formulario los pinte junto a la fila (§6, criterio 2).
 */
export type ManualEntryResult = Partial<PostedEntrySummary> & { lineErrors?: Record<number, string> }

const lineErrorsOf = (errors: readonly LedgerModelError[]): Record<number, string> => {
  const out: Record<number, string> = {}
  for (const e of errors) {
    if (e.lineNo === undefined) continue
    out[e.lineNo] = out[e.lineNo] ? `${out[e.lineNo]} · ${e.message}` : e.message
  }
  return out
}

const failWithLines = (errors: readonly LedgerModelError[]): ActionState<ManualEntryResult> => ({
  success: false,
  error: formatLedgerErrors(errors),
  data: { lineErrors: lineErrorsOf(errors) },
})

const summarize = (entry: PostedEntry): PostedEntrySummary => ({
  entryId: entry.id,
  entryNumber: entry.entryNumber,
  entryDate: entry.entryDate,
  fiscalYearId: entry.fiscalYearId,
  description: entry.description,
})

// ─────────────────────────────────────────────────────────────────────────────
// Posteo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * T-20 · asiento manual. EDITOR.
 *
 * La fecha contable la fija `resolveEntryDate` a partir de devengo y documento:
 * el usuario no la elige (§2.2 del experto).
 */
export async function postManualEntryAction(input: unknown): Promise<ActionState<ManualEntryResult>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = manualEntrySchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const data = validated.data
    const refDate = today()

    const built = await tenantTransaction(org.id, user.id, async (tx) => {
      const ctx = await getLedgerContext(tx, refDate)
      return buildEntry(
        {
          organizationId: org.id,
          documentDate: data.documentDate ?? null,
          accrualDate: data.accrualDate ?? null,
          description: data.description,
          kind: "NORMAL",
          sourceType: "MANUAL",
          sourceId: data.sourceId ?? null,
          fileId: data.fileId ?? null,
          templateCode: "ASIENTO_MANUAL",
          lines: data.lines.map((l, i) => ({
            lineNo: i + 1,
            accountCode: l.accountCode,
            // El texto en euros se convierte AQUÍ, en el servidor.
            debitCents: l.debitCents ?? parseCents(l.debit ?? null) ?? 0,
            creditCents: l.creditCents ?? parseCents(l.credit ?? null) ?? 0,
            description: l.description ?? null,
            dueDate: l.dueDate ?? null,
            counterpartyId: l.counterpartyId ?? null,
            // E4 · T15: el destino analítico llega tal cual del formulario; el
            // tipo EFECTIVO lo resuelve `post.ts` (R-A2/R-A3/R-A4) y lo valida
            // `validateAnalytics`. Aquí no se decide ni se corrige nada.
            projectId: l.projectId ?? null,
            costCenterId: l.costCenterId ?? null,
            analyticType: l.analyticType ?? null,
          })),
        },
        ctx
      )
    })

    if (!built.ok) return failWithLines(built.errors)

    const posted = await postEntry(org.id, built.value, { userId: user.id }, {
      refDate,
      idempotencyKey: data.idempotencyKey ?? null,
    })
    if (!posted.ok) return failWithLines(posted.errors)

    revalidatePath(LEDGER_PATH)
    return { success: true, data: summarize(posted.value) }
  })()
}

/** T-01…T-24 · posteo desde plantilla de operativa. EDITOR. */
export async function postFromTemplateAction(input: unknown): Promise<ActionState<PostedEntrySummary>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = templatePostSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await postFromTemplate(
      org.id,
      validated.data.templateCode,
      validated.data.input,
      { userId: user.id },
      { refDate: validated.data.refDate ?? today(), idempotencyKey: validated.data.idempotencyKey ?? null }
    )
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(LEDGER_PATH)
    return { success: true, data: summarize(result.value) }
  })()
}

/**
 * Vista previa del asiento SIN persistir nada (§6): la UI enseña las líneas de
 * impuesto ya desglosadas y el reparto de prorrata antes de contabilizar.
 * VIEWER: no muta nada.
 */
export async function previewTemplateAction(input: unknown): Promise<ActionState<EntryDraft>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const validated = templatePreviewSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await previewTemplate(
      org.id,
      validated.data.templateCode,
      validated.data.input,
      { userId: user.id },
      { refDate: validated.data.refDate ?? today(), withBalances: true }
    )
    return toActionState(result)
  })()
}

/** Catálogo de plantillas para los formularios. VIEWER. */
export async function listTemplatesAction(): Promise<ActionState<TemplateSummary[]>> {
  return await withOrg(Role.VIEWER, async () => ({ success: true, data: listTemplates() }))()
}

/** Criterio 10 · «contabilizar» una operación heredada. EDITOR. */
export async function postTransactionAction(input: unknown): Promise<ActionState<PostedEntrySummary>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = postTransactionSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await postTransactionWithTemplate(
      org.id,
      validated.data.transactionId,
      validated.data.templateCode,
      validated.data.input,
      { userId: user.id },
      { refDate: validated.data.refDate ?? today(), idempotencyKey: validated.data.idempotencyKey ?? null }
    )
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(LEDGER_PATH)
    revalidatePath("/transactions")
    return { success: true, data: summarize(result.value.entry) }
  })()
}

/**
 * T-21 · anulación por contra-asiento. EDITOR, **motivo obligatorio** (CA-6).
 * La fecha la calcula el motor; `requestedDate` sólo puede retrasarla.
 */
export async function voidEntryAction(input: unknown): Promise<ActionState<PostedEntrySummary>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = voidEntrySchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)

    const result = await voidEntry(
      org.id,
      validated.data.entryId,
      validated.data.reason,
      { userId: user.id },
      { requestedDate: validated.data.requestedDate ?? null, refDate: today() }
    )
    if (!result.ok) return { success: false, error: formatLedgerErrors(result.errors) }
    revalidatePath(LEDGER_PATH)
    return { success: true, data: summarize(result.value.reversal) }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Consulta
// ─────────────────────────────────────────────────────────────────────────────

export async function listEntriesAction(
  input: unknown = {}
): Promise<ActionState<{ entries: PostedEntry[]; total: number }>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const validated = entryFilterSchema.safeParse(input ?? {})
    if (!validated.success) return invalid(validated.error)
    const { skip, take, ...filter } = validated.data

    const data = await tenantTransaction(org.id, user.id, async (tx) =>
      getEntries(tx, filter, { skip: skip ?? 0, take: take ?? 50 })
    )
    return { success: true, data }
  })()
}

export async function getEntryAction(entryId: string): Promise<ActionState<PostedEntry>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const entry = await tenantTransaction(org.id, user.id, async (tx) => getEntry(tx, entryId))
    if (!entry) return { success: false, error: "El asiento no existe" }
    return { success: true, data: entry }
  })()
}

/**
 * Invariantes + sello para la cabecera de los informes y la pestaña Auditoría.
 * VIEWER: es una lectura, y precisamente la que dice si las cifras se pueden
 * afirmar como comprobadas.
 */
export async function runInvariantsAction(
  input: unknown = {}
): Promise<ActionState<{ validacion: Validacion; sello: Seal }>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const validated = runInvariantsSchema.safeParse(input ?? {})
    if (!validated.success) return invalid(validated.error)

    const run = await runLedgerInvariants(org.id, {
      refDate: validated.data.refDate ?? today(),
      ...(validated.data.fiscalYearId ? { fiscalYearId: validated.data.fiscalYearId } : {}),
      actor: { userId: user.id },
    })
    return { success: true, data: run }
  })()
}
