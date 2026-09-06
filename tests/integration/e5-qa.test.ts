import { Client } from "pg"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * QA adversarial de E5 (liquidación de CECOs), agente `qa-tester`.
 *
 * Objetivo del protocolo: demostrar que el código NO cumple los criterios de
 * aceptación de `docs/design/E5-liquidacion.md` / `E5-validacion-liquidacion.md`.
 * No toca fixtures ni código de producto — sólo añade tests.
 *
 * Escenarios encargados: FIXED_PERCENT con Σ ≠ 10000, driver con base 0 y
 * fallback por defecto, cascada cíclica A→B→A por la vía de la aplicación,
 * doble liquidación del mismo periodo, doble reversión, VIEWER intentando
 * sellar/revertir, fuga de tenant en reglas, periodo bloqueado, Hamilton con
 * 1 céntimo y 3 receptores (empate → menor código), y run sobre periodo sin
 * movimientos.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

// ── Mocks de Next, sólo para la sección de autorización (VIEWER) ───────────
let currentUser: { id: string; email: string; name: string } | null = null
const cookieBag: Record<string, string> = {}
const cookieStore = {
  get: (name: string) => (cookieBag[name] ? { value: cookieBag[name] } : undefined),
  set: (name: string, value: string) => {
    cookieBag[name] = value
  },
  delete: (name: string) => {
    delete cookieBag[name]
  },
}
vi.mock("next/headers", () => ({ cookies: async () => cookieStore, headers: async () => new Headers() }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`)
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => {
    if (!currentUser) throw new Error("no currentUser set for this test")
    return currentUser
  },
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod } = await import("@/models/period-locks")
const { getLedgerContext, postEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const {
  createAllocationRuleTx,
  createAllocationRulesTx,
  listAllocationRules,
  listAllocationRuns,
  previewAllocationRun,
  reverseAllocationRunTx,
  sealAllocationRunTx,
} = await import("@/models/allocations")

const ORG = "e5900000-0000-4000-8000-00000000000a"
const ORG_OTHER = "e5900000-0000-4000-8000-00000000000b"
const USER = "e5900000-0000-4000-8000-0000000000a1"
const ALL_ORGS = [ORG, ORG_OTHER]
const actor = { userId: USER }
const REF = "2026-12-31"

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("QA adversarial E5 · liquidación de CECOs", () => {
  const ceco: Record<string, string> = {}
  const proj: Record<string, string> = {}
  let fiscalYearId = ""
  let foreignCeco = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e5-qa@test.local", name: "E5 QA" } })
    await prisma.organization.createMany({
      data: ALL_ORGS.map((id, index) => ({
        id,
        slug: `e5-qa-org-${index}`,
        name: `E5 QA Org ${index}`,
        pgcVariant: "PYMES" as const,
        updatedAt: new Date(),
      })),
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })

    for (const organizationId of ALL_ORGS) {
      await importNpgc(organizationId, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
      const fy = await openFiscalYear(
        organizationId,
        { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" },
        actor
      )
      if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
      if (organizationId === ORG) fiscalYearId = fy.value.id
      await tenantTransaction(organizationId, USER, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: USER })
      })
    }

    await tenantTransaction(ORG, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      for (const code of ["P-01", "P-02", "P-03"]) {
        proj[code] = (
          await tx.project.create({
            data: { organizationId: ORG, code, name: code, businessLineId: bl.id, sortOrder: 1 },
          })
        ).id
      }
      for (const c of await tx.costCenter.findMany()) ceco[c.code] = c.id
    })
    await tenantTransaction(ORG_OTHER, USER, async (tx) => {
      foreignCeco = (await tx.costCenter.findFirstOrThrow({ where: { code: "CC-GA" } })).id
    })
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  afterEach(() => {
    for (const k of Object.keys(cookieBag)) delete cookieBag[k]
    currentUser = null
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      for (const table of ["allocation_lines", "allocation_runs", "allocation_rule_targets", "allocation_rules"]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      }
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query("COMMIT")
      for (const table of [
        "report_runs",
        "period_locks",
        "fiscal_years",
        "audit_logs",
        "margin_level_configs",
        "cost_centers",
        "projects",
        "business_lines",
        "tax_rates",
        "organization_account_maps",
        "accounts",
      ]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      }
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    })
  }

  async function post(line: {
    accountCode: string
    debitCents?: number
    creditCents?: number
    projectId?: string
    costCenterId?: string
    entryDate?: string
  }): Promise<void> {
    const debit = line.debitCents ?? 0
    const credit = line.creditCents ?? 0
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: line.entryDate ?? "2026-02-10",
          description: "Movimiento QA E5",
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

  const ruleInput = (over: Record<string, unknown> = {}) => ({
    code: "AL-QA",
    name: "Regla QA",
    sourceCostCenterId: ceco["CC-MKT"],
    targetKind: "PROJECTS" as const,
    driver: "EQUAL" as const,
    period: "YEAR" as const,
    priority: 10,
    sourceShareBps: 10000,
    zeroBaseFallback: "SKIP_WARN" as const,
    targetFilter: { projectStatus: ["ACTIVE" as const] },
    validFrom: "2026-01-01",
    validTo: null,
    targets: [],
    ...over,
  })

  // ───────────────────────────────────────────────────────────────────────
  // 1. FIXED_PERCENT con Σ targets ≠ 10000 bps
  // ───────────────────────────────────────────────────────────────────────

  // BUG-E5-1 · CERRADO en la ronda 1 de corrección.
  //
  // I-E5-2 (skill fiabilidad / E5-validacion-liquidacion §4.3) exige «CHECK
  // diferido + validación al guardar». `sourceShareBps` (I-E5-3) ya se validaba
  // en `assertRuleSetCoherent`; `percentBps` NO, ni en la app ni en la base: el
  // `FIXED_PERCENT_NOT_100` sólo saltaba dentro de `allocate()`, al simular o
  // sellar. Quedaba una regla guardada, listada y aparentemente válida que nunca
  // podría repartir nada — la «regla inerte» que ADR-0013 D4 prohíbe, con fallo
  // diferido. Ahora hay DOS barreras, y este test ejercita las dos.

  it("BUG-E5-1 · FIXED_PERCENT con Σ percentBps = 6000 se RECHAZA al guardar, y no queda ninguna regla persistida", async () => {
    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        createAllocationRuleTx(
          tx,
          ruleInput({
            code: "AL-QA-FP60",
            sourceCostCenterId: ceco["CC-DEV"],
            driver: "FIXED_PERCENT",
            targets: [{ projectId: proj["P-01"], percentBps: 6000 }],
          }) as never,
          actor
        )
      )
    ).rejects.toThrow(/100 %/)

    const listed = await listAllocationRules(tenantDb(ORG), { includeClosed: true })
    expect(listed.map((r) => r.code)).not.toContain("AL-QA-FP60")
  })

  it("BUG-E5-1 · la BASE lo repite: el constraint trigger diferido rechaza el INSERT aunque se salte la aplicación", async () => {
    // Por SQL directo, como propietario: ni la acción, ni el zod, ni el modelo.
    // El trigger es DIFERIDO, así que la regla y su destino pueden insertarse en
    // cualquier orden dentro de la transacción; lo que no puede es CONFIRMARSE.
    await expect(
      owner(async (client) => {
        await client.query("BEGIN")
        try {
          const rule = await client.query(
            `INSERT INTO allocation_rules
               (id, organization_id, code, name, source_cost_center_id, target_kind, driver,
                period, priority, source_share_bps, zero_base_fallback, valid_from, updated_at)
             VALUES (gen_random_uuid(), $1, 'AL-QA-FP60-SQL', 'Regla SQL', $2, 'PROJECTS', 'FIXED_PERCENT',
                     'YEAR', 10, 10000, 'SKIP_WARN', DATE '2026-01-01', now())
             RETURNING id`,
            [ORG, ceco["CC-DEV"]]
          )
          await client.query(
            `INSERT INTO allocation_rule_targets (id, organization_id, rule_id, project_id, percent_bps, sort_order)
             VALUES (gen_random_uuid(), $1, $2, $3, 6000, 0)`,
            [ORG, rule.rows[0].id, proj["P-01"]]
          )
          await client.query("COMMIT")
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        }
      })
    ).rejects.toThrow(/FIXED_PERCENT|10000 bps/)

    const rows = await owner((client) =>
      client.query(`SELECT 1 FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-QA-FP60-SQL'`, [ORG])
    )
    expect(rows.rowCount).toBe(0)
  })

  it("BUG-E5-1 · con Σ = 10000 la misma regla se guarda y liquida sin sorpresas", async () => {
    await post({ accountCode: "621", debitCents: 10_000, costCenterId: ceco["CC-DEV"] })
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        ruleInput({
          code: "AL-QA-FP100",
          sourceCostCenterId: ceco["CC-DEV"],
          driver: "FIXED_PERCENT",
          targets: [
            { projectId: proj["P-01"], percentBps: 6000 },
            { projectId: proj["P-02"], percentBps: 4000 },
          ],
        }) as never,
        actor
      )
    )
    expect(created.code).toBe("AL-QA-FP100")
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))
    const lines = preview.result.lines.filter((l) => l.ruleCode === "AL-QA-FP100")
    expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(10_000)

    await owner((client) =>
      client.query(`DELETE FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-QA-FP100'`, [ORG])
    )
  })

  // ───────────────────────────────────────────────────────────────────────
  // 1-bis. BLOQUEA #1 · el destino que no admite el driver, en los dos caminos
  // ───────────────────────────────────────────────────────────────────────

  it("BLOQUEA #1 · COST_CENTERS con un driver calculado se rechaza al guardar (antes repartía 0 € en silencio)", async () => {
    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        createAllocationRuleTx(
          tx,
          ruleInput({
            code: "AL-QA-INERTE",
            sourceCostCenterId: ceco["CC-DEV"],
            targetKind: "COST_CENTERS",
            driver: "DIRECT_COST_SHARE",
            targets: [],
          }) as never,
          actor
        )
      )
    ).rejects.toThrow(/centros de coste/)

    const listed = await listAllocationRules(tenantDb(ORG), { includeClosed: true })
    expect(listed.map((r) => r.code)).not.toContain("AL-QA-INERTE")
  })

  it("BLOQUEA #1 · el zod de la acción rechaza la misma combinación antes de llegar al modelo", async () => {
    const { allocationRuleCreateSchema } = await import("@/forms/allocations")
    const parsed = allocationRuleCreateSchema.safeParse(
      ruleInput({ code: "AL-QA-INERTE-2", targetKind: "COST_CENTERS", driver: "EQUAL", targets: [] })
    )
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.map((i) => i.message).join(" ")).toMatch(/destinos explícitos/)
  })

  it("BLOQUEA #1 · una regla vigente con saldo y SIN receptores con peso no reparte 0: el motor PARA", async () => {
    await post({ accountCode: "621", debitCents: 33_000, costCenterId: ceco["CC-DEV"] })
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        ruleInput({
          code: "AL-QA-SIN-DEST",
          sourceCostCenterId: ceco["CC-DEV"],
          driver: "EQUAL",
          targetFilter: { excludeProjectCodes: ["P-01", "P-02", "P-03"] },
        }) as never,
        actor
      )
    )
    await expect(tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))).rejects.toThrow(
      /RULE_INERT|ningún receptor con peso/
    )
    await owner((client) =>
      client.query(`DELETE FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-QA-SIN-DEST'`, [ORG])
    )
  })

  // ───────────────────────────────────────────────────────────────────────
  // 2. Driver con base 0, fallback por defecto (SKIP_WARN)
  // ───────────────────────────────────────────────────────────────────────

  const YEAR = { periodKind: "YEAR" as const, periodStart: "2026-01-01", periodEnd: "2026-12-31" }

  it("base cero con SKIP_WARN por defecto: no reparte nada, avisa, y el saldo del CECO queda visible", async () => {
    await post({ accountCode: "621", debitCents: 15_000, costCenterId: ceco["CC-MKT"] })
    // REVENUE_SHARE: este fixture nunca postea ingresos directos (705/706/708/709)
    // en ningún proyecto, así que Σw = 0 con toda seguridad, sin depender de lo
    // que otros escenarios de este mismo fichero hayan podido postear antes.
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        ruleInput({
          code: "AL-QA-ZERO",
          sourceCostCenterId: ceco["CC-MKT"],
          driver: "REVENUE_SHARE",
        }) as never,
        actor
      )
    )
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))
    const linesFromMkt = preview.result.lines.filter((l) => l.sourceCostCenterId === ceco["CC-MKT"])
    expect(linesFromMkt).toEqual([])
    expect(preview.result.warnings.some((w) => w.code === "W-E5-ZERO-BASE")).toBe(true)

    await owner((client) =>
      client.query(`DELETE FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-QA-ZERO'`, [ORG])
    )
  })

  // ───────────────────────────────────────────────────────────────────────
  // 3. Cascada cíclica A → B → A, por la vía real de la aplicación
  // ───────────────────────────────────────────────────────────────────────

  it("cascada cíclica CC-DEV → CC-OTR → CC-DEV se rechaza al crear el CONJUNTO, sin persistir ninguna regla", async () => {
    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        createAllocationRulesTx(
          tx,
          [
            ruleInput({
              code: "AL-QA-C1",
              sourceCostCenterId: ceco["CC-DEV"],
              targetKind: "COST_CENTERS",
              driver: "FIXED_PERCENT",
              priority: 10,
              targets: [{ costCenterId: ceco["CC-OTR"], percentBps: 10000 }],
            }),
            ruleInput({
              code: "AL-QA-C2",
              sourceCostCenterId: ceco["CC-OTR"],
              targetKind: "COST_CENTERS",
              driver: "FIXED_PERCENT",
              priority: 20,
              targets: [{ costCenterId: ceco["CC-DEV"], percentBps: 10000 }],
            }),
          ] as never,
          actor
        )
      )
    ).rejects.toThrow(/ciclo/)

    // Todo o nada: ni siquiera la primera regla del conjunto queda persistida.
    const rules = await listAllocationRules(tenantDb(ORG), { includeClosed: true })
    expect(rules.map((r) => r.code)).not.toContain("AL-QA-C1")
    expect(rules.map((r) => r.code)).not.toContain("AL-QA-C2")
  })

  // ───────────────────────────────────────────────────────────────────────
  // 4. Liquidar dos veces el mismo periodo con la misma regla: nunca duplica
  // ───────────────────────────────────────────────────────────────────────

  it("sellar el mismo periodo dos veces sin `supersede` se rechaza; con `supersede` sustituye, nunca duplica", async () => {
    await post({ accountCode: "621", debitCents: 20_000, costCenterId: ceco["CC-GA"] })
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        ruleInput({ code: "AL-QA-GA", sourceCostCenterId: ceco["CC-GA"], driver: "EQUAL" }) as never,
        actor
      )
    )
    const Q1 = { periodKind: "QUARTER" as const, periodStart: "2026-01-01", periodEnd: "2026-03-31" }
    const first = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...Q1, gitSha: "qa" }, actor))
    expect(first.status).toBe("SEALED")

    await expect(
      tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...Q1, gitSha: "qa" }, actor))
    ).rejects.toThrow(/ya tiene una liquidación vigente/)

    // Con supersede: sustituye, un único SEALED vigente por periodo.
    const second = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...Q1, gitSha: "qa", supersede: true, reason: "rerun QA" }, actor)
    )
    expect(second.id).not.toBe(first.id)
    const runsQ1 = (await listAllocationRuns(tenantDb(ORG), { periodKind: "QUARTER" })).filter(
      (r) => r.periodStart === "2026-01-01"
    )
    expect(runsQ1.filter((r) => r.status === "SEALED")).toHaveLength(1)
    expect(runsQ1.find((r) => r.id === first.id)?.status).toBe("SUPERSEDED")
  })

  // ───────────────────────────────────────────────────────────────────────
  // 5. Revertir un run ya revertido
  // ───────────────────────────────────────────────────────────────────────

  it("revertir un run ya REVERSED se rechaza (no se puede revertir dos veces)", async () => {
    const YEAR2 = { periodKind: "YEAR" as const, periodStart: "2026-01-01", periodEnd: "2026-12-31" }
    const run = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...YEAR2, gitSha: "qa" }, actor))
    await tenantTransaction(ORG, USER, async (tx) =>
      reverseAllocationRunTx(tx, { runId: run.id, reason: "primera reversión de prueba", reversedAt: new Date() }, actor)
    )
    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        reverseAllocationRunTx(
          tx,
          { runId: run.id, reason: "segunda reversión de prueba", reversedAt: new Date() },
          actor
        )
      )
    ).rejects.toThrow(/sólo se revierte una vigente/)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 6. VIEWER intentando sellar/revertir
  // ───────────────────────────────────────────────────────────────────────

  it("VIEWER no puede sellar ni revertir: `withOrg(EDITOR)` responde «Sin permiso», sin tocar la BD", async () => {
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: ORG, userId: USER } }, data: { role: "VIEWER" } })
    currentUser = { id: USER, email: "e5-qa@test.local", name: "E5 QA" }
    const { signActiveOrgCookie, ACTIVE_ORG_COOKIE } = await import("@/lib/authz-core")
    const config = (await import("@/lib/config")).default
    cookieBag[ACTIVE_ORG_COOKIE] = signActiveOrgCookie(ORG, USER, config.auth.secret)

    const { sealAllocationRunAction, reverseAllocationRunAction } = await import(
      "@/app/(app)/analytics/allocations/actions"
    )
    const runsBefore = await listAllocationRuns(tenantDb(ORG), {})

    const sealResult = await sealAllocationRunAction({
      periodKind: "MONTH",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
    })
    expect(sealResult.success).toBe(false)

    const anyRun = runsBefore.find((r) => r.status === "SEALED")
    expect(anyRun).toBeDefined()
    const reverseResult = await reverseAllocationRunAction({ runId: anyRun!.id, reason: "intento VIEWER" })
    expect(reverseResult.success).toBe(false)

    const runsAfter = await listAllocationRuns(tenantDb(ORG), {})
    expect(runsAfter).toEqual(runsBefore)

    await prisma.membership.update({ where: { organizationId_userId: { organizationId: ORG, userId: USER } }, data: { role: "ADMIN" } })
  })

  // ───────────────────────────────────────────────────────────────────────
  // 7. Reglas de otra organización: fuga de tenant
  // ───────────────────────────────────────────────────────────────────────

  it("una regla de ORG no puede leerse ni referenciarse desde ORG_OTHER (tenant leak)", async () => {
    const rulesOther = await listAllocationRules(tenantDb(ORG_OTHER), { includeClosed: true })
    expect(rulesOther).toEqual([])
    // Una regla de ORG_OTHER no puede apuntar a un CECO de ORG (FK compuesta).
    await expect(
      tenantTransaction(ORG_OTHER, USER, async (tx) =>
        createAllocationRuleTx(
          tx,
          ruleInput({
            code: "AL-QA-CRUZADA",
            sourceCostCenterId: foreignCeco,
            targetKind: "COST_CENTERS",
            driver: "FIXED_PERCENT",
            targets: [{ costCenterId: ceco["CC-GA"], percentBps: 10000 }],
          }) as never,
          actor
        )
      )
    ).rejects.toThrow()
  })

  // ───────────────────────────────────────────────────────────────────────
  // 8. Periodo bloqueado (PeriodLock)
  // ───────────────────────────────────────────────────────────────────────

  it("un periodo con PeriodLock se puede simular y sellar igualmente (la liquidación no toca el diario)", async () => {
    await tenantTransaction(ORG, USER, async (tx) => lockPeriod(tx, { fiscalYearId, month: 10 }, actor))
    const MONTH10 = { periodKind: "MONTH" as const, periodStart: "2026-10-01", periodEnd: "2026-10-31" }
    // ADR-0004: la liquidación nunca genera asientos, así que un bloqueo de
    // publicación de asientos no tiene por qué impedir liquidar un periodo ya
    // cerrado — es, de hecho, el momento en que su saldo es definitivo.
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, MONTH10))
    expect(preview.result).toBeDefined()
    const run = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...MONTH10, gitSha: "qa" }, actor))
    expect(run.status).toBe("SEALED")
  })

  // ───────────────────────────────────────────────────────────────────────
  // 9. Hamilton: 1 céntimo, 3 receptores con el mismo peso → menor código
  // ───────────────────────────────────────────────────────────────────────

  it("Hamilton con importe de 1 céntimo y 3 receptores EQUAL: el céntimo va al de MENOR código", async () => {
    await post({ accountCode: "621", debitCents: 1, costCenterId: ceco["CC-OTR"] })
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        ruleInput({
          code: "AL-QA-1C",
          sourceCostCenterId: ceco["CC-OTR"],
          driver: "EQUAL",
          targetFilter: { projectStatus: ["ACTIVE"] },
        }) as never,
        actor
      )
    )
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))
    const lines = preview.result.lines.filter((l) => l.sourceCostCenterId === ceco["CC-OTR"])
    // 1 céntimo entre 3 receptores de igual peso: uno se lleva 1, los otros 0.
    expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(1)
    const winner = lines.find((l) => l.amountCents === 1)
    expect(winner?.target.code).toBe("P-01") // menor código lexicográfico de P-01/P-02/P-03
    expect(lines.filter((l) => l.amountCents === 0).map((l) => l.target.code).sort()).toEqual(["P-02", "P-03"])

    await owner((client) =>
      client.query(`DELETE FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-QA-1C'`, [ORG])
    )
  })

  // ───────────────────────────────────────────────────────────────────────
  // 10. Run sobre un periodo sin ningún movimiento
  // ───────────────────────────────────────────────────────────────────────

  it("liquidar un periodo sin ningún movimiento produce un run VACÍO (lineCount = 0), no un error", async () => {
    const MARCH = { periodKind: "MONTH" as const, periodStart: "2026-03-01", periodEnd: "2026-03-31" }
    const run = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...MARCH, gitSha: "qa" }, actor))
    expect(run.status).toBe("SEALED")
    expect(run.lineCount).toBe(0)
    expect(run.totalAllocatedCents).toBe(0)
    expect(run.lines).toEqual([])
  })
})
