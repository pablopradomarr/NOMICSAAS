"use server"

/**
 * E9 · T15 — Server actions del inmovilizado (§5.2, ADR-0016 D2 y D11).
 *
 * Dos cosas que sólo pasan aquí y no en el modelo:
 *
 * · **La atribución por activo (O-19).** `postEntryTx` **no** persiste
 *   `JournalLine.fixedAssetId` —hallazgo de B3—, así que toda acción que postea
 *   una línea de `68x`/`28x`/`671`/`771` llama a `attributeLinesToAssetTx`
 *   **en la misma transacción**. Sin esa llamada, I-E9-5 saldría `INFO` para
 *   todos los activos, que es justo lo que O-19 vino a cerrar.
 * · **Los avisos fiscales de la baja y la venta** (`disposalWarnings`): el
 *   art. 110 LIVA y el art. 20.Uno.22º no se automatizan, **se enseñan**. Viajan
 *   en el resultado para que la pantalla los pinte junto a la vista previa.
 */

import {
  createAssetSchema,
  disposeAssetSchema,
  listAssetsSchema,
  previewDepreciationSchema,
  reviseAssetSchema,
  sellAssetSchema,
} from "@/forms/assets"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import {
  accumulatedThrough,
  depreciationSchedule,
  disposalWarnings,
  type DepreciationRow,
  type DisposalWarning,
} from "@/lib/closing/depreciation"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { EntryDraft, LocalDate } from "@/lib/ledger/types"
import { periodKeyOf } from "@/lib/recurring/schedule"
import {
  attributeLinesToAssetTx,
  createAssetTx,
  markAssetDisposedTx,
  readAssetsWithRevisions,
  reviseAssetTx,
  type AssetWithRevisions,
} from "@/models/assets"
import { formatLedgerErrors, getLedgerContext, postEntryTx, runLedgerTransaction, todayLocalDate, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const ASSETS_PATH = "/settings/assets"

const today = (): LocalDate => todayLocalDate()

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos
// ─────────────────────────────────────────────────────────────────────────────

/** Ficha del activo con su cuadro y el enlace al asiento de cada periodo (O-19). */
export type AssetDetail = {
  asset: AssetWithRevisions["asset"]
  revisions: AssetWithRevisions["revisions"]
  schedule: DepreciationRow[]
  /** `periodo → entryId` de la dotación, para el drill-down en ≤ 3 clics. */
  postedPeriods: string[]
  accumulatedCents: number
  scheduleHash: string
}

export type DisposalResult = {
  fixedAssetId: string
  kind: "BAJA" | "VENTA"
  entryId: string | null
  entryNumber: number | null
  draft: EntryDraft | null
  attributedLines: number
  warnings: DisposalWarning[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const listAssetsAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<AssetDetail[]>> => {
    const parsed = listAssetsSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const cutoff = parsed.data.cutoff ?? today()
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      readAssetsWithRevisions(tx, { cutoff, assetId: parsed.data.assetId ?? undefined })
    )
    return { success: true, data: rows.map(toDetail) }
  }
)

/** Vista previa de la cuota de un periodo. No postea: sólo enseña el cuadro. */
export const previewDepreciationAction = withOrg(
  Role.VIEWER,
  async (ctx, input: unknown): Promise<ActionState<{ period: string; quotaCents: number; accumulatedCents: number }>> => {
    const parsed = previewDepreciationSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const rows = await tenantTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      readAssetsWithRevisions(tx, { assetId: parsed.data.fixedAssetId })
    )
    const asset = rows[0]
    if (!asset) return { success: false, error: "El activo no existe en esta organización" }
    const schedule = depreciationSchedule(asset.asset, asset.revisions)
    const row = schedule.find((r) => r.period === parsed.data.period)
    if (!row) return { success: false, error: `El cuadro no tiene fila para el periodo ${parsed.data.period}` }
    return {
      success: true,
      data: { period: row.period, quotaCents: row.quotaCents, accumulatedCents: row.accumulatedCents },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Alta y revisión (EDITOR)
// ─────────────────────────────────────────────────────────────────────────────

export const createAssetAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ id: string; code: string; scheduleHash: string }>> => {
    const parsed = createAssetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const row = await createAssetTx(tx, { ...v, isCapitalGood: v.isCapitalGood ?? undefined }, { userId: ctx.user.id })
      return { id: row.id, code: row.code, scheduleHash: row.scheduleHash }
    })
    if (result.ok) revalidatePath(ASSETS_PATH)
    return toActionState(result)
  }
)

