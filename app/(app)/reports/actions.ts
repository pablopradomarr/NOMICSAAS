"use server"

/**
 * E6 · T14 — Server actions de los informes financieros (§4 del diseño).
 *
 * Matriz de roles (la UI la refleja, no la decide):
 *
 * | Acción                                              | Rol mínimo |
 * |-----------------------------------------------------|-----------|
 * | `getReportAction` (balance, PyG, cashflow, panel)     | `VIEWER`  |
 * | `listRunsAction`, `runDetailAction`, `runDiffAction`  | `VIEWER`  |
 * | `exportReportAction`                                  | `VIEWER`  |
 * | `forceReviewAction`, `clearReviewAction`              | **ADMIN** |
 * | `setReviewThresholdsAction`                           | **ADMIN** |
 *
 * Emitir un informe **escribe** un `ReportRun`, y aun así es `VIEWER`: un
 * informe emitido es un HECHO fechado, no una mutación de negocio. Lo contrario
 * —exigir EDITOR para mirar el balance— dejaría sin trazabilidad justo al perfil
 * que más consulta.
 *
 * Ninguna acción calcula nada: componen el contexto, llaman a `models/reports.ts`
 * y traducen el error a español. «Hoy» se decide AQUÍ, en el borde, nunca dentro
 * de `lib/ledger/`.
 */

import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import {
  balanceParamsSchema,
  cashflowParamsSchema,
  clearReviewSchema,
  exportReportSchema,
  forceReviewSchema,
  listRunsSchema,
  pygParamsSchema,
  reviewThresholdsSchema,
} from "@/forms/reports"
import { exportRun, type ExportFormat } from "@/lib/export/report-export"
import { NOTA_NO_COMPENSACION } from "@/lib/ledger/reports/balance"
import { CASHFLOW_HEADER_NOTE } from "@/lib/ledger/reports/cashflow"
import { AGING_GROUPING_NOTE } from "@/lib/ledger/reports/aging"
import {
  clearManualReviewFlag,
  diffAgainstPrevious,
  getOrCreateReportRun,
  getReportRun,
  listManualReviewFlags,
  listReportRuns,
  setManualReviewFlag,
  setReviewThresholds,
  type ReportDiffRow,
  type ReportRunView,
} from "@/models/reports"
import { ReportType, Role } from "@/prisma/client"

const REPORTS_PATH = "/reports"

function invalid(error: z.ZodError): ActionState<never> {
  const issue = error.issues[0]
  return { success: false, error: issue?.message ?? "Datos inválidos" }
}

const failure = (error: unknown): ActionState<never> => ({
  success: false,
  error: error instanceof Error ? error.message : "No se ha podido completar la operación",
})

// ─────────────────────────────────────────────────────────────────────────────
// Lectura de informes — VIEWER
// ─────────────────────────────────────────────────────────────────────────────

/** Balance de situación. La foto y la variante van en `params` (O-5). */
export const balanceAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<ReportRunView>> => {
    const parsed = balanceParamsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { periodStart, periodEnd, fiscalYearId, comparativeBasis, ...params } = parsed.data
    try {
      const run = await getOrCreateReportRun(org.id, {
        type: ReportType.BALANCE,
        periodStart,
        periodEnd,
        ...(fiscalYearId ? { fiscalYearId } : {}),
        ...(comparativeBasis ? { comparativeBasis } : {}),
        params: { ...params, variant: params.variant ?? org.pgcVariant },
        actor: { userId: user.id },
      })
      return { success: true, data: run }
    } catch (error) {
      return failure(error)
    }
  }
)

export const pygAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<ReportRunView>> => {
    const parsed = pygParamsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { periodStart, periodEnd, fiscalYearId, comparativeBasis, ...params } = parsed.data
    try {
      const run = await getOrCreateReportRun(org.id, {
        type: ReportType.PYG,
        periodStart,
        periodEnd,
        ...(fiscalYearId ? { fiscalYearId } : {}),
        ...(comparativeBasis ? { comparativeBasis } : {}),
        params: { ...params, variant: params.variant ?? org.pgcVariant },
        actor: { userId: user.id },
      })
      return { success: true, data: run }
    } catch (error) {
      return failure(error)
    }
  }
)

/**
 * Cashflow. Devuelve SIEMPRE las tres vistas (directo mensual, indirecto y EFE
 * oficial A–E) en el mismo run: son tres lecturas del mismo hecho y separarlas
 * en tres runs invitaría a que divergieran.
 */
export const cashflowAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<ReportRunView>> => {
    const parsed = cashflowParamsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const { periodStart, periodEnd, fiscalYearId, ...params } = parsed.data
    try {
      const run = await getOrCreateReportRun(org.id, {
        type: params.method === "INDIRECTO" ? ReportType.CASHFLOW_INDIRECTO : ReportType.CASHFLOW_DIRECTO,
        periodStart,
        periodEnd,
        ...(fiscalYearId ? { fiscalYearId } : {}),
        params,
        actor: { userId: user.id },
      })
      return { success: true, data: run }
    } catch (error) {
      return failure(error)
    }
  }
)

