"use server"

/**
 * E5 · T11/T12/T13 — Acciones de apoyo de las pantallas de liquidación.
 *
 * Mismo papel que `app/(app)/ledger/ui-actions.ts`: el formulario manda
 * **cadenas** (un importe manual se teclea `"1.899,54"`, una cuota `"30"`) y es
 * AQUÍ, en el servidor, donde se convierten a céntimos enteros y a puntos
 * básicos con `lib/money.parseCents`. El navegador nunca decide un céntimo.
 * Hecha la conversión, se delega en las acciones de T10
 * (`app/(app)/analytics/allocations/actions.ts`), que son las que comprueban el
 * rol, validan con `zod` y llaman al motor.
 *
 * Aquí **no se calcula ninguna cifra contable**: se traduce entrada de
 * formulario, se leen agregados ya calculados y se compone la respuesta.
 */

import {
  createAllocationRuleSetAction,
  supersedeAllocationRuleAction,
} from "@/app/(app)/analytics/allocations/actions"
import type { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { allocationCellQuery } from "@/lib/analytics/margins"
import type { AnalyticPnl } from "@/lib/analytics/margins"
import type { AnalyticsConfig, ColumnKey, MarginLevel } from "@/lib/analytics/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import { parseCents } from "@/lib/money"
import { getAnalyticsConfig } from "@/models/analytics"
import { getAppliedAllocations, type AllocationRuleListItem } from "@/models/allocations"
import { getAnalyticPnl } from "@/models/margins"
import { Role } from "@/prisma/client"
import { randomUUID } from "node:crypto"

const gitSha = (): string => process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "desconocido"

// ─────────────────────────────────────────────────────────────────────────────
// Formulario de reglas: texto → céntimos / puntos básicos, EN EL SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────

/** Un destino tal y como lo teclea el formulario: porcentaje o importe, en texto. */
export type RawRuleTarget = {
  projectId?: string | null
  businessLineId?: string | null
  costCenterId?: string | null
  /** `"60"` o `"60,00"` → 6000 bps. */
  percentText?: string | null
  /** `"1.899,54"` → 189954 céntimos. */
  amountText?: string | null
}

export type RawRule = {
  code: string
  name: string
  sourceCostCenterId: string
  targetKind: string
  driver: string
  period: string
  priority: string
  /** Cuota del saldo del CECO que ESTA regla declara repartir, en texto. */
  sourceSharePercentText: string
  zeroBaseFallback: string
  validFrom: string
  validTo?: string | null
  onlyActiveProjects?: boolean
  targets: RawRuleTarget[]
}

/**
 * `"30"` / `"30,5"` → puntos básicos enteros. `parseCents` ya hace exactamente
 * esa conversión (dos decimales → entero), así que se reutiliza en vez de
 * escribir otro parser de números con coma decimal.
 */
const percentToBps = (text: string | null | undefined): number | null => parseCents(text ?? null)

function toRuleInput(raw: RawRule): Record<string, unknown> {
  const isPercentDriver = raw.driver === "FIXED_PERCENT"
  const isManual = raw.driver === "MANUAL"
  return {
    code: raw.code,
    name: raw.name,
    sourceCostCenterId: raw.sourceCostCenterId,
    targetKind: raw.targetKind,
    driver: raw.driver,
    period: raw.period,
    priority: Number.parseInt(raw.priority, 10),
    sourceShareBps: percentToBps(raw.sourceSharePercentText) ?? 0,
    zeroBaseFallback: raw.zeroBaseFallback,
    targetFilter: raw.onlyActiveProjects === true ? { projectStatus: ["ACTIVE"] } : null,
    validFrom: raw.validFrom,
    validTo: raw.validTo && raw.validTo.trim() !== "" ? raw.validTo : null,
    targets:
      isPercentDriver || isManual
        ? raw.targets
            .filter((t) => t.projectId || t.businessLineId || t.costCenterId)
            .map((t) => ({
              projectId: t.projectId ?? null,
              businessLineId: t.businessLineId ?? null,
              costCenterId: t.costCenterId ?? null,
              percentBps: isPercentDriver ? (percentToBps(t.percentText) ?? 0) : null,
              amountCents: isManual ? (parseCents(t.amountText ?? null) ?? 0) : null,
            }))
        : [],
  }
}

/**
 * Alta del CONJUNTO de reglas de un centro de coste fuente. El reparto
 * fraccionado (30/70) se declara entero, en una sola transacción, porque
 * `Σ sourceShareBps = 10000` se juzga sobre el conjunto.
 */
export async function createAllocationRuleSetFromFormAction(
  raws: readonly RawRule[]
): Promise<ActionState<AllocationRuleListItem[]>> {
  return await createAllocationRuleSetAction(raws.map(toRuleInput))
}

/** Versionado de una regla: cierra la vigente y crea la sucesora con los cambios. */
export async function supersedeAllocationRuleFromFormAction(input: {
  ruleId: string
  validFrom: string
  reason: string
  raw: RawRule
}): Promise<ActionState<AllocationRuleListItem>> {
  const changes = toRuleInput(input.raw)
  delete changes.code
  delete changes.validFrom
  return await supersedeAllocationRuleAction({
    ruleId: input.ruleId,
    validFrom: input.validFrom,
    reason: input.reason,
    changes,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PyG analítica CON imputaciones (T13)
// ─────────────────────────────────────────────────────────────────────────────

export type AllocatedPnlPayload = {
  pnl: AnalyticPnl
  config: AnalyticsConfig
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  /** El CUARTO sello (O-E5-7). `sha256("")` cuando no hay imputaciones. */
  allocationRunSetHash: string
  allocationRunIds: string[]
  withAllocations: boolean
  checks: CheckResult[]
  runId: string
  gitSha: string
}

/**
 * La MISMA matriz de E4 con el toggle «con imputaciones» activado: suma las
 * líneas de los `AllocationRun` vigentes del periodo y compone el
 * `analyticsHash` con el `allocationRunSetHash` real, de modo que la caché
 * nunca sirve el informe imputado por el que no lo está (ni al revés).
 */
export const allocatedPnlAction = withOrg(
  Role.VIEWER,
  async (
    { org },
    input: { from: string; to: string; fiscalYearId?: string }
  ): Promise<ActionState<AllocatedPnlPayload>> => {
    const runId = randomUUID()
    const sha = gitSha()
    let report
    try {
      report = await tenantTransaction(org.id, async (tx) =>
        getAnalyticPnl(tx, {
          from: input.from,
          to: input.to,
          ...(input.fiscalYearId ? { fiscalYearId: input.fiscalYearId } : {}),
          withAllocations: true,
          provenance: { runId, gitSha: sha, baseCurrency: org.baseCurrency },
        })
      )
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error)
      return { success: false, error: `REQUIERE REVISIÓN — el motor analítico ha fallado: ${motivo}` }
    }
    return {
      success: true,
      data: {
        ...report,
        pnl: { ...report.pnl, lineDetail: [], coveredLineIds: new Set<string>() },
        runId,
        gitSha: sha,
      },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down de una celda IMPUTADA (§3.2: la segunda consulta de la provenance)
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationCellLine = {
  runId: string
  ruleCode: string
  sourceCostCenterCode: string
  targetCode: string
  targetKind: string
  marginLevel: string
  /** Convención de la MATRIZ (aporte): el coste que llega al receptor resta. */
  amountCents: number
  driverBase: number
  driverBaseTotal: number
  driverShareBps: number
  fallbackApplied: string | null
}

export type AllocationCellDetail = {
  level: string
  column: string
  /** La consulta parametrizada que produce estas líneas (provenance, §7). */
  query: string
  parameters: string[]
  runIds: string[]
  amountCents: number
  lines: AllocationCellLine[]
}

/**
 * Las `AllocationLine` que aportan a una celda de la matriz imputada.
 *
 * Una celda MC3 de proyecto con imputaciones **no** se reproduce con una sola
 * consulta al diario: parte del importe viene de `allocation_lines`. Esto es la
 * segunda mitad de su provenance, y es lo que hace que el drill-down no mienta
 * por omisión.
 */
export const allocationCellDetailAction = withOrg(
  Role.VIEWER,
  async (
    { org },
    input: { level: string; column: string; from: string; to: string }
  ): Promise<ActionState<AllocationCellDetail>> => {
    const payload = await tenantTransaction(org.id, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: input.to })
      const applied = await getAppliedAllocations(tx, { from: input.from, to: input.to })
      return { config, applied }
    })
    const { config, applied } = payload
    const { query, params } = allocationCellQuery(
      input.level as MarginLevel,
      input.column as ColumnKey,
      config,
      applied.runIds
    )

    // El filtro es el MISMO que el de la consulta de provenance de arriba,
    // aplicado sobre las líneas que la matriz ya ha sumado: no hay una segunda
    // lectura que pueda divergir de la cifra pintada.
    const matches = applied.lines.filter((line) => {
      if (line.marginLevel !== input.level) return false
      if (input.column.startsWith("PROJ:")) {
        return line.target.kind === "PROJECT" && line.target.code === input.column.slice(5)
      }
      if (input.column.startsWith("BL:")) {
        return line.target.kind === "BUSINESS_LINE" && line.target.code === input.column.slice(3)
      }
      if (input.column.startsWith("CECO:")) {
        const kind = input.column.slice(5)
        const codes = new Set(config.costCenters.filter((c) => c.kind === kind).map((c) => c.code))
        return codes.has(line.sourceCostCenterCode) || (line.target.kind === "COST_CENTER" && codes.has(line.target.code))
      }
      return false
    })

    const lines: AllocationCellLine[] = matches.map((line) => ({
      runId: line.runId,
      ruleCode: line.ruleCode,
      sourceCostCenterCode: line.sourceCostCenterCode,
      targetCode: line.target.code,
      targetKind: line.target.kind,
      marginLevel: line.marginLevel,
      // La línea se guarda en convención de COSTE; la matriz habla en aporte.
      amountCents: -line.amountCents,
      driverBase: line.driverBase,
      driverBaseTotal: line.driverBaseTotal,
      driverShareBps: line.driverShareBps,
      fallbackApplied: line.fallbackApplied,
    }))

    return {
      success: true,
      data: {
        level: input.level,
        column: input.column,
        query,
        parameters: params.map((p) => (Array.isArray(p) ? `[${p.length}]` : String(p))),
        runIds: applied.runIds,
        amountCents: lines.reduce((acc, l) => acc + l.amountCents, 0),
        lines,
      },
    }
  }
)
