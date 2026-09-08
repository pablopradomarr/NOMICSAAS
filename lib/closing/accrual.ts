/**
 * E9 · T7 — Cuadro de periodificaciones (`lib/closing/accrual.ts`).
 *
 * Implementa **R-PE-1…6** de `docs/design/E9-cierre-recurrentes.md` §4.3 y la
 * decisión **D3** de ADR-0016 (precisada por O-22 y O-25).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM.
 *
 * ## Las cuatro cuentas, y por qué no son dos
 *
 * | Clase | Cuenta | Contrapartida | Tipo analítico |
 * |---|---|---|---|
 * | `GASTO_ANTICIPADO` | `480` | `6xx` | el del gasto |
 * | `INGRESO_ANTICIPADO` | `485` | `7xx` | el del ingreso |
 * | `INTERESES_PAGADOS_ANTICIPADO` | `567` | `662` | **FINANCIERO**, nivel BAI |
 * | `INTERESES_COBRADOS_ANTICIPADO` | `568` | `762` | **FINANCIERO**, nivel BAI |
 *
 * **R-PE-5**: 480/485 son comerciales y 567/568 financieras. Tratarlas igual
 * movería el EBITDA, que es exactamente la cifra que un comité mira primero.
 * `438` y `407` **no** son periodificaciones: son anticipos con IVA devengado
 * (E3 §3.3) y no entran aquí.
 *
 * ## ACT/ACT y no 30/360
 *
 * **R-PE-1 (Q-6)**: días naturales, **ambos extremos incluidos**. No hay norma
 * contable que imponga 30/360 —es un convenio financiero— y el devengo se mide
 * por el tiempo real de prestación. Una prima del 15-11-2026 al 14-11-2027 cubre
 * **365** días, no 364.
 *
 * ## El WARN de 567/568 (R-PE-6, O-25)
 *
 * Los intereses se devengan por **tipo de interés efectivo** sobre el coste
 * amortizado (NRV 9ª.2.2 y 9ª.3.1). Con principal constante y horizonte ≤ 12
 * meses el lineal por días es admisible por inmaterialidad; con principal
 * **decreciente** el devengo lo aporta el cuadro del préstamo
 * (`basis = TIPO_EFECTIVO` sobre un `DebtSchedule`). Mientras no lo haya,
 * `basis = DIAS` sobre 567/568 emite **WARN** con la desviación estimada: no se
 * bloquea el cierre por una aproximación, pero tampoco se calla.
 */

import { createHash } from "node:crypto"

import type { Cents, DraftLine, LocalDate, Result } from "@/lib/ledger/types"
import { err, fail, ok } from "@/lib/ledger/types"
import {
  canonicalJson,
  daysInclusive,
  periodBounds,
  periodIndex,
  periodKeyFromIndex,
  periodKeyOf,
  type PeriodKey,
  type RecurrenceFreq,
} from "@/lib/recurring/schedule"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos (mismos literales que los enums del esquema; sin Prisma)
// ─────────────────────────────────────────────────────────────────────────────

export type AccrualKind =
  | "GASTO_ANTICIPADO"
  | "INGRESO_ANTICIPADO"
  | "INTERESES_PAGADOS_ANTICIPADO"
  | "INTERESES_COBRADOS_ANTICIPADO"
export type AccrualBasis = "DIAS" | "MESES" | "TIPO_EFECTIVO"
export type AccrualStatus = "VIVA" | "AGOTADA" | "CANCELADA"

/** Cuota del cuadro de una deuda (`DebtInstallment`), ya sellada por su contrato. */
export type DebtInstallmentRef = { seq: number; dueDate: LocalDate; principalCents: Cents; interestCents: Cents }

export type AccrualRef = {
  id: string
  code: string
  name?: string
  kind: AccrualKind
  accrualAccountCode: string
  pnlAccountCode: string
  totalCents: Cents
  periodStart: LocalDate
  periodEnd: LocalDate
  basis: AccrualBasis
  /** Obligatorio con `basis = TIPO_EFECTIVO` (R-PE-6). */
  debtInstallments?: readonly DebtInstallmentRef[]
  /** R-PE-4: cancelación anticipada; el pendiente se devenga en este periodo. */
  cancelledAtPeriod?: PeriodKey | null
  projectId?: string | null
  costCenterId?: string | null
}

