"use server"

/**
 * E10 · T14 — Server actions del **presupuesto** (§4.2 del diseño).
 *
 * Todas empiezan por `withOrg(<rol>)` y devuelven `ActionState`. **Ninguna
 * calcula**: componen el contexto, delegan en `models/budget.ts` —que delega en
 * `lib/budget/**`, puro— y traducen el error a español contable con su salida
 * (`forms/e10-errors.ts`). `refDate`, `sealedAt` y el `gitSha` se deciden AQUÍ,
 * en el borde: ni el modelo ni el motor leen un reloj.
 *
 * | Acción | Rol |
 * |---|---|
 * | `listBudgetsAction`, `getBudgetAction`, `budgetDiffAction` | `VIEWER` |
 * | `upsertBudgetCellsAction`, `deleteBudgetCellsAction`, `upsertBudgetHoursAction`, `importBudgetCsvAction`, `proposeDepreciationBudgetAction` | `EDITOR` |
 * | `createBudgetVersionAction`, `sealBudgetAction`, `supersedeBudgetAction` | **`ADMIN`** |
 *
 * Sellar un presupuesto fija el patrón de medida de toda la compañía: es
 * política, no operación (mismo criterio que `createAllocationRuleAction`). Un
 * `EDITOR` teclea el presupuesto; un `ADMIN` decide cuál rige.
 */

import { parseCsvRows } from "@/lib/accounts/csv"
import {
  budgetDiffSchema,
  budgetIdSchema,
  budgetListSchema,
  createBudgetVersionSchema,
  deleteBudgetCellsSchema,
  importBudgetCsvSchema,
  proposeDepreciationBudgetSchema,
  sealBudgetSchema,
  supersedeBudgetSchema,
  upsertBudgetCellsSchema,
  upsertBudgetHoursSchema,
  BUDGET_CSV_COLUMNS,
} from "@/forms/budget"
import { formatE10Errors } from "@/forms/e10-errors"
import { ActionState } from "@/lib/actions"
import { marginConfigHash } from "@/lib/analytics/hash"
import type { AnalyticType, AnalyticsConfig } from "@/lib/analytics/types"
import { withOrg } from "@/lib/authz"
import { tenantDb, tenantTransaction } from "@/lib/db"
import { checkBudgetSign, detectInvertedSignConvention } from "@/lib/budget/hash"
import type { BudgetCell } from "@/lib/budget/types"
import { getAnalyticsConfig } from "@/models/analytics"
import {
  createBudgetVersionTx,
  deleteBudgetCellsTx,
  getBudgetVersion,
  importBudgetCsvTx,
  listBudgets,
  proposeDepreciationBudget,
  resolveBudgetMarginLevel,
  sealBudgetTx,
  supersedeBudgetTx,
  upsertBudgetCellsTx,
  upsertBudgetHoursTx,
  type BudgetCellInput,
  type BudgetImportReport,
  type BudgetListItem,
  type DepreciationBudgetProposal,
  type StoredBudgetVersion,
  type UpsertCellsResult,
} from "@/models/budget"
import { runLedgerTransaction, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const BUDGET_PATH = "/analytics/budget"
const BUDGET_VS_ACTUAL_PATH = "/analytics/budget-vs-actual"

const gitSha = (): string => process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "desconocido"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatE10Errors(result.errors) }

function revalidateBudget(): void {
  revalidatePath(BUDGET_PATH)
  revalidatePath(BUDGET_VS_ACTUAL_PATH)
}

// ─────────────────────────────────────────────────────────────────────────────
// Contratos de salida (C2 y C3 arrancan de aquí)
// ─────────────────────────────────────────────────────────────────────────────

/** Una celda que cambia entre dos versiones, con su Δ en céntimos. */
export type BudgetDiffRow = {
  key: string
  month: string
  accountCode: string | null
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionCode: string
  analyticType: AnalyticType
  fromCents: number | null
  toCents: number | null
  deltaCents: number
}

export type BudgetDiffPayload = {
  from: { budgetId: string; label: string }
  to: { budgetId: string; label: string }
  rows: readonly BudgetDiffRow[]
  totalDeltaCents: number
}

