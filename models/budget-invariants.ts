/**
 * E10 · ronda 1 · auditor **H-1 (GRAVE)** — el bloque `budget` / `time` del
 * barrido de invariantes.
 *
 * `runInvariantsPure` ejecuta los dieciocho `I-E10-*` `if (input.budget ||
 * input.time)`, y **nadie rellenaba esos dos bloques**: `runBudgetInvariants` y
 * `budgetSealReasons` no tenían un solo llamante fuera de `lib/` y de sus
 * tests, la familia `PRESUPUESTO` de `/audit` salía siempre `SIN_EVALUAR` y los
 * cinco motivos de sello de E10 nunca llegaban al sello del periodo. Es
 * literalmente el **H-2 de E9** («el bloque `closing`, que nadie rellenaba»)
 * repetido, y el propio comentario de `models/ledger.ts` lo documentaba.
 *
 * Aquí se compone el bloque desde la base, por el mismo patrón que
 * `readClosingInvariantInput`:
 *
 *  · **sólo en el barrido de auditoría y con un ejercicio en el alcance** — los
 *    invariantes de presupuesto son de un ejercicio concreto, y una cabecera de
 *    informe no paga por lo que no usa;
 *  · **en serie** — dentro de la transacción hay una sola conexión;
 *  · **sin calcular nada**: el `budgetHash` recomputado sale de
 *    `lib/budget/hash.ts` y la matriz de `lib/budget/matrix.ts`, que son los
 *    mismos módulos puros que produjeron el sello. Este fichero sólo LEE.
 *
 * Lo que no se puede componer sale **omitido**, nunca falseado: el check
 * correspondiente responde `INFO` diciendo qué falta (contrato de
 * `runBudgetInvariants`), y jamás un PASS por vacuidad.
 */

