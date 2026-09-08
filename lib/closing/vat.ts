/**
 * E9 · T8 — Liquidación de IVA, prorrata, RECC, importación y el 303
 * (`docs/design/E9-cierre-recurrentes.md` §4.4, **R-IVA-8…20**; ADR-0016 **D4**,
 * **D8** y **D12**; observaciones **O-9…O-16** y **O-27** de la validación
 * contable).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM. Todo lo que
 * hace falta —el libro registro del periodo, los saldos del diario, el régimen
 * vigente— entra por parámetro; lo que sale son cifras, líneas de borrador y
 * `CheckResult`s. Quien las postea es la capa de aplicación (T13/T15).
 *
 * ## Las cinco decisiones que gobiernan este fichero
 *
 * 1. **La liquidación sale del LIBRO REGISTRO, no de los saldos** (R-IVA-9). Los
 *    saldos de `472`/`477` son *la otra orilla del puente*: sirven para
 *    **verificar**. Si libro y diario difieren, **no se postea** y se enseña la
 *    diferencia documento a documento. Un producto que liquidase por saldos no
 *    podría detectar un `UPDATE` por SQL sobre una cuota (criterio 12 de §12).
 * 2. **La base del ajuste de prorrata es la cuota soportada PRORRATEABLE del
 *    año** (O-9), no «lo ya deducido». Con la lectura errónea, sobre 100 000 con
 *    provisional 80 % y definitiva 87 % el ajuste salía 5 600 en vez de **7 000**.
 * 3. **El numerador y el denominador se DERIVAN del libro de emitidas** con las
 *    exclusiones del art. 104.Tres **marcadas en el documento** (O-10). Con
 *    documentos sin clasificar el resultado es `INFO` **con su lista**, nunca un
 *    porcentaje: un porcentaje inventado se declara y se paga.
 * 4. **Bajo RECC, `477` sólo recoge lo cobrado** mientras el libro anota la
 *    factura íntegra en su expedición (arts. 63 y 61 *decies* RIVA). Por eso los
 *    puentes al 303 se reformulan con las cuentas de pendiente incluidas
 *    (**15a′/15c′**, O-14): un invariante que falla por hacer lo correcto es peor
 *    que no tenerlo.
 * 5. **El art. 107 (bienes de inversión) queda para E10, pero el cierre no
 *    avanza en silencio** (O-12): `capitalGoodsGuard` es una guardia
 *    determinista y **bloqueante**. Una casilla en blanco con una nota es honesta
 *    frente al usuario, no frente a la AEAT.
 *
 * ## Aritmética
 *
 * Céntimos **enteros**. Los productos y cocientes pasan por `BigInt` y truncan
 * hacia cero (`trunc`), con el residuo a la **última** aplicación —la misma
 * convención que R-AM-2 y R-PE-2—. El porcentaje definitivo de prorrata es la
 * excepción: se redondea **al alza** a entero (art. 104.Dos.2ª).
 */

import type { AccountKey, Cents, DraftLine, LedgerError, LocalDate, Result } from "@/lib/ledger/types"
import { err, fail, ok } from "@/lib/ledger/types"
import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"
import type { Deducibilidad } from "@/lib/ledger/tax"
import { periodBounds, periodKeyOf, type PeriodKey, type RecurrenceFreq } from "@/lib/recurring/schedule"
import { model303MapAt, offeredBoxes, type Model303Box, type Model303Map } from "@/lib/closing/model303.map"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos (mismos literales que los enums del esquema; sin Prisma)
// ─────────────────────────────────────────────────────────────────────────────

export type VatPeriodKind = "MENSUAL" | "TRIMESTRAL"
export type IvaRegime = "GENERAL" | "RECC" | "REDEME" | "OTRO"

/**
 * Clave de operación del libro registro. **Toda exclusión de la prorrata es una
 * clave marcada en el documento, jamás deducida por el motor** (O-10): sin
 * clave, el documento cuenta como *sin clasificar* y la prorrata sale `INFO`.
 */
export type VatOperationKey =
  /** Sujeta y no exenta en el TAI: con derecho a deducción. */
  | "INTERIOR"
  /** Adquisición intracomunitaria de bienes o servicios (casillas 10-11). */
  | "AIB"
  /** Inversión del sujeto pasivo (casillas 12-13). */
  | "ISP"
  /** Importación con DUA (casillas 32-35). */
  | "IMPORTACION"
  /** Exportación y asimiladas (art. 21-23): numerador, casilla 60. */
  | "EXPORTACION"
  /** Entrega intracomunitaria exenta (art. 25): numerador, casilla 59. */
  | "EIB"
  /** Exención **plena** del art. 94.Uno: numerador, casilla 61. */
  | "EXENTA_PLENA"
  /** Exención **limitada** del art. 20: sólo denominador. */
  | "EXENTA_LIMITADA"
  /** No sujeta con derecho a deducción o con ISP: casilla 61. */
  | "NO_SUJETA_ISP"
  // ── Excluidas de ambos términos (art. 104.Tres) ──────────────────────────
  | "BIEN_INVERSION_USADO"
  | "INMOBILIARIA_NO_HABITUAL"
  | "FINANCIERA_NO_HABITUAL"
  | "AUTOCONSUMO_9_1_C_D"
  | "FUERA_TAI"

export type VatDocKind = "FACTURA" | "RECTIFICATIVA" | "DUA_IMPORTACION"

/**
 * Fila del libro registro con las columnas que E9 necesita. Extiende la de E8
 * (`lib/ledger/invariants-e8.ts · VatBookRow`) sin tocarla: E9 **agrupa por
 * periodo** un libro que ya se deriva del asiento contabilizado.
 *
 * Las columnas de RECC —fechas e importes de cobro y pago y medio empleado,
 * arts. 61 *decies* y *undecies* RIVA— llegan resumidas en las dos «cuotas en el
 * periodo»: **`cuota*Cents` es lo que el libro anota por la factura íntegra**
 * (en su expedición) y **`cuota*EnPeriodoCents` es lo efectivamente devengado o
 * deducido en este periodo**. Fuera de RECC las dos coinciden, y ahí está toda
 * la diferencia entre I-E8-15c y I-E8-15c′.
 */
export type VatBookRowE9 = {
  id: string
  entryId: string | null
  ivaPeriod: PeriodKey
  tipo: "RECIBIDAS" | "EMITIDAS"
  docKind: VatDocKind
  operationKey: VatOperationKey | null
  /** Tipo impositivo en puntos básicos (2100 = 21 %). `null` en exentas. */
  rateBps: number | null
  baseCents: Cents
  /**
   * Base imputable **a este periodo**. Bajo RECC es la parte proporcional al
   * cobro o al pago; fuera de RECC coincide con `baseCents`. Las casillas
   * 01-09, 10, 12, 14 y 28-41 declaran ésta; las informativas y las de RECC
   * (62/63 y 74/75) declaran la **íntegra**, que es lo que el libro anota en la
   * expedición de la factura (art. 61 *decies* RIVA).
   */
  baseEnPeriodoCents: Cents
  cuotaTotalCents: Cents
  cuotaDeducibleCents: Cents
  cuotaNoDeducibleAlCosteCents: Cents
  cuotaRepercutidaCents: Cents
  cuotaDevengadaIspAibCents: Cents
  /** EMITIDAS: repercutido **efectivamente devengado** en el periodo (RECC: al cobro). */
  cuotaDevengadaEnPeriodoCents: Cents
  /** RECIBIDAS: soportado **efectivamente deducible** en el periodo (RECC: al pago). */
  cuotaDeducibleEnPeriodoCents: Cents
  /** Grupo 2 del PGC: separa 30-31, 34-35 y 38-39, y alimenta la guardia del art. 107. */
  investmentGood: boolean
  /** `FULL` (afectación exclusiva), `NONE` (art. 96) o `PRORRATA`: define la base de O-9. */
  deductibility: Deducibilidad | null
  /** La operación está acogida a RECC (propia o del proveedor, `Counterparty.ivaRegime`). */
  recc: boolean
  /** DUA con diferimiento del ingreso (art. 167.Dos LIVA): casilla 77. */
  importDeferred: boolean
  documentDate: LocalDate
  deductionDate: LocalDate
}

/**
 * Saldos del diario por periodo, con las dos cuentas de pendiente de RECC
 * (O-14). Signo: `472`/`4728` en **deudor** (debe − haber) y `477`/`4778` en
 * **acreedor** (haber − debe), que es como quedan cuando el asiento es correcto.
 */
