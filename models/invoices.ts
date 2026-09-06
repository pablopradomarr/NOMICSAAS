/**
 * E8 · T18 — facturas EMITIDAS: numeración por serie y emisión → asiento.
 *
 * Tres reglas gobiernan este fichero:
 *
 * 1. **La numeración la da la base de datos, no el formulario.** `FOR UPDATE`
 *    sobre la fila de la serie serializa a los emisores concurrentes; el trigger
 *    `invoice_series_no_gaps` de T3 impide que el contador retroceda o salte, y
 *    I-E8-20 comprueba después que la sucesión emitida es 1..N sin huecos (art.
 *    6.1.a RD 1619/2012). Una factura emitida **no se borra ni se renumera**.
 * 2. **Las cifras se recalculan en servidor** (G-21): del cliente sólo entran
 *    cantidad, precio unitario y código de tipo. Lo demás sale de
 *    `lib/invoices/totals.ts` y del motor de E3.
 * 3. **Número y asiento nacen en la MISMA transacción.** Si el asiento no cuadra
 *    o el mes está bloqueado, el número tampoco se consume: no hay hueco.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { retencion, selectRate } from "@/lib/ledger/tax"
import type { LedgerContext, LocalDate, PostedEntry } from "@/lib/ledger/types"
import type { Cents } from "@/lib/money"
import { sumCents } from "@/lib/money"
import type { InvoiceSeriesKind } from "@/prisma/client"
import type { Actor } from "@/models/accounts"
import {
  abort,
  abortWith,
  getLedgerContext,
  modelErr,
  postEntryTx,
  runLedgerTransaction,
  type LedgerResult,
} from "@/models/ledger"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { EmitInvoiceInput } from "@/forms/invoices"
import {
  computeInvoiceTotals,
  substitutionDeltaByRate,
  type EmitInvoiceLine,
  type InvoiceTotals,
} from "@/lib/invoices/totals"

// ─────────────────────────────────────────────────────────────────────────────
// Series
// ─────────────────────────────────────────────────────────────────────────────

export type InvoiceSeriesRow = {
  id: string
  code: string
  kind: InvoiceSeriesKind
  prefix: string
  nextNumber: number
  year: number | null
}

export type AssignedNumber = {
  seriesId: string
  seriesCode: string
  kind: InvoiceSeriesKind
  number: number
  /** Número completo tal y como sale en el documento: `prefix || number`. */
  documentNumber: string
}

/** Formato del número emitido. Cinco dígitos, que es lo que cabe en un ejercicio. */
export const formatInvoiceNumber = (prefix: string, number: number): string =>
  `${prefix}${String(number).padStart(5, "0")}`

/**
 * Reserva el siguiente número de la serie del tipo pedido, **con `FOR UPDATE`**.
 *
 * El bloqueo es de fila y sólo serializa a quien emite en ESA serie: dos
 * usuarios emitiendo a la vez obtienen números distintos y consecutivos, y el
 * segundo espera al COMMIT del primero. Sin el bloqueo, dos lecturas del mismo
 * `next_number` producen la misma factura dos veces —el error que ninguna
 * inspección perdona—.
 *
 * Debe llamarse **dentro** de la transacción que crea el asiento: si ésta
 * revierte, el número vuelve atrás y no queda hueco.
 */
export async function nextInvoiceNumberTx(
  tx: TenantTransactionClient,
  opts: { kind: InvoiceSeriesKind; seriesCode?: string; year?: number | null }
): Promise<AssignedNumber> {
  const organizationId = tx.$organizationId
  const year = opts.year ?? null

  const rows = await tx.$queryRaw<
    { id: string; code: string; kind: InvoiceSeriesKind; prefix: string; next_number: number; year: number | null }[]
  >`
    SELECT "id", "code", "kind", "prefix", "next_number", "year"
      FROM "invoice_series"
     WHERE "organization_id" = ${organizationId}::uuid
       AND "kind" = ${opts.kind}::"invoice_series_kind"
       AND "is_active"
       AND (${opts.seriesCode ?? null}::text IS NULL OR "code" = ${opts.seriesCode ?? null}::text)
       AND ("year" IS NULL OR "year" = ${year}::int)
     ORDER BY "year" DESC NULLS LAST, "code" ASC
     LIMIT 1
     FOR UPDATE
  `

  const series = rows[0]
  if (!series) {
    abort(
      modelErr(
        "TEMPLATE_INPUT",
        "seriesKind",
        `No hay ninguna serie activa de tipo ${opts.kind}${opts.seriesCode ? ` con código ${opts.seriesCode}` : ""}: ` +
          "configúrela en Ajustes → Facturación antes de emitir"
      )
    )
  }

  const number = series.next_number
  await tx.$executeRaw`
    UPDATE "invoice_series"
       SET "next_number" = "next_number" + 1, "updated_at" = now()
     WHERE "id" = ${series.id}::uuid AND "organization_id" = ${organizationId}::uuid
  `

  return {
    seriesId: series.id,
    seriesCode: series.code,
    kind: series.kind,
    number,
    documentNumber: formatInvoiceNumber(series.prefix, number),
  }
}