export type SealBudgetPayload = {
  budgetId: string
  budgetHash: string
  closedPreviousId: string | null
  closedPreviousTo: string | null
  warnings: readonly { code: string; message: string }[]
}

/** Informe del import, con su `dry-run`. Un contador sin motivos no se audita. */
export type BudgetImportPayload = BudgetImportReport & { dryRun: boolean; parsed: number }

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

export const listBudgetsAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown = {}): Promise<ActionState<BudgetListItem[]>> => {
    const parsed = budgetListSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await listBudgets(tenantDb(org.id), parsed.data)
    return { success: true, data: rows }
  }
)

/** Cabecera + celdas + horas de UNA versión, con sus tres sellos. */
export const getBudgetAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<StoredBudgetVersion>> => {
    const parsed = budgetIdSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const version = await tenantTransaction(org.id, user.id, async (tx) => getBudgetVersion(tx, parsed.data.budgetId))
    if (!version) return { success: false, error: "La versión de presupuesto no existe en esta organización" }
    return { success: true, data: version }
  }
)

const diffKey = (c: { month: string; accountCode: string | null; dimension: { kind: string; code: string }; analyticType: string }): string =>
  `${c.month}|${c.accountCode ?? "∅"}|${c.dimension.kind}:${c.dimension.code}|${c.analyticType}`

/**
 * **Diff entre dos versiones**, celda a celda. Es lo que un CFO pide para ver
 * *qué cambió la reproyección*, y lo que la doctrina de «sustituir, no corregir»
 * hace posible: las dos versiones siguen ahí, enteras.
 */
export const budgetDiffAction = withOrg(
  Role.VIEWER,
  async ({ org, user }, input: unknown): Promise<ActionState<BudgetDiffPayload>> => {
    const parsed = budgetDiffSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const pair = await tenantTransaction(org.id, user.id, async (tx) => {
      // En SERIE: dentro de una transacción hay UNA conexión (regla de E6-perf).
      const from = await getBudgetVersion(tx, parsed.data.againstBudgetId)
      const to = await getBudgetVersion(tx, parsed.data.budgetId)
      return { from, to }
    })
    if (!pair.from || !pair.to) return { success: false, error: "Alguna de las dos versiones no existe en esta organización" }

    const rows = new Map<string, BudgetDiffRow>()
    const put = (cell: BudgetCell, side: "from" | "to"): void => {
      const key = diffKey(cell)
      const row = rows.get(key) ?? {
        key,
        month: cell.month,
        accountCode: cell.accountCode,
        dimensionKind: cell.dimension.kind,
        dimensionCode: cell.dimension.code,
        analyticType: cell.analyticType,
        fromCents: null,
        toCents: null,
        deltaCents: 0,
      }
      if (side === "from") row.fromCents = (row.fromCents ?? 0) + cell.amountCents
      else row.toCents = (row.toCents ?? 0) + cell.amountCents
      row.deltaCents = (row.toCents ?? 0) - (row.fromCents ?? 0)
      rows.set(key, row)
    }
    for (const cell of pair.from.cells) put(cell, "from")
    for (const cell of pair.to.cells) put(cell, "to")

    const changed = [...rows.values()].filter((r) => r.deltaCents !== 0).sort((a, b) => a.key.localeCompare(b.key))
    return {
      success: true,
      data: {
        from: { budgetId: pair.from.id, label: pair.from.code },
        to: { budgetId: pair.to.id, label: pair.to.code },
        rows: changed,
        totalDeltaCents: changed.reduce((a, r) => a + r.deltaCents, 0),
      },
    }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Celdas y horas (EDITOR) — sólo sobre BORRADOR
// ─────────────────────────────────────────────────────────────────────────────

export const upsertBudgetCellsAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<UpsertCellsResult>> => {
    const parsed = upsertBudgetCellsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const config = await configFor(tx, data.cells)
      return upsertBudgetCellsTx(
        tx,
        {
          budgetId: data.budgetId,
          config,
          cells: data.cells.map(toCellInput),
        },
        { userId: user.id }
      )
    })
    if (result.ok) revalidateBudget()
    return toActionState(result)
  }
)

