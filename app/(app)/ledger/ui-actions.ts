"use server"

import { postFromTemplateAction, previewTemplateAction as previewDraftAction } from "@/app/(app)/ledger/actions"
import { accountNames } from "@/app/(app)/ledger/shared"
import { requireOrg } from "@/lib/authz"
import type { ActionState } from "@/lib/actions"
import { coerceRawInput, type RawInput } from "@/lib/ledger-ui/template-fields"
import { isTemplateCode, TEMPLATES } from "@/lib/ledger/templates"
import { templateFormSpec } from "@/lib/ledger-ui/template-fields"
import { Role } from "@/prisma/client"

/**
 * E3 · T11 — Acciones de apoyo del formulario de plantilla.
 *
 * El formulario manda un mapa plano de **cadenas** (`lines.0.baseCents = "1.000,00"`).
 * Aquí, EN EL SERVIDOR, `coerceRawInput` lo convierte al input tipado que espera
 * el schema de la plantilla —los importes pasan a céntimos con
 * `lib/money.parseCents`— y se delega en las acciones de T9
 * (`previewTemplateAction` / `postFromTemplateAction`), que son las que llaman
 * al motor. Este fichero no construye asientos ni suma nada.
 */

export type PreviewLine = {
  lineNo: number
  accountCode: string
  accountName: string
  description?: string | null
  debitCents: number
  creditCents: number
}

export type EntryPreview = {
  entryDate: string
  description: string
  dateNote?: string | null
  lines: PreviewLine[]
  totalDebitCents: number
  totalCreditCents: number
  balanced: boolean
}

type PreviewState = ActionState<EntryPreview & { errors?: string[] }>

function specFor(templateCode: string) {
  if (!isTemplateCode(templateCode)) return null
  const template = TEMPLATES[templateCode]
  if (template.systemOnly) return null
  return templateFormSpec(template.code, template.label, template.block, template.schema)
}

/** Vista previa del asiento: lo construye el motor en el servidor y no persiste nada. */
export async function previewTemplateAction(templateCode: string, raw: RawInput): Promise<PreviewState> {
  const spec = specFor(templateCode)
  if (!spec) return { success: false, error: "Plantilla no disponible" }

  const state = await previewDraftAction({ templateCode, input: coerceRawInput(spec, raw) })
  if (!state.success || !state.data) {
    return { success: false, error: state.error ?? "No se ha podido construir el asiento" }
  }

  const { db } = await requireOrg(Role.VIEWER)
  const names = await accountNames(db)
  const draft = state.data

  const lines: PreviewLine[] = draft.lines.map((line) => ({
    lineNo: line.lineNo,
    accountCode: line.accountCode,
    accountName: names.get(line.accountCode) ?? line.accountCode,
    description: line.description ?? null,
    debitCents: line.debitCents,
    creditCents: line.creditCents,
  }))
  const totalDebitCents = lines.reduce((acc, l) => acc + l.debitCents, 0)
  const totalCreditCents = lines.reduce((acc, l) => acc + l.creditCents, 0)

  return {
    success: true,
    data: {
      entryDate: draft.entryDate,
      description: draft.description,
      lines,
      totalDebitCents,
      totalCreditCents,
      balanced: totalDebitCents === totalCreditCents,
    },
  }
}

/** Contabiliza la plantilla con los valores en bruto del formulario. EDITOR (lo exige T9). */
export async function postTemplateFormAction(
  templateCode: string,
  raw: RawInput
): Promise<ActionState<{ entryId?: string; entryNumber?: number; errors?: string[] }>> {
  const spec = specFor(templateCode)
  if (!spec) return { success: false, error: "Plantilla no disponible" }

  const state = await postFromTemplateAction({ templateCode, input: coerceRawInput(spec, raw) })
  if (!state.success || !state.data) {
    return { success: false, error: state.error ?? "No se ha podido contabilizar el asiento" }
  }
  return { success: true, data: { entryId: state.data.entryId, entryNumber: state.data.entryNumber } }
}
