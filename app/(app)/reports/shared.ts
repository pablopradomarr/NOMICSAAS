import type { CheckRow, ReportHeaderView, SealView } from "@/components/ledger/types"
import type { StatementNode } from "@/components/reports/statement-table"
import type { TenantClient } from "@/lib/db"
import type { BalanceAccountDetail, BalanceReport } from "@/lib/ledger/reports/balance"
import type { StatementRow } from "@/lib/ledger/reports/types"
import { listFiscalYears } from "@/models/fiscal-years"
import type { ReportRunView } from "@/models/reports"
import { Seal } from "@/prisma/client"

/**
 * E6 · T16/T17/T18 — Ayudas de SERVIDOR de las pantallas de informes.
 *
 * No es un módulo de acciones ni de dominio: adapta lo que devuelven
 * `app/(app)/reports/actions.ts` y `app/(app)/dashboard/actions.ts` a los
 * modelos de vista de `components/`. **Aquí no se calcula ninguna cifra
 * contable**: las cifras llegan ya hechas y selladas dentro del `ReportRun`, y
 * lo único que se hace con ellas es ordenarlas, anidarlas y darles formato.
 *
 * La única resta que aparece en este fichero es la de la columna Δ, que
 * compara **dos informes sellados** del mismo tipo y los mismos parámetros
 * (§8.7 del diseño): se marca como tal en la cabecera de la columna y no entra
 * en ningún cuadre.
 */

