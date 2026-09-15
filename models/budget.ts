/**
 * E10 · T12 — Acceso a datos de las versiones de presupuesto
 * (`docs/design/E10-presupuesto-horas.md` §4.1).
 *
 * **Ninguna función calcula**: leen, escriben y delegan en `lib/budget/**`, que
 * es puro. Todo acceso pasa por `tenantDb` / `tenantTransaction`; toda escritura
 * lleva su `AuditLog` **en la misma transacción**, y todo aborto es un `throw`
 * (lección BLOQUEA-1 de E3).
 *
 * Las cuatro cosas que este módulo garantiza, y por qué:
 *
 *  1. **Sellar cierra la vigencia anterior EN LA MISMA TRANSACCIÓN** (O-E10-8).
 *     El `EXCLUDE USING gist` de `budgets` impide el **solape**; el **hueco** no
 *     lo impide nadie, y un mes sin versión vigente disparaba
 *     `PRESUPUESTO_AUSENTE` teniendo presupuesto. La continuidad la exige
 *     `sealBudgetTx` y la comprueba I-E10-15.
 *  2. **La versión efectiva de un ejercicio se COMPONE** (O-E10-9): la última no
 *     parcial, sustituida mes a mes por las `partialFrom` posteriores, con la
 *     procedencia de cada mes. Una `REVISADO` que sólo trae julio–diciembre
 *     desinflaba el año a la mitad **y nada lo decía**.
 *  3. **El signo lo fuerza el tipo analítico** (O-E10-6), con la MISMA función
 *     pura que usa el importador y el mismo CHECK en la base, para que el
 *     mensaje y la barrera digan lo mismo. Un `6400` en positivo duplicaba la
 *     desviación con ejecución exacta.
 *  4. **El importador rechaza el fichero ENTERO** con la convención de signo
 *     invertida (R-B-6): importar el 95 % bien y el 5 % al revés es peor que no
 *     importar nada, porque nadie lo mira.
 *
 * ## Frontera con `lib/budget/**` (ola B, agente B1)
 *
 * El motor puro —`budgetHash`, `composeBudget`, `checkBudgetSign`,
 * `detectInvertedSignConvention`, `buildBudgetMatrix`— es de **B1** (T7/T8) y
 * este módulo lo CONSUME: los tipos del dominio (`BudgetCell`, `BudgetVersion`,
 * `ComposedBudget`) se reexportan desde `lib/budget/types.ts` y
 * `lib/budget/hash.ts`, y no se redeclaran aquí. Una segunda definición de
 * `BudgetCell` en la capa de datos sería la forma más rápida de que la matriz
 * del presupuesto y la del real dejaran de medir lo mismo.
 */

import { randomUUID } from "node:crypto"

import { depreciationSchedule } from "@/lib/closing/depreciation"
import {
  budgetHash as computeBudgetHash,
  checkBudgetSign,
  composeBudget,
  detectInvertedSignConvention,
  type ComposedBudget,
  type SignCheck,
} from "@/lib/budget/hash"
import {
  fiscalYearMonths,
  monthKey,
  type BudgetCell,
  type BudgetDimension,
  type BudgetHoursCell,
  type BudgetVersion,
} from "@/lib/budget/types"
import type { AnalyticsConfig, AnalyticType, Cents, LocalDate, MarginLevel } from "@/lib/analytics/types"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { centsFromDb } from "@/lib/money"
import type { Actor } from "@/models/analytics"
import { writeAuditLog } from "@/models/audit-log"
import { e10Abort, assertReason } from "@/models/e10-errors"
import { previousDay } from "@/models/employees"
import type { BudgetLineSource, BudgetScenario, BudgetStatus, Prisma } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Lo que este módulo añade a los tipos del motor
//
// `BudgetVersion` de `lib/budget/types.ts` es PURA: no conoce sellos ni estado
// de fila. La capa de datos necesita los tres sellos y la etiqueta para la
// pantalla, así que los lleva aparte en vez de contaminar el tipo del motor —
// que es lo que hace que el `budgetHash` dependa exactamente de lo que §3.8
// dice y de nada más.
// ─────────────────────────────────────────────────────────────────────────────

export type { BudgetCell, BudgetDimension, BudgetHoursCell, BudgetVersion, ComposedBudget }

/** Los sellos de la fila, que el motor puro no conoce ni necesita. */
export type BudgetSeals = {
  budgetHash: string | null
  marginConfigHash: string | null
  gitSha: string | null
  sealedAt: string | null
}

export type StoredBudgetVersion = Omit<BudgetVersion, "cells" | "hours"> & {
  seals: BudgetSeals
  cells: readonly BudgetCellRow[]
  hours: readonly BudgetHoursRow[]
}

/**
 * **La celda de importe TAL COMO SE GUARDA: con el id de su `BudgetLine`.**
 *
 * Sin él, el editor no podía distinguir «vaciar la celda» de «teclear 0», y la
 * vaciaba escribiendo `0,00 €` —un cero declarado, que es una decisión de
 * presupuesto— en vez de retirar la línea. `deleteBudgetCellsTx` pide ids; el
 * id sale de aquí. El motor puro sigue viendo un `BudgetCell` y el
 * `budgetHash` no lo mira: es un dato de persistencia, no de presupuesto.
 */
export type BudgetCellRow = BudgetCell & { id: string }

/** La celda de horas TAL COMO SE GUARDA: con el id del empleado, no sólo su código. */
export type BudgetHoursRow = BudgetHoursCell & { employeeId: string | null }

// ─────────────────────────────────────────────────────────────────────────────
// Reglas de signo y de nivel, espejo de los CHECK y del trigger de M2
// ─────────────────────────────────────────────────────────────────────────────

/** La comprobación de signo del motor (O-E10-6): una sola definición. */
const signOf = (cell: BudgetCell): SignCheck => checkBudgetSign(cell)

/**
 * **O-E10-7 — el nivel que la línea congela.** Espejo EXACTO del trigger
 * `app.assert_budget_line_margin_level`, y por eso está aquí y no en el motor
 * puro: depende de `CostCenter.marginLevel` y de la `MarginLevelConfig` vigente
 * **al mes**, que son datos, no reglas. Si los dos caminos divergieran, la
 * escritura fallaría con `23514` y el usuario no sabría por qué.
 */
