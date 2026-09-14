/**
 * E10 · T11 — Invariantes del presupuesto y de las horas, **I-E10-1…18**
 * (`docs/design/E10-presupuesto-horas.md` §6; ADR-0018 D1–D6; O-E10-0…23).
 *
 * Mismo contrato que los bloques de E7, E8 y E9:
 *
 * > **nunca un PASS que no se haya comprobado**; lo no evaluable sale `INFO`
 * > diciendo **qué falta**; **tolerancia 0** en todo lo que compara cifras.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM. Todo entra por
 * parámetro en **tipos planos**; quien lee la base es T12.
 *
 * ## Cuatro decisiones de este fichero, a propósito
 *
 * 1. **No importa `lib/budget/{hash,matrix,variance,forecast}.ts`.** Un
 *    invariante que recomputa la cifra con la MISMA función que la produjo es
 *    tautológico: comprueba que el código es igual a sí mismo. Lo que llega aquí
 *    son las cifras **ya calculadas y persistidas** y los datos crudos con los
 *    que se pueden contrastar por un camino independiente. Es la lección de
 *    I-E9-16 y del hallazgo 2 del auditor de E5.
 * 2. **Los tres invariantes de horas (`I-E10-3`, `10`, `11`, `17`) sí usan
 *    `lib/time/**` y `lib/analytics/allocate.ts`**, porque ahí la comprobación es
 *    real: la base persistida en la línea (`driverBase`) se contrasta contra el
 *    agregado recalculado **desde los partes**, que es otro dato.
 * 3. **Siempre salen los dieciocho resultados**, aunque falte el bloque: un
 *    invariante que desaparece de la lista porque nadie aportó su bloque es
 *    exactamente el silencio que la pestaña de auditoría existe para evitar
 *    (riesgo R3 de E7).
 * 4. **Los cinco motivos de sello** son un **código cerrado**, no una frase: se
 *    filtran, se cuentan y se comparan entre periodos, igual que los seis de E8
 *    y los diez de E9. Y **ningún motivo sin regla que lo emita** (O-E10-17).
 */

import { isTimeSealStale, timeSealOf, type AllocationPeriodRef, type AllocationRuleSpec } from "@/lib/analytics/allocate"
import {
  dailyMinutesExcesses,
  fteMonthsByCostCenter,
  isActivityDriver,
  minutesByTarget,
  timeWindowOf,
  DAILY_MINUTES_CEILING,
  type DateWindow,
  type DriverCode,
  type HeadcountRow,
  type LocalDate,
  type TimeEntryRow,
  type ZeroBaseFallbackCode,
} from "@/lib/time/aggregate"
import { overlappingRates, rateAt, type EmployeeRateRow } from "@/lib/time/cost"
import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"

export type Cents = number

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
const missing = (id: string, quéFalta: string): CheckResult => info(id, `no evaluable: ${quéFalta}`)

const cut = (items: readonly string[], max = 20): string =>
  items.length <= max ? items.join(" · ") : `${items.slice(0, max).join(" · ")} · (+${items.length - max} más)`

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ─────────────────────────────────────────────────────────────────────────────
// Los cinco motivos de sello (ADR-0018 D5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Los cinco motivos que el presupuesto y las horas aportan al sello.** Código
 * cerrado. `PRESUPUESTO_NO_SELLADO` **no está**: EV-14 se retiró (O-E10-5) y un
 * borrador no produce un `ReportRun`, así que es un **rechazo**
 * (`BUDGET_NOT_SEALED`), no un motivo.
 */
export const E10_SEAL_REASONS = [
  "DESVIACION_PRESUPUESTO",
  "PRESUPUESTO_AUSENTE",
  "HORAS_SIN_APROBAR",
  "PLANTILLA_AUSENTE",
  "TARIFA_AUSENTE",
] as const

export type E10SealReason = (typeof E10_SEAL_REASONS)[number]

/** El texto que la pantalla muestra junto a cada código. */
export const E10_SEAL_REASON_TEXT: Readonly<Record<E10SealReason, string>> = {
  DESVIACION_PRESUPUESTO:
    "la desviación supera el umbral declarado en porcentaje Y en importe, o el presupuesto ha cambiado de versión",
  PRESUPUESTO_AUSENTE: "no hay versión de presupuesto vigente para el periodo: la columna sale vacía, nunca a cero",
  HORAS_SIN_APROBAR:
    "hay minutos sin aprobar que alguna regla de actividad habría usado: el reparto sale sobre una parte de la actividad",
  PLANTILLA_AUSENTE:
    "una regla de plantilla reparte a un centro de coste sin ningún snapshot en el periodo: peso 0 por falta de dato, no por no haber nadie",
  TARIFA_AUSENTE:
    "hay partes sin tarifa vigente el día del parte y el informe publica coste-hora o margen por hora: no se aplica 0 ni la tarifa anterior",
}

export const isE10SealReason = (code: string): code is E10SealReason =>
  (E10_SEAL_REASONS as readonly string[]).includes(code)

/**
 * **O-E10-17 — un motivo, una regla.** Cada regla `EV-*` de E10 emite un motivo
 * del código cerrado, y cada motivo tiene al menos una regla que lo emite. Un
 * motivo sin regla es decoración (lección H-4 de E7), y esta tabla es la que el
 * test recorre para comprobarlo.
 */