export const reviseAssetAction = withOrg(
  Role.EDITOR,
  async (ctx, input: unknown): Promise<ActionState<{ scheduleHash: string }>> => {
    const parsed = reviseAssetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) =>
      reviseAssetTx(tx, parsed.data, { userId: ctx.user.id })
    )
    if (result.ok) revalidatePath(ASSETS_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Baja y venta (ADMIN) — T-33 y T-34
// ─────────────────────────────────────────────────────────────────────────────

export const disposeAssetAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<DisposalResult>> => {
    const parsed = disposeAssetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const [asset] = await readAssetsWithRevisions(tx, { assetId: v.fixedAssetId, cutoff: v.disposalDate })
      if (!asset) throw new Error("El activo no existe en esta organización")
      const schedule = depreciationSchedule(asset.asset, asset.revisions)
      const accumulated = accumulatedThrough(schedule, periodKeyOf(v.disposalDate, "MENSUAL"))

      const lctx = await getLedgerContext(tx, v.disposalDate)
      const built = buildFromTemplate(
        "BAJA_INMOVILIZADO",
        {
          documentDate: v.disposalDate,
          entryDate: v.disposalDate,
          fixedAssetId: asset.asset.id,
          assetCode: asset.asset.code,
          assetAccountCode: asset.asset.assetAccountCode,
          accumulatedAccountCode: asset.asset.accumulatedAccountCode,
          acquisitionCostCents: asset.asset.acquisitionCostCents,
          accumulatedCents: accumulated,
          description: `Baja de ${asset.asset.code} · ${v.reason}`,
        },
        lctx
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))

      const entry = await postEntryTx(tx, built.value, { userId: ctx.user.id })
      // O-19: `postEntryTx` no persiste `fixedAssetId`; se atribuye aquí mismo.
      const attributed = await attributeLinesToAssetTx(tx, { entryId: entry.id, fixedAssetId: asset.asset.id })
      await markAssetDisposedTx(
        tx,
        { fixedAssetId: v.fixedAssetId, kind: "BAJA", disposalDate: v.disposalDate, disposalEntryId: entry.id, reason: v.reason },
        { userId: ctx.user.id }
      )
      return {
        fixedAssetId: v.fixedAssetId,
        kind: "BAJA" as const,
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        draft: built.value,
        attributedLines: attributed,
        warnings: disposalWarnings(asset.asset, { kind: "BAJA", date: v.disposalDate, lossAccountCode: v.lossAccountCode ?? "671" }),
      }
    })
    if (result.ok) revalidatePath(ASSETS_PATH)
    return toActionState(result)
  }
)

export const sellAssetAction = withOrg(
  Role.ADMIN,
  async (ctx, input: unknown): Promise<ActionState<DisposalResult>> => {
    const parsed = sellAssetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(ctx.org.id, ctx.user.id, async (tx) => {
      const [asset] = await readAssetsWithRevisions(tx, { assetId: v.fixedAssetId, cutoff: v.disposalDate })
      if (!asset) throw new Error("El activo no existe en esta organización")
      const schedule = depreciationSchedule(asset.asset, asset.revisions)
      const accumulated = accumulatedThrough(schedule, periodKeyOf(v.disposalDate, "MENSUAL"))

      const lctx = await getLedgerContext(tx, v.disposalDate)
      const built = buildFromTemplate(
        "VENTA_INMOVILIZADO",
        {
          documentDate: v.disposalDate,
          entryDate: v.disposalDate,
          fixedAssetId: asset.asset.id,
          assetCode: asset.asset.code,
          assetAccountCode: asset.asset.assetAccountCode,
          accumulatedAccountCode: asset.asset.accumulatedAccountCode,
          acquisitionCostCents: asset.asset.acquisitionCostCents,
          accumulatedCents: accumulated,
          counterpartyId: v.counterpartyId ?? undefined,
          priceCents: v.salePriceCents,
          taxRateCode: v.taxRateCode ?? undefined,
          receivableAccountCode: v.receivableAccountCode,
          description: `Venta de ${asset.asset.code} · ${v.reason}`,
        },
        lctx
      )
      if (!built.ok) throw new Error(formatLedgerErrors(built.errors as never))

      const entry = await postEntryTx(tx, built.value, { userId: ctx.user.id })
      const attributed = await attributeLinesToAssetTx(tx, { entryId: entry.id, fixedAssetId: asset.asset.id })
      await markAssetDisposedTx(
        tx,
        { fixedAssetId: v.fixedAssetId, kind: "VENTA", disposalDate: v.disposalDate, disposalEntryId: entry.id, reason: v.reason },
        { userId: ctx.user.id }
      )
      return {
        fixedAssetId: v.fixedAssetId,
        kind: "VENTA" as const,
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        draft: built.value,
        attributedLines: attributed,
        warnings: disposalWarnings(asset.asset, {
          kind: "VENTA",
          date: v.disposalDate,
          priceCents: v.salePriceCents,
          receivableAccountCode: v.receivableAccountCode,
          lossAccountCode: "671",
        }),
      }
    })
    if (result.ok) revalidatePath(ASSETS_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

function toDetail(row: AssetWithRevisions): AssetDetail {
  return {
    asset: row.asset,
    revisions: row.revisions,
    schedule: depreciationSchedule(row.asset, row.revisions),
    postedPeriods: row.postedPeriods,
    accumulatedCents: row.accumulatedCents,
    scheduleHash: row.asset.scheduleHash,
  }
}
