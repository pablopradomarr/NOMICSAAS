/**
 * E8 · T7/T9 — Puente entre `docs/design/fixtures/extraccion-esperada.json` y
 * los motores puros. **Sólo lo usan los tests**: no entra en ningún camino de
 * producción, y por eso vive junto al motor y no en `tests/support/`, donde
 * habría que importarlo cruzando de módulo (la regla de `reconcile*` de la
 * tarea).
 *
 * El fixture está sellado por T8 y es la ÚNICA fuente de verdad de los quince
 * casos: aquí no se copia ni una cifra, se leen todas de él. Lo que sí se hace
 * es traducir tres cosas que el JSON escribe en lenguaje de dominio y el motor
 * necesita en su forma tipada:
 *
 *  1. `taxRoundingMode: "POR_TIPO"` → `PER_TIPO`, que es como se llama el enum.
 *  2. Los identificadores legibles de proyecto y CECO (`PRJ-ALFA`, `CC-ADM`) →
 *     UUID, porque los schemas zod de E3 los exigen. La traducción es una tabla
 *     fija y biyectiva, de modo que el asiento se compara con los nombres del
 *     fixture.
 *  3. El catálogo de cuentas del fixture (`accountMap` + `analyticTypePorCuenta`)
 *     → un `Plan` sintético. **No se usa el plan PYMES del seed a propósito**:
 *     allí `PROVEEDORES` es la 4000 y el fixture dice 400, y comparar contra el
 *     plan real mediría la siembra del mapa en vez del asiento.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AccountKey, AnalyticType, LedgerContext, LocalDate, PeriodLockRef, Plan, TaxRateRow } from "@/lib/ledger/types"
import type { PlanAccount } from "@/lib/accounts/types"
import type { ExtractionProposal, ProposalLine, ProposalTax } from "@/lib/extraction/types"
import type { CategoryRef, CounterpartyRef, ReconcileContext, TaxRateRef } from "@/lib/extraction/reconcile"

// ─────────────────────────────────────────────────────────────────────────────
// Lectura del JSON sellado
// ─────────────────────────────────────────────────────────────────────────────

export type FixtureJson = {
  schemaVersion: string
  contextoComun: {
    accountMap: Record<string, string>
    taxRates: Record<string, { code: string; kind: string; rateBps: number; appliesTo: string; validFrom: string; validTo: string | null }>
    analyticTypePorCuenta: Record<string, string | null>
    organization: FixtureOrganization
    counterparties: Record<string, FixtureCounterparty>
    exchangeRates: FixtureRate[]
  }
  casos: FixtureCase[]
  casosNegativos: FixtureNegative[]
  identidadesIvaPorPeriodo: Record<string, Record<string, number>>
  identidadesIvaGlobales: Record<string, number>
  observacionesParaT14: { id: string; afecta: string; hallazgo: string; correccion: string; severidad: string }[]
}

export type FixtureOrganization = {
  baseCurrency: string
  taxRoundingMode: string
  redondeoToleranciaCents: number
  prorrataBps: number | null
  roiRegistered: boolean
  ivaRegime: string
  analyticsRequired: boolean
}

export type FixtureCounterparty = {
  id: string | null
  name: string | null
  taxId: string | null
  countryCode: string | null
  vatNumber: string | null
  viesValid: boolean | null
  viesCheckedAt: string | null
  withholdingRegime: string
  withholdingRateCode: string | null
  surchargeRegime: boolean
  isEmployee: boolean
  enMaestro: boolean
}

export type FixtureRate = { id: string; date: string; from: string; to: string; rateMicro: number; source: string }

export type FixtureLine = {
  kind: string
  baseCents: number
  discountCents: number
  taxRateCode: string | null
  description?: string
  accountCode: string | null
  accountCodeOrigin?: string
  projectId: string | null
  costCenterId: string | null
  deductibility: string | null
}

export type FixtureProposal = {
  version: number
  docKind: string
  documentNumber: string | null
  counterparty: { name: string | null; taxId: string | null; id: string | null }
  documentDate: string | null
  accrualDate: string | null
  receptionDate: string | null
  operationDate: string | null
  dueSchedule: { dueDate: string; amountCents: number }[] | null
  currency: string
  lines: FixtureLine[]
  taxes: { taxRateCode: string; baseCents: number; quotaCents: number; operationKey?: string }[]
  withholding: { rateCode: string; quotaCents: number } | null
  readWithholding: { rateBps: number; quotaCents: number } | null
  appliedAdvanceCents: number
  appliedAdvanceTaxCents: number
  advanceEntryId: string | null
  rectifies: { documentNumber: string; entryId?: string; reason: string; mode: string } | null
  paymentKey: string | null
  simplifiedQualified: boolean | null
  totalCents: number
  description: string | null
  pagesAnalyzed: number
  pagesTotal: number
  docKindSugeridoPorElModelo?: string
}

export type FixtureAsientoLine = {
  accountCode: string
  accountKey: string | null
  description: string
  debitCents: number
  creditCents: number
  analyticType: string | null
  projectId: string | null
  costCenterId: string | null
  taxRateCode: string | null
  deductibility: string | null
  nonDeductibleIncludedCents: number
  originalCurrency: string | null
  originalAmountCents: number | null
  exchangeRateId: string | null
}

export type FixtureAsiento = {
  templateCode: string
  templateVersion: number
  sourceType: string
  entryDate: string
  documentDate: string
  receptionDate: string | null
  operationDate: string | null
  ivaPeriod: string
  hashVersion: number
  payableBlocks: { payableKey: string; accountCode: string; baseCents: number; quotaCents: number; retencionCents?: number; amountCents: number }[]
  taxOverrides: { taxRateCode: string; quotaCents: number }[]
  lines: FixtureAsientoLine[]
  totalDebitCents: number
  totalCreditCents: number
  cuadreCents: number
  notas: string[]
}

export type FixtureCase = {
  id: string
  slug: string
  titulo: string
  cubre: string[]
  contexto: {
    organization: FixtureOrganization
    counterparty: FixtureCounterparty | null
    refDate: string
    run: { kind: string; pagesAnalyzed: number; pagesTotal: number; partial: boolean }
    rate: FixtureRate | null
    categoria: { code: string; defaultAccountCode: string | null; defaultDeductibility: string } | null
  }
  propuesta: FixtureProposal
  reconcile: {
    status: string
    checks: { id: string; status: string; blocksBatch: boolean; message: string; evidence: Record<string, unknown>; fields: string[] }[]
    confianzaPorCampo: Record<string, { origin: string; confidence: string; check: string | null }>
    quotaDeviationsCents: Record<string, number>
    elegibleParaLote: boolean
    sellos: string[]
  }
  postError: string | null
  asiento: FixtureAsiento | null
  libroRegistro: {
    tipo: string
    baseCents: number
    cuotaTotalCents: number
    cuotaDeducibleCents: number
    cuotaNoDeducibleAlCosteCents: number
    cuotaRepercutidaCents: number
    cuotaDevengadaIspAibCents: number
  }
  identidadInternaDelDocumento: Record<string, number>
  identidadesIva: Record<string, unknown>
  notas: string[]
}

export type FixtureNegative = {
  id: string
  casoBase: string
  titulo: string
  mutacion: Record<string, unknown>
  esperado: Record<string, unknown>
  fundamento: string
}

const FIXTURE_PATH = resolve(process.cwd(), "docs/design/fixtures/extraccion-esperada.json")

let cached: FixtureJson | null = null

export function loadExtractionFixture(): FixtureJson {
  if (cached === null) cached = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FixtureJson
  return cached
}

export const caseById = (id: string): FixtureCase => {
  const hit = loadExtractionFixture().casos.find((c) => c.id === id)
  if (!hit) throw new Error(`El fixture no tiene el caso ${id}`)
  return hit
}

// ─────────────────────────────────────────────────────────────────────────────
// Traducción de identificadores legibles a UUID (y vuelta)
// ─────────────────────────────────────────────────────────────────────────────

const DIMENSION_UUIDS: Readonly<Record<string, string>> = {
  "PRJ-ALFA": "00000000-0000-4000-8000-000000000a01",
  "PRJ-BETA": "00000000-0000-4000-8000-000000000a02",
  "PRJ-GAMMA": "00000000-0000-4000-8000-000000000a03",
  "CC-ADM": "00000000-0000-4000-8000-000000000c01",
  "CC-OPS": "00000000-0000-4000-8000-000000000c02",
  "CC-NA": "00000000-0000-4000-8000-000000000c99",
}

const DIMENSION_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DIMENSION_UUIDS).map(([name, id]) => [id, name])
)

export const uuidForDimension = (name: string | null): string | null => (name === null ? null : (DIMENSION_UUIDS[name] ?? name))
export const dimensionForUuid = (id: string | null | undefined): string | null =>
  id === null || id === undefined ? null : (DIMENSION_NAMES[id] ?? id)

export const ORG_ID = "00000000-0000-4000-8000-0000000000e8"
export const FY_2026_ID = "00000000-0000-4000-8000-000000002026"
export const FY_2025_ID = "00000000-0000-4000-8000-000000002025"

/**
 * Los identificadores legibles del fixture (`CP-ES-SUBCON`, `ENTRY-C01`) → UUID,
 * por el mismo motivo que las dimensiones: los schemas de E3 los validan. La
 * tabla es fija, de modo que un mismo nombre da siempre el mismo UUID y el
 * asiento sigue siendo reproducible byte a byte.
 */
