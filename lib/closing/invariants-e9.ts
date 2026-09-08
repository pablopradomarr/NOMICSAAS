/**
 * E9 · T11 — Invariantes del cierre y de los recurrentes, **I-E9-1…26**
 * (`docs/design/E9-cierre-recurrentes.md` §6.1; ADR-0016; observaciones O-1…O-30).
 *
 * Mismo contrato que los I-E7-* y los I-E8-*:
 *
 * > **nunca un PASS que no se haya comprobado**; lo no evaluable sale `INFO`
 * > diciendo **qué falta**. **Tolerancia 0** en todo lo que compara importes.
 *
 * Y el experto confirma que la tolerancia 0 es **alcanzable**, porque las tres
 * reglas de reparto de E9 (R-AM-2, R-PE-2, O-15) llevan el residuo a una fila
 * determinada y **no hay reparto por mayor resto en ningún punto**. No se relaja.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO. Todo entra por
 * parámetro, en **tipos planos**; quien lee la base es T12 (agente B3).
 *
 * ## Cuatro cosas que este fichero hace distinto, a propósito
 *
 * 1. **I-E9-5 se evalúa POR ACTIVO** (O-19), vía `journal_lines.fixed_asset_id`.
 *    Sin atribución sale **`INFO` nombrando los activos**, jamás PASS por
 *    agregado: un activo sobreamortizado compensado por otro infraamortizado
 *    pasaba el invariante (riesgo R14).
 * 2. **I-E9-16 no es tautológico** (§6.1): no recomputa la reclasificación y la
 *    compara consigo misma, sino que mira las posiciones **antes y después** del
 *    asiento posteado —la suma por contraparte no cambia, toda posición
 *    reclasificada tiene vencimiento y **ninguna posición con vencimiento dentro
 *    de la frontera queda en la cuenta de largo**—.
 * 3. **I-E9-8a′ e I-E9-26 viven en `lib/closing/vat.ts`** (T8) y se **cablean**
 *    aquí: el invariante se escribe **una vez**, donde está la regla que lo
 *    produce.
 * 4. **Los diez motivos de sello** son un **código cerrado**, no una frase: se
 *    filtran, se cuentan y se comparan entre periodos, igual que los seis de E8.
 */

import {
  checkIE98aPrime,
  checkReccFullyAccrued,
  type ClosingStepResult,
  type ReccPendingRef,
  type VatBalanceRowE9,
  type VatBookRowE9,
} from "@/lib/closing/vat"
import { maturityBoundary, reclassReversalDeviations, type MaturityPosition, type OpeningEntryRef, type ReclassPairRef } from "@/lib/closing/reclass"
import { closingRateFor, type ClosingRate, type FxPosition } from "@/lib/closing/fx"
import { convertWithRateMicro } from "@/lib/money"
import { reversalNetsToZero } from "@/lib/ledger/void"
import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"
import type { Cents, LocalDate, PostedEntry } from "@/lib/ledger/types"
import type { PeriodKey } from "@/lib/recurring/schedule"

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de resultado
// ─────────────────────────────────────────────────────────────────────────────

const result = (id: string, status: CheckStatus, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status, evidencia } : { id, status, evidencia, query }

const pass = (id: string, evidencia: string, query?: string) => result(id, "PASS", evidencia, query)
const failed = (id: string, evidencia: string, query?: string) => result(id, "FAIL", evidencia, query)
const warn = (id: string, evidencia: string, query?: string) => result(id, "WARN", evidencia, query)
const info = (id: string, evidencia: string, query?: string) => result(id, "INFO", evidencia, query)

/** Lo NO evaluable nunca es un PASS: dice qué falta y quién lo aporta. */
const missing = (id: string, quéFalta: string): CheckResult =>
  info(id, `no evaluable: ${quéFalta}`)

const sum = (values: readonly number[]): Cents => values.reduce((a, b) => a + b, 0)

const cut = (items: readonly string[], max = 20): string =>
  items.length <= max ? items.join(" · ") : `${items.slice(0, max).join(" · ")} · (+${items.length - max} más)`

// ─────────────────────────────────────────────────────────────────────────────
// Los diez motivos de sello (§4.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Los diez motivos que el cierre aporta al sello.** Código cerrado, como los
 * seis de E8 (ADR-0014 D7) y los cuatro de E7: un motivo de sello es un dato de
 * auditoría, no una frase.
 */
export const E9_SEAL_REASONS = [
  "IVA_NO_LIQUIDADO",
  "RECURRENTES_PENDIENTES",
  "PERIODIFICACION_SIN_AGOTAR",
  "VENCIMIENTOS_SIN_FECHA",
  "CIERRE_REABIERTO",
  "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
  "IMPUESTO_DIFERIDO_NO_RECONOCIDO",
  "DEUDA_SIN_DESGLOSE",
  "RESULTADO_SIN_DISTRIBUIR",
  "MODELO_200_PRESENTADO",
] as const

export type E9SealReason = (typeof E9_SEAL_REASONS)[number]

/** El texto que la pantalla muestra junto a cada código. */
export const E9_SEAL_REASON_TEXT: Readonly<Record<E9SealReason, string>> = {
  IVA_NO_LIQUIDADO: "hay periodos de IVA del ejercicio sin liquidar: 472 y 477 siguen con saldo",
  RECURRENTES_PENDIENTES: "hay reglas recurrentes con periodos vencidos sin generar",
  PERIODIFICACION_SIN_AGOTAR: "hay periodificaciones cuyo periodo ha terminado y conservan saldo pendiente de imputar",
  VENCIMIENTOS_SIN_FECHA: "hay posiciones vivas sin fecha de vencimiento: no se reclasifican, las decide una persona",
  CIERRE_REABIERTO: "el ejercicio se ha reabierto: el sello exige revisión hasta el cierre nuevo",
  REGULARIZACION_BIENES_INVERSION_PENDIENTE:
    "hay bienes de inversión del art. 108 con desviación de prorrata > 10 puntos: falta la regularización del art. 107",
  IMPUESTO_DIFERIDO_NO_RECONOCIDO:
    "se han declarado diferencias temporarias, bases imponibles negativas o deducciones sin reconocer su efecto",
  DEUDA_SIN_DESGLOSE: "hay deuda viva de 17x/52x sin cuadro de vencimientos: su parte corriente no se puede presentar",
  RESULTADO_SIN_DISTRIBUIR: "el resultado de un ejercicio ya aprobado sigue en 129 sin distribuir",
  MODELO_200_PRESENTADO:
    "el impuesto sobre sociedades ya se ha presentado: reabrir obliga a autoliquidación complementaria o rectificativa (art. 122 LGT)",
}

export const isE9SealReason = (code: string): code is E9SealReason =>
  (E9_SEAL_REASONS as readonly string[]).includes(code)

/**
 * Motivos que aportan los pasos del checklist. **Lección H-4 de E7**: el sello se
 * compone **después** de los motivos, y `seal` y `sealReasons` dicen lo mismo. Un
 * paso en PASS no aporta motivo; uno que no está en PASS aporta el suyo, y los
 * repetidos se colapsan.
 */
