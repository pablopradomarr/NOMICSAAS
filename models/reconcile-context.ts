/**
 * E8 · T13 — el contexto de `reconcile()`, leído de la base.
 *
 * `reconcile()` es puro y no consulta nada: **todo** lo que necesita para
 * juzgar un documento —plan, tipos vigentes, dimensiones, calificación fiscal
 * de la contraparte, régimen de la organización, tasa de cambio, duplicados,
 * asiento rectificado y asiento del anticipo— entra por parámetro. Este módulo
 * es quien lo lee, y es la razón de que el motor sea reproducible: dado el
 * mismo contexto, el mismo veredicto, en el mismo orden y byte a byte (I-E8-6).
 *
 * Lo que **no** hace: calcular. Aquí no se deriva ni una base ni una cuota.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import type {
  CounterpartyRef,
  ExtractionKind,
  ReconcileContext,
  TaxRateRef,
} from "@/lib/extraction/reconcile"
import type { ExtractionProposal } from "@/lib/extraction/types"
import { getOrFetchRate, newRateMemo, type RateMemo } from "@/lib/fx/rates"
import { fromUtcDate } from "@/lib/ledger/dates"
// E7 · ADR-0015 D1: el borde `bigint` → `number` del diario.
import { centsFromDb } from "@/lib/money"
import { getAccountMapByKey } from "@/models/account-map"
import { listAccounts } from "@/models/accounts"
import { findFilesBySha256 } from "@/models/files"
import { listFiscalYearRefs, listPeriodLockRefs } from "@/models/ledger"
import { listTaxRates } from "@/models/tax-rates"
import { findDuplicateDocuments } from "@/models/transactions"
import type { ExtractionRun, File, Organization } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/**
 * Monedas cuyo exponente ISO-4217 **no** es 2. RC-04 rechaza el documento en
 * cuanto aparece una: el motor trabaja en céntimos y un yen no tiene céntimos.
 * `currencies` no guarda el exponente, así que la excepción se declara aquí en
 * vez de suponer que todo el mundo tiene dos decimales.
 */
