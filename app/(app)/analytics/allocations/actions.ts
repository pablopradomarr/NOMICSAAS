"use server"

/**
 * E5 · T10 — Server actions de la liquidación de CECOs
 * (`docs/design/E5-liquidacion.md` §4.2).
 *
 * Todas empiezan por `withOrg(<rol>)` y devuelven `ActionState`. **Ninguna
 * calcula**: componen el contexto, delegan en `models/allocations.ts` —que a su
 * vez delega en `lib/analytics/allocate.ts`, puro— y traducen el resultado a
 * español contable. `refDate` se decide AQUÍ, en el borde.
 *
 * Matriz de roles (§4.2), con las dos divergencias de Pablo respecto del experto
 * documentadas:
 *
 * | Acción                                            | Rol mínimo |
 * |---|---|
 * | listar reglas, runs, detalle, diff y **simular**  | `VIEWER`   |
 * | crear, versionar y cerrar una regla · `MANUAL`    | `ADMIN`    |
 * | **liquidar** (sellar el run)                      | `EDITOR`   |
 * | **revertir** con motivo ≥ 10 caracteres           | `EDITOR`   |
 *
 * Una regla mueve dinero entre columnas de todos los informes de gestión: es
 * política, y por eso es `ADMIN`. Liquidar es aplicar una política que un ADMIN
 * ya aprobó, y por eso es `EDITOR`. La simulación es un dry-run que no escribe
 * nada, así que no exige permiso de escritura: es además la vía por la que un
 * controller comprueba una regla antes de pedir que se aplique.
 */

import {
  allocationDiffSchema,
  allocationPeriodSchema,
  allocationReverseSchema,
  allocationRuleCloseSchema,
  allocationRuleCreateSchema,
  allocationRuleListSchema,
  allocationRuleSetCreateSchema,
  allocationRuleSupersedeSchema,
  allocationRunIdSchema,
  allocationRunListSchema,
  allocationSealSchema,
} from "@/forms/allocations"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantDb, tenantTransaction } from "@/lib/db"
import type { AllocationResult } from "@/lib/analytics/allocate"
import { listHeadcount } from "@/models/employees"
import { listTimeEntries } from "@/models/time"
import type { TenantTransactionClient } from "@/lib/db"
import {
  closeAllocationRuleTx,
  createAllocationRuleTx,
  createAllocationRulesTx,
  diffAllocationRuns,
  getAllocationRun,
  listAllocationRules,
  listAllocationRuns,
  previewAllocationRun,
  reverseAllocationRunTx,
  sealAllocationRunTx,
  supersedeAllocationRuleTx,
  type AllocationDiffRow,
  type AllocationPreview,
  type AllocationRuleListItem,
  type AllocationRunDetail,
  type AllocationRunListItem,
  type AllocationSeals,
} from "@/models/allocations"
import { formatLedgerErrors, runLedgerTransaction, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const ALLOCATIONS_PATH = "/analytics/allocations"
const PYG_PATH = "/analytics/pyg"

const gitSha = (): string => process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "desconocido"

function invalid(error: z.ZodError): ActionState<never> {
  const issue = error.issues[0]
  return { success: false, error: issue ? issue.message : "Datos inválidos" }
}

function toActionState<T>(result: LedgerResult<T>): ActionState<T> {
  return result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }
}

/**
 * Liquidar **caduca** `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD` del
 * periodo, y SÓLO esos: `ledgerHash` no cambia, así que balance, PyG contable,
 * cashflow y diario conservan su caché (ADR-0010, criterio 17).
 */
function revalidateAnalytics(): void {
  revalidatePath(ALLOCATIONS_PATH)
  revalidatePath(PYG_PATH)
}

// ─────────────────────────────────────────────────────────────────────────────
// E10 · T14 — ADR-0013 D4, punto 1: ninguna regla de actividad INERTE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Con `HORAS` o `PLANTILLA`, la organización tiene que tener el módulo de horas
 * encendido **y** al menos un dato de la clase que el driver consume —un parte
 * **aprobado**, o un snapshot de plantilla— en el ejercicio de `validFrom`.
 *
 * El `CHECK allocation_rules_driver_available` desapareció con E10 (los drivers
 * ya existen), así que la garantía de que **una regla no nace muerta** vive aquí,
 * en el sellado del run y en el aviso de base parcial (§3.6). El mensaje dice
 * **qué falta y dónde darlo de alta**: un «driver no disponible» mudo obliga al
 * usuario a adivinar.
 */
