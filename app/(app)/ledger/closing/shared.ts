import "server-only"

/**
 * E9 · T16 — Lecturas y mapeo a vista del asistente de cierre (§7).
 *
 * Todo lo que la pantalla enseña sale de aquí, **en serie** dentro de la única
 * transacción que abre `tenantPage` (§9 y `lib/page-tenant.ts`): nada de
 * `Promise.all`, nada de una consulta por paso. El catálogo de los 43 pasos y el
 * orden de los doce asientos son los del motor puro (`lib/closing/checklist.ts`)
 * —no se reescriben aquí— y el veredicto de cada paso es el que el `ClosingRun`
 * selló: la pantalla **no reevalúa nada**.
 */

import {
  CLOSING_BLOCK_TEXT,
  CLOSING_ENTRY_ORDER,
  CLOSING_STEPS,
  sealReasonText,
  type ClosingBlock,
} from "@/lib/closing/checklist"
import { fromUtcDate } from "@/lib/ledger/dates"
import { centsFromDbNullable } from "@/lib/money"
import type { TenantClient } from "@/lib/db"
import type {
  ClosingBlockView,
  ClosingEntryView,
  ClosingPageView,
  ClosingRunView,
  ClosingStepStatus,
  ClosingStepView,
  DistributionRowView,
  EntryRefView,
  FiscalYearView,
} from "@/components/closing/types"

type AnyDb = Pick<TenantClient, "fiscalYear" | "closingRun" | "journalEntry" | "profitDistribution">

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)

const STATUSES: readonly ClosingStepStatus[] = ["PASS", "FAIL", "WARN", "INFO", "NA", "PENDIENTE_RECOMPUTO"]
const asStatus = (value: unknown): ClosingStepStatus =>
  STATUSES.includes(value as ClosingStepStatus) ? (value as ClosingStepStatus) : "INFO"

export function toFiscalYearView(row: {
  id: string
  code: string
  startDate: Date
  endDate: Date
  status: string
  accountsApprovalStatus: string
  taxFilingStatus: string
  closedAt: Date | null
}): FiscalYearView {
  return {
    id: row.id,
    code: row.code,
    startDate: fromUtcDate(row.startDate),
    endDate: fromUtcDate(row.endDate),
    status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
    accountsApprovalStatus: row.accountsApprovalStatus as FiscalYearView["accountsApprovalStatus"],
    taxFilingStatus: row.taxFilingStatus as FiscalYearView["taxFilingStatus"],
    closedAt: iso(row.closedAt),
  }
}

/** Los pasos del run, cruzados con el catálogo. Un paso sin sellar sale `INFO`. */
type StepRecord = { step?: unknown; status?: unknown; evidencia?: unknown; query?: unknown; entryId?: unknown; answer?: unknown }

function toStepViews(steps: readonly StepRecord[], entries: Map<string, EntryRefView>): ClosingStepView[] {
  const byCode = new Map<string, StepRecord>()
  for (const record of steps) if (typeof record?.step === "string") byCode.set(record.step, record)

  return CLOSING_STEPS.map((def) => {
    const record = byCode.get(def.step)
    const orden = CLOSING_ENTRY_ORDER.find((o) => POSTABLE_STEPS[def.step] === o.orden) ?? null
    const entryId = typeof record?.entryId === "string" ? record.entryId : null
    const answer = record?.answer as { status?: unknown; note?: unknown } | undefined
    return {
      step: def.step,
      block: def.block,
      titulo: def.titulo,
      norma: def.norma ?? null,
      nature: def.nature,
      blocking: def.blocking,
      status: record ? asStatus(record.status) : "INFO",
      evidencia:
        typeof record?.evidencia === "string"
          ? record.evidencia
          : "Sin evaluar: ejecute el checklist para que el motor mire este paso",
      query: typeof record?.query === "string" ? record.query : null,
      entry: entryId ? (entries.get(entryId) ?? { id: entryId, entryNumber: null, entryDate: null, description: null }) : null,
      answer:
        answer && typeof answer.status === "string"
          ? { status: answer.status, note: typeof answer.note === "string" ? answer.note : null }
          : null,
      templateCode: orden?.templateCode ?? null,
      orden: orden?.orden ?? null,
    }
  })
}

/** Los cuatro pasos que el asistente postea uno a uno (órdenes 5-8 de O-17). */
const POSTABLE_STEPS: Readonly<Record<string, number>> = {
  VALOR_ACTUAL_APLAZAMIENTO: 5,
  DIFERENCIAS_DE_CAMBIO: 6,
  RECLASIFICACION_VENCIMIENTOS: 7,
  IMPUESTO_BENEFICIOS: 8,
}