export function closingSealReasons(steps: readonly ClosingStepResult[]): E9SealReason[] {
  const codes = new Set<E9SealReason>()
  for (const step of steps) {
    if (step.status === "PASS" || step.status === "NA") continue
    const code = step.sealReason
    if (code && isE9SealReason(code)) codes.add(code)
  }
  return [...codes].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// Entradas: tipos PLANOS, un bloque por familia de invariantes
// ─────────────────────────────────────────────────────────────────────────────

export type RecurringRuleSnapshot = {
  id: string
  code: string
  kind: "AMORTIZACION" | "PERIODIFICACION" | "IMPORTE_FIJO"
  /** Hash de la regla vigente, para I-E9-1b. */
  inputHash?: string | null
}

export type RecurringOccurrenceSnapshot = {
  ruleId: string
  ruleCode: string
  period: PeriodKey
  status: "GENERADA" | "OMITIDA" | "FALLIDA"
  entryId: string | null
  /** `CUOTA_CERO`, `REGLA_PAUSADA`, `SIN_FILA_EN_CUADRO`… */
  reason?: string | null
  /** Hash con el que se generó, y el recomputado sobre la regla vigente (1b). */
  inputHash?: string | null
  recomputedInputHash?: string | null
}

/** I-E9-2: lo posteado por una regla de amortización frente a su cuadro. */
export type RecurringDepreciationTotal = {
  ruleId: string
  ruleCode: string
  periods: readonly PeriodKey[]
  postedCents: Cents
  scheduleCents: Cents
}

export type RecurringBlock = {
  rules: readonly RecurringRuleSnapshot[]
  occurrences: readonly RecurringOccurrenceSnapshot[]
  depreciationTotals?: readonly RecurringDepreciationTotal[]
}

export type AssetSnapshot = {
  id: string
  code: string
  /** `FixedAsset.scheduleHash` persistido y el recomputado con el motor (I-E9-3). */
  scheduleHash?: string | null
  recomputedScheduleHash?: string | null
  /** Σ cuotas del cuadro vigente y la base que debe igualar (I-E9-4). */
  scheduleTotalCents?: Cents | null
  amortizableBaseCents?: Cents | null
  /** ¿Alguna cuota negativa en el cuadro vigente? */
  hasNegativeQuota?: boolean
  /** Σ 68x histórica **atribuida a este activo** y saldo de su 28x (I-E9-5). */
  expensePostedCents?: Cents | null
  accumulatedCents?: Cents | null
  /** `false` cuando hay líneas de 68x/28x del activo **sin** `fixed_asset_id`. */
  fullyAttributed?: boolean
}

export type AccrualSnapshot = {
  id: string
  code: string
  periodEnd: LocalDate
  totalCents: Cents
  accruedCents: Cents
  status: "VIVA" | "AGOTADA" | "CANCELADA"
  /** Saldo pendiente en 480/485/567/568 imputable a esta periodificación. */
  pendingCents: Cents
}

export type AccrualBlock = {
  accruals: readonly AccrualSnapshot[]
  /** Σ saldos de 480/485/567/568 leídos del diario (I-E9-7). */
  accountBalanceCents?: Cents | null
}

export type VatSettlementSnapshot = {
  period: PeriodKey
  resultCents: Cents
  carryForwardCents?: Cents
  prorrataAdjustmentCents?: Cents
  /** Asiento sellado y su recomputo línea a línea (I-E9-9). */
  entryLines?: readonly { accountCode: string; debitCents: Cents; creditCents: Cents }[]
  recomputedLines?: readonly { accountCode: string; debitCents: Cents; creditCents: Cents }[]
}

export type IvaPeriodLineSnapshot = {
  lineId: string
  accountCode: string
  /** El `iva_period` **persistido** y el recomputado por `app.iva_period` (8b). */
  storedPeriod: PeriodKey | null
  recomputedPeriod: PeriodKey | null
  entryNumber: number
}

export type ProrrataSnapshot = {
  year: number
  /** Sellada y recomputada; múltiplo de 100 bps (art. 104.Dos.2ª). */
  definitiveBps: number
  recomputedBps: number
  provisionalBps: number
  /** Provisional del año siguiente: debe ser la definitiva de éste (I-E9-10b). */
  nextYearProvisionalBps?: number | null
  numeratorCents: Cents
  denominatorCents: Cents
  /** Documentos sin clave de operación: con ellos, el resultado es INFO (O-10). */
  unclassifiedDocuments?: readonly string[]
  adjustmentCents: Cents
  prorrateableQuotaCents: Cents
  /** Movimiento neto de 634/639 del asiento de regularización. */
  adjustment634639Cents?: Cents | null
  /** Componente de 472 de ese mismo asiento. */
  adjustment472Cents?: Cents | null
  /** `ivaPeriod` del asiento y último periodo del año (O-11). */
  adjustmentPeriod?: PeriodKey | null
  lastPeriodOfYear?: PeriodKey | null
  /** ¿Se posteó ANTES de la T-23 de ese periodo? */
  postedBeforeSettlement?: boolean | null
}

export type DuaSnapshot = {
  documentNumber: string
  customsValueCents: Cents
  invoiceBaseCents: Cents
  bookedBaseCents: Cents
  vatQuotaCents: Cents
  importDeferral: boolean
  /** Cuota devengada realmente anotada en 477 por el DUA. */
  outputVatCents: Cents
  /** ¿Aparece en la casilla 77? */
  box77Cents?: Cents | null
}

export type VatBlock = {
  book?: readonly VatBookRowE9[]
  balances?: readonly VatBalanceRowE9[]
  settlements?: readonly VatSettlementSnapshot[]
  /** Periodos ya liquidados: ningún asiento nuevo puede caer en ellos (I-E9-11). */
  settledPeriods?: readonly PeriodKey[]
  /** Líneas de 472/477/4728/4778 con su `iva_period` (I-E9-8b y I-E9-11). */
  vatLines?: readonly IvaPeriodLineSnapshot[]
  prorrata?: ProrrataSnapshot | null
  dua?: readonly DuaSnapshot[]
  recc?: readonly ReccPendingRef[]
}

export type ClosingEntriesBlock = {
  /** Asientos del ejercicio que se cierra y del siguiente (T-26…T-28, T-32). */
  entries?: readonly PostedEntry[]
  /** Saldos **tras T-26**, por cuenta. Los grupos 6 y 7 deben quedar a 0. */
  balancesAfterRegularization?: Readonly<Record<string, Cents>> | null
  /** Saldo de `129` tras T-26 y el resultado I3 del ejercicio (I-E9-13). */
  balance129Cents?: Cents | null
  resultI3Cents?: Cents | null
  /** Asientos de N+1 para el orden de la apertura (O-8, I-E9-14). */
  nextYearEntries?: readonly OpeningEntryRef[]
  /** Asientos posteados **después** del `closedAt` de un ejercicio cerrado. */
  postedAfterClose?: readonly {
    entryNumber: number
    fiscalYearCode: string
    postedAt: string
    kind: string
    isReopeningReversal: boolean
  }[]
}

export type ClosingRunSnapshot = {
  id: string
  fiscalYearCode: string
  status: "BORRADOR" | "CERRADO" | "REABIERTO" | "FALLIDO"
  ledgerHash: string
  configHash: string
  /** Veredicto sellado y el recomputado sobre el mismo par de hashes (I-E9-20). */
  stepsHash?: string | null
  recomputedStepsHash?: string | null
}

export type ReopeningSnapshot = {
  fiscalYearCode: string
  /** Plantillas de los contra-asientos encontrados: T-28, T-27, T-26 y **T-25**. */
  reversedTemplates: readonly string[]
  /** Cuentas de los grupos 1 a 7 cuyo saldo NO ha vuelto al previo al cierre. */
  driftedAccounts: readonly { accountCode: string; beforeCents: Cents; afterCents: Cents }[]
  balance129Cents: Cents
  balance6300Cents: Cents
  /** Pasos 5-7, que no se revierten y quedan marcados (O-21). */
  pendingRecompute?: readonly string[]
}

export type ReclassBlock = {
  cutoff: LocalDate
  thresholdMonths?: number
  pairs?: readonly ReclassPairRef[]
  /** Posiciones vivas **antes** y **después** del asiento de reclasificación. */
  positionsBefore: readonly MaturityPosition[]
  positionsAfter: readonly MaturityPosition[]
  /** Deudas de 17x/52x sin desglose, y las declaradas por una persona (I-E9-25). */
  debtsWithoutSchedule?: readonly { reference: string; accountCode: string; openCents: Cents; declaredReason?: string | null }[]
}

export type FxBlock = {
  cutoff: LocalDate
  windowDays?: number
  rates: readonly ClosingRate[]
  /** Posiciones **después** de T-30: la diferencia debe ser 0 (I-E9-17). */
  positionsAfter: readonly FxPosition[]
  /** Tasa sellada en el asiento, por divisa (O-5). */
  sealedRates?: readonly { currency: string; rateMicro: bigint; rateDate: LocalDate }[]
  /** Líneas del asiento T-30, para I-E9-18. */
  adjustmentLines?: readonly { accountCode: string; originalCurrency: string | null; originalAmountCents: Cents | null }[]
  /** Líneas en divisa de cuentas **no monetarias** barridas por error (I-E9-24). */
  nonMonetaryInSweep?: readonly { accountCode: string; currency: string }[]
}

export type PresentValueSnapshot = {
  reference: string
  nominalCents: Cents
  presentValueCents: Cents
  /** Σ intereses implícitos de **toda** la vida del pasivo. */
  scheduledInterestCents: Cents
  /** Valor contable al vencimiento según el cuadro. */
  finalCarryingCents: Cents
}

export type DistributionSnapshot = {
  fiscalYearCode: string
  approvalStatus: "BORRADOR" | "FORMULADAS" | "APROBADAS" | "DEPOSITADAS"
  /** Saldo de `129` del ejercicio anterior que sigue vivo. */
  pending129Cents: Cents
  profitCents: Cents
  destinationsCents: Cents
  legalReserveCents: Cents
  legalReserveRequiredCents: Cents
  capitalSource: "DIARIO" | "DECLARADO"
}

export type ClosingInvariantInput = {
  cutoff: LocalDate
  recurring?: RecurringBlock
  assets?: readonly AssetSnapshot[]
  accruals?: AccrualBlock
  vat?: VatBlock
  closing?: ClosingEntriesBlock
  closingRuns?: readonly ClosingRunSnapshot[]
  reopening?: ReopeningSnapshot | null
  reclass?: ReclassBlock
  fx?: FxBlock
  presentValue?: readonly PresentValueSnapshot[]
  distribution?: readonly DistributionSnapshot[]
}

/** Los veintisiete ids que E9 aporta (I-E9-1a y 1b cuentan por separado, y 10b). */
export const E9_INVARIANT_IDS: readonly string[] = [
  "I-E9-1a",
  "I-E9-1b",
  "I-E9-2",
  "I-E9-3",
  "I-E9-4",
  "I-E9-5",
  "I-E9-6",
  "I-E9-7",
  "I-E9-8a′",
  "I-E9-8b",
  "I-E9-9",
  "I-E9-10",
  "I-E9-10b",
  "I-E9-11",
  "I-E9-12",
  "I-E9-13",
  "I-E9-14",
  "I-E9-15",
  "I-E9-16",
  "I-E9-17",
  "I-E9-18",
  "I-E9-19",
  "I-E9-20",
  "I-E9-21",
  "I-E9-22",
  "I-E9-23",
  "I-E9-24",
  "I-E9-25",
  "I-E9-26",
]

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-1a / 1b — idempotencia y versión de la regla
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-1a** — `(regla, periodo)` único; toda `GENERADA` tiene asiento; ninguna `OMITIDA`/`FALLIDA` sin motivo. */
export function checkIE91a(block: RecurringBlock | undefined): CheckResult {
  if (!block) return missing("I-E9-1a", "faltan las reglas y ocurrencias recurrentes")
  const seen = new Set<string>()
  const problems: string[] = []
  for (const occ of block.occurrences) {
    const key = `${occ.ruleId}:${occ.period}`
    if (seen.has(key)) problems.push(`${occ.ruleCode} ${occ.period}: ocurrencia duplicada`)
    seen.add(key)
    if (occ.status === "GENERADA" && !occ.entryId) {
      problems.push(`${occ.ruleCode} ${occ.period}: GENERADA sin asiento`)
    }
    if (occ.status !== "GENERADA" && !occ.reason) {
      problems.push(`${occ.ruleCode} ${occ.period}: ${occ.status} sin motivo`)
    }
  }
  const query =
    "SELECT rule_id, period, count(*) FROM recurring_occurrences WHERE organization_id = $1 " +
    "GROUP BY 1, 2 HAVING count(*) > 1"
  return problems.length === 0
    ? pass("I-E9-1a", `${block.occurrences.length} ocurrencia(s) de ${block.rules.length} regla(s), sin duplicados ni huérfanas`, query)
    : failed("I-E9-1a", cut(problems), query)
}

/** **I-E9-1b** — el `inputHash` recomputado coincide, o la evidencia dice qué ocurrencia nació con otra versión. */
export function checkIE91b(block: RecurringBlock | undefined): CheckResult {
  if (!block) return missing("I-E9-1b", "faltan las ocurrencias recurrentes")
  const comparables = block.occurrences.filter((o) => o.inputHash && o.recomputedInputHash)
  if (comparables.length === 0) {
    return info("I-E9-1b", "ninguna ocurrencia trae su `inputHash` y el recomputado: no se puede comparar la versión de la regla")
  }
  const drifted = comparables
    .filter((o) => o.inputHash !== o.recomputedInputHash)
    .map((o) => `${o.ruleCode} ${o.period}: se generó con otra versión de la regla`)
  return drifted.length === 0
    ? pass("I-E9-1b", `${comparables.length} ocurrencia(s) con el hash de entrada reproducible sobre la regla vigente`)
    : warn("I-E9-1b", cut(drifted))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-2 — lo posteado por una regla = su cuadro
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE92(block: RecurringBlock | undefined): CheckResult {
  if (!block?.depreciationTotals) {
    return missing("I-E9-2", "faltan los totales por regla de amortización (posteado y cuadro)")
  }
  const broken = block.depreciationTotals
    .filter((t) => t.postedCents !== t.scheduleCents)
    .map((t) => `${t.ruleCode}: posteado ${t.postedCents} ≠ cuadro ${t.scheduleCents} en ${t.periods.length} periodo(s)`)
  return broken.length === 0
    ? pass("I-E9-2", `${block.depreciationTotals.length} regla(s) de amortización cuadran con su cuadro, tolerancia 0`)
    : failed("I-E9-2", cut(broken))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-3 / 4 / 5 — el cuadro, su suma y la atribución POR ACTIVO (O-19, O-28)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE93(assets: readonly AssetSnapshot[] | undefined): CheckResult {
  if (!assets) return missing("I-E9-3", "faltan los activos y sus `scheduleHash`")
  const comparables = assets.filter((a) => a.scheduleHash && a.recomputedScheduleHash)
  if (comparables.length === 0) return info("I-E9-3", "ningún activo trae su `scheduleHash` y el recomputado")
  const broken = comparables
    .filter((a) => a.scheduleHash !== a.recomputedScheduleHash)
    .map((a) => `${a.code}: el cuadro persistido no es el que produce el motor`)
  return broken.length === 0
    ? pass("I-E9-3", `${comparables.length} activo(s) con el sello del cuadro reproducible`)
    : failed("I-E9-3", cut(broken))
}

/** **I-E9-4 (O-28)** — `Σ cuotas = coste + mejoras − residual vigente`; ninguna cuota negativa. */
export function checkIE94(assets: readonly AssetSnapshot[] | undefined): CheckResult {
  if (!assets) return missing("I-E9-4", "faltan los activos y sus cuadros")
  const comparables = assets.filter((a) => a.scheduleTotalCents != null && a.amortizableBaseCents != null)
  if (comparables.length === 0) return info("I-E9-4", "ningún activo trae Σ cuotas y base amortizable")
  const problems: string[] = []
  for (const a of comparables) {
    if (a.scheduleTotalCents !== a.amortizableBaseCents) {
      problems.push(`${a.code}: Σ cuotas ${a.scheduleTotalCents} ≠ base ${a.amortizableBaseCents}`)
    }
    if (a.hasNegativeQuota) problems.push(`${a.code}: el cuadro tiene alguna cuota negativa`)
  }
  return problems.length === 0
    ? pass("I-E9-4", `${comparables.length} cuadro(s) suman su base amortizable, sin cuotas negativas y con el residuo en la última`)
    : failed("I-E9-4", cut(problems))
}

/**
 * **I-E9-5 (O-19).** Amortización acumulada **= Σ 68x histórica, POR ACTIVO**, y
 * `28x` del activo ≤ base amortizable. Sin atribución (`fixed_asset_id`), **INFO
 * nombrando los activos**, jamás PASS por agregado: es el riesgo R14.
 */
export function checkIE95(assets: readonly AssetSnapshot[] | undefined): CheckResult {
  if (!assets) return missing("I-E9-5", "faltan los activos y sus importes por activo")
  const query =
    "SELECT l.fixed_asset_id, sum(CASE WHEN l.account_code LIKE '68%' THEN l.debit_cents - l.credit_cents ELSE 0 END) AS dotado, " +
    "sum(CASE WHEN l.account_code LIKE '28%' THEN l.credit_cents - l.debit_cents ELSE 0 END) AS acumulada " +
    "FROM journal_lines l WHERE l.organization_id = $1 GROUP BY 1"
  const unattributed = assets.filter((a) => a.fullyAttributed === false).map((a) => a.code)
  const comparables = assets.filter(
    (a) => a.fullyAttributed !== false && a.expensePostedCents != null && a.accumulatedCents != null
  )
  const problems: string[] = []
  for (const a of comparables) {
    if (a.expensePostedCents !== a.accumulatedCents) {
      problems.push(`${a.code}: Σ 68x ${a.expensePostedCents} ≠ 28x ${a.accumulatedCents}`)
    }
    if (a.amortizableBaseCents != null && (a.accumulatedCents as number) > a.amortizableBaseCents) {
      problems.push(`${a.code}: 28x ${a.accumulatedCents} por encima de la base amortizable ${a.amortizableBaseCents}`)
    }
  }
  if (problems.length > 0) return failed("I-E9-5", cut(problems), query)
  if (unattributed.length > 0) {
    return info(
      "I-E9-5",
      `sin atribución por activo en ${cut(unattributed, 10)}: la comprobación por agregado dejaría pasar un activo ` +
        "sobreamortizado compensado por otro infraamortizado (O-19), así que no se declara PASS",
      query
    )
  }
  if (comparables.length === 0) return info("I-E9-5", "ningún activo trae Σ 68x y saldo de 28x atribuidos", query)
  return pass("I-E9-5", `${comparables.length} activo(s) con la acumulada igual a su dotación histórica, activo a activo`, query)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-6 / 7 — periodificaciones
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE96(block: AccrualBlock | undefined, cutoff: LocalDate): CheckResult {
  if (!block) return missing("I-E9-6", "faltan las periodificaciones")
  const due = block.accruals.filter((a) => a.periodEnd <= cutoff && a.status !== "CANCELADA")
  const problems = due
    .filter((a) => a.accruedCents !== a.totalCents || a.pendingCents !== 0)
    .map((a) => `${a.code}: devengado ${a.accruedCents} de ${a.totalCents}, pendiente ${a.pendingCents}`)
  return problems.length === 0
    ? pass("I-E9-6", `${due.length} periodificación(es) con periodo terminado a ${cutoff}, todas agotadas y con saldo 0`)
    : failed("I-E9-6", cut(problems))
}

export function checkIE97(block: AccrualBlock | undefined): CheckResult {
  if (!block || block.accountBalanceCents == null) {
    return missing("I-E9-7", "falta el saldo de 480/485/567/568 leído del diario")
  }
  const pending = sum(block.accruals.filter((a) => a.status === "VIVA").map((a) => a.pendingCents))
  const query =
    "SELECT sum(l.debit_cents - l.credit_cents) FROM journal_lines l WHERE l.organization_id = $1 " +
    "AND l.account_code IN ('480', '485', '567', '568')"
  return pending === block.accountBalanceCents
    ? pass("I-E9-7", `saldo de 480/485/567/568 ${block.accountBalanceCents} = pendiente de devengo de las periodificaciones vivas`, query)
    : failed(
        "I-E9-7",
        `saldo de 480/485/567/568 ${block.accountBalanceCents} ≠ pendiente de las periodificaciones vivas ${pending} ` +
          `(diferencia ${block.accountBalanceCents - pending})`,
        query
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-8b / 9 / 10 / 10b / 11 / 22 — IVA (8a′ y 26 viven en `vat.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-8b** — el `iva_period` persistido = `app.iva_period(...)` recomputado. */
export function checkIE98b(block: VatBlock | undefined): CheckResult {
  if (!block?.vatLines) return missing("I-E9-8b", "faltan las líneas de 472/477/4728/4778 con su `iva_period`")
  const problems = block.vatLines
    .filter((l) => l.storedPeriod !== l.recomputedPeriod)
    .map((l) => `asiento ${l.entryNumber}, línea ${l.lineId} (${l.accountCode}): ${l.storedPeriod} ≠ ${l.recomputedPeriod}`)
  const query =
    "SELECT l.id, e.iva_period, app.iva_period(e.reception_date, e.document_date, e.entry_date, $2) " +
    "FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id " +
    "WHERE l.organization_id = $1 AND l.account_code IN ('472', '477', '4728', '4778')"
  return problems.length === 0
    ? pass("I-E9-8b", `${block.vatLines.length} línea(s) de IVA con el periodo persistido igual al recomputado`, query)
    : failed("I-E9-8b", cut(problems), query)
}

/** **I-E9-9** — la liquidación es reproducible **línea a línea**. */
export function checkIE99(block: VatBlock | undefined): CheckResult {
  if (!block?.settlements) return missing("I-E9-9", "faltan las liquidaciones selladas")
  const comparables = block.settlements.filter((s) => s.entryLines && s.recomputedLines)
  if (comparables.length === 0) {
    return info("I-E9-9", "ninguna liquidación trae su asiento sellado y el recomputado: no se puede comparar línea a línea")
  }
  const problems: string[] = []
  for (const s of comparables) {
    const sealed = [...(s.entryLines ?? [])].map((l) => `${l.accountCode}:${l.debitCents}:${l.creditCents}`).sort()
    const recomputed = [...(s.recomputedLines ?? [])].map((l) => `${l.accountCode}:${l.debitCents}:${l.creditCents}`).sort()
    if (sealed.join("|") !== recomputed.join("|")) {
      problems.push(`${s.period}: el asiento sellado no coincide línea a línea con el recomputado desde el libro`)
      continue
    }
    const neto = sum((s.entryLines ?? []).map((l) => l.debitCents - l.creditCents))
    if (neto !== 0) problems.push(`${s.period}: el asiento de liquidación no cuadra (${neto})`)
  }
  return problems.length === 0
    ? pass("I-E9-9", `${comparables.length} liquidación(es) reproducible(s) línea a línea, con su resultado y su compensación`)
    : failed("I-E9-9", cut(problems))
}

/** **I-E9-10 (O-9/O-10)** — prorrata definitiva: recomputada, múltiplo de 100 y derivada del libro. */
export function checkIE910(block: VatBlock | undefined): CheckResult {
  const p = block?.prorrata
  if (!p) return missing("I-E9-10", "falta la prorrata definitiva del año")
  if (p.unclassifiedDocuments && p.unclassifiedDocuments.length > 0) {
    return info(
      "I-E9-10",
      `${p.unclassifiedDocuments.length} documento(s) del año sin clave de operación: la prorrata no se declara ` +
        `sin clasificarlos (O-10) — ${cut(p.unclassifiedDocuments, 10)}`
    )
  }
  const problems: string[] = []
  if (p.definitiveBps !== p.recomputedBps) {
    problems.push(`definitiva sellada ${p.definitiveBps} bps ≠ recomputada ${p.recomputedBps} bps`)
  }
  if (p.definitiveBps % 100 !== 0) {
    problems.push(`la definitiva ${p.definitiveBps} bps no es múltiplo de 100 (art. 104.Dos.2ª: entero redondeado al alza)`)
  }
  const esperado =
    Number((BigInt(p.prorrateableQuotaCents) * BigInt(p.definitiveBps)) / BigInt(10_000)) -
    Number((BigInt(p.prorrateableQuotaCents) * BigInt(p.provisionalBps)) / BigInt(10_000))
  if (esperado !== p.adjustmentCents) {
    problems.push(`ajuste sellado ${p.adjustmentCents} ≠ recomputado ${esperado} sobre la cuota prorrateable del año (O-9)`)
  }
  return problems.length === 0
    ? pass(
        "I-E9-10",
        `prorrata ${p.year}: definitiva ${p.definitiveBps} bps derivada de ${p.numeratorCents}/${p.denominatorCents}, ` +
          `ajuste ${p.adjustmentCents} sobre cuota prorrateable ${p.prorrateableQuotaCents}`
      )
    : failed("I-E9-10", cut(problems))
}

/** **I-E9-10b (O-11)** — momento, importe y arrastre de la regularización de prorrata. */
export function checkIE910b(block: VatBlock | undefined): CheckResult {
  const p = block?.prorrata
  if (!p) return missing("I-E9-10b", "falta la prorrata definitiva del año")
  if (p.adjustmentPeriod == null || p.lastPeriodOfYear == null) {
    return info("I-E9-10b", "falta el `ivaPeriod` del asiento de regularización o el último periodo del año")
  }
  const problems: string[] = []
  if (p.adjustmentPeriod !== p.lastPeriodOfYear) {
    problems.push(`el asiento de regularización va en ${p.adjustmentPeriod} y debe ir en ${p.lastPeriodOfYear} (art. 105.Uno)`)
  }
  if (p.postedBeforeSettlement === false) {
    problems.push("la regularización se posteó DESPUÉS de la T-23 de su periodo: debe ir antes (O-11)")
  }
  if (p.adjustment634639Cents != null && p.adjustment634639Cents !== p.adjustmentCents) {
    problems.push(`movimiento neto de 634/639 ${p.adjustment634639Cents} ≠ ajuste ${p.adjustmentCents}`)
  }
  if (p.adjustment472Cents != null && p.adjustment472Cents !== p.adjustmentCents) {
    problems.push(`componente de 472 del asiento ${p.adjustment472Cents} ≠ ajuste ${p.adjustmentCents}`)
  }
  if (p.nextYearProvisionalBps != null && p.nextYearProvisionalBps !== p.definitiveBps) {
    problems.push(
      `la provisional de ${p.year + 1} es ${p.nextYearProvisionalBps} bps y debe ser la definitiva de ${p.year} (${p.definitiveBps} bps)`
    )
  }
  return problems.length === 0
    ? pass(
        "I-E9-10b",
        `regularización en ${p.adjustmentPeriod}, antes de su liquidación, con 634/639 = 472 = ${p.adjustmentCents} ` +
          `y provisional de ${p.year + 1} fijada en ${p.definitiveBps} bps`
      )
    : failed("I-E9-10b", cut(problems))
}

/** **I-E9-11** — ningún asiento con línea de IVA en un periodo ya liquidado (B-6). */
export function checkIE911(block: VatBlock | undefined): CheckResult {
  if (!block?.vatLines || !block.settledPeriods) {
    return missing("I-E9-11", "faltan las líneas de IVA o la lista de periodos liquidados")
  }
  const settled = new Set(block.settledPeriods)
  const intruders = block.vatLines
    .filter((l) => l.storedPeriod !== null && settled.has(l.storedPeriod))
    .map((l) => `asiento ${l.entryNumber} (${l.accountCode}) en ${l.storedPeriod}, ya liquidado`)
  const query =
    "SELECT e.entry_number, e.iva_period FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id " +
    "WHERE e.organization_id = $1 AND e.iva_period = ANY($2) AND l.account_code IN ('472', '477', '4728', '4778')"
  // Las líneas de la PROPIA liquidación llevan el periodo liquidado, así que
  // quien lee la base excluye el asiento de T-23: aquí sólo se juzga lo que llega.
  return intruders.length === 0
    ? pass("I-E9-11", `${settled.size} periodo(s) liquidado(s) y ninguna línea de IVA nueva en ellos`, query)
    : failed("I-E9-11", cut(intruders), query)
}

/** **I-E9-22 (O-16)** — DUA: la base es la del DUA, y el 477 depende del diferimiento. */
export function checkIE922(block: VatBlock | undefined): CheckResult {
  if (!block?.dua) return missing("I-E9-22", "faltan los DUA de importación del periodo")
  if (block.dua.length === 0) return info("I-E9-22", "ninguna importación con DUA en el periodo")
  const problems: string[] = []
  for (const d of block.dua) {
    if (d.bookedBaseCents !== d.customsValueCents) {
      problems.push(
        `${d.documentNumber}: base anotada ${d.bookedBaseCents} ≠ base del DUA ${d.customsValueCents} ` +
          `(la de la factura del proveedor es ${d.invoiceBaseCents})`
      )
    }
    if (!d.importDeferral && d.outputVatCents !== 0) {
      problems.push(`${d.documentNumber}: sin diferimiento no puede generar 477 y genera ${d.outputVatCents}`)
    }
    if (d.importDeferral) {
      if (d.outputVatCents !== d.vatQuotaCents) {
        problems.push(`${d.documentNumber}: con diferimiento el 477 debe ser ${d.vatQuotaCents} y es ${d.outputVatCents}`)
      }
      if (d.box77Cents != null && d.box77Cents !== d.vatQuotaCents) {
        problems.push(`${d.documentNumber}: la casilla 77 declara ${d.box77Cents} y la cuota es ${d.vatQuotaCents}`)
      }
    }
  }
  return problems.length === 0
    ? pass("I-E9-22", `${block.dua.length} DUA con la base de aduana anotada y el devengo del art. 167.Dos bien resuelto`)
    : failed("I-E9-22", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-12 … 15 — regularización, cierre y apertura
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-12** — tras T-26 **todas** las cuentas de grupo 6 y 7, **`6300` incluida**, a 0. */
export function checkIE912(block: ClosingEntriesBlock | undefined): CheckResult {
  const balances = block?.balancesAfterRegularization
  if (!balances) return missing("I-E9-12", "faltan los saldos por cuenta tras la regularización")
  const alive = Object.entries(balances)
    .filter(([code, cents]) => (code.startsWith("6") || code.startsWith("7")) && cents !== 0)
    .map(([code, cents]) => `${code}: ${cents}`)
  const has6300 = Object.keys(balances).some((c) => c.startsWith("6300"))
  return alive.length === 0
    ? pass(
        "I-E9-12",
        `todas las cuentas de los grupos 6 y 7 quedan a cero tras la regularización${has6300 ? " (6300 incluida)" : ""}`
      )
    : failed("I-E9-12", `cuentas de 6/7 con saldo tras T-26: ${cut(alive)}`)
}

/** **I-E9-13** — `129` tras T-26 = I3 del ejercicio. */
export function checkIE913(block: ClosingEntriesBlock | undefined): CheckResult {
  if (!block || block.balance129Cents == null || block.resultI3Cents == null) {
    return missing("I-E9-13", "falta el saldo de 129 tras la regularización o el resultado I3")
  }
  return block.balance129Cents === block.resultI3Cents
    ? pass("I-E9-13", `129 tras T-26 = ${block.balance129Cents} = resultado I3 del ejercicio`)
    : failed(
        "I-E9-13",
        `129 tras T-26 ${block.balance129Cents} ≠ resultado I3 ${block.resultI3Cents} ` +
          `(diferencia ${block.balance129Cents - block.resultI3Cents})`
      )
}

/** **I-E9-14 (O-8)** — apertura = cierre **línea a línea**, con los saldos ya reclasificados. */
export function checkIE914(block: ClosingEntriesBlock | undefined): CheckResult {
  if (!block?.entries) return missing("I-E9-14", "faltan los asientos de cierre y apertura")
  const closing = block.entries.find((e) => e.kind === "CLOSING")
  const opening = block.entries.find((e) => e.kind === "OPENING")
  if (!closing || !opening) {
    return info("I-E9-14", "no hay todavía par de cierre y apertura que comparar")
  }
  const net = reversalNetsToZero(closing.lines, opening.lines)
  const problems: string[] = []
  if (!net.ok) {
    problems.push(
      `cierre y apertura no son espejo: ${net.residuals.map((r) => `${r.accountCode}: ${r.diffCents}`).join(", ")}`
    )
  }
  if (block.nextYearEntries) problems.push(...reclassReversalDeviations(block.nextYearEntries))
  return problems.length === 0
    ? pass("I-E9-14", `apertura espejo exacto del cierre en ${closing.lines.length} línea(s), con los saldos ya reclasificados`)
    : failed("I-E9-14", cut(problems))
}

/** **I-E9-15** — ningún asiento en un ejercicio `CLOSED` posterior a su `closedAt`. */
export function checkIE915(block: ClosingEntriesBlock | undefined): CheckResult {
  if (!block?.postedAfterClose) return missing("I-E9-15", "falta la lista de asientos posteados tras el cierre")
  const intruders = block.postedAfterClose
    .filter((e) => !e.isReopeningReversal)
    .map((e) => `asiento ${e.entryNumber} de ${e.fiscalYearCode} posteado el ${e.postedAt}, ya cerrado`)
  return intruders.length === 0
    ? pass("I-E9-15", "ningún asiento posterior al cierre salvo los contra-asientos de una reapertura registrada")
    : failed("I-E9-15", cut(intruders))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-16 / 25 — reclasificación (NO tautológico)
// ─────────────────────────────────────────────────────────────────────────────

const counterpartyKey = (p: MaturityPosition): string => `${p.counterpartyId ?? "sin contraparte"} ${p.currency}`

/**
 * **I-E9-16.** Tres afirmaciones sobre el asiento **ya posteado**, no sobre un
 * recomputo de sí mismo:
 *
 * 1. `Σ largo + Σ corto` **por contraparte** no cambia con la reclasificación;
 * 2. toda posición reclasificada **tiene `dueDate`**;
 * 3. **ninguna posición con `dueDate ≤ corte + threshold` queda en la cuenta de
 *    largo** —lo que faltaba en la ronda 0, y lo único que distingue «la suma
 *    cuadra» de «está bien clasificado»—.
 */
export function checkIE916(block: ReclassBlock | undefined): CheckResult {
  if (!block) return missing("I-E9-16", "faltan las posiciones vivas antes y después de la reclasificación")
  const boundary = maturityBoundary(block.cutoff, block.thresholdMonths ?? 12)
  const pairs = block.pairs ?? []
  const longCodes = new Set(pairs.map((p) => p.longCode))
  const problems: string[] = []

  const totals = (positions: readonly MaturityPosition[]): Map<string, Cents> => {
    const map = new Map<string, Cents>()
    for (const p of positions) {
      if (pairs.length > 0 && !longCodes.has(p.accountCode) && !pairs.some((x) => x.shortCode === p.accountCode)) continue
      map.set(counterpartyKey(p), (map.get(counterpartyKey(p)) ?? 0) + p.openCents)
    }
    return map
  }
  const before = totals(block.positionsBefore)
  const after = totals(block.positionsAfter)
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(key) ?? 0
    const a = after.get(key) ?? 0
    if (b !== a) problems.push(`${key}: Σ largo + corto pasa de ${b} a ${a} (la reclasificación no puede mover el total)`)
  }

  const sinFecha = block.positionsAfter
    .filter((p) => p.dueDate === null && (longCodes.has(p.accountCode) || pairs.some((x) => x.shortCode === p.accountCode)))
    .map((p) => `${p.accountCode}/${p.counterpartyId ?? "sin contraparte"} sin vencimiento`)
  problems.push(...sinFecha)

  const malClasificadas = block.positionsAfter
    .filter((p) => p.dueDate !== null && longCodes.has(p.accountCode) && p.dueDate <= boundary)
    .map((p) => `${p.accountCode}/${p.counterpartyId ?? "sin contraparte"} vence ${p.dueDate} ≤ ${boundary} y sigue en la cuenta de largo`)
  problems.push(...malClasificadas)

  return problems.length === 0
    ? pass(
        "I-E9-16",
        `frontera ${boundary}: la suma por contraparte no cambia, toda posición reclasificada tiene vencimiento y ` +
          "ninguna vence dentro del año en una cuenta de largo plazo"
      )
    : failed("I-E9-16", cut(problems))
}

/** **I-E9-25 (O-6)** — toda posición de `17x`/`52x` viva tiene desglose, o está declarada con motivo. */
export function checkIE925(block: ReclassBlock | undefined): CheckResult {
  if (!block?.debtsWithoutSchedule) return missing("I-E9-25", "falta la lista de deudas de 17x/52x sin desglose")
  const undeclared = block.debtsWithoutSchedule
    .filter((d) => !d.declaredReason)
    .map((d) => `${d.reference} (${d.accountCode}, ${d.openCents} c): declare el cuadro de vencimientos de la deuda`)
  const declared = block.debtsWithoutSchedule.filter((d) => d.declaredReason)
  if (undeclared.length > 0) return failed("I-E9-25", cut(undeclared))
  return declared.length === 0
    ? pass("I-E9-25", "toda deuda viva de 17x/52x tiene su cuadro de vencimientos")
    : warn(
        "I-E9-25",
        `${declared.length} deuda(s) sin desglose declaradas por una persona con motivo: ` +
          cut(declared.map((d) => `${d.reference}: ${d.declaredReason}`), 10)
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-17 / 18 / 24 — diferencias de cambio
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-17 (O-4/O-5)** — tras T-30, `D × r − S = 0` con la tasa **sellada**. */
export function checkIE917(block: FxBlock | undefined): CheckResult {
  if (!block) return missing("I-E9-17", "faltan las posiciones en divisa y las tasas de cierre")
  const monetary = block.positionsAfter.filter((p) => p.isMonetary)
  if (monetary.length === 0) return info("I-E9-17", "ninguna posición monetaria en divisa a la fecha de cierre")
  const sealed = new Map((block.sealedRates ?? []).map((r) => [r.currency.toUpperCase(), r]))
  const problems: string[] = []
  for (const p of monetary) {
    const currency = p.currency.toUpperCase()
    const effective = closingRateFor(block.rates, currency, block.cutoff, block.windowDays ?? 7)
    const used = sealed.get(currency) ?? effective
    if (!used) {
      problems.push(`${p.accountCode} (${currency}): sin tasa de cierre publicada en la ventana`)
      continue
    }
    if (effective && (used.rateMicro !== effective.rateMicro || used.rateDate !== effective.rateDate)) {
      problems.push(
        `${p.accountCode} (${currency}): el asiento sella la tasa de ${used.rateDate} y la efectiva es la de ${effective.rateDate}`
      )
    }
    const delta = convertWithRateMicro(p.currencyBalanceCents, used.rateMicro) - p.baseBalanceCents
    if (delta !== 0) {
      problems.push(`${p.accountCode} (${currency}): D × r − S = ${delta} tras T-30, debería ser 0`)
    }
  }
  return problems.length === 0
    ? pass("I-E9-17", `${monetary.length} posición(es) monetaria(s) valorada(s) a la tasa sellada, sin diferencia pendiente`)
    : failed("I-E9-17", cut(problems))
}

/** **I-E9-18** — el asiento de diferencias de cambio no mueve ninguna posición **en divisa**. */
export function checkIE918(block: FxBlock | undefined): CheckResult {
  if (!block?.adjustmentLines) return missing("I-E9-18", "faltan las líneas del asiento de diferencias de cambio")
  const byCurrency = new Map<string, Cents>()
  for (const l of block.adjustmentLines) {
    if (!l.originalCurrency) continue
    byCurrency.set(l.originalCurrency, (byCurrency.get(l.originalCurrency) ?? 0) + (l.originalAmountCents ?? 0))
  }
  const problems = [...byCurrency.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([currency, cents]) => `${currency}: Σ originalAmountCents = ${cents}, debería ser 0 (R-FX-4)`)
  return problems.length === 0
    ? pass("I-E9-18", `${block.adjustmentLines.length} línea(s) de T-30 sin mover un céntimo de divisa`)
    : failed("I-E9-18", cut(problems))
}

/** **I-E9-24 (O-4)** — ninguna cuenta **no monetaria** entra en el barrido. */
export function checkIE924(block: FxBlock | undefined): CheckResult {
  if (!block) return missing("I-E9-24", "faltan las posiciones en divisa")
  const intruders = (block.nonMonetaryInSweep ?? []).map((l) => `${l.accountCode} (${l.currency})`)
  const nonMonetary = block.positionsAfter.filter((p) => !p.isMonetary)
  return intruders.length === 0
    ? pass(
        "I-E9-24",
        `el barrido se limita a las cuentas con is_monetary${
          nonMonetary.length > 0 ? `; ${nonMonetary.length} posición(es) en divisa excluida(s) (407, 438…)` : ""
        }`
      )
    : failed(
        "I-E9-24",
        `cuentas NO monetarias en el barrido de diferencias de cambio: ${cut(intruders)} — ` +
          "un anticipo no da derecho a recibir un importe fijo de efectivo, y descontarlo inventa resultado"
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-19 — valor actual
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-19 (O-1)** — `descuento inicial = Σ intereses` y a vencimiento el pasivo vale su **nominal**. */
export function checkIE919(items: readonly PresentValueSnapshot[] | undefined): CheckResult {
  if (!items) return missing("I-E9-19", "faltan los aplazamientos descontados y sus cuadros de interés implícito")
  if (items.length === 0) return info("I-E9-19", "ningún aplazamiento descontado a valor actual")
  const problems: string[] = []
  for (const item of items) {
    const discount = item.nominalCents - item.presentValueCents
    if (discount !== item.scheduledInterestCents) {
      problems.push(`${item.reference}: descuento ${discount} ≠ Σ intereses implícitos ${item.scheduledInterestCents}`)
    }
    if (item.finalCarryingCents !== item.nominalCents) {
      problems.push(`${item.reference}: a vencimiento vale ${item.finalCarryingCents} y su nominal es ${item.nominalCents}`)
    }
  }
  return problems.length === 0
    ? pass("I-E9-19", `${items.length} aplazamiento(s): el descuento se devenga íntegro y a vencimiento vale su nominal`)
    : failed("I-E9-19", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-20 / 21 — el `ClosingRun` y la reapertura
// ─────────────────────────────────────────────────────────────────────────────

/** **I-E9-20** — el `ClosingRun` es reproducible y un ejercicio cerrado tiene exactamente uno `CERRADO`. */
export function checkIE920(runs: readonly ClosingRunSnapshot[] | undefined): CheckResult {
  if (!runs) return missing("I-E9-20", "faltan los `ClosingRun`")
  const problems: string[] = []
  const cerradosPorEjercicio = new Map<string, number>()
  for (const run of runs) {
    if (run.status === "CERRADO") {
      cerradosPorEjercicio.set(run.fiscalYearCode, (cerradosPorEjercicio.get(run.fiscalYearCode) ?? 0) + 1)
    }
    if (run.stepsHash && run.recomputedStepsHash && run.stepsHash !== run.recomputedStepsHash) {
      problems.push(
        `${run.fiscalYearCode}: los pasos recomputados sobre ledgerHash ${run.ledgerHash.slice(0, 8)} y configHash ` +
          `${run.configHash.slice(0, 8)} dan otro veredicto`
      )
    }
  }
  for (const [code, n] of cerradosPorEjercicio) {
    if (n > 1) problems.push(`${code}: ${n} ClosingRun en estado CERRADO, debe haber exactamente uno`)
  }
  return problems.length === 0
    ? pass("I-E9-20", `${runs.length} ClosingRun reproducible(s), uno CERRADO por ejercicio cerrado`)
    : failed("I-E9-20", cut(problems))
}

/** El orden inverso de la reversión (O-21): **T-28 → T-27 → T-26 → T-25**. */
export const REOPENING_REVERSAL_TEMPLATES: readonly string[] = ["T-28", "T-27", "T-26", "T-25"]

/**
 * **I-E9-21 (O-21).** Existen los **cuatro** contra-asientos, el saldo de **cada
 * cuenta de los grupos 1 a 7** vuelve al previo al cierre y **`129 = 0` y
 * `6300 = 0`**. Sin revertir T-25, al recerrar el impuesto se posteaba otra vez y
 * `6300` quedaba al doble con `4752` duplicado.
 */
export function checkIE921(reopening: ReopeningSnapshot | null | undefined): CheckResult {
  if (reopening === undefined) return missing("I-E9-21", "falta la foto de la reapertura")
  if (reopening === null) return info("I-E9-21", "ningún ejercicio reabierto")
  const problems: string[] = []
  const found = new Set(reopening.reversedTemplates)
  const faltan = REOPENING_REVERSAL_TEMPLATES.filter((t) => !found.has(t))
  if (faltan.length > 0) problems.push(`faltan los contra-asientos de ${faltan.join(", ")} (orden inverso T-28 → T-25)`)
  for (const d of reopening.driftedAccounts) {
    problems.push(`${d.accountCode}: ${d.beforeCents} antes del cierre, ${d.afterCents} tras la reapertura`)
  }
  if (reopening.balance129Cents !== 0) problems.push(`129 = ${reopening.balance129Cents}, debe quedar a 0`)
  if (reopening.balance6300Cents !== 0) problems.push(`6300 = ${reopening.balance6300Cents}, debe quedar a 0`)
  return problems.length === 0
    ? pass(
        "I-E9-21",
        `${reopening.fiscalYearCode} reabierto con los cuatro contra-asientos, los grupos 1 a 7 en su saldo previo y ` +
          `129 = 6300 = 0${reopening.pendingRecompute?.length ? `; pasos PENDIENTE_RECOMPUTO: ${reopening.pendingRecompute.join(", ")}` : ""}`
      )
    : failed("I-E9-21", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E9-23 — distribución del resultado (O-18)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE923(items: readonly DistributionSnapshot[] | undefined): CheckResult {
  if (!items) return missing("I-E9-23", "falta la distribución del resultado de los ejercicios aprobados")
  const aprobados = items.filter((d) => d.approvalStatus === "APROBADAS" || d.approvalStatus === "DEPOSITADAS")
  if (aprobados.length === 0) return info("I-E9-23", "ningún ejercicio con las cuentas aprobadas todavía")
  const problems: string[] = []
  const avisos: string[] = []
  for (const d of aprobados) {
    if (d.pending129Cents !== 0) {
      problems.push(`${d.fiscalYearCode}: 129 sigue con ${d.pending129Cents} tras aprobar las cuentas`)
    }
    if (d.destinationsCents !== d.profitCents) {
      problems.push(`${d.fiscalYearCode}: Σ destinos ${d.destinationsCents} ≠ resultado regularizado ${d.profitCents}`)
    }
    if (d.legalReserveCents < d.legalReserveRequiredCents) {
      problems.push(
        `${d.fiscalYearCode}: reserva legal dotada ${d.legalReserveCents} < exigida ${d.legalReserveRequiredCents} (art. 274 LSC)`
      )
    }
    if (d.capitalSource === "DECLARADO") {
      avisos.push(`${d.fiscalYearCode}: el capital social se ha declarado en vez de derivarse del saldo de 100 (R2-2)`)
    }
  }
  if (problems.length > 0) return failed("I-E9-23", cut(problems))
  return avisos.length === 0
    ? pass("I-E9-23", `${aprobados.length} ejercicio(s) aprobado(s) con 129 a cero, Σ destinos = resultado y la reserva legal dotada`)
    : warn("I-E9-23", cut(avisos))
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución completa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los **veintisiete** resultados, siempre en el mismo orden y **siempre los
 * veintisiete**: un invariante que desaparece de la lista porque nadie aportó su
 * bloque es exactamente el silencio que la pestaña de auditoría existe para
 * evitar (riesgo R3 de E7). Lo no evaluable sale `INFO` diciendo qué falta.
 */
export function runClosingInvariants(input: ClosingInvariantInput): CheckResult[] {
  const vat = input.vat
  return [
    checkIE91a(input.recurring),
    checkIE91b(input.recurring),
    checkIE92(input.recurring),
    checkIE93(input.assets),
    checkIE94(input.assets),
    checkIE95(input.assets),
    checkIE96(input.accruals, input.cutoff),
    checkIE97(input.accruals),
    // I-E9-8a′ vive en `lib/closing/vat.ts` (T8): la regla y su invariante, juntos.
    vat?.book && vat.balances && vat.settlements
      ? checkIE98aPrime(vat.book, vat.balances, vat.settlements)
      : missing("I-E9-8a′", "faltan el libro registro, los saldos del diario o las liquidaciones selladas"),
    checkIE98b(vat),
    checkIE99(vat),
    checkIE910(vat),
    checkIE910b(vat),
    checkIE911(vat),
    checkIE912(input.closing),
    checkIE913(input.closing),
    checkIE914(input.closing),
    checkIE915(input.closing),
    checkIE916(input.reclass),
    checkIE917(input.fx),
    checkIE918(input.fx),
    checkIE919(input.presentValue),
    checkIE920(input.closingRuns),
    checkIE921(input.reopening),
    checkIE922(vat),
    checkIE923(input.distribution),
    checkIE924(input.fx),
    checkIE925(input.reclass),
    // I-E9-26 vive también en `vat.ts`: el barrido del 31/12 y su comprobación.
    vat?.recc ? checkReccFullyAccrued(vat.recc, input.cutoff) : missing("I-E9-26", "faltan las facturas pendientes de RECC"),
  ]
}