export const E10_SEAL_REASON_BY_RULE: Readonly<Record<string, E10SealReason>> = {
  "EV-11": "DESVIACION_PRESUPUESTO",
  "EV-12": "PRESUPUESTO_AUSENTE",
  "EV-15": "HORAS_SIN_APROBAR",
  "EV-16": "PLANTILLA_AUSENTE",
  "EV-17": "TARIFA_AUSENTE",
  /** Los cuatro KPI de umbral disparan el mismo motivo que EV-11. */
  UMBRAL: "DESVIACION_PRESUPUESTO",
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrada: tipos PLANOS, uno por bloque
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetStatus = "BORRADOR" | "VIGENTE" | "SUSTITUIDO" | "CERRADO"

export type BudgetDimensionKind = "PROJECT" | "COST_CENTER"

/** Una línea de importe de una versión, tal y como la fila la tiene hoy. */
export type BudgetLineRef = {
  versionCode: string
  /** Día 1 del mes presupuestado. */
  month: LocalDate
  dimensionKind: BudgetDimensionKind
  dimensionCode: string
  /** LN denormalizada; en un proyecto, la suya. */
  businessLineCode: string | null
  projectBusinessLineCode?: string | null
  accountCode: string | null
  /** **O-E10-23**: obligatorio. Una línea sin tipo saltaba el CHECK de signo. */
  analyticType: string | null
  /** **O-E10-7**: congelado en la línea, como en `AllocationLine` (E5-D1). */
  marginLevel: string | null
  amountCents: Cents
  /** `61x`/`71x`, `706`/`708`/`709`, `79x`/`759`: salen LISTADAS, no calladas. */
  signException?: boolean
}

export type BudgetVersionRef = {
  code: string
  fiscalYearCode: string
  scenario: string
  revision: number
  status: BudgetStatus
  validFrom: LocalDate
  validTo: LocalDate | null
  /** **O-E10-9**: declara que la versión sólo trae de este mes en adelante. */
  partialFrom: LocalDate | null
  /** El sello escrito al sellar; `null` mientras es BORRADOR. */
  budgetHash: string | null
  /**
   * El `budgetHash` recomputado **hoy** sobre lo que la fila y sus líneas
   * tienen. Lo aporta el llamante con `lib/budget/hash.ts`; sin él, I-E10-6 sale
   * `INFO`, jamás PASS.
   */
  recomputedHash?: string | null
  /** Meses con al menos una línea, en `AAAA-MM`. */
  monthsCovered: readonly string[]
}

export type BudgetMatrixRef = {
  /** `Σ_c presupuesto[ℓ][c]` por nivel, tal y como la matriz lo publica. */
  levelTotalsCents: Readonly<Record<string, Cents>>
  /** Los mismos totales por mes: `[mes][nivel]`. */
  byMonthCents?: Readonly<Record<string, Readonly<Record<string, Cents>>>>
  /** Líneas que la matriz no supo colocar. Debe estar VACÍO. */
  unresolved: readonly string[]
  /** Qué niveles recoge cada línea, para contrastar la Σ (`marginLevel`). */
  levelOfLine?: (line: BudgetLineRef) => string | null
}

export type VarianceCellRef = {
  level: string
  column: string
  month: string
  actualCents: Cents
  budgetCents: Cents
  varianceCents: Cents
  /** El % en bps: redondearlo **nunca** puede tocar el importe. */
  varianceBps?: number | null
  published?: boolean
}

export type ForecastMonthRef = {
  month: string
  provenance: "REAL_CERRADO" | "PRESUPUESTO_ABIERTO"
  amountCents: Cents
}

export type ForecastRef = {
  months: readonly ForecastMonthRef[]
  /** Los doce meses del ejercicio, en `AAAA-MM`. */
  fiscalYearMonths: readonly string[]
  realToCutoffCents: Cents
  budgetFromCutoffCents: Cents
}

export type ComparabilityRef = {
  /** ¿El informe publica desviación POR DIMENSIÓN en niveles ≥ MC3? */
  publishesByDimension: boolean
  withAllocations: boolean
  /** `rulesHash` con el que se liquidó el REAL. */
  rulesHash: string | null
  /** `rulesHash` con el que se liquidó el PRESUPUESTO (`settleBudgetMatrix`). */
  budgetRulesHash: string | null
  /** Celdas que el informe declara **no publicadas** por no ser comparables. */
  notPublishedCells: number
  /** Celdas por dimensión de MC3 y superiores que el informe SÍ publica. */
  publishedByDimensionCells: number
}

export type ReproducibilityRef = {
  /** Dos ejecuciones con las mismas entradas: la salida canónica, dos veces. */
  canonicalResultJson: readonly string[]
  inputs: { ledgerHash: string; budgetHash: string; timeHash: string; paramsHash: string; gitSha: string }
  /** Las siete tablas nuevas, sin GUC: filas leídas y código SQLSTATE. */
  tenantIsolation?: readonly { table: string; rowsWithoutGuc: number; insertSqlState: string }[]
}

export type BudgetBlock = {
  versions: readonly BudgetVersionRef[]
  lines: readonly BudgetLineRef[]
  /** Ejercicio bajo examen: `[inicio, fin]` y sus doce meses. */
  fiscalYear: { code: string; start: LocalDate; end: LocalDate; months: readonly string[] }
  matrix?: BudgetMatrixRef
  variance?: readonly VarianceCellRef[]
  forecast?: ForecastRef
  comparability?: ComparabilityRef
  reproducibility?: ReproducibilityRef
}

/** Un parte, con lo que I-E10-4 y I-E10-10 necesitan además de la base. */
export type TimeEntryAudit = TimeEntryRow & {
  /** Id del parte que corrige; `null` si es un apunte normal. */
  reversesId?: string | null
  /** Motivo del contra-apunte: ≥ 10 caracteres (R-H-4). */
  reason?: string | null
  /** Huella de la fila aprobada, para detectar un `UPDATE` por SQL. */
  approvedFingerprint?: string | null
  currentFingerprint?: string | null
}

/** Una línea de reparto persistida, vista por el barrido. */
export type AllocationLineAudit = {
  ruleCode: string
  driver: DriverCode
  targetKind: "PROJECTS" | "BUSINESS_LINES" | "COST_CENTERS"
  targetCode: string
  targetId: string
  driverBase: number
  driverBaseTotal: number
  fallbackApplied: ZeroBaseFallbackCode | null
}

/** Un `AllocationRun` sellado, con su cuarto sello y su ventana. */
export type AllocationRunAudit = {
  runId: string
  period: AllocationPeriodRef
  rules: readonly AllocationRuleSpec[]
  lines: readonly AllocationLineAudit[]
  timeHash: string
  timeHashWindowStart: LocalDate | null
  timeHashWindowEnd: LocalDate | null
}

export type PayrollAbsorptionRef = {
  periodLabel: string
  /** `Σ (minutos × tarifa / 60)` imputado a proyectos por los caminos (a) y (b). */
  valuedCents: Cents
  /** `Σ −aporte` de las cuentas 64x del periodo. */
  payrollCents: Cents
}

export type TimeBlock = {
  entries: readonly TimeEntryAudit[]
  rates?: readonly EmployeeRateRow[]
  headcount?: readonly HeadcountRow[]
  runs?: readonly AllocationRunAudit[]
  /** Ventana del ejercicio: I-E10-10 exige que todo parte caiga dentro. */
  fiscalYearWindow?: DateWindow
  /** Meses bloqueados, en `AAAA-MM`: ningún parte nace dentro de uno. */
  lockedMonths?: readonly string[]
  payroll?: readonly PayrollAbsorptionRef[]
  /** ¿El informe publica coste-hora o margen por hora? (EV-17). */
  publishesHourlyCost?: boolean
}

export type BudgetInvariantInput = {
  budget?: BudgetBlock
  time?: TimeBlock
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-1 — Σ líneas = totales por nivel, y los doce meses = el anual
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE101(budget: BudgetBlock | undefined): CheckResult {
  if (!budget?.matrix) return missing("I-E10-1", "falta la matriz de presupuesto construida (`buildBudgetMatrix`)")
  const matrix = budget.matrix
  const problems: string[] = []
  if (matrix.unresolved.length > 0) {
    problems.push(`${matrix.unresolved.length} línea(s) fuera de la matriz: ${cut(matrix.unresolved)}`)
  }
  // Σ de las líneas que cada nivel recoge, por el `marginLevel` congelado en la
  // propia línea (O-E10-7): el nivel NO se re-deriva de la cuenta, porque se
  // leería en otra fila sin cambiar el hash.
  const levelOf = matrix.levelOfLine ?? ((line: BudgetLineRef) => line.marginLevel)
  const byLevel = new Map<string, Cents>()
  for (const line of budget.lines) {
    const level = levelOf(line)
    if (level === null) continue
    byLevel.set(level, (byLevel.get(level) ?? 0) + line.amountCents)
  }
  for (const [level, total] of [...Object.entries(matrix.levelTotalsCents)].sort()) {
    const fromLines = byLevel.get(level) ?? 0
    if (fromLines !== total) problems.push(`nivel ${level}: matriz ${total} c ≠ Σ líneas ${fromLines} c`)
  }
  // Σ de los doce meses = el anual, nivel a nivel.
  if (matrix.byMonthCents) {
    for (const level of Object.keys(matrix.levelTotalsCents).sort()) {
      const months = sum(Object.values(matrix.byMonthCents).map((m) => m[level] ?? 0))
      if (months !== matrix.levelTotalsCents[level]) {
        problems.push(`nivel ${level}: Σ de los meses ${months} c ≠ anual ${matrix.levelTotalsCents[level]} c`)
      }
    }
  }
  return problems.length === 0
    ? pass(
        "I-E10-1",
        `${budget.lines.length} línea(s) presupuestadas cuadran con los ${Object.keys(matrix.levelTotalsCents).length} ` +
          `nivel(es) de la matriz${matrix.byMonthCents ? " y con la suma de sus meses" : ""}; `+
          "ninguna línea queda fuera"
      )
    : failed("I-E10-1", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-2 — desviación exacta, celda a celda
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE102(budget: BudgetBlock | undefined): CheckResult {
  const cells = budget?.variance
  if (!cells) return missing("I-E10-2", "falta la matriz de desviación (`buildVarianceMatrix`)")
  if (cells.length === 0) return info("I-E10-2", "la matriz de desviación no tiene ninguna celda que comparar")
  const problems: string[] = []
  for (const cell of cells) {
    if (cell.published === false) continue
    const expected = cell.actualCents - cell.budgetCents
    if (cell.varianceCents !== expected) {
      problems.push(
        `${cell.level}/${cell.column}/${cell.month}: desviación ${cell.varianceCents} c ≠ real ${cell.actualCents} − ` +
          `presupuesto ${cell.budgetCents} = ${expected} c`
      )
    }
  }
  return problems.length === 0
    ? pass("I-E10-2", `${cells.length} celda(s): desviación = real − presupuesto al céntimo, y el % no mueve el importe`)
    : failed("I-E10-2", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-3 — Σ minutos imputados por regla `HOURS` = base de la ventana efectiva
// ─────────────────────────────────────────────────────────────────────────────

/** La ventana que el driver usó de verdad: la del periodo, o la del fallback. */
function driverWindowOf(run: AllocationRunAudit, rule: AllocationRuleSpec, fallbackApplied: ZeroBaseFallbackCode | null): DateWindow {
  if (fallbackApplied === "YTD") return { from: run.period.fiscalYearStart, to: run.period.end }
  if (fallbackApplied === "PRIOR_PERIOD") {
    const window = timeWindowOf([{ driver: rule.driver, zeroBaseFallback: "PRIOR_PERIOD" }], {
      kind: run.period.kind,
      label: run.period.label,
      start: run.period.start,
      end: run.period.end,
      fiscalYearStart: run.period.fiscalYearStart,
    })
    if (window) return { from: window.from, to: run.period.end }
  }
  return { from: run.period.start, to: run.period.end }
}

export function checkIE103(time: TimeBlock | undefined): CheckResult {
  if (!time?.runs) return missing("I-E10-3", "faltan los runs de liquidación sellados con sus líneas")
  const runs = time.runs.filter((r) => r.lines.some((l) => l.driver === "HOURS"))
  if (runs.length === 0) return info("I-E10-3", "ningún run del alcance reparte con el driver HORAS")
  const problems: string[] = []
  let checked = 0
  for (const run of runs) {
    const byRule = new Map<string, AllocationLineAudit[]>()
    for (const line of run.lines) {
      if (line.driver !== "HOURS") continue
      byRule.set(line.ruleCode, [...(byRule.get(line.ruleCode) ?? []), line])
    }
    for (const [ruleCode, lines] of [...byRule.entries()].sort()) {
      checked += 1
      const rule = run.rules.find((r) => r.code === ruleCode)
      if (!rule) {
        problems.push(`${run.runId}/${ruleCode}: el run no conserva la regla con la que repartió`)
        continue
      }
      const window = driverWindowOf(run, rule, lines[0].fallbackApplied)
      const agregado = minutesByTarget(time.entries, window, { productiveOnly: true, approvedOnly: true })
      const byTarget = new Map(agregado.map((t) => [t.id, Math.max(0, t.minutes)]))
      const blByCode = new Map<string, number>()
      for (const row of time.entries) {
        if (!row.approved || !row.productive || !row.businessLineCode) continue
        if (row.date < window.from || row.date > window.to) continue
        blByCode.set(row.businessLineCode, (blByCode.get(row.businessLineCode) ?? 0) + row.minutes)
      }
      for (const line of lines) {
        const esperado =
          line.targetKind === "BUSINESS_LINES"
            ? Math.max(0, blByCode.get(line.targetCode) ?? 0)
            : (byTarget.get(line.targetId) ?? 0)
        if (line.driverBase !== esperado) {
          problems.push(
            `${run.runId}/${ruleCode}/${line.targetCode}: driverBase ${line.driverBase} ≠ ${esperado} minutos ` +
              `aprobados y productivos en [${window.from}, ${window.to}]`
          )
        }
      }
      const total = sum(lines.map((l) => l.driverBase))
      const distintos = [...new Set(lines.map((l) => l.driverBaseTotal))]
      if (distintos.length > 1 || (distintos.length === 1 && distintos[0] !== total)) {
        problems.push(`${run.runId}/${ruleCode}: driverBaseTotal ${distintos.join("/")} ≠ Σ driverBase ${total}`)
      }
    }
  }
  return problems.length === 0
    ? pass(
        "I-E10-3",
        `${checked} regla(s) HORAS: Σ driverBase = minutos aprobados y productivos de la VENTANA EFECTIVA del run ` +
          "(no la del periodo: O-E10-1), y driverBaseTotal es ese mismo número en todas sus líneas"
      )
    : failed("I-E10-3", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-4 — las `TimeEntry` aprobadas son inmutables
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE104(time: TimeBlock | undefined): CheckResult {
  if (!time) return missing("I-E10-4", "faltan los partes de horas")
  const problems: string[] = []
  const byId = new Map(time.entries.map((e) => [e.id, e]))
  const counter = time.entries.filter((e) => e.reversesId)
  for (const row of time.entries) {
    if (row.approved && row.approvedFingerprint && row.currentFingerprint && row.approvedFingerprint !== row.currentFingerprint) {
      problems.push(`${row.employeeCode} ${row.date}: la fila aprobada ha cambiado fuera de la transición de aprobación`)
    }
  }
  for (const row of counter) {
    const original = byId.get(row.reversesId as string)
    if (!original) {
      problems.push(`${row.employeeCode} ${row.date}: contra-apunte sin original (${row.reversesId})`)
      continue
    }
    if ((row.reason ?? "").trim().length < 10) {
      problems.push(`${row.employeeCode} ${row.date}: contra-apunte sin motivo de 10 caracteres o más`)
    }
    if (Math.sign(row.minutes) === Math.sign(original.minutes) || row.minutes === 0) {
      problems.push(`${row.employeeCode} ${row.date}: el contra-apunte no lleva el signo contrario al original`)
    }
    if (row.employeeId !== original.employeeId || row.date !== original.date) {
      problems.push(`${row.employeeCode} ${row.date}: el contra-apunte no cuadra con su original en empleado y fecha`)
    }
    if (row.target.kind !== original.target.kind || row.target.id !== original.target.id) {
      problems.push(`${row.employeeCode} ${row.date}: el contra-apunte apunta a otra dimensión que su original`)
    }
  }
  // Σ de los contra-apuntes de un original no puede exceder su magnitud.
  const byOriginal = new Map<string, number>()
  for (const row of counter) byOriginal.set(row.reversesId as string, (byOriginal.get(row.reversesId as string) ?? 0) + row.minutes)
  for (const [id, minutes] of [...byOriginal.entries()].sort()) {
    const original = byId.get(id)
    if (original && Math.abs(minutes) > Math.abs(original.minutes)) {
      problems.push(`${id}: los contra-apuntes suman ${Math.abs(minutes)} minutos sobre un original de ${Math.abs(original.minutes)}`)
    }
  }
  return problems.length === 0
    ? pass(
        "I-E10-4",
        `${time.entries.filter((e) => e.approved).length} parte(s) aprobado(s) íntegros y ${counter.length} ` +
          "contra-apunte(s) con motivo, signo contrario y la misma dimensión que su original"
      )
    : failed("I-E10-4", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-5 — coste-hora vigente única por fecha (y su motivo de sello)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE105(time: TimeBlock | undefined): CheckResult {
  if (!time?.rates) return missing("I-E10-5", "faltan las tarifas de coste-hora de los empleados")
  const overlaps = overlappingRates(time.rates)
  if (overlaps.length > 0) {
    return failed(
      "I-E10-5",
      cut(overlaps.map((o) => `${o.employeeCode}: las tarifas ${o.a} y ${o.b} se solapan; la base lo impide con 23P01`))
    )
  }
  const sinTarifa: string[] = []
  for (const row of time.entries) {
    if (!row.approved || row.minutes === 0) continue
    if (rateAt(time.rates, row.employeeId, row.date).kind === "MISSING") {
      sinTarifa.push(`${row.employeeCode} ${row.date}`)
    }
  }
  if (sinTarifa.length === 0) {
    return pass("I-E10-5", `0 ó 1 tarifa vigente por empleado y fecha en ${time.rates.length} tarifa(s); ningún parte sin tarifa`)
  }
  // Nunca se aplica 0 ni la tarifa anterior: la fila sale NO EVALUABLE. Y mueve
  // el sello con `TARIFA_AUSENTE` cuando el informe publica coste-hora o margen
  // por hora: un margen por hora calculado con partes sin tarifa no es un margen.
  const nombres = [...new Set(sinTarifa)].sort()
  const texto =
    `${nombres.length} parte(s) aprobados sin tarifa vigente ese día: ${cut(nombres)} · no se aplica 0 ni la tarifa ` +
    "anterior; el coste del receptor sale NO EVALUABLE"
  return time.publishesHourlyCost === true
    ? warn("I-E10-5", `${texto} · mueve el sello con TARIFA_AUSENTE (EV-17)`)
    : info("I-E10-5", texto)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-6 — una versión sellada no cambia
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE106(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-6", "falta el bloque de presupuesto")
  const selladas = budget.versions.filter((v) => v.status !== "BORRADOR")
  if (selladas.length === 0) return info("I-E10-6", "ninguna versión sellada todavía")
  const sinRecomputar = selladas.filter((v) => v.recomputedHash === undefined || v.recomputedHash === null)
  const comparables = selladas.filter((v) => typeof v.recomputedHash === "string")
  const problems: string[] = []
  for (const v of comparables) {
    if (v.budgetHash === null) {
      problems.push(`${v.code}: está ${v.status} y no tiene budgetHash escrito`)
      continue
    }
    if (v.budgetHash !== v.recomputedHash) {
      problems.push(`${v.code}: el hash sellado ${v.budgetHash.slice(0, 12)}… no coincide con el de sus líneas de hoy`)
    }
  }
  if (problems.length > 0) return failed("I-E10-6", cut(problems))
  if (comparables.length === 0) {
    return missing("I-E10-6", `falta el budgetHash recomputado de ${sinRecomputar.map((v) => v.code).join(", ")}`)
  }
  return sinRecomputar.length === 0
    ? pass("I-E10-6", `${comparables.length} versión(es) sellada(s) con el hash recomputado idéntico al sellado`)
    : warn(
        "I-E10-6",
        `${comparables.length} versión(es) comprobada(s); sin hash recomputado: ${sinRecomputar.map((v) => v.code).join(", ")}`
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-7 — forecast sin solape ni hueco
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE107(budget: BudgetBlock | undefined): CheckResult {
  const forecast = budget?.forecast
  if (!forecast) return missing("I-E10-7", "falta el forecast (`buildForecast`)")
  const problems: string[] = []
  const seen = new Map<string, number>()
  for (const m of forecast.months) seen.set(m.month, (seen.get(m.month) ?? 0) + 1)
  for (const month of forecast.fiscalYearMonths) {
    const veces = seen.get(month) ?? 0
    if (veces === 0) problems.push(`${month}: no aparece en el forecast`)
    if (veces > 1) problems.push(`${month}: aparece ${veces} veces, con más de una procedencia`)
  }
  for (const month of seen.keys()) {
    if (!forecast.fiscalYearMonths.includes(month)) problems.push(`${month}: no pertenece al ejercicio`)
  }
  const real = sum(forecast.months.filter((m) => m.provenance === "REAL_CERRADO").map((m) => m.amountCents))
  const ppto = sum(forecast.months.filter((m) => m.provenance === "PRESUPUESTO_ABIERTO").map((m) => m.amountCents))
  if (real !== forecast.realToCutoffCents) problems.push(`Σ meses REAL_CERRADO ${real} c ≠ real hasta el corte ${forecast.realToCutoffCents} c`)
  if (ppto !== forecast.budgetFromCutoffCents) {
    problems.push(`Σ meses PRESUPUESTO_ABIERTO ${ppto} c ≠ presupuesto desde el corte ${forecast.budgetFromCutoffCents} c`)
  }
  return problems.length === 0
    ? pass(
        "I-E10-7",
        `los ${forecast.fiscalYearMonths.length} meses aparecen una sola vez y con una sola procedencia; ` +
          `real ${real} c + presupuesto ${ppto} c = ${real + ppto} c`
      )
    : failed("I-E10-7", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-8 — unicidad y exclusividad de celda (O-A6)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE108(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-8", "falta el bloque de presupuesto")
  if (budget.lines.length === 0) return info("I-E10-8", "no hay ninguna línea de presupuesto que comprobar")
  const problems: string[] = []
  const seen = new Map<string, number>()
  for (const line of budget.lines) {
    const key = [line.versionCode, line.month, line.dimensionKind, line.dimensionCode, line.accountCode ?? "∅"].join("|")
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (!line.dimensionCode) problems.push(`${line.versionCode} ${line.month}: línea sin dimensión`)
    if (
      line.dimensionKind === "PROJECT" &&
      line.projectBusinessLineCode !== undefined &&
      line.businessLineCode !== line.projectBusinessLineCode
    ) {
      problems.push(
        `${line.versionCode} ${line.month} ${line.dimensionCode}: LN denormalizada ${line.businessLineCode} ≠ ` +
          `la del proyecto ${line.projectBusinessLineCode}`
      )
    }
  }
  for (const [key, veces] of [...seen.entries()].sort()) {
    if (veces > 1) problems.push(`${key.replace(/\|/g, " · ")}: ${veces} líneas para la misma celda`)
  }
  return problems.length === 0
    ? pass("I-E10-8", `${budget.lines.length} línea(s) con celda única (versión, mes, dimensión, cuenta) y una sola dimensión`)
    : failed("I-E10-8", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-9 — una versión vigente por ejercicio y fecha
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE109(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-9", "falta el bloque de presupuesto")
  const versions = budget.versions.filter((v) => v.status !== "BORRADOR")
  if (versions.length === 0) return info("I-E10-9", "ninguna versión sellada todavía")
  const problems: string[] = []
  const byScenario = new Map<string, BudgetVersionRef[]>()
  for (const v of versions) {
    const key = `${v.fiscalYearCode}|${v.scenario}`
    byScenario.set(key, [...(byScenario.get(key) ?? []), v])
  }
  for (const [key, list] of [...byScenario.entries()].sort()) {
    const sorted = [...list].sort((a, b) => cmp(a.validFrom, b.validFrom) || a.revision - b.revision)
    for (let i = 1; i < sorted.length; i++) {
      const previo = sorted[i - 1]
      const to = previo.validTo ?? "9999-12-31"
      if (sorted[i].validFrom <= to) {
        problems.push(`${key}: ${previo.code} (hasta ${previo.validTo ?? "∞"}) y ${sorted[i].code} (desde ${sorted[i].validFrom}) se solapan`)
      }
    }
    const revisiones = sorted.map((v) => v.revision).sort((a, b) => a - b)
    revisiones.forEach((rev, index) => {
      if (rev !== index) problems.push(`${key}: la revisión ${rev} rompe la correlatividad (esperada ${index})`)
    })
    for (const v of sorted) {
      if (v.revision > 0 && !sorted.some((other) => other.revision === v.revision - 1)) {
        problems.push(`${key}: ${v.code} es una revisión ${v.revision} sin la anterior`)
      }
    }
  }
  return problems.length === 0
    ? pass("I-E10-9", `${versions.length} versión(es) con vigencias sin solape y revisión correlativa sin huecos`)
    : failed("I-E10-9", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-10 — partes bien formados (con el techo diario AGREGADO, O-E10-21)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1010(time: TimeBlock | undefined): CheckResult {
  if (!time) return missing("I-E10-10", "faltan los partes de horas")
  if (time.entries.length === 0) return info("I-E10-10", "no hay ningún parte de horas que comprobar")
  const problems: string[] = []
  const locked = new Set(time.lockedMonths ?? [])
  for (const row of time.entries) {
    if (!Number.isInteger(row.minutes) || row.minutes === 0) {
      problems.push(`${row.employeeCode} ${row.date}: minutos ${row.minutes} (entero distinto de cero)`)
    }
    if (Math.abs(row.minutes) > DAILY_MINUTES_CEILING) {
      problems.push(`${row.employeeCode} ${row.date}: ${row.minutes} minutos supera el techo de ${DAILY_MINUTES_CEILING} por parte`)
    }
    if (row.minutes < 0 && !row.reversesId) {
      problems.push(`${row.employeeCode} ${row.date}: minutos negativos sin ser un contra-apunte`)
    }
    if (time.fiscalYearWindow && (row.date < time.fiscalYearWindow.from || row.date > time.fiscalYearWindow.to)) {
      problems.push(`${row.employeeCode} ${row.date}: la fecha cae fuera del ejercicio`)
    }
    if (locked.has(row.date.slice(0, 7))) {
      problems.push(`${row.employeeCode} ${row.date}: el mes está bloqueado`)
    }
  }
  // **O-E10-21**: el techo por fila no ve cuatro partes de 1 440 el mismo día.
  for (const excess of dailyMinutesExcesses(time.entries)) {
    problems.push(`${excess.employeeCode} ${excess.date}: Σ ${excess.minutes} minutos supera el techo diario de ${DAILY_MINUTES_CEILING}`)
  }
  return problems.length === 0
    ? pass(
        "I-E10-10",
        `${time.entries.length} parte(s) bien formados: minutos ≠ 0 dentro de ±${DAILY_MINUTES_CEILING}, negativos sólo en ` +
          `contra-apuntes, fecha dentro del ejercicio y Σ por (empleado, fecha) ≤ ${DAILY_MINUTES_CEILING}`
      )
    : failed("I-E10-10", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-11 — base de `HEADCOUNT` (FTE·mes)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1011(time: TimeBlock | undefined): CheckResult {
  if (!time?.headcount) return missing("I-E10-11", "faltan los snapshots de plantilla")
  const problems: string[] = []
  const avisos: string[] = []
  const seen = new Map<string, number>()
  for (const row of time.headcount) {
    if (!Number.isInteger(row.fteMilli) || row.fteMilli < 0) {
      problems.push(`${row.costCenterCode} ${row.periodEnd}: fteMilli ${row.fteMilli} debe ser un entero ≥ 0`)
    }
    const key = `${row.costCenterId}|${row.periodEnd.slice(0, 7)}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [key, veces] of [...seen.entries()].sort()) {
    if (veces > 1) problems.push(`${key.replace("|", " · ")}: ${veces} snapshots para el mismo mes`)
  }
  let checked = 0
  for (const run of time.runs ?? []) {
    const lines = run.lines.filter((l) => l.driver === "HEADCOUNT")
    if (lines.length === 0) continue
    checked += 1
    const window: DateWindow = { from: run.period.start, to: run.period.end }
    const fte = new Map(
      fteMonthsByCostCenter(time.headcount, window, {
        eligible: lines.map((l) => ({ id: l.targetId, code: l.targetCode })),
      }).map((f) => [f.id, f])
    )
    for (const line of lines) {
      const esperado = fte.get(line.targetId)
      if (!esperado) continue
      if (line.driverBase !== Math.max(0, esperado.fteMilli)) {
        problems.push(
          `${run.runId}/${line.ruleCode}/${line.targetCode}: driverBase ${line.driverBase} ≠ ${esperado.fteMilli} ` +
            `FTE·mes de [${window.from}, ${window.to}]`
        )
      }
      if (!esperado.declared) {
        // Nunca se confunde «no hay nadie» (snapshot a 0) con «no lo hemos
        // rellenado»: lo segundo es peso 0, aviso y sello `PLANTILLA_AUSENTE`.
        avisos.push(`${run.runId}/${line.targetCode}: sin ningún snapshot en el periodo (PLANTILLA_AUSENTE)`)
      }
    }
    const total = sum(lines.map((l) => l.driverBase))
    const distintos = [...new Set(lines.map((l) => l.driverBaseTotal))]
    if (distintos.length > 1 || (distintos.length === 1 && distintos[0] !== total)) {
      problems.push(`${run.runId}: driverBaseTotal ${distintos.join("/")} ≠ Σ driverBase ${total} de la regla de PLANTILLA`)
    }
  }
  if (problems.length > 0) return failed("I-E10-11", cut(problems))
  if (avisos.length > 0) return warn("I-E10-11", cut(avisos))
  return checked === 0
    ? info("I-E10-11", `${time.headcount.length} snapshot(s) bien formados; ningún run reparte con el driver PLANTILLA`)
    : pass(
        "I-E10-11",
        `${checked} run(s) con driver PLANTILLA: Σ driverBase = Σ fteMilli de los snapshots del periodo (FTE·mes), ` +
          `sobre ${time.headcount.length} snapshot(s) con un solo dato por (CECO, mes)`
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-12 — el personal imputado no excede al contabilizado (guarda, no medida)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1012(time: TimeBlock | undefined): CheckResult {
  if (!time?.payroll) return missing("I-E10-12", "falta el coste de personal valorado y el saldo de las cuentas 64x del periodo")
  if (time.payroll.length === 0) return info("I-E10-12", "ningún periodo con coste de personal que contrastar")
  const problems: string[] = []
  for (const row of time.payroll) {
    if (row.valuedCents > row.payrollCents) {
      problems.push(
        `${row.periodLabel}: ${row.valuedCents} c imputados a proyectos por horas sobre ${row.payrollCents} c ` +
          `contabilizados en 64x (exceso de ${row.valuedCents - row.payrollCents} c): tarifa mal puesta u horas duplicadas`
      )
    }
  }
  const holgura = sum(time.payroll.map((r) => r.payrollCents - r.valuedCents))
  return problems.length === 0
    ? pass(
        "I-E10-12",
        `${time.payroll.length} periodo(s): el personal imputado por horas no excede al contabilizado en 64x ` +
          `(holgura ${holgura} c). Es una GUARDA: la infraabsorción la publica el informe de absorción (O-E10-20)`
      )
    : failed("I-E10-12", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-13 — reproducibilidad y aislamiento
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1013(budget: BudgetBlock | undefined): CheckResult {
  const repro = budget?.reproducibility
  if (!repro) return missing("I-E10-13", "faltan las dos ejecuciones con las mismas entradas y el barrido sin GUC")
  const problems: string[] = []
  if (repro.canonicalResultJson.length < 2) {
    return missing("I-E10-13", "hace falta MÁS DE UNA ejecución para poder comparar: una sola no prueba nada")
  }
  const [first, ...rest] = repro.canonicalResultJson
  const distintas = rest.filter((other) => other !== first).length
  if (distintas > 0) {
    problems.push(
      `${distintas} de ${repro.canonicalResultJson.length} ejecuciones con (ledgerHash, budgetHash, timeHash, ` +
        "paramsHash, gitSha) idénticos devuelven un JSON canónico distinto"
    )
  }
  for (const row of repro.tenantIsolation ?? []) {
    if (row.rowsWithoutGuc !== 0) problems.push(`${row.table}: devuelve ${row.rowsWithoutGuc} fila(s) sin GUC`)
    if (row.insertSqlState !== "42501") problems.push(`${row.table}: el INSERT sin GUC responde ${row.insertSqlState} y no 42501`)
  }
  const tablas = repro.tenantIsolation?.length ?? 0
  return problems.length === 0
    ? pass(
        "I-E10-13",
        `${repro.canonicalResultJson.length} ejecuciones byte a byte idénticas con gitSha ${repro.inputs.gitSha}` +
          (tablas > 0 ? `; ${tablas} tabla(s) devuelven 0 filas y 42501 sin GUC` : "; el aislamiento lo comprueba la suite RLS")
      )
    : failed("I-E10-13", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-14 — tipo declarado y coherencia de signo (O-E10-6 + O-E10-23)
// ─────────────────────────────────────────────────────────────────────────────

/** Tipos cuyo importe presupuestado es un COSTE y por tanto va en negativo. */
const NEGATIVE_TYPES: ReadonlySet<string> = new Set([
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
])

/** Las excepciones DECLARADAS: salen listadas, no calladas (O-E10-6). */
const SIGN_EXCEPTION_PREFIXES: readonly string[] = ["61", "71", "706", "708", "709", "79", "759"]

export const isSignException = (accountCode: string | null): boolean =>
  accountCode !== null && SIGN_EXCEPTION_PREFIXES.some((p) => accountCode.startsWith(p))

export function checkIE1014(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-14", "falta el bloque de presupuesto")
  if (budget.lines.length === 0) return info("I-E10-14", "no hay ninguna línea de presupuesto que comprobar")
  const untyped: string[] = []
  const wrongSign: string[] = []
  const exceptions = new Set<string>()
  for (const line of budget.lines) {
    const donde = `${line.versionCode} ${line.month} ${line.dimensionCode} ${line.accountCode ?? "sin cuenta"}`
    if (!line.analyticType) {
      // Sin el tipo obligatorio, la comprobación de signo se saltaba a sí misma.
      untyped.push(donde)
      continue
    }
    if (line.signException === true || isSignException(line.accountCode)) {
      exceptions.add(line.accountCode ?? line.analyticType)
      continue
    }
    if (line.analyticType === "INGRESO_DIRECTO" && line.amountCents < 0) {
      wrongSign.push(`${donde}: INGRESO_DIRECTO en negativo (${line.amountCents} c)`)
    }
    if (NEGATIVE_TYPES.has(line.analyticType) && line.amountCents > 0) {
      wrongSign.push(`${donde}: ${line.analyticType} en positivo (${line.amountCents} c)`)
    }
  }
  const listadas = [...exceptions].sort()
  if (untyped.length > 0 || wrongSign.length > 0) {
    return failed(
      "I-E10-14",
      cut([
        ...(untyped.length > 0 ? [`${untyped.length} línea(s) SIN analyticType: ${cut(untyped, 10)}`] : []),
        ...wrongSign,
      ])
    )
  }
  return pass(
    "I-E10-14",
    `${budget.lines.length} línea(s) con tipo analítico declarado y el signo que le corresponde` +
      (listadas.length > 0 ? `; excepciones declaradas: ${listadas.join(", ")}` : "; sin excepciones de signo")
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-15 — continuidad de vigencias (O-E10-8)
// ─────────────────────────────────────────────────────────────────────────────

const nextDay = (date: LocalDate): LocalDate => {
  const [y, m, d] = date.split("-").map(Number)
  const daysIn = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  if (d < daysIn) return `${y}-${String(m).padStart(2, "0")}-${String(d + 1).padStart(2, "0")}`
  if (m < 12) return `${y}-${String(m + 1).padStart(2, "0")}-01`
  return `${y + 1}-01-01`
}

export function checkIE1015(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-15", "falta el bloque de presupuesto")
  const versions = budget.versions.filter((v) => v.status !== "BORRADOR" && v.fiscalYearCode === budget.fiscalYear.code)
  if (versions.length === 0) {
    return info("I-E10-15", `el ejercicio ${budget.fiscalYear.code} no tiene ninguna versión de presupuesto sellada`)
  }
  const spans = [...versions].sort((a, b) => cmp(a.validFrom, b.validFrom) || a.revision - b.revision)
  const problems: string[] = []
  let cursor = budget.fiscalYear.start
  for (const v of spans) {
    if (v.validFrom > cursor) problems.push(`hueco sin versión vigente entre ${cursor} y ${nextDayBefore(v.validFrom)} (antes de ${v.code})`)
    const to = v.validTo ?? budget.fiscalYear.end
    if (to >= cursor) cursor = nextDay(to)
  }
  if (cursor <= budget.fiscalYear.end) problems.push(`hueco sin versión vigente entre ${cursor} y ${budget.fiscalYear.end}`)
  return problems.length === 0
    ? pass(
        "I-E10-15",
        `las vigencias de ${spans.map((v) => v.code).join(", ")} cubren ${budget.fiscalYear.start} … ` +
          `${budget.fiscalYear.end} sin hueco`
      )
    : failed("I-E10-15", cut(problems))
}

const nextDayBefore = (date: LocalDate): LocalDate => {
  const [y, m, d] = date.split("-").map(Number)
  if (d > 1) return `${y}-${String(m).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}`
  if (m > 1) {
    const daysIn = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 2]
    return `${y}-${String(m - 1).padStart(2, "0")}-${String(daysIn).padStart(2, "0")}`
  }
  return `${y - 1}-12-31`
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-16 — completitud de la versión (O-E10-9)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1016(budget: BudgetBlock | undefined): CheckResult {
  if (!budget) return missing("I-E10-16", "falta el bloque de presupuesto")
  const versions = budget.versions.filter((v) => v.status !== "BORRADOR" && v.fiscalYearCode === budget.fiscalYear.code)
  if (versions.length === 0) return info("I-E10-16", "ninguna versión sellada del ejercicio")
  const problems: string[] = []
  for (const v of versions) {
    const cubiertos = new Set(v.monthsCovered)
    const faltan = budget.fiscalYear.months.filter((m) => !cubiertos.has(m))
    if (faltan.length === 0) continue
    if (v.partialFrom === null) {
      // Sin esto, una revisión que sólo trae jul–dic desinfla el año a la mitad
      // en silencio: el informe la compone sólo si la versión lo DECLARA.
      problems.push(`${v.code}: cubre ${cubiertos.size} de ${budget.fiscalYear.months.length} meses y no declara partialFrom (faltan ${cut(faltan, 6)})`)
      continue
    }
    const desde = v.partialFrom.slice(0, 7)
    const huecos = budget.fiscalYear.months.filter((m) => m >= desde && !cubiertos.has(m))
    if (huecos.length > 0) {
      problems.push(`${v.code}: declara partialFrom ${v.partialFrom} y aun así le faltan ${cut(huecos, 6)}`)
    }
  }
  return problems.length === 0
    ? pass(
        "I-E10-16",
        `${versions.length} versión(es): cada una cubre los ${budget.fiscalYear.months.length} meses o declara su ` +
          "partialFrom, y el informe compone la procedencia mes a mes"
      )
    : failed("I-E10-16", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-17 — el `timeHash` cubre la ventana consumida (O-E10-1)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1017(time: TimeBlock | undefined): CheckResult {
  if (!time?.runs) return missing("I-E10-17", "faltan los runs sellados con su timeHash y su ventana")
  if (time.runs.length === 0) return info("I-E10-17", "ningún run sellado en el alcance")
  const problems: string[] = []
  let checked = 0
  for (const run of time.runs) {
    const usaActividad = run.rules.some((r) => isActivityDriver(r.driver))
    const esperada = timeWindowOf(
      run.rules.map((r) => ({ driver: r.driver, zeroBaseFallback: r.zeroBaseFallback })),
      {
        kind: run.period.kind,
        label: run.period.label,
        start: run.period.start,
        end: run.period.end,
        fiscalYearStart: run.period.fiscalYearStart,
      }
    )
    if (!usaActividad || esperada === null) {
      if (run.timeHash !== "∅" || run.timeHashWindowStart !== null || run.timeHashWindowEnd !== null) {
        problems.push(`${run.runId}: no usa ningún driver de actividad y debería sellar "∅" con la ventana a NULL`)
      }
      continue
    }
    checked += 1
    if (run.timeHashWindowStart === null || run.timeHashWindowEnd === null) {
      problems.push(`${run.runId}: usa un driver de actividad y no persiste la ventana del timeHash`)
      continue
    }
    // La ventana sellada CONTIENE la que el driver pudo consumir, y también el
    // periodo del run (es lo que exige el CHECK de M4). Sellar de más nunca
    // rompe el invariante; sellar de menos sí.
    if (run.timeHashWindowStart > esperada.from || run.timeHashWindowEnd < esperada.to) {
      problems.push(
        `${run.runId}: la ventana sellada [${run.timeHashWindowStart}, ${run.timeHashWindowEnd}] no contiene la ` +
          `consumida [${esperada.from}, ${esperada.to}]`
      )
      continue
    }
    if (run.timeHashWindowStart > run.period.start || run.timeHashWindowEnd < run.period.end) {
      problems.push(`${run.runId}: la ventana sellada no contiene el periodo del run`)
      continue
    }
    const stale = isTimeSealStale(
      {
        timeHash: run.timeHash,
        timeHashWindowStart: run.timeHashWindowStart,
        timeHashWindowEnd: run.timeHashWindowEnd,
      },
      time.entries
    )
    if (stale) {
      problems.push(
        `${run.runId}: el timeHash recomputado sobre [${run.timeHashWindowStart}, ${run.timeHashWindowEnd}] difiere ` +
          "del sellado: el run está CADUCADO (cuarta causa de STALE)"
      )
    }
  }
  return problems.length === 0
    ? pass(
        "I-E10-17",
        `${checked} run(s) con driver de actividad: la ventana sellada contiene la consumida y el hash recomputado ` +
          "sobre ella coincide con el sellado"
      )
    : failed("I-E10-17", cut(problems))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E10-18 — comparabilidad presupuesto ↔ real (O-E10-4)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1018(budget: BudgetBlock | undefined): CheckResult {
  const c = budget?.comparability
  if (!c) return missing("I-E10-18", "falta el estado de imputación del presupuesto y del real")
  if (!c.publishesByDimension) {
    return info("I-E10-18", "el informe no publica desviación por dimensión en niveles ≥ MC3: no hay nada que comparar")
  }
  if (!c.withAllocations) {
    return c.publishedByDimensionCells === 0
      ? pass("I-E10-18", "el informe se pide sin imputación: las celdas por dimensión de MC3 y superiores no se publican")
      : failed(
          "I-E10-18",
          `el informe se pide sin imputación y aun así publica ${c.publishedByDimensionCells} celda(s) por dimensión de MC3 o superior`
        )
  }
  const mismas = c.rulesHash !== null && c.budgetRulesHash !== null && c.rulesHash === c.budgetRulesHash
  if (mismas) {
    return pass(
      "I-E10-18",
      `presupuesto y real imputados con las MISMAS reglas (${(c.rulesHash as string).slice(0, 12)}…): ` +
        `${c.publishedByDimensionCells} celda(s) por dimensión publicadas y ${c.notPublishedCells} sin publicar`
    )
  }
  // En ningún caso se produce una matriz mixta: si el presupuesto no se puede
  // liquidar con las mismas reglas, las celdas por dimensión NO se calculan.
  return c.publishedByDimensionCells === 0
    ? pass(
        "I-E10-18",
        `el presupuesto no está imputado con las mismas reglas que el real (${c.budgetRulesHash ?? "sin liquidar"} ≠ ` +
          `${c.rulesHash ?? "sin liquidar"}): las ${c.notPublishedCells} celda(s) afectadas salen NO PUBLICADAS, nunca calculadas`
      )
    : failed(
        "I-E10-18",
        `presupuesto y real imputados con reglas distintas (${c.budgetRulesHash ?? "sin liquidar"} ≠ ` +
          `${c.rulesHash ?? "sin liquidar"}) y el informe publica ${c.publishedByDimensionCells} celda(s) por dimensión: ` +
          "sería comparar dos medidas distintas"
      )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución completa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los **dieciocho** resultados, siempre en el mismo orden y **siempre los
 * dieciocho**. Lo no evaluable sale `INFO` diciendo qué falta: una organización
 * sin presupuesto ni horas no ve un solo FAIL, y tampoco un PASS que nadie ha
 * comprobado.
 */
export function runBudgetInvariants(input: BudgetInvariantInput): CheckResult[] {
  const { budget, time } = input
  return [
    checkIE101(budget),
    checkIE102(budget),
    checkIE103(time),
    checkIE104(time),
    checkIE105(time),
    checkIE106(budget),
    checkIE107(budget),
    checkIE108(budget),
    checkIE109(budget),
    checkIE1010(time),
    checkIE1011(time),
    checkIE1012(time),
    checkIE1013(budget),
    checkIE1014(budget),
    checkIE1015(budget),
    checkIE1016(budget),
    checkIE1017(time),
    checkIE1018(budget),
  ]
}

/**
 * Los motivos de sello que aporta el bloque, compuestos **a partir de los
 * datos** y no de los checks: lección **H-4 de E7**, el sello se calcula después
 * de los motivos y `seal` y `sealReasons` dicen lo mismo.
 */
export function budgetSealReasons(input: {
  /** EV-11: el `budgetHash` del periodo cambia respecto del run anterior. */
  budgetHash?: string | null
  previousBudgetHash?: string | null
  /** EV-12: no hay versión vigente para el periodo. */
  hasActiveBudget?: boolean
  /** Los cuatro KPI de umbral que han disparado. */
  firedThresholds?: readonly string[]
  /** EV-15 / EV-16: los avisos del run de liquidación. */
  allocationSealReasons?: readonly ("HORAS_SIN_APROBAR" | "PLANTILLA_AUSENTE")[]
  /** EV-17: partes sin tarifa y el informe publica coste-hora. */
  unpricedTimeEntries?: number
  publishesHourlyCost?: boolean
}): E10SealReason[] {
  const out = new Set<E10SealReason>()
  if (
    input.previousBudgetHash !== undefined &&
    input.previousBudgetHash !== null &&
    input.budgetHash !== undefined &&
    input.budgetHash !== null &&
    input.previousBudgetHash !== input.budgetHash
  ) {
    out.add("DESVIACION_PRESUPUESTO")
  }
  if ((input.firedThresholds ?? []).length > 0) out.add("DESVIACION_PRESUPUESTO")
  if (input.hasActiveBudget === false) out.add("PRESUPUESTO_AUSENTE")
  for (const reason of input.allocationSealReasons ?? []) out.add(reason)
  if ((input.unpricedTimeEntries ?? 0) > 0 && input.publishesHourlyCost === true) out.add("TARIFA_AUSENTE")
  return [...out].sort()
}

/** Re-exportado para que el borde no tenga que importar dos módulos. */
export { timeSealOf }