export const listRunsAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<ReportRunView[]>> => {
    const parsed = listRunsSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    try {
      return { success: true, data: await listReportRuns(tenantDb(org.id), parsed.data) }
    } catch (error) {
      return failure(error)
    }
  }
)

export const runDetailAction = withOrg(
  Role.VIEWER,
  async ({ org }, runId: string): Promise<ActionState<ReportRunView>> => {
    const parsed = z.string().uuid().safeParse(runId)
    if (!parsed.success) return { success: false, error: "El informe pedido no existe" }
    try {
      const run = await getReportRun(tenantDb(org.id), parsed.data)
      // RLS + tenant: un run de otra organización no se distingue de uno que no
      // existe, y así debe quedarse.
      if (!run) return { success: false, error: "El informe pedido no existe" }
      return { success: true, data: run }
    } catch (error) {
      return failure(error)
    }
  }
)

/** Diff contra el run comparado (O-6): sin él, el motivo del sello no se audita. */
export const runDiffAction = withOrg(
  Role.VIEWER,
  async ({ org }, runId: string): Promise<ActionState<{ comparativeRunId: string | null; rows: ReportDiffRow[] }>> => {
    const parsed = z.string().uuid().safeParse(runId)
    if (!parsed.success) return { success: false, error: "El informe pedido no existe" }
    try {
      const db = tenantDb(org.id)
      const run = await getReportRun(db, parsed.data)
      if (!run) return { success: false, error: "El informe pedido no existe" }
      return { success: true, data: await diffAgainstPrevious(db, run) }
    } catch (error) {
      return failure(error)
    }
  }
)

export type ExportedReport = {
  filename: string
  contentType: string
  /** El binario en base64: una server action no devuelve `Buffer`. */
  base64: string
  sha256: string
}

/**
 * Export CSV/XLSX/PDF de un run YA emitido. No recalcula nada: exporta la foto
 * congelada, que es lo único que el sello acredita.
 */
export const exportReportAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown): Promise<ActionState<ExportedReport>> => {
    const parsed = exportReportSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const run = await getReportRun(tenantDb(org.id), parsed.data.runId)
      if (!run) return { success: false, error: "El informe pedido no existe" }
      const exported = await exportRun(
        {
          id: run.id,
          type: run.type,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          ledgerHash: run.ledgerHash,
          gitSha: run.gitSha,
          seal: run.seal,
          sealReasons: run.sealReasons,
          validation: run.validation,
          provenance: run.provenance,
          result: run.result,
          params: run.params,
        },
        parsed.data.format as ExportFormat,
        notesFor(run.type)
      )
      return {
        success: true,
        data: {
          filename: exported.filename,
          contentType: exported.contentType,
          base64: exported.body.toString("base64"),
          sha256: exported.sha256,
        },
      }
    } catch (error) {
      return failure(error)
    }
  }
)

/** Notas al pie obligatorias por tipo de informe. */
function notesFor(type: ReportType): string[] {
  if (type === ReportType.BALANCE) return [NOTA_NO_COMPENSACION]
  if (type === ReportType.CASHFLOW_DIRECTO || type === ReportType.CASHFLOW_INDIRECTO) return [CASHFLOW_HEADER_NOTE]
  if (type === ReportType.DASHBOARD) return [AGING_GROUPING_NOTE]
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// Revisión manual — ADMIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fuerza la revisión de un periodo. Un `EDITOR` recibe «Sin permiso» y **no se
 * escribe nada**: `withOrg` corta antes de llegar al modelo.
 */
export const forceReviewAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = forceReviewSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const flag = await setManualReviewFlag(
        org.id,
        {
          periodStart: parsed.data.periodStart,
          periodEnd: parsed.data.periodEnd,
          scope: parsed.data.scope ?? null,
          reason: parsed.data.reason,
        },
        { userId: user.id, role: "ADMIN" }
      )
      revalidatePath(REPORTS_PATH)
      return { success: true, data: { id: flag.id } }
    } catch (error) {
      return failure(error)
    }
  }
)

/** Levanta un flag. No lo borra: marca `cleared` con autor y motivo. */
export const clearReviewAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = clearReviewSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const flag = await clearManualReviewFlag(org.id, parsed.data, { userId: user.id, role: "ADMIN" })
      revalidatePath(REPORTS_PATH)
      return { success: true, data: { id: flag.id } }
    } catch (error) {
      return failure(error)
    }
  }
)

export const listReviewFlagsAction = withOrg(Role.VIEWER, async ({ org }, activeOnly: boolean = true) => {
  try {
    return { success: true, data: await listManualReviewFlags(tenantDb(org.id), { activeOnly }) }
  } catch (error) {
    return failure(error)
  }
})

export const setReviewThresholdsAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<unknown>> => {
    const parsed = reviewThresholdsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    try {
      const saved = await setReviewThresholds(org.id, parsed.data, { userId: user.id, role: "ADMIN" })
      revalidatePath("/settings/reports")
      return { success: true, data: saved }
    } catch (error) {
      return failure(error)
    }
  }
)
