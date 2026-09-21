/**
 * E10 · T14 — Las server actions del presupuesto, las horas y los empleados
 * contra Postgres de verdad.
 *
 * Lo que aquí se ejerce **no se puede ejercer en un test puro**:
 *
 *  · **La matriz de roles de §4.2.** Un `VIEWER` no teclea una celda, un
 *    `EDITOR` no sella una versión ni fija una tarifa, y el rechazo llega como
 *    `Sin permiso` —no como una excepción de servidor sin mensaje—.
 *  · **El tenant**: nada de la organización B se ve desde la A.
 *  · **La idempotencia es del ÍNDICE, no de un `if`**: reimportar el mismo CSV
 *    de partes inserta **0 filas** y el informe dice por qué.
 *  · **El presupuesto del fixture sellado, entero**: `2026-BASE` + `2026-REV1`
 *    parcial desde julio, sellados, y el informe de desviación con las tres
 *    cifras de cabecera de `presupuesto-horas-esperado.v1.4.json` —INGRESOS −76 400,
 *    MC3 +63 350, EBITDA +228 797—. Es el criterio de aceptación del lote: si el
 *    borde compone mal, aquí se ve.
 *  · **`BUDGET_NOT_SEALED`** contra un borrador, y la previsualización del mismo
 *    borrador **sin fila en `report_runs`** (O-E10-5).
 *  · **R-H-4 y el `timeHash`**: un `EDITOR` no aprueba sus propios partes, un
 *    `ADMIN` sí, y aprobar un parte **tardío** de la ventana de un run sellado lo
 *    deja `STALE` por la cuarta causa (ADR-0018 D1).
 *  · **B-9**: un mes bloqueado no admite partes nuevos ni aprobaciones.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e10ac000-0000-4000-8000-000000000001"
const ORG_B = "e10ac000-0000-4000-8000-000000000002"
const ADMIN = "e10ac000-0000-4000-8000-0000000000a1"
const EDITOR = "e10ac000-0000-4000-8000-0000000000e1"
const VIEWER = "e10ac000-0000-4000-8000-0000000000b1"
const ADMIN_B = "e10ac000-0000-4000-8000-0000000000a2"

type TestUser = { id: string; email: string; name: string }
const users: Record<string, TestUser> = {
  [ADMIN]: { id: ADMIN, email: "e10-admin@test.local", name: "Admin" },
  [EDITOR]: { id: EDITOR, email: "e10-editor@test.local", name: "Editor" },
  [VIEWER]: { id: VIEWER, email: "e10-viewer@test.local", name: "Viewer" },
  [ADMIN_B]: { id: ADMIN_B, email: "e10-admin-b@test.local", name: "Admin B" },
}
let currentUser: TestUser = users[ADMIN]
const as = (id: string): void => {
  currentUser = users[id]
}

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { getAnalyticsConfig } = await import("@/models/analytics")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod } = await import("@/models/period-locks")

const {
  budgetDiffAction,
  createBudgetVersionAction,
  getBudgetAction,
  importBudgetCsvAction,
  listBudgetsAction,
  sealBudgetAction,
  upsertBudgetCellsAction,
  upsertBudgetHoursAction,
} = await import("@/app/(app)/analytics/budget/actions")
const { budgetVsActualAction, previewBudgetVsActualAction, budgetCellDetailAction } = await import(
  "@/app/(app)/analytics/budget-vs-actual/actions"
)
const {
  approveTimeEntriesAction,
  correctTimeEntryAction,
  createTimeEntriesAction,
  importTimeCsvAction,
  listTimeEntriesAction,
  timeCalendarAction,
} = await import("@/app/(app)/time/actions")
const {
  createEmployeeAction,
  createEmployeeRateAction,
  deriveHeadcountAction,
  listEmployeesAction,
  proposeHourlyCostAction,
  upsertHeadcountSnapshotAction,
} = await import("@/app/(app)/settings/employees/actions")
const { createAllocationRuleAction, listAllocationRunsAction, previewAllocationAction, sealAllocationRunAction } =
  await import("@/app/(app)/analytics/allocations/actions")

// ── El fixture sellado de T10 ────────────────────────────────────────────────

type ExpectedLine = {
  month: string
  accountCode: string | null
  analyticType: string
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionCode: string
  amountCents: number
  signException: boolean
}
type ExpectedHours = { month: string; dimensionKind: string; dimensionCode: string; minutes: number }
const expected = JSON.parse(
  readFileSync(path.join(process.cwd(), "docs", "design", "fixtures", "presupuesto-horas-esperado.v1.4.json"), "utf8")
) as {
  budgetLines: Record<string, ExpectedLine[]>
  budgetHoursLines: ExpectedHours[]
  variance: { withAllocationsFalse: { levelTotalsCents: Record<string, number> } }
  budgetLevelTotalsCents: Record<string, number>
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · T14 — server actions de presupuesto, horas y empleados", () => {
  let fiscalYearId = ""
  let projectByCode: Record<string, string> = {}
  let cecoByCode: Record<string, string> = {}
  let employeeId = ""
  let selfEmployeeId = ""
  let baseId = ""
  let revId = ""
  let revLabel = ""
  let draftId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({ data: Object.values(users).map((u) => ({ ...u, updatedAt: new Date() })), skipDuplicates: true })

    await prisma.organization.create({
      data: { id: ORG, slug: "e10-acciones", name: "E10 acciones SL", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.organization.create({
      data: { id: ORG_B, slug: "e10-acciones-b", name: "E10 otra SL", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    for (const [userId, role] of [
      [ADMIN, "ADMIN"],
      [EDITOR, "EDITOR"],
      [VIEWER, "VIEWER"],
    ] as const) {
      await prisma.membership.create({ data: { organizationId: ORG, userId, role, updatedAt: new Date() } })
    }
    await prisma.membership.create({
      data: { organizationId: ORG_B, userId: ADMIN_B, role: "ADMIN", updatedAt: new Date() },
    })

    // El ejercicio 2026 completo: es el real contra el que mide el fixture de
    // presupuesto (su `source.fixture`).
    const report = await loadFixtureIntoOrg({ organizationId: ORG, fixture: "ejercicio-completo", userId: ADMIN })
    expect(report.mismatches).toEqual([])

    // La otra organización, mínima: sólo hace falta para el test de tenant.
    await importNpgc(ORG_B, "PYMES", { actor: { userId: ADMIN_B }, now: new Date("2026-01-01"), useSubaccounts: false })
    const fyB = await openFiscalYear(ORG_B, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, { userId: ADMIN_B })
    if (!fyB.ok) throw new Error(JSON.stringify(fyB.errors))

    const ctx = await tenantTransaction(ORG, ADMIN, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      const fy = await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" }, select: { id: true } })
      return { config, fiscalYearId: fy.id }
    })
    fiscalYearId = ctx.fiscalYearId
    projectByCode = Object.fromEntries(ctx.config.projects.map((p) => [p.code, p.id]))
    cecoByCode = Object.fromEntries(ctx.config.costCenters.map((c) => [c.code, c.id]))

    // El módulo de horas encendido: sin él, ADR-0013 D4 rechaza una regla HORAS.
    await prisma.organization.update({ where: { id: ORG }, data: { timeTrackingEnabled: true } })

    as(EDITOR)
    const e1 = await createEmployeeAction({
      code: "E-001",
      name: "A. García",
      defaultCostCenterId: cecoByCode["CC-GA"],
      fteMilli: 1000,
      hireDate: "2026-01-01",
    })
    expect(e1.error ?? null).toBeNull()
    employeeId = e1.data!.id
    const e2 = await createEmployeeAction({
      code: "E-002",
      name: "B. López (el propio editor)",
      userId: EDITOR,
      defaultCostCenterId: cecoByCode["CC-GA"],
      fteMilli: 1000,
      hireDate: "2026-01-01",
    })
    expect(e2.error ?? null).toBeNull()
    selfEmployeeId = e2.data!.id
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    const { Client } = await import("pg")
    const client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query("BEGIN")
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
      ]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1)`, [[ORG, ORG_B]])
      }
      for (const table of ["time_entries", "budgets", "budget_lines", "budget_hours_lines"]) {
        await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`)
      }
      await client.query("COMMIT")
    } finally {
      await client.query("ROLLBACK").catch(() => undefined)
      await client.end()
    }
    const { resetOrganizationLedger } = await import("@/scripts/load-fixture")
    for (const org of [ORG, ORG_B]) {
      await resetOrganizationLedger(org).catch(() => undefined)
    }
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: Object.keys(users) } } })
  }

  /** Un CECO fuente que no sea `CC-GA`: ése ya reparte el 100 % con la regla HORAS. */
  const headcountSource = (): string => {
    const code = Object.keys(cecoByCode).find((c) => c !== "CC-GA")
    if (!code) throw new Error("el fixture no trae un segundo centro de coste")
    return cecoByCode[code]
  }

  const dimensionOf = (line: { dimensionKind: string; dimensionCode: string }) =>
    line.dimensionKind === "PROJECT"
      ? { projectId: projectByCode[line.dimensionCode], costCenterId: null }
      : { projectId: null, costCenterId: cecoByCode[line.dimensionCode] }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Matriz de roles (§4.2)
  // ───────────────────────────────────────────────────────────────────────────

  it("§4.2 · un VIEWER lee el presupuesto pero no teclea una celda ni crea una versión", async () => {
    as(VIEWER)
    const listed = await listBudgetsAction({ fiscalYearId })
    expect(listed.success).toBe(true)

    const created = await createBudgetVersionAction({
      fiscalYearId,
      scenario: "BASE",
      name: "intento de VIEWER",
      validFrom: "2026-01-01",
    })
    expect(created).toEqual({ success: false, error: "Sin permiso" })

    const typed = await upsertBudgetCellsAction({
      budgetId: "00000000-0000-4000-8000-000000000000",
      cells: [
        {
          month: "2026-01-01",
          accountCode: "705",
          projectId: projectByCode["P-01"],
          analyticType: "INGRESO_DIRECTO",
          amountCents: 1000,
        },
      ],
    })
    expect(typed).toEqual({ success: false, error: "Sin permiso" })
  })

  it("§4.2 · un EDITOR teclea el borrador pero NO sella: sellar es política, no operación", async () => {
    as(ADMIN)
    const created = await createBudgetVersionAction({
      fiscalYearId,
      scenario: "REVISADO",
      name: "borrador de roles",
      validFrom: "2026-12-01",
    })
    expect(created.error ?? null).toBeNull()
    draftId = created.data!.id

    as(EDITOR)
    const typed = await upsertBudgetCellsAction({
      budgetId: draftId,
      cells: [
        {
          month: "2026-03-01",
          accountCode: "705",
          projectId: projectByCode["P-01"],
          analyticType: "INGRESO_DIRECTO",
          amountCents: 500_000,
        },
      ],
    })
    expect(typed.data?.written).toBe(1)

    const sealed = await sealBudgetAction({ budgetId: draftId })
    expect(sealed).toEqual({ success: false, error: "Sin permiso" })
  })

  it("§4.2 · la tarifa es de ADMIN: el coste-hora mueve el margen de todos los proyectos", async () => {
    as(EDITOR)
    const rejected = await createEmployeeRateAction({
      employeeId,
      hourlyCostCents: 2500,
      basis: "COSTE_EMPRESA_CON_SS",
      validFrom: "2026-01-01",
    })
    expect(rejected).toEqual({ success: false, error: "Sin permiso" })

    // La PROPUESTA sí la pide un EDITOR: es información, no política.
    const proposal = await proposeHourlyCostAction({
      scope: "COST_CENTER",
      costCenterId: cecoByCode["CC-GA"],
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    })
    expect(proposal.success).toBe(true)

    as(ADMIN)
    const accepted = await createEmployeeRateAction({
      employeeId,
      hourlyCostCents: 2500,
      basis: "COSTE_EMPRESA_CON_SS",
      validFrom: "2026-01-01",
    })
    expect(accepted.error ?? null).toBeNull()

    // §10 — la tarifa individual sólo la ve un ADMIN.
    as(VIEWER)
    const seenByViewer = await listEmployeesAction({ rateAt: "2026-06-30" })
    const rowForViewer = seenByViewer.data!.find((e) => e.id === employeeId)
    expect(rowForViewer?.currentRateCents).toBeNull()
    expect(rowForViewer?.rateHidden).toBe(true)

    as(ADMIN)
    const seenByAdmin = await listEmployeesAction({ rateAt: "2026-06-30" })
    expect(seenByAdmin.data!.find((e) => e.id === employeeId)?.currentRateCents).toBe(2500)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Tenant
  // ───────────────────────────────────────────────────────────────────────────

  it("tenant · el ADMIN de la otra organización no ve ni una versión de presupuesto de ésta", async () => {
    as(ADMIN_B)
    const listed = await listBudgetsAction({})
    expect(listed.success).toBe(true)
    expect(listed.data!.map((b) => b.id)).not.toContain(draftId)

    const read = await getBudgetAction({ budgetId: draftId })
    expect(read).toEqual({ success: false, error: "La versión de presupuesto no existe en esta organización" })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Signo, import invertido y dry-run
  // ───────────────────────────────────────────────────────────────────────────

  it("O-E10-6 · un gasto tecleado en POSITIVO se rechaza diciendo que va en negativo", async () => {
    as(EDITOR)
    const typed = await upsertBudgetCellsAction({
      budgetId: draftId,
      cells: [
        {
          month: "2026-03-01",
          accountCode: "6400",
          projectId: projectByCode["P-01"],
          analyticType: "COSTE_DIRECTO_MC2",
          amountCents: 1_200_000,
        },
      ],
    })
    expect(typed.success).toBe(false)
    expect(typed.error).toMatch(/negativo/i)
  })

  it("R-B-6 · con la convención invertida se rechaza el FICHERO ENTERO y no entra una sola fila", async () => {
    as(EDITOR)
    const rows = [
      "mes;cuenta;tipo_analitico;proyecto;centro_coste;importe_centimos",
      "2026-04-01;621;INDIRECTO_CECO;;CC-GA;124800",
      "2026-04-01;640;INDIRECTO_CECO;;CC-GA;78000",
      "2026-04-01;629;INDIRECTO_CECO;;CC-GA;15000",
    ].join("\n")
    const imported = await importBudgetCsvAction({ budgetId: draftId, csv: rows })
    expect(imported.data?.fileRejected).toBe(true)
    expect(imported.data?.inserted).toBe(0)
    expect(imported.data?.reasons[0].reason).toMatch(/convención de signo del fichero está invertida/)

    const version = await getBudgetAction({ budgetId: draftId })
    // Sólo sigue la celda del test de roles: el fichero no ha dejado nada.
    expect(version.data!.cells.length).toBe(1)
  })

  it("import CSV con `dry-run` · valida, informa y NO escribe", async () => {
    as(EDITOR)
    const csv = [
      "mes;cuenta;tipo_analitico;proyecto;centro_coste;importe_centimos",
      "2026-05-01;621;INDIRECTO_CECO;;CC-GA;-124800",
      "2026-05-01;705;INGRESO_DIRECTO;P-99;;500000",
      "2026-13-01;705;INGRESO_DIRECTO;P-01;;500000",
    ].join("\n")
    const dry = await importBudgetCsvAction({ budgetId: draftId, csv, dryRun: true })
    expect(dry.data?.dryRun).toBe(true)
    expect(dry.data?.inserted).toBe(0)
    expect(dry.data?.parsed).toBe(1)
    expect(dry.data?.reasons.map((r) => r.reason).join(" · ")).toMatch(/P-99.*no existe/)

    const version = await getBudgetAction({ budgetId: draftId })
    expect(version.data!.cells.length).toBe(1)

    // Y sin `dry-run`, la única fila válida entra.
    const wet = await importBudgetCsvAction({ budgetId: draftId, csv })
    expect(wet.data?.inserted).toBe(1)
    expect(wet.data?.dryRun).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. El presupuesto del fixture, sellado, y el informe de desviación
  // ───────────────────────────────────────────────────────────────────────────

  it(
    "criterio del lote · BASE + REV1 del fixture → sellar → desviación INGRESOS −76.400 / MC3 +63.350 / EBITDA +228.797",
    async () => {
      as(ADMIN)
      const base = await createBudgetVersionAction({
        fiscalYearId,
        scenario: "BASE",
        name: "Presupuesto 2026",
        validFrom: "2026-01-01",
      })
      expect(base.error ?? null).toBeNull()
      baseId = base.data!.id

      as(EDITOR)
      const baseCells = expected.budgetLines["2026-BASE"].map((l) => ({
        month: l.month,
        accountCode: l.accountCode,
        ...dimensionOf(l),
        analyticType: l.analyticType,
        amountCents: l.amountCents,
        signException: l.signException,
      }))
      const typed = await upsertBudgetCellsAction({ budgetId: baseId, cells: baseCells })
      expect(typed.error ?? null).toBeNull()
      expect(typed.data?.written).toBe(80)

      const hours = await upsertBudgetHoursAction({
        budgetId: baseId,
        rows: expected.budgetHoursLines.map((h) => ({
          month: h.month,
          ...dimensionOf(h as { dimensionKind: string; dimensionCode: string }),
          minutes: h.minutes,
        })),
      })
      expect(hours.error ?? null).toBeNull()

      // Con la versión en BORRADOR, el informe se NIEGA a firmar, y la
      // previsualización del mismo borrador sí sale — sin `ReportRun`.
      as(VIEWER)
      const refused = await budgetVsActualAction({
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        granularity: "YEAR",
        budgetId: baseId,
      })
      expect(refused.success).toBe(false)
      expect(refused.error).toMatch(/borrador|BORRADOR/)
      expect(refused.error).toMatch(/previsualización/)

      const preview = await previewBudgetVsActualAction({
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        granularity: "YEAR",
        budgetId: baseId,
      })
      expect(preview.error ?? null).toBeNull()
      expect(preview.data?.runId).toBeNull()
      expect(preview.data?.sealed).toBe(false)
      expect(await reportRunCount()).toBe(0)

      as(ADMIN)
      const sealedBase = await sealBudgetAction({ budgetId: baseId, validFrom: "2026-01-01" })
      expect(sealedBase.error ?? null).toBeNull()
      expect(sealedBase.data?.budgetHash).toMatch(/^[0-9a-f]{64}$/)

      // La REVISADO parcial desde julio CIERRA la BASE el 30 de junio (O-E10-8).
      const rev = await createBudgetVersionAction({
        fiscalYearId,
        scenario: "REVISADO",
        name: "Reproyección julio",
        validFrom: "2026-07-01",
        partialFrom: "2026-07-01",
      })
      expect(rev.error ?? null).toBeNull()
      revId = rev.data!.id
      revLabel = rev.data!.label

      as(EDITOR)
      const revTyped = await upsertBudgetCellsAction({
        budgetId: revId,
        cells: expected.budgetLines["2026-REV1"].map((l) => ({
          month: l.month,
          accountCode: l.accountCode,
          ...dimensionOf(l),
          analyticType: l.analyticType,
          amountCents: l.amountCents,
          signException: l.signException,
        })),
      })
      expect(revTyped.data?.written).toBe(36)

      as(ADMIN)
      const sealedRev = await sealBudgetAction({ budgetId: revId, validFrom: "2026-07-01" })
      expect(sealedRev.error ?? null).toBeNull()
      expect(sealedRev.data?.closedPreviousId).toBe(baseId)
      expect(sealedRev.data?.closedPreviousTo).toBe("2026-06-30")

      // El informe, sobre la versión EFECTIVA compuesta (O-E10-9).
      as(VIEWER)
      const view = await budgetVsActualAction({
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        granularity: "YEAR",
      })
      expect(view.error ?? null).toBeNull()
      const result = view.data!.result
      expect(result.budgetComposition["2026-01"]).toBe("2026-BASE")
      expect(result.budgetComposition["2026-12"]).toBe(revLabel)

      const levelTotal = (level: string): number =>
        result.variance
          .filter((c) => c.level === level && c.month === null && c.varianceCents !== null)
          .reduce((a, c) => a + (c.varianceCents ?? 0), 0)

      expect(levelTotal("INGRESOS")).toBe(expected.variance.withAllocationsFalse.levelTotalsCents.INGRESOS)
      expect(levelTotal("INGRESOS")).toBe(-76_400)
      expect(levelTotal("MC3")).toBe(63_350)
      expect(levelTotal("EBITDA")).toBe(228_797)

      // El informe SÍ deja fila, y la segunda llamada la sirve de la caché.
      expect(view.data?.runId).not.toBeNull()
      expect(await reportRunCount()).toBe(1)
      const again = await budgetVsActualAction({
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        granularity: "YEAR",
      })
      expect(again.data?.runId).toBe(view.data?.runId)
      expect(await reportRunCount()).toBe(1)
    },
    600_000
  )

  it("drill-down · la tercera consulta de la procedencia son las líneas de presupuesto de la celda", async () => {
    as(VIEWER)
    const detail = await budgetCellDetailAction({
      budgetId: baseId,
      level: "INGRESOS",
      column: `PROJ:P-01`,
      month: "2026-01-01",
    })
    expect(detail.error ?? null).toBeNull()
    expect(detail.data!.rows.length).toBeGreaterThan(0)
    expect(detail.data!.rows.every((r) => r.dimensionCode === "P-01" && r.month === "2026-01-01")).toBe(true)
    expect(detail.data!.totalCents).toBe(detail.data!.rows.reduce((a, r) => a + r.amountCents, 0))
  })

  it("diff · el Δ entre BASE y REV1 sale celda a celda y suma lo que cambió", async () => {
    as(VIEWER)
    const diff = await budgetDiffAction({ budgetId: revId, againstBudgetId: baseId })
    expect(diff.error ?? null).toBeNull()
    expect(diff.data!.rows.length).toBeGreaterThan(0)
    expect(diff.data!.from.label).toBe("2026-BASE")
    expect(diff.data!.to.label).toBe(revLabel)
    expect(diff.data!.totalDeltaCents).toBe(diff.data!.rows.reduce((a, r) => a + r.deltaCents, 0))
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Horas: R-H-4, idempotencia, contra-apunte y `timeHash`
  // ───────────────────────────────────────────────────────────────────────────

  it("R-H-4 · un EDITOR no aprueba sus propios partes; un ADMIN sí", async () => {
    as(EDITOR)
    const mine = await createTimeEntriesAction({
      rows: [{ employeeId: selfEmployeeId, date: "2026-02-10", projectId: projectByCode["P-01"], minutes: 480 }],
    })
    expect(mine.error ?? null).toBeNull()
    const mineId = mine.data!.ids[0]

    const selfApproval = await approveTimeEntriesAction({ ids: [mineId] })
    expect(selfApproval.success).toBe(false)
    expect(selfApproval.error).toMatch(/otra persona|ADMIN|aprueb/i)

    as(ADMIN)
    const byAdmin = await approveTimeEntriesAction({ ids: [mineId] })
    expect(byAdmin.error ?? null).toBeNull()
    expect(byAdmin.data?.approved).toBe(1)

    // Y una vez aprobado, sólo se corrige por CONTRA-APUNTE con motivo.
    as(EDITOR)
    const short = await correctTimeEntryAction({ entryId: mineId, minutes: -60, reason: "corto" })
    expect(short.success).toBe(false)
    const corrected = await correctTimeEntryAction({
      entryId: mineId,
      minutes: -60,
      reason: "el parte del 10 de febrero incluía una hora de formación interna",
    })
    expect(corrected.error ?? null).toBeNull()
  })

  it("import CSV de partes · idempotente por fichero y línea: la segunda vez entran 0", async () => {
    as(EDITOR)
    const csv = [
      "empleado;fecha;proyecto;centro_coste;minutos;productivo",
      "E-001;2026-03-02;P-01;;480;1",
      "E-001;2026-03-03;P-02;;420;1",
      "E-999;2026-03-04;P-01;;480;1",
    ].join("\n")
    const first = await importTimeCsvAction({ csv })
    expect(first.data?.inserted).toBe(2)
    expect(first.data?.reasons.some((r) => /E-999/.test(r.reason))).toBe(true)

    const second = await importTimeCsvAction({ csv })
    expect(second.data?.inserted).toBe(0)
    expect(second.data?.skipped).toBeGreaterThanOrEqual(2)
    expect(second.data?.reasons.some((r) => /ya importada/.test(r.reason))).toBe(true)
  })

  it("§10 · un VIEWER ve el agregado y la banda de pendientes, no los nombres ajenos", async () => {
    as(VIEWER)
    const listed = await listTimeEntriesAction({ from: "2026-01-01", to: "2026-12-31" })
    expect(listed.error ?? null).toBeNull()
    expect(listed.data?.redacted).toBe(true)
    expect(listed.data!.entries.some((e) => e.employeeName === "A. García")).toBe(false)
    expect(listed.data!.aggregate.length).toBeGreaterThan(0)
    expect(listed.data!.unapprovedShareBps).not.toBeNull()

    as(EDITOR)
    const nominal = await listTimeEntriesAction({ from: "2026-01-01", to: "2026-12-31" })
    expect(nominal.data?.redacted).toBe(false)
    expect(nominal.data!.entries.some((e) => e.employeeName === "A. García")).toBe(true)
  })

  it("O-E10-21 · el techo diario es AGREGADO: dos partes legales uno a uno y absurdos juntos se rechazan", async () => {
    as(EDITOR)
    const ok = await createTimeEntriesAction({
      rows: [
        { employeeId, date: "2026-04-06", projectId: projectByCode["P-01"], minutes: 800 },
        { employeeId, date: "2026-04-06", projectId: projectByCode["P-02"], minutes: 600 },
      ],
    })
    expect(ok.error ?? null).toBeNull()

    // 800 + 600 + 300 = 1 700 minutos el mismo día: cada parte es legal por sí
    // solo y el conjunto no lo es. El CHECK por fila no lo veía.
    const over = await createTimeEntriesAction({
      rows: [{ employeeId, date: "2026-04-06", projectId: projectByCode["P-01"], minutes: 300 }],
    })
    expect(over.success).toBe(false)
    expect(over.error).toMatch(/1 440|techo diario/)

    const calendar = await timeCalendarAction({ month: "2026-04" })
    expect(calendar.error ?? null).toBeNull()
    const day = calendar.data!.cells.find((c) => c.date === "2026-04-06")
    expect(day?.minutes).toBe(1400)
    expect(day?.targets.length).toBe(2)
    expect(calendar.data!.overCeiling).toEqual([])
  })

  it(
    "ADR-0018 D1 · regla HORAS con `timeHash`, y aprobar un parte TARDÍO deja el run STALE",
    async () => {
      as(EDITOR)
      const rows = [1, 2, 3].map((d) => ({
        employeeId,
        date: `2026-05-0${d}`,
        projectId: projectByCode[d === 3 ? "P-02" : "P-01"],
        minutes: 480,
      }))
      const created = await createTimeEntriesAction({ rows })
      expect(created.error ?? null).toBeNull()
      as(ADMIN)
      const approved = await approveTimeEntriesAction({ ids: created.data!.ids })
      expect(approved.data?.approved).toBe(3)

      const rule = await createAllocationRuleAction({
        code: "R-HORAS-05",
        name: "Estructura por horas",
        sourceCostCenterId: cecoByCode["CC-GA"],
        targetKind: "PROJECTS",
        driver: "HOURS",
        period: "MONTH",
        priority: 10,
        sourceShareBps: 10000,
        validFrom: "2026-05-01",
        targets: [],
      })
      expect(rule.error ?? null).toBeNull()

      as(VIEWER)
      const preview = await previewAllocationAction({ periodKind: "MONTH", periodStart: "2026-05-01", periodEnd: "2026-05-31" })
      expect(preview.error ?? null).toBeNull()
      // El cuarto sello, con su VENTANA.
      expect(preview.data!.result.timeSeal.timeHash).toHaveLength(64)
      expect(preview.data!.result.timeSeal.timeHashWindowStart).not.toBeNull()

      as(EDITOR)
      const sealed = await sealAllocationRunAction({
        periodKind: "MONTH",
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
        expectedHashes: preview.data!.seals,
      })
      expect(sealed.error ?? null).toBeNull()

      const runsBefore = await listAllocationRunsAction({ periodKind: "MONTH" })
      const mayBefore = runsBefore.data!.find((r) => r.periodStart === "2026-05-01" && r.status === "SEALED")
      // Recién sellado, el run está VIGENTE y ninguna de las cuatro causas
      // aparece —el espejo SQL de `marginConfigHash` reproduce ya
      // `canonicalMarginConfigForm` (lote C4, hallazgo de C1)—, y en particular
      // no la CUARTA, la de los partes de horas.
      expect(mayBefore?.staleReasons ?? []).toEqual([])
      expect(mayBefore?.isStale).toBe(false)

      // Un parte TARDÍO de la misma ventana, aprobado después de sellar: el
      // `timeHash` cambia y el run queda STALE (cuarta causa de ADR-0018 D1).
      const late = await createTimeEntriesAction({
        rows: [{ employeeId, date: "2026-05-20", projectId: projectByCode["P-02"], minutes: 300 }],
      })
      expect(late.error ?? null).toBeNull()
      as(ADMIN)
      const lateApproved = await approveTimeEntriesAction({ ids: late.data!.ids })
      expect(lateApproved.data?.approved).toBe(1)

      const runsAfter = await listAllocationRunsAction({ periodKind: "MONTH" })
      const mayAfter = runsAfter.data!.find((r) => r.periodStart === "2026-05-01" && r.status === "SEALED")
      expect(mayAfter?.isStale).toBe(true)
      expect((mayAfter?.staleReasons ?? []).join(" ")).toMatch(/hora|timeHash|parte/i)
      // Y el motivo NUEVO es exactamente el que antes no estaba.
      expect((mayAfter?.staleReasons ?? []).length).toBeGreaterThan((mayBefore?.staleReasons ?? []).length)
    },
    600_000
  )

  it("ADR-0013 D4 · una regla PLANTILLA sin snapshots no nace: dice qué falta y dónde darlo de alta", async () => {
    as(ADMIN)
    const inert = await createAllocationRuleAction({
      code: "R-PLANTILLA-X",
      name: "Estructura por plantilla",
      sourceCostCenterId: headcountSource(),
      targetKind: "COST_CENTERS",
      driver: "HEADCOUNT",
      period: "MONTH",
      // La cascada: quien ALIMENTA a CC-GA va antes que la regla de CC-GA.
      priority: 5,
      sourceShareBps: 10000,
      validFrom: "2026-06-01",
      targets: [{ costCenterId: cecoByCode["CC-GA"], percentBps: 10000 }],
    })
    expect(inert.success).toBe(false)
    expect(inert.error).toMatch(/snapshots de plantilla|Plantilla/)

    // Con la plantilla registrada, la misma regla sí nace.
    as(EDITOR)
    const snapshot = await upsertHeadcountSnapshotAction({
      costCenterId: cecoByCode["CC-GA"],
      periodEnd: "2026-06-30",
      fteMilli: 3000,
      headcount: 3,
    })
    expect(snapshot.error ?? null).toBeNull()
    const badDay = await upsertHeadcountSnapshotAction({
      costCenterId: cecoByCode["CC-GA"],
      periodEnd: "2026-06-15",
      fteMilli: 3000,
      headcount: 3,
    })
    expect(badDay.success).toBe(false)
    expect(badDay.error).toMatch(/FIN de mes/)

    const derived = await deriveHeadcountAction({ periodEnd: "2026-07-31" })
    expect(derived.error ?? null).toBeNull()
    expect(derived.data!.written).toBeGreaterThan(0)

    as(ADMIN)
    const born = await createAllocationRuleAction({
      code: "R-PLANTILLA-X",
      name: "Estructura por plantilla",
      sourceCostCenterId: headcountSource(),
      targetKind: "COST_CENTERS",
      driver: "HEADCOUNT",
      period: "MONTH",
      // La cascada: quien ALIMENTA a CC-GA va antes que la regla de CC-GA.
      priority: 5,
      sourceShareBps: 10000,
      validFrom: "2026-06-01",
      targets: [{ costCenterId: cecoByCode["CC-GA"], percentBps: 10000 }],
    })
    expect(born.error ?? null).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. B-9 — el mes bloqueado
  // ───────────────────────────────────────────────────────────────────────────

  it("B-9 · un mes bloqueado no admite partes nuevos: sus horas ya alimentaron un informe rendido", async () => {
    as(ADMIN)
    // El bloqueo es SECUENCIAL (B-2): para cerrar septiembre hay que cerrar
    // antes enero…agosto.
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const locked = await lockPeriod(ORG, { fiscalYearId, month, reason: `cierre del mes ${month} rendido` }, { userId: ADMIN })
      expect(locked.ok, JSON.stringify(locked)).toBe(true)
    }

    as(EDITOR)
    const rejected = await createTimeEntriesAction({
      rows: [{ employeeId, date: "2026-09-10", projectId: projectByCode["P-01"], minutes: 480 }],
    })
    expect(rejected.success).toBe(false)
    expect(rejected.error).toMatch(/bloquead|desbloquear/i)
  })

  async function reportRunCount(): Promise<number> {
    return await prisma.reportRun.count({ where: { organizationId: ORG, type: "PRESUPUESTO_REAL" } })
  }
})
