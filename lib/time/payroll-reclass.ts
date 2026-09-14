/**
 * E10 · T8 — Propuesta de reclasificación analítica de nómina por horas
 * (`docs/design/E10-presupuesto-horas.md` §3.7, camino (b), ADR-0010).
 *
 * Módulo PURO. Devuelve **SIEMPRE una propuesta, nunca un cambio**: la aplica
 * `models/analytics.reclassifyLines` sin un solo cambio —misma ventana, mismo
 * motivo obligatorio, mismo `AuditLog`, mismo recálculo de `entryHash` y misma
 * caducidad de sólo los informes analíticos—. **`ledgerHash` no cambia**, y hay
 * un test que lo exige al céntimo (criterio 14).
 *
 * Y lo que NO se hace, y por qué: no se crea un asiento de traspaso 64x → 64x
 * por dimensión. No es un hecho económico (NRV 14ª), contaminaría el diario,
 * obligaría a un flag de exclusión de informes —prohibido por `CLAUDE.md`— y ya
 * lo descartaron ADR-0004 y ADR-0013. Tampoco se crean cuentas del grupo 9.
 */

import type { AnalyticType, Cents, LocalDate } from "@/lib/analytics/types"
import {
  DEFAULT_PAYROLL_ACCOUNT_PREFIXES,
  EXCLUDED_PAYROLL_PREFIXES,
  matchesPayrollPrefix,
} from "@/lib/time/cost"
import { minutesByTarget, type DateWindow, type TimeEntryRow } from "@/lib/time/aggregate"

/**
 * **O-E10-22.** La concentración exigida es 10 000 bps = **100 %, fija y sin
 * parámetro**. Con 8 000, una línea de 300 000 c de la que el proyecto sólo
 * consumió el 80 % se reasignaría ENTERA y el MC2 del proyecto se llevaría
 * 60 000 c que no son suyos. El caso no íntegro es el camino (a) —una
 * `AllocationRule` con driver `HOURS`—, como ya decía el propio comentario de
 * esta función.
 */
export const REQUIRED_CONCENTRATION_BPS = 10_000

/** Línea de nómina candidata, tal y como la lee `models/`. */
export type PayrollLineRef = {
  lineId: string
  entryId: string
  entryNumber: number
  lineNo: number
  entryDate: LocalDate
  accountCode: string
  /** APORTE (`haber − debe`): un gasto de nómina es NEGATIVO. */
  amountCents: Cents
  costCenterId: string | null
  costCenterCode: string | null
  projectId: string | null
  /** `counterpartyId` de la línea, cuando la nómina se contabiliza por persona. */
  employeeId: string | null
  employeeCode: string | null
}

export type ReclassProposal = {
  lineId: string
  entryId: string
  entryNumber: number
  lineNo: number
  accountCode: string
  amountCents: Cents
  fromCostCenterId: string
  fromCostCenterCode: string | null
  toProjectId: string
  toProjectCode: string
  employeeId: string
  employeeCode: string | null
  /** Minutos del empleado en el proyecto y en total, dentro de la ventana. */
  minutes: number
  totalMinutes: number
  /** Siempre 10 000: sólo se propone lo atribuible al 100 % (O-E10-22). */
  concentrationBps: number
  /**
   * R-A3 la convierte automáticamente: el coste baja de MC3 a MC2, que es la
   * lectura correcta — y significa que la reclasificación **mueve MC2 y MC3 de
   * periodos ya informados**. Lo acota la ventana temporal de ADR-0010.
   */
  resultingAnalyticType: AnalyticType
}

export type NotAttributableReason =
  | "NOT_PAYROLL"
  | "ALREADY_ON_PROJECT"
  | "NO_COST_CENTER"
  | "NO_EMPLOYEE"
  | "NO_HOURS"
  | "SPLIT_ACROSS_PROJECTS"

export type NotAttributable = {
  lineId: string
  entryId: string
  lineNo: number
  accountCode: string
  amountCents: Cents
  reason: NotAttributableReason
  detail: string
  /** Reparto real de las horas del empleado, para que la pantalla lo enseñe. */
  distribution: readonly { projectCode: string; minutes: number; shareBps: number }[]
}

export type ProposePayrollReclassInput = {
  /** Líneas 64x del periodo con `costCenterId`. */
  payrollLines: readonly PayrollLineRef[]
  hours: readonly TimeEntryRow[]
  window: DateWindow
}