export function resolveBudgetMarginLevel(
  cell: Pick<BudgetCell, "accountCode" | "analyticType" | "dimension" | "month">,
  config: AnalyticsConfig
): MarginLevel {
  const fallback: MarginLevel =
    cell.accountCode !== null && config.incomeTaxPrefixes.some((p) => cell.accountCode?.startsWith(p))
      ? "RESULTADO"
      : (config.nonAnalyticLevel as MarginLevel)

  if (cell.analyticType === "INDIRECTO_CECO") {
    if (cell.dimension.kind !== "COST_CENTER") {
      e10Abort(
        "BUDGET_DIMENSION",
        "analyticType",
        "una celda `INDIRECTO_CECO` necesita un centro de coste: es su nivel de margen el que la sitúa (R-A6)"
      )
    }
    const ceco = config.costCenters.find((c) => c.id === cell.dimension.id)
    if (!ceco) {
      e10Abort("BUDGET_DIMENSION", "costCenterId", "el centro de coste de la celda no existe en la configuración vigente")
    }
    return ceco.marginLevel as MarginLevel
  }
  if (cell.analyticType === "NO_ANALITICO") return fallback

  const level = config.levels.find(
    (l) =>
      l.analyticTypes.includes(cell.analyticType) &&
      l.validFrom <= cell.month &&
      (l.validTo === null || l.validTo >= cell.month)
  )
  return level ? level.level : fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetListItem = {
  id: string
  label: string
  scenario: BudgetScenario
  revision: number
  name: string
  status: BudgetStatus
  fiscalYearId: string
  validFrom: LocalDate
  validTo: LocalDate | null
  partialFrom: LocalDate | null
  budgetHash: string | null
  sealedAt: string | null
  lineCount: number
  hoursLineCount: number
  /** Σ de los importes presupuestados, por agregado SQL. Nunca en memoria. */
  totalCents: Cents
}

export const budgetLabel = (fiscalYearCode: string, scenario: BudgetScenario, revision: number): string =>
  scenario === "BASE" ? `${fiscalYearCode}-BASE` : `${fiscalYearCode}-REV${revision}`

/**
 * §9 — la lista trae sus totales por **agregado SQL**. Con 28 800 celdas, sumar
 * en memoria para pintar una tabla de cinco filas es exactamente lo que el
 * estándar de calidad prohíbe.
 */
export async function listBudgets(
  db: AnyClient,
  filter: { fiscalYearId?: string; status?: BudgetStatus } = {}
): Promise<BudgetListItem[]> {
  const rows = await db.budget.findMany({
    where: {
      ...(filter.fiscalYearId ? { fiscalYearId: filter.fiscalYearId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    include: {
      fiscalYear: { select: { code: true } },
      _count: { select: { lines: true, hoursLines: true } },
    },
    orderBy: [{ fiscalYearId: "asc" }, { scenario: "asc" }, { revision: "asc" }],
  })
  if (rows.length === 0) return []

  const totals = await db.budgetLine.groupBy({
    by: ["budgetId"],
    where: { budgetId: { in: rows.map((r) => r.id) } },
    _sum: { amountCents: true },
  })
  const totalById = new Map(totals.map((t) => [t.budgetId, t._sum.amountCents ?? 0]))

  return rows.map((r) => ({
    id: r.id,
    label: budgetLabel(r.fiscalYear.code, r.scenario, r.revision),
    scenario: r.scenario,
    revision: r.revision,
    name: r.name,
    status: r.status,
    fiscalYearId: r.fiscalYearId,
    validFrom: fromUtcDate(r.validFrom),
    validTo: r.validTo ? fromUtcDate(r.validTo) : null,
    partialFrom: r.partialFrom ? fromUtcDate(r.partialFrom) : null,
    budgetHash: r.budgetHash,
    sealedAt: r.sealedAt ? r.sealedAt.toISOString() : null,
    lineCount: r._count.lines,
    hoursLineCount: r._count.hoursLines,
    totalCents: totalById.get(r.id) ?? 0,
  }))
}

/** Cabecera + celdas + horas, en la forma que el motor puro consume. */
/**
 * **§9 · techo 1 y deuda C2 de la revisión** — el editor pintaba las celdas de
 * UNA versión sin paginación y el drill-down las filtraba **en memoria** tras
 * traerlas todas. Con las 28 800 celdas del techo, `getBudgetVersion` tardaba
 * ~2 300 ms contra un techo de 900 ms y traía 28 800 filas a la memoria del
 * servidor para pintar cien.
 *
 * La página es de **filas de la hoja** —(dimensión, cuenta, tipo)—, no de
 * celdas: una fila de la hoja son sus doce meses, y partirla por la mitad daría
 * una hoja con meses en blanco que no están en blanco. El recuento de filas y
 * los totales del ejercicio salen por agregado SQL (`budgetSheetSummary`), así
 * que **no dependen de la página**.
 */
export type BudgetRowWindow = { limit: number; offset: number }

export async function getBudgetVersion(
  tx: TenantTransactionClient,
  budgetId: string,
  opts: { rows?: BudgetRowWindow } = {}
): Promise<StoredBudgetVersion | null> {
  const header = await tx.budget.findFirst({
    where: { id: budgetId },
    include: { fiscalYear: { select: { code: true, startDate: true, endDate: true } } },
  })
  if (!header) return null

  // La ventana de filas, resuelta en SQL: `dense_rank()` sobre la clave de fila
  // y las líneas de las filas de esta página. Nunca se traen las 28 800 celdas
  // para quedarse con 1 200.
  let pageLineIds: string[] | null = null
  if (opts.rows) {
    // La ventana de filas, con **delegados de Prisma y no `$queryRaw`**: el `db`
    // que `tenantPage` entrega es un `TenantClient` que despacha las operaciones
    // de modelo sobre la transacción abierta, pero **`$queryRaw` se sale de
    // ella** y sin `app.current_org` la RLS devuelve VACÍO en silencio. Es el
    // hallazgo 3 de la ronda de integración de E10, repetido: aquí dejaba la
    // hoja en blanco con el presupuesto delante.
    //
    // Se leen sólo las cinco columnas de la clave de fila —no las 28 800 filas
    // completas con sus `include`— y la ventana se corta en memoria sobre un
    // orden estable. Lo que el techo 1 de §9 no admite es traer la versión
    // ENTERA hidratada para pintar cien filas.
    const keys = await tx.budgetLine.findMany({
      where: { budgetId },
      select: { id: true, projectId: true, costCenterId: true, accountCode: true, analyticType: true },
      orderBy: [
        { projectId: "asc" },
        { costCenterId: "asc" },
        { accountCode: "asc" },
        { analyticType: "asc" },
        { id: "asc" },
      ],
    })
    const ids: string[] = []
    let currentKey: string | null = null
    let rank = 0
    for (const row of keys) {
      const key = [row.projectId ?? "∅", row.costCenterId ?? "∅", row.accountCode ?? "∅", row.analyticType].join("|")
      if (key !== currentKey) {
        currentKey = key
        rank += 1
      }
      if (rank > opts.rows.offset && rank <= opts.rows.offset + opts.rows.limit) ids.push(row.id)
      if (rank > opts.rows.offset + opts.rows.limit) break
    }
    pageLineIds = ids
  }

  // En SERIE: dentro de la transacción hay UNA conexión.
  const lines = await tx.budgetLine.findMany({
    where: { budgetId, ...(pageLineIds === null ? {} : { id: { in: pageLineIds } }) },
    include: {
      project: { select: { code: true } },
      costCenter: { select: { code: true } },
      businessLine: { select: { code: true } },
    },
    orderBy: [{ month: "asc" }, { accountCode: "asc" }, { id: "asc" }],
  })
  const hours = await tx.budgetHoursLine.findMany({
    where: { budgetId },
    include: {
      project: { select: { code: true } },
      costCenter: { select: { code: true } },
      employee: { select: { code: true } },
    },
    orderBy: [{ month: "asc" }, { id: "asc" }],
  })

  return {
    id: header.id,
    scenario: header.scenario,
    revision: header.revision,
    code: budgetLabel(header.fiscalYear.code, header.scenario, header.revision),
    fiscalYearId: header.fiscalYearId,
    fiscalYearStart: fromUtcDate(header.fiscalYear.startDate),
    fiscalYearEnd: fromUtcDate(header.fiscalYear.endDate),
    status: header.status,
    validFrom: fromUtcDate(header.validFrom),
    validTo: header.validTo ? fromUtcDate(header.validTo) : null,
    partialFrom: header.partialFrom ? fromUtcDate(header.partialFrom) : null,
    seals: {
      budgetHash: header.budgetHash,
      marginConfigHash: header.marginConfigHash,
      gitSha: header.gitSha,
      sealedAt: header.sealedAt ? header.sealedAt.toISOString() : null,
    },
    cells: lines.map((l) => ({
      id: l.id,
      month: fromUtcDate(l.month),
      accountCode: l.accountCode,
      dimension:
        l.projectId !== null
          ? {
              kind: "PROJECT" as const,
              id: l.projectId,
              code: l.project?.code ?? "?",
              businessLineCode: l.businessLine?.code ?? null,
            }
          : { kind: "COST_CENTER" as const, id: l.costCenterId ?? "?", code: l.costCenter?.code ?? "?" },
      analyticType: l.analyticType,
      marginLevel: l.marginLevel,
      amountCents: l.amountCents,
      signException: l.signException,
    })),
    hours: hours.map((h) => ({
      month: fromUtcDate(h.month),
      dimension:
        h.projectId !== null
          ? { kind: "PROJECT" as const, id: h.projectId, code: h.project?.code ?? "?", businessLineCode: null }
          : { kind: "COST_CENTER" as const, id: h.costCenterId ?? "?", code: h.costCenter?.code ?? "?" },
      employeeCode: h.employee?.code ?? null,
      employeeId: h.employeeId,
      minutes: h.minutes,
    })),
  }
}

/**
 * **§9 · techo 1** — el recuento de filas y los totales del ejercicio por nivel
 * y por mes, **por agregado SQL**. Es lo que permite paginar la hoja sin mentir
 * en los totales: el pie de la tabla es del ejercicio entero aunque en pantalla
 * haya cien filas. Nunca se materializa el presupuesto para dar una cifra
 * (CLAUDE.md, estándar de calidad).
 */
export async function budgetSheetSummary(
  tx: TenantTransactionClient,
  budgetId: string
): Promise<{
  rowCount: number
  cellCount: number
  totalCents: Cents
  byMonthCents: Record<string, Cents>
  byLevelCents: Record<string, Cents>
}> {
  // **Agregados de servidor, no de memoria** (CLAUDE.md, §Estándar de calidad):
  // `groupBy` y `aggregate` son operaciones de MODELO, así que la extensión de
  // tenant las despacha sobre la transacción abierta y llevan `app.current_org`.
  // Con `$queryRaw` la consulta se sale de la transacción de `tenantPage` y la
  // RLS devuelve vacío en silencio.
  //
  // En SERIE: dentro de la transacción hay UNA conexión.
  const totals = await tx.budgetLine.aggregate({
    where: { budgetId },
    _count: { _all: true },
    _sum: { amountCents: true },
  })
  const byMonth = await tx.budgetLine.groupBy({
    by: ["month"],
    where: { budgetId },
    _sum: { amountCents: true },
    orderBy: { month: "asc" },
  })
  const byLevel = await tx.budgetLine.groupBy({
    by: ["marginLevel"],
    where: { budgetId },
    _sum: { amountCents: true },
    orderBy: { marginLevel: "asc" },
  })
  // El recuento de FILAS de la hoja: una fila es (dimensión, cuenta, tipo) con
  // sus doce meses. `groupBy` lo resuelve con un hash agregado en la base.
  const rows = await tx.budgetLine.groupBy({
    by: ["projectId", "costCenterId", "accountCode", "analyticType"],
    where: { budgetId },
    _count: { _all: true },
  })

  return {
    rowCount: rows.length,
    cellCount: totals._count._all,
    totalCents: totals._sum.amountCents ?? 0,
    byMonthCents: Object.fromEntries(
      byMonth.map((r) => [monthKey(fromUtcDate(r.month)), r._sum.amountCents ?? 0])
    ),
    byLevelCents: Object.fromEntries(byLevel.map((r) => [r.marginLevel, r._sum.amountCents ?? 0])),
  }
}

/**
 * **O-E10-9** — la versión **EFECTIVA** del ejercicio en una fecha, ya compuesta
 * a partir de la BASE y de las `REVISADO` parciales, con la procedencia mes a
 * mes. Nunca una versión suelta que pueda cubrir medio año.
 *
 * `null` cuando no hay ninguna versión sellada vigente: la columna de
 * presupuesto sale **vacía con leyenda** y el sello lleva `PRESUPUESTO_AUSENTE`
 * (EV-12). Nunca ceros.
 */
export async function activeBudgetAt(
  tx: TenantTransactionClient,
  input: { fiscalYearId: string; at: LocalDate }
): Promise<ComposedBudget | null> {
  // Todas las versiones SELLADAS del ejercicio que ya estaban vigentes en la
  // fecha. **No se filtra por `validTo`** a propósito (O-E10-9): una `BASE`
  // cerrada el 30-06 por una `REVISADO` parcial de julio sigue siendo la que
  // aporta enero-junio, y excluirla dejaba el año compuesto entero por la
  // revisión —los seis primeros meses a cero y nadie diciéndolo—. Lo que la
  // fecha decide es qué versiones han NACIDO ya, no cuáles siguen abiertas;
  // `composeBudget` hace el resto.
  const headers = await tx.budget.findMany({
    where: {
      fiscalYearId: input.fiscalYearId,
      status: { in: ["VIGENTE", "SUSTITUIDO"] },
      validFrom: { lte: toUtcDate(input.at) },
    },
    select: { id: true, validFrom: true, validTo: true },
    orderBy: [{ validFrom: "asc" }, { revision: "asc" }],
  })
  if (headers.length === 0) return null

  const versions: BudgetVersion[] = []
  for (const h of headers) {
    const v = await getBudgetVersion(tx, h.id)
    if (v) versions.push(v)
  }
  if (versions.length === 0) return null

  const months = fiscalYearMonths(versions[0].fiscalYearStart, versions[0].fiscalYearEnd)
  return composeBudget(versions, months)
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras: versiones
// ─────────────────────────────────────────────────────────────────────────────

export type CreateBudgetVersionInput = {
  fiscalYearId: string
  scenario: BudgetScenario
  name: string
  note?: string | null
  validFrom: LocalDate
  /** O-E10-9: con valor, la versión es PARCIAL y sustituye desde ese mes. */
  partialFrom?: LocalDate | null
  /** `REVISADO` que copia las celdas de otra versión. */
  copyFromBudgetId?: string | null
}

export async function createBudgetVersionTx(
  tx: TenantTransactionClient,
  input: CreateBudgetVersionInput,
  actor: Actor
): Promise<{ id: string; label: string; revision: number; copiedCells: number }> {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { id: input.fiscalYearId },
    select: { id: true, code: true, startDate: true, endDate: true },
  })
  if (!fiscalYear) e10Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "el ejercicio no existe en esta organización")

  // `BASE` es la revisión 0 y sólo hay una (CHECK `budgets_revision_base` +
  // `budgets_version_unique`); cada `REVISADO` toma la siguiente.
  const revision =
    input.scenario === "BASE"
      ? 0
      : ((
          await tx.budget.aggregate({
            where: { fiscalYearId: input.fiscalYearId, scenario: "REVISADO" },
            _max: { revision: true },
          })
        )._max.revision ?? 0) + 1

  const duplicate = await tx.budget.findFirst({
    where: { fiscalYearId: input.fiscalYearId, scenario: input.scenario, revision },
    select: { id: true },
  })
  if (duplicate) {
    e10Abort(
      "BUDGET_VERSION_EXISTS",
      "scenario",
      `ya existe la versión ${budgetLabel(fiscalYear.code, input.scenario, revision)}: crea una revisión nueva`
    )
  }

  const from = fromUtcDate(fiscalYear.startDate)
  const to = fromUtcDate(fiscalYear.endDate)
  if (input.validFrom < from || input.validFrom > to) {
    e10Abort(
      "BUDGET_VALIDITY",
      "validFrom",
      `la vigencia ${input.validFrom} cae fuera del ejercicio ${fiscalYear.code} (${from} … ${to})`
    )
  }

  const id = randomUUID()
  await tx.budget.create({
    data: {
      id,
      organizationId: tx.$organizationId,
      fiscalYearId: input.fiscalYearId,
      scenario: input.scenario,
      revision,
      name: input.name,
      note: input.note ?? null,
      status: "BORRADOR",
      validFrom: toUtcDate(input.validFrom),
      partialFrom: input.partialFrom ? toUtcDate(input.partialFrom) : null,
      createdById: actor.userId,
    },
  })

  let copiedCells = 0
  if (input.copyFromBudgetId) {
    const source = await tx.budgetLine.findMany({ where: { budgetId: input.copyFromBudgetId } })
    if (source.length > 0) {
      const created = await tx.budgetLine.createMany({
        data: source.map((l) => ({
          organizationId: tx.$organizationId,
          budgetId: id,
          month: l.month,
          accountCode: l.accountCode,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
          analyticType: l.analyticType,
          marginLevel: l.marginLevel,
          amountCents: l.amountCents,
          signException: l.signException,
          source: "COPIED_FROM_VERSION" as BudgetLineSource,
          note: l.note,
        })),
      })
      copiedCells = created.count
    }
    const sourceHours = await tx.budgetHoursLine.findMany({ where: { budgetId: input.copyFromBudgetId } })
    if (sourceHours.length > 0) {
      await tx.budgetHoursLine.createMany({
        data: sourceHours.map((h) => ({
          organizationId: tx.$organizationId,
          budgetId: id,
          month: h.month,
          projectId: h.projectId,
          costCenterId: h.costCenterId,
          employeeId: h.employeeId,
          minutes: h.minutes,
          source: "COPIED_FROM_VERSION" as BudgetLineSource,
        })),
      })
    }
  }

  const label = budgetLabel(fiscalYear.code, input.scenario, revision)
  await writeAuditLog(tx, {
    entity: "Budget",
    entityId: id,
    action: "create",
    after: {
      label,
      scenario: input.scenario,
      revision,
      validFrom: input.validFrom,
      partialFrom: input.partialFrom ?? null,
      copiedCells,
    },
    userId: actor.userId,
  })
  return { id, label, revision, copiedCells }
}

/**
 * **O-E10-8 / criterio 6** — sella la versión y **cierra la anterior en la misma
 * transacción** con `validTo = validFrom − 1 día`. El `EXCLUDE` impedía el
 * solape; el hueco, no.
 *
 * Escribe los tres sellos a la vez, que es lo que el CHECK `budgets_sealed_marks`
 * exige: un `budget_hash` sin `git_sha` no se puede reproducir y un `sealed_at`
 * sin hash no acredita nada.
 */
export async function sealBudgetTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; validFrom?: LocalDate; gitSha: string; marginConfigHash: string; sealedAt: Date },
  actor: Actor
): Promise<{
  budgetHash: string
  closedPreviousId: string | null
  closedPreviousTo: LocalDate | null
  warnings: { code: "PARTIAL_WITHOUT_HOURS"; message: string }[]
}> {
  const version = await getBudgetVersion(tx, input.budgetId)
  if (!version) e10Abort("BUDGET_NOT_FOUND", "budgetId", "la versión de presupuesto no existe en esta organización")
  if (version.status !== "BORRADOR") {
    e10Abort(
      "BUDGET_SEALED",
      "budgetId",
      `la versión ${version.code} está sellada desde ${version.validFrom}: crea una revisión en vez de editarla`
    )
  }

  const validFrom = input.validFrom ?? version.validFrom
  // El hash se toma sobre la versión TAL COMO QUEDA SELLADA: misma vigencia,
  // mismo estado. Sellar y hashear otra cosa sería firmar lo que no se guarda.
  const sealed: BudgetVersion = { ...version, validFrom, status: "VIGENTE" }
  const budgetHash = computeBudgetHash(sealed, input.marginConfigHash)

  // La anterior se cierra ANTES de sellar: el `EXCLUDE USING gist` no admite dos
  // vigencias solapadas ni un instante, y no es diferible.
  const previous = await tx.budget.findFirst({
    where: {
      fiscalYearId: version.fiscalYearId,
      status: "VIGENTE",
      id: { not: version.id },
      validFrom: { lt: toUtcDate(validFrom) },
      OR: [{ validTo: null }, { validTo: { gte: toUtcDate(validFrom) } }],
    },
    orderBy: { validFrom: "desc" },
    select: { id: true, validTo: true },
  })
  const closedPreviousTo = previous ? previousDay(validFrom) : null
  if (previous && closedPreviousTo !== null) {
    await tx.budget.update({
      where: { id: previous.id },
      data: { validTo: toUtcDate(closedPreviousTo) },
    })
  }

  // ── Hallazgo de B1: las horas cuelgan de CADA versión que cubre el mes ─────
  // `composeBudget` toma las celdas Y las horas del mes de la versión que lo
  // gobierna. Una `REVISADO` PARCIAL desde julio manda sobre julio-diciembre:
  // si se sella sin líneas de horas en esos meses, el año compuesto se queda
  // con las de enero-junio y `settleBudgetMatrix` reparte con **la mitad de la
  // base del driver**, sin que nada falle. La liquidación presupuestaria sale
  // más baja y comparable en apariencia, que es la peor forma de equivocarse.
  //
  // No se bloquea —presupuestar sin horas es legítimo mientras ninguna regla
  // use `HOURS`— pero el aviso viaja con el sello y queda en el `AuditLog`.
  const warnings: { code: "PARTIAL_WITHOUT_HOURS"; message: string }[] = []
  if (version.partialFrom !== null) {
    const fromMonth = monthKey(version.partialFrom)
    const coveredWithHours = version.hours.filter((h) => monthKey(h.month) >= fromMonth).length
    if (coveredWithHours === 0 && previous) {
      const previousHours = await tx.budgetHoursLine.count({
        where: { budgetId: previous.id, month: { gte: toUtcDate(version.partialFrom) } },
      })
      if (previousHours > 0) {
        warnings.push({
          code: "PARTIAL_WITHOUT_HOURS",
          message:
            `la versión ${version.code} es parcial desde ${version.partialFrom} y no lleva ni una línea de ` +
            `horas presupuestadas en los meses que gobierna, mientras que la versión que releva llevaba ` +
            `${previousHours}. El presupuesto compuesto se quedará sin esas horas y una regla de imputación ` +
            `por HORAS repartirá con una base incompleta: copia las horas a esta versión antes de sellarla`,
        })
      }
    }
  }

  await tx.budget.update({
    where: { id: version.id },
    data: {
      status: "VIGENTE",
      validTo: null,
      budgetHash,
      marginConfigHash: input.marginConfigHash,
      gitSha: input.gitSha,
      sealedAt: input.sealedAt,
      sealedById: actor.userId,
    },
  })

  await writeAuditLog(tx, {
    entity: "Budget",
    entityId: version.id,
    action: "SEAL_BUDGET",
    before: { status: "BORRADOR" },
    after: {
      code: version.code,
      status: "VIGENTE",
      validFrom,
      budgetHash,
      marginConfigHash: input.marginConfigHash,
      gitSha: input.gitSha,
      cells: version.cells.length,
      hoursLines: version.hours.length,
      // O-E10-8: la continuidad queda ESCRITA, no sólo hecha.
      closedPrevious: previous ? { id: previous.id, validTo: closedPreviousTo } : null,
      warnings: warnings.map((w) => w.code),
    },
    userId: actor.userId,
  })
  return { budgetHash, closedPreviousId: previous?.id ?? null, closedPreviousTo, warnings }
}