export const deleteBudgetCellsAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ deleted: number }>> => {
    const parsed = deleteBudgetCellsSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      deleteBudgetCellsTx(tx, parsed.data, { userId: user.id })
    )
    if (result.ok) revalidateBudget()
    return toActionState(result)
  }
)

export const upsertBudgetHoursAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ written: number }>> => {
    const parsed = upsertBudgetHoursSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      upsertBudgetHoursTx(
        tx,
        {
          budgetId: data.budgetId,
          rows: data.rows.map((r) => ({
            month: r.month,
            projectId: r.projectId ?? null,
            costCenterId: r.costCenterId ?? null,
            employeeId: r.employeeId ?? null,
            minutes: r.minutes,
          })),
        },
        { userId: user.id }
      )
    )
    if (result.ok) revalidateBudget()
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Import CSV (EDITOR) — parseo EN SERVIDOR, con `dry-run`
// ─────────────────────────────────────────────────────────────────────────────

type ParsedCsv = {
  rows: (BudgetCellInput & { lineNo: number })[]
  rejected: { line: number; reason: string }[]
  cells: BudgetCell[]
}

/**
 * **R-B-6 / criterio 28.** El fichero se parsea aquí, con lista blanca de
 * columnas, y **el rechazo del fichero entero por convención de signo invertida
 * se decide con la MISMA función pura** que usa el modelo
 * (`detectInvertedSignConvention`): con más del 90 % de las líneas de grupo 6 en
 * positivo no se inserta ni una fila. Importar la mitad al revés es peor que no
 * importar.
 *
 * Con `dryRun`, la acción **no abre transacción de escritura**: valida, informa
 * y no toca la base.
 */
export const importBudgetCsvAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<BudgetImportPayload>> => {
    const parsed = importBudgetCsvSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data

    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const version = await getBudgetVersion(tx, data.budgetId)
      if (!version) {
        return {
          inserted: 0,
          rejected: 0,
          reasons: [{ line: 0, reason: "la versión de presupuesto no existe en esta organización" }],
          fileRejected: true,
          dryRun: data.dryRun,
          parsed: 0,
        }
      }
      const config = await getAnalyticsConfig(tx, { periodEnd: version.fiscalYearEnd })
      const file = parseBudgetCsv(data.csv, data.delimiter, config)

      const inverted = detectInvertedSignConvention(file.cells)
      if (inverted) {
        return {
          inserted: 0,
          rejected: file.rows.length + file.rejected.length,
          reasons: [
            {
              line: 0,
              reason:
                "más del 90 % de las líneas de grupo 6 vienen en POSITIVO: la convención de signo del fichero " +
                "está invertida (en este producto el gasto presupuestado es NEGATIVO, ADR-0018 D2). No se ha " +
                "insertado ninguna fila: corrige el signo en origen y vuelve a importar",
            },
            ...file.rejected,
          ],
          fileRejected: true,
          dryRun: data.dryRun,
          parsed: file.rows.length,
        }
      }

      // El signo celda a celda, con la misma función que el guardado manual: en
      // `dry-run` se informa, y en el import real lo vuelve a comprobar el
      // modelo (y detrás el CHECK).
      const signRejects = file.cells
        .map((cell, i) => ({ check: checkBudgetSign(cell), lineNo: file.rows[i].lineNo }))
        .filter((r) => !r.check.ok && r.check.kind === "WRONG_SIGN")
        .map((r) => ({ line: r.lineNo, reason: r.check.ok ? "" : r.check.message }))

      if (data.dryRun) {
        return {
          inserted: 0,
          rejected: file.rejected.length + signRejects.length,
          reasons: [...file.rejected, ...signRejects],
          fileRejected: false,
          dryRun: true,
          parsed: file.rows.length,
        }
      }
      if (signRejects.length > 0) {
        return {
          inserted: 0,
          rejected: file.rejected.length + signRejects.length,
          reasons: [...file.rejected, ...signRejects],
          fileRejected: false,
          dryRun: false,
          parsed: file.rows.length,
        }
      }

      const report = await importBudgetCsvTx(tx, { budgetId: data.budgetId, rows: file.rows, config }, { userId: user.id })
      return {
        ...report,
        rejected: report.rejected + file.rejected.length,
        reasons: [...report.reasons, ...file.rejected],
        dryRun: false,
        parsed: file.rows.length,
      }
    })
    if (result.ok && !result.value.dryRun) revalidateBudget()
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Q-4 — propuesta de amortización presupuestada (EDITOR; NO escribe)
// ─────────────────────────────────────────────────────────────────────────────

export const proposeDepreciationBudgetAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<DepreciationBudgetProposal>> => {
    const parsed = proposeDepreciationBudgetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(
      org.id,
      user.id,
      async (tx) => proposeDepreciationBudget(tx, parsed.data),
      { readOnly: true }
    )
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Política de versiones (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export const createBudgetVersionAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string; label: string; revision: number; copiedCells: number }>> => {
    const parsed = createBudgetVersionSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      createBudgetVersionTx(
        tx,
        {
          fiscalYearId: data.fiscalYearId,
          scenario: data.scenario,
          name: data.name,
          note: data.note ?? null,
          validFrom: data.validFrom,
          partialFrom: data.partialFrom ?? null,
          copyFromBudgetId: data.copyFromBudgetId ?? null,
        },
        { userId: user.id }
      )
    )
    if (result.ok) revalidateBudget()
    return toActionState(result)
  }
)

/**
 * **Sellar**: calcula `budgetHash` + `marginConfigHash` + `gitSha` y **cierra la
 * vigencia anterior con `validTo = validFrom − 1 día` en la MISMA transacción**
 * (O-E10-8). `sealedAt` se decide aquí, en el borde.
 */
export const sealBudgetAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<SealBudgetPayload>> => {
    const parsed = sealBudgetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const sealedAt = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const version = await getBudgetVersion(tx, data.budgetId)
      if (!version) {
        return { budgetId: data.budgetId, budgetHash: "", closedPreviousId: null, closedPreviousTo: null, warnings: [] }
      }
      const config = await getAnalyticsConfig(tx, { periodEnd: version.fiscalYearEnd })
      const sealed = await sealBudgetTx(
        tx,
        {
          budgetId: data.budgetId,
          validFrom: data.validFrom,
          gitSha: gitSha(),
          marginConfigHash: marginConfigHash(config),
          sealedAt,
        },
        { userId: user.id }
      )
      return { budgetId: data.budgetId, ...sealed }
    })
    if (result.ok) revalidateBudget()
    if (result.ok && result.value.budgetHash === "") {
      return { success: false, error: "La versión de presupuesto no existe en esta organización" }
    }
    return toActionState(result)
  }
)

export const supersedeBudgetAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = supersedeBudgetSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await supersedeBudgetTx(tx, parsed.data, { userId: user.id })
      return null
    })
    if (result.ok) revalidateBudget()
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

const toCellInput = (c: {
  month: string
  accountCode?: string | null
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  analyticType: AnalyticType
  amountCents: number
  signException?: boolean
  note?: string | null
}): BudgetCellInput => ({
  month: c.month,
  accountCode: c.accountCode ?? null,
  projectId: c.projectId ?? null,
  costCenterId: c.costCenterId ?? null,
  businessLineId: c.businessLineId ?? null,
  analyticType: c.analyticType,
  amountCents: c.amountCents,
  signException: c.signException ?? false,
  note: c.note ?? null,
})

/** La configuración vigente al ÚLTIMO mes tocado: el nivel se congela al mes. */
async function configFor(
  tx: Parameters<typeof getAnalyticsConfig>[0],
  cells: readonly { month: string }[]
): Promise<AnalyticsConfig> {
  const last = cells.reduce((a, c) => (c.month > a ? c.month : a), cells[0]?.month ?? "1970-01-01")
  return getAnalyticsConfig(tx, { periodEnd: last })
}

/**
 * Parseo del CSV **en servidor**, con lista blanca de columnas (patrón G-08 de
 * E8): una columna que no esté en `BUDGET_CSV_COLUMNS` se ignora, y una fila a
 * la que le falte una obligatoria se rechaza **con su motivo y su número de
 * línea**. Ninguna fila se acepta a medias.
 */
