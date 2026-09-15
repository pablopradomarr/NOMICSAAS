import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · ronda de integración — los cuatro defectos que los agentes de interfaz
 * (C2 y C3) dejaron nombrados y que sólo se demuestran con la base delante.
 *
 *  1. **BLOQUEANTE** — `previewAllocationRun` / `sealAllocationRunTx` llamaban a
 *     `allocate()` **sin** `timeEntries` ni `headcount` aunque `loadRunContext`
 *     ya cargaba `ctx.activity`: `HORAS` y `PLANTILLA` caían SIEMPRE en su
 *     `zeroBaseFallback` y emitían `W-E10-NO-HOURS` en vez de repartir.
 *  2. `models/reports.budgetVsActual` construía la desviación **antes** que el
 *     forecast y sin pasárselo: la quinta columna existía y estaba siempre
 *     vacía. Y la vista no exponía los cinco sellos de la cabecera ni el mes
 *     real con granularidad `MONTH`.
 *  3. `getAnalyticsConfig` resolvía la organización con un `$queryRaw` que se
 *     sale de la transacción de tenant cuando se le pasa el `db` de
 *     `tenantPage()` (hallazgo menor de C3).
 *  4. Vaciar una celda del editor la guardaba como `0,00 €` porque
 *     `getBudgetVersion` no devolvía el id de la línea y el editor no tenía qué
 *     borrar: **celda vacía = sin línea**.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { getAnalyticsConfig, seedAnalyticsDefaults } = await import("@/models/analytics")
const { createAllocationRuleTx, previewAllocationRun, sealAllocationRunTx } = await import("@/models/allocations")
const { approveTimeEntriesTx, createTimeEntriesTx } = await import("@/models/time")
const { createEmployeeTx } = await import("@/models/employees")
const {
  createBudgetVersionTx,
  deleteBudgetCellsTx,
  getBudgetVersion,
  sealBudgetTx,
  upsertBudgetCellsTx,
} = await import("@/models/budget")
const { budgetVsActual } = await import("@/models/reports")
const { marginConfigHash } = await import("@/lib/analytics/hash")