const ENTITY_UUIDS: Readonly<Record<string, string>> = {
  "CP-CH-BIENES": "00000000-0000-4000-8000-0000000000c1",
  "CP-DE-AIB": "00000000-0000-4000-8000-0000000000c2",
  "CP-ES-ABOGADO": "00000000-0000-4000-8000-0000000000c3",
  "CP-ES-CLIENTE": "00000000-0000-4000-8000-0000000000c4",
  "CP-ES-INFORMATICA": "00000000-0000-4000-8000-0000000000c5",
  "CP-ES-SERVICIOS": "00000000-0000-4000-8000-0000000000c6",
  "CP-ES-SUBCON": "00000000-0000-4000-8000-0000000000c7",
  "CP-US-CONSULT": "00000000-0000-4000-8000-0000000000c8",
  "ENTRY-C01": "00000000-0000-4000-8000-0000000000e1",
  "ENTRY-FV41": "00000000-0000-4000-8000-000000000f41",
}

export const uuidForEntity = (name: string | null | undefined): string | null =>
  name === null || name === undefined ? null : (ENTITY_UUIDS[name] ?? name)

// ─────────────────────────────────────────────────────────────────────────────
// Propuesta tipada
// ─────────────────────────────────────────────────────────────────────────────

const asOrigin = (v: string | undefined): ProposalLine["accountCodeOrigin"] =>
  v === "usuario" || v === "catalogo" || v === "importado" ? v : undefined