export type AccrualRow = {
  period: PeriodKey
  from: LocalDate
  to: LocalDate
  /** Días naturales del periodo dentro de `[periodStart, periodEnd]`, ACT/ACT. */
  days: number
  quotaCents: Cents
  /** Lo que queda por devengar tras esta fila. La última deja **0 exacto**. */
  pendingCents: Cents
}

export type AccrualWarning = {
  code:
    | "DIAS_SOBRE_INTERESES"
    | "SIN_CUADRO_DE_DEUDA"
    | "CUADRO_NO_CUBRE_EL_INTERVALO"
    | "CUOTA_CERO"
    | "CANCELACION_ANTICIPADA"
  severity: "WARN" | "ERROR"
  message: string
  /** Desviación estimada frente al devengo por tipo efectivo, si es computable. */
  deviationCents?: Cents
}

const INTEREST_KINDS: readonly AccrualKind[] = ["INTERESES_PAGADOS_ANTICIPADO", "INTERESES_COBRADOS_ANTICIPADO"]

export const isInterestAccrual = (kind: AccrualKind): boolean => INTEREST_KINDS.includes(kind)

// ─────────────────────────────────────────────────────────────────────────────
// El cuadro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-PE-1…6.** Cuadro de devengo de la periodificación, periodo a periodo de la
 * frecuencia pedida.
 *
 *  - `MESES`: pesos iguales entre los periodos del intervalo.
 *  - `DIAS`: **ACT/ACT**, días naturales del periodo dentro de
 *    `[periodStart, periodEnd]`, ambos extremos incluidos.
 *  - `TIPO_EFECTIVO`: la cuota la aporta el cuadro del préstamo (suma de los
 *    intereses de los vencimientos que caen en el periodo).
 *
 * **R-PE-2**: reparto entero con `trunc` y **residuo a la última fila**, de modo
 * que la cuenta de periodificación queda en **0 exacto**. Una fila con cuota 0
 * no genera asiento (**R-REC-8**); el importe no se pierde porque el residuo va
 * a la última fila, y la omisión queda a la vista con motivo `CUOTA_CERO`.
 */
