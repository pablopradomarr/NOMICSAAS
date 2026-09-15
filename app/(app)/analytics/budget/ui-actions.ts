"use server"

/**
 * E10 · T15 — Acciones de apoyo del editor de presupuesto.
 *
 * Mismo papel que `app/(app)/analytics/allocations/ui-actions.ts`: el editor
 * manda **texto** —el usuario teclea `"1.200,00"` o `"−45.000"`— y es AQUÍ, en
 * el servidor, donde `lib/money.parseCents` lo convierte a céntimos enteros.
 * Hecha la conversión se delega en las acciones de T14
 * (`app/(app)/analytics/budget/actions.ts`), que comprueban el rol, validan con
 * `zod` y llaman al modelo. **El navegador nunca decide un céntimo.**
 *
 * Las dos funciones que no son mera traducción de formulario son lecturas:
 *
 * · `previewSealBudgetAction` calcula, **sin escribir nada**, el `budgetHash`
 *   que el sellado va a firmar, el `validTo` que le quedará a la versión
 *   anterior y qué informes caducan. El diálogo de sellado enseña eso ANTES de
 *   pedir la doble confirmación: firmar a ciegas no es firmar (§7).
 * · `applyDepreciationProposalAction` trae la propuesta de `68x` (Q-4) y la
 *   escribe **sólo cuando el usuario la acepta**, con la misma acción de
 *   celdas que el tecleo manual. La propuesta por sí sola no escribe.
 */

import {
  deleteBudgetCellsAction,
  importBudgetCsvAction,
  proposeDepreciationBudgetAction,
  upsertBudgetCellsAction,
  type BudgetImportPayload,
} from "@/app/(app)/analytics/budget/actions"
import type { ActionState } from "@/lib/actions"
import { marginConfigHash } from "@/lib/analytics/hash"
import { withOrg } from "@/lib/authz"
import { budgetHash as computeBudgetHash } from "@/lib/budget/hash"
import { tenantTransaction } from "@/lib/db"
import { parseCents } from "@/lib/money"
import { getAnalyticsConfig } from "@/models/analytics"
import { budgetLabel, getBudgetVersion, type DepreciationBudgetProposal, type UpsertCellsResult } from "@/models/budget"
import { Role } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// Celdas: texto → céntimos, EN EL SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────

/** Una celda tal y como la teclea el editor: el importe viaja en texto. */
export type RawBudgetCell = {
  month: string
  accountCode?: string | null
  projectId?: string | null
  costCenterId?: string | null
  analyticType: string
  /** `"1.200,00"` → 120000 céntimos. Vacío → `0`. */
  amountText: string
  signException?: boolean
  note?: string | null
}

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? "").trim()
  return text === "" ? null : text
}

/**
 * El signo menos **tipográfico** (`−`, U+2212) es el que la UI pinta en las
 * cifras de sólo lectura, y un usuario puede pegarlo en una celda desde una
 * hoja de cálculo. `parseCents` sólo entiende el ASCII, así que se normaliza
 * aquí, en el borde, antes de convertir. Sin esto, «−45.000» entraba como 0 sin
 * que nada lo dijera.
 */
const toCents = (text: string): number => parseCents(text.replace(/−/g, "-")) ?? 0

/**
 * Guardado **por lotes** de las celdas tocadas.
 *
 * **Ronda de integración E10.** Aquí sólo llegan celdas CON importe: una celda
 * que el usuario deja en blanco no es un `0,00 €`. Un cero declarado es una
 * decisión de presupuesto —«este proyecto no factura en agosto»— y una celda
 * vacía es la ausencia de decisión; escribir la primera por la segunda hacía
 * que la columna de presupuesto del informe afirmara algo que nadie decidió.
 * El editor separa las dos: lo tecleado viene por aquí y lo vaciado por
 * `deleteBudgetCellsFromFormAction`. Retirar líneas de una versión SELLADA
 * sigue siendo, por doctrina, una **revisión** y no un borrado: las dos
 * acciones exigen `BORRADOR` (`assertDraft`).
 */
export async function saveBudgetCellsFromFormAction(input: {
  budgetId: string
  cells: readonly RawBudgetCell[]
}): Promise<ActionState<UpsertCellsResult>> {
  return await upsertBudgetCellsAction({
    budgetId: input.budgetId,
    cells: input.cells.map((cell) => ({
      month: cell.month,
      accountCode: clean(cell.accountCode),
      projectId: clean(cell.projectId),
      costCenterId: clean(cell.costCenterId),
      analyticType: cell.analyticType,
      amountCents: toCents(cell.amountText),
      signException: cell.signException === true,
      note: clean(cell.note),
    })),
  })
}

/**
 * **Celda vaciada = línea retirada** (nunca `0,00 €`). El editor manda los ids
 * de las `BudgetLine` que componían la celda, que es lo que `getBudgetVersion`
 * devuelve en `cells[].id` y lo que `deleteBudgetCellsTx` espera.
 */
export async function deleteBudgetCellsFromFormAction(input: {
  budgetId: string
  cellIds: readonly string[]
}): Promise<ActionState<{ deleted: number }>> {
  return await deleteBudgetCellsAction({ budgetId: input.budgetId, cellIds: [...input.cellIds] })
}

/** Import CSV: el fichero se parsea en la acción de T14, no aquí. */
export async function importBudgetCsvFromFormAction(input: {
  budgetId: string
  csv: string
  delimiter: "," | ";"
  dryRun: boolean
}): Promise<ActionState<BudgetImportPayload>> {
  return await importBudgetCsvAction(input)
}