function toBlocks(steps: readonly ClosingStepView[]): ClosingBlockView[] {
  const blocks = [...new Set(CLOSING_STEPS.map((s) => s.block))] as ClosingBlock[]
  return blocks.map((block) => {
    const own = steps.filter((s) => s.block === block)
    const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0, NA: 0, PENDIENTE_RECOMPUTO: 0 }
    for (const step of own) counts[step.status] += 1
    return { block, label: CLOSING_BLOCK_TEXT[block], steps: own, counts }
  })
}

/**
 * Los **doce** asientos de O-17 con su hueco o con su asiento. La columna de
 * cada uno la dice el propio `CLOSING_ENTRY_ORDER`, así que un asiento nuevo en
 * el orden no obliga a tocar esta pantalla.
 */
function toEntryViews(run: Record<string, unknown> | null, entries: Map<string, EntryRefView>): ClosingEntryView[] {
  const ref = (id: unknown): EntryRefView[] => {
    if (typeof id !== "string" || id.length === 0) return []
    return [entries.get(id) ?? { id, entryNumber: null, entryDate: null, description: null }]
  }
  return CLOSING_ENTRY_ORDER.map((orden) => {
    const raw = run?.[orden.runColumn]
    const list = Array.isArray(raw) ? raw.flatMap((id) => ref(id)) : ref(raw)
    return { orden: orden.orden, paso: orden.paso, templateCode: orden.templateCode, porQue: orden.porQue, entries: list }
  })
}

export async function readClosingPage(
  db: AnyDb,
  opts: { fiscalYearId?: string | null }
): Promise<ClosingPageView | null> {
  const years = await db.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
  if (years.length === 0) return null
  const selected =
    (opts.fiscalYearId ? years.find((y) => y.id === opts.fiscalYearId) : undefined) ??
    years.find((y) => y.status === "OPEN") ??
    years[years.length - 1]

  const runRow = await db.closingRun.findFirst({
    where: { fiscalYearId: selected.id },
    orderBy: { createdAt: "desc" },
  })

  const distributionRow = await db.profitDistribution.findFirst({
    where: { fiscalYearId: selected.id },
    orderBy: { meetingDate: "desc" },
  })

  // Un único `findMany` para TODOS los asientos que la pantalla nombra: los de
  // los pasos, los doce del cierre, los de la reapertura y el de la
  // distribución. Nada de una consulta por asiento (§9).
  const stepRecords = (Array.isArray(runRow?.steps) ? runRow.steps : []) as StepRecord[]
  const ids = new Set<string>()
  for (const record of stepRecords) if (typeof record?.entryId === "string") ids.add(record.entryId)
  if (runRow) {
    for (const orden of CLOSING_ENTRY_ORDER) {
      const raw = (runRow as Record<string, unknown>)[orden.runColumn]
      if (typeof raw === "string") ids.add(raw)
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") ids.add(id)
    }
    const reopen = runRow.reopenEntryIds
    if (Array.isArray(reopen)) for (const id of reopen) if (typeof id === "string") ids.add(id)
  }
  if (distributionRow?.entryId) ids.add(distributionRow.entryId)

  const entryRows =
    ids.size > 0
      ? await db.journalEntry.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, entryNumber: true, entryDate: true, description: true },
        })
      : []
  const entries = new Map<string, EntryRefView>(
    entryRows.map((e) => [
      e.id,
      { id: e.id, entryNumber: e.entryNumber, entryDate: fromUtcDate(e.entryDate), description: e.description },
    ])
  )

  const steps = toStepViews(stepRecords, entries)
  const run: ClosingRunView | null = runRow
    ? {
        id: runRow.id,
        status: runRow.status as ClosingRunView["status"],
        refDate: fromUtcDate(runRow.refDate),
        seal: {
          sello: runRow.seal === "VALIDADO_AUTOMATICAMENTE" ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
          motivos: (Array.isArray(runRow.sealReasons) ? runRow.sealReasons : [])
            .filter((r): r is string => typeof r === "string")
            .map(sealReasonText),
        },
        hashes: {
          ledgerHash: runRow.ledgerHash,
          planHash: runRow.planHash,
          accountMapHash: runRow.accountMapHash,
          configHash: runRow.configHash,
          gitSha: runRow.gitSha,
        },
        durationMs: runRow.durationMs,
        createdAt: runRow.createdAt.toISOString(),
        closedAt: iso(runRow.closedAt),
        reopenedAt: iso(runRow.reopenedAt),
        reopenReason: runRow.reopenReason ?? null,
        reopenEntryIds: (Array.isArray(runRow.reopenEntryIds) ? runRow.reopenEntryIds : []).filter(
          (id): id is string => typeof id === "string"
        ),
      }
    : null

  const distribution: DistributionRowView | null = distributionRow
    ? {
        id: distributionRow.id,
        meetingDate: fromUtcDate(distributionRow.meetingDate),
        resultCents: centsFromDbNullable(distributionRow.resultCents, "resultado distribuido") ?? 0,
        legalReserveCents: centsFromDbNullable(distributionRow.legalReserveCents, "reserva legal") ?? 0,
        voluntaryReserveCents: centsFromDbNullable(distributionRow.voluntaryReserveCents, "reservas voluntarias") ?? 0,
        carryForwardCents: centsFromDbNullable(distributionRow.carryForwardCents, "remanente") ?? 0,
        dividendCents: centsFromDbNullable(distributionRow.dividendCents, "dividendo") ?? 0,
        entry: distributionRow.entryId ? (entries.get(distributionRow.entryId) ?? null) : null,
      }
    : null

  return {
    fiscalYears: years.map(toFiscalYearView),
    fiscalYear: toFiscalYearView(selected),
    run,
    blocks: toBlocks(steps),
    blockers: steps.filter((s) => s.blocking && s.status !== "PASS"),
    entries: toEntryViews(runRow as Record<string, unknown> | null, entries),
    distribution,
    totals: {
      steps: steps.length,
      blocking: steps.filter((s) => s.blocking).length,
      pass: steps.filter((s) => s.status === "PASS").length,
    },
  }
}