export function accrualSchedule(
  accrual: AccrualRef,
  freq: RecurrenceFreq
): { rows: AccrualRow[]; warnings: AccrualWarning[] } {
  const warnings: AccrualWarning[] = []
  if (!Number.isSafeInteger(accrual.totalCents) || accrual.totalCents < 0) {
    throw new TypeError(`importe total inválido en la periodificación ${accrual.code}: ${String(accrual.totalCents)}`)
  }
  if (accrual.periodEnd < accrual.periodStart) {
    throw new TypeError(`intervalo invertido en la periodificación ${accrual.code}`)
  }

  const firstIndex = periodIndex(periodKeyOf(accrual.periodStart, freq), freq)
  const lastIndex = periodIndex(periodKeyOf(accrual.periodEnd, freq), freq)
  const cancelIndex = accrual.cancelledAtPeriod ? periodIndex(accrual.cancelledAtPeriod, freq) : null
  const endIndex = cancelIndex !== null && cancelIndex < lastIndex ? cancelIndex : lastIndex

  // El reparto se calcula SIEMPRE sobre el intervalo COMPLETO y sólo después se
  // recorta en la cancelación (R-PE-4): si se repartiera sobre el intervalo ya
  // recortado, las cuotas de los periodos anteriores cambiarían y dejarían de
  // explicar los asientos que ya se posearon.
  type Slot = { key: PeriodKey; from: LocalDate; to: LocalDate; days: number }
  const slots: Slot[] = []
  for (let i = firstIndex; i <= lastIndex; i++) {
    const key = periodKeyFromIndex(i, freq)
    const bounds = periodBounds(key, freq)
    const from = bounds.start < accrual.periodStart ? accrual.periodStart : bounds.start
    const to = bounds.end > accrual.periodEnd ? accrual.periodEnd : bounds.end
    slots.push({ key, from, to, days: daysInclusive(from, to) })
  }
  if (slots.length === 0) return { rows: [], warnings }

  const totalDays = daysInclusive(accrual.periodStart, accrual.periodEnd)
  let quotas: Cents[]

  if (accrual.basis === "TIPO_EFECTIVO") {
    const installments = accrual.debtInstallments ?? []
    if (installments.length === 0) {
      warnings.push({
        code: "SIN_CUADRO_DE_DEUDA",
        severity: "ERROR",
        message:
          `${accrual.code} declara basis = TIPO_EFECTIVO y no aporta el cuadro de la deuda: el devengo por tipo ` +
          "efectivo lo dicta el cuadro del préstamo (R-PE-6), no un reparto lineal.",
      })
      return { rows: [], warnings }
    }
    quotas = slots.map((s) =>
      installments
        .filter((inst) => inst.dueDate >= s.from && inst.dueDate <= s.to)
        .reduce((acc, inst) => acc + inst.interestCents, 0)
    )
    const covered = quotas.reduce((a, b) => a + b, 0)
    if (covered !== accrual.totalCents) {
      warnings.push({
        code: "CUADRO_NO_CUBRE_EL_INTERVALO",
        severity: "WARN",
        message:
          `El cuadro de la deuda devenga ${covered} céntimos en [${accrual.periodStart}, ${accrual.periodEnd}] y la ` +
          `periodificación declara ${accrual.totalCents}: manda el cuadro.`,
        deviationCents: accrual.totalCents - covered,
      })
    }
  } else {
    // R-PE-2: trunc por peso y residuo a la ÚLTIMA fila. Nunca `hamilton()`:
    // el mayor resto adelantaría céntimos a los primeros periodos y la última
    // fila dejaría de ser la que cuadra.
    const weights = accrual.basis === "DIAS" ? slots.map((s) => s.days) : slots.map(() => 1)
    const weightSum = weights.reduce((a, b) => a + b, 0)
    const denominator = accrual.basis === "DIAS" ? totalDays : weightSum
    quotas = weights.map((w) => (denominator > 0 ? Math.trunc((accrual.totalCents * w) / denominator) : 0))
    const assigned = quotas.reduce((a, b) => a + b, 0)
    quotas[quotas.length - 1] += accrual.totalCents - assigned
  }

  // R-PE-4: cancelar antes de tiempo devenga el pendiente EN el periodo de la
  // cancelación, con motivo. Nunca se borra.
  let keptSlots = slots
  if (endIndex < lastIndex) {
    const keep = endIndex - firstIndex + 1
    keptSlots = slots.slice(0, keep)
    const kept = quotas.slice(0, keep)
    const remaining = accrual.totalCents - kept.reduce((a, b) => a + b, 0)
    quotas = kept
    if (remaining !== 0) {
      quotas[quotas.length - 1] += remaining
      warnings.push({
        code: "CANCELACION_ANTICIPADA",
        severity: "WARN",
        message:
          `${accrual.code} se cancela en ${accrual.cancelledAtPeriod}: se devengan ${remaining} céntimos pendientes ` +
          "en ese periodo (R-PE-4).",
        deviationCents: remaining,
      })
    }
  }

  let pending = accrual.totalCents
  const rows: AccrualRow[] = keptSlots.map((s, i) => {
    pending -= quotas[i]
    return { period: s.key, from: s.from, to: s.to, days: s.days, quotaCents: quotas[i], pendingCents: pending }
  })

  if (rows.some((r) => r.quotaCents === 0)) {
    warnings.push({
      code: "CUOTA_CERO",
      severity: "WARN",
      message:
        `${accrual.code} tiene ${rows.filter((r) => r.quotaCents === 0).length} periodo(s) con cuota 0: no generan ` +
        "asiento (R-REC-8/O-22) y la ocurrencia queda OMITIDA con motivo CUOTA_CERO.",
    })
  }

  // R-PE-6 (O-25): el WARN de 567/568 por días.
  if (isInterestAccrual(accrual.kind) && accrual.basis === "DIAS") {
    const decreasing = hasDecreasingPrincipal(accrual.debtInstallments)
    if (decreasing || totalDays > 366) {
      warnings.push({
        code: "DIAS_SOBRE_INTERESES",
        severity: "WARN",
        message:
          `${accrual.code} devenga intereses (${accrual.kind}) por reparto lineal de días sobre un horizonte de ` +
          `${totalDays} días${decreasing ? " y principal decreciente" : ""}. Los intereses se devengan por tipo de ` +
          "interés efectivo sobre el coste amortizado (NRV 9ª.2.2 y 9ª.3.1): use basis = TIPO_EFECTIVO con el cuadro " +
          "del préstamo.",
        deviationCents: linearVsEffectiveDeviation(rows, accrual.debtInstallments),
      })
    }
  }

  return { rows, warnings }
}