// ─────────────────────────────────────────────────────────────────────────────
// Previsualización del sellado (lectura pura)
// ─────────────────────────────────────────────────────────────────────────────

export type SealPreview = {
  budgetId: string
  label: string
  /** El hash que se va a firmar, calculado sobre la versión tal como quedará. */
  budgetHash: string
  marginConfigHash: string
  validFrom: string
  cellCount: number
  hoursLineCount: number
  /** La versión que se cierra y el `validTo` que se le pondrá (O-E10-8). */
  closesPrevious: { label: string; validTo: string } | null
  partialFrom: string | null
  /** Informes que caducan: sólo el de presupuesto (criterio 17). */
  expiringReports: readonly string[]
}

/** Día anterior a una fecha `YYYY-MM-DD`, sin zonas horarias. */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Lo que el diálogo de sellado enseña antes de pedir la doble confirmación.
 * **No escribe nada** y repite exactamente el cálculo de `sealBudgetTx`: el
 * hash sale de la misma función pura sobre la misma versión con
 * `status = VIGENTE`.
 */
export const previewSealBudgetAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: { budgetId: string; validFrom?: string }): Promise<ActionState<SealPreview>> => {
    const preview = await tenantTransaction(org.id, user.id, async (tx) => {
      const version = await getBudgetVersion(tx, input.budgetId)
      if (!version) return null
      const config = await getAnalyticsConfig(tx, { periodEnd: version.fiscalYearEnd })
      const configHash = marginConfigHash(config)
      const validFrom = input.validFrom && input.validFrom.trim() !== "" ? input.validFrom : version.validFrom
      const hash = computeBudgetHash({ ...version, validFrom, status: "VIGENTE" }, configHash)

      const previous = await tx.budget.findFirst({
        where: {
          fiscalYearId: version.fiscalYearId,
          status: "VIGENTE",
          id: { not: version.id },
          validFrom: { lt: new Date(`${validFrom}T00:00:00.000Z`) },
          OR: [{ validTo: null }, { validTo: { gte: new Date(`${validFrom}T00:00:00.000Z`) } }],
        },
        orderBy: { validFrom: "desc" },
        include: { fiscalYear: { select: { code: true } } },
      })

      const result: SealPreview = {
        budgetId: version.id,
        label: version.code,
        budgetHash: hash,
        marginConfigHash: configHash,
        validFrom,
        cellCount: version.cells.length,
        hoursLineCount: version.hours.length,
        closesPrevious: previous
          ? {
              label: budgetLabel(previous.fiscalYear.code, previous.scenario, previous.revision),
              validTo: previousDay(validFrom),
            }
          : null,
        partialFrom: version.partialFrom,
        expiringReports: ["PRESUPUESTO_REAL"],
      }
      return result
    })
    if (!preview) return { success: false, error: "La versión de presupuesto no existe en esta organización" }
    return { success: true, data: preview }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Q-4 — «Precargar amortización»
// ─────────────────────────────────────────────────────────────────────────────

export type DepreciationApplyResult = {
  written: number
  /** Líneas propuestas que no se pudieron escribir, con su motivo. */
  skipped: readonly { assetCode: string; reason: string }[]
}

/** La propuesta, sin escribir nada: el usuario la ve antes de aceptarla. */
export async function proposeDepreciationAction(
  fiscalYearId: string
): Promise<ActionState<DepreciationBudgetProposal>> {
  return await proposeDepreciationBudgetAction({ fiscalYearId })
}

/**
 * Acepta la propuesta: la escribe con la MISMA acción que el tecleo manual, así
 * que pasa por la validación de signo, el `marginLevel` congelado y el
 * `AuditLog`. Un activo sin destino analítico **no se inventa**: se omite con su
 * motivo, porque la celda exige proyecto o CECO (O-A6).
 */
export async function applyDepreciationProposalAction(input: {
  budgetId: string
  fiscalYearId: string
}): Promise<ActionState<DepreciationApplyResult>> {
  const proposal = await proposeDepreciationBudgetAction({ fiscalYearId: input.fiscalYearId })
  if (!proposal.success || !proposal.data) {
    return { success: false, error: proposal.error ?? "No se ha podido componer la propuesta de amortización" }
  }
  const skipped = [...proposal.data.skipped]
  const cells = proposal.data.lines
    .filter((line) => {
      if (line.projectId === null && line.costCenterId === null) {
        skipped.push({
          assetCode: line.assetCode,
          reason: "el activo no tiene destino analítico (proyecto o centro de coste): decláralo en su ficha",
        })
        return false
      }
      return true
    })
    .map((line) => ({
      month: line.month,
      accountCode: line.accountCode,
      projectId: line.projectId,
      costCenterId: line.costCenterId,
      analyticType: "AMORTIZACION_DETERIORO",
      amountCents: line.amountCents,
      signException: false,
      note: `Amortización presupuestada del activo ${line.assetCode} (propuesta Q-4)`,
    }))

  if (cells.length === 0) {
    return { success: true, data: { written: 0, skipped } }
  }
  const state = await upsertBudgetCellsAction({ budgetId: input.budgetId, cells })
  if (!state.success) return { success: false, error: state.error ?? "No se ha podido escribir la propuesta" }
  return { success: true, data: { written: state.data?.written ?? 0, skipped } }
}