export const listInvoiceSeries = async (db: TenantClient): Promise<InvoiceSeriesRow[]> =>
  (
    await db.invoiceSeries.findMany({
      orderBy: [{ kind: "asc" }, { code: "asc" }],
      select: { id: true, code: true, kind: true, prefix: true, nextNumber: true, year: true },
    })
  ).map((s) => ({ ...s }))

// ─────────────────────────────────────────────────────────────────────────────
// I-E8-20 · numeración correlativa por serie y ejercicio
// ─────────────────────────────────────────────────────────────────────────────

export type NumberingGap = {
  seriesId: string
  seriesCode: string
  fiscalYear: number
  /** Números que la serie debería haber emitido y que no están en el diario. */
  missing: number[]
  /** Números emitidos más de una vez. */
  duplicated: number[]
  /** Pares (número menor con fecha posterior) dentro de la serie. */
  outOfOrder: { number: number; documentDate: string }[]
}

/**
 * **I-E8-20.** La numeración de cada serie es correlativa por ejercicio y su
 * fecha no decrece: si falta un número, o hay uno repetido, o el 7 es de marzo y
 * el 6 de abril, la organización tiene un problema registral que ninguna cifra
 * del balance denuncia.
 *
 * Se mide sobre el **diario**, que es la fuente única (ADR-0003): el contador de
 * la serie dice cuántos se han repartido; los asientos, cuáles existen de
 * verdad. Un contador adelantado sin asiento detrás **es** un hueco.
 */
export async function checkInvoiceNumberingGaps(db: TenantClient): Promise<NumberingGap[]> {
  const series = await listInvoiceSeries(db)
  if (series.length === 0) return []

  const gaps: NumberingGap[] = []
  for (const s of series) {
    const emitted = await db.journalEntry.findMany({
      where: {
        sourceType: { in: ["INVOICE_OUT"] },
        sourceId: { startsWith: s.prefix },
      },
      select: { sourceId: true, documentDate: true },
      orderBy: { documentDate: "asc" },
    })

    const byYear = new Map<number, { number: number; documentDate: string }[]>()
    for (const row of emitted) {
      const suffix = (row.sourceId ?? "").slice(s.prefix.length)
      if (!/^\d+$/.test(suffix)) continue
      const documentDate = row.documentDate ? row.documentDate.toISOString().slice(0, 10) : ""
      const year = s.year ?? (documentDate ? Number(documentDate.slice(0, 4)) : 0)
      const list = byYear.get(year) ?? []
      list.push({ number: Number(suffix), documentDate })
      byYear.set(year, list)
    }

    for (const [fiscalYear, list] of byYear) {
      const sorted = [...list].sort((a, b) => a.number - b.number)
      const seen = new Set<number>()
      const duplicated: number[] = []
      for (const item of sorted) {
        if (seen.has(item.number)) duplicated.push(item.number)
        seen.add(item.number)
      }
      // El contador dice cuántos se repartieron; el diario, cuáles existen.
      const highest = Math.max(s.nextNumber - 1, ...sorted.map((i) => i.number))
      const missing: number[] = []
      for (let n = 1; n <= highest; n++) if (!seen.has(n)) missing.push(n)

      const outOfOrder: { number: number; documentDate: string }[] = []
      let previousDate = ""
      for (const item of sorted) {
        if (item.documentDate && previousDate && item.documentDate < previousDate) outOfOrder.push(item)
        if (item.documentDate) previousDate = item.documentDate
      }

      if (missing.length > 0 || duplicated.length > 0 || outOfOrder.length > 0) {
        gaps.push({ seriesId: s.id, seriesCode: s.code, fiscalYear, missing, duplicated, outOfOrder })
      }
    }
  }
  return gaps
}

// ─────────────────────────────────────────────────────────────────────────────
// Emisión → asiento (T-01 / T-02)
// ─────────────────────────────────────────────────────────────────────────────