function hasDecreasingPrincipal(installments?: readonly DebtInstallmentRef[]): boolean {
  if (!installments || installments.length < 2) return false
  const ordered = [...installments].sort((a, b) => a.seq - b.seq)
  return ordered.some((inst, i) => i > 0 && inst.interestCents < ordered[i - 1].interestCents)
}

/**
 * Desviación máxima acumulada entre el reparto lineal y el que dicta el cuadro
 * del préstamo. Sin cuadro no es computable y se devuelve `undefined`: una cifra
 * inventada sería peor que ninguna (P1).
 */
function linearVsEffectiveDeviation(
  rows: readonly AccrualRow[],
  installments?: readonly DebtInstallmentRef[]
): Cents | undefined {
  if (!installments || installments.length === 0) return undefined
  let linear = 0
  let effective = 0
  let worst = 0
  for (const row of rows) {
    linear += row.quotaCents
    effective += installments
      .filter((inst) => inst.dueDate >= row.from && inst.dueDate <= row.to)
      .reduce((acc, inst) => acc + inst.interestCents, 0)
    const gap = Math.abs(linear - effective)
    if (gap > worst) worst = gap
  }
  return worst
}

/** sha256 canónico del cuadro vigente (`Accrual.scheduleHash`). ADR-0011. */
export function accrualScheduleHashOf(rows: readonly AccrualRow[]): string {
  return createHash("sha256").update(canonicalJson(rows), "utf8").digest("hex")
}

export function accrualForPeriod(rows: readonly AccrualRow[], period: PeriodKey): AccrualRow | null {
  return rows.find((r) => r.period === period) ?? null
}

export function totalAccruedCents(rows: readonly AccrualRow[]): Cents {
  return rows.reduce((acc, r) => acc + r.quotaCents, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Reversión periodo a periodo (R-PE-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-PE-3.** Líneas del asiento de devengo de un periodo. La reversión de la
 * periodificación es **periodo a periodo**, generada por su regla recurrente: no
 * hay un asiento único de reversión, porque partiría el gasto en el ejercicio
 * equivocado justo cuando la periodificación cruza el cierre, que es su caso de
 * uso.
 *
 * | Clase | Debe | Haber |
 * |---|---|---|
 * | `GASTO_ANTICIPADO` | `6xx` | `480` |
 * | `INGRESO_ANTICIPADO` | `485` | `7xx` |
 * | `INTERESES_PAGADOS_ANTICIPADO` | `662` | `567` |
 * | `INTERESES_COBRADOS_ANTICIPADO` | `568` | `762` |
 */
export function accrualPeriodLines(accrual: AccrualRef, row: AccrualRow): Result<DraftLine[]> {
  if (row.quotaCents <= 0) {
    return fail(
      err("ZERO_LINE", "quotaCents", `La cuota de ${accrual.code} en ${row.period} es 0: no genera asiento (R-REC-8)`, {
        check: "R-REC-8",
      })
    )
  }
  const amount = row.quotaCents
  const description = `${accrual.name ?? accrual.code} · devengo ${row.period}`
  const analytic = { projectId: accrual.projectId ?? null, costCenterId: accrual.costCenterId ?? null }

  const toPnl = accrual.kind === "GASTO_ANTICIPADO" || accrual.kind === "INTERESES_PAGADOS_ANTICIPADO"
  if (toPnl) {
    // El gasto (o el interés) nace en la PyG y consume la cuenta de balance.
    return ok([
      { lineNo: 1, accountCode: accrual.pnlAccountCode, debitCents: amount, creditCents: 0, description, ...analytic },
      { lineNo: 2, accountCode: accrual.accrualAccountCode, debitCents: 0, creditCents: amount, description },
    ])
  }
  return ok([
    { lineNo: 1, accountCode: accrual.accrualAccountCode, debitCents: amount, creditCents: 0, description },
    { lineNo: 2, accountCode: accrual.pnlAccountCode, debitCents: 0, creditCents: amount, description, ...analytic },
  ])
}