async function assertActivityDriverAvailable(
  tx: TenantTransactionClient,
  rules: readonly { code: string; driver: string; validFrom: string }[]
): Promise<string | null> {
  const activity = rules.filter((r) => r.driver === "HOURS" || r.driver === "HEADCOUNT")
  if (activity.length === 0) return null

  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: tx.$organizationId },
    select: { timeTrackingEnabled: true },
  })

  for (const rule of activity) {
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: { startDate: { lte: new Date(`${rule.validFrom}T00:00:00.000Z`) }, endDate: { gte: new Date(`${rule.validFrom}T00:00:00.000Z`) } },
      select: { code: true, startDate: true, endDate: true },
    })
    if (!fiscalYear) {
      return `la regla ${rule.code} empieza el ${rule.validFrom}, que no cae en ningún ejercicio de la organización`
    }
    const from = fiscalYear.startDate.toISOString().slice(0, 10)
    const to = fiscalYear.endDate.toISOString().slice(0, 10)

    if (rule.driver === "HOURS") {
      if (!organization.timeTrackingEnabled) {
        return (
          `el driver HORAS necesita el módulo de partes de horas, y esta organización lo tiene apagado. ` +
          `Actívalo en Configuración → Horas`
        )
      }
      const approved = await listTimeEntries(tx, { from, to, status: "APROBADO" }, { take: 1 })
      if (approved.total === 0) {
        return (
          `el driver HORAS necesita partes de horas aprobados: la organización no tiene ninguno en ${fiscalYear.code}. ` +
          `Actívalos en Configuración → Horas y aprueba al menos un parte`
        )
      }
    } else {
      const snapshots = await listHeadcount(tx, { from, to })
      if (snapshots.length === 0) {
        return (
          `el driver PLANTILLA necesita snapshots de plantilla: la organización no tiene ninguno en ${fiscalYear.code}. ` +
          `Regístralos en Configuración → Plantilla, o derívalos de los empleados`
        )
      }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas y simulación (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

/** Reglas vigentes (y cerradas si se piden) con su vigencia y nº de líneas. */
export const listAllocationRulesAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown = {}): Promise<ActionState<AllocationRuleListItem[]>> => {
    const parsed = allocationRuleListSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rules = await listAllocationRules(tenantDb(org.id), parsed.data)
    return { success: true, data: rules }
  }
)

export type AllocationPreviewPayload = {
  result: AllocationResult
  seals: AllocationSeals
  summary: AllocationPreview["summary"]
}

/**
 * **Dry-run puro: no escribe nada.** Es lo que hace que un run sellado nunca
 * sorprenda — el usuario aprueba EXACTAMENTE lo que se va a persistir— y por eso
 * es obligatorio antes de sellar.
 */
export const previewAllocationAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<AllocationPreviewPayload>> => {
    const parsed = allocationPeriodSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    // #15: la simulación es un dry-run de rol VIEWER; la transacción es de
    // SÓLO LECTURA, como el resto de las lecturas. Abrirla de escritura tomaba
    // un slot de escritura del pool para no escribir nada.
    const result = await runLedgerTransaction(
      org.id,
      null,
      async (tx) => {
        const preview = await previewAllocationRun(tx, parsed.data)
        return { result: preview.result, seals: preview.seals, summary: preview.summary }
      },
      { readOnly: true }
    )
    return toActionState(result)
  }
)

export const listAllocationRunsAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown = {}): Promise<ActionState<AllocationRunListItem[]>> => {
    const parsed = allocationRunListSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    // `STALE` es DERIVADO (§3.5): se calcula comparando los sellos del run con
    // los del periodo hoy. Nunca se almacena, así que nunca se queda obsoleto ni
    // exige un cron que lo mantenga.
    //
    // **E10 · deuda §0-bis #6** — la derivación va por LOTE
    // (`allocationRunStalenessBatch`, dentro de `listAllocationRuns`): tres
    // consultas sea cual sea el número de runs, frente a las ~17 del bucle de
    // E5. Y con E10 hay una CUARTA causa de `STALE`: el `timeHash` de la ventana
    // del run, que cambia en cuanto se aprueba un parte tardío.
    const runs = await tenantTransaction(org.id, async (tx) =>
      listAllocationRuns(tx, { ...parsed.data, deriveStaleness: true })
    )
    return { success: true, data: runs }
  }
)

export const getAllocationRunAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<AllocationRunDetail>> => {
    const parsed = allocationRunIdSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const run = await getAllocationRun(tenantDb(org.id), parsed.data.runId)
    if (!run) return { success: false, error: "La liquidación no existe en esta organización" }
    return { success: true, data: run }
  }
)