export function toProposal(raw: FixtureProposal): ExtractionProposal {
  const lines: ProposalLine[] = raw.lines.map((l) => ({
    kind: l.kind as ProposalLine["kind"],
    baseCents: l.baseCents,
    discountCents: l.discountCents,
    taxRateCode: l.taxRateCode,
    ...(l.description === undefined ? {} : { description: l.description }),
    ...(l.accountCode === null ? {} : { accountCode: l.accountCode }),
    ...(asOrigin(l.accountCodeOrigin) === undefined ? {} : { accountCodeOrigin: asOrigin(l.accountCodeOrigin) }),
    ...(l.projectId === null ? {} : { projectId: uuidForDimension(l.projectId) as string }),
    ...(l.costCenterId === null ? {} : { costCenterId: uuidForDimension(l.costCenterId) as string }),
    ...(l.deductibility === null ? {} : { deductibility: l.deductibility as ProposalLine["deductibility"] }),
  }))
  const taxes: ProposalTax[] = raw.taxes.map((t) => ({
    taxRateCode: t.taxRateCode,
    baseCents: t.baseCents,
    quotaCents: t.quotaCents,
    ...(t.operationKey === undefined ? {} : { operationKey: t.operationKey as ProposalTax["operationKey"] }),
  }))
  return {
    version: 1,
    docKind: raw.docKind as ExtractionProposal["docKind"],
    documentNumber: raw.documentNumber,
    counterparty: { name: raw.counterparty.name, taxId: raw.counterparty.taxId, id: uuidForEntity(raw.counterparty.id) },
    documentDate: raw.documentDate,
    accrualDate: raw.accrualDate,
    receptionDate: raw.receptionDate,
    operationDate: raw.operationDate,
    ...(raw.dueSchedule === null ? {} : { dueSchedule: raw.dueSchedule }),
    currency: raw.currency,
    lines,
    taxes,
    withholding: raw.withholding,
    readWithholding: raw.readWithholding,
    appliedAdvanceCents: raw.appliedAdvanceCents,
    appliedAdvanceTaxCents: raw.appliedAdvanceTaxCents,
    ...(raw.advanceEntryId === null ? {} : { advanceEntryId: uuidForEntity(raw.advanceEntryId) as string }),
    ...(raw.rectifies === null
      ? {}
      : {
          rectifies: {
            documentNumber: raw.rectifies.documentNumber,
            ...(raw.rectifies.entryId === undefined ? {} : { entryId: uuidForEntity(raw.rectifies.entryId) as string }),
            reason: raw.rectifies.reason as NonNullable<ExtractionProposal["rectifies"]>["reason"],
            mode: raw.rectifies.mode as NonNullable<ExtractionProposal["rectifies"]>["mode"],
          },
        }),
    ...(raw.paymentKey === null ? {} : { paymentKey: raw.paymentKey as ExtractionProposal["paymentKey"] }),
    ...(raw.simplifiedQualified === null ? {} : { simplifiedQualified: raw.simplifiedQualified }),
    totalCents: raw.totalCents,
    description: raw.description,
  }
}

