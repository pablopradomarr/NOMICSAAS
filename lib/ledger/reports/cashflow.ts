/**
 * E6 · T8/T9 — Cashflow: método directo mensual, método indirecto y la vista
 * oficial del EFE (A–E). Reglas R-CF-1…R-CF-8 (ADR-0012 D2).
 *
 * **El cashflow es un informe de GESTIÓN, no una cuenta anual.** El estado de
 * flujos de efectivo no es exigible ni en PYMES ni en el modelo abreviado
 * (art. 257.3 LSC y RD 1515/2007), y así se declara en la cabecera. Eso es lo
 * que libera de la numeración oficial y permite el desglose mensual, que es lo
 * que un gerente entiende y lo que ningún programa de contabilidad le da.
 *
 * Módulo PURO.
 */

import type { CashflowBucket, CashflowCategory } from "@/lib/accounts/types"
import { cashflowCategoryOf } from "@/lib/accounts/types"
import type { Cents, EntryKind } from "@/lib/ledger/types"
import { cellProvenance, type Provenance } from "@/lib/ledger/provenance"
import {
  buildAccountIndex,
  CASH_PREFIX,
  isCashAccount,
  type AccountIndex,
  type ProvenanceContext,
  type ReportLine,
  type ReportPeriod,
  type StatementAccount,
} from "@/lib/ledger/reports/types"

/** Cabecera OBLIGATORIA en las dos vistas (§8.4 de la validación contable). */
export const CASHFLOW_HEADER_NOTE = "Informe de gestión. No forma parte de las cuentas anuales abreviadas."

/**
 * R-CF-2: universo del cashflow. Los tres `kind` se excluyen por motivos
 * distintos —`OPENING` fija el saldo inicial, `CLOSING` lo anula y
 * `REGULARIZATION` sólo reordena 6/7 → 129— y ninguno mueve un euro.
 */
export const CASHFLOW_EXCLUDED_KINDS: readonly EntryKind[] = ["OPENING", "CLOSING", "REGULARIZATION"]

export const CASHFLOW_BUCKET_ORDER: readonly CashflowBucket[] = [
  "COBROS_CLIENTES",
  "PAGOS_PROVEEDORES",
  "PAGOS_PERSONAL",
  "PAGOS_IMPUESTOS",
  "OTROS_EXPLOTACION",
  "INVERSION",
  "FINANCIACION",
]

/** Buckets que R-CF-7 considera «bloque comercial». */
const COMMERCIAL_BUCKETS: readonly CashflowBucket[] = ["COBROS_CLIENTES", "PAGOS_PROVEEDORES"]

/** Cuentas de IVA repercutido y soportado, para R-CF-7. */
const isVatAccount = (code: string): boolean => code.startsWith("472") || code.startsWith("477")

// ─────────────────────────────────────────────────────────────────────────────
// Método indirecto: partición MECÁNICA y EXHAUSTIVA (R-CF-5, O-11)
//
// `indirectBlockOf` es una FUNCIÓN PURA sobre el prefijo, nunca una columna del
// plan. Una columna nullable admite huecos y un hueco rompe I6 **en silencio**;
// con una función y un test de exhaustividad sobre las 906 cuentas del seed no
// puede haberlos. Por álgebra —todo asiento cumple `Σ(debe−haber) = 0`— la suma
// de los bloques ES el Δ57x, con tolerancia 0 y sin partida de cuadre.
// ─────────────────────────────────────────────────────────────────────────────

export type IndirectBlock =
  | "RESULTADO"
  | "AJUSTES_NO_MONETARIOS"
  | "VAR_CIRCULANTE_EXISTENCIAS"
  | "VAR_CIRCULANTE_DEUDORES"
  | "VAR_CIRCULANTE_ACREEDORES"
  | "VAR_CIRCULANTE_ADMIN_PUBLICAS"
  | "VAR_CIRCULANTE_PERIODIFICACIONES"
  | "VAR_CIRCULANTE_OTROS"
  | "INVERSION"
  | "FINANCIACION"