/** Diff celda a celda contra el run anterior del mismo periodo. */
export const diffAllocationRunsAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<AllocationDiffRow[]>> => {
    const parsed = allocationDiffSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const rows = await diffAllocationRuns(tenantDb(org.id), parsed.data)
    return { success: true, data: rows }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Política de reglas (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export const createAllocationRuleAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<AllocationRuleListItem>> => {
    const parsed = allocationRuleCreateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const unavailable = await assertActivityDriverAvailable(tx, [
        { code: data.code, driver: data.driver, validFrom: data.validFrom },
      ])
      if (unavailable) throw new Error(unavailable)
      return createAllocationRuleTx(
        tx,
        {
          code: data.code,
          name: data.name,
          sourceCostCenterId: data.sourceCostCenterId,
          targetKind: data.targetKind,
          driver: data.driver,
          period: data.period,
          priority: data.priority,
          sourceShareBps: data.sourceShareBps,
          zeroBaseFallback: data.zeroBaseFallback,
          targetFilter: data.targetFilter ?? null,
          validFrom: data.validFrom,
          validTo: data.validTo ?? null,
          targets: data.targets.map((t) => ({
            projectId: t.projectId ?? null,
            businessLineId: t.businessLineId ?? null,
            costCenterId: t.costCenterId ?? null,
            percentBps: t.percentBps ?? null,
            amountCents: t.amountCents ?? null,
          })),
        },
        { userId: user.id }
      )
    })
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)

/**
 * Alta del CONJUNTO de reglas de un CECO fuente, en una sola transacción.
 *
 * Es la vía para declarar un reparto fraccionado: `Σ sourceShareBps = 10000` se
 * comprueba sobre el conjunto entero. Con una sola regla equivale a
 * `createAllocationRuleAction`.
 */
export const createAllocationRuleSetAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<AllocationRuleListItem[]>> => {
    const parsed = allocationRuleSetCreateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const unavailable = await assertActivityDriverAvailable(
        tx,
        parsed.data.map((d) => ({ code: d.code, driver: d.driver, validFrom: d.validFrom }))
      )
      if (unavailable) throw new Error(unavailable)
      return createAllocationRulesTx(
        tx,
        parsed.data.map((data) => ({
          code: data.code,
          name: data.name,
          sourceCostCenterId: data.sourceCostCenterId,
          targetKind: data.targetKind,
          driver: data.driver,
          period: data.period,
          priority: data.priority,
          sourceShareBps: data.sourceShareBps,
          zeroBaseFallback: data.zeroBaseFallback,
          targetFilter: data.targetFilter ?? null,
          validFrom: data.validFrom,
          validTo: data.validTo ?? null,
          targets: data.targets.map((t) => ({
            projectId: t.projectId ?? null,
            businessLineId: t.businessLineId ?? null,
            costCenterId: t.costCenterId ?? null,
            percentBps: t.percentBps ?? null,
            amountCents: t.amountCents ?? null,
          })),
        })),
        { userId: user.id }
      )
    })
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)

/**
 * Versiona la regla: cierra la vigente y crea la sucesora con el mismo `code`.
 * **Nunca edita una regla con líneas emitidas** — reescribiría en silencio
 * liquidaciones ya emitidas y haría irreproducible cualquier informe histórico.
 */
export const supersedeAllocationRuleAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<AllocationRuleListItem>> => {
    const parsed = allocationRuleSupersedeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      if (data.changes.driver) {
        const unavailable = await assertActivityDriverAvailable(tx, [
          { code: data.ruleId, driver: data.changes.driver, validFrom: data.validFrom },
        ])
        if (unavailable) throw new Error(unavailable)
      }
      return supersedeAllocationRuleTx(
        tx,
        {
          ruleId: data.ruleId,
          validFrom: data.validFrom,
          reason: data.reason,
          changes: {
            ...data.changes,
            targetFilter: data.changes.targetFilter ?? null,
            validTo: data.changes.validTo ?? null,
          },
        },
        { userId: user.id }
      )
    })
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)

export const closeAllocationRuleAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = allocationRuleCloseSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await closeAllocationRuleTx(tx, parsed.data, { userId: user.id })
      return null
    })
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo del run (EDITOR)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sella la liquidación del periodo. Si algo ha cambiado entre simular y sellar
 * —un asiento tardío, una reclasificación, una regla nueva— responde
 * `LIQUIDACION_DESFASADA` y **no persiste lo aprobado**: obliga a resimular.
 */
export const sealAllocationRunAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<AllocationRunDetail>> => {
    const parsed = allocationSealSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      sealAllocationRunTx(
        tx,
        {
          periodKind: data.periodKind,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
          gitSha: gitSha(),
          expectedHashes: data.expectedHashes,
          supersede: data.supersede,
          reason: data.reason ?? null,
        },
        { userId: user.id }
      )
    )
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)

/**
 * Apaga un run **sin** sustituirlo. `reason` ≥ 10 caracteres, y la reversión
 * **no genera ningún asiento** (ADR-0004): el `ledgerHash` del periodo queda
 * idéntico. El run revertido deja de aportar y sigue consultable.
 */
export const reverseAllocationRunAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = allocationReverseSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    // «Ahora» se decide en el BORDE: ni `models/` ni `lib/analytics/` construyen
    // fechas por su cuenta.
    const reversedAt = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await reverseAllocationRunTx(tx, { ...parsed.data, reversedAt }, { userId: user.id })
      return null
    })
    if (result.ok) revalidateAnalytics()
    return toActionState(result)
  }
)
