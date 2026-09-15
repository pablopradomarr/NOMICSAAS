import "server-only"

/**
 * E10 · T15 — Composición **en el servidor** de la vista del editor de
 * presupuesto (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Aquí es donde se suma. El editor de `/analytics/budget` es una hoja de
 * cuenta × mes × dimensión, y **todos** sus totales —de fila, de mes, por nivel
 * de margen y el general— se componen aquí, sobre las celdas que devuelve
 * `getBudgetAction` y sobre la matriz de `lib/budget/matrix.ts`. El navegador
 * recibe cifras, nunca sumandos: es la regla 3 de `dev-frontend` y el criterio
 * de §7 («todos los totales de fila, de columna y por nivel de margen los
 * compone el servidor»).
 *
 * Los niveles de margen NO se recalculan: cada celda trae el suyo congelado
 * (O-E10-7) y `buildBudgetMatrix` declara en `unresolved` cualquier deriva
 * (`LEVEL_DRIFT`) en vez de moverla en silencio.
 */

import type {
  BudgetSheetCell,
  BudgetSheetRow,
  BudgetSheetView,
  BudgetVersionView,
} from "@/components/budget/types"
import { sheetRowKey } from "@/components/budget/types"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import type { AnalyticsConfig } from "@/lib/analytics/types"
import { buildBudgetMatrix } from "@/lib/budget/matrix"
import { budgetSignOffenders } from "@/lib/budget/hash"
import { fiscalYearMonths, monthKey } from "@/lib/budget/types"
import type { BudgetListItem, StoredBudgetVersion } from "@/models/budget"

/** Orden de presentación de una fila: nivel de margen → dimensión → cuenta. */
const levelRank = (level: string): number => {
  const at = MARGIN_LEVELS.indexOf(level as (typeof MARGIN_LEVELS)[number])
  return at < 0 ? MARGIN_LEVELS.length : at
}

/**
 * La hoja entera, con sus totales. Una sola pasada por las celdas para las
 * filas y los meses; los totales por nivel vienen de la matriz, que es la misma
 * que firma el `budgetHash` y la que compara `budget-vs-actual`.
 */
export function buildBudgetSheet(version: StoredBudgetVersion, config: AnalyticsConfig): BudgetSheetView {
  const months = fiscalYearMonths(version.fiscalYearStart, version.fiscalYearEnd)
  const nameByProject = new Map(config.projects.map((p) => [p.id, p.name]))
  const nameByCostCenter = new Map(config.costCenters.map((c) => [c.id, c.name]))

  const offenderKeys = new Set<string>()
  const offenderMessage = new Map<string, string>()
  for (const { cell, check } of budgetSignOffenders(version.cells)) {
    const key = `${sheetRowKey({
      dimensionKind: cell.dimension.kind,
      dimensionId: cell.dimension.id,
      accountCode: cell.accountCode,
      analyticType: cell.analyticType,
    })}|${monthKey(cell.month)}`
    offenderKeys.add(key)
    if (!check.ok) offenderMessage.set(key, check.message)
  }

  const rowByKey = new Map<string, BudgetSheetRow & { cells: Record<string, BudgetSheetCell> }>()
  const monthTotals: Record<string, number> = {}
  for (const month of months) monthTotals[month] = 0
  let total = 0

  for (const cell of version.cells) {
    const month = monthKey(cell.month)
    const key = sheetRowKey({
      dimensionKind: cell.dimension.kind,
      dimensionId: cell.dimension.id,
      accountCode: cell.accountCode,
      analyticType: cell.analyticType,
    })
    const row =
      rowByKey.get(key) ??
      ({
        key,
        dimensionKind: cell.dimension.kind,
        dimensionId: cell.dimension.id,
        dimensionCode: cell.dimension.code,
        dimensionName:
          (cell.dimension.kind === "PROJECT"
            ? nameByProject.get(cell.dimension.id)
            : nameByCostCenter.get(cell.dimension.id)) ?? "",
        accountCode: cell.accountCode,
        analyticType: cell.analyticType,
        marginLevel: cell.marginLevel,
        cells: {},
        totalCents: 0,
        signIssues: [],
      } as BudgetSheetRow & { cells: Record<string, BudgetSheetCell>; signIssues: { month: string; message: string }[] })

    const previous = row.cells[month]
    row.cells[month] = {
      amountCents: (previous?.amountCents ?? 0) + cell.amountCents,
      signException: (previous?.signException ?? false) || cell.signException,
      // Una celda de la hoja puede agregar más de una línea (la misma
      // dimensión, cuenta y tipo con dos líneas de origen distinto): vaciarla
      // las retira TODAS, o la celda volvería a pintar un resto.
      lineIds: [...(previous?.lineIds ?? []), cell.id],
    }
    row.totalCents += cell.amountCents
    monthTotals[month] = (monthTotals[month] ?? 0) + cell.amountCents
    total += cell.amountCents

    const offenderKey = `${key}|${month}`
    if (offenderKeys.has(offenderKey)) {
      ;(row.signIssues as { month: string; message: string }[]).push({
        month,
        message: offenderMessage.get(offenderKey) ?? "el signo no corresponde al tipo analítico (O-E10-6)",
      })
    }
    rowByKey.set(key, row)
  }

  const rows = [...rowByKey.values()].sort(
    (a, b) =>
      levelRank(a.marginLevel) - levelRank(b.marginLevel) ||
      a.dimensionCode.localeCompare(b.dimensionCode, "es") ||
      (a.accountCode ?? "").localeCompare(b.accountCode ?? "", "es") ||
      a.analyticType.localeCompare(b.analyticType, "es")
  )

  const matrix = buildBudgetMatrix(version, config, { from: version.fiscalYearStart, to: version.fiscalYearEnd })

  return {
    months,
    rows,
    monthTotalsCents: monthTotals,
    levelTotalsCents: MARGIN_LEVELS.map((level) => ({ level, cents: matrix.levelTotalsCents[level] ?? 0 })),
    totalCents: total,
    unresolved: matrix.unresolved.map((u) => ({
      month: monthKey(u.month),
      dimensionCode: u.dimensionCode,
      code: u.code,
      message: u.message,
    })),
  }
}

/** Cabecera de versión para el selector: sin celdas, sólo su estado y su sello. */
export function toVersionView(item: BudgetListItem, fiscalYearCode: string): BudgetVersionView {
  return {
    id: item.id,
    label: item.label,
    name: item.name,
    scenario: item.scenario,
    revision: item.revision,
    status: item.status,
    fiscalYearId: item.fiscalYearId,
    fiscalYearCode,
    validFrom: item.validFrom,
    validTo: item.validTo,
    partialFrom: item.partialFrom,
    budgetHash: item.budgetHash,
    sealedAt: item.sealedAt,
    lineCount: item.lineCount,
    hoursLineCount: item.hoursLineCount,
    totalCents: item.totalCents,
  }
}