export const INDIRECT_BLOCK_ORDER: readonly IndirectBlock[] = [
  "RESULTADO",
  "AJUSTES_NO_MONETARIOS",
  "VAR_CIRCULANTE_EXISTENCIAS",
  "VAR_CIRCULANTE_DEUDORES",
  "VAR_CIRCULANTE_ACREEDORES",
  "VAR_CIRCULANTE_ADMIN_PUBLICAS",
  "VAR_CIRCULANTE_PERIODIFICACIONES",
  "VAR_CIRCULANTE_OTROS",
  "INVERSION",
  "FINANCIACION",
]

export const INDIRECT_BLOCKS: readonly { prefix: string; block: IndirectBlock }[] = [
  { prefix: "129", block: "RESULTADO" }, // sólo se mueve en REGULARIZATION/CLOSING (excluidos)
  { prefix: "28", block: "AJUSTES_NO_MONETARIOS" }, // amortización acumulada
  { prefix: "29", block: "AJUSTES_NO_MONETARIOS" }, // deterioro de inmovilizado
  { prefix: "39", block: "AJUSTES_NO_MONETARIOS" }, // deterioro de existencias
  { prefix: "49", block: "AJUSTES_NO_MONETARIOS" }, // deterioro de créditos comerciales
  { prefix: "59", block: "AJUSTES_NO_MONETARIOS" }, // deterioro de inversiones financieras
  { prefix: "14", block: "AJUSTES_NO_MONETARIOS" }, // provisiones a largo plazo
  { prefix: "529", block: "AJUSTES_NO_MONETARIOS" }, // provisiones a corto plazo
  { prefix: "30", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "31", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "32", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "33", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "34", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "35", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "36", block: "VAR_CIRCULANTE_EXISTENCIAS" },
  { prefix: "407", block: "VAR_CIRCULANTE_ACREEDORES" },
  { prefix: "40", block: "VAR_CIRCULANTE_ACREEDORES" },
  { prefix: "41", block: "VAR_CIRCULANTE_ACREEDORES" },
  { prefix: "438", block: "VAR_CIRCULANTE_ACREEDORES" },
  { prefix: "43", block: "VAR_CIRCULANTE_DEUDORES" },
  { prefix: "44", block: "VAR_CIRCULANTE_DEUDORES" },
  { prefix: "460", block: "VAR_CIRCULANTE_OTROS" },
  { prefix: "465", block: "VAR_CIRCULANTE_OTROS" },
  { prefix: "466", block: "VAR_CIRCULANTE_OTROS" },
  { prefix: "47", block: "VAR_CIRCULANTE_ADMIN_PUBLICAS" },
  { prefix: "476", block: "VAR_CIRCULANTE_ADMIN_PUBLICAS" },
  { prefix: "48", block: "VAR_CIRCULANTE_PERIODIFICACIONES" },
  { prefix: "55", block: "VAR_CIRCULANTE_OTROS" },
  { prefix: "20", block: "INVERSION" },
  { prefix: "21", block: "INVERSION" },
  { prefix: "22", block: "INVERSION" },
  { prefix: "23", block: "INVERSION" },
  { prefix: "24", block: "INVERSION" },
  { prefix: "25", block: "INVERSION" },
  { prefix: "26", block: "INVERSION" },
  { prefix: "27", block: "INVERSION" },
  { prefix: "53", block: "INVERSION" },
  { prefix: "54", block: "INVERSION" },
  // `58` (activos no corrientes mantenidos para la venta) NO está en la tabla
  // sellada del fixture porque ninguna línea del ejercicio lo toca. Se añade
  // aquí para que la partición sea exhaustiva de verdad: el seed sí le da bucket
  // `INVERSION` (§3.2), y un hueco en la partición rompería I6 en silencio el
  // día que una organización real use el subgrupo. No altera ninguna cifra del
  // fixture, y el test de contraste sobre los 53 prefijos sellados lo comprueba.
  { prefix: "58", block: "INVERSION" },
  { prefix: "10", block: "FINANCIACION" },
  { prefix: "11", block: "FINANCIACION" },
  { prefix: "12", block: "FINANCIACION" },
  { prefix: "13", block: "FINANCIACION" },
  { prefix: "15", block: "FINANCIACION" },
  { prefix: "16", block: "FINANCIACION" },
  { prefix: "17", block: "FINANCIACION" },
  { prefix: "18", block: "FINANCIACION" },
  { prefix: "19", block: "FINANCIACION" },
  { prefix: "50", block: "FINANCIACION" },
  { prefix: "51", block: "FINANCIACION" },
  { prefix: "52", block: "FINANCIACION" },
  { prefix: "56", block: "FINANCIACION" },
  { prefix: "6", block: "RESULTADO" },
  { prefix: "7", block: "RESULTADO" },
]