export type VatBalanceRowE9 = {
  ivaPeriod: PeriodKey
  saldo472Cents: Cents
  saldo477Cents: Cents
  saldo4728Cents: Cents
  saldo4778Cents: Cents
  /** Desglose por asiento, para enseñar la diferencia **documento a documento**. */
  byEntry?: readonly { entryId: string; saldo472Cents: Cents; saldo477Cents: Cents }[]
}

/** Vigencia del régimen (`VatRegimePeriod`): el régimen es un dato FECHADO (D8.1). */
export type VatRegimePeriodRef = {
  regime: IvaRegime
  periodKind: VatPeriodKind
  importDeferral: boolean
  validFrom: LocalDate
  validTo: LocalDate | null
}

/** Paso del checklist de cierre (§4.8). T13 lo consume tal cual. */
export type ClosingStepResult = {
  step: string
  block: string
  status: CheckStatus | "NA" | "PENDIENTE_RECOMPUTO"
  blocking: boolean
  evidencia: string
  /** Motivo de sello que el paso aporta cuando no está en PASS. */
  sealReason?: string
  query?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética entera
// ─────────────────────────────────────────────────────────────────────────────

const sum = (values: readonly number[]): Cents => values.reduce((a, b) => a + b, 0)

/** `a × b / d` truncado **hacia cero**, en `BigInt`: sin coma flotante y sin sesgo de signo. */
export function mulDivTrunc(a: Cents, b: number, d: number): Cents {
  if (d === 0) throw new RangeError("mulDivTrunc: divisor 0")
  const q = (BigInt(a) * BigInt(b)) / BigInt(d)
  return Number(q)
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n)

// ─────────────────────────────────────────────────────────────────────────────
// R-IVA-8 · el periodo, y el régimen que lo decide
// ─────────────────────────────────────────────────────────────────────────────

const freqOf = (kind: VatPeriodKind): RecurrenceFreq => (kind === "MENSUAL" ? "MENSUAL" : "TRIMESTRAL")

/**
 * **R-IVA-8.** Periodo de IVA de una fecha según el `kind` **vigente a esa
 * fecha**. `quarterOf` de E8 no se borra: es el caso `TRIMESTRAL`, y el
 * `ivaPeriod` de una organización trimestral no cambia ni un valor.
 */
export function vatPeriodOf(date: LocalDate, kind: VatPeriodKind): PeriodKey {
  return periodKeyOf(date, freqOf(kind))
}

/** `MENSUAL` si la clave es `YYYY-MM`, `TRIMESTRAL` si es `YYYY-QN`. */
export function vatPeriodKindOf(period: PeriodKey): VatPeriodKind {
  if (/^\d{4}-Q[1-4]$/.test(period)) return "TRIMESTRAL"
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return "MENSUAL"
  throw new TypeError(`periodo de IVA «${period}» inválido`)
}

/** Primer y último día naturales del periodo de IVA. */
export function vatPeriodBounds(period: PeriodKey): { start: LocalDate; end: LocalDate } {
  return periodBounds(period, freqOf(vatPeriodKindOf(period)))
}

/** Año natural del periodo. */
export const vatPeriodYear = (period: PeriodKey): number => Number(period.slice(0, 4))

/** Último periodo del año natural: donde se practica la regularización (art. 105.Uno). */
export function lastVatPeriodOfYear(year: number, kind: VatPeriodKind): PeriodKey {
  return kind === "MENSUAL" ? `${year}-12` : `${year}-Q4`
}

/** Régimen vigente a una fecha (`VatRegimePeriod`), o `null` si no hay ninguno. */
export function vatRegimeAt(periods: readonly VatRegimePeriodRef[], date: LocalDate): VatRegimePeriodRef | null {
  const hits = periods.filter((p) => p.validFrom <= date && (p.validTo === null || date <= p.validTo))
  if (hits.length === 0) return null
  // Vigencias sin solape por `EXCLUDE USING gist`; si aun así hubiera dos, manda
  // la más reciente: nunca se elige «la primera que aparezca en el array».
  return hits.reduce((best, p) => (p.validFrom > best.validFrom ? p : best))
}

/**
 * **R-IVA-8 completo**: el periodo de un asiento es
 * `vatPeriodOf(max(receptionDate, documentDate), kind vigente a esa fecha)`.
 */
export function vatPeriodForDates(
  receptionDate: LocalDate | null,
  documentDate: LocalDate,
  regimes: readonly VatRegimePeriodRef[]
): Result<{ period: PeriodKey; date: LocalDate; regime: VatRegimePeriodRef }> {
  const date = receptionDate !== null && receptionDate > documentDate ? receptionDate : documentDate
  const regime = vatRegimeAt(regimes, date)
  if (!regime) {
    return fail(
      err("TEMPLATE_INPUT", "ivaPeriod", `No hay régimen de IVA vigente a ${date}: el periodo no se puede decidir`, {
        check: "R-IVA-8",
      })
    )
  }
  return ok({ period: vatPeriodOf(date, regime.periodKind), date, regime })
}

// ─────────────────────────────────────────────────────────────────────────────
// El libro registro del periodo, resumido
// ─────────────────────────────────────────────────────────────────────────────

const issued = (book: readonly VatBookRowE9[]): VatBookRowE9[] => book.filter((r) => r.tipo === "EMITIDAS")
const received = (book: readonly VatBookRowE9[]): VatBookRowE9[] => book.filter((r) => r.tipo === "RECIBIDAS")
const inPeriod = (book: readonly VatBookRowE9[], period: PeriodKey): VatBookRowE9[] =>
  book.filter((r) => r.ivaPeriod === period)

/** Orden canónico del libro: periodo, tipo, fecha y id. Determinista y estable. */
export const byBookOrder = (a: VatBookRowE9, b: VatBookRowE9): number =>
  a.ivaPeriod !== b.ivaPeriod
    ? a.ivaPeriod < b.ivaPeriod
      ? -1
      : 1
    : a.tipo !== b.tipo
      ? a.tipo < b.tipo
        ? -1
        : 1
      : a.documentDate !== b.documentDate
        ? a.documentDate < b.documentDate
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0

/**
 * Resumen del periodo **efectivamente devengado y deducible**, que es lo que se
 * declara y lo que barre T-23.
 */
export type VatPeriodTotals = {
  /** Repercutido devengado + devengado por ISP/AIB + DUA con diferimiento. */
  outputCents: Cents
  /** Soportado deducible del periodo (sin el ajuste de prorrata, que va aparte). */
  inputCents: Cents
  /** IVA soportado NO deducible incorporado al coste (art. 103 LIVA): nunca toca 472. */
  nonDeductibleCents: Cents
  /** Cuota íntegra del libro de emitidas (RECC incluido): término de 15c′. */
  bookIssuedCents: Cents
  /** Cuota deducible del libro de recibidas (RECC incluido): término de 15a′. */
  bookReceivedCents: Cents
  /** Cuota del DUA con diferimiento: casilla 77. */
  importDeferredCents: Cents
}

export function vatPeriodTotals(book: readonly VatBookRowE9[], period: PeriodKey): VatPeriodTotals {
  const rows = inPeriod(book, period)
  const rec = received(rows)
  const iss = issued(rows)
  return {
    outputCents:
      sum(iss.map((r) => r.cuotaDevengadaEnPeriodoCents)) +
      sum(rec.map((r) => r.cuotaDevengadaIspAibCents)) +
      sum(rec.filter((r) => r.importDeferred).map((r) => r.cuotaTotalCents)),
    inputCents: sum(rec.map((r) => r.cuotaDeducibleEnPeriodoCents)),
    nonDeductibleCents: sum(rec.map((r) => r.cuotaNoDeducibleAlCosteCents)),
    bookIssuedCents: sum(iss.map((r) => r.cuotaRepercutidaCents)) + sum(rec.map((r) => r.cuotaDevengadaIspAibCents)),
    bookReceivedCents: sum(rec.map((r) => r.cuotaDeducibleCents)),
    importDeferredCents: sum(rec.filter((r) => r.importDeferred).map((r) => r.cuotaTotalCents)),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Los puentes al 303, reformulados (O-14): I-E8-15a′, I-E8-15c′, I-E9-8a′
// ─────────────────────────────────────────────────────────────────────────────

const check = (id: string, status: CheckStatus, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status, evidencia } : { id, status, evidencia, query }

const BRIDGE_QUERY = `
  -- 15a′/15c′: los saldos incluyen las cuentas de PENDIENTE de RECC (4728/4778)
  SELECT l.account_code, sum(l.debit_cents - l.credit_cents)
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE l.organization_id = $1 AND e.iva_period = $2
     AND l.account_code IN ($3 /*472*/, $4 /*4728*/, $5 /*477*/, $6 /*4778*/)
   GROUP BY 1`

/**
 * **I-E8-15a′** — `Σ 472 + Σ 4728 = Σ` cuota **deducible** del libro de
 * recibidas del periodo (**+** el ajuste de prorrata del art. 105, que se
 * postea contra `472` con el `ivaPeriod` del último periodo del año, O-11).
 *
 * Con el enunciado de E8 (`Σ 472` a secas) toda organización acogida a RECC
 * —y toda la de su cliente— daba **FAIL por diseño**.
 */
export function checkBridge15aPrime(
  book: readonly VatBookRowE9[],
  balances: readonly VatBalanceRowE9[],
  prorrataAdjustmentByPeriod: Readonly<Record<string, Cents>> = {}
): CheckResult {
  const periods = allPeriods(book, balances)
  const broken: string[] = []
  for (const period of periods) {
    const libro = vatPeriodTotals(book, period).bookReceivedCents + (prorrataAdjustmentByPeriod[period] ?? 0)
    const b = balanceOf(balances, period)
    const diario = b.saldo472Cents + b.saldo4728Cents
    if (diario !== libro) broken.push(`${period}: libro ${libro} vs diario 472+4728 ${diario} (diferencia ${diario - libro})`)
  }
  return broken.length === 0
    ? check("I-E8-15a′", "PASS", `${periods.length} periodo(s) con el IVA soportado deducible cuadrado a 0`, BRIDGE_QUERY)
    : check("I-E8-15a′", "FAIL", broken.slice(0, 20).join(" · "), BRIDGE_QUERY)
}

/**
 * **I-E8-15c′** — `Σ 477 + Σ 4778 = Σ` cuota repercutida del libro de emitidas
 * **+** la devengada por ISP/AIB de recibidas.
 */
export function checkBridge15cPrime(
  book: readonly VatBookRowE9[],
  balances: readonly VatBalanceRowE9[]
): CheckResult {
  const periods = allPeriods(book, balances)
  const broken: string[] = []
  for (const period of periods) {
    const totals = vatPeriodTotals(book, period)
    const libro = totals.bookIssuedCents + totals.importDeferredCents
    const b = balanceOf(balances, period)
    const diario = b.saldo477Cents + b.saldo4778Cents
    if (diario !== libro) broken.push(`${period}: libro ${libro} vs diario 477+4778 ${diario} (diferencia ${diario - libro})`)
  }
  return broken.length === 0
    ? check("I-E8-15c′", "PASS", `${periods.length} periodo(s) con el IVA repercutido y el devengado por ISP/AIB cuadrado a 0`, BRIDGE_QUERY)
    : check("I-E8-15c′", "FAIL", broken.slice(0, 20).join(" · "), BRIDGE_QUERY)
}

/**
 * **I-E9-8a′** — resultado del periodo = `Σ 477` efectivamente devengado −
 * `Σ 472` efectivamente deducible; **tras T-23, `472` y `477` del periodo quedan
 * en 0, pero `4728` y `4778` conservan saldo y no se barren**.
 */
export function checkIE98aPrime(
  book: readonly VatBookRowE9[],
  balances: readonly VatBalanceRowE9[],
  settled: readonly { period: PeriodKey; resultCents: Cents; carryForwardCents?: Cents; prorrataAdjustmentCents?: Cents }[]
): CheckResult {
  const failures: string[] = []
  for (const s of settled) {
    const b = balanceOf(balances, s.period)
    // Tras T-23, 472 y 477 del periodo quedan a cero; 4728/4778 NO se barren.
    if (b.saldo472Cents !== 0 || b.saldo477Cents !== 0) {
      failures.push(`${s.period}: tras T-23 quedan saldos 472=${b.saldo472Cents} y 477=${b.saldo477Cents}, deberían ser 0`)
    }
    const totals = vatPeriodTotals(book, s.period)
    const esperado =
      totals.outputCents - (totals.inputCents + (s.prorrataAdjustmentCents ?? 0)) - (s.carryForwardCents ?? 0)
    if (esperado !== s.resultCents) {
      failures.push(`${s.period}: resultado sellado ${s.resultCents} vs recomputado desde el libro ${esperado}`)
    }
  }
  return failures.length === 0
    ? check("I-E9-8a′", "PASS", `${settled.length} periodo(s) liquidado(s) con 472 y 477 a cero, 4728/4778 intactos y el resultado recomputado`)
    : check("I-E9-8a′", "FAIL", failures.slice(0, 20).join(" · "))
}

const allPeriods = (book: readonly VatBookRowE9[], balances: readonly VatBalanceRowE9[]): PeriodKey[] =>
  [...new Set([...book.map((r) => r.ivaPeriod), ...balances.map((b) => b.ivaPeriod)])].sort()

const balanceOf = (balances: readonly VatBalanceRowE9[], period: PeriodKey): VatBalanceRowE9 =>
  balances.find((b) => b.ivaPeriod === period) ?? {
    ivaPeriod: period,
    saldo472Cents: 0,
    saldo477Cents: 0,
    saldo4728Cents: 0,
    saldo4778Cents: 0,
  }

// ─────────────────────────────────────────────────────────────────────────────
// R-IVA-9/10 · la liquidación (T-23)
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que T-23 (`buildRegularizacionIva`) necesita. Estructuralmente igual a `RegularizacionIvaInput`. */
export type VatSettlementDraft = {
  periodStart: LocalDate
  periodEnd: LocalDate
  entryDate?: LocalDate
  outputCents: Cents
  inputCents: Cents
  carryForwardCents?: Cents
  description?: string
}

export type VatSettlementInput = {
  period: PeriodKey
  regime: IvaRegime
  book: readonly VatBookRowE9[]
  /** Saldos del diario del periodo: la verificación, nunca la fuente (R-IVA-9). */
  balance: VatBalanceRowE9
  /** Cuota a compensar de periodos anteriores (casilla 67). */
  carryForwardCents?: Cents
  /** Casilla 44, **con signo**, ya posteada contra `472` ANTES de T-23 (O-11). */
  prorrataAdjustmentCents?: Cents
  /**
   * **O-12.** La guardia de bienes de inversión ha salido FAIL: la liquidación
   * del último periodo del año **no se postea**.
   */
  capitalGoodsBlocking?: boolean
  entryDate?: LocalDate
  description?: string
}

/**
 * **R-IVA-9/10.** Liquidación del periodo **desde el libro registro**, con el
 * diario como verificación. Devuelve el input de **T-23**, que no se toca.
 */
export function vatSettlement(input: VatSettlementInput): Result<VatSettlementDraft> {
  const errors: LedgerError[] = []
  const { start, end } = vatPeriodBounds(input.period)
  const carryForward = input.carryForwardCents ?? 0
  const adjustment = input.prorrataAdjustmentCents ?? 0

  if (!isInt(carryForward) || carryForward < 0) {
    errors.push(err("TEMPLATE_INPUT", "carryForwardCents", "La cuota a compensar es un entero no negativo de céntimos"))
  }
  if (!isInt(adjustment)) {
    errors.push(err("TEMPLATE_INPUT", "prorrataAdjustmentCents", "El ajuste de prorrata es un entero de céntimos"))
  }
  if (input.capitalGoodsBlocking) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "capitalGoods",
        "Regularización de bienes de inversión pendiente (art. 107 LIVA): la liquidación del último periodo no se postea",
        { check: "R-IVA-16" }
      )
    )
  }

  const totals = vatPeriodTotals(input.book, input.period)
  const outputCents = totals.outputCents
  const inputCents = totals.inputCents + adjustment

  // ── R-IVA-9: el libro manda, y el diario tiene que decir lo mismo ─────────
  const libroDeducible = totals.bookReceivedCents + adjustment
  const diarioDeducible = input.balance.saldo472Cents + input.balance.saldo4728Cents
  const libroDevengado = totals.bookIssuedCents + totals.importDeferredCents
  const diarioDevengado = input.balance.saldo477Cents + input.balance.saldo4778Cents

  if (libroDeducible !== diarioDeducible || libroDevengado !== diarioDevengado) {
    errors.push(
      err(
        "DOCUMENT_TOTAL_MISMATCH",
        "vatBook",
        `El libro y el diario no dicen lo mismo en ${input.period}: soportado libro ${libroDeducible} vs diario ${diarioDeducible}; repercutido libro ${libroDevengado} vs diario ${diarioDevengado}. ` +
          documentByDocument(input),
        { check: "R-IVA-9" }
      )
    )
  }

  if (outputCents < 0 || inputCents < 0) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "outputCents",
        `Las rectificativas del periodo dejan un devengado ${outputCents} o un deducible ${inputCents} negativos: se declara a mano`
      )
    )
  }

  if (errors.length > 0) return fail<VatSettlementDraft>(...errors)

  const draft: VatSettlementDraft = {
    periodStart: start,
    periodEnd: end,
    outputCents,
    inputCents,
    ...(input.entryDate ? { entryDate: input.entryDate } : {}),
    ...(carryForward > 0 ? { carryForwardCents: carryForward } : {}),
    description:
      input.description ?? `Liquidación de IVA ${input.period} (modelo 303, régimen ${input.regime.toLowerCase()})`,
  }
  return ok(draft)
}