const EXPONENT_BY_CURRENCY: Readonly<Record<string, number>> = {
  JPY: 0, KRW: 0, CLP: 0, ISK: 0, VND: 0, PYG: 0, RWF: 0, UGX: 0, XAF: 0, XOF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export type ReconcileContextOptions = {
  /** Fecha de referencia («hoy»). Nunca `Date.now()` dentro del motor. */
  refDate: string
  /** Categoría del gasto elegida por el usuario (RC-15, O-17). */
  categoryCode?: string | null
  /** Memo de tasas: 50 facturas del mismo día ⇒ una llamada de red (§9). */
  rateMemo?: RateMemo
  /**
   * Las N `Transaction` de un mismo split **no se cuentan entre sí** (RC-12):
   * comparten fichero y número de documento por construcción.
   */
  skipDuplicateCheck?: boolean
  /** Sello de la operación que ya existe, para no auto-detectarse duplicada. */
  excludeTransactionId?: string | null
}

/** Fila de `TaxRate` → referencia pura, con las vigencias en `LocalDate`. */
const toTaxRateRef = (row: {
  id: string
  code: string
  kind: string
  rateBps: number
  appliesTo: string
  validFrom: Date
  validTo: Date | null
}): TaxRateRef => ({
  id: row.id,
  code: row.code,
  kind: row.kind,
  rateBps: row.rateBps,
  appliesTo: row.appliesTo as TaxRateRef["appliesTo"],
  validFrom: fromUtcDate(row.validFrom),
  validTo: row.validTo ? fromUtcDate(row.validTo) : null,
})

export async function buildReconcileContext(
  db: AnyClient,
  organization: Organization,
  input: {
    proposal: ExtractionProposal
    run: Pick<ExtractionRun, "kind" | "partial" | "pagesSent" | "pagesTotal" | "fileSha256" | "rawOutput" | "fieldOrigins">
    file: Pick<File, "id" | "sha256">
  },
  options: ReconcileContextOptions
): Promise<ReconcileContext> {
  const client = db as TenantClient
  const { proposal, run, file } = input

  const [accounts, accountMap, taxRates, fiscalYears, periodLocks, projects, costCenters, currencies] = [
    await listAccounts(client),
    await getAccountMapByKey(client),
    await listTaxRates(client),
    await listFiscalYearRefs(client),
    await listPeriodLockRefs(client),
    await client.project.findMany({ select: { id: true, isActive: true, status: true } }),
    await client.costCenter.findMany({ select: { id: true, isActive: true } }),
    await client.currency.findMany({ select: { code: true } }),
  ]

  const counterparty = await resolveCounterparty(client, proposal)
  const category = options.categoryCode
    ? await client.category.findFirst({
        where: { code: options.categoryCode },
        select: { code: true, defaultAccountCode: true, defaultDeductibility: true },
      })
    : null

  // ── Duplicados (RC-12): los resuelve quien lee la base, no el motor ────────
  let duplicate: { bySha256: boolean; byDocumentNumber: boolean } | undefined
  if (!options.skipDuplicateCheck) {
    const sameBytes = file.sha256 ? await findFilesBySha256(client, file.sha256, file.id) : []
    const year = proposal.documentDate ? Number(proposal.documentDate.slice(0, 4)) : null
    const sameKey = await findDuplicateDocuments(client, {
      taxId: counterparty?.taxId ?? proposal.counterparty.taxId,
      documentNumber: proposal.documentNumber,
      year,
    })
    duplicate = { bySha256: sameBytes.length > 0, byDocumentNumber: sameKey.length > 0 }
  }

  // ── Tasa del `documentDate` (D2). Sin tasa no se inventa nada (RC-14) ──────
  let rate: ReconcileContext["rate"] = null
  if (proposal.currency.toUpperCase() !== organization.baseCurrency.toUpperCase() && proposal.documentDate) {
    const hit = await getOrFetchRate(
      client,
      proposal.documentDate,
      proposal.currency,
      organization.baseCurrency,
      options.rateMemo ?? newRateMemo()
    )
    rate = hit.id === null ? null : { id: hit.id, rateMicro: hit.rateMicro, rateDate: hit.rateDate, source: hit.source }
  }

  const rectifiedEntry = await resolveRectifiedEntry(client, proposal, taxRates)
  const advanceEntry = await resolveAdvanceEntry(client, proposal, accountMap.get("IVA_REPERCUTIDO") ?? "477")

  return {
    baseCurrency: organization.baseCurrency,
    taxRates: taxRates.map(toTaxRateRef),
    accounts: accounts.map((a) => ({
      code: a.code,
      isPostable: a.isPostable,
      isActive: a.isActive,
      group: Number(a.code.slice(0, 1)),
    })),
    accountMap: Object.fromEntries(accountMap),
    projects: projects.map((p) => ({ id: p.id, isActive: p.isActive, status: p.status as "OPEN" | "CLOSED" })),
    costCenters: costCenters.map((c) => ({ id: c.id, isActive: c.isActive })),
    currencies: currencies.map((c) => ({ code: c.code, exponent: EXPONENT_BY_CURRENCY[c.code] ?? 2 })),
    fiscalYears,
    periodLocks,
    counterparty,
    organization: {
      roiRegistered: organization.roiRegistered,
      ivaRegime: organization.ivaRegime as ReconcileContext["organization"]["ivaRegime"],
      prorrataBps: organization.prorrataBps,
      taxRoundingMode: organization.taxRoundingMode,
      redondeoToleranciaCents: organization.redondeoToleranciaCents,
      analyticsRequired: organization.analyticsRequired,
    },
    ...(category
      ? {
          category: {
            code: category.code,
            defaultAccountCode: category.defaultAccountCode,
            defaultDeductibility: category.defaultDeductibility,
          },
        }
      : {}),
    ...(rectifiedEntry ? { rectifiedEntry } : {}),
    ...(advanceEntry ? { advanceEntry, advanceCollected: true } : { advanceCollected: false }),
    rate,
    legalMentionArt61m: legalMentionOf(run.fieldOrigins),
    suggestedDocKind: suggestedDocKindOf(run.rawOutput),
    ...(duplicate ? { duplicate } : {}),
    file: { sha256: file.sha256, runSha256: run.fileSha256 },
    partial: run.partial,
    runKind: run.kind as ExtractionKind,
    pagesAnalyzed: run.pagesSent,
    pagesTotal: run.pagesTotal,
    refDate: options.refDate,
  }
}

/**
 * La ficha de la contraparte, que es **quien decide la calificación fiscal**
 * (O-11, O-4, D11): la retención la fija el régimen del maestro, no el PDF.
 * Un NIF válido sin ficha existe y es legítimo: se devuelve con
 * `enMaestro: false` y RC-11 lo degrada a `interpretacion_ia`.
 */
async function resolveCounterparty(db: TenantClient, proposal: ExtractionProposal): Promise<CounterpartyRef | null> {
  const id = proposal.counterparty.id ?? null
  const taxId = proposal.counterparty.taxId
  const row = id
    ? await db.counterparty.findFirst({ where: { id } })
    : taxId
      ? await db.counterparty.findFirst({ where: { taxId } })
      : null

  if (!row) {
    if (!taxId && !proposal.counterparty.name) return null
    return {
      id: null,
      name: proposal.counterparty.name,
      taxId,
      countryCode: null,
      vatNumber: null,
      viesValid: null,
      viesCheckedAt: null,
      withholdingRegime: "NINGUNO",
      withholdingRateCode: null,
      surchargeRegime: false,
      isEmployee: false,
      enMaestro: false,
    }
  }

  return {
    id: row.id,
    name: row.name,
    taxId: row.taxId,
    countryCode: row.countryCode,
    vatNumber: row.vatNumber,
    viesValid: row.viesValid,
    viesCheckedAt: row.viesCheckedAt ? fromUtcDate(row.viesCheckedAt) : null,
    withholdingRegime: row.withholdingRegime as CounterpartyRef["withholdingRegime"],
    withholdingRateCode: row.withholdingRateCode,
    surchargeRegime: row.surchargeRegime,
    isEmployee: row.isEmployee,
    enMaestro: true,
  }
}

/** Bases y cuotas del documento rectificado, por tipo (RC-21, modo SUSTITUCIÓN). */
async function resolveRectifiedEntry(
  db: TenantClient,
  proposal: ExtractionProposal,
  taxRates: readonly { id: string; code: string }[]
): Promise<ReconcileContext["rectifiedEntry"] | null> {
  const entryId = proposal.rectifies?.entryId
  if (!entryId) return null
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId },
    select: { id: true, lines: { select: { taxRateId: true, taxBaseCents: true, debitCents: true, creditCents: true } } },
  })
  if (!entry) return null

  const codeById = new Map(taxRates.map((r) => [r.id, r.code]))
  const baseByRate: Record<string, number> = {}
  const quotaByRate: Record<string, number> = {}
  for (const line of entry.lines) {
    if (!line.taxRateId) continue
    const code = codeById.get(line.taxRateId)
    if (!code) continue
    // E7 · ADR-0015 D1: borde `bigint` → `Cents`.
    if (line.taxBaseCents !== null) {
      baseByRate[code] = (baseByRate[code] ?? 0) + centsFromDb(line.taxBaseCents, "base imponible")
    }
    quotaByRate[code] =
      (quotaByRate[code] ?? 0) + centsFromDb(line.debitCents, "debe") + centsFromDb(line.creditCents, "haber")
  }
  return { id: entry.id, baseByRate, quotaByRate }
}