function parseBudgetCsv(text: string, delimiter: string, config: AnalyticsConfig): ParsedCsv {
  const out: ParsedCsv = { rows: [], rejected: [], cells: [] }
  const grid = parseCsvRows(text, delimiter)
  if (grid.length === 0) return out

  const header = grid[0].map((h) => h.trim().toLowerCase())
  const index = (name: (typeof BUDGET_CSV_COLUMNS)[number]): number => header.indexOf(name)
  const missing = (["mes", "tipo_analitico", "importe_centimos"] as const).filter((c) => index(c) < 0)
  if (missing.length > 0) {
    out.rejected.push({ line: 1, reason: `faltan columnas obligatorias en la cabecera: ${missing.join(", ")}` })
    return out
  }

  const projectByCode = new Map(config.projects.map((p) => [p.code.toUpperCase(), p]))
  const cecoByCode = new Map(config.costCenters.map((c) => [c.code.toUpperCase(), c]))

  for (let i = 1; i < grid.length; i += 1) {
    const lineNo = i + 1
    const row = grid[i]
    if (row.every((v) => v.trim() === "")) continue
    const get = (name: (typeof BUDGET_CSV_COLUMNS)[number]): string => {
      const at = index(name)
      return at < 0 ? "" : (row[at] ?? "").trim()
    }

    const month = get("mes")
    if (!/^\d{4}-\d{2}-01$/.test(month)) {
      out.rejected.push({ line: lineNo, reason: `el mes «${month}» no tiene el formato AAAA-MM-01` })
      continue
    }
    const amountRaw = get("importe_centimos")
    const amountCents = Number(amountRaw)
    if (!Number.isInteger(amountCents)) {
      out.rejected.push({ line: lineNo, reason: `el importe «${amountRaw}» no es un entero de céntimos` })
      continue
    }
    const analyticType = get("tipo_analitico").toUpperCase() as AnalyticType
    const projectCode = get("proyecto").toUpperCase()
    const cecoCode = get("centro_coste").toUpperCase()
    if ((projectCode === "") === (cecoCode === "")) {
      out.rejected.push({
        line: lineNo,
        reason: "la fila lleva UN proyecto o UN centro de coste, nunca los dos ni ninguno (O-A6)",
      })
      continue
    }
    const project = projectCode ? projectByCode.get(projectCode) : undefined
    const ceco = cecoCode ? cecoByCode.get(cecoCode) : undefined
    if (projectCode && !project) {
      out.rejected.push({ line: lineNo, reason: `el proyecto «${projectCode}» no existe en esta organización` })
      continue
    }
    if (cecoCode && !ceco) {
      out.rejected.push({ line: lineNo, reason: `el centro de coste «${cecoCode}» no existe en esta organización` })
      continue
    }

    const accountCode = get("cuenta") === "" ? null : get("cuenta")
    const signException = ["1", "si", "sí", "true", "x"].includes(get("excepcion_signo").toLowerCase())
    const cellInput: BudgetCellInput & { lineNo: number } = {
      lineNo,
      month,
      accountCode,
      projectId: project?.id ?? null,
      costCenterId: ceco?.id ?? null,
      businessLineId: null,
      analyticType,
      amountCents,
      signException,
      note: get("nota") === "" ? null : get("nota"),
      source: "CSV_IMPORT",
    }

    let marginLevel
    try {
      marginLevel = resolveBudgetMarginLevel(
        {
          accountCode,
          analyticType,
          month,
          dimension: project
            ? { kind: "PROJECT", id: project.id, code: project.code, businessLineCode: null }
            : { kind: "COST_CENTER", id: ceco?.id ?? "", code: ceco?.code ?? "" },
        },
        config
      )
    } catch {
      out.rejected.push({
        line: lineNo,
        reason: `el tipo analítico «${analyticType}» no se puede situar en un nivel de margen con esa dimensión`,
      })
      continue
    }

    out.rows.push(cellInput)
    out.cells.push({
      month,
      accountCode,
      dimension: project
        ? { kind: "PROJECT", id: project.id, code: project.code, businessLineCode: null }
        : { kind: "COST_CENTER", id: ceco?.id ?? "", code: ceco?.code ?? "" },
      analyticType,
      marginLevel,
      amountCents,
      signException,
    })
  }
  return out
}
