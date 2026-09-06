"use server"

/**
 * E8 · T15/T16 — Puente entre el formulario del documento y las acciones de T13.
 *
 * Mismo papel que `app/(app)/ledger/ui-actions.ts` y
 * `app/(app)/analytics/allocations/ui-actions.ts`: **el navegador manda texto**
 * («1.234,56», «21») y es aquí, en el servidor, donde ese texto se convierte a
 * céntimos enteros con `lib/money.parseCents`. El cliente no multiplica por 100
 * ni suma bases: si lo hiciera, habría una aritmética contable en el navegador y
 * dos verdades posibles para la misma factura.
 *
 * Dos decisiones de este fichero que no son de estilo:
 *
 * 1. **La propuesta base la pone el servidor, no el formulario.** Lo que llega
 *    del cliente son sólo los campos que la pantalla deja editar; el resto
 *    —`withholding` (que fija el régimen de la contraparte, O-11),
 *    `advanceEntryId`, `readWithholding`, `rectifies`, `appliedAdvance*`— se
 *    toma de la propuesta ya sellada en el run. Un campo que la pantalla no
 *    enseña es un campo que el navegador no puede inventar.
 * 2. **Aquí no se juzga nada.** El veredicto sigue siendo de `reconcile()` a
 *    través de `previewProposalAction` / `confirmProposalAction`, que son las
 *    que aplican la matriz de roles. Este módulo traduce y delega.
 */