/**
 * La propuesta **tal como entra** en `reconcile()`, que no siempre es la que el
 * fixture sella: el JSON guarda la propuesta ya NORMALIZADA, y en el caso del
 * abono con total negativo (C06) la normalización es precisamente lo que RC-13
 * hace. La evidencia de ese check conserva el documento crudo —`totalLeido`,
 * `docKindLeido`—, así que se reconstruye desde ahí y `reconcile()` tiene que
 * devolver la propuesta sellada.
 */
export function inputProposalFor(c: FixtureCase): ExtractionProposal {
  const normalized = toProposal(c.propuesta)
  const rc13 = c.reconcile.checks.find((k) => k.id === "RC-13")
  const evidence = (rc13?.evidence ?? {}) as { totalLeido?: number; docKindLeido?: string }
  if (evidence.totalLeido === undefined || evidence.totalLeido >= 0) return normalized
  return {
    ...normalized,
    docKind: (evidence.docKindLeido ?? normalized.docKind) as ExtractionProposal["docKind"],
    totalCents: evidence.totalLeido,
    lines: normalized.lines.map((l) => ({ ...l, baseCents: -l.baseCents })),
    taxes: normalized.taxes.map((t) => ({ ...t, baseCents: -t.baseCents, quotaCents: -t.quotaCents })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contextos
// ─────────────────────────────────────────────────────────────────────────────

const ROUNDING: Readonly<Record<string, "PER_TIPO" | "PER_LINEA">> = {
  POR_TIPO: "PER_TIPO",
  PER_TIPO: "PER_TIPO",
  POR_LINEA: "PER_LINEA",
  PER_LINEA: "PER_LINEA",
}

export const toTaxRateRefs = (fixture: FixtureJson): TaxRateRef[] =>
  Object.values(fixture.contextoComun.taxRates).map((r) => ({
    id: `rate-${r.code}`,
    code: r.code,
    kind: r.kind,
    rateBps: r.rateBps,
    appliesTo: r.appliesTo as TaxRateRef["appliesTo"],
    validFrom: r.validFrom,
    validTo: r.validTo,
  }))

const toCounterparty = (c: FixtureCounterparty | null): CounterpartyRef | null =>
  c === null
    ? null
    : {
        id: c.id,
        name: c.name,
        taxId: c.taxId,
        countryCode: c.countryCode,
        vatNumber: c.vatNumber,
        viesValid: c.viesValid,
        viesCheckedAt: c.viesCheckedAt,
        withholdingRegime: c.withholdingRegime as CounterpartyRef["withholdingRegime"],
        withholdingRateCode: c.withholdingRateCode,
        surchargeRegime: c.surchargeRegime,
        isEmployee: c.isEmployee,
        enMaestro: c.enMaestro,
      }

/** Cuentas que el fixture menciona, con su tipo analítico y su naturaleza. */
export function fixtureAccounts(fixture: FixtureJson): { code: string; analyticType: AnalyticType | null }[] {
  const codes = new Set<string>([
    ...Object.values(fixture.contextoComun.accountMap),
    ...Object.keys(fixture.contextoComun.analyticTypePorCuenta),
    // T-22 (NRV 22ª): reservas y resultados de ejercicios anteriores. El
    // fixture no las nombra porque ninguno de sus quince casos es de ejercicio
    // cerrado, pero el desvío por fecha sí se prueba.
    "113",
    "121",
    "678",
    "778",
  ])
  for (const c of fixture.casos) {
    for (const l of c.propuesta.lines) if (l.accountCode) codes.add(l.accountCode)
    for (const l of c.asiento?.lines ?? []) codes.add(l.accountCode)
  }
  return [...codes]
    .sort()
    .map((code) => ({ code, analyticType: (fixture.contextoComun.analyticTypePorCuenta[code] ?? null) as AnalyticType | null }))
}

export const FIXTURE_FISCAL_YEARS = [
  { id: FY_2025_ID, code: "2025", startDate: "2025-01-01", endDate: "2025-12-31", status: "CLOSED" as const },
  { id: FY_2026_ID, code: "2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "OPEN" as const },
]

const CURRENCIES = [
  { code: "EUR", exponent: 2 },
  { code: "USD", exponent: 2 },
  { code: "CHF", exponent: 2 },
]

export type FixtureContextOverrides = {
  organization?: Partial<FixtureOrganization>
  counterparty?: Partial<FixtureCounterparty> | null
  rate?: FixtureRate | null
  run?: Partial<FixtureCase["contexto"]["run"]>
  duplicate?: { bySha256: boolean; byDocumentNumber: boolean }
  legalMentionArt61m?: string | null
  advanceCollected?: boolean
  periodLocks?: readonly PeriodLockRef[]
}

/**
 * Contexto de `reconcile()` para un caso del fixture. Los datos que el JSON no
 * lleva porque no son del documento —la mención legal del art. 6.1.m, el cobro
 * del anticipo, el duplicado— se derivan de lo que el caso declara esperar, que
 * es exactamente lo que en producción aporta quien lee la base.
 */
export function reconcileContextFor(c: FixtureCase, overrides: FixtureContextOverrides = {}): ReconcileContext {
  const fixture = loadExtractionFixture()
  const org = { ...c.contexto.organization, ...(overrides.organization ?? {}) }
  const cpRaw = overrides.counterparty === null ? null : { ...(c.contexto.counterparty as FixtureCounterparty), ...(overrides.counterparty ?? {}) }
  const run = { ...c.contexto.run, ...(overrides.run ?? {}) }
  const rate = overrides.rate === undefined ? c.contexto.rate : overrides.rate
  const category = c.contexto.categoria

  // El texto de la mención legal es lo único de RC-22 que se lee del PDF. El
  // fixture lo guarda en la evidencia del propio check, que es donde el experto
  // lo selló.
  const rc22 = c.reconcile.checks.find((k) => k.id === "RC-22")
  const evidence = (rc22?.evidence ?? {}) as { textoLeido?: string }
  const legalMention =
    overrides.legalMentionArt61m !== undefined ? overrides.legalMentionArt61m : (evidence.textoLeido ?? null)

  const sha = `${"0".repeat(63)}${c.id === "C13" ? "d" : "a"}`

  return {
    baseCurrency: org.baseCurrency,
    taxRates: toTaxRateRefs(fixture),
    accounts: fixtureAccounts(fixture).map((a) => ({ code: a.code, isPostable: true, isActive: true })),
    accountMap: fixture.contextoComun.accountMap,
    projects: Object.values(DIMENSION_UUIDS)
      .filter((id) => (DIMENSION_NAMES[id] ?? "").startsWith("PRJ-"))
      .map((id) => ({ id, isActive: true, status: "OPEN" as const })),
    costCenters: Object.values(DIMENSION_UUIDS)
      .filter((id) => (DIMENSION_NAMES[id] ?? "").startsWith("CC-"))
      .map((id) => ({ id, isActive: true })),
    currencies: CURRENCIES,
    fiscalYears: FIXTURE_FISCAL_YEARS,
    periodLocks: overrides.periodLocks ?? [],
    counterparty: toCounterparty(cpRaw),
    organization: {
      roiRegistered: org.roiRegistered,
      ivaRegime: org.ivaRegime as ReconcileContext["organization"]["ivaRegime"],
      prorrataBps: org.prorrataBps,
      taxRoundingMode: ROUNDING[org.taxRoundingMode] ?? "PER_TIPO",
      redondeoToleranciaCents: org.redondeoToleranciaCents,
      analyticsRequired: org.analyticsRequired,
    },
    ...(category === null
      ? {}
      : {
          category: {
            code: category.code,
            defaultAccountCode: category.defaultAccountCode,
            defaultDeductibility: category.defaultDeductibility as CategoryRef["defaultDeductibility"],
          },
        }),
    ...(c.id === "C07"
      ? {
          rectifiedEntry: RECTIFIED_ENTRY_C07,
        }
      : {}),
    advanceCollected: overrides.advanceCollected ?? false,
    rate:
      rate === null
        ? null
        : { id: rate.id, rateMicro: BigInt(rate.rateMicro), rateDate: rate.date, source: rate.source },
    legalMentionArt61m: legalMention,
    ...(c.propuesta.docKindSugeridoPorElModelo
      ? { suggestedDocKind: c.propuesta.docKindSugeridoPorElModelo as ExtractionProposal["docKind"] }
      : {}),
    ...(overrides.duplicate ? { duplicate: overrides.duplicate } : {}),
    file: { sha256: sha, runSha256: sha },
    partial: run.partial,
    runKind: run.kind as ReconcileContext["runKind"],
    pagesAnalyzed: run.pagesAnalyzed,
    pagesTotal: run.pagesTotal,
    refDate: c.contexto.refDate,
  }
}

/**
 * `C07` rectifica por SUSTITUCIÓN una factura de 100 000 + 21 000 que el
 * fixture describe en la evidencia de RC-21. Se declara aquí, junto a la
 * traducción, y no dentro del motor: es un dato de la BD.
 */
export const RECTIFIED_ENTRY_C07 = {
  id: "00000000-0000-4000-8000-000000000f41",
  baseByRate: { IVA_21: 100000 },
  quotaByRate: { IVA_21: 21000 },
}

// ─────────────────────────────────────────────────────────────────────────────
// LedgerContext sintético construido desde el propio fixture
// ─────────────────────────────────────────────────────────────────────────────

const NATURE_OF = (code: string): PlanAccount["nature"] =>
  code.startsWith("4") || code.startsWith("5") ? "DEUDORA" : code.startsWith("7") ? "ACREEDORA" : "DEUDORA"

export function fixturePlan(fixture: FixtureJson): Plan {
  const byCode = new Map<string, PlanAccount>()
  for (const { code, analyticType } of fixtureAccounts(fixture)) {
    byCode.set(code, {
      code,
      name: `Cuenta ${code}`,
      level: code.length,
      parentCode: code.length > 1 ? code.slice(0, code.length - 1) : null,
      nature: NATURE_OF(code),
      statement: null,
      epigraph: null,
      epigraphPymes: null,
      bidirectional: false,
      isContra: false,
      analyticType,
      cashflowBucket: null,
      isPostable: true,
      isActive: true,
      isSystem: false,
      origin: "SEED",
    })
  }
  return { byCode, codes: [...byCode.keys()].sort() }
}

export function fixtureRates(fixture: FixtureJson): TaxRateRow[] {
  return Object.values(fixture.contextoComun.taxRates).map((r) => ({
    id: `rate-${r.code}`,
    code: r.code,
    name: r.code,
    kind: r.kind as TaxRateRow["kind"],
    rateBps: r.rateBps,
    appliesTo: r.appliesTo as TaxRateRow["appliesTo"],
    accountCode: r.kind === "IRPF" ? fixture.contextoComun.accountMap.IRPF_PROFESIONALES_A_PAGAR : fixture.contextoComun.accountMap.IVA_REPERCUTIDO,
    counterAccountCode: r.kind === "IRPF" ? null : fixture.contextoComun.accountMap.IVA_SOPORTADO,
    linkedTaxRateId: null,
    validFrom: new Date(`${r.validFrom}T00:00:00.000Z`),
    validTo: r.validTo === null ? null : new Date(`${r.validTo}T00:00:00.000Z`),
    isActive: true,
    isSystem: true,
  }))
}

export function fixtureLedgerContext(c: FixtureCase, overrides: FixtureContextOverrides = {}): LedgerContext {
  const fixture = loadExtractionFixture()
  const org = { ...c.contexto.organization, ...(overrides.organization ?? {}) }
  const map = fixture.contextoComun.accountMap
  return {
    organizationId: ORG_ID,
    refDate: c.contexto.refDate as LocalDate,
    plan: fixturePlan(fixture),
    map: (key: AccountKey) => map[key] ?? null,
    rates: fixtureRates(fixture),
    fiscalYears: FIXTURE_FISCAL_YEARS,
    periodLocks: overrides.periodLocks ?? [],
    policy: {
      taxRoundingMode: ROUNDING[org.taxRoundingMode] ?? "PER_TIPO",
      prorrataBps: org.prorrataBps,
      redondeoToleranciaCents: org.redondeoToleranciaCents,
      analyticsRequired: org.analyticsRequired,
    },
    dimensions: {
      available: true,
      projects: Object.entries(DIMENSION_UUIDS)
        .filter(([name]) => name.startsWith("PRJ-"))
        .map(([name, id]) => ({
          id,
          code: name,
          name,
          businessLineId: "00000000-0000-4000-8000-0000000000b1",
          status: "ACTIVE" as const,
          sortOrder: 0,
          isActive: true,
        })),
      costCenters: Object.entries(DIMENSION_UUIDS)
        .filter(([name]) => name.startsWith("CC-"))
        .map(([name, id]) => ({
          id,
          code: name,
          name,
          kind: "G_A" as const,
          marginLevel: "MC3" as const,
          allocatable: true,
          sortOrder: 0,
          isActive: true,
        })),
      businessLines: [],
      unassignedCostCenterId: DIMENSION_UUIDS["CC-NA"],
    },
    baseCurrency: org.baseCurrency,
  }
}
