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
import type { AllocationRuleListItem } from "@/models/allocations"
import { parseCents } from "@/lib/money"

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

/**
 * **Aquí no hay más.** La PyG analítica con imputaciones es
 * `analyticPnlAction({ …, withAllocations: true })` y el drill-down de la parte
 * imputada de una celda es `allocationCellDetailAction`, las dos en
 * `app/(app)/analytics/actions.ts` junto a las de E4: son el MISMO informe con
 * un parámetro más, no un informe paralelo, y duplicar la acción habría
 * duplicado también la composición del `analyticsHash`.
 */
