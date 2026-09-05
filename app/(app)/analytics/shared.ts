import type {
  AnalyticsHeaderView,
  BusinessLineRow,
  CellDetail,
  CellLine,
  CostCenterRow,
  DimensionOption,
  MatrixCell,
  MatrixHeader,
  MatrixRow,
  MatrixView,
  ProjectRow,
} from "@/components/analytics/types"
import { COST_CENTER_KIND_LABELS, MARGIN_LEVEL_LABELS } from "@/components/analytics/types"
import type { AnalyticPnl } from "@/lib/analytics/margins"
import { marginBps } from "@/lib/analytics/margins"
import { COST_CENTER_KINDS, MARGIN_LEVELS } from "@/lib/analytics/types"
import type { AnalyticsConfig } from "@/lib/analytics/types"
import { seal } from "@/lib/ledger/invariants"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { TenantClient } from "@/lib/db"

/**
 * E4 · T13/T14 — Ayudas de servidor de las pantallas de analítica.
 *
 * Mismo papel que `app/(app)/ledger/shared.ts`: lecturas con el `db` de
 * `requireOrg` y **adaptación** de lo que devuelven `models/` y el motor puro a
 * los modelos de vista de `components/analytics/types.ts`.
 *
 * Aquí NO se calcula ninguna cifra contable. Los importes salen de
 * `buildAnalyticPnl` (puro), los porcentajes de `marginBps` (puro) y las
 * diferencias de presupuesto se marcan como `calculado` en la pantalla. Lo
 * único que hace este módulo es elegir el orden de las columnas y ponerles
 * nombre en español.
 */

/** Niveles cuyo % sobre ingresos tiene sentido enseñar (`ui-erp` §Tablas). */
const MARGIN_PERCENT_LEVELS = ["MC1", "MC2", "MC3", "EBITDA"] as const

/** En una columna de proyecto, de EBIT hacia abajo es lectura de compañía (§6). */
const COMPANY_ONLY_LEVELS = new Set(["EBIT", "BAI", "RESULTADO"])

export const TOTAL_COLUMN = "TOTAL"

const OTHER_COLUMN_LABELS: Record<string, string> = {
  AMORTIZACION_DETERIORO: "Amortización y deterioro",
  FINANCIERO: "Financiero",
  EXTRAORDINARIO: "Extraordinario",
  NO_ANALITICO: "No analítico",
}