/**
 * Sustituir, nunca retirar: **no existe `ANULADO`** (misma doctrina que
 * `AllocationRun`, ADR-0013 D5). La versión sustituida sigue consultable y sigue
 * siendo la que explica los informes que firmó.
 */
export async function supersedeBudgetTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; supersededById: string; reason: string },
  actor: Actor
): Promise<void> {
  const reason = assertReason(input.reason, "reason", "la sustitución de una versión de presupuesto")
  const before = await tx.budget.findFirst({ where: { id: input.budgetId }, select: { id: true, status: true } })
  if (!before) e10Abort("BUDGET_NOT_FOUND", "budgetId", "la versión de presupuesto no existe en esta organización")
  if (before.status !== "VIGENTE") {
    e10Abort("BUDGET_NOT_SEALED", "budgetId", `sólo se sustituye una versión VIGENTE; ésta está en ${before.status}`)
  }
  const replacement = await tx.budget.findFirst({
    where: { id: input.supersededById },
    select: { id: true, status: true },
  })
  if (!replacement || replacement.status === "BORRADOR") {
    e10Abort(
      "BUDGET_SUPERSEDE_TARGET",
      "supersededById",
      "la versión que sustituye tiene que existir y estar sellada: un borrador no releva a nadie"
    )
  }
  await tx.budget.update({
    where: { id: before.id },
    data: { status: "SUSTITUIDO", supersededById: replacement.id },
  })
  await writeAuditLog(tx, {
    entity: "Budget",
    entityId: before.id,
    action: "SUPERSEDE_BUDGET",
    before: { status: before.status },
    after: { status: "SUSTITUIDO", supersededById: replacement.id },
    reason,
    userId: actor.userId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras: celdas
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetCellInput = {
  month: LocalDate
  accountCode?: string | null
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  analyticType: AnalyticType
  amountCents: Cents
  signException?: boolean
  note?: string | null
  source?: BudgetLineSource
}

async function assertDraft(tx: TenantTransactionClient, budgetId: string): Promise<{ id: string; label: string; status: BudgetStatus; fiscalYearId: string }> {
  const row = await tx.budget.findFirst({
    where: { id: budgetId },
    include: { fiscalYear: { select: { code: true } } },
  })
  if (!row) e10Abort("BUDGET_NOT_FOUND", "budgetId", "la versión de presupuesto no existe en esta organización")
  const label = budgetLabel(row.fiscalYear.code, row.scenario, row.revision)
  if (row.status !== "BORRADOR") {
    e10Abort(
      "BUDGET_SEALED",
      "budgetId",
      `la versión ${label} está sellada desde ${fromUtcDate(row.validFrom)}: crea una revisión en vez de editarla`
    )
  }
  return { id: row.id, label, status: row.status, fiscalYearId: row.fiscalYearId }
}

export type UpsertCellsResult = { written: number; warnings: { message: string }[] }

/**
 * Guardado **por lotes** (§9: 500 celdas en < 300 ms con `createMany` +
 * `updateMany`, nunca 500 `upsert`). Valida el **signo por tipo analítico**
 * (O-E10-6) y congela el `marginLevel` (O-E10-7) con la MISMA regla que el
 * trigger, para que el mensaje sea en español contable en vez de un `23514`.
 */
export async function upsertBudgetCellsTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; cells: readonly BudgetCellInput[]; config: AnalyticsConfig },
  actor: Actor
): Promise<UpsertCellsResult> {
  const budget = await assertDraft(tx, input.budgetId)
  if (input.cells.length === 0) return { written: 0, warnings: [] }

  const warnings: { message: string }[] = []
  // Índices O(1) de las dimensiones: `config.projects.find(...)` por celda es
  // O(celdas × dimensiones), y el techo 2 de §9 son 500 celdas por lote.
  const projectById = new Map(input.config.projects.map((p) => [p.id, p]))
  const businessLineById = new Map(input.config.businessLines.map((b) => [b.id, b]))
  const costCenterById = new Map(input.config.costCenters.map((c) => [c.id, c]))
  const prepared = input.cells.map((c) => {
    if ((c.projectId == null) === (c.costCenterId == null)) {
      e10Abort(
        "BUDGET_DIMENSION",
        "projectId",
        "una celda de presupuesto es de UN proyecto o de UN centro de coste, nunca de los dos ni de ninguno (O-A6)"
      )
    }
    if (c.accountCode != null && !["6", "7"].includes(c.accountCode.slice(0, 1))) {
      e10Abort(
        "BUDGET_ACCOUNT_NOT_PNL",
        "accountCode",
        `la cuenta ${c.accountCode} no es de explotación: el presupuesto de grupo 2 (CAPEX) llega en E11`
      )
    }
    // **R-A9** — `businessLineId` es una columna DENORMALIZADA del proyecto: la
    // escribe el código y la verifica un trigger. Dejarla nula con proyecto es
    // `23514`, y ponerla a mano invita a que diverja de la del proyecto.
    const project = c.projectId == null ? null : projectById.get(c.projectId)
    const businessLine = project ? businessLineById.get(project.businessLineId) : null
    const dimension: BudgetDimension =
      c.projectId != null
        ? {
            kind: "PROJECT",
            id: c.projectId,
            code: project?.code ?? "?",
            businessLineCode: businessLine?.code ?? null,
          }
        : {
            kind: "COST_CENTER",
            id: c.costCenterId ?? "?",
            code: (c.costCenterId == null ? undefined : costCenterById.get(c.costCenterId))?.code ?? "?",
          }
    const marginLevel = resolveBudgetMarginLevel(
      { accountCode: c.accountCode ?? null, analyticType: c.analyticType, dimension, month: c.month },
      input.config
    )
    const cell: BudgetCell = {
      month: c.month,
      accountCode: c.accountCode ?? null,
      dimension,
      analyticType: c.analyticType,
      marginLevel,
      amountCents: c.amountCents,
      signException: c.signException ?? false,
    }
    const sign = signOf(cell)
    if (!sign.ok && sign.kind === "WRONG_SIGN") e10Abort("BUDGET_SIGN", "amountCents", sign.message)
    if (!sign.ok) warnings.push({ message: sign.message })
    return { input: c, cell, businessLineId: project?.businessLineId ?? null }
  })

  // **§9 · techo 2 — «`createMany` + `updateMany`, nunca 500 `upsert`».**
  //
  // La ronda 0 hacía **un `findFirst` por celda** antes de decidir: con el lote
  // de 500 celdas del techo eran 500 ida y vuelta contra la base dentro de la
  // transacción, y el guardado tardaba ~800 ms contra un techo de 300 ms. T19 no
  // se ejecutó, así que nadie lo vio (revisión, hallazgo 1).
  //
  // La identidad de una celda es la de los cuatro índices parciales de O-A6 —con
  // nulos, que `updateMany` no sabe expresar—, así que las existentes se siguen
  // actualizando una a una; lo que desaparece es la **búsqueda** fila a fila:
  // se leen de golpe las líneas de los meses afectados y se indexan en memoria.
  const monthsTouched = [...new Set(prepared.map((p) => p.input.month))]
  const existingRows = await tx.budgetLine.findMany({
    where: { budgetId: budget.id, month: { in: monthsTouched.map(toUtcDate) } },
    select: { id: true, month: true, accountCode: true, projectId: true, costCenterId: true },
  })
  const identityOf = (row: {
    month: string
    accountCode: string | null
    projectId: string | null
    costCenterId: string | null
  }): string => [row.month, row.accountCode ?? "∅", row.projectId ?? "∅", row.costCenterId ?? "∅"].join("|")
  const existingByIdentity = new Map(
    existingRows.map((r) => [
      identityOf({
        month: fromUtcDate(r.month),
        accountCode: r.accountCode,
        projectId: r.projectId,
        costCenterId: r.costCenterId,
      }),
      r.id,
    ])
  )

  let written = 0
  const toCreate: Prisma.BudgetLineCreateManyInput[] = []
  const toUpdate: {
    id: string
    analyticType: AnalyticType
    marginLevel: MarginLevel
    amountCents: Cents
    signException: boolean
    note: string | null
  }[] = []
  for (const { input: c, cell, businessLineId } of prepared) {
    const existingId = existingByIdentity.get(
      identityOf({
        month: c.month,
        accountCode: c.accountCode ?? null,
        projectId: c.projectId ?? null,
        costCenterId: c.costCenterId ?? null,
      })
    )
    if (existingId !== undefined) {
      toUpdate.push({
        id: existingId,
        analyticType: cell.analyticType,
        marginLevel: cell.marginLevel,
        amountCents: cell.amountCents,
        signException: cell.signException,
        note: c.note ?? null,
      })
      continue
    }
    toCreate.push({
      organizationId: tx.$organizationId,
      budgetId: budget.id,
      month: toUtcDate(c.month),
      accountCode: c.accountCode ?? null,
      projectId: c.projectId ?? null,
      costCenterId: c.costCenterId ?? null,
      businessLineId: c.businessLineId ?? businessLineId,
      analyticType: cell.analyticType,
      marginLevel: cell.marginLevel,
      amountCents: cell.amountCents,
      signException: cell.signException,
      source: c.source ?? "MANUAL",
      note: c.note ?? null,
    })
  }
  // Las actualizaciones, en UNA sentencia: `UPDATE … FROM unnest(...)`. Con 500
  // celdas del techo, 500 `update()` de Prisma son 500 ida y vuelta dentro de la
  // transacción; esto es una.
  if (toUpdate.length > 0) {
    await tx.$executeRaw`
      UPDATE "budget_lines" AS bl
         SET "analytic_type"  = v.analytic_type::analytic_type,
             "margin_level"   = v.margin_level::margin_level,
             "amount_cents"   = v.amount_cents,
             "sign_exception" = v.sign_exception,
             "note"           = v.note
        FROM unnest(
               ${toUpdate.map((u) => u.id)}::uuid[],
               ${toUpdate.map((u) => u.analyticType)}::text[],
               ${toUpdate.map((u) => u.marginLevel)}::text[],
               ${toUpdate.map((u) => u.amountCents)}::int[],
               ${toUpdate.map((u) => u.signException)}::boolean[],
               ${toUpdate.map((u) => u.note)}::text[]
             ) AS v(id, analytic_type, margin_level, amount_cents, sign_exception, note)
       WHERE bl."id" = v.id AND bl."organization_id" = ${tx.$organizationId}::uuid`
    written += toUpdate.length
  }
  if (toCreate.length > 0) {
    const created = await tx.budgetLine.createMany({ data: toCreate })
    written += created.count
  }

  await writeAuditLog(tx, {
    entity: "BudgetLine",
    entityId: budget.id,
    action: "update",
    after: { label: budget.label, cells: written, warnings: warnings.length },
    userId: actor.userId,
  })
  return { written, warnings }
}

export async function deleteBudgetCellsTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; cellIds: readonly string[] },
  actor: Actor
): Promise<{ deleted: number }> {
  const budget = await assertDraft(tx, input.budgetId)
  if (input.cellIds.length === 0) return { deleted: 0 }
  const result = await tx.budgetLine.deleteMany({
    where: { budgetId: budget.id, id: { in: [...input.cellIds] } },
  })
  await writeAuditLog(tx, {
    entity: "BudgetLine",
    entityId: budget.id,
    action: "delete",
    after: { label: budget.label, deleted: result.count },
    userId: actor.userId,
  })
  return { deleted: result.count }
}

