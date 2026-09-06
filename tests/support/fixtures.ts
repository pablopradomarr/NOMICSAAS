/**
 * E3 · T13 (parte pura) — Cargador de los fixtures inmutables
 * `tests/fixtures/ejercicio-*.json`.
 *
 * Convierte el fichero en lo que el motor consume: un `LedgerContext` con el
 * plan PYMES sembrado y el mapa de defaults, y un `EntryDraft` por asiento con
 * las `AccountKey` ya resueltas a código.
 *
 * **E4 · T9 (invierte D-E3-1):** `projectCode` / `costCenterCode` /
 * `businessLineCode` YA NO se descartan. El cargador construye las tres
 * dimensiones declaradas en el fixture con ids deterministas, las pone en
 * `ctx.dimensions` (`available: true`) y resuelve cada línea a su `projectId` /
 * `costCenterId`, con `businessLineId` denormalizado del proyecto (R-A9).
 *
 * Los fixtures **no se editan**: se regeneran con
 * `docs/design/fixtures/build_ejercicio_completo.py`.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { buildPlan } from "@/lib/accounts/codes"
import { filterByVariant, parseNpgcCsv, seedRowsToPlanAccounts } from "@/lib/accounts/csv"
import { defaultAccountMap } from "@/lib/accounts/map"
import type { AccountKey, AnalyticType, Plan } from "@/lib/accounts/types"
import { resolveEffectiveAnalyticType } from "@/lib/analytics/margins"
import type { BusinessLineRef, CostCenterMarginLevel, CostCenterRef, ProjectRef } from "@/lib/analytics/types"
import { entryHash, HASH_VERSION_CURRENT, HashableLine } from "@/lib/ledger/hash"
import type {
  Cents,
  EntryDraft,
  EntryKind,
  FiscalYearRef,
  LedgerContext,
  LocalDate,
  PostedEntry,
  PostedLine,
  ResolvedLine,
  SourceType,
  TaxRoundingMode,
} from "@/lib/ledger/types"
import { seedTaxRates } from "@/lib/taxes/rates"
import type { TaxRateRow } from "@/lib/taxes/types"
import type { ReportAccount, ReportEntry, ReportLine } from "@/lib/ledger/reports/types"

// ─────────────────────────────────────────────────────────────────────────────
// Esquema real del fixture (schemaVersion 1.0, §8.3 del diseño)
// ─────────────────────────────────────────────────────────────────────────────

export type FixtureLine = {
  accountKey?: string
  accountCode?: string
  debitCents: number
  creditCents: number
  lineNo: number
  taxRateCode?: string
  /** E4: se resuelven a id y se persisten en la línea. */
  projectCode?: string
  costCenterCode?: string
  businessLineCode?: string
  analyticType?: string
}

export type FixtureEntry = {
  ref: string
  entryNumber: number
  date: LocalDate
  kind: EntryKind
  fiscalYearCode: string
  description: string
  sourceType: SourceType
  template: string
  reversesRef?: string
  lines: FixtureLine[]
}

export type FixtureFile = {
  schemaVersion: string
  organization: {
    slug: string
    name: string
    baseCurrency: string
    pgcVariant: "GENERAL" | "PYMES"
    taxRoundingMode: TaxRoundingMode
    prorrataBps: number | null
    redondeoToleranciaCents: number
    analyticsRequired: boolean
    useSubaccounts: boolean
    createSoftwareAccounts: boolean
  }
  fiscalYear: { code: string; startDate: LocalDate; endDate: LocalDate; status: "OPEN" | "CLOSED" }
  fiscalYearsExtra: { code: string; startDate: LocalDate; endDate: LocalDate; status: "OPEN" | "CLOSED" }[]
  accountsExtra: { code: string; name: string; parentCode: string | null }[]
  businessLines: { code: string; name: string; sortOrder: number }[]
  projects: { code: string; name: string; businessLineCode: string; status: string }[]
  costCenters: { code: string; name: string; kind: string; marginLevel: string; allocatable: boolean }[]
  entries: FixtureEntry[]
  expected: Record<string, unknown> & {
    entryCount: number
    totalDebitCents: number
    totalCreditCents: number
    saldo129Cents: number
    balancesBeforeClosingCents: Record<string, number>
  }
}

export type FixtureName = "ejercicio-minimo" | "ejercicio-completo"

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures")