/** La diferencia libro↔diario, **documento a documento** (criterio 12 de §12). */
function documentByDocument(input: VatSettlementInput): string {
  const byEntry = input.balance.byEntry
  if (!byEntry || byEntry.length === 0) return "Sin desglose por asiento: no se puede señalar el documento."
  const rows = inPeriod(input.book, input.period)
  const diffs: string[] = []
  for (const b of byEntry) {
    const libro = rows.filter((r) => r.entryId === b.entryId)
    const libro472 = sum(libro.map((r) => (r.tipo === "RECIBIDAS" ? r.cuotaDeducibleCents : 0)))
    const libro477 =
      sum(libro.map((r) => (r.tipo === "EMITIDAS" ? r.cuotaRepercutidaCents : r.cuotaDevengadaIspAibCents)))
    if (libro472 !== b.saldo472Cents || libro477 !== b.saldo477Cents) {
      diffs.push(
        `asiento ${b.entryId}: 472 libro ${libro472} vs diario ${b.saldo472Cents}; 477 libro ${libro477} vs diario ${b.saldo477Cents}`
      )
    }
  }
  return diffs.length === 0 ? "Ningún asiento difiere: la diferencia está en un apunte sin documento detrás." : diffs.slice(0, 20).join(" · ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Prorrata (arts. 102 a 105): R-IVA-11…15, O-9, O-10, O-11
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-IVA-11.** `pct = ceil(numerador × 100 / denominador)` en aritmética
 * **entera**, `bps = pct × 100`: es un porcentaje **entero redondeado al alza**
 * (art. 104.Dos.2ª). `8 700 001 / 10 000 000` ⇒ 87,00001 % ⇒ **88 %**.
 *
 * Denominador 0 ⇒ el llamante decide (`prorrataTerms` devuelve `INFO`, nunca
 * 0 %): aquí se lanza porque un 0 % silencioso se declararía.
 */
export function prorrataDefinitivaBps(numeratorCents: Cents, denominatorCents: Cents): number {
  if (!isInt(numeratorCents) || !isInt(denominatorCents) || numeratorCents < 0 || denominatorCents < 0) {
    throw new TypeError("prorrataDefinitivaBps: numerador y denominador son céntimos enteros no negativos")
  }
  if (denominatorCents === 0) {
    throw new RangeError("prorrataDefinitivaBps: denominador 0; el resultado es INFO, nunca 0 % (R-IVA-11)")
  }
  const n = BigInt(numeratorCents) * BigInt(100)
  const d = BigInt(denominatorCents)
  const pct = Number((n + d - BigInt(1)) / d) // ceil entero, sin coma flotante
  return Math.min(pct, 100) * 100
}

export type ProrrataExclusion = {
  id: string
  operationKey: VatOperationKey
  baseCents: Cents
  motivo: string
}

export type ProrrataTerms = {
  year: number
  numeratorCents: Cents
  denominatorCents: Cents
  /** `null` mientras haya documentos sin clasificar o el denominador sea 0. */
  definitiveBps: number | null
  status: "OK" | "INFO"
  /** Documentos del año **sin clave de operación**: con alguno, nunca hay porcentaje. */
  unclassified: readonly { id: string; documentDate: LocalDate; baseCents: Cents }[]
  /** Exclusiones del art. 104.Tres, cada una con su motivo. */
  excluded: readonly ProrrataExclusion[]
  evidencia: string
}

const NUMERATOR_KEYS: readonly VatOperationKey[] = ["INTERIOR", "EXPORTACION", "EIB", "EXENTA_PLENA", "NO_SUJETA_ISP"]
const DENOMINATOR_ONLY_KEYS: readonly VatOperationKey[] = ["EXENTA_LIMITADA"]
const EXCLUDED_KEYS: Readonly<Record<string, string>> = {
  BIEN_INVERSION_USADO: "entrega de bien de inversión utilizado (art. 104.Tres.1º)",
  INMOBILIARIA_NO_HABITUAL: "operación inmobiliaria no habitual (art. 104.Tres.4º)",
  FINANCIERA_NO_HABITUAL: "operación financiera no habitual (art. 104.Tres.4º)",
  AUTOCONSUMO_9_1_C_D: "autoconsumo del art. 9.1º.c) y d) (art. 104.Tres.2º)",
  FUERA_TAI: "operación realizada fuera del TAI desde un establecimiento no situado en él (art. 104.Tres.5º)",
}

/**
 * **R-IVA-12 (O-10).** Numerador y denominador **derivados del libro de
 * emitidas** del año natural, en importes **sin IVA** (art. 104.Dos.1ª).
 *
 * Toda exclusión es una **clave marcada en el documento**; el motor no deduce
 * ninguna. Con documentos sin clasificar el resultado es `INFO` **con su
 * lista** y `definitiveBps = null`: nunca un porcentaje.
 */
export function prorrataTerms(book: readonly VatBookRowE9[], year: number): ProrrataTerms {
  const rows = issued(book)
    .filter((r) => vatPeriodYear(r.ivaPeriod) === year)
    .sort(byBookOrder)

  const unclassified = rows
    .filter((r) => r.operationKey === null)
    .map((r) => ({ id: r.id, documentDate: r.documentDate, baseCents: r.baseCents }))

  const excluded: ProrrataExclusion[] = rows
    .filter((r) => r.operationKey !== null && r.operationKey in EXCLUDED_KEYS)
    .map((r) => ({
      id: r.id,
      operationKey: r.operationKey as VatOperationKey,
      baseCents: r.baseCents,
      motivo: EXCLUDED_KEYS[r.operationKey as string],
    }))

  const numeratorCents = sum(
    rows.filter((r) => r.operationKey !== null && NUMERATOR_KEYS.includes(r.operationKey)).map((r) => r.baseCents)
  )
  const denominatorOnly = sum(
    rows.filter((r) => r.operationKey !== null && DENOMINATOR_ONLY_KEYS.includes(r.operationKey)).map((r) => r.baseCents)
  )
  const denominatorCents = numeratorCents + denominatorOnly

  if (unclassified.length > 0) {
    return {
      year,
      numeratorCents,
      denominatorCents,
      definitiveBps: null,
      status: "INFO",
      unclassified,
      excluded,
      evidencia: `${unclassified.length} documento(s) del ${year} sin clave de operación: no se calcula ningún porcentaje (O-10)`,
    }
  }
  if (denominatorCents === 0) {
    return {
      year,
      numeratorCents,
      denominatorCents,
      definitiveBps: null,
      status: "INFO",
      unclassified,
      excluded,
      evidencia: `Denominador 0 en ${year}: sin operaciones que prorratear, el porcentaje no se calcula (nunca 0 %)`,
    }
  }
  const definitiveBps = prorrataDefinitivaBps(numeratorCents, denominatorCents)
  return {
    year,
    numeratorCents,
    denominatorCents,
    definitiveBps,
    status: "OK",
    unclassified,
    excluded,
    evidencia: `Prorrata definitiva ${year}: ceil(${numeratorCents} × 100 / ${denominatorCents}) = ${definitiveBps / 100} % (art. 104.Dos.2ª), con ${excluded.length} exclusión(es) del art. 104.Tres`,
  }
}

/**
 * **O-9.** Base del ajuste: la **cuota soportada del año sometida a prorrata**.
 * Excluye las 100 % deducibles por afectación exclusiva (`FULL`), las no
 * deducibles por naturaleza (`NONE`, art. 96) y las de **bienes de inversión**
 * (art. 107, cuya regularización es otra y queda fechada para E10).
 */
export function prorrateableQuotaCents(book: readonly VatBookRowE9[], year: number): Cents {
  return sum(
    received(book)
      .filter((r) => vatPeriodYear(r.ivaPeriod) === year && r.deductibility === "PRORRATA" && !r.investmentGood)
      .map((r) => r.cuotaTotalCents)
  )
}

export type ProrrataRegularization = {
  adjustmentCents: Cents
  accountKey: "AJUSTE_PRORRATA_NEGATIVO" | "AJUSTE_PRORRATA_POSITIVO"
}

/**
 * **R-IVA-13/14 (O-9, Q-7).**
 * `ajuste = trunc(q × definitiva/10000) − trunc(q × provisional/10000)`.
 *
 * | Situación | Ajuste | Asiento | Casilla 44 |
 * |---|---|---|---|
 * | Definitiva > provisional | `> 0` | `472 (D) / 639 (H)` | positiva |
 * | Definitiva < provisional | `< 0` | `634 (D) / 472 (H)` | negativa |
 *
 * La contrapartida `472` **no es una elección**: la definición de la 634 en la
 * 3ª parte del PGC dice literalmente *con abono a la cuenta 472*, y la de la 639
 * *con cargo a la cuenta 472*.
 */
export function prorrataRegularization(input: {
  prorrateableQuotaCents: Cents
  provisionalBps: number
  definitiveBps: number
}): ProrrataRegularization {
  const { prorrateableQuotaCents: q, provisionalBps, definitiveBps } = input
  if (!isInt(q) || q < 0) throw new TypeError("prorrataRegularization: la cuota prorrateable es un entero no negativo")
  for (const bps of [provisionalBps, definitiveBps]) {
    if (!isInt(bps) || bps < 0 || bps > 10000) throw new TypeError(`prorrataRegularization: bps fuera de rango: ${bps}`)
  }
  const adjustmentCents = mulDivTrunc(q, definitiveBps, 10000) - mulDivTrunc(q, provisionalBps, 10000)
  return {
    adjustmentCents,
    accountKey: adjustmentCents >= 0 ? "AJUSTE_PRORRATA_POSITIVO" : "AJUSTE_PRORRATA_NEGATIVO",
  }
}

/**
 * Las dos líneas del asiento de regularización. La línea de `472` lleva el
 * `ivaPeriod` del **último periodo del año** (art. 105.Uno, O-11): quien la
 * postea la fecha dentro de ese periodo y **antes** de T-23.
 */
export function prorrataRegularizationLines(reg: ProrrataRegularization, year: number): DraftLine[] {
  const { adjustmentCents, accountKey } = reg
  if (adjustmentCents === 0) return []
  const amount = Math.abs(adjustmentCents)
  const descripcion = `Regularización de la prorrata definitiva ${year} (art. 105 LIVA)`
  return adjustmentCents > 0
    ? [
        { lineNo: 1, accountKey: "IVA_SOPORTADO", debitCents: amount, creditCents: 0, description: descripcion },
        { lineNo: 2, accountKey, debitCents: 0, creditCents: amount, description: descripcion },
      ]
    : [
        { lineNo: 1, accountKey, debitCents: amount, creditCents: 0, description: descripcion },
        { lineNo: 2, accountKey: "IVA_SOPORTADO", debitCents: 0, creditCents: amount, description: descripcion },
      ]
}

/** **R-IVA-15 (O-11).** La provisional de N+1 es la definitiva de N (art. 105.Dos). */
export const provisionalBpsForNextYear = (definitiveBps: number): number => definitiveBps

/**
 * **R-IVA-17.** Prorrata **especial** (art. 103.Dos) y **sectores diferenciados**
 * (art. 101) se **bloquean**, no se aproximan.
 */
export function prorrataSpecialGuard(input: { specialProrrata: boolean; differentiatedSectors: boolean }): ClosingStepResult {
  const razones: string[] = []
  if (input.specialProrrata) razones.push("prorrata especial (art. 103.Dos LIVA)")
  if (input.differentiatedSectors) razones.push("sectores diferenciados (art. 101 LIVA)")
  return razones.length === 0
    ? {
        step: "PRORRATA_DEFINITIVA",
        block: "Fiscal",
        status: "PASS",
        blocking: true,
        evidencia: "Prorrata general: ni prorrata especial ni sectores diferenciados",
      }
    : {
        step: "PRORRATA_DEFINITIVA",
        block: "Fiscal",
        status: "FAIL",
        blocking: true,
        evidencia: `El producto implementa prorrata GENERAL; ${razones.join(" y ")} quedan fuera de v1 y no se aproximan`,
        sealReason: "PRORRATA_NO_SOPORTADA",
      }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-IVA-16 (O-12) · guardia de bienes de inversión, art. 107
// ─────────────────────────────────────────────────────────────────────────────

/** Umbral del art. 108 LIVA: 3 005,06 € en céntimos. */
export const CAPITAL_GOODS_THRESHOLD_CENTS = 300_506
/** Diez puntos porcentuales en bps (art. 107.Uno). */
export const CAPITAL_GOODS_DEVIATION_BPS = 1000
/** Ventana de regularización: cuatro años; nueve para terrenos y edificaciones (art. 107.Tres). */
export const CAPITAL_GOODS_WINDOW_YEARS = 4
export const CAPITAL_GOODS_WINDOW_YEARS_REAL_ESTATE = 9

export type CapitalGoodRef = {
  id: string
  code: string
  /** Cuenta de grupo 2 del alta. */
  accountCode: string
  acquisitionYear: number
  costCents: Cents
  /** Terrenos y edificaciones: ventana de nueve años (art. 107.Tres). */
  realEstate: boolean
}

export type CapitalGoodsInput = {
  year: number
  /** Prorrata definitiva por año, en bps. Un año ausente es un año desconocido. */
  prorrataByYear: readonly { year: number; bps: number }[]
  assets: readonly CapitalGoodRef[]
}

/**
 * **R-IVA-16 (O-12).** Guardia determinista y **bloqueante**:
 *
 * ```
 * si  ∃ año Y ∈ ventana con prorrataBps(Y) ≠ 10000
 * y   ∃ alta de grupo 2 con coste ≥ 300 506 c en la ventana        // art. 108
 * y   |prorrataBps(N) − prorrataBps(año de alta)| > 1000           // art. 107.Uno
 * ⇒   PRORRATA_DEFINITIVA = FAIL, blocking = true
 *     sello REGULARIZACION_BIENES_INVERSION_PENDIENTE
 * ```
 *
 * Dejar el art. 107 para E10 es defendible **con** la guardia; sin ella, no: una
 * casilla vacía es honesta frente al usuario, no frente a la AEAT.
 */
export function capitalGoodsGuard(input: CapitalGoodsInput): ClosingStepResult {
  const bpsOf = (year: number): number | null => input.prorrataByYear.find((p) => p.year === year)?.bps ?? null
  const current = bpsOf(input.year)
  const step = "BIENES_DE_INVERSION"
  const block = "Fiscal"

  const inWindow = input.assets.filter((a) => {
    const span = a.realEstate ? CAPITAL_GOODS_WINDOW_YEARS_REAL_ESTATE : CAPITAL_GOODS_WINDOW_YEARS
    return a.acquisitionYear >= input.year - span && a.acquisitionYear <= input.year && a.costCents >= CAPITAL_GOODS_THRESHOLD_CENTS
  })

  if (inWindow.length === 0) {
    return {
      step,
      block,
      status: "PASS",
      blocking: true,
      evidencia: `Ningún bien de inversión del art. 108 (≥ ${CAPITAL_GOODS_THRESHOLD_CENTS} c) dado de alta en la ventana de regularización de ${input.year}`,
    }
  }

  const yearsWithProrrata = input.prorrataByYear.filter(
    (p) => p.year >= input.year - CAPITAL_GOODS_WINDOW_YEARS_REAL_ESTATE && p.year <= input.year && p.bps !== 10000
  )
  if (yearsWithProrrata.length === 0 && current !== null) {
    return {
      step,
      block,
      status: "PASS",
      blocking: true,
      evidencia: `${inWindow.length} bien(es) de inversión en ventana, pero la prorrata fue del 100 % en todos los años: no hay nada que regularizar (art. 107.Uno)`,
    }
  }

  const unknown = inWindow.filter((a) => bpsOf(a.acquisitionYear) === null)
  const breached = inWindow.filter((a) => {
    const at = bpsOf(a.acquisitionYear)
    return at !== null && current !== null && Math.abs(current - at) > CAPITAL_GOODS_DEVIATION_BPS
  })

  if (breached.length > 0) {
    const detalle = breached
      .map((a) => `${a.code} (${a.accountCode}, alta ${a.acquisitionYear}, coste ${a.costCents}, prorrata ${((bpsOf(a.acquisitionYear) ?? 0) / 100).toFixed(0)} % → ${((current ?? 0) / 100).toFixed(0)} %)`)
      .join(" · ")
    return {
      step,
      block,
      status: "FAIL",
      blocking: true,
      evidencia: `Regularización del art. 107 LIVA pendiente sobre ${breached.length} bien(es) de inversión: ${detalle}. La casilla 43 no se puede dejar vacía y la liquidación del último periodo no se postea`,
      sealReason: "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
    }
  }

  if (unknown.length > 0 || current === null) {
    return {
      step,
      block,
      status: "WARN",
      blocking: false,
      evidencia:
        current === null
          ? `No hay prorrata definitiva cerrada para ${input.year}: la desviación del art. 107 no se puede medir`
          : `Sin prorrata definitiva del año de alta de ${unknown.map((a) => a.code).join(", ")}: la desviación del art. 107 no se puede medir`,
      sealReason: "REGULARIZACION_BIENES_INVERSION_PENDIENTE",
    }
  }

  return {
    step,
    block,
    status: "PASS",
    blocking: true,
    evidencia: `${inWindow.length} bien(es) de inversión en ventana, ninguno con desviación de prorrata > 10 puntos (art. 107.Uno)`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-IVA-19 (O-14, O-15) · RECC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-15.** Devengo proporcional al importe cobrado:
 * `cuotaDevengada = trunc(cobro × cuotaTotal / totalFactura)`, con el **residuo
 * al último cobro** (misma convención que R-AM-2 y R-PE-2).
 *
 * *(ejemplo del experto: base 1 000 000, IVA 210 000, cobro 500 000 ⇒ **86 776**)*
 */
export function reccAccrualOnCollection(input: {
  collectedCents: Cents
  totalInvoiceCents: Cents
  totalQuotaCents: Cents
  alreadyAccruedCents: Cents
  isFinal: boolean
}): Cents {
  const { collectedCents, totalInvoiceCents, totalQuotaCents, alreadyAccruedCents, isFinal } = input
  if (!isInt(totalInvoiceCents) || totalInvoiceCents <= 0) {
    throw new TypeError("reccAccrualOnCollection: el total de la factura es un entero positivo")
  }
  for (const v of [collectedCents, totalQuotaCents, alreadyAccruedCents]) {
    if (!isInt(v) || v < 0) throw new TypeError("reccAccrualOnCollection: importes enteros no negativos")
  }
  if (isFinal) return totalQuotaCents - alreadyAccruedCents
  const quota = mulDivTrunc(collectedCents, totalQuotaCents, totalInvoiceCents)
  // Nunca se devenga más de lo que queda: un redondeo no puede pasarse.
  return Math.min(quota, totalQuotaCents - alreadyAccruedCents)
}

export type ReccPendingRef = {
  id: string
  /** `EMITIDA`: `4778 → 477`. `RECIBIDA`: `4728 → 472` (también el destinatario, D8.2). */
  side: "EMITIDA" | "RECIBIDA"
  documentNumber: string
  /** Fecha de la operación: fija el límite del art. 163 *terdecies*. */
  operationDate: LocalDate
  totalQuotaCents: Cents
  accruedCents: Cents
}

/**
 * **R-IVA-19 / D8.4 — el barrido del 31/12 es T-36, no un aviso.** El art. 163
 * *terdecies* fija el devengo en el cobro y, **en todo caso**, el **31 de
 * diciembre del año inmediato posterior** al de la operación. Se postea antes de
 * la última liquidación de ese periodo.
 *
 * Barre las facturas cuya operación es de `año(cutoff) − 1` o anterior y que
 * conservan cuota pendiente. Orden determinista: lado, fecha, número.
 */
export function reccYearEndSweep(pending: readonly ReccPendingRef[], cutoff: LocalDate): DraftLine[] {
  const limitYear = Number(cutoff.slice(0, 4)) - 1
  const due = pending
    .filter((p) => Number(p.operationDate.slice(0, 4)) <= limitYear && p.totalQuotaCents - p.accruedCents > 0)
    .sort((a, b) =>
      a.side !== b.side
        ? a.side < b.side
          ? -1
          : 1
        : a.operationDate !== b.operationDate
          ? a.operationDate < b.operationDate
            ? -1
            : 1
          : a.documentNumber < b.documentNumber
            ? -1
            : a.documentNumber > b.documentNumber
              ? 1
              : 0
    )

  const lines: DraftLine[] = []
  let lineNo = 1
  for (const p of due) {
    const amount = p.totalQuotaCents - p.accruedCents
    const descripcion = `Devengo RECC 31/12 · ${p.documentNumber} (art. 163 terdecies LIVA)`
    if (p.side === "EMITIDA") {
      lines.push({ lineNo: lineNo++, accountKey: "IVA_REPERCUTIDO_PENDIENTE_RECC", debitCents: amount, creditCents: 0, description: descripcion })
      lines.push({ lineNo: lineNo++, accountKey: "IVA_REPERCUTIDO", debitCents: 0, creditCents: amount, description: descripcion })
    } else {
      lines.push({ lineNo: lineNo++, accountKey: "IVA_SOPORTADO", debitCents: amount, creditCents: 0, description: descripcion })
      lines.push({ lineNo: lineNo++, accountKey: "IVA_SOPORTADO_PENDIENTE_RECC", debitCents: 0, creditCents: amount, description: descripcion })
    }
  }
  return lines
}

/** Las dos líneas del devengo al cobro: `4778 (D) / 477 (H)` por la cuota proporcional. */
export function reccCollectionLines(quotaCents: Cents, documentNumber: string): DraftLine[] {
  if (quotaCents <= 0) return []
  const descripcion = `Devengo RECC al cobro · ${documentNumber} (art. 163 terdecies LIVA)`
  return [
    { lineNo: 1, accountKey: "IVA_REPERCUTIDO_PENDIENTE_RECC", debitCents: quotaCents, creditCents: 0, description: descripcion },
    { lineNo: 2, accountKey: "IVA_REPERCUTIDO", debitCents: 0, creditCents: quotaCents, description: descripcion },
  ]
}

/**
 * **I-E9-26.** Al saldar la factura —o al llegar el 31/12 del año siguiente—,
 * `Σ cuotas devengadas = cuota total`. Es el CHECK que exige O-15.
 */
export function checkReccFullyAccrued(pending: readonly ReccPendingRef[], cutoff: LocalDate): CheckResult {
  const limitYear = Number(cutoff.slice(0, 4)) - 1
  const failures = pending
    .filter((p) => Number(p.operationDate.slice(0, 4)) <= limitYear && p.accruedCents !== p.totalQuotaCents)
    .map((p) => `${p.documentNumber} (${p.operationDate}): devengado ${p.accruedCents} de ${p.totalQuotaCents}`)
  return failures.length === 0
    ? check("I-E9-26", "PASS", `${pending.length} factura(s) RECC; ninguna del año anterior queda sin devengar a ${cutoff}`)
    : check("I-E9-26", "FAIL", failures.slice(0, 20).join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// R-IVA-18 (O-16) · DUA de importación, con y sin diferimiento
// ─────────────────────────────────────────────────────────────────────────────

export type DuaInput = {
  /** Base del **DUA**: valor en aduana + aranceles + gastos hasta el primer destino (art. 83.Uno). */
  customsValueCents: Cents
  /** Derechos arancelarios: **mayor coste** (NRV 10ª.1 y 2ª.1), nunca gasto financiero. */
  dutiesCents: Cents
  vatQuotaCents: Cents
  /** `VatRegimePeriod.importDeferral`, sólo con periodo MENSUAL. */
  importDeferral: boolean
  periodKind: VatPeriodKind
  investmentGood: boolean
}

export type DuaVatEffect = {
  /** Base que se declara: la del DUA, **no** la de la factura del proveedor. */
  taxableBaseCents: Cents
  /** Cuota devengada (casilla 77). 0 sin diferimiento: se ingresa en la Aduana. */
  accruedCents: Cents
  deductibleCents: Cents
  /** Casillas de la cuota deducible: 32-33 corrientes, 34-35 de inversión. */
  boxes: { base: string; quota: string; deferred: string | null }
  /** Con diferimiento el DUA **sí** genera `477` (art. 167.Dos LIVA). */
  generatesOutputVat: boolean
}

/**
 * **R-IVA-18 (O-16).** Contabilizar el DUA sin devengo en una organización con
 * diferimiento produce una autoliquidación con **menos cuota devengada de la
 * debida**. La base es la del DUA; los aranceles son mayor coste.
 */
export function duaVatEffect(input: DuaInput): Result<DuaVatEffect> {
  const errors: LedgerError[] = []
  for (const [field, v] of [
    ["customsValueCents", input.customsValueCents],
    ["dutiesCents", input.dutiesCents],
    ["vatQuotaCents", input.vatQuotaCents],
  ] as const) {
    if (!isInt(v) || v < 0) errors.push(err("TEMPLATE_INPUT", field, `${field} es un entero no negativo de céntimos`))
  }
  if (input.importDeferral && input.periodKind !== "MENSUAL") {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "importDeferral",
        "El diferimiento del ingreso del IVA a la importación exige periodo MENSUAL (art. 74.1 RIVA)",
        { check: "R-IVA-18" }
      )
    )
  }
  if (errors.length > 0) return fail<DuaVatEffect>(...errors)

  return ok({
    taxableBaseCents: input.customsValueCents,
    accruedCents: input.importDeferral ? input.vatQuotaCents : 0,
    deductibleCents: input.vatQuotaCents,
    boxes: input.investmentGood
      ? { base: "34", quota: "35", deferred: input.importDeferral ? "77" : null }
      : { base: "32", quota: "33", deferred: input.importDeferral ? "77" : null },
    generatesOutputVat: input.importDeferral,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// D12 (O-27) · retenciones: 4751 por modelo, 111 y 115
// ─────────────────────────────────────────────────────────────────────────────

export type WithholdingModel = "111" | "115" | "123"

/**
 * **D12 (O-27).** `4751` se parte por modelo y se resuelve **por `AccountKey`,
 * nunca por códigos escritos**: con una sola cuenta, el puente I-E8-17 no puede
 * repartir el saldo y `RETENCIONES_LIQUIDADAS` no es verificable.
 */
export function withholdingAccountKey(model: WithholdingModel): AccountKey {
  switch (model) {
    case "111":
      return "IRPF_A_PAGAR_111"
    case "115":
      return "IRPF_A_PAGAR_115"
    case "123":
      return "IRPF_A_PAGAR_123"
  }
}

export type WithholdingBookRow = {
  id: string
  period: PeriodKey
  model: WithholdingModel
  /** Retención practicada según el documento. */
  practicadoCents: Cents
  /** Abonos a la subcuenta del modelo, según el diario. */
  abonadoCents: Cents
}

export type WithholdingSettlement = {
  period: PeriodKey
  model: WithholdingModel
  accountKey: AccountKey
  amountCents: Cents
  lines: DraftLine[]
}

/**
 * Liquidación de retenciones del periodo, **por modelo**: `4751-<modelo> (D) /
 * 572 (H)`. El importe sale del diario (lo abonado), y el puente con lo
 * practicado es I-E8-17, que ahora sí puede repartirlo.
 */
export function withholdingSettlement(rows: readonly WithholdingBookRow[], period: PeriodKey): WithholdingSettlement[] {
  const models: WithholdingModel[] = ["111", "115", "123"]
  const out: WithholdingSettlement[] = []
  for (const model of models) {
    const amountCents = sum(rows.filter((r) => r.period === period && r.model === model).map((r) => r.abonadoCents))
    if (amountCents === 0) continue
    const accountKey = withholdingAccountKey(model)
    const descripcion = `Liquidación del modelo ${model} · ${period}`
    out.push({
      period,
      model,
      accountKey,
      amountCents,
      lines: [
        { lineNo: 1, accountKey, debitCents: amountCents, creditCents: 0, description: descripcion },
        { lineNo: 2, accountKey: "BANCO_DEFAULT", debitCents: 0, creditCents: amountCents, description: descripcion },
      ],
    })
  }
  return out
}

/** Puente por modelo: lo practicado = lo abonado a su subcuenta de `4751` (I-E8-17 con D12). */
export function checkWithholdingByModel(rows: readonly WithholdingBookRow[]): CheckResult {
  const failures = rows
    .filter((r) => r.practicadoCents !== r.abonadoCents)
    .map((r) => `${r.period} modelo ${r.model}: practicado ${r.practicadoCents} vs abonado ${r.abonadoCents}`)
  return failures.length === 0
    ? check("I-E8-17/D12", "PASS", `${rows.length} periodo(s)/modelo(s) con la retención practicada = la abonada a su subcuenta de 4751`)
    : check("I-E8-17/D12", "FAIL", failures.slice(0, 20).join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// O-13 · las casillas del 303, vista derivada con fórmula y origen
// ─────────────────────────────────────────────────────────────────────────────

export type Model303Input = {
  period: PeriodKey
  book: readonly VatBookRowE9[]
  regime: IvaRegime
  importDeferral: boolean
  /** Casilla 67. */
  carryForwardCents?: Cents
  /** Casilla 70: resultado de la autoliquidación anterior del mismo periodo. */
  previousDeclarationCents?: Cents
  /** Casilla 65: 100 salvo régimen foral. */
  statePct?: number
  /** Casilla 44, con signo (O-9). */
  prorrataAdjustmentCents?: Cents
  /** Motivo de la casilla 43 vacía (O-12). */
  capitalGoodsReason?: string
  /** Fecha con la que se elige la versión del mapa. Por defecto, fin del periodo. */
  mapDate?: LocalDate
}

export type Model303Cell = Model303Box & {
  /** Céntimos, salvo `PORCENTAJE` (puntos porcentuales enteros). */
  value: Cents
  /** De dónde sale ESTA cifra, en una línea. */
  provenance: string
}

export type Model303View = {
  period: PeriodKey
  mapVersion: string
  cells: readonly Model303Cell[]
  /** Casillas declaradas no ofrecidas, con su motivo, para enseñarlas. */
  notOffered: readonly Model303Box[]
  /** Casilla 71: el importe del asiento T-23. */
  resultCents: Cents
}

const RATE_BOXES: readonly { bps: number; base: string; rate: string; quota: string }[] = [
  { bps: 400, base: "01", rate: "02", quota: "03" },
  { bps: 1000, base: "04", rate: "05", quota: "06" },
  { bps: 2100, base: "07", rate: "08", quota: "09" },
]

/**
 * **O-13.** La vista derivada del 303, casilla a casilla, con su fórmula, su
 * origen y su procedencia. No se almacena: una rectificativa posterior dejaría
 * mintiendo a las cifras guardadas (§3.6).
 */
export function casillas303(input: Model303Input): Model303View {
  const rows = inPeriod(input.book, input.period).sort(byBookOrder)
  const iss = issued(rows)
  const rec = received(rows)
  const bounds = vatPeriodBounds(input.period)
  const map: Model303Map = model303MapAt(input.mapDate ?? bounds.end)
  const values = new Map<string, Cents>()
  const provenance = new Map<string, string>()

  const put = (id: string, value: Cents, why: string): void => {
    values.set(id, value)
    provenance.set(id, why)
  }
  const v = (id: string): Cents => values.get(id) ?? 0

  const facturas = (rs: VatBookRowE9[]): VatBookRowE9[] => rs.filter((r) => r.docKind !== "RECTIFICATIVA")
  const rectificativas = (rs: VatBookRowE9[]): VatBookRowE9[] => rs.filter((r) => r.docKind === "RECTIFICATIVA")
  const key = (r: VatBookRowE9, ...keys: VatOperationKey[]): boolean =>
    r.operationKey !== null && keys.includes(r.operationKey)

  // ── Devengado, régimen general (01-09) ───────────────────────────────────
  for (const rb of RATE_BOXES) {
    const hits = facturas(iss).filter((r) => r.rateBps === rb.bps)
    put(rb.base, sum(hits.map((r) => r.baseEnPeriodoCents)), `${hits.length} factura(s) emitida(s) al ${rb.bps / 100} %`)
    put(rb.rate, rb.bps / 100, `tipo vigente ${rb.bps / 100} %`)
    put(rb.quota, sum(hits.map((r) => r.cuotaDevengadaEnPeriodoCents)), `cuota devengada en el periodo al ${rb.bps / 100} %`)
  }

  // ── Autorrepercusión y modificación de bases (10-15) ─────────────────────
  const aib = rec.filter((r) => key(r, "AIB"))
  const isp = rec.filter((r) => key(r, "ISP"))
  put("10", sum(aib.map((r) => r.baseEnPeriodoCents)), `${aib.length} adquisición(es) intracomunitaria(s)`)
  put("11", sum(aib.map((r) => r.cuotaDevengadaIspAibCents)), "cuota devengada por AIB")
  put("12", sum(isp.map((r) => r.baseEnPeriodoCents)), `${isp.length} operación(es) con inversión del sujeto pasivo`)
  put("13", sum(isp.map((r) => r.cuotaDevengadaIspAibCents)), "cuota devengada por ISP")
  const rectVenta = rectificativas(iss)
  put("14", sum(rectVenta.map((r) => r.baseEnPeriodoCents)), `${rectVenta.length} rectificativa(s) de venta`)
  put("15", sum(rectVenta.map((r) => r.cuotaDevengadaEnPeriodoCents)), "cuota de las rectificativas de venta")

  put("27", v("03") + v("06") + v("09") + v("11") + v("13") + v("15"), "03+06+09+11+13+15")

  // ── Deducible (28-41) ────────────────────────────────────────────────────
  const interiores = facturas(rec).filter((r) => key(r, "INTERIOR", "ISP"))
  const corrientes = interiores.filter((r) => !r.investmentGood)
  const inversion = interiores.filter((r) => r.investmentGood)
  put("28", sum(corrientes.map((r) => r.baseEnPeriodoCents)), `${corrientes.length} recibida(s) interior(es) corriente(s)`)
  put("29", sum(corrientes.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible del periodo (incluye la soportada por ISP)")
  put("30", sum(inversion.map((r) => r.baseEnPeriodoCents)), `${inversion.length} recibida(s) de bienes de inversión`)
  put("31", sum(inversion.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible de bienes de inversión")

  const duas = rec.filter((r) => r.docKind === "DUA_IMPORTACION")
  const duaCorriente = duas.filter((r) => !r.investmentGood)
  const duaInversion = duas.filter((r) => r.investmentGood)
  put("32", sum(duaCorriente.map((r) => r.baseEnPeriodoCents)), `${duaCorriente.length} DUA de bienes corrientes (base del DUA)`)
  put("33", sum(duaCorriente.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible de importaciones corrientes")
  put("34", sum(duaInversion.map((r) => r.baseEnPeriodoCents)), `${duaInversion.length} DUA de bienes de inversión`)
  put("35", sum(duaInversion.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible de importaciones de inversión")

  const aibCorriente = aib.filter((r) => !r.investmentGood)
  const aibInversion = aib.filter((r) => r.investmentGood)
  put("36", sum(aibCorriente.map((r) => r.baseEnPeriodoCents)), `${aibCorriente.length} AIB corriente(s)`)
  put("37", sum(aibCorriente.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible de AIB corrientes")
  put("38", sum(aibInversion.map((r) => r.baseEnPeriodoCents)), `${aibInversion.length} AIB de bienes de inversión`)
  put("39", sum(aibInversion.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota deducible de AIB de inversión")

  const rectCompra = rectificativas(rec)
  put("40", sum(rectCompra.map((r) => r.baseEnPeriodoCents)), `${rectCompra.length} rectificativa(s) de compra`)
  put("41", sum(rectCompra.map((r) => r.cuotaDeducibleEnPeriodoCents)), "cuota de las rectificativas de compra")

  put("43", 0, input.capitalGoodsReason ?? "Art. 107 LIVA fuera de v1: casilla vacía bajo la guardia de R-IVA-16 (O-12)")
  put("44", input.prorrataAdjustmentCents ?? 0, "ajuste de la prorrata definitiva, con signo (O-9)")
  put("45", v("29") + v("31") + v("33") + v("35") + v("37") + v("39") + v("41") + v("43") + v("44"), "29+31+33+35+37+39+41+43+44")
  put("46", v("27") - v("45"), "27 − 45")

  // ── Informativas (59-61) ─────────────────────────────────────────────────
  const eib = iss.filter((r) => key(r, "EIB"))
  const expo = iss.filter((r) => key(r, "EXPORTACION"))
  const noSujetas = iss.filter((r) => key(r, "NO_SUJETA_ISP", "EXENTA_PLENA"))
  put("59", sum(eib.map((r) => r.baseCents)), `${eib.length} entrega(s) intracomunitaria(s) exenta(s) (art. 25)`)
  put("60", sum(expo.map((r) => r.baseCents)), `${expo.length} exportación(es) y asimiladas`)
  put("61", sum(noSujetas.map((r) => r.baseCents)), `${noSujetas.length} operación(es) no sujeta(s) o con ISP con derecho a deducción`)

  // ── RECC (62/63 y 74/75), sólo con el régimen activo ─────────────────────
  const reccActive = input.regime === "RECC"
  const reccIss = iss.filter((r) => r.recc)
  const reccRec = rec.filter((r) => r.recc)
  put("62", reccActive ? sum(reccIss.map((r) => r.baseCents)) : 0, "base de las entregas RECC por su devengo del art. 75")
  put("63", reccActive ? sum(reccIss.map((r) => r.cuotaRepercutidaCents)) : 0, "cuota íntegra de las entregas RECC")
  put("74", reccActive ? sum(reccRec.map((r) => r.baseCents)) : 0, "base de las adquisiciones bajo el art. 163 terdecies")
  put("75", reccActive ? sum(reccRec.map((r) => r.cuotaDeducibleCents)) : 0, "cuota íntegra de las adquisiciones RECC")

  // ── Cadena hasta el resultado (64-71, con 77 en medio) ───────────────────
  const statePct = input.statePct ?? 100
  const deferred = input.importDeferral ? sum(rec.filter((r) => r.importDeferred).map((r) => r.cuotaTotalCents)) : 0
  put("64", v("46"), "46 + 58 (el régimen simplificado no se ofrece)")
  put("65", statePct, statePct === 100 ? "100 % (territorio común)" : `${statePct} % atribuible al Estado (régimen foral)`)
  put("66", mulDivTrunc(v("64"), statePct, 100), "trunc(64 × 65 / 100)")
  put("77", deferred, input.importDeferral ? "cuota del DUA con diferimiento del ingreso (art. 167.Dos LIVA)" : "sin diferimiento: la cuota se ingresa en la Aduana")
  put("67", input.carryForwardCents ?? 0, "cuotas a compensar de periodos anteriores")
  put("69", v("66") + v("77") - v("67"), "66 + 77 − 67 + 68 (68 no se ofrece)")
  put("70", input.previousDeclarationCents ?? 0, "resultado de la autoliquidación anterior del mismo periodo")
  put("71", v("69") - v("70"), "69 − 70 · importe del asiento T-23")

  const cells: Model303Cell[] = offeredBoxes(map)
    .filter((b) => (b.requires === "RECC" ? reccActive : b.requires === "IMPORT_DEFERRAL" ? input.importDeferral : true))
    .map((b) => ({ ...b, value: v(b.box), provenance: provenance.get(b.box) ?? "—" }))

  return {
    period: input.period,
    mapVersion: map.version,
    cells,
    notOffered: map.boxes.filter((b) => !b.offered),
    resultCents: v("71"),
  }
}

/**
 * **Criterio 16 de §12** — `casilla 71 = importe del asiento T-23`. La identidad
 * sólo es cierta una vez existen 64, 66, 67, 69 y 70; con el mapa de la ronda 0
 * este invariante **no se podía escribir**.
 */
export function checkBox71EqualsSettlement(view: Model303View, settlement: VatSettlementDraft): CheckResult {
  const t23 = settlement.outputCents - settlement.inputCents - (settlement.carryForwardCents ?? 0)
  // La casilla 70 (declaración anterior del mismo periodo) no toca el asiento:
  // el diario ya recogió aquella liquidación, así que se suma para comparar.
  const box70 = view.cells.find((c) => c.box === "70")?.value ?? 0
  const esperado = t23 - box70
  return view.resultCents === esperado
    ? check("I-E9-22a", "PASS", `Casilla 71 = ${view.resultCents} = importe del asiento T-23 de ${view.period} (menos la casilla 70)`)
    : check("I-E9-22a", "FAIL", `Casilla 71 = ${view.resultCents} pero el asiento T-23 de ${view.period} vale ${t23} (casilla 70 = ${box70})`)
}