/** Asiento del anticipo aplicado y su IVA repercutido (RC-23, RC-25). */
async function resolveAdvanceEntry(
  db: TenantClient,
  proposal: ExtractionProposal,
  outputVatAccount: string
): Promise<{ id: string; taxCents: number } | null> {
  const entryId = proposal.advanceEntryId
  if (!entryId) return null
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId },
    select: { id: true, lines: { select: { accountCode: true, debitCents: true, creditCents: true } } },
  })
  if (!entry) return null
  const taxCents = entry.lines
    .filter((l) => l.accountCode === outputVatAccount)
    .reduce((acc, l) => acc + centsFromDb(l.creditCents, "haber") - centsFromDb(l.debitCents, "debe"), 0)
  return { id: entry.id, taxCents }
}

/**
 * RC-22 precondición 3: la mención del art. 6.1.m **leída del documento**. Es
 * lo único de la inversión del sujeto pasivo que sale del PDF; las otras tres
 * precondiciones son de la ficha y de la organización.
 */
function legalMentionOf(fieldOrigins: unknown): string | null {
  const origins = (fieldOrigins ?? {}) as Record<string, { value?: unknown }>
  const value = origins["legalMentions"]?.value
  const texts = Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : []
  const match = texts.find((t) => /inversi[óo]n del sujeto pasivo|reverse charge|art[íi]culo\s*84/i.test(t))
  return match ?? null
}

/** Lo que el modelo SUGIRIÓ, antes de la calificación firme (C15 / RC-22). */
function suggestedDocKindOf(rawOutput: unknown): ExtractionProposal["docKind"] | null {
  const raw = (rawOutput ?? {}) as { docKind?: unknown }
  return typeof raw.docKind === "string" ? (raw.docKind as ExtractionProposal["docKind"]) : null
}
