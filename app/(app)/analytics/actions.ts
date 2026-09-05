"use server"

/**
 * E4 · T12 — Server actions de la analítica (`docs/design/E4-analitica.md` §4).
 *
 * Todas empiezan por `withOrg(<rol>)` y devuelven `ActionState`. **Ninguna
 * calcula**: componen el contexto, delegan en `models/analytics.ts` y
 * `models/margins.ts` (que a su vez delegan en `lib/analytics/**`, puro) y
 * traducen el resultado a mensajes en español.
 *
 * Matriz de roles (§4):
 * | Acción | Rol mínimo |
 * |---|---|
 * | lecturas y el informe | `VIEWER` |
 * | alta/edición de proyecto, LN y CECO (nombre/orden) | `EDITOR` |
 * | `kind`/`marginLevel`/`allocatable` de un CECO, archivar, reabrir | `ADMIN` |
 * | `MarginLevelConfig`, política analítica, `analyticType` de cuenta | `ADMIN` |
 * | reclasificación | `EDITOR` mes abierto · `ADMIN` mes bloqueado · nadie con ejercicio cerrado |
 *
 * `refDate` («hoy») se decide AQUÍ, en el borde, nunca dentro de `lib/analytics/`.
 */

import {
  accountAnalyticTypeSchema,
  analyticPnlSchema,
  cellDetailSchema,
  analyticsPolicySchema,
  archiveDimensionSchema,
  businessLineCreateSchema,
  businessLineUpdateSchema,
  costCenterCreateSchema,
  costCenterUpdateSchema,
  dimensionListSchema,
  marginLevelConfigSchema,
  projectCloseSchema,
  projectCreateSchema,
  projectReopenSchema,
  projectUpdateSchema,
  reclassifySchema,
} from "@/forms/analytics"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import type { AnalyticPnl } from "@/lib/analytics/margins"
import type { AnalyticsConfig, ColumnKey, LocalDate } from "@/lib/analytics/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import {
  archiveDimension,
  closeProject,
  createAnalyticProject,
  createBusinessLine,
  createCostCenter,
  getAnalyticsConfig,
  listBusinessLines,
  listCostCenters,
  listProjects,
  reclassifyLines,
  reopenProject,
  setOrganizationAnalyticsPolicy,
  updateAccountAnalyticType,
  updateAnalyticProject,
  updateBusinessLine,
  updateCostCenter,
  updateMarginLevelConfig,
  type BusinessLineListItem,
  type CostCenterListItem,
  type ProjectListItem,
  type ReclassifyResult,
} from "@/models/analytics"
import { formatLedgerErrors, runLedgerTransaction, todayLocalDate, type LedgerResult } from "@/models/ledger"
import { getAnalyticPnl, getCellDetail, type CellDetail } from "@/models/margins"
import { Role } from "@/prisma/client"
import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const ANALYTICS_PATH = "/analytics"

/** «Hoy» en la zona de la organización. El motor puro no lo calcula nunca. */
const today = (): LocalDate => todayLocalDate()

const gitSha = (): string => process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "desconocido"

function invalid(error: z.ZodError): ActionState<never> {
  const issue = error.issues[0]
  return { success: false, error: issue ? issue.message : "Datos inválidos" }
}