/** Cabecera de la PyG analítica con los TRES sellos de E4-D2 (§2.5). */
export function analyticsHeader(params: {
  from: string
  to: string
  baseCurrency: string
  runId: string
  gitSha: string
  ledgerHash: string
  analyticsHash: string
  marginConfigHash: string
  checks: readonly CheckResult[]
  refDate: string
  organizationId: string
}): AnalyticsHeaderView {
  const sello = seal(
    {
      run_id: params.runId,
      ledgerHash: params.ledgerHash,
      gitSha: params.gitSha,
      refDate: params.refDate,
      organizationId: params.organizationId,
      checks: [...params.checks],
    },
    { gitSha: params.gitSha }
  )

  return {
    from: params.from,
    to: params.to,
    baseCurrency: params.baseCurrency,
    runId: params.runId,
    gitSha: params.gitSha,
    ledgerHash: params.ledgerHash,
    analyticsHash: params.analyticsHash,
    marginConfigHash: params.marginConfigHash,
    seal: sello,
    checks: params.checks.map((c) => ({
      id: c.id,
      status: c.status,
      evidencia: c.evidencia,
      ...(c.query ? { query: c.query } : {}),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Matriz
// ─────────────────────────────────────────────────────────────────────────────

type ColumnSpec = MatrixHeader & {
  /** Clave de la matriz del motor; `null` en agregados y en el total. */
  source: string | null
  /** Código de línea de negocio, para leer `businessLineMatrixCents`. */
  businessLineCode?: string
}

/**
 * Orden de columnas sellado por el diseño: proyectos agrupados bajo su línea de
 * negocio (con el subtotal de la línea, marcado como agregado), CECOs por
 * `kind`, y las cuatro columnas sueltas. `TOTAL` cierra la tabla.
 */
export function matrixColumns(pnl: AnalyticPnl, config: AnalyticsConfig): ColumnSpec[] {
  const out: ColumnSpec[] = []
  const projectsByLine = new Map<string, typeof config.projects>()
  for (const bl of config.businessLines) {
    projectsByLine.set(
      bl.id,
      config.projects.filter((p) => p.businessLineId === bl.id)
    )
  }

  for (const bl of config.businessLines) {
    const projects = projectsByLine.get(bl.id) ?? []
    if (projects.length === 0) continue
    for (const project of projects) {
      out.push({
        key: `PROJ:${project.code}`,
        source: `PROJ:${project.code}`,
        label: project.name,
        sub: `${project.code} · ${bl.code}`,
        kind: "project",
      })
    }
    out.push({
      key: `BL:${bl.code}`,
      source: null,
      businessLineCode: bl.code,
      label: bl.name,
      sub: `${bl.code} · agregado`,
      kind: "businessLine",
      aggregate: true,
    })
  }

  const kindsWithCeco = new Set(config.costCenters.map((c) => c.kind))
  for (const kind of COST_CENTER_KINDS) {
    const key = `CECO:${kind}`
    const hasAmount = MARGIN_LEVELS.some((level) => (pnl.matrixCents[level]?.[key] ?? 0) !== 0)
    if (!kindsWithCeco.has(kind) && !hasAmount) continue
    out.push({
      key,
      source: key,
      label: COST_CENTER_KIND_LABELS[kind] ?? kind,
      sub: "centro de coste",
      kind: "ceco",
    })
  }

  for (const key of ["AMORTIZACION_DETERIORO", "FINANCIERO", "EXTRAORDINARIO", "NO_ANALITICO"] as const) {
    out.push({ key, source: key, label: OTHER_COLUMN_LABELS[key], kind: "other" })
  }

  out.push({ key: TOTAL_COLUMN, source: null, label: "TOTAL", sub: "Σ columnas", kind: "total" })
  return out
}

function cellAmount(pnl: AnalyticPnl, column: ColumnSpec, level: string): number {
  if (column.kind === "total") return pnl.levelTotalsCents[level] ?? 0
  if (column.businessLineCode) return pnl.businessLineMatrixCents[level]?.[column.businessLineCode] ?? 0
  return pnl.matrixCents[level]?.[column.source ?? ""] ?? 0
}

function contributionAmount(pnl: AnalyticPnl, column: ColumnSpec, level: string): number {
  if (column.source === null) return 0
  return pnl.contributionByLevelCents[level]?.[column.source] ?? 0
}

export type MatrixBuildInput = {
  pnl: AnalyticPnl
  config: AnalyticsConfig
  accountNames: Map<string, string>
  /** `true` ⇒ proyectos/columnas en filas y niveles en columnas. */
  transposed: boolean
}

/** Construye la vista de la matriz en la orientación pedida. Sin sumar nada. */
export function buildMatrixView(input: MatrixBuildInput): MatrixView {
  const { pnl, config, transposed } = input
  const columns = matrixColumns(pnl, config)
  const visibleLevels = MARGIN_LEVELS.filter((level) => {
    const row = config.levels.find((l) => l.level === level)
    return row ? row.isVisible : true
  })

  const details: Record<string, CellDetail> = {}
  for (const column of columns) {
    if (column.source === null) continue
    for (const level of visibleLevels) {
      const key = `${level}|${column.source}`
      const lines: CellLine[] = pnl.lineDetail
        .filter((d) => d.level === level && d.column === column.source)
        .map((d) => ({
          entryRef: d.entryRef,
          lineNo: d.lineNo,
          accountCode: d.accountCode,
          accountName: input.accountNames.get(d.accountCode) ?? "",
          analyticType: d.analyticType,
          projectCode: d.projectCode,
          costCenterCode: d.costCenterCode,
          amountCents: d.amountCents,
        }))
      const prov = pnl.provenance.get(key)
      details[key] = {
        title: `${MARGIN_LEVEL_LABELS[level] ?? level} · ${column.label}`,
        cumulativeCents: cellAmount(pnl, column, level),
        contributionCents: contributionAmount(pnl, column, level),
        ...(prov ? { provenance: prov } : {}),
        lines,
      }
    }
  }

  const check = {
    label: "Σ columnas (RESULTADO) − PyG contable",
    differenceCents: (pnl.levelTotalsCents.RESULTADO ?? 0) - pnl.pygContableCents,
    balanced: (pnl.levelTotalsCents.RESULTADO ?? 0) === pnl.pygContableCents,
  }

  if (!transposed) {
    const headers: MatrixHeader[] = columns.map(({ key, label, sub, kind, aggregate }) => ({
      key,
      label,
      ...(sub ? { sub } : {}),
      kind,
      ...(aggregate ? { aggregate } : {}),
    }))
    const rows: MatrixRow[] = []
    for (const level of visibleLevels) {
      rows.push({
        id: level,
        label: config.levels.find((l) => l.level === level)?.label ?? MARGIN_LEVEL_LABELS[level] ?? level,
        kind: "level",
        cells: columns.map((column) => levelCell(pnl, column, level)),
      })
      if ((MARGIN_PERCENT_LEVELS as readonly string[]).includes(level)) {
        rows.push({
          id: `%${level}`,
          label: `% ${level} sobre ingresos`,
          kind: "margin",
          cells: columns.map((column) => ({
            bps: marginBps(cellAmount(pnl, column, level), cellAmount(pnl, column, "INGRESOS")),
          })),
        })
      }
    }
    return { headers, rows, cornerLabel: "Nivel de margen", details, check }
  }

  // ── Vista transpuesta: una fila por columna analítica ──────────────────────
  const headers: MatrixHeader[] = []
  for (const level of visibleLevels) {
    headers.push({
      key: level,
      label: config.levels.find((l) => l.level === level)?.label ?? MARGIN_LEVEL_LABELS[level] ?? level,
      sub: level,
      kind: "other",
    })
    if ((MARGIN_PERCENT_LEVELS as readonly string[]).includes(level)) {
      headers.push({ key: `%${level}`, label: `% ${level}`, sub: "sobre ingresos", kind: "other" })
    }
  }

  const rows: MatrixRow[] = columns.map((column) => ({
    id: column.key,
    label: column.label,
    kind: "level" as const,
    ...(column.aggregate ? { note: "agregado, no suma al total" } : {}),
    cells: headers.map((header) => {
      if (header.key.startsWith("%")) {
        const level = header.key.slice(1)
        return { bps: marginBps(cellAmount(pnl, column, level), cellAmount(pnl, column, "INGRESOS")) }
      }
      return levelCell(pnl, column, header.key)
    }),
  }))

  return { headers, rows, cornerLabel: "Proyecto / centro", details, check }
}

function levelCell(pnl: AnalyticPnl, column: ColumnSpec, level: string): MatrixCell {
  const cell: MatrixCell = { cents: cellAmount(pnl, column, level) }
  if (column.source !== null) cell.detailKey = `${level}|${column.source}`
  if (column.kind === "project" && COMPANY_ONLY_LEVELS.has(level)) cell.muted = true
  return cell
}

// ─────────────────────────────────────────────────────────────────────────────
// Dimensiones
// ─────────────────────────────────────────────────────────────────────────────

/** Opciones de destino analítico: proyectos abiertos + CECOs activos. */
export function dimensionOptions(
  projects: readonly { id: string; code: string; name: string; status: string; isActive: boolean }[],
  costCenters: readonly { id: string; code: string; name: string; isActive: boolean }[]
): DimensionOption[] {
  return [
    ...projects
      .filter((p) => p.isActive)
      .map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        family: "project" as const,
        ...(p.status === "CLOSED" ? { disabled: true, hint: "Proyecto cerrado" } : {}),
      })),
    ...costCenters
      .filter((c) => c.isActive)
      .map((c) => ({ id: c.id, code: c.code, name: c.name, family: "costCenter" as const })),
  ]
}

/** Presupuesto y fechas del proyecto, que el listado de `models/` no trae. */
export async function projectExtras(
  db: TenantClient,
  ids: readonly string[]
): Promise<
  Map<
    string,
    {
      startDate: string | null
      endDate: string | null
      budgetRevenueCents: number | null
      budgetCostCents: number | null
      counterpartyId: string | null
    }
  >
> {
  if (ids.length === 0) return new Map()
  const rows = await db.project.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      budgetRevenueCents: true,
      budgetCostCents: true,
      counterpartyId: true,
    },
  })
  return new Map(
    rows.map((r) => [
      r.id,
      {
        startDate: r.startDate ? r.startDate.toISOString().slice(0, 10) : null,
        endDate: r.endDate ? r.endDate.toISOString().slice(0, 10) : null,
        budgetRevenueCents: r.budgetRevenueCents,
        budgetCostCents: r.budgetCostCents,
        counterpartyId: r.counterpartyId,
      },
    ])
  )
}

/** Cifras del periodo de cada proyecto, leídas de la matriz (nunca recalculadas). */
export function projectPeriodFigures(
  pnl: AnalyticPnl,
  code: string
): { revenueCents: number; mc2Cents: number; mc3Cents: number } {
  const column = `PROJ:${code}`
  return {
    revenueCents: pnl.matrixCents.INGRESOS?.[column] ?? 0,
    mc2Cents: pnl.matrixCents.MC2?.[column] ?? 0,
    mc3Cents: pnl.matrixCents.MC3?.[column] ?? 0,
  }
}

export type { BusinessLineRow, CostCenterRow, ProjectRow }