const ORG = "eb000000-0000-4000-8000-00000000000a"
const USER = "eb000000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const REF = "2026-12-31"
const YEAR = { periodKind: "YEAR" as const, periodStart: "2026-01-01" as const, periodEnd: "2026-12-31" as const }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · ronda de integración (hallazgos de C2 y C3)", () => {
  const ceco: Record<string, string> = {}
  let projectA = ""
  let projectB = ""
  let fiscalYearId = ""
  let employeeId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e10-ronda@test.local", name: "E10 ronda" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e10-ronda", name: "E10 ronda", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() } })

    await importNpgc(ORG, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    fiscalYearId = fy.value.id

    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: USER })
    })
    await tenantTransaction(ORG, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      projectA = (
        await tx.project.create({
          data: { organizationId: ORG, code: "P-01", name: "Alfa", businessLineId: bl.id, sortOrder: 1 },
        })
      ).id
      projectB = (
        await tx.project.create({
          data: { organizationId: ORG, code: "P-02", name: "Beta", businessLineId: bl.id, sortOrder: 2 },
        })
      ).id
      for (const c of await tx.costCenter.findMany()) ceco[c.code] = c.id
      employeeId = (
        await createEmployeeTx(tx, { code: "E-001", name: "A. García", defaultCostCenterId: ceco["CC-GA"] }, actor)
      ).id
    })

    await post({ accountCode: "705", creditCents: 600_000, projectId: projectA })
    await post({ accountCode: "705", creditCents: 400_000, projectId: projectB })
    await post({ accountCode: "621", debitCents: 90_000, costCenterId: ceco["CC-GA"] })

    // La base de actividad del criterio 13: **720 minutos APROBADOS** en P-01 y
    // **300 SIN APROBAR** en P-02. Con la base pasada al motor hay líneas y hay
    // aviso; sin pasarla, `W-E10-NO-HOURS` y ni una línea.
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      createTimeEntriesTx(
        tx,
        [
          { employeeId, date: "2026-11-03", projectId: projectA, minutes: 720 },
          { employeeId, date: "2026-11-04", projectId: projectB, minutes: 300 },
        ],
        actor
      )
    )
    await tenantTransaction(ORG, USER, async (tx) =>
      approveTimeEntriesTx(tx, { ids: [created.ids[0]], approvedAt: new Date("2026-11-05"), actorIsAdmin: true }, actor)
    )
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      for (const table of ["time_entries", "budgets", "budget_lines", "budget_hours_lines"]) {
        await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`)
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
        await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`)
      }
      await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    })
  }

  async function post(line: {
    accountCode: string
    debitCents?: number
    creditCents?: number
    projectId?: string
    costCenterId?: string
  }): Promise<void> {
    const debit = line.debitCents ?? 0
    const credit = line.creditCents ?? 0
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: "2026-02-10",
          description: "Movimiento de la ronda E10",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "4300", debitCents: credit, creditCents: debit },
            {
              lineNo: 2,
              accountCode: line.accountCode,
              debitCents: debit,
              creditCents: credit,
              projectId: line.projectId ?? null,
              costCenterId: line.costCenterId ?? null,
            },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1 · BLOQUEANTE — la base de actividad llega al motor
  // ───────────────────────────────────────────────────────────────────────

  it("criterio 13 · con 720 min aprobados y 300 sin aprobar, `HORAS` reparte y avisa (no cae en el fallback)", async () => {
    await tenantTransaction(ORG, USER, async (tx) => {
      await createAllocationRuleTx(
        tx,
        {
          code: "AL-GA-H",
          name: "G&A a proyectos por horas",
          sourceCostCenterId: ceco["CC-GA"],
          targetKind: "PROJECTS",
          driver: "HOURS",
          period: "YEAR",
          priority: 20,
          sourceShareBps: 10000,
          zeroBaseFallback: "SKIP_WARN",
          targetFilter: { projectStatus: ["ACTIVE"] },
          validFrom: "2026-01-01",
          validTo: null,
          targets: [],
        } as never,
        actor
      )
    })

    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))
    const codes = preview.result.warnings.map((w) => w.code)

    // Lo que fallaba: sin `timeEntries` la base era 0 y el aviso era el del
    // hueco de datos. Con la base, el aviso es el del reparto PARCIAL (O-E10-2).
    expect(codes).not.toContain("W-E10-NO-HOURS")
    expect(codes).toContain("W-E10-UNAPPROVED-HOURS")
    const unapproved = preview.result.warnings.find((w) => w.code === "W-E10-UNAPPROVED-HOURS")
    expect(unapproved).toMatchObject({
      unapprovedMinutes: 300,
      // 300 / 720 sobre la base APROBADA, en puntos básicos ENTEROS.
      shareOfBaseBps: Math.floor((300 * 10000) / 720),
      sealReason: "HORAS_SIN_APROBAR",
    })

    // Y hay líneas: los 90 000 c de CC-GA van al único proyecto con horas
    // aprobadas, sin fallback aplicado.
    expect(preview.result.lines.length).toBeGreaterThan(0)
    const toA = preview.result.lines.filter((l) => l.target.code === "P-01")
    expect(toA.length).toBe(1)
    expect(toA[0].amountCents).toBe(90_000)
    expect(toA[0].fallbackApplied).toBeNull()
    expect(preview.result.totalAllocatedCents).toBe(90_000)

    // Con líneas se puede SELLAR, que es lo que el criterio 12-bis necesita
    // para tomar después el cuarto sello sobre la ventana de los partes.
    const run = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...YEAR, gitSha: "ronda-e10" }, actor)
    )
    expect(run.lineCount).toBe(preview.result.lines.length)
    // El CUARTO sello queda escrito CON su ventana (O-E10-1): es lo que hace
    // que aprobar después un parte de enero caduque el run de noviembre.
    const sealedRow = await prisma.allocationRun.findFirstOrThrow({ where: { id: run.id } })
    expect(sealedRow.timeHash).not.toBe("∅")
    expect(sealedRow.timeHashWindowStart?.toISOString().slice(0, 10)).toBe("2026-01-01")
    expect(sealedRow.timeHashWindowEnd?.toISOString().slice(0, 10)).toBe("2026-12-31")
  })

  // ───────────────────────────────────────────────────────────────────────
  // 2 · El informe: forecast por celda, cinco sellos y mes real
  // ───────────────────────────────────────────────────────────────────────

  describe("PRESUPUESTO_REAL", () => {
    let budgetId = ""

    beforeAll(async () => {
      budgetId = await tenantTransaction(ORG, USER, async (tx) => {
        const created = await createBudgetVersionTx(
          tx,
          { fiscalYearId, scenario: "BASE", name: "BASE", validFrom: "2026-01-01", partialFrom: null },
          actor
        )
        const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
        await upsertBudgetCellsTx(
          tx,
          {
            budgetId: created.id,
            config,
            cells: [
              {
                month: "2026-02-01",
                accountCode: "705",
                projectId: projectA,
                costCenterId: null,
                analyticType: "INGRESO_DIRECTO",
                amountCents: 500_000,
                signException: false,
                note: null,
              },
              {
                month: "2026-03-01",
                accountCode: "705",
                projectId: projectA,
                costCenterId: null,
                analyticType: "INGRESO_DIRECTO",
                amountCents: 400_000,
                signException: false,
                note: null,
              },
            ],
          },
          actor
        )
        await sealBudgetTx(
          tx,
          {
            budgetId: created.id,
            gitSha: "ronda-e10",
            marginConfigHash: marginConfigHash(config),
            sealedAt: new Date("2026-01-15T00:00:00Z"),
          },
          actor
        )
        return created.id
      })
      // Un mes cerrado: es lo que fija el corte del forecast (§3.4).
      await tenantTransaction(ORG, USER, async (tx) => {
        await tx.periodLock.create({
          data: { organizationId: ORG, fiscalYearId, month: 2, lockedById: USER },
        })
      })
    }, 120_000)

    it("la celda trae su columna de forecast, y el corte es el último mes cerrado", async () => {
      const view = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        budgetId,
        actor,
        noCache: true,
      })
      expect(view.forecastCutoff).toBe("2026-02")

      const cells = view.result.variance
      expect(cells.length).toBeGreaterThan(0)
      // Lo que fallaba: `buildVariance` se construía SIN forecast y las cinco
      // columnas por celda eran cuatro y un hueco.
      expect(cells.every((c) => c.forecastCents !== null || c.notComparable)).toBe(true)
      expect(cells.some((c) => c.forecastCents !== null && c.forecastCents !== 0)).toBe(true)

      // Y el forecast por celda es el mismo que el del bloque del ejercicio:
      // una sola `buildForecast`, no dos cifras que puedan divergir.
      const forecast = view.result.forecast as { levelTotalsCents: Record<string, number> }
      const ingresos = cells
        .filter((c) => c.level === "INGRESOS" && c.column.startsWith("PROJ:"))
        .reduce((acc, c) => acc + (c.forecastCents ?? 0), 0)
      expect(ingresos).toBe(forecast.levelTotalsCents.INGRESOS)
    })

    it("la vista expone los CINCO sellos de la cabecera, y son los de la fila emitida", async () => {
      const view = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        budgetId,
        actor,
      })
      expect(view.seals.ledgerHash).toMatch(/^[0-9a-f]{64}$/)
      expect(view.seals.analyticsKey.length).toBeGreaterThan(0)
      expect(view.seals.budgetHash).toBe(view.budgetHash)
      expect(view.seals.budgetRulesHash).toBe(view.budgetRulesHash)
      expect(view.seals.gitSha.length).toBeGreaterThan(0)

      const row = await prisma.reportRun.findFirstOrThrow({ where: { id: view.runId ?? "" } })
      expect(row.ledgerHash).toBe(view.seals.ledgerHash)
      expect(row.budgetHash).toBe(view.seals.budgetHash)
      expect(row.gitSha).toBe(view.seals.gitSha)

      // La caché devuelve los MISMOS cinco, no unos recalculados a ojo.
      const cached = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        budgetId,
        actor,
      })
      expect(cached.origen).toBe("cache")
      expect(cached.seals).toEqual(view.seals)
    })

    it("granularidad MONTH · la celda dice de qué mes es, no `null`", async () => {
      const month = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        budgetId,
        granularity: "MONTH",
        actor,
        noCache: true,
      })
      expect(month.result.variance.length).toBeGreaterThan(0)
      expect(month.result.variance.every((c) => c.month === "2026-03")).toBe(true)

      // El acumulado sigue diciendo `null`: «no es de un mes» es una afirmación
      // distinta de «es de marzo», y la provenance por celda las distingue.
      const ytd = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        budgetId,
        granularity: "YTD",
        actor,
        noCache: true,
      })
      expect(ytd.result.variance.every((c) => c.month === null)).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 3 · `getAnalyticsConfig` con el cliente de página
  // ───────────────────────────────────────────────────────────────────────

  it("`getAnalyticsConfig` resuelve la MISMA organización con el `db` de página que dentro de la transacción", async () => {
    const inTransaction = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
    )
    // El `db` que reparte `tenantPage()` es exactamente esto: un `TenantClient`,
    // no un cliente de transacción. Antes, el `$queryRaw` de la organización se
    // salía del tenant y la configuración no era la de esta organización.
    const withPageDb = await getAnalyticsConfig(tenantDb(ORG), { periodEnd: "2026-12-31" })

    expect(withPageDb.organizationId).toBe(ORG)
    expect(withPageDb.nonAnalyticLevel).toBe(inTransaction.nonAnalyticLevel)
    expect(withPageDb.analyticsRequired).toBe(inTransaction.analyticsRequired)
    expect(withPageDb.projects.map((p) => p.code).sort()).toEqual(inTransaction.projects.map((p) => p.code).sort())
    expect(withPageDb.levels.map((l) => l.level)).toEqual(inTransaction.levels.map((l) => l.level))
  })

  // ───────────────────────────────────────────────────────────────────────
  // 4 · Celda vaciada = línea retirada, nunca `0,00 €`
  // ───────────────────────────────────────────────────────────────────────

  it("`getBudgetVersion` devuelve el id de cada celda y `deleteBudgetCellsTx` la retira (no la pone a 0)", async () => {
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const created = await createBudgetVersionTx(
        tx,
        { fiscalYearId, scenario: "REVISADO", name: "REV-VACIAR", validFrom: "2026-06-01", partialFrom: "2026-06-01" },
        actor
      )
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      await upsertBudgetCellsTx(
        tx,
        {
          budgetId: created.id,
          config,
          cells: [
            {
              month: "2026-07-01",
              accountCode: "705",
              projectId: projectB,
              costCenterId: null,
              analyticType: "INGRESO_DIRECTO",
              amountCents: 250_000,
              signException: false,
              note: null,
            },
          ],
        },
        actor
      )
      return created.id
    })

    const before = await tenantTransaction(ORG, USER, async (tx) => getBudgetVersion(tx, draft))
    expect(before?.cells).toHaveLength(1)
    const cellId = before?.cells[0].id ?? ""
    // Sin el id, el editor no tenía qué borrar y vaciar la celda la guardaba
    // como un cero declarado — que es una decisión de presupuesto distinta.
    expect(cellId).toMatch(/^[0-9a-f-]{36}$/)

    const deleted = await tenantTransaction(ORG, USER, async (tx) =>
      deleteBudgetCellsTx(tx, { budgetId: draft, cellIds: [cellId] }, actor)
    )
    expect(deleted.deleted).toBe(1)

    const after = await tenantTransaction(ORG, USER, async (tx) => getBudgetVersion(tx, draft))
    // Ni una línea con `amountCents = 0`: la celda simplemente no existe.
    expect(after?.cells).toHaveLength(0)
  })
})