export type EmittedInvoice = {
  entry: PostedEntry
  transactionId: string
  documentNumber: string
  seriesId: string
  baseTotalCents: Cents
  taxTotalCents: Cents
  withholdingCents: Cents
  totalCents: Cents
}

/** Tipo en puntos básicos vigente al devengo, o `null` si no hay ninguno. */
function rateBpsAt(ctx: LedgerContext, code: string, date: LocalDate, side: "SALE" | "PURCHASE"): number | null {
  const selected = selectRate(ctx, code, date, side)
  return "error" in selected ? null : selected.rate.rateBps
}

/**
 * Bases de la factura ORIGINAL, por tipo, leídas del asiento. Es lo que necesita
 * la rectificativa por sustitución para contabilizar la **diferencia** y no la
 * cifra nueva (ADR-0014 D12). Salen de `taxBaseCents` de las líneas de IVA
 * repercutido, que es donde el motor de E3 las sella.
 */
async function originalBasesByRate(
  tx: TenantTransactionClient,
  ctx: LedgerContext,
  entryId: string
): Promise<{ taxRateCode: string; baseCents: Cents }[]> {
  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId },
    select: { lines: { select: { taxRateId: true, taxBaseCents: true }, orderBy: { lineNo: "asc" } } },
  })
  if (!entry) {
    abort(modelErr("ENTRY_NOT_FOUND", "rectifies.entryId", "La factura que se rectifica no existe en esta organización"))
  }
  const byCode = new Map<string, Cents>()
  for (const line of entry.lines) {
    if (!line.taxRateId || line.taxBaseCents === null) continue
    const rate = ctx.rates.find((r) => r.id === line.taxRateId)
    if (!rate) continue
    byCode.set(rate.code, (byCode.get(rate.code) ?? 0) + line.taxBaseCents)
  }
  const out = [...byCode.entries()].map(([taxRateCode, baseCents]) => ({ taxRateCode, baseCents }))
  if (out.length === 0) {
    abort(
      modelErr(
        "TEMPLATE_INPUT",
        "rectifies.entryId",
        "La factura original no tiene bases imponibles selladas: rectifíquela por diferencias"
      )
    )
  }
  return out
}

/**
 * Emite una factura (o un abono) y la contabiliza: número de la serie, asiento
 * T-01/T-02, y `Transaction` en `POSTED` con su `journalEntryId` (I-E8-4).
 *
 * El PDF **no** se genera aquí: renderizarlo dentro de la transacción la
 * alargaría segundos y serializaría la serie entera. Lo hace la server action
 * con el número ya asignado y lo adjunta como `File` con su `sha256`.
 */