/** Un `ClosingRun` concreto, para `/ledger/closing/[runId]` (la foto sellada). */
export async function readClosingRunDetail(
  db: AnyDb,
  runId: string
): Promise<{ run: ClosingRunView; fiscalYear: FiscalYearView; blocks: readonly ClosingBlockView[]; entries: readonly ClosingEntryView[] } | null> {
  const runRow = await db.closingRun.findFirst({ where: { id: runId } })
  if (!runRow) return null
  const year = await db.fiscalYear.findFirst({ where: { id: runRow.fiscalYearId } })
  if (!year) return null

  const stepRecords = (Array.isArray(runRow.steps) ? runRow.steps : []) as StepRecord[]
  const ids = new Set<string>()
  for (const record of stepRecords) if (typeof record?.entryId === "string") ids.add(record.entryId)
  for (const orden of CLOSING_ENTRY_ORDER) {
    const raw = (runRow as Record<string, unknown>)[orden.runColumn]
    if (typeof raw === "string") ids.add(raw)
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === "string") ids.add(id)
  }
  const entryRows =
    ids.size > 0
      ? await db.journalEntry.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, entryNumber: true, entryDate: true, description: true },
        })
      : []
  const entries = new Map<string, EntryRefView>(
    entryRows.map((e) => [
      e.id,
      { id: e.id, entryNumber: e.entryNumber, entryDate: fromUtcDate(e.entryDate), description: e.description },
    ])
  )

  return {
    run: {
      id: runRow.id,
      status: runRow.status as ClosingRunView["status"],
      refDate: fromUtcDate(runRow.refDate),
      seal: {
        sello: runRow.seal === "VALIDADO_AUTOMATICAMENTE" ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
        motivos: (Array.isArray(runRow.sealReasons) ? runRow.sealReasons : [])
          .filter((r): r is string => typeof r === "string")
          .map(sealReasonText),
      },
      hashes: {
        ledgerHash: runRow.ledgerHash,
        planHash: runRow.planHash,
        accountMapHash: runRow.accountMapHash,
        configHash: runRow.configHash,
        gitSha: runRow.gitSha,
      },
      durationMs: runRow.durationMs,
      createdAt: runRow.createdAt.toISOString(),
      closedAt: iso(runRow.closedAt),
      reopenedAt: iso(runRow.reopenedAt),
      reopenReason: runRow.reopenReason ?? null,
      reopenEntryIds: (Array.isArray(runRow.reopenEntryIds) ? runRow.reopenEntryIds : []).filter(
        (id): id is string => typeof id === "string"
      ),
    },
    fiscalYear: toFiscalYearView(year),
    blocks: toBlocks(toStepViews(stepRecords, entries)),
    entries: toEntryViews(runRow as Record<string, unknown>, entries),
  }
}