import { budgetHash as computeBudgetHash } from "@/lib/budget/hash"
import { budgetSealReasons, type E10SealReason } from "@/lib/budget/invariants-e10"
import { buildBudgetMatrix } from "@/lib/budget/matrix"
import { fiscalYearMonths, monthKey, type LocalDate } from "@/lib/budget/types"
import type { Cents } from "@/lib/analytics/types"
import type {
  AllocationRunAudit,
  BudgetBlock,
  BudgetLineRef,
  BudgetVersionRef,
  PayrollAbsorptionRef,
  TimeBlock,
  TimeEntryAudit,
} from "@/lib/budget/invariants-e10"
import type { AnalyticsConfig } from "@/lib/analytics/types"
import type { TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { getBudgetVersion } from "@/models/budget"
import { getEmployeeRateRows, listHeadcount } from "@/models/employees"
import { costOfTime, rateAt, type EmployeeRateRow } from "@/lib/time/cost"
import { getTimeRowsForWindow } from "@/models/time"

export type BudgetTimeInvariantInput = {
  budget?: BudgetBlock
  time?: TimeBlock
}

/** Lo que el barrido necesita: los dos bloques **y** los motivos de sello. */
export type BudgetInvariantRead = BudgetTimeInvariantInput & {
  /** ADR-0018 D5, compuestos por `budgetSealReasons()` a partir de los DATOS. */
  sealReasons: E10SealReason[]
}

/**
 * Compone los dos bloques de E10 para un ejercicio. Devuelve `{}` cuando la
 * organización no tiene ni una versión de presupuesto ni un parte de horas: en
 * ese caso `runInvariants` omite los dieciocho checks, que es lo que el contrato
 * pide (una organización sin presupuesto no ve dieciocho INFO inútiles).
 */
export async function readBudgetInvariantInput(
  tx: TenantTransactionClient,
  opts: { fiscalYearId: string; config: AnalyticsConfig; publishesHourlyCost?: boolean }
): Promise<BudgetInvariantRead> {
  const fy = await tx.fiscalYear.findFirst({
    where: { id: opts.fiscalYearId },
    select: { id: true, code: true, startDate: true, endDate: true },
  })
  if (!fy) return { sealReasons: [] }
  const start = fromUtcDate(fy.startDate)
  const end = fromUtcDate(fy.endDate)
  const months = fiscalYearMonths(start, end)

  const budget = await readBudgetBlock(tx, { fiscalYearId: fy.id, code: fy.code, start, end, months }, opts.config)
  const time = await readTimeBlock(
    tx,
    { fiscalYearId: fy.id, code: fy.code, start, end },
    opts.config,
    opts.publishesHourlyCost === true
  )

  // ADR-0018 D5 — los motivos se componen **de los datos**, no de los checks
  // (lección H-4 de E7: el sello se calcula DESPUÉS de los motivos, y `seal` y
  // `sealReasons` dicen lo mismo). `TARIFA_AUSENTE` sólo se arma cuando el
  // llamante publica coste-hora: el barrido de `/audit` no lo publica.
  const sealReasons =
    budget === undefined && time === undefined
      ? []
      : budgetSealReasons({
          ...(budget ? { hasActiveBudget: budget.versions.some((v) => v.status === "VIGENTE") } : {}),
          ...(time ? { allocationSealReasons: allocationSealReasonsOf(time) } : {}),
          ...(time && opts.publishesHourlyCost === true
            ? { unpricedTimeEntries: unpricedApprovedEntries(time), publishesHourlyCost: true }
            : {}),
        })

  return {
    ...(budget ? { budget } : {}),
    ...(time ? { time } : {}),
    sealReasons,
  }
}

/**
 * EV-15 / EV-16 — los avisos de actividad de los runs sellados del ejercicio,
 * traducidos a los dos motivos de sello que les corresponden. Se leen del propio
 * `AllocationRun.warnings`, que es la memoria de por qué el reparto salió así.
 */
function allocationSealReasonsOf(time: TimeBlock): ("HORAS_SIN_APROBAR" | "PLANTILLA_AUSENTE")[] {
  const out = new Set<"HORAS_SIN_APROBAR" | "PLANTILLA_AUSENTE">()
  for (const code of (time.runs ?? []).flatMap((r) => r.warningCodes ?? [])) {
    if (code === "W-E10-UNAPPROVED-HOURS") out.add("HORAS_SIN_APROBAR")
    if (code === "W-E10-NO-HEADCOUNT" || code === "W-E10-HEADCOUNT-TRAPPED") out.add("PLANTILLA_AUSENTE")
  }
  return [...out].sort()
}

/** EV-17: partes aprobados sin tarifa vigente ese día. Nunca se aplica 0. */
function unpricedApprovedEntries(time: TimeBlock): number {
  if (!time.rates) return 0
  return time.entries.filter(
    (row) => row.approved && row.minutes !== 0 && rateAt(time.rates ?? [], row.employeeId, row.date).kind === "MISSING"
  ).length
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloque `budget`
// ─────────────────────────────────────────────────────────────────────────────

type FiscalYearRef = { fiscalYearId: string; code: string; start: LocalDate; end: LocalDate; months: string[] }

async function readBudgetBlock(
  tx: TenantTransactionClient,
  fy: FiscalYearRef,
  config: AnalyticsConfig
): Promise<BudgetBlock | undefined> {
  const headers = await tx.budget.findMany({
    where: { fiscalYearId: fy.fiscalYearId },
    orderBy: [{ validFrom: "asc" }, { revision: "asc" }],
    select: { id: true },
  })
  if (headers.length === 0) return undefined

  const versions: BudgetVersionRef[] = []
  const lines: BudgetLineRef[] = []
  let effective: Awaited<ReturnType<typeof getBudgetVersion>> | null = null

  for (const { id } of headers) {
    const v = await getBudgetVersion(tx, id)
    if (!v) continue
    const monthsCovered = [...new Set(v.cells.map((c) => monthKey(c.month)))].sort()
    versions.push({
      code: v.code,
      fiscalYearCode: fy.code,
      scenario: v.scenario,
      revision: v.revision,
      status: v.status,
      validFrom: v.validFrom,
      validTo: v.validTo,
      partialFrom: v.partialFrom,
      budgetHash: v.seals.budgetHash,
      // I-E10-6 se juega aquí: el hash se recomputa **sobre lo que la fila y sus
      // líneas tienen hoy**, con el `marginConfigHash` que la propia versión
      // selló. Con el de hoy, cualquier cambio de la configuración de márgenes
      // habría producido un FAIL indistinguible de una manipulación.
      recomputedHash:
        v.status === "BORRADOR" || v.seals.marginConfigHash === null
          ? null
          : computeBudgetHash(v, v.seals.marginConfigHash),
      monthsCovered,
    })
    for (const cell of v.cells) {
      lines.push({
        versionCode: v.code,
        month: cell.month,
        dimensionKind: cell.dimension.kind,
        dimensionCode: cell.dimension.code,
        businessLineCode: cell.dimension.kind === "PROJECT" ? cell.dimension.businessLineCode : null,
        ...(cell.dimension.kind === "PROJECT"
          ? { projectBusinessLineCode: businessLineCodeOfProject(config, cell.dimension.code) }
          : {}),
        accountCode: cell.accountCode,
        analyticType: cell.analyticType,
        marginLevel: cell.marginLevel,
        amountCents: cell.amountCents,
        signException: cell.signException,
      })
    }
    // La versión que gobierna el ejercicio para la matriz: la última no parcial
    // sellada. `composeBudget` la usa igual, y aquí se evita rehacer la
    // composición sólo para I-E10-1.
    if (v.status !== "BORRADOR" && v.partialFrom === null) effective = v
  }

  const matrix = effective
    ? (() => {
        const built = buildBudgetMatrix(effective, config, { from: fy.start, to: fy.end })
        // I-E10-1 contrasta `levelTotalsCents[ℓ]` contra la **Σ de las líneas
        // cuyo `marginLevel` es ℓ**, así que aquí va el APORTE por nivel, no la
        // matriz CUMULATIVA de presentación: con la cumulativa, MC1 arrastraría
        // INGRESOS y el invariante fallaría sobre datos perfectos.
        const sumOf = (byColumn: Record<string, number>): number =>
          Object.values(byColumn).reduce((a, b) => a + b, 0)
        const levelTotalsCents = Object.fromEntries(
          Object.entries(built.contributionByLevelCents).map(([level, byColumn]) => [level, sumOf(byColumn)])
        )
        // Y el desglose por mes, del mismo aporte: recomponerlo desde
        // `built.byMonth` (cumulativa) diría otra cosa.
        const byMonthCents: Record<string, Record<string, number>> = {}
        for (const month of built.months) byMonthCents[month] = {}
        for (const cell of built.cells) {
          const month = monthKey(cell.month)
          if (byMonthCents[month] === undefined) byMonthCents[month] = {}
          byMonthCents[month][cell.marginLevel] = (byMonthCents[month][cell.marginLevel] ?? 0) + cell.amountCents
        }
        // Denso: todo nivel presente en el anual existe en cada mes, aunque a 0.
        for (const month of Object.keys(byMonthCents)) {
          for (const level of Object.keys(levelTotalsCents)) {
            byMonthCents[month][level] = byMonthCents[month][level] ?? 0
          }
        }
        return {
          levelTotalsCents,
          byMonthCents,
          unresolved: built.unresolved.map((u) => `${u.code} · ${u.message}`),
        }
      })()
    : undefined

  // I-E10-1 compara la matriz contra las líneas de TODAS las versiones, así que
  // cuando hay matriz sólo entran las de la versión que la produjo.
  const linesForMatrix = effective ? lines.filter((l) => l.versionCode === effective.code) : lines

  return {
    versions,
    lines: matrix ? linesForMatrix : lines,
    fiscalYear: { code: fy.code, start: fy.start, end: fy.end, months: fy.months },
    ...(matrix ? { matrix } : {}),
  }
}

const businessLineCodeOfProject = (config: AnalyticsConfig, projectCode: string): string | null => {
  const project = config.projects.find((p) => p.code === projectCode)
  if (!project) return null
  return config.businessLines.find((b) => b.id === project.businessLineId)?.code ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloque `time`
// ─────────────────────────────────────────────────────────────────────────────

async function readTimeBlock(
  tx: TenantTransactionClient,
  fy: { fiscalYearId: string; code: string; start: LocalDate; end: LocalDate },
  config: AnalyticsConfig,
  publishesHourlyCost: boolean
): Promise<TimeBlock | undefined> {
  const window = { from: fy.start, to: fy.end }
  const base = await getTimeRowsForWindow(tx, window)
  if (base.length === 0) {
    const anyRates = await tx.employeeRate.count()
    if (anyRates === 0) return undefined
  }

  // Lo que `getTimeRowsForWindow` no trae y I-E10-4 / I-E10-10 necesitan.
  const extra = await tx.timeEntry.findMany({
    where: { date: { gte: toUtcDate(fy.start), lte: toUtcDate(fy.end) } },
    select: { id: true, correctsEntryId: true, correctionReason: true },
  })
  const extraById = new Map(extra.map((e) => [e.id, e]))

  const entries: TimeEntryAudit[] = base.map((row) => {
    const more = extraById.get(row.id)
    return {
      ...row,
      reversesId: more?.correctsEntryId ?? null,
      reason: more?.correctionReason ?? null,
    }
  })

  const rates = await getEmployeeRateRows(tx, window)
  const headcount = (await listHeadcount(tx, { from: fy.start, to: fy.end })).map((h) => ({
    costCenterId: h.costCenterId,
    costCenterCode: h.costCenterCode,
    periodEnd: h.periodEnd,
    fteMilli: h.fteMilli,
  }))
  const year = fy.start.slice(0, 4)
  const lockedMonths = (
    await tx.periodLock.findMany({ where: { fiscalYearId: fy.fiscalYearId }, select: { month: true } })
  ).map((l) => `${year}-${String(l.month).padStart(2, "0")}`)

  const runs = await readAllocationRunAudits(tx, fy, config)
  const payroll = payrollAbsorptionOf(fy.code, entries, rates, window, await payrollOfFiscalYear(tx, fy))

  return {
    entries,
    rates,
    headcount,
    runs,
    fiscalYearWindow: window,
    lockedMonths,
    payroll,
    publishesHourlyCost,
  }
}

/**
 * Los runs SELLADOS del ejercicio con sus líneas y las reglas con las que
 * repartieron. Tres consultas, no una por run: I-E10-3, I-E10-11 y I-E10-17 las
 * recorren enteras.
 */
async function readAllocationRunAudits(
  tx: TenantTransactionClient,
  fy: { fiscalYearId: string; start: LocalDate; end: LocalDate },
  config: AnalyticsConfig
): Promise<AllocationRunAudit[]> {
  const runRows = await tx.allocationRun.findMany({
    where: { fiscalYearId: fy.fiscalYearId, status: "SEALED" },
    orderBy: [{ periodStart: "asc" }, { periodKind: "asc" }],
    select: {
      id: true,
      periodKind: true,
      periodStart: true,
      periodEnd: true,
      timeHash: true,
      timeHashWindowStart: true,
      timeHashWindowEnd: true,
      warnings: true,
    },
  })
  if (runRows.length === 0) return []

  const lineRows = await tx.allocationLine.findMany({
    where: { runId: { in: runRows.map((r) => r.id) } },
    select: {
      runId: true,
      driverBase: true,
      driverBaseTotal: true,
      fallbackApplied: true,
      targetProjectId: true,
      targetBusinessLineId: true,
      targetCostCenterId: true,
      rule: { select: { code: true, driver: true, targetKind: true } },
    },
  })

  // `AllocationLine` no tiene relación de navegación a los tres receptores (son
  // ids sueltos con FK compuesta): el código sale de la configuración analítica
  // que ya está en memoria, no de tres JOIN más.
  const codeById = new Map<string, string>([
    ...config.projects.map((p) => [p.id, p.code] as const),
    ...config.costCenters.map((c) => [c.id, c.code] as const),
    ...config.businessLines.map((b) => [b.id, b.code] as const),
  ])

  const { getAllocationRuleSpecs } = await import("@/models/allocations")
  const byRunLines = new Map<string, AllocationRunAudit["lines"][number][]>()
  for (const l of lineRows) {
    const targetId = l.targetProjectId ?? l.targetBusinessLineId ?? l.targetCostCenterId ?? ""
    const targetCode = codeById.get(targetId) ?? "?"
    byRunLines.set(l.runId, [
      ...(byRunLines.get(l.runId) ?? []),
      {
        ruleCode: l.rule.code,
        driver: l.rule.driver as AllocationRunAudit["lines"][number]["driver"],
        targetKind: l.rule.targetKind as AllocationRunAudit["lines"][number]["targetKind"],
        targetCode,
        targetId,
        driverBase: Number(l.driverBase),
        driverBaseTotal: Number(l.driverBaseTotal),
        fallbackApplied: (l.fallbackApplied as AllocationRunAudit["lines"][number]["fallbackApplied"]) ?? null,
      },
    ])
  }

  const out: AllocationRunAudit[] = []
  for (const run of runRows) {
    const periodEnd = fromUtcDate(run.periodEnd)
    const rules = await getAllocationRuleSpecs(tx, { periodEnd })
    out.push({
      runId: run.id,
      period: {
        kind: run.periodKind as AllocationRunAudit["period"]["kind"],
        label: periodLabelOf(run.periodKind, fromUtcDate(run.periodStart)),
        start: fromUtcDate(run.periodStart),
        end: periodEnd,
        fiscalYearId: fy.fiscalYearId,
        fiscalYearStart: fy.start,
        fiscalYearEnd: fy.end,
      },
      rules,
      lines: byRunLines.get(run.id) ?? [],
      timeHash: run.timeHash,
      timeHashWindowStart: run.timeHashWindowStart ? fromUtcDate(run.timeHashWindowStart) : null,
      timeHashWindowEnd: run.timeHashWindowEnd ? fromUtcDate(run.timeHashWindowEnd) : null,
      warningCodes: warningCodesOf(run.warnings),
    })
  }
  return out
}

/** `AllocationRun.warnings` es `Json`: se lee defensivamente, nunca se confía. */
function warningCodesOf(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return []
  return warnings
    .map((w) => (w !== null && typeof w === "object" && "code" in w ? String((w as { code: unknown }).code) : null))
    .filter((c): c is string => c !== null)
}

const periodLabelOf = (kind: string, start: LocalDate): string => {
  if (kind === "YEAR") return start.slice(0, 4)
  if (kind === "QUARTER") return `${start.slice(0, 4)}-Q${Math.floor(Number(start.slice(5, 7)) / 3) + 1}`
  return start.slice(0, 7)
}

/**
 * **I-E10-12**, la guarda: *el personal imputado a proyectos por horas no puede
 * exceder al contabilizado en 64x*.
 *
 * **Ronda 3 · el único punto accionable del auditor.** Las dos mitades de la
 * comparación estaban mal elegidas, y con la regla del propio diseño daba FAIL
 * sobre datos íntegros:
 *
 *  · **El «imputado» no es «lo repartido por un driver `HOURS`».** El driver
 *    dice **cómo** se reparte un saldo, no **qué** es: el saldo de `CC-OPS`
 *    lleva su 628 de suministros además de su nómina, y contarlo entero como
 *    personal imputado infla el numerador con gasto que no es de personal.
 *    Mirar la línea de ORIGEN y no el driver es lo que distingue una cosa de la
 *    otra — y en cuanto se hace, lo que queda es exactamente **el coste de las
 *    horas valoradas a tarifa**, que es lo que el fixture sella (O-E10-20) y lo
 *    que el informe de absorción publica. Se usa esa magnitud, la misma
 *    `costOfTime()` del producto, en vez de una segunda definición paralela.
 *  · **La comparación es del EJERCICIO, no mes a mes.** La nómina se devenga
 *    con su calendario (pagas extra, finiquitos) y las horas con el suyo; exigir
 *    la cota en cada mes convierte un desfase de calendario en un descuadre.
 *    §5.2 define la absorción sobre el periodo del informe, y el fixture la
 *    sella así: **2 617 213 c valorados ≤ 2 640 000 c de 64x**.
 *
 * Sigue siendo una GUARDA y no una medida: la infraabsorción —que aquí es de
 * 22 787 c— la publica el informe (O-E10-20), porque endurecer esto a igualdad
 * sería exigir horas y tarifas perfectas.
 */
function payrollAbsorptionOf(
  fyCode: string,
  entries: readonly TimeEntryAudit[],
  rates: readonly EmployeeRateRow[],
  window: { from: LocalDate; to: LocalDate },
  payrollCents: Cents
): PayrollAbsorptionRef[] {
  const valued = costOfTime(entries, rates, window).totals.valuedCents
  if (valued === 0 && payrollCents === 0) return []
  return [{ periodLabel: fyCode, valuedCents: valued, payrollCents }]
}

/** Σ (debe − haber) de las 64x del ejercicio, sin regularización ni cierre. */
async function payrollOfFiscalYear(
  tx: TenantTransactionClient,
  fy: { start: LocalDate; end: LocalDate }
): Promise<Cents> {
  const [row] = await tx.$queryRaw<{ cents: bigint | null }[]>`
    SELECT COALESCE(SUM(jl.debit_cents - jl.credit_cents), 0)::bigint AS cents
      FROM journal_lines jl
      JOIN journal_entries je
        ON je.id = jl.entry_id AND je.organization_id = jl.organization_id
     WHERE jl.organization_id = ${tx.$organizationId}::uuid
       AND je.entry_date BETWEEN ${toUtcDate(fy.start)}::date AND ${toUtcDate(fy.end)}::date
       -- La MISMA convencion que la PyG (I3, lib/analytics/margins.ts): el
       -- asiento de regularizacion ABONA las 640/642 para llevarlas a la 129, y
       -- sin excluirlo la nomina del ejercicio salia NEGATIVA y la guarda leia
       -- 0 <= -2 640 000 como un exceso: todo ejercicio cerrado quedaba en FAIL
       -- con los datos intactos (regresion GRAVE de la ronda 1).
       AND jl.entry_kind NOT IN ('REGULARIZATION', 'CLOSING', 'OPENING')
       AND (jl.account_code LIKE '640%' OR jl.account_code LIKE '642%'
            OR jl.account_code LIKE '645%' OR jl.account_code LIKE '649%')`
  return Number(row?.cents ?? 0)
}