export async function emitInvoice(
  organizationId: string,
  input: EmitInvoiceInput,
  actor: Actor,
  opts: { refDate: LocalDate; idempotencyKey?: string | null }
): Promise<LedgerResult<EmittedInvoice>> {
  return await runLedgerTransaction(organizationId, actor.userId, async (tx) => {
    const ctx = await getLedgerContext(tx, opts.refDate)
    const taxDate = input.accrualDate ?? input.documentDate

    // ── 1. Líneas: bases recalculadas en servidor (G-21) ────────────────────
    let lines: EmitInvoiceLine[] = input.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitPriceCents: l.unitPriceCents,
      taxRateCode: l.taxRateCode,
      revenueAccountCode: l.revenueAccountCode,
      projectId: l.projectId,
      costCenterId: l.costCenterId,
    }))

    // ── 2. Rectificativa por sustitución: se contabiliza la DIFERENCIA ──────
    if (input.rectifies?.mode === "SUSTITUCION") {
      const original = await originalBasesByRate(tx, ctx, input.rectifies.entryId)
      const replacement = computeInvoiceTotals(lines, {
        rateBps: (code) => rateBpsAt(ctx, code, taxDate, "SALE"),
        taxRoundingMode: ctx.policy.taxRoundingMode,
      }).taxByRate.map((t) => ({ taxRateCode: t.taxRateCode, baseCents: t.baseCents }))

      let deltas: { taxRateCode: string; baseCents: Cents }[] = []
      try {
        deltas = substitutionDeltaByRate(original, replacement)
      } catch (error) {
        abort(modelErr("TEMPLATE_INPUT", "rectifies", error instanceof Error ? error.message : String(error)))
      }
      lines = deltas.map((d) => ({
        description: `Rectificación por sustitución (${d.taxRateCode})`,
        quantityMilli: 1000,
        unitPriceCents: d.baseCents,
        taxRateCode: d.taxRateCode,
      }))
    }

    // ── 3. Totales del documento, con la aritmética del motor ───────────────
    const withholdingBps = input.withholdingRateCode
      ? rateBpsAt(ctx, input.withholdingRateCode, input.documentDate, "PURCHASE")
      : null
    if (input.withholdingRateCode && withholdingBps === null) {
      abort(
        modelErr(
          "TAX_RATE_NOT_IN_FORCE",
          "withholdingRateCode",
          `No hay ninguna retención ${input.withholdingRateCode} vigente a ${input.documentDate}`
        )
      )
    }

    let totals: InvoiceTotals
    try {
      totals = computeInvoiceTotals(lines, {
        rateBps: (code) => rateBpsAt(ctx, code, taxDate, "SALE"),
        taxRoundingMode: ctx.policy.taxRoundingMode,
        withholdingRateBps: withholdingBps,
      })
    } catch (error) {
      abort(modelErr("TEMPLATE_INPUT", "lines", error instanceof Error ? error.message : String(error)))
    }
    // La retención se comprueba contra la del motor: dos caminos, un resultado.
    if (withholdingBps !== null && totals.withholdingCents !== retencion(totals.baseTotalCents, withholdingBps)) {
      abort(modelErr("TEMPLATE_INPUT", "withholdingRateCode", "El cálculo de la retención no es reproducible"))
    }
    if (totals.totalCents !== totals.baseTotalCents + sumCents(totals.taxByRate.map((t) => t.quotaCents)) - totals.withholdingCents) {
      abort(modelErr("TEMPLATE_INPUT", "lines", "El total del documento no cuadra con sus bases y cuotas"))
    }

    // ── 4. Número de la serie, con FOR UPDATE ───────────────────────────────
    const assigned = await nextInvoiceNumberTx(tx, {
      kind: input.seriesKind,
      seriesCode: input.seriesCode,
      year: Number(input.documentDate.slice(0, 4)),
    })

    // ── 5. Plantilla T-01 / T-02 ────────────────────────────────────────────
    const isRectification = input.seriesKind === "RECTIFICATIVA"
    const templateCode = isRectification ? "ABONO_EMITIDO" : "FACTURA_EMITIDA_SERVICIOS"
    const templateInput = {
      counterpartyId: input.counterpartyId,
      documentNumber: assigned.documentNumber,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate,
      entryDate: input.entryDate,
      dueDate: input.dueDate,
      lines: totals.lines.map((l) => ({
        baseCents: l.baseCents,
        taxRateCode: l.taxRateCode,
        revenueAccountCode: l.revenueAccountCode,
        description: l.description,
        projectId: l.projectId,
        costCenterId: l.costCenterId,
      })),
      withholdingRateCode: input.withholdingRateCode,
      totalCents: totals.totalCents,
      description: input.description ?? `Factura emitida ${assigned.documentNumber}`,
      ...(isRectification && input.rectifies
        ? { rectifiesEntryId: input.rectifies.entryId, reason: input.rectifies.reason }
        : {}),
    }

    const built = buildFromTemplate(templateCode, templateInput, ctx)
    if (!built.ok) abortWith(built.errors)

    // ── 6. Operación + asiento, en esta MISMA transacción ───────────────────
    const transaction = await tx.transaction.create({
      data: {
        organizationId,
        createdById: actor.userId ?? null,
        name: `Factura ${assigned.documentNumber}`,
        merchant: input.customerName ?? null,
        description: input.description ?? null,
        note: input.notes ?? null,
        total: totals.totalCents,
        currencyCode: ctx.baseCurrency,
        type: "income",
        issuedAt: new Date(`${input.documentDate}T00:00:00.000Z`),
        status: "DRAFT",
      },
    })

    const entry = await postEntryTx(tx, { ...built.value, transactionId: transaction.id }, actor, {
      idempotencyKey: opts.idempotencyKey ?? null,
    })

    // I-E8-4: `POSTED ⟺ journalEntryId`. Los dos, en la misma transacción.
    await tx.transaction.update({
      where: { id: transaction.id },
      data: { status: "POSTED", journalEntryId: entry.id },
    })

    return {
      entry,
      transactionId: transaction.id,
      documentNumber: assigned.documentNumber,
      seriesId: assigned.seriesId,
      baseTotalCents: totals.baseTotalCents,
      taxTotalCents: totals.taxTotalCents,
      withholdingCents: totals.withholdingCents,
      totalCents: totals.totalCents,
    }
  })
}
