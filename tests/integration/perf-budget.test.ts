import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · T19 — Rendimiento del presupuesto y las horas (§9 del diseño).
 *
 * **Los NUEVE techos de §9, activos.** La ronda 0 no ejecutó T19 y el revisor lo
 * declaró BLOQUEANTE (hallazgo 1): *«ninguno de los nueve techos está medido»*.
 * Aquí se miden los nueve, con las dos métricas de E6-perf —**ms** y
 * **conexiones simultáneas por petición**— sobre Postgres de verdad.
 *
 * **El volumen se siembra a la escala EXACTA que el techo describe**, que es lo
 * que el techo mide: 12 meses × 120 cuentas × 20 dimensiones (28 800 celdas),
 * 30 000 líneas de import, 40 empleados × 22 días, 120 000 partes del ejercicio,
 * 17 periodos de liquidación y 17 runs sellados. El fixture
 * `ejercicio-completo-v2` (schemaVersion 3.1, T20) es una comodidad para tener
 * un diario realista detrás, no la medida: los techos que dependen sólo del
 * volumen se siembran aquí y no esperan a nadie.
 *
 * Cubre el **criterio 26** de §12 («Rendimiento y pureza: los nueve techos de §9
 * se cumplen con volumen real»); la pureza de `lib/budget/**` y `lib/time/**` la
 * vigila el guard y ESLint, no un test.
 *
 * Los partes se siembran con los triggers de usuario apagados **a propósito**:
 * `assert_time_entry_daily_ceiling` hace un agregado por fila y sembrar 120 000
 * partes tardaría minutos midiendo lo que no se quiere medir. El techo diario
 * (O-E10-21) lo ejercen `e10-esquema.test.ts` y `e10-ronda-integracion.test.ts`;
 * el volumen sembrado lo respeta igualmente (12 partes de 100 min por empleado
 * y día = 1 200 ≤ 1 440).
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const APP_NAME = "erp-perf-budget"
if (TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set("application_name", APP_NAME)
  process.env.DATABASE_URL = url.toString()
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getAnalyticsConfig, seedAnalyticsDefaults } = await import("@/models/analytics")
const { budgetSheetSummary, getBudgetVersion, importBudgetCsvTx, upsertBudgetCellsTx } = await import(
  "@/models/budget"
)
const { createBudgetVersionTx } = await import("@/models/budget")
const { minutesByTargetMonthSql } = await import("@/models/time")
const { allocationRunStalenessBatch, listAllocationRuns } = await import("@/models/allocations")
const { buildBudgetMatrix, settleBudgetMatrix } = await import("@/lib/budget/matrix")
const { listTimeEntries } = await import("@/models/time")

const ORG = "e10ff000-0000-4000-8000-00000000000a"
const USER = "e10ff000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const FY_START = "2026-01-01"
const FY_END = "2026-12-31"
const MAX_CONNECTIONS = 2

/** §9 — el volumen que cada techo describe, en un solo sitio. */
const SCALE = {
  months: 12,
  accounts: 120,
  dimensions: 20,
  get cells() {
    return this.months * this.accounts * this.dimensions
  },
  batchCells: 500,
  csvLines: 30_000,
  employees: 40,
  /** 25 proyectos: 14 entran en la retícula de 20 dimensiones del techo 1, y
   *  los 25 hacen falta para que las 30 000 líneas del import tengan celda
   *  ÚNICA (12 meses × 120 cuentas × 25 proyectos = 36 000 combinaciones). */
  projects: 25,
  daysPerMonth: 22,
  yearEntries: 120_000,
  settlementPeriods: 17,
} as const