export const firstOf = (
  params: Record<string, string | string[] | undefined>,
  key: string
): string | undefined => {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

// ─────────────────────────────────────────────────────────────────────────────
// Cabecera: sello, motivos y checks del run
// ─────────────────────────────────────────────────────────────────────────────

/** Sello del `ReportRun` (`Seal` + `sealReasons` con código cerrado, O-7). */
export function sealViewOf(run: Pick<ReportRunView, "seal" | "sealReasons">): SealView {
  return {
    sello: run.seal === Seal.VALIDADO_AUTOMATICAMENTE ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
    motivos: (run.sealReasons ?? []).map((reason) => `${reason.code} · ${reason.message}`),
  }
}

/** `ReportRunView` → cabecera común (`ReportHeader`). */
export function runHeader(run: ReportRunView, baseCurrency: string): ReportHeaderView {
  const checks: CheckRow[] = (run.validation?.checks ?? []).map((check) => ({
    id: check.id,
    status: check.status,
    evidencia: check.evidencia,
    ...(check.query ? { query: check.query } : {}),
  }))
  return {
    from: run.periodStart,
    to: run.periodEnd,
    baseCurrency,
    runId: run.id,
    ledgerHash: run.ledgerHash,
    gitSha: run.gitSha,
    seal: sealViewOf(run),
    checks,
  }
}

/** Ruta de descarga del run ya emitido (route handler, binario). */
export const exportHref = (type: string, runId: string, format: "csv" | "xlsx" | "pdf"): string =>
  `/reports/${type.toLowerCase()}/export?runId=${runId}&format=${format}`

// ─────────────────────────────────────────────────────────────────────────────
// Ejercicios y periodo
// ─────────────────────────────────────────────────────────────────────────────

export type FiscalYearRow = {
  id: string
  code: string
  startDate: string
  endDate: string
  status: string
}

export type FiscalYearContext = {
  fiscalYears: FiscalYearRow[]
  selected: FiscalYearRow | null
  /** El ejercicio inmediatamente anterior, si existe: la columna comparativa. */
  previous: FiscalYearRow | null
}

export async function fiscalYearContext(db: TenantClient, selectedId?: string): Promise<FiscalYearContext> {
  const rows: FiscalYearRow[] = (await listFiscalYears(db)).map((fy) => ({
    id: fy.id,
    code: fy.code,
    startDate: fy.startDate.toISOString().slice(0, 10),
    endDate: fy.endDate.toISOString().slice(0, 10),
    status: fy.status,
  }))
  const selected =
    rows.find((fy) => fy.id === selectedId) ??
    rows.find((fy) => fy.status === "OPEN") ??
    rows[rows.length - 1] ??
    null
  const previous = selected
    ? ([...rows].reverse().find((fy) => fy.endDate < selected.startDate) ?? null)
    : null
  return { fiscalYears: rows, selected, previous }
}

/**
 * Misma fecha del ejercicio anterior. Si el corte cae fuera del ejercicio
 * anterior (p. ej. ejercicios de distinta longitud), se acota a su cierre: el
 * comparativo del balance es SIEMPRE una fecha de ese ejercicio (§8.7).
 */
export function comparativeCutoff(cutoff: string, previous: FiscalYearRow): string {
  const shifted = shiftOneYear(cutoff)
  if (shifted < previous.startDate) return previous.startDate
  if (shifted > previous.endDate) return previous.endDate
  return shifted
}

/** Un año atrás sin construir `Date` (29-feb incluido). */
export function shiftOneYear(date: string): string {
  const [y, m, d] = date.split("-").map(Number)
  const ny = y - 1
  const leap = (ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0
  const day = m === 2 && d === 29 && !leap ? 28 : d
  return `${ny}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Filas de estado financiero → nodos de la tabla
// ─────────────────────────────────────────────────────────────────────────────

const SEPARATOR = " / "

/**
 * `StatementRow[]` **plana y ya ordenada** por el motor → árbol de nodos.
 *
 * El motor devuelve las rutas completas (`"A) Activo no corriente / II. …"`)
 * en su orden de presentación (`segmentOrder`, nunca lexicográfico). Aquí sólo
 * se anidan por prefijo: no se suma, no se reordena y no se inventa ninguna
 * fila. Bajo cada hoja de epígrafe se cuelgan sus **cuentas**, tomadas de
 * `accountDetail` (que también viene del motor, con su importe ya presentado).
 */
export function statementNodes(
  rows: readonly StatementRow[],
  opts: {
    /** Importe de la columna comparativa por ruta, del run del periodo anterior. */
    previousByPath?: ReadonlyMap<string, number>
    /** Cuentas por epígrafe, para el nivel hoja del balance. */
    accountsByEpigraph?: ReadonlyMap<string, readonly BalanceAccountDetail[]>
    previousByAccount?: ReadonlyMap<string, number>
    /** Prefijo de los `id`, para que dos tablas de la misma página no colisionen. */
    prefix: string
  }
): StatementNode[] {
  const byPath = new Map<string, StatementNode>()
  const roots: StatementNode[] = []

  for (const row of rows) {
    const previous = opts.previousByPath?.get(row.path)
    const node: StatementNode = {
      id: `${opts.prefix}:${row.path}`,
      label: row.label,
      depth: row.depth - 1,
      path: row.path,
      isAccount: false,
      isContraCell: row.isContraCell,
      isComputed: row.isComputed,
      accountCodes: [...row.accountCodes],
      values: {
        actual: row.cents,
        anterior: previous ?? null,
        delta: previous === undefined ? null : row.cents - previous,
      },
      children: [],
    }
    byPath.set(row.path, node)
    const parentPath = row.path.slice(0, row.path.lastIndexOf(SEPARATOR))
    const parent = row.path.includes(SEPARATOR) ? byPath.get(parentPath) : undefined
    if (parent) parent.children?.push(node)
    else roots.push(node)

    if (row.isLeaf && opts.accountsByEpigraph) {
      for (const account of opts.accountsByEpigraph.get(row.path) ?? []) {
        const before = opts.previousByAccount?.get(account.code)
        node.children?.push({
          id: `${opts.prefix}:${row.path}:${account.code}`,
          label: account.name,
          depth: row.depth,
          path: row.path,
          isAccount: true,
          code: account.code,
          isContraCell: account.isContra,
          isComputed: account.synthetic === true,
          accountCodes: [account.code],
          values: {
            actual: account.presentedCents,
            anterior: before ?? null,
            delta: before === undefined ? null : account.presentedCents - before,
          },
        })
      }
    }
  }

  return roots
}

/** Cuentas del balance agrupadas por epígrafe, en el orden que da el motor. */
export function accountsByEpigraph(
  report: Pick<BalanceReport, "accountDetail">,
  sides: readonly BalanceAccountDetail["side"][]
): Map<string, BalanceAccountDetail[]> {
  const out = new Map<string, BalanceAccountDetail[]>()
  for (const account of report.accountDetail) {
    if (!sides.includes(account.side)) continue
    const list = out.get(account.epigraph) ?? []
    list.push(account)
    out.set(account.epigraph, list)
  }
  return out
}

/** Importe por ruta de un lado del balance ya emitido (columna comparativa). */
export function centsByPath(...groups: readonly (readonly StatementRow[])[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const rows of groups) for (const row of rows) out.set(row.path, row.cents)
  return out
}

export function centsByAccount(report: Pick<BalanceReport, "accountDetail">): Map<string, number> {
  return new Map(report.accountDetail.map((a) => [a.code, a.presentedCents]))
}