export type ProposePayrollReclassResult = {
  proposals: readonly ReclassProposal[]
  notAttributable: readonly NotAttributable[]
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Propone qué líneas 64x de un CECO son atribuibles a un solo proyecto según
 * las **horas aprobadas y productivas** del periodo.
 *
 * **Sólo propone líneas atribuibles al 100 % a un proyecto.** Una línea
 * repartida entre varios NO se puede reclasificar: partir una `JournalLine` está
 * prohibido (ADR-0003; ADR-0010 salvaguarda 1 — sólo cambian las cuatro columnas
 * analíticas). Ese caso es el camino (a), y la propuesta lo dice así.
 */
export function proposePayrollReclass(input: ProposePayrollReclassInput): ProposePayrollReclassResult {
  const { window } = input

  // Minutos aprobados y productivos por (empleado, proyecto) en la ventana. Se
  // reutiliza `minutesByTarget` para heredar sus validaciones (techo diario,
  // minutos enteros) y el signo de los contra-apuntes.
  const byEmployee = new Map<string, TimeEntryRow[]>()
  for (const row of input.hours) {
    const list = byEmployee.get(row.employeeId) ?? []
    list.push(row)
    byEmployee.set(row.employeeId, list)
  }

  const proposals: ReclassProposal[] = []
  const notAttributable: NotAttributable[] = []

  const reject = (
    line: PayrollLineRef,
    reason: NotAttributableReason,
    detail: string,
    distribution: NotAttributable["distribution"] = []
  ): void => {
    notAttributable.push({
      lineId: line.lineId,
      entryId: line.entryId,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      amountCents: line.amountCents,
      reason,
      detail,
      distribution,
    })
  }

  for (const line of input.payrollLines) {
    if (
      !matchesPayrollPrefix(line.accountCode, DEFAULT_PAYROLL_ACCOUNT_PREFIXES) ||
      EXCLUDED_PAYROLL_PREFIXES.some((p) => line.accountCode.startsWith(p))
    ) {
      reject(
        line,
        "NOT_PAYROLL",
        `la cuenta ${line.accountCode} no es de nómina reclasificable (${DEFAULT_PAYROLL_ACCOUNT_PREFIXES.join("/")}; ` +
          `${EXCLUDED_PAYROLL_PREFIXES.join("/")} queda fuera, O-E10-11)`
      )
      continue
    }
    if (line.projectId) {
      reject(line, "ALREADY_ON_PROJECT", "la línea ya está imputada a un proyecto: no hay nada que reclasificar")
      continue
    }
    if (!line.costCenterId) {
      reject(line, "NO_COST_CENTER", "la línea no está imputada a ningún centro de coste")
      continue
    }
    if (!line.employeeId) {
      reject(
        line,
        "NO_EMPLOYEE",
        "la línea no lleva el empleado (`counterpartyId`): sin él no hay horas con las que atribuirla. " +
          "Usa el camino (a): una AllocationRule con driver HOURS reparte el CECO entre los proyectos"
      )
      continue
    }

    const rows = byEmployee.get(line.employeeId) ?? []
    const targets = minutesByTarget(rows, window, { productiveOnly: true, approvedOnly: true })
      .filter((t) => t.kind === "PROJECT" && t.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes || cmp(a.code, b.code))
    const totalMinutes = targets.reduce((acc, t) => acc + t.minutes, 0)

    if (totalMinutes === 0) {
      reject(
        line,
        "NO_HOURS",
        `el empleado ${line.employeeCode ?? line.employeeId} no tiene minutos aprobados y productivos en ` +
          `${window.from} … ${window.to}: no hay base con la que atribuir la línea`
      )
      continue
    }

    const distribution = targets.map((t) => ({
      projectCode: t.code,
      minutes: t.minutes,
      shareBps: Math.floor((t.minutes * 10_000) / totalMinutes),
    }))

    if (targets.length > 1) {
      reject(
        line,
        "SPLIT_ACROSS_PROJECTS",
        `el empleado ${line.employeeCode ?? line.employeeId} repartió sus horas entre ${targets.length} proyectos ` +
          `(${distribution.map((d) => `${d.projectCode} ${(d.shareBps / 100).toFixed(2)} %`).join(", ")}): ` +
          "partir una JournalLine está prohibido (ADR-0003), así que este caso es el camino (a), " +
          "una AllocationRule con driver HOURS",
        distribution
      )
      continue
    }

    const only = targets[0]
    proposals.push({
      lineId: line.lineId,
      entryId: line.entryId,
      entryNumber: line.entryNumber,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      amountCents: line.amountCents,
      fromCostCenterId: line.costCenterId,
      fromCostCenterCode: line.costCenterCode,
      toProjectId: only.id,
      toProjectCode: only.code,
      employeeId: line.employeeId,
      employeeCode: line.employeeCode,
      minutes: only.minutes,
      totalMinutes,
      concentrationBps: REQUIRED_CONCENTRATION_BPS,
      resultingAnalyticType: "COSTE_DIRECTO_MC2",
    })
  }

  proposals.sort((a, b) => cmp(a.entryId, b.entryId) || a.lineNo - b.lineNo)
  notAttributable.sort((a, b) => cmp(a.entryId, b.entryId) || a.lineNo - b.lineNo)
  return { proposals, notAttributable }
}

/** Importe total que una propuesta movería de MC3 a MC2, en valor absoluto. */
export const proposedMc2ShiftCents = (proposals: readonly ReclassProposal[]): Cents =>
  proposals.reduce((acc, p) => acc - p.amountCents, 0)