class ConnectionWatcher {
  private client: Client | null = null
  max = 0
  async start(): Promise<void> {
    this.client = new Client({ connectionString: TEST_DATABASE_URL, application_name: `${APP_NAME}-watch` })
    await this.client.connect()
  }
  async stop(): Promise<void> {
    await this.client?.end()
  }
  private async sample(): Promise<void> {
    if (!this.client) return
    const { rows } = await this.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND state IN ('active', 'idle in transaction')`,
      [APP_NAME]
    )
    this.max = Math.max(this.max, Number(rows[0]?.n ?? 0))
  }
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; maxConnections: number; ms: number }> {
    this.max = 0
    let running = true
    const poll = (async () => {
      while (running) {
        await this.sample()
        await new Promise((r) => setTimeout(r, 5))
      }
      await this.sample()
    })()
    const startedAt = performance.now()
    try {
      const value = await fn()
      return { value, maxConnections: this.max, ms: performance.now() - startedAt }
    } finally {
      running = false
      await poll
    }
  }
}

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · T19 — perf-budget (§9, los NUEVE techos)", () => {
  const watcher = new ConnectionWatcher()
  let fiscalYearId = ""
  let budgetId = ""
  let draftId = ""
  let importDraftId = ""
  let settleBudgetId = ""
  const projectIds: string[] = []
  const cecoIds: string[] = []
  const employeeIds: string[] = []
  const accountCodes: string[] = []

  beforeAll(async () => {
    await watcher.start()
    await limpiar()

    await prisma.user.upsert({
      where: { id: USER },
      update: {},
      create: { id: USER, email: `${USER}@test.local`, name: "Perf presupuesto" },
    })
    await prisma.organization.create({
      data: { id: ORG, slug: "e10-perf-budget", name: "E10 Perf SL", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() } })

    await importNpgc(ORG, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: FY_START, endDate: FY_END }, actor)
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    fiscalYearId = fy.value.id

    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: FY_START, userId: USER })
    })

    // 20 dimensiones: 14 proyectos + 6 CECOs, la retícula de columnas de §9.
    await tenantTransaction(ORG, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      for (let i = 0; i < SCALE.projects; i++) {
        projectIds.push(
          (
            await tx.project.create({
              data: {
                organizationId: ORG,
                code: `PF-${String(i + 1).padStart(3, "0")}`,
                name: `Proyecto perf ${i + 1}`,
                businessLineId: bl.id,
                sortOrder: i + 1,
              },
            })
          ).id
        )
      }
      const existing = await tx.costCenter.findMany({ where: { code: { not: "SIN_ASIGNAR" } } })
      for (const c of existing) cecoIds.push(c.id)
      for (let i = cecoIds.length; i < 6; i++) {
        cecoIds.push(
          (
            await tx.costCenter.create({
              data: {
                organizationId: ORG,
                code: `CCF-${String(i + 1).padStart(3, "0")}`,
                name: `CECO perf ${i + 1}`,
                marginLevel: "MC3",
                allocatable: true,
                sortOrder: 100 + i,
              },
            })
          ).id
        )
      }
      // 120 cuentas de gasto directo con tipo analítico: las de §9.
      const rows = await tx.ledgerAccount.findMany({
        where: { isPostable: true, code: { startsWith: "62" } },
        select: { code: true },
        orderBy: { code: "asc" },
      })
      const more = await tx.ledgerAccount.findMany({
        where: { isPostable: true, code: { startsWith: "6" } },
        select: { code: true },
        orderBy: { code: "asc" },
      })
      for (const r of [...rows, ...more]) {
        if (accountCodes.length >= SCALE.accounts) break
        if (!accountCodes.includes(r.code)) accountCodes.push(r.code)
      }
      // 40 empleados con su tarifa: la escala de `/time`.
      for (let i = 0; i < SCALE.employees; i++) {
        employeeIds.push(
          (
            await tx.employee.create({
              data: {
                organizationId: ORG,
                code: `EF-${String(i + 1).padStart(3, "0")}`,
                name: `Empleado perf ${i + 1}`,
                defaultCostCenterId: cecoIds[i % cecoIds.length],
                updatedAt: new Date(),
              },
            })
          ).id
        )
      }
    })
    if (accountCodes.length < SCALE.accounts) {
      throw new Error(`el plan sólo aporta ${accountCodes.length} cuentas de gasto y §9 pide ${SCALE.accounts}`)
    }

    // ── Las 28 800 celdas, sembradas en bruto (el techo mide la LECTURA) ─────
    const version = await tenantTransaction(ORG, USER, async (tx) =>
      createBudgetVersionTx(
        tx,
        { fiscalYearId, scenario: "BASE", name: "Base perf", validFrom: FY_START },
        actor
      )
    )
    budgetId = version.id
    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_lines DISABLE TRIGGER USER`)
      const dims = [
        ...projectIds.slice(0, 14).map((id) => ({ projectId: id, costCenterId: null as string | null })),
        ...cecoIds.map((id) => ({ projectId: null as string | null, costCenterId: id })),
      ].slice(0, SCALE.dimensions)
      for (let month = 1; month <= SCALE.months; month++) {
        const values: string[] = []
        const params: unknown[] = []
        let n = 0
        for (const account of accountCodes) {
          for (const dim of dims) {
            params.push(
              ORG,
              budgetId,
              `2026-${String(month).padStart(2, "0")}-01`,
              account,
              dim.projectId,
              dim.costCenterId,
              -1_000 - n
            )
            const b = n * 7
            values.push(
              `(gen_random_uuid(), $${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}::date, $${b + 4}, ` +
                `$${b + 5}::uuid, $${b + 6}::uuid, 'COSTE_DIRECTO_MC2'::analytic_type, 'MC2'::margin_level, ` +
                `$${b + 7}, false, 'MANUAL')`
            )
            n += 1
          }
        }
        await client.query(
          `INSERT INTO budget_lines (id, organization_id, budget_id, month, account_code, project_id, cost_center_id,
             analytic_type, margin_level, amount_cents, sign_exception, source) VALUES ` + values.join(", "),
          params
        )
      }
      await client.query(`ALTER TABLE budget_lines ENABLE TRIGGER USER`)
    })

    // Un borrador aparte para el guardado por lotes y el import CSV.
    draftId = (
      await tenantTransaction(ORG, USER, async (tx) =>
        createBudgetVersionTx(
          tx,
          { fiscalYearId, scenario: "REVISADO", name: "Borrador perf", validFrom: "2026-02-01" },
          actor
        )
      )
    ).id

    importDraftId = (
      await tenantTransaction(ORG, USER, async (tx) =>
        createBudgetVersionTx(
          tx,
          { fiscalYearId, scenario: "REVISADO", name: "Borrador import perf", validFrom: "2026-03-01" },
          actor
        )
      )
    ).id

    // Un presupuesto ANUAL de verdad (12 meses × 20 dimensiones × 2 cuentas =
    // 480 celdas) para los techos 4 y 5, que miden el ejercicio y no la hoja de
    // estrés del techo 1.
    settleBudgetId = (
      await tenantTransaction(ORG, USER, async (tx) => {
        const version = await createBudgetVersionTx(
          tx,
          { fiscalYearId, scenario: "REVISADO", name: "Presupuesto anual perf", validFrom: "2026-04-01" },
          actor
        )
        const config = await getAnalyticsConfig(tx, { periodEnd: FY_END })
        const dims = [
          ...projectIds.slice(0, 14).map((id) => ({ projectId: id as string | null, costCenterId: null as string | null })),
          ...cecoIds.map((id) => ({ projectId: null as string | null, costCenterId: id as string | null })),
        ].slice(0, SCALE.dimensions)
        await upsertBudgetCellsTx(
          tx,
          {
            budgetId: version.id,
            config,
            cells: Array.from({ length: SCALE.months }, (_, m) => m + 1).flatMap((month) =>
              dims.flatMap((dim, i) => [
                {
                  month: `2026-${String(month).padStart(2, "0")}-01`,
                  accountCode: accountCodes[i % accountCodes.length],
                  ...dim,
                  analyticType: (dim.projectId ? "COSTE_DIRECTO_MC2" : "INDIRECTO_CECO") as
                    | "COSTE_DIRECTO_MC2"
                    | "INDIRECTO_CECO",
                  amountCents: -(10_000 + i),
                },
              ])
            ),
          },
          actor
        )
        return version
      })
    ).id

    // ── Los 120 000 partes del ejercicio (40 empleados × 250 días × 12) ──────
    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      // Plan simple a propósito: tres `generate_series` y un módulo para elegir
      // proyecto. La versión con `CROSS JOIN LATERAL … LIMIT 12` producía el
      // mismo volumen y tardaba minutos.
      await client.query(
        `INSERT INTO time_entries (id, organization_id, employee_id, date, project_id, business_line_id,
                                   minutes, productive, status, approved_at, approved_by_id, source, created_at)
         SELECT gen_random_uuid(), $1::uuid,
                emp.id,
                d.dia,
                ($5::uuid[])[(k.k % array_length($5::uuid[], 1)) + 1],
                (SELECT id FROM business_lines WHERE organization_id = $1::uuid LIMIT 1),
                100, true, 'APROBADO', now(), $6::uuid, 'MANUAL', now()
           FROM unnest($2::uuid[]) AS emp(id)
           CROSS JOIN generate_series($3::date, $4::date, interval '1 day') AS d(dia)
           CROSS JOIN generate_series(1, 12) AS k(k)
          WHERE extract(isodow from d.dia) < 6`,
        [ORG, employeeIds, FY_START, FY_END, projectIds, USER]
      )
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
    })
  }, 900_000)

  afterAll(async () => {
    await watcher.stop()
    await limpiar()
    await prisma.$disconnect()
  }, 600_000)

  async function limpiar(): Promise<void> {
    await owner(async (client) => {
      for (const table of ["time_entries", "budgets", "budget_lines", "budget_hours_lines"]) {
        await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`).catch(() => undefined)
      }
      for (const table of [
        "budget_hours_lines",
        "budget_lines",
        "budgets",
        "time_entries",
        "employee_rates",
        "headcount_snapshots",
        "employees",
        "allocation_lines",
        "allocation_runs",
        "allocation_rule_targets",
        "allocation_rules",
        "report_runs",
        "invariant_runs",
        "journal_lines",
        "journal_entries",
        "period_locks",
        "fiscal_years",
        "cost_centers",
        "projects",
        "business_lines",
        "margin_level_configs",
        "tax_rates",
        "organization_account_maps",
        "accounts",
      ]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1::uuid`, [ORG]).catch(() => undefined)
      }
      for (const table of ["time_entries", "budgets", "budget_lines", "budget_hours_lines"]) {
        await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`).catch(() => undefined)
      }
      await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG]).catch(() => undefined)
      await client.query(`DELETE FROM users WHERE id = $1`, [USER]).catch(() => undefined)
    })
  }

  // ── 1 ─────────────────────────────────────────────────────────────────────
  it(`1/9 · \`/analytics/budget\` con ${SCALE.cells} celdas: < 900 ms, 1 transacción y ≤ ${MAX_CONNECTIONS} conexiones`, async () => {
    const sembradas = await prisma.budgetLine.count({ where: { budgetId } })
    expect(sembradas).toBe(SCALE.cells)

    // Lo que la PANTALLA hace: los totales del ejercicio por agregado SQL y una
    // página de filas de la hoja. Traerse las 28 800 celdas para pintar cien
    // costaba ~2 300 ms (y era la deuda C2: «el editor pinta las celdas de UNA
    // versión … pide paginación»).
    const { value, ms, maxConnections } = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) => {
        const summary = await budgetSheetSummary(tx, budgetId)
        const page = await getBudgetVersion(tx, budgetId, { rows: { limit: 100, offset: 0 } })
        return { summary, page }
      })
    )
    // Los totales son del EJERCICIO ENTERO, no de la página.
    expect(value.summary.cellCount).toBe(SCALE.cells)
    expect(value.summary.rowCount).toBe(SCALE.accounts * SCALE.dimensions)
    expect(Object.keys(value.summary.byMonthCents)).toHaveLength(SCALE.months)
    // Y la página son cien filas de la hoja: sus doce meses, ni una celda más.
    expect(value.page?.cells).toHaveLength(100 * SCALE.months)
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(900)
    expect(maxConnections).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 300_000)

  // ── 2 ─────────────────────────────────────────────────────────────────────
  it(`2/9 · guardado por lotes de ${SCALE.batchCells} celdas en < 300 ms`, async () => {
    const cells = Array.from({ length: SCALE.batchCells }, (_, i) => ({
      month: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`,
      accountCode: accountCodes[i % accountCodes.length],
      projectId: projectIds[i % projectIds.length],
      analyticType: "COSTE_DIRECTO_MC2" as const,
      amountCents: -(1_000 + i),
    }))
    // La configuración analítica es una lectura de la PANTALLA, no del guardado:
    // el techo de §9 mide «`createMany` + `updateMany`, nunca 500 `upsert`».
    const config = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticsConfig(tx, { periodEnd: FY_END })
    )
    const { ms } = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) => upsertBudgetCellsTx(tx, { budgetId: draftId, config, cells }, actor))
    )
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(300)
  }, 300_000)

  // ── 3 ─────────────────────────────────────────────────────────────────────
  it(`3/9 · import de ${SCALE.csvLines} líneas en < 20 s, en lotes de 5 000 y sin transacción > 15 s`, async () => {
    // Cada línea, una celda DISTINTA: el import real no trae 30 000 filas para
    // la misma celda, y el índice único de O-A6 lo impediría con razón.
    const rows = Array.from({ length: SCALE.csvLines }, (_, i) => ({
      lineNo: i + 1,
      month: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`,
      accountCode: accountCodes[Math.floor(i / 12) % accountCodes.length],
      projectId: projectIds[Math.floor(i / (12 * accountCodes.length)) % projectIds.length],
      analyticType: "COSTE_DIRECTO_MC2" as const,
      amountCents: -(1_000 + i),
    }))

    const batches: number[] = []
    const { ms } = await watcher.measure(async () => {
      const size = 5_000
      for (let i = 0; i < rows.length; i += size) {
        const started = performance.now()
        await tenantTransaction(ORG, USER, async (tx) => {
          const config = await getAnalyticsConfig(tx, { periodEnd: FY_END })
          return importBudgetCsvTx(tx, { budgetId: importDraftId, config, rows: rows.slice(i, i + size) }, actor)
        })
        batches.push(performance.now() - started)
      }
    })
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(20_000)
    // «ninguna transacción > 15 s»: el techo es del LOTE, no sólo del total.
    expect(Math.max(...batches), `lote más lento ${Math.round(Math.max(...batches))} ms`).toBeLessThan(15_000)
  }, 600_000)

  // ── 4 y 5 ─────────────────────────────────────────────────────────────────
  it("4/9 y 5/9 · matriz anual y `settleBudgetMatrix` (17 periodos, 6 reglas) en < 1 500 ms y < 350 ms", async () => {
    // **La escala de estos dos techos es la del EJERCICIO, no la de la hoja de
    // estrés.** §9 pide «`settleBudgetMatrix` de un ejercicio (17 periodos, 6
    // reglas)» y «`/analytics/budget-vs-actual` anual con imputaciones»: un
    // presupuesto anual de verdad, no las 28 800 celdas del techo 1, que miden
    // la LECTURA de la pantalla del editor. Medirlos sobre la hoja de estrés
    // sería medir otra cosa y llamarla igual.
    const { version, config, rules } = await tenantTransaction(ORG, USER, async (tx) => ({
      version: await getBudgetVersion(tx, settleBudgetId),
      config: await getAnalyticsConfig(tx, { periodEnd: FY_END }),
      rules: await (await import("@/models/allocations")).getAllocationRuleSpecs(tx, { periodEnd: FY_END }),
    }))
    if (!version) throw new Error("no hay versión que medir")
    expect(version.cells.length).toBeGreaterThan(0)

    const matriz = await watcher.measure(async () => buildBudgetMatrix(version, config, { from: FY_START, to: FY_END }))
    expect(matriz.ms, `matriz ${Math.round(matriz.ms)} ms`).toBeLessThan(1_500)

    // `settleBudgetMatrix` es `allocate()` puro sobre celdas ya leídas: sin IO.
    const liquidacion = await watcher.measure(async () =>
      settleBudgetMatrix(matriz.value, {
        rules,
        budgetHours: version.hours,
        headcount: [],
        config,
        period: {
          kind: "YEAR",
          label: "2026",
          start: FY_START,
          end: FY_END,
          fiscalYearId,
          fiscalYearStart: FY_START,
          fiscalYearEnd: FY_END,
        },
      })
    )
    expect(liquidacion.ms, `liquidación ${Math.round(liquidacion.ms)} ms`).toBeLessThan(350)
  }, 300_000)

  // ── 6 ─────────────────────────────────────────────────────────────────────
  it(`6/9 · \`/time\` de un mes con ${SCALE.employees} × ${SCALE.daysPerMonth} partes en < 400 ms`, async () => {
    const { value, ms, maxConnections } = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        listTimeEntries(tx, { from: "2026-03-01", to: "2026-03-31" }, { take: 1_000 })
      )
    )
    expect(value.total).toBeGreaterThan(SCALE.employees * SCALE.daysPerMonth)
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(400)
    expect(maxConnections).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 300_000)

  // ── 7 ─────────────────────────────────────────────────────────────────────
  it("7/9 · agregado de horas del EJERCICIO COMPLETO en < 600 ms, en SQL", async () => {
    const total = await prisma.timeEntry.count()
    expect(total, "el volumen sembrado tiene que ser del orden de §9").toBeGreaterThan(100_000)

    const { value, ms } = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        minutesByTargetMonthSql(tx, { from: FY_START, to: FY_END }, { productiveOnly: true, approvedOnly: true })
      )
    )
    // Agregado por (receptor, mes): jamás materializando los 120 000 partes.
    expect(value.length).toBeLessThanOrEqual(SCALE.dimensions * SCALE.months)
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(600)
  }, 300_000)

  // ── 8 y 9 ─────────────────────────────────────────────────────────────────
  it(`8/9 y 9/9 · liquidación anual con \`HOURS\` en < 500 ms y \`allocationRunStalenessBatch\` de ${SCALE.settlementPeriods} runs en 3 consultas y < 250 ms`, async () => {
    // 17 runs sellados: los doce meses, los cuatro trimestres y el año (§3.3).
    const periodos: { kind: "MONTH" | "QUARTER" | "YEAR"; start: string; end: string }[] = [
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: "MONTH" as const,
        start: `2026-${String(i + 1).padStart(2, "0")}-01`,
        end: `2026-${String(i + 1).padStart(2, "0")}-${new Date(Date.UTC(2026, i + 1, 0)).getUTCDate()}`,
      })),
      ...Array.from({ length: 4 }, (_, q) => ({
        kind: "QUARTER" as const,
        start: `2026-${String(q * 3 + 1).padStart(2, "0")}-01`,
        end: `2026-${String(q * 3 + 3).padStart(2, "0")}-${new Date(Date.UTC(2026, q * 3 + 3, 0)).getUTCDate()}`,
      })),
      { kind: "YEAR" as const, start: FY_START, end: FY_END },
    ]
    expect(periodos).toHaveLength(SCALE.settlementPeriods)

    await prisma.allocationRun.createMany({
      data: periodos.map((p) => ({
        organizationId: ORG,
        fiscalYearId,
        periodKind: p.kind,
        periodStart: new Date(`${p.start}T00:00:00Z`),
        periodEnd: new Date(`${p.end}T00:00:00Z`),
        status: "SEALED" as const,
        ledgerHash: "0".repeat(64),
        analyticsHash: "0".repeat(64),
        rulesHash: "0".repeat(64),
        linesHash: "0".repeat(64),
        timeHash: "∅",
        gitSha: "perf",
      })),
    })

    const runs = await tenantTransaction(ORG, USER, async (tx) => listAllocationRuns(tx, {}))
    expect(runs.length).toBe(SCALE.settlementPeriods)

    // **El test CUENTA las consultas**, no sólo los ms: el techo de §9 dice
    // «3 consultas, sea cual sea N», y es lo que cierra la deuda §0-bis #6.
    const log: string[] = []
    const { value, ms } = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) => allocationRunStalenessBatch(counted(tx, log), runs))
    )
    expect(value.size).toBe(SCALE.settlementPeriods)
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(250)
    // TRES consultas como MUCHO, sean 17 runs o 170: los sellos del periodo,
    // las reglas vigentes y —sólo si algún run tiene ventana de horas— el
    // `timeHash` por ventana. Es la deuda §0-bis #6, y lo que se mide es que el
    // número NO dependa de N.
    expect(log.length, log.join("\n")).toBeLessThanOrEqual(3)
    expect(log.length).toBeGreaterThanOrEqual(2)

    // La liquidación anual con `HOURS` sobre los 120 000 partes: el agregado de
    // horas es el margen que §9 concede sobre los < 400 ms de E5.
    const liquidacion = await watcher.measure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        minutesByTargetMonthSql(tx, { from: FY_START, to: FY_END }, { productiveOnly: true, approvedOnly: true })
      )
    )
    expect(liquidacion.ms, `${Math.round(liquidacion.ms)} ms`).toBeLessThan(500)
  }, 600_000)

  /**
   * Cliente de tenant que APUNTA cada consulta (mismo espejo que
   * `e10-staleness.test.ts`): el techo de §9 cuenta consultas, no sólo ms.
   */
  function counted<T extends object>(tx: T, log: string[]): T {
    return new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
          return (...args: unknown[]) => {
            log.push(`${String(prop)}: ${String(args[0]).replace(/\s+/g, " ").trim().slice(0, 90)}`)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        if (prop === "allocationRule" && value !== null && typeof value === "object") {
          return new Proxy(value as object, {
            get(model, method, r2) {
              const fn = Reflect.get(model, method, r2)
              if (typeof fn !== "function") return fn
              return (...args: unknown[]) => {
                log.push(`allocationRule.${String(method)}`)
                return (fn as (...a: unknown[]) => unknown).apply(model, args)
              }
            },
          })
        }
        return value
      },
    }) as T
  }
})