function toActionState<T>(result: LedgerResult<T>): ActionState<T> {
  return result.ok ? { success: true, data: result.value } : { success: false, error: formatLedgerErrors(result.errors) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export type AnalyticsListing = {
  businessLines: BusinessLineListItem[]
  projects: ProjectListItem[]
  costCenters: CostCenterListItem[]
}

/** Las tres dimensiones con recuento de líneas e importe imputado. */
export const listAnalyticsAction = withOrg(
  Role.VIEWER,
  async ({ db }, input: unknown = {}): Promise<ActionState<AnalyticsListing>> => {
    const parsed = dimensionListSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    // En SERIE por la misma razón que dentro de cada listado: `tenantDb` abre
    // una transacción por operación y lanzarlas a la vez dispara el aviso del
    // adaptador `pg` cuando el llamante ya tiene una abierta.
    const businessLines = await listBusinessLines(db, parsed.data)
    const projects = await listProjects(db, parsed.data)
    const costCenters = await listCostCenters(db, parsed.data)
    return { success: true, data: { businessLines, projects, costCenters } }
  }
)

export type AnalyticPnlPayload = {
  pnl: AnalyticPnl
  config: AnalyticsConfig
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  checks: CheckResult[]
  runId: string
  gitSha: string
}

/** PyG analítica del periodo, con sus tres sellos y el bloque de invariantes. */
export const analyticPnlAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<AnalyticPnlPayload>> => {
    const parsed = analyticPnlSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const runId = randomUUID()
    const sha = gitSha()
    // E4-UI-1.b: una excepción del motor analítico NO tumba /analytics/pyg. Se
    // devuelve el motivo y la pantalla lo pinta como REQUIERE REVISIÓN, sin
    // pintar media matriz.
    let report
    try {
      report = await tenantTransaction(org.id, async (tx) =>
        getAnalyticPnl(tx, {
          from: parsed.data.from,
          to: parsed.data.to,
          ...(parsed.data.fiscalYearId ? { fiscalYearId: parsed.data.fiscalYearId } : {}),
          provenance: { runId, gitSha: sha, baseCurrency: org.baseCurrency },
        })
      )
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error)
      return { success: false, error: `REQUIERE REVISIÓN — el motor analítico ha fallado: ${motivo}` }
    }
    // Hallazgo #5: `lineDetail` NO viaja al cliente. Son 85 objetos en el
    // fixture y decenas de miles en un ejercicio real, para pintar una tabla de
    // 8 × N celdas que no los usa; el drill-down los pide celda a celda con
    // `analyticCellDetailAction`. Los agregados y la provenance sí viajan: son
    // 8 × N entradas y son lo que la pantalla enseña.
    const payload: AnalyticPnlPayload = {
      ...report,
      pnl: { ...report.pnl, lineDetail: [], coveredLineIds: new Set<string>() },
      runId,
      gitSha: sha,
    }
    return { success: true, data: payload }
  }
)

/**
 * Detalle de UNA celda de la matriz, **bajo demanda** (hallazgo #5).
 *
 * La pantalla no recibe ninguna línea del diario al cargar: pinta la matriz con
 * los agregados y, cuando el usuario pincha una celda, pide sólo esa. La
 * consulta que se ejecuta es exactamente la de la provenance de esa celda, así
 * que la suma que devuelve es por construcción la que se muestra.
 */
export const analyticCellDetailAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<CellDetail>> => {
    const parsed = cellDetailSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const detail = await tenantTransaction(org.id, async (tx) =>
      getCellDetail(tx, {
        level: parsed.data.level,
        column: parsed.data.column as ColumnKey,
        from: parsed.data.from,
        to: parsed.data.to,
        ...(parsed.data.fiscalYearId ? { fiscalYearId: parsed.data.fiscalYearId } : {}),
      })
    )
    return { success: true, data: detail }
  }
)

/** Configuración analítica vigente para el periodo (la consume la UI). */
export const getAnalyticsConfigAction = withOrg(
  Role.VIEWER,
  async ({ org }, periodEnd?: string): Promise<ActionState<AnalyticsConfig>> => {
    const at = periodEnd ?? today()
    const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: at }))
    return { success: true, data: config }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// CRUD de dimensiones
// ─────────────────────────────────────────────────────────────────────────────