export function readFixture(name: FixtureName): FixtureFile {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")) as FixtureFile
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan, mapa y contexto
// ─────────────────────────────────────────────────────────────────────────────

/** Plan de cuentas del seed oficial, filtrado por variante. */
export function planForVariant(variant: "GENERAL" | "PYMES"): Plan {
  const csv = readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8")
  const parsed = parseNpgcCsv(csv)
  if (!parsed.ok) throw new Error(`El seed no parsea: ${JSON.stringify(parsed.errors.slice(0, 3))}`)
  const filtered = filterByVariant(parsed.value, variant)
  if (!filtered.ok) throw new Error(`No se puede filtrar el seed: ${JSON.stringify(filtered.errors.slice(0, 3))}`)
  return buildPlan(seedRowsToPlanAccounts(filtered.value, "SEED"))
}

/** Ids deterministas: el fixture debe producir el MISMO hash en dos ejecuciones. */
const stableId = (prefix: string, key: string): string => `${prefix}-${key}`

/** Grupos 6 y 7: los únicos con destino analítico (R-A1). */
const isPnl = (code: string): boolean => code.startsWith("6") || code.startsWith("7")

export type LoadedFixture = {
  file: FixtureFile
  plan: Plan
  ctx: LedgerContext
  rates: TaxRateRow[]
  fiscalYears: FiscalYearRef[]
  /** Un borrador por asiento del fixture, en el orden del fichero. */
  drafts: (EntryDraft & { ref: string; entryNumber: number })[]
  /** Los mismos asientos como si estuvieran ya posteados (informes, invariantes). */
  posted: PostedEntry[]
  /** E4 · T9: las tres dimensiones del fixture con ids deterministas. */
  dimensions: {
    businessLines: BusinessLineRef[]
    projects: ProjectRef[]
    costCenters: CostCenterRef[]
    unassignedCostCenterId: string | null
  }
  /** Códigos analíticos RESUELTOS (antes de E4 se descartaban). */
  resolvedDimensions: { projectCodes: number; costCenterCodes: number; businessLineCodes: number }
}

/**
 * Carga un fixture y lo convierte en `drafts` + `posted`.
 *
 * `refDate` por defecto: el día siguiente al último asiento, para que I8 no
 * marque como futuro ningún asiento del fichero. Entra por parámetro, como
 * exige el motor puro.
 */
export function loadFixture(name: FixtureName, opts: { refDate?: LocalDate } = {}): LoadedFixture {
  const file = readFixture(name)
  const plan = planForVariant(file.organization.pgcVariant)

  const { entries: mapEntries } = defaultAccountMap(plan, {
    useSubaccounts: file.organization.useSubaccounts,
    createSoftwareAccounts: file.organization.createSoftwareAccounts,
  })
  const mapByKey = new Map<string, string>(mapEntries.map((e) => [e.key, e.accountCode]))
  const map = (key: AccountKey): string | null => mapByKey.get(key) ?? null

  const organizationId = stableId("org", file.organization.slug)

  const fiscalYears: FiscalYearRef[] = [file.fiscalYear, ...file.fiscalYearsExtra].map((fy) => ({
    id: stableId("fy", fy.code),
    code: fy.code,
    startDate: fy.startDate,
    endDate: fy.endDate,
    status: fy.status,
  }))
  const fyByCode = new Map(fiscalYears.map((fy) => [fy.code, fy]))

  // Catálogo de tipos: los del seed, con vigencia desde el inicio del primer
  // ejercicio, más ids deterministas.
  const firstStart = fiscalYears.reduce((a, fy) => (fy.startDate < a ? fy.startDate : a), fiscalYears[0].startDate)
  const validFrom = new Date(`${firstStart.slice(0, 4)}-01-01T00:00:00.000Z`)
  const rates: TaxRateRow[] = seedTaxRates(map, { ivaValidFrom: validFrom, orgValidFrom: validFrom }).map((seed) => ({
    id: stableId("rate", seed.code),
    code: seed.code,
    name: seed.name,
    kind: seed.kind,
    rateBps: seed.rateBps,
    appliesTo: seed.appliesTo,
    accountCode: seed.accountCode,
    counterAccountCode: seed.counterAccountCode,
    linkedTaxRateId: seed.linkedCode ? stableId("rate", seed.linkedCode) : null,
    validFrom: seed.validFrom,
    validTo: seed.validTo,
    isActive: seed.isActive,
    isSystem: seed.isSystem,
  }))
  const rateByCode = new Map(rates.map((r) => [r.code, r]))

  const refDate = opts.refDate ?? fixtureRefDate(file)

  // ── E4 · T9: las tres dimensiones, con ids deterministas ──────────────────
  const businessLines: BusinessLineRef[] = (file.businessLines ?? []).map((b) => ({
    id: stableId("bl", b.code),
    code: b.code,
    name: b.name,
    sortOrder: b.sortOrder,
    isActive: true,
  }))
  const blIdByCode = new Map(businessLines.map((b) => [b.code, b.id]))
  const projects: ProjectRef[] = (file.projects ?? []).map((p, index) => ({
    id: stableId("proj", p.code),
    code: p.code,
    name: p.name,
    businessLineId: blIdByCode.get(p.businessLineCode) ?? "",
    status: p.status as ProjectRef["status"],
    sortOrder: index + 1,
    isActive: true,
    closedAt: null,
  }))
  const projectIdByCode = new Map(projects.map((p) => [p.code, p.id]))
  const costCenters: CostCenterRef[] = (file.costCenters ?? []).map((c, index) => ({
    id: stableId("cc", c.code),
    code: c.code,
    name: c.name,
    kind: c.kind as CostCenterRef["kind"],
    marginLevel: c.marginLevel as CostCenterMarginLevel,
    allocatable: c.allocatable,
    sortOrder: index + 1,
    isActive: true,
    isSystem: c.kind === "SIN_ASIGNAR",
  }))
  const ccIdByCode = new Map(costCenters.map((c) => [c.code, c.id]))
  const unassignedCostCenterId = costCenters.find((c) => c.kind === "SIN_ASIGNAR")?.id ?? null

  const analyticTypeByAccount = new Map<string, AnalyticType | null>(
    [...plan.byCode.entries()].map(([code, account]) => [code, account.analyticType])
  )

  const ctx: LedgerContext = {
    organizationId,
    refDate,
    plan,
    map,
    rates,
    fiscalYears,
    periodLocks: [],
    policy: {
      taxRoundingMode: file.organization.taxRoundingMode,
      prorrataBps: file.organization.prorrataBps,
      redondeoToleranciaCents: file.organization.redondeoToleranciaCents,
      analyticsRequired: file.organization.analyticsRequired,
    },
    // E4 · T9: las dimensiones YA existen y C-9 muerde sobre ellas.
    dimensions: { available: true, projects, costCenters, businessLines, unassignedCostCenterId },
    baseCurrency: file.organization.baseCurrency,
  }

  const resolved = { projectCodes: 0, costCenterCodes: 0, businessLineCodes: 0 }

  const drafts = file.entries.map((entry) => {
    const fy = fyByCode.get(entry.fiscalYearCode)
    if (!fy) throw new Error(`El asiento ${entry.ref} apunta al ejercicio ${entry.fiscalYearCode}, que no existe`)

    const lines: ResolvedLine[] = entry.lines
      .slice()
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l, index) => {
        if (l.projectCode) resolved.projectCodes++
        if (l.costCenterCode) resolved.costCenterCodes++
        if (l.businessLineCode) resolved.businessLineCodes++

        const accountCode = l.accountKey ? map(l.accountKey as AccountKey) : (l.accountCode ?? null)
        if (!accountCode) {
          throw new Error(`El asiento ${entry.ref}, línea ${l.lineNo}, no resuelve a ninguna cuenta`)
        }
        const rate = l.taxRateCode ? rateByCode.get(l.taxRateCode) : undefined

        // E4: destino resuelto a id; `businessLineId` COPIADO del proyecto
        // (R-A9) y NULL cuando la línea va a un CECO.
        const projectId = l.projectCode ? (projectIdByCode.get(l.projectCode) ?? null) : null
        if (l.projectCode && !projectId) {
          throw new Error(`El asiento ${entry.ref}, línea ${l.lineNo}, apunta al proyecto ${l.projectCode}, que el fixture no declara`)
        }
        const costCenterId = l.costCenterCode ? (ccIdByCode.get(l.costCenterCode) ?? null) : null
        if (l.costCenterCode && !costCenterId) {
          throw new Error(`El asiento ${entry.ref}, línea ${l.lineNo}, apunta al CECO ${l.costCenterCode}, que el fixture no declara`)
        }
        const businessLineId = projectId ? (projects.find((p) => p.id === projectId)?.businessLineId ?? null) : null
        const analyticType = isPnl(accountCode)
          ? resolveEffectiveAnalyticType(
              { accountCode, analyticType: (l.analyticType as AnalyticType | undefined) ?? null, projectId, costCenterId },
              { analyticTypeByAccount }
            )
          : null

        return {
          lineNo: index + 1,
          accountKey: (l.accountKey as AccountKey) ?? null,
          accountCode,
          debitCents: l.debitCents,
          creditCents: l.creditCents,
          description: null,
          taxRateId: rate?.id ?? null,
          taxBaseCents: null,
          counterpartyId: null,
          dueDate: null,
          analyticType,
          projectId,
          costCenterId,
          businessLineId,
        }
      })

    const draft: EntryDraft & { ref: string; entryNumber: number } = {
      ref: entry.ref,
      entryNumber: entry.entryNumber,
      organizationId,
      fiscalYearId: fy.id,
      documentDate: entry.date,
      accrualDate: null,
      entryDate: entry.date,
      description: entry.description,
      kind: entry.kind,
      sourceType: entry.sourceType,
      sourceId: entry.ref,
      transactionId: null,
      fileId: null,
      templateCode: entry.template,
      taxRoundingMode: file.organization.taxRoundingMode,
      reversesEntryId: entry.reversesRef ? stableId("entry", entry.reversesRef) : null,
      lines,
    }
    return draft
  })

  const posted: PostedEntry[] = drafts.map((draft) => {
    const lines: PostedLine[] = draft.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description ?? null,
      taxRateId: l.taxRateId ?? null,
      taxBaseCents: l.taxBaseCents ?? null,
      counterpartyId: null,
      dueDate: null,
      analyticType: l.analyticType ?? null,
      projectId: l.projectId ?? null,
      costCenterId: l.costCenterId ?? null,
      businessLineId: l.businessLineId ?? null,
      entryDate: draft.entryDate,
      fiscalYearId: draft.fiscalYearId,
      entryKind: draft.kind,
    }))
    const hashable: HashableLine[] = lines.map((l) => ({
      entryId: stableId("entry", draft.ref),
      entryDate: draft.entryDate,
      entryNumber: draft.entryNumber,
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      entryKind: draft.kind,
      fiscalYearId: draft.fiscalYearId,
      taxRateId: l.taxRateId ?? null,
      taxBaseCents: l.taxBaseCents ?? null,
      counterpartyId: l.counterpartyId ?? null,
      dueDate: l.dueDate ?? null,
      description: l.description ?? null,
      analyticType: l.analyticType ?? null,
      projectId: l.projectId ?? null,
      costCenterId: l.costCenterId ?? null,
      businessLineId: l.businessLineId ?? null,
    }))
    return {
      id: stableId("entry", draft.ref),
      organizationId,
      fiscalYearId: draft.fiscalYearId,
      entryNumber: draft.entryNumber,
      documentDate: draft.documentDate ?? null,
      accrualDate: null,
      entryDate: draft.entryDate,
      description: draft.description,
      kind: draft.kind,
      taxRoundingMode: draft.taxRoundingMode,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId ?? null,
      templateCode: draft.templateCode ?? null,
      reversesEntryId: draft.reversesEntryId ?? null,
      voidedAt: null,
      // E8 · T2b: un asiento que nace HOY nace en v3 y lo DECLARA, igual que
      // hace `postEntryTx`. Sin declararlo, I-E3-7 lo verificaría con v2 y daría
      // un FAIL que no existe. Los ficheros JSON del fixture no cambian ni un
      // byte, y `ledgerHash` tampoco: la forma canónica financiera es la misma.
      entryHash: entryHash(hashable, HASH_VERSION_CURRENT),
      hashVersion: HASH_VERSION_CURRENT,
      lines,
    }
  })

  return {
    file,
    plan,
    ctx,
    rates,
    fiscalYears,
    drafts,
    posted,
    dimensions: { businessLines, projects, costCenters, unassignedCostCenterId },
    resolvedDimensions: resolved,
  }
}