/** Prefijo más largo que case, resuelto una vez y memoizado por la tabla ordenada. */
const INDIRECT_BY_LENGTH = [...INDIRECT_BLOCKS].sort((a, b) => b.prefix.length - a.prefix.length)

export function indirectBlockOf(accountCode: string): IndirectBlock | null {
  for (const { prefix, block } of INDIRECT_BY_LENGTH) {
    if (accountCode.startsWith(prefix)) return block
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Método directo
// ─────────────────────────────────────────────────────────────────────────────

export type CashflowParams = ReportPeriod & {
  /**
   * Cuentas del impuesto sobre beneficios, resueltas por las claves
   * `HP_ACREEDORA_IS` / `HP_DEUDORA_IS` del `OrganizationAccountMap`. R-CF-8: la
   * línea 8.d del EFE se deriva DENTRO de `PAGOS_IMPUESTOS`, nunca por códigos
   * escritos a mano en el motor.
   */
  incomeTaxAccountCodes?: readonly string[]
}

export type CashflowLineDetail = {
  entryId: string
  month: string
  lineNo: number
  code: string
  bucket: CashflowBucket
  category: CashflowCategory
  cents: Cents
}

export type CashflowDirectReport = {
  header: string
  openingCashCents: Cents
  closingCashCents: Cents
  deltaCashCents: Cents
  buckets: readonly CashflowBucket[]
  bucketCategory: Record<CashflowBucket, CashflowCategory>
  annualCents: Record<CashflowBucket, Cents>
  byCategoryCents: Record<CashflowCategory, Cents>
  /** `YYYY-MM` → bucket → céntimos. Los buckets a cero NO se materializan. */
  monthlyCents: Record<string, Partial<Record<CashflowBucket, Cents>>>
  monthlyTotalCents: Record<string, Cents>
  monthlyRunningCashCents: Record<string, Cents>
  /** R-CF-8: línea 8.d del EFE, derivada dentro de `PAGOS_IMPUESTOS`. */
  efeImpuestoBeneficiosCents: Cents
  efeOtrosImpuestosCents: Cents
  /** R-CF-4: asientos 57x↔57x, excluidos por serlo las DOS cuentas. */
  internalTransfers: string[]
  totalFlowsCents: Cents
  lineDetail: CashflowLineDetail[]
  /** I6 directo: `inicial + Σ bloques = final`. Cero o el sello se cae. */
  checkI6DirectCents: Cents
  /** R-CF-7 ambiguo: IVA con varios bloques comerciales en el mismo asiento. */
  ambiguousVatEntries: string[]
  /** Cuentas sin bucket que aportan flujo: romperían el informe en silencio. */
  unbucketedAccounts: { code: string; cents: Cents }[]
  /** Sólo cuando el llamante aporta contexto de provenance. */
  provenanceByBucket?: Record<CashflowBucket, Provenance>
}

/**
 * Cashflow directo.
 *
 * **R-CF-3 — regla POR LÍNEA, exacta.** En cada asiento con al menos una línea
 * 57x, cada línea **no-57x** aporta `−(debe − haber)` a su bucket. Como el
 * asiento cuadra (I1), la suma de los aportes ES el Δ57x del asiento.
 *
 * El reparto proporcional entre contrapartidas **se descarta**: es innecesario y
 * produce cifras que no corresponden a ningún hecho. En `CO-003` (cobro de
 * 300 000 con 500 de comisión) la regla por línea da +300 000 y −500; el
 * proporcional daría 299 001 y 499, que no se pueden explicar al usuario ni
 * pinchar en el drill-down.
 */
export function buildCashflowDirect(
  lines: readonly ReportLine[],
  accounts: readonly StatementAccount[] | AccountIndex,
  params: CashflowParams,
  ctx?: ProvenanceContext
): CashflowDirectReport {
  const index = "byCode" in accounts ? (accounts as AccountIndex) : buildAccountIndex(accounts as StatementAccount[])
  const inScope = (l: ReportLine): boolean =>
    params.fiscalYearId === undefined || l.fiscalYearId === params.fiscalYearId

  // R-CF-1: el saldo inicial se lee del asiento `OPENING`, NO de un campo de
  // configuración. Un saldo inicial configurable es una cifra que puede diverger
  // del diario, y ADR-0003 lo prohíbe.
  let opening = 0
  for (const l of lines) {
    if (!inScope(l) || l.entryKind !== "OPENING" || !isCashAccount(l.accountCode)) continue
    opening += l.debitCents - l.creditCents
  }

  const flow = lines.filter((l) => inScope(l) && !CASHFLOW_EXCLUDED_KINDS.includes(l.entryKind))
  const deltaCash = flow.reduce((a, l) => (isCashAccount(l.accountCode) ? a + l.debitCents - l.creditCents : a), 0)
  const closing = opening + deltaCash

  const byEntry = new Map<string, ReportLine[]>()
  for (const l of flow) {
    const list = byEntry.get(l.entryId) ?? []
    list.push(l)
    byEntry.set(l.entryId, list)
  }

  const monthly = new Map<string, Map<CashflowBucket, Cents>>()
  const annual = new Map<CashflowBucket, Cents>()
  const lineDetail: CashflowLineDetail[] = []
  const internalTransfers: string[] = []
  const ambiguousVatEntries: string[] = []
  const unbucketed = new Map<string, Cents>()

  for (const [entryId, entryLines] of byEntry) {
    const cash = entryLines.filter((l) => isCashAccount(l.accountCode))
    if (cash.length === 0) continue
    const others = entryLines.filter((l) => !isCashAccount(l.accountCode))
    if (others.length === 0) {
      // R-CF-4: traspaso interno. Se excluye **porque las dos cuentas son 57x**,
      // no porque el neto sea 0: la regla se aplica antes de mirar el importe.
      internalTransfers.push(entryId)
      continue
    }
    const month = entryLines[0].entryDate.slice(0, 7)

    // R-CF-7: si el asiento mezcla tesorería, UN SOLO bloque comercial y el IVA
    // de esa misma operación, el IVA sigue al bloque comercial. El EFE mide
    // flujos BRUTOS: los 42 000 de IVA de un anticipo de cliente de 242 000 son
    // parte del cobro, no un cobro de Hacienda —Hacienda no ha pagado nada—.
    const commercial = new Set<CashflowBucket>()
    for (const l of others) {
      const bucket = index.bucketOf(l.accountCode)
      if (bucket && COMMERCIAL_BUCKETS.includes(bucket)) commercial.add(bucket)
    }
    const vatTarget = commercial.size === 1 ? [...commercial][0] : null
    if (commercial.size > 1 && others.some((l) => isVatAccount(l.accountCode))) {
      ambiguousVatEntries.push(entryId)
    }

    for (const l of others) {
      const seeded = index.bucketOf(l.accountCode)
      if (!seeded) {
        unbucketed.set(l.accountCode, (unbucketed.get(l.accountCode) ?? 0) - (l.debitCents - l.creditCents))
        continue
      }
      const bucket = vatTarget && isVatAccount(l.accountCode) ? vatTarget : seeded
      const contrib = -(l.debitCents - l.creditCents)
      const perMonth = monthly.get(month) ?? new Map<CashflowBucket, Cents>()
      perMonth.set(bucket, (perMonth.get(bucket) ?? 0) + contrib)
      monthly.set(month, perMonth)
      annual.set(bucket, (annual.get(bucket) ?? 0) + contrib)
      lineDetail.push({
        entryId,
        month,
        lineNo: l.lineNo,
        code: l.accountCode,
        bucket,
        category: cashflowCategoryOf(bucket),
        cents: contrib,
      })
    }
  }

  const months = [...monthly.keys()].sort()
  const annualCents = Object.fromEntries(
    CASHFLOW_BUCKET_ORDER.map((b) => [b, annual.get(b) ?? 0])
  ) as Record<CashflowBucket, Cents>

  const monthlyTotalCents: Record<string, Cents> = {}
  const monthlyRunningCashCents: Record<string, Cents> = {}
  const monthlyCents: Record<string, Partial<Record<CashflowBucket, Cents>>> = {}
  let running = opening
  for (const m of months) {
    const row = monthly.get(m)!
    const cells: Partial<Record<CashflowBucket, Cents>> = {}
    for (const b of CASHFLOW_BUCKET_ORDER) {
      const value = row.get(b) ?? 0
      if (value !== 0) cells[b] = value
    }
    monthlyCents[m] = cells
    const total = [...row.values()].reduce((a, v) => a + v, 0)
    monthlyTotalCents[m] = total
    running += total
    monthlyRunningCashCents[m] = running
  }

  const incomeTax = new Set(params.incomeTaxAccountCodes ?? [])
  const totalFlows = Object.values(annualCents).reduce((a, v) => a + v, 0)

  const report: CashflowDirectReport = {
    header: CASHFLOW_HEADER_NOTE,
    openingCashCents: opening,
    closingCashCents: closing,
    deltaCashCents: deltaCash,
    buckets: CASHFLOW_BUCKET_ORDER,
    bucketCategory: Object.fromEntries(
      CASHFLOW_BUCKET_ORDER.map((b) => [b, cashflowCategoryOf(b)])
    ) as Record<CashflowBucket, CashflowCategory>,
    annualCents,
    byCategoryCents: {
      OPERATING: CASHFLOW_BUCKET_ORDER.filter((b) => cashflowCategoryOf(b) === "OPERATING").reduce((a, b) => a + annualCents[b], 0),
      INVESTING: CASHFLOW_BUCKET_ORDER.filter((b) => cashflowCategoryOf(b) === "INVESTING").reduce((a, b) => a + annualCents[b], 0),
      FINANCING: CASHFLOW_BUCKET_ORDER.filter((b) => cashflowCategoryOf(b) === "FINANCING").reduce((a, b) => a + annualCents[b], 0),
    },
    monthlyCents,
    monthlyTotalCents,
    monthlyRunningCashCents,
    efeImpuestoBeneficiosCents: lineDetail.filter((d) => incomeTax.has(d.code)).reduce((a, d) => a + d.cents, 0),
    efeOtrosImpuestosCents: lineDetail
      .filter((d) => d.bucket === "PAGOS_IMPUESTOS" && !incomeTax.has(d.code))
      .reduce((a, d) => a + d.cents, 0),
    internalTransfers: internalTransfers.sort(),
    totalFlowsCents: totalFlows,
    lineDetail: lineDetail.sort(
      (a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0) || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0) || a.lineNo - b.lineNo
    ),
    checkI6DirectCents: opening + totalFlows - closing,
    ambiguousVatEntries: [...new Set(ambiguousVatEntries)].sort(),
    unbucketedAccounts: [...unbucketed.entries()].sort().map(([code, cents]) => ({ code, cents })),
  }

  if (ctx) {
    // Provenance por bucket: la celda de un bucket es la suma de sus líneas, y
    // la consulta las devuelve todas — no una muestra.
    report.provenanceByBucket = Object.fromEntries(
      CASHFLOW_BUCKET_ORDER.map((bucket) => [
        bucket,
        cellProvenance(
          `cashflow.directo.${bucket}`,
          annualCents[bucket],
          {
            organizationId: params.organizationId,
            from: params.from,
            to: params.to,
            query:
              "SELECT l.id FROM journal_lines l WHERE l.organization_id = $1 " +
              "AND l.entry_date BETWEEN $2 AND $3 AND l.account_code = ANY($4::text[]) " +
              "AND NOT (l.entry_kind::text = ANY($5::text[]))",
            extraParams: [
              [...new Set(lineDetail.filter((d) => d.bucket === bucket).map((d) => d.code))].sort(),
              CASHFLOW_EXCLUDED_KINDS as readonly string[],
            ],
          },
          ctx
        ),
      ])
    ) as Record<CashflowBucket, Provenance>
  }

  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// Método indirecto
// ─────────────────────────────────────────────────────────────────────────────

export type CashflowIndirectReport = {
  header: string
  blocks: readonly IndirectBlock[]
  blockCents: Record<IndirectBlock, Cents>
  blockAccountCents: Partial<Record<IndirectBlock, Record<string, Cents>>>
  totalCents: Cents
  openingCashCents: Cents
  closingCashCents: Cents
  deltaCashCents: Cents
  /** R-CF-6: operaciones que no han supuesto flujos de efectivo. */
  nonCashEntries: string[]
  /** I6 indirecto: `Σ bloques − Δ57x`. Cero por álgebra; si no, hay un hueco. */
  checkI6IndirectCents: Cents
  /** Cuentas fuera de la partición: no puede haber ninguna (test de exhaustividad). */
  unpartitionedAccounts: string[]
}

export function buildCashflowIndirect(
  lines: readonly ReportLine[],
  params: CashflowParams
): CashflowIndirectReport {
  const inScope = (l: ReportLine): boolean =>
    params.fiscalYearId === undefined || l.fiscalYearId === params.fiscalYearId

  let opening = 0
  for (const l of lines) {
    if (!inScope(l) || l.entryKind !== "OPENING" || !isCashAccount(l.accountCode)) continue
    opening += l.debitCents - l.creditCents
  }
  const flow = lines.filter((l) => inScope(l) && !CASHFLOW_EXCLUDED_KINDS.includes(l.entryKind))
  const deltaCash = flow.reduce((a, l) => (isCashAccount(l.accountCode) ? a + l.debitCents - l.creditCents : a), 0)

  const blocks = new Map<IndirectBlock, Cents>()
  const blockAccounts = new Map<IndirectBlock, Map<string, Cents>>()
  const unpartitioned = new Set<string>()
  const cashEntries = new Set<string>()
  const investOrFinanceEntries = new Set<string>()

  for (const l of flow) {
    if (isCashAccount(l.accountCode)) {
      cashEntries.add(l.entryId)
      continue
    }
    const block = indirectBlockOf(l.accountCode)
    if (!block) {
      unpartitioned.add(l.accountCode)
      continue
    }
    const contrib = -(l.debitCents - l.creditCents)
    blocks.set(block, (blocks.get(block) ?? 0) + contrib)
    const perAccount = blockAccounts.get(block) ?? new Map<string, Cents>()
    perAccount.set(l.accountCode, (perAccount.get(l.accountCode) ?? 0) + contrib)
    blockAccounts.set(block, perAccount)
    if (block === "INVERSION" || block === "FINANCIACION") investOrFinanceEntries.add(l.entryId)
  }

  const blockCents = Object.fromEntries(
    INDIRECT_BLOCK_ORDER.map((b) => [b, blocks.get(b) ?? 0])
  ) as Record<IndirectBlock, Cents>
  const total = Object.values(blockCents).reduce((a, v) => a + v, 0)

  const blockAccountCents: CashflowIndirectReport["blockAccountCents"] = {}
  for (const b of INDIRECT_BLOCK_ORDER) {
    const perAccount = blockAccounts.get(b)
    if (!perAccount || perAccount.size === 0) continue
    blockAccountCents[b] = Object.fromEntries([...perAccount.entries()].sort())
  }

  return {
    header: CASHFLOW_HEADER_NOTE,
    blocks: INDIRECT_BLOCK_ORDER,
    blockCents,
    blockAccountCents,
    totalCents: total,
    openingCashCents: opening,
    closingCashCents: opening + deltaCash,
    deltaCashCents: deltaCash,
    // R-CF-6: sin esta nota, el lector ve una inversión de 1 500 000 que no
    // cuadra con nada de lo que ha visto en el banco.
    nonCashEntries: [...investOrFinanceEntries].filter((id) => !cashEntries.has(id)).sort(),
    checkI6IndirectCents: total - deltaCash,
    unpartitionedAccounts: [...unpartitioned].sort(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vista oficial del EFE (A–E)
// ─────────────────────────────────────────────────────────────────────────────

export type EfeReport = {
  header: string
  /** A) Flujos de explotación, por los bloques del indirecto. */
  explotacionCents: Cents
  explotacionDetalle: { resultado: Cents; ajustes: Cents; capitalCorriente: Cents; otros: Cents }
  /** B) Flujos de inversión. */
  inversionCents: Cents
  /** C) Flujos de financiación. */
  financiacionCents: Cents
  /**
   * D) Efecto de las variaciones de los tipos de cambio. **0 hoy y documentado**:
   * el ERP trabaja en moneda base y las diferencias de cambio son de transacción
   * (`668`/`768`), que van a explotación. Con `ExchangeRate` y saldos 57x en
   * divisa (v2) dejará de ser 0.
   */
  tipoCambioCents: Cents
  /** E) Aumento/disminución neta del efectivo. Es I6. */
  deltaCashCents: Cents
  openingCashCents: Cents
  closingCashCents: Cents
  checkCents: Cents
}

const CAPITAL_CORRIENTE: readonly IndirectBlock[] = [
  "VAR_CIRCULANTE_EXISTENCIAS",
  "VAR_CIRCULANTE_DEUDORES",
  "VAR_CIRCULANTE_ACREEDORES",
  "VAR_CIRCULANTE_ADMIN_PUBLICAS",
  "VAR_CIRCULANTE_PERIODIFICACIONES",
  "VAR_CIRCULANTE_OTROS",
]

export function buildEfeView(direct: CashflowDirectReport, indirect: CashflowIndirectReport): EfeReport {
  const resultado = indirect.blockCents.RESULTADO
  const ajustes = indirect.blockCents.AJUSTES_NO_MONETARIOS
  const capitalCorriente = CAPITAL_CORRIENTE.reduce((a, b) => a + indirect.blockCents[b], 0)
  const explotacion = resultado + ajustes + capitalCorriente
  return {
    header: CASHFLOW_HEADER_NOTE,
    explotacionCents: explotacion,
    explotacionDetalle: { resultado, ajustes, capitalCorriente, otros: 0 },
    inversionCents: indirect.blockCents.INVERSION,
    financiacionCents: indirect.blockCents.FINANCIACION,
    tipoCambioCents: 0,
    deltaCashCents: direct.deltaCashCents,
    openingCashCents: direct.openingCashCents,
    closingCashCents: direct.closingCashCents,
    checkCents:
      explotacion + indirect.blockCents.INVERSION + indirect.blockCents.FINANCIACION - direct.deltaCashCents,
  }
}

export { CASH_PREFIX }