export const createBusinessLineAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = businessLineCreateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      createBusinessLine(tx, parsed.data, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/business-lines`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

export const updateBusinessLineAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = businessLineUpdateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { id, ...rest } = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      updateBusinessLine(tx, id, rest, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/business-lines`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

export const createProjectAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = projectCreateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      createAnalyticProject(tx, parsed.data, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/projects`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

export const updateProjectAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = projectUpdateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { id, ...rest } = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      updateAnalyticProject(tx, id, rest, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/projects`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

export const closeProjectAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = projectCloseSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      closeProject(tx, parsed.data.id, parsed.data.closedAt, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/projects`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

/** Reabrir es ADMIN: deshace un cierre que ya ha servido para decidir. */
export const reopenProjectAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = projectReopenSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      reopenProject(tx, parsed.data.id, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/projects`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

export const createCostCenterAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = costCenterCreateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      createCostCenter(tx, parsed.data, { userId: user.id })
    )
    revalidatePath(`${ANALYTICS_PATH}/cost-centers`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

/**
 * `EDITOR` para nombre y orden; **`ADMIN`** para `kind`, `marginLevel` y
 * `allocatable`, que mueven importe entre niveles de la matriz.
 */
export const updateCostCenterAction = withOrg(
  Role.EDITOR,
  async ({ org, user, role }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = costCenterUpdateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { id, ...rest } = parsed.data
    const structural = rest.kind !== undefined || rest.marginLevel !== undefined || rest.allocatable !== undefined
    if (structural && role !== Role.ADMIN) {
      return { success: false, error: "El tipo, el nivel de margen y la imputabilidad de un CECO sólo los cambia un ADMIN" }
    }
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => updateCostCenter(tx, id, rest, { userId: user.id }))
    revalidatePath(`${ANALYTICS_PATH}/cost-centers`)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

/** Nada se borra: se archiva, con motivo. `CC-NA` y la LN de sistema, nunca. */
export const archiveDimensionAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = archiveDimensionSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const now = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      archiveDimension(tx, parsed.data.kind, parsed.data.id, parsed.data.reason, { userId: user.id }, now)
    )
    revalidatePath(ANALYTICS_PATH)
    return toActionState(result.ok ? { ok: true, value: { id: result.value.id } } : result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Configuración (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export const updateMarginLevelConfigAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ versions: number }>> => {
    const parsed = marginLevelConfigSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      updateMarginLevelConfig(tx, parsed.data, { userId: user.id })
    )
    revalidatePath("/settings/analytics")
    return toActionState(result.ok ? { ok: true, value: { versions: result.value.length } } : result)
  }
)

export const setAnalyticsPolicyAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = analyticsPolicySchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await setOrganizationAnalyticsPolicy(tx, parsed.data, { userId: user.id })
      return null
    })
    revalidatePath("/settings/analytics")
    return toActionState(result)
  }
)

/** O-A9: mueve importe entre niveles en todos los periodos abiertos. */
export const updateAccountAnalyticTypeAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ accountCode: string }>> => {
    const parsed = accountAnalyticTypeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      updateAccountAnalyticType(tx, parsed.data.accountCode, parsed.data.analyticType, parsed.data.reason, {
        userId: user.id,
      })
    )
    revalidatePath("/settings/accounts")
    return toActionState(result.ok ? { ok: true, value: { accountCode: result.value.code } } : result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Reclasificación analítica (ADR-0010)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `EDITOR` con el mes abierto, **`ADMIN`** con el mes bloqueado del ejercicio
 * abierto, **nadie** con el ejercicio cerrado. La ventana la resuelve
 * `checkReclassify` (puro) con el rol que se le pasa desde aquí, y el trigger
 * `journal_lines_reclassify_window` la repite en la base.
 */
export const reclassifyLinesAction = withOrg(
  Role.EDITOR,
  async ({ org, user, role }, input: unknown): Promise<ActionState<ReclassifyResult>> => {
    const parsed = reclassifySchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await reclassifyLines(
      org.id,
      { reason: parsed.data.reason, targets: parsed.data.targets },
      { userId: user.id, role },
      { refDate: today() }
    )
    revalidatePath(ANALYTICS_PATH)
    revalidatePath("/ledger")
    return toActionState(result)
  }
)