/**
 * `refDate` («hoy») de un fixture, DETERMINISTA (ronda 2, #4).
 *
 * Es la fecha del último asiento del fichero —que en `ejercicio-completo` es la
 * apertura de 2027— y nunca `new Date()`: I8 exige `entryDate ≤ refDate`, así
 * que hacerla depender del reloj convertiría un invariante en un test que
 * cambia de resultado según el día. El cargador, los tests y
 * `scripts/load-fixture.ts` usan ÉSTA.
 */
export function fixtureRefDate(file: FixtureFile): LocalDate {
  const last = file.entries.reduce((a, e) => (e.date > a ? e.date : a), file.entries[0]?.date ?? file.fiscalYear.endDate)
  // El día siguiente al último asiento: así ningún asiento del fichero es
  // «futuro» y la fecha sigue siendo función pura del contenido.
  return nextDay(last)
}

/** Día siguiente sin construir un `Date` con hora (I8, caso 29-feb). */
function nextDay(date: LocalDate): LocalDate {
  const [y, m, d] = date.split("-").map(Number)
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dim = m === 2 ? (leap ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
  if (d < dim) return `${y}-${String(m).padStart(2, "0")}-${String(d + 1).padStart(2, "0")}`
  if (m < 12) return `${y}-${String(m + 1).padStart(2, "0")}-01`
  return `${y + 1}-01-01`
}

// ─────────────────────────────────────────────────────────────────────────────
// Adaptadores a los informes
// ─────────────────────────────────────────────────────────────────────────────

export function toReportLines(posted: readonly PostedEntry[]): ReportLine[] {
  return posted.flatMap((e) =>
    e.lines.map((l) => ({
      entryId: e.id,
      entryNumber: e.entryNumber,
      entryDate: e.entryDate,
      entryKind: e.kind,
      fiscalYearId: e.fiscalYearId,
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description ?? null,
      dueDate: null,
      taxRateId: l.taxRateId ?? null,
    }))
  )
}

export function toReportEntries(posted: readonly PostedEntry[]): ReportEntry[] {
  return posted.map((e) => ({
    id: e.id,
    entryNumber: e.entryNumber,
    entryDate: e.entryDate,
    documentDate: e.documentDate ?? null,
    accrualDate: e.accrualDate ?? null,
    description: e.description,
    kind: e.kind,
    sourceType: e.sourceType,
    sourceId: e.sourceId ?? null,
    templateCode: e.templateCode ?? null,
    taxRoundingMode: e.taxRoundingMode,
    reversesEntryId: e.reversesEntryId ?? null,
    voidedAt: e.voidedAt ?? null,
  }))
}

export function toReportAccounts(plan: Plan): ReportAccount[] {
  return plan.codes.map((code) => {
    const account = plan.byCode.get(code)!
    return { code, name: account.name, level: account.level, isContra: account.isContra }
  })
}

/** Saldos `Σdebe − Σhaber` por cuenta, opcionalmente excluyendo `kind`. */
export function balancesOf(
  posted: readonly PostedEntry[],
  opts: { excludeKinds?: readonly EntryKind[]; upTo?: LocalDate } = {}
): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const e of posted) {
    if (opts.excludeKinds?.includes(e.kind)) continue
    if (opts.upTo && e.entryDate > opts.upTo) continue
    for (const l of e.lines) {
      out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents)
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-consistencia del fixture (auditoría de fiabilidad, ronda 1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los fixtures son INMUTABLES: no se les añaden campos a `expected` para cubrir
 * un hueco de la revisión. Lo que sí se puede —y es más fuerte— es comprobar el
 * fichero **contra sí mismo**: que los saldos declarados en `expected` son
 * exactamente los que salen de sumar sus propias líneas.
 *
 * El auditor echaba en falta los saldos de los grupos 6 y 7 (la PyG). Aquí se
 * derivan de las líneas del JSON y se contrastan con `balancesBeforeClosingCents`
 * y con `resultadoAntesRegularizacionCents` / `saldo129Cents`, de modo que una
 * regeneración del fixture que descuadre la PyG rompe el build aunque las cifras
 * de balance sigan cuadrando.
 */
export type FixtureSelfCheck = {
  /** Discrepancias encontradas. Vacío = el fichero es coherente consigo mismo. */
  mismatches: string[]
  /** Cuentas de grupo 6 y 7 con movimiento (excluidos los asientos de sistema). */
  pnlAccountCount: number
  /** `Σ(haber − debe)` de los grupos 6 y 7 = resultado antes de regularizar (I3). */
  resultadoCents: Cents
  saldo129Cents: Cents
}

export function checkFixtureSelfConsistency(name: FixtureName): FixtureSelfCheck {
  const file = readFixture(name)
  const mismatches: string[] = []

  /** Saldos `Σdebe − Σhaber` por cuenta, calculados sobre el JSON. */
  const balanceOf = (excludeKinds: readonly EntryKind[]): Map<string, Cents> => {
    const out = new Map<string, Cents>()
    for (const entry of file.entries) {
      if (excludeKinds.includes(entry.kind)) continue
      if (entry.fiscalYearCode !== file.fiscalYear.code) continue
      for (const line of entry.lines) {
        const code = line.accountCode ?? accountCodeForKey(file, line.accountKey)
        out.set(code, (out.get(code) ?? 0) + line.debitCents - line.creditCents)
      }
    }
    return out
  }

  // `balancesBeforeClosingCents` es el saldo del ejercicio principal SIN el
  // asiento de cierre: la misma definición que usa `scripts/load-fixture.ts`.
  const beforeClosing = balanceOf(["CLOSING"])
  for (const [code, expected] of Object.entries(file.expected.balancesBeforeClosingCents)) {
    const actual = beforeClosing.get(code) ?? 0
    if (actual !== expected) mismatches.push(`saldo ${code}: el JSON suma ${actual} y declara ${expected}`)
  }
  // Y al revés: ninguna cuenta con saldo puede faltar en `expected`.
  for (const [code, actual] of beforeClosing) {
    if (actual === 0) continue
    if (!(code in file.expected.balancesBeforeClosingCents)) {
      mismatches.push(`la cuenta ${code} suma ${actual} y no aparece en balancesBeforeClosingCents`)
    }
  }

  // PyG: los grupos 6 y 7 ANTES de regularizar (I3 del catálogo de invariantes).
  const operating = balanceOf(["CLOSING", "REGULARIZATION", "OPENING"])
  const pnl = [...operating.entries()].filter(([code]) => code.startsWith("6") || code.startsWith("7"))
  const resultadoCents = pnl.reduce((acc, [, saldo]) => acc - saldo, 0)

  const expectedResultado = (file.expected as { resultadoAntesRegularizacionCents?: number })
    .resultadoAntesRegularizacionCents
  if (expectedResultado !== undefined && resultadoCents !== expectedResultado) {
    mismatches.push(
      `resultado antes de regularizar: los grupos 6/7 del JSON suman ${resultadoCents} y el fichero declara ${expectedResultado}`
    )
  }

  // Tras la regularización, ese resultado tiene que estar en la 129.
  const saldo129Cents = -(beforeClosing.get("129") ?? 0)
  if (saldo129Cents !== file.expected.saldo129Cents) {
    mismatches.push(`saldo de la 129: el JSON suma ${saldo129Cents} y declara ${file.expected.saldo129Cents}`)
  }
  if (expectedResultado !== undefined && saldo129Cents !== expectedResultado) {
    mismatches.push(`la 129 (${saldo129Cents}) no recoge el resultado de los grupos 6/7 (${expectedResultado})`)
  }

  return { mismatches, pnlAccountCount: pnl.filter(([, s]) => s !== 0).length, resultadoCents, saldo129Cents }
}

/**
 * Resuelve una `accountKey` del fixture con el mismo mapa que `loadFixture`.
 * El mapa se memoiza por variante: construirlo parsea las 906 filas del seed y
 * hacerlo por línea convertía la comprobación en un test de dos minutos.
 */
const mapCache = new Map<string, Map<string, string>>()

function accountCodeForKey(file: FixtureFile, key: string | undefined): string {
  if (!key) throw new Error("Línea del fixture sin cuenta ni clave")
  const cacheKey = `${file.organization.pgcVariant}|${file.organization.useSubaccounts}|${file.organization.createSoftwareAccounts}`
  let byKey = mapCache.get(cacheKey)
  if (!byKey) {
    const plan = planForVariant(file.organization.pgcVariant)
    const { entries } = defaultAccountMap(plan, {
      useSubaccounts: file.organization.useSubaccounts,
      createSoftwareAccounts: file.organization.createSoftwareAccounts,
    })
    byKey = new Map(entries.map((e) => [e.key as string, e.accountCode]))
    mapCache.set(cacheKey, byKey)
  }
  const code = byKey.get(key)
  if (!code) throw new Error(`La clave ${key} no resuelve a ninguna cuenta`)
  return code
}