export type BudgetHoursInput = {
  month: LocalDate
  projectId?: string | null
  costCenterId?: string | null
  employeeId?: string | null
  minutes: number
}

/**
 * Las horas presupuestadas alimentan dos cosas: el KPI de horas y la
 * **liquidación presupuestaria** de O-E10-4. Sin ellas, `settleBudgetMatrix`
 * devuelve `BUDGET_NOT_SETTLEABLE` y el informe no publica las celdas por
 * dimensión de nivel ≥ MC3 (I-E10-18): es exactamente para eso para lo que la
 * tabla existe.
 */
export async function upsertBudgetHoursTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; rows: readonly BudgetHoursInput[] },
  actor: Actor
): Promise<{ written: number }> {
  const budget = await assertDraft(tx, input.budgetId)
  let written = 0
  for (const row of input.rows) {
    if (!Number.isInteger(row.minutes) || row.minutes < 0) {
      e10Abort("BUDGET_DIMENSION", "minutes", `los minutos presupuestados son enteros ≥ 0; recibido ${row.minutes}`)
    }
    if ((row.projectId == null) === (row.costCenterId == null)) {
      e10Abort("BUDGET_DIMENSION", "projectId", "las horas presupuestadas van a UN proyecto o a UN centro de coste")
    }
    const existing = await tx.budgetHoursLine.findFirst({
      where: {
        budgetId: budget.id,
        month: toUtcDate(row.month),
        projectId: row.projectId ?? null,
        costCenterId: row.costCenterId ?? null,
        employeeId: row.employeeId ?? null,
      },
      select: { id: true },
    })
    if (existing) {
      await tx.budgetHoursLine.update({ where: { id: existing.id }, data: { minutes: row.minutes } })
    } else {
      await tx.budgetHoursLine.create({
        data: {
          organizationId: tx.$organizationId,
          budgetId: budget.id,
          month: toUtcDate(row.month),
          projectId: row.projectId ?? null,
          costCenterId: row.costCenterId ?? null,
          employeeId: row.employeeId ?? null,
          minutes: row.minutes,
        },
      })
    }
    written += 1
  }
  await writeAuditLog(tx, {
    entity: "BudgetLine",
    entityId: budget.id,
    action: "update",
    after: { label: budget.label, hoursLines: written },
    userId: actor.userId,
  })
  return { written }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import CSV — R-B-6: la convención invertida rechaza el fichero ENTERO
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetImportReport = {
  inserted: number
  rejected: number
  /** El diagnóstico, fila a fila. Un contador sin motivos no se audita. */
  reasons: { line: number; reason: string }[]
  /** R-B-6: el fichero entero se rechazó por la convención de signo. */
  fileRejected: boolean
}

/**
 * **R-B-6 / criterio 28.** Con más del 90 % de las líneas de grupo 6 en
 * positivo, la convención del fichero está invertida y se rechaza **entero**,
 * sin insertar una sola fila.
 *
 * Importar la mitad al revés es peor que no importar: el total cuadra por
 * casualidad en algunos niveles, la desviación sale del doble en otros y nadie
 * sabe qué mirar.
 */
export async function importBudgetCsvTx(
  tx: TenantTransactionClient,
  input: { budgetId: string; rows: readonly (BudgetCellInput & { lineNo: number })[]; config: AnalyticsConfig },
  actor: Actor
): Promise<BudgetImportReport> {
  const budget = await assertDraft(tx, input.budgetId)
  const report: BudgetImportReport = { inserted: 0, rejected: 0, reasons: [], fileRejected: false }
  if (input.rows.length === 0) return report

  const asCells: BudgetCell[] = input.rows.map((r) => ({
    month: r.month,
    accountCode: r.accountCode ?? null,
    dimension:
      r.projectId != null
        ? { kind: "PROJECT", id: r.projectId, code: "?", businessLineCode: null }
        : { kind: "COST_CENTER", id: r.costCenterId ?? "?", code: "?" },
    analyticType: r.analyticType,
    marginLevel: "EBITDA",
    amountCents: r.amountCents,
    signException: r.signException ?? false,
  }))

  const inverted = detectInvertedSignConvention(asCells)
  if (inverted) {
    report.fileRejected = true
    report.rejected = input.rows.length
    report.reasons.push({
      line: 0,
      reason:
        "más del 90 % de las líneas de grupo 6 vienen en POSITIVO: la convención de signo del fichero está " +
        "invertida (en este producto el gasto presupuestado es NEGATIVO, D2). No se ha insertado ninguna fila: " +
        "corrige el signo en origen y vuelve a importar",
    })
    await writeAuditLog(tx, {
      entity: "Budget",
      entityId: budget.id,
      action: "IMPORT_BUDGET",
      after: { label: budget.label, fileRejected: true, rows: input.rows.length },
      userId: actor.userId,
    })
    return report
  }

  const written = await upsertBudgetCellsTx(
    tx,
    {
      budgetId: budget.id,
      cells: input.rows.map((r) => ({ ...r, source: "CSV_IMPORT" as BudgetLineSource })),
      config: input.config,
    },
    actor
  )
  report.inserted = written.written
  await writeAuditLog(tx, {
    entity: "Budget",
    entityId: budget.id,
    action: "IMPORT_BUDGET",
    after: { label: budget.label, inserted: report.inserted, rows: input.rows.length },
    userId: actor.userId,
  })
  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// Q-4 — propuesta de presupuesto de amortización
// ─────────────────────────────────────────────────────────────────────────────

export type DepreciationBudgetLine = {
  month: LocalDate
  accountCode: string
  projectId: string | null
  costCenterId: string | null
  amountCents: Cents
  assetId: string
  assetCode: string
  /** Los términos, para que la cifra se pueda rehacer a mano. */
  terms: { baseCents: Cents; method: string; remainingMonths: number; inServiceDate: LocalDate }
}

export type DepreciationBudgetProposal = {
  fiscalYearId: string
  lines: readonly DepreciationBudgetLine[]
  totalCents: Cents
  /** Activos que no se pudieron proponer y por qué. Nunca se omiten en silencio. */
  skipped: readonly { assetCode: string; reason: string }[]
}

/**
 * **Q-4** — precarga las líneas `68x` mes a mes con la dotación de los activos
 * **ya en alta**, con su dimensión analítica y sus términos. Reutiliza el cuadro
 * de E9 (`depreciationSchedule`); es **propuesta, nunca aplicación** (patrón
 * `deriveHourlyCost`). El CAPEX del grupo 2 es E11, y el CHECK
 * `budget_lines_pnl_only` lo impide aquí.
 */
export async function proposeDepreciationBudget(
  tx: TenantTransactionClient,
  input: { fiscalYearId: string }
): Promise<DepreciationBudgetProposal> {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { id: input.fiscalYearId },
    select: { id: true, startDate: true, endDate: true },
  })
  if (!fiscalYear) e10Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "el ejercicio no existe en esta organización")
  const from = fromUtcDate(fiscalYear.startDate)
  const to = fromUtcDate(fiscalYear.endDate)

  const assets = await tx.fixedAsset.findMany({
    where: { disposalDate: null },
    include: { revisions: true },
    orderBy: { code: "asc" },
  })

  const lines: DepreciationBudgetLine[] = []
  const skipped: { assetCode: string; reason: string }[] = []
  let totalCents = 0

  for (const asset of assets) {
    if (asset.method !== "LINEAL") {
      skipped.push({ assetCode: asset.code, reason: `método ${asset.method}: el motor sólo resuelve LINEAL (E9 D2.1)` })
      continue
    }
    const schedule = depreciationSchedule(
      {
        id: asset.id,
        code: asset.code,
        name: asset.name,
        method: "LINEAL",
        inServiceDate: fromUtcDate(asset.inServiceDate),
        acquisitionCostCents: centsFromDb(asset.acquisitionCostCents, "coste de adquisición"),
        residualValueCents: centsFromDb(asset.residualValueCents, "valor residual"),
        usefulLifeMonths: asset.usefulLifeMonths,
        assetAccountCode: asset.assetAccountCode,
        accumulatedAccountCode: asset.accumulatedAccountCode,
        expenseAccountCode: asset.expenseAccountCode,
        projectId: asset.projectId,
        costCenterId: asset.costCenterId,
      },
      asset.revisions.map((r) => ({
        effectiveFrom: fromUtcDate(r.effectiveFrom),
        newUsefulLifeMonths: r.newUsefulLifeMonths,
        newResidualValueCents: r.newResidualValueCents === null ? null : centsFromDb(r.newResidualValueCents, "valor residual revisado"),
        addedCostCents: r.addedCostCents === null ? null : centsFromDb(r.addedCostCents, "mejora capitalizada"),
        reason: r.reason,
      }))
    )

    for (const row of schedule) {
      if (row.period < from.slice(0, 7) || row.period > to.slice(0, 7)) continue
      // APORTE: la dotación es un gasto, así que va en NEGATIVO (D2).
      const amountCents = -row.quotaCents
      if (amountCents === 0) continue
      lines.push({
        month: `${row.period}-01`,
        accountCode: asset.expenseAccountCode,
        projectId: asset.projectId,
        costCenterId: asset.costCenterId,
        amountCents,
        assetId: asset.id,
        assetCode: asset.code,
        terms: {
          baseCents:
            centsFromDb(asset.acquisitionCostCents, "coste") - centsFromDb(asset.residualValueCents, "residual"),
          method: "LINEAL",
          remainingMonths: asset.usefulLifeMonths,
          inServiceDate: fromUtcDate(asset.inServiceDate),
        },
      })
      totalCents += amountCents
    }
  }

  return { fiscalYearId: input.fiscalYearId, lines, totalCents, skipped }
}