import {
  confirmProposalAction,
  previewProposalAction,
  type ConfirmedProposal,
  type ProposalPreview,
} from "@/app/(app)/unsorted/actions"
import type { ActionState } from "@/lib/actions"
import type { ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"
import { parseCents } from "@/lib/money"

// ─────────────────────────────────────────────────────────────────────────────
// Lo que el formulario manda: TEXTO
// ─────────────────────────────────────────────────────────────────────────────

export type RawProposalLine = {
  kind: string
  description: string
  /** `"1.234,56"` → 123456 céntimos, en el SERVIDOR. */
  baseText: string
  discountText: string
  taxRateCode: string
  accountCode: string
  deductibility: string
  projectId: string
  costCenterId: string
}

export type RawProposalTax = {
  taxRateCode: string
  baseText: string
  /** ADR-0014 D3: **ésta** es la cuota que se contabiliza, la del documento. */
  quotaText: string
  operationKey: string
}

export type RawProposal = {
  docKind: string
  documentNumber: string
  counterpartyName: string
  counterpartyTaxId: string
  documentDate: string
  accrualDate: string
  receptionDate: string
  operationDate: string
  currency: string
  totalText: string
  paymentKey: string
  description: string
  lines: RawProposalLine[]
  taxes: RawProposalTax[]
}

export type PreviewFromFormInput = {
  runId: string
  raw: RawProposal
  templateCode?: string
  closedYearAdjustmentKind?: "MATERIAL" | "NO_SIGNIFICATIVO"
}

export type ConfirmFromFormInput = PreviewFromFormInput & {
  forceReason?: string
  idempotencyKey?: string
}

const trimmed = (value: string): string => value.trim()
const orNull = (value: string): string | null => (trimmed(value) === "" ? null : trimmed(value))
const orUndefined = (value: string): string | undefined => (trimmed(value) === "" ? undefined : trimmed(value))

/**
 * Texto → céntimos, en el servidor y sólo aquí. Un campo vacío es `0`: la
 * propuesta exige el entero, y quien decide si ese cero cuadra con el documento
 * es RC-01/RC-03, no esta función.
 */
const cents = (text: string): number => parseCents(text) ?? 0

function toLine(raw: RawProposalLine): ProposalLine {
  const discount = parseCents(raw.discountText)
  const deductibility = orUndefined(raw.deductibility)
  return {
    kind: (orUndefined(raw.kind) ?? "OPERACION") as ProposalLine["kind"],
    baseCents: cents(raw.baseText),
    ...(discount !== null && discount !== 0 ? { discountCents: discount } : {}),
    taxRateCode: orNull(raw.taxRateCode),
    ...(orUndefined(raw.description) ? { description: trimmed(raw.description) } : {}),
    ...(orUndefined(raw.accountCode) ? { accountCode: trimmed(raw.accountCode) } : {}),
    ...(orUndefined(raw.projectId) ? { projectId: trimmed(raw.projectId) } : {}),
    ...(orUndefined(raw.costCenterId) ? { costCenterId: trimmed(raw.costCenterId) } : {}),
    ...(deductibility ? { deductibility: deductibility as ProposalLine["deductibility"] } : {}),
  }
}

function toTax(raw: RawProposalTax): ProposalTax {
  const operationKey = orUndefined(raw.operationKey)
  return {
    taxRateCode: trimmed(raw.taxRateCode),
    baseCents: cents(raw.baseText),
    quotaCents: cents(raw.quotaText),
    ...(operationKey ? { operationKey: operationKey as ProposalTax["operationKey"] } : {}),
  }
}

/**
 * Funde lo editado con lo sellado. La base es **la propuesta normalizada del
 * run**, que ya viene de `reconcile()`; encima se escriben sólo los campos que
 * la pantalla enseña.
 */
function merge(base: ExtractionProposal, raw: RawProposal): ExtractionProposal {
  const paymentKey = orUndefined(raw.paymentKey)
  return {
    ...base,
    docKind: (orUndefined(raw.docKind) ?? base.docKind) as ExtractionProposal["docKind"],
    documentNumber: orNull(raw.documentNumber),
    counterparty: {
      ...base.counterparty,
      name: orNull(raw.counterpartyName),
      taxId: orNull(raw.counterpartyTaxId),
    },
    documentDate: orNull(raw.documentDate),
    accrualDate: orNull(raw.accrualDate),
    receptionDate: orNull(raw.receptionDate),
    operationDate: orNull(raw.operationDate),
    currency: (orUndefined(raw.currency) ?? base.currency).toUpperCase(),
    totalCents: cents(raw.totalText),
    lines: raw.lines.map(toLine),
    taxes: raw.taxes.map(toTax),
    ...(paymentKey ? { paymentKey: paymentKey as ExtractionProposal["paymentKey"] } : {}),
    description: orNull(raw.description),
  }
}

/** Propuesta sellada del run, tal y como la devuelve la previsualización. */
async function baseProposalOf(runId: string): Promise<ExtractionProposal | { error: string }> {
  const sealed = await previewProposalAction({ runId })
  if (!sealed.success || !sealed.data) {
    return { error: sealed.error ?? "No se ha podido leer la propuesta de la extracción" }
  }
  return sealed.data.proposal
}

/**
 * Previsualiza la propuesta editada. No persiste nada y es de rol **VIEWER**:
 * ver el veredicto y el borrador del asiento es información de auditoría.
 */
export async function previewFromFormAction(input: PreviewFromFormInput): Promise<ActionState<ProposalPreview>> {
  const base = await baseProposalOf(input.runId)
  if ("error" in base) return { success: false, error: base.error }

  return await previewProposalAction({
    runId: input.runId,
    proposal: merge(base, input.raw),
    ...(input.templateCode ? { templateCode: input.templateCode } : {}),
    ...(input.closedYearAdjustmentKind ? { closedYearAdjustmentKind: input.closedYearAdjustmentKind } : {}),
  })
}

/**
 * Confirma. Si hubo ediciones, `confirmProposalAction` abre un **run de
 * revisión** colgado del original (D5): el run del modelo queda intacto byte a
 * byte y el asiento apunta al de la persona que asumió las cifras.
 */
export async function confirmFromFormAction(input: ConfirmFromFormInput): Promise<ActionState<ConfirmedProposal>> {
  const base = await baseProposalOf(input.runId)
  if ("error" in base) return { success: false, error: base.error }

  return await confirmProposalAction({
    runId: input.runId,
    proposal: merge(base, input.raw),
    ...(input.templateCode ? { templateCode: input.templateCode } : {}),
    ...(input.forceReason ? { forceReason: input.forceReason } : {}),
    ...(input.closedYearAdjustmentKind ? { closedYearAdjustmentKind: input.closedYearAdjustmentKind } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
}
