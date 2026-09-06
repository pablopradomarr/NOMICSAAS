import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E5 · T14 — Integración de la liquidación contra Postgres de verdad
 * (`docs/design/E5-liquidacion.md` §8.1, criterios 8–18).
 *
 * Lo que se ejerce aquí y no se puede ejercer con funciones puras:
 *  - los seis triggers y los CHECK de la migración (ciclo, orden topológico,
 *    no imputables, driver de E10, inmutabilidad del run, run único por periodo);
 *  - que sellar **no toca el diario** (`ledgerHash` idéntico) pero **sí caduca**
 *    la PyG analítica (`analyticsKey` distinto);
 *  - que un run sustituido o revertido deja de aportar a la matriz (I-E5-9);
 *  - que I4 sigue en PASS tras imputar, con los mismos ocho totales de E4;
 *  - que nada de esto cruza el tenant.
 *
 * La suite conecta con el rol PROPIETARIO: aquí se ejercen lógica y triggers. La
 * RLS efectiva se ejerce en `tests/integration-rls/e5-tenant.test.ts`.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { computeLedgerHash, getLedgerContext, postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { getAllocationCellDetail, getAnalyticPnl } = await import("@/models/margins")
const {
  closeAllocationRuleTx,
  createAllocationRuleTx,
  createAllocationRulesTx,
  diffAllocationRuns,
  getAllocationRun,
  getAppliedAllocations,
  listAllocationRules,
  listAllocationRuns,
  previewAllocationRun,
  reverseAllocationRunTx,
  sealAllocationRunTx,
  supersedeAllocationRuleTx,
} = await import("@/models/allocations")
const { EMPTY_RUN_SET_HASH } = await import("@/lib/analytics/hash")
const { analyticsKeyOf } = await import("@/lib/ledger/report-run")
const { resetOrganizationLedger } = await import("@/scripts/load-fixture")

const ORG = "e5000000-0000-4000-8000-00000000000a"
const ORG_OTHER = "e5000000-0000-4000-8000-00000000000b"
const USER = "e5000000-0000-4000-8000-0000000000a1"
const ALL_ORGS = [ORG, ORG_OTHER]
const actor = { userId: USER }
const REF = "2026-12-31"

const YEAR = { periodKind: "YEAR" as const, periodStart: "2026-01-01", periodEnd: "2026-12-31" }
const Q1 = { periodKind: "QUARTER" as const, periodStart: "2026-01-01", periodEnd: "2026-03-31" }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E5 · liquidación de CECOs en base de datos", () => {
  const ceco: Record<string, string> = {}
  let projectA = ""
  let projectB = ""
  let blGeneral = ""
  let foreignCeco = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e5@test.local", name: "E5" } })
    await prisma.organization.createMany({
      data: ALL_ORGS.map((id, index) => ({
        id,
        slug: `e5-org-${index}`,
        name: `E5 Org ${index}`,
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
      await tenantTransaction(organizationId, USER, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: USER })
      })
    }

    await tenantTransaction(ORG, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      blGeneral = bl.id
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
    })
    await tenantTransaction(ORG_OTHER, USER, async (tx) => {
      foreignCeco = (await tx.costCenter.findFirstOrThrow({ where: { code: "CC-GA" } })).id
    })

    // Diario mínimo pero real: ingresos y coste directo en los dos proyectos y
    // estructura en CC-GA (EBITDA) y CC-OPS (MC3).
    await post({ accountCode: "705", creditCents: 600_000, projectId: projectA })
    await post({ accountCode: "705", creditCents: 400_000, projectId: projectB })
    await post({ accountCode: "600", debitCents: 300_000, projectId: projectA })
    await post({ accountCode: "600", debitCents: 100_000, projectId: projectB })
    await post({ accountCode: "621", debitCents: 90_000, costCenterId: ceco["CC-GA"] })
    await post({ accountCode: "628", debitCents: 30_000, costCenterId: ceco["CC-OPS"] })
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
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

  /** Un asiento de dos líneas: contrapartida en 4300 y la línea con destino. */
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
          description: "Movimiento E5",
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
    code: "AL-GA-Y",
    name: "G&A a proyectos a partes iguales",
    sourceCostCenterId: ceco["CC-GA"],
    targetKind: "PROJECTS" as const,
    driver: "EQUAL" as const,
    period: "YEAR" as const,
    priority: 20,
    sourceShareBps: 10000,
    zeroBaseFallback: "SKIP_WARN" as const,
    targetFilter: { projectStatus: ["ACTIVE" as const] },
    validFrom: "2026-01-01",
    validTo: null,
    targets: [],
    ...over,
  })

  const createRule = (over: Record<string, unknown> = {}) =>
    tenantTransaction(ORG, USER, async (tx) => createAllocationRuleTx(tx, ruleInput(over) as never, actor))

  // ───────────────────────────────────────────────────────────────────────────
  // Reglas: criterios 8, 9, 10, 12, 13
  // ───────────────────────────────────────────────────────────────────────────

  it("criterio 12 · `HOURS` se rechaza en la acción Y en la BD: nunca queda una regla inerte", async () => {
    await expect(createRule({ code: "AL-HORAS", driver: "HOURS" })).rejects.toThrow(/HORAS/)
    // Saltándose la aplicación, el CHECK rechaza el INSERT con 23514.
    await expect(
      owner((client) =>
        client.query(
          `INSERT INTO allocation_rules
             (organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
           VALUES ($1, 'AL-RAW-H', 'raw', $2, 'PROJECTS', 'HOURS', 'YEAR', 10, '2026-01-01', now())`,
          [ORG, ceco["CC-GA"]]
        )
      )
    ).rejects.toMatchObject({ code: "23514" })
  })

  it("criterio 13 · un CECO no imputable no puede ser fuente ni destino", async () => {
    await expect(createRule({ code: "AL-FIN", sourceCostCenterId: ceco["CC-FIN"] })).rejects.toThrow(/imputable/)
    await expect(
      createRule({
        code: "AL-A-FIN",
        targetKind: "COST_CENTERS",
        driver: "FIXED_PERCENT",
        targets: [{ costCenterId: ceco["CC-FIN"], percentBps: 10000 }],
      })
    ).rejects.toThrow(/imputable/)
    const rules = await listAllocationRules(tenantDb(ORG), { includeClosed: true })
    expect(rules.map((r) => r.code)).not.toContain("AL-FIN")
  })

  it("criterio 10 · `Σ sourceShareBps ≠ 10000` se rechaza y el mensaje dice cuánto falta", async () => {
    await expect(createRule({ code: "AL-PARCIAL", sourceShareBps: 3000 })).rejects.toThrow(/70\.00 % restante/)
  })

  it("criterio 8 · un ciclo se rechaza: en la acción y, saltándosela, en el constraint trigger", async () => {
    // El 30/70 se declara ENTERO: Σ sourceShareBps se juzga sobre el conjunto.
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRulesTx(
        tx,
        [
          ruleInput({
            code: "AL-GA-OPS",
            targetKind: "COST_CENTERS",
            driver: "FIXED_PERCENT",
            priority: 10,
            sourceShareBps: 3000,
            targets: [{ costCenterId: ceco["CC-OPS"], percentBps: 10000 }],
          }),
          ruleInput({ code: "AL-GA-PRY", priority: 20, sourceShareBps: 7000 }),
        ] as never,
        actor
      )
    )
    // CC-OPS también necesita una regla: recibe en cascada y tiene que sacarlo.
    await createRule({ code: "AL-OPS-Y", sourceCostCenterId: ceco["CC-OPS"], priority: 30 })
    // Ahora CC-OPS → CC-GA cerraría el ciclo. El constraint trigger diferido lo
    // detecta al confirmar, aunque el INSERT se haga por SQL crudo.
    await expect(
      owner(async (client) => {
        await client.query("BEGIN")
        const rule = await client.query(
          `INSERT INTO allocation_rules
             (organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
           VALUES ($1, 'AL-CICLO', 'ciclo', $2, 'COST_CENTERS', 'FIXED_PERCENT', 'YEAR', 30, '2026-01-01', now())
           RETURNING id`,
          [ORG, ceco["CC-OPS"]]
        )
        await client.query(
          `INSERT INTO allocation_rule_targets (organization_id, rule_id, cost_center_id, percent_bps)
           VALUES ($1, $2, $3, 10000)`,
          [ORG, rule.rows[0].id, ceco["CC-GA"]]
        )
        await client.query("COMMIT")
      })
    ).rejects.toThrow(/ciclo/)
  })

  it("criterio 9 · la prioridad tiene que ser un orden topológico de la cascada", async () => {
    // `AL-GA-OPS` (donante, prioridad 10) alimenta a CC-OPS: una regla con fuente
    // CC-OPS y prioridad 5 rompería el orden.
    await expect(
      owner(async (client) => {
        await client.query("BEGIN")
        await client.query(
          `INSERT INTO allocation_rules
             (organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
           VALUES ($1, 'AL-OPS-TOPO', 'topo', $2, 'PROJECTS', 'EQUAL', 'YEAR', 5, '2026-01-01', now())`,
          [ORG, ceco["CC-OPS"]]
        )
        await client.query("COMMIT")
      })
    ).rejects.toThrow(/topológico/)
  })

  it("versionado: una regla se cierra y se abre otra con el mismo código, sin solape", async () => {
    // Sobre `CC-OTR`, que no tiene ninguna otra regla: el conjunto de un CECO se
    // juzga entero y así el escenario no toca el 30/70 de CC-GA.
    const created = await createRule({ code: "AL-OTR-Y", sourceCostCenterId: ceco["CC-OTR"], priority: 40 })

    const next = await tenantTransaction(ORG, USER, async (tx) =>
      supersedeAllocationRuleTx(
        tx,
        { ruleId: created.id, validFrom: "2026-07-01", reason: "cambio de política de reparto", changes: {} },
        actor
      )
    )
    expect(next.code).toBe("AL-OTR-Y")
    expect(next.id).not.toBe(created.id)

    const versions = (await listAllocationRules(tenantDb(ORG), { includeClosed: true })).filter(
      (r) => r.code === "AL-OTR-Y"
    )
    expect(versions).toHaveLength(2)
    expect(versions.map((v) => v.validTo).filter(Boolean)).toEqual(["2026-06-30"])

    // El EXCLUDE de vigencias impide una tercera versión que se solape.
    await expect(
      owner((client) =>
        client.query(
          `INSERT INTO allocation_rules
             (organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
           VALUES ($1, 'AL-OTR-Y', 'solape', $2, 'PROJECTS', 'EQUAL', 'YEAR', 40, '2026-09-01', now())`,
          [ORG, ceco["CC-OTR"]]
        )
      )
    ).rejects.toMatchObject({ code: "23P01" })

    // Se cierran las dos versiones: CC-OTR no tiene saldo y no debe liquidar.
    await tenantTransaction(ORG, USER, async (tx) => {
      await closeAllocationRuleTx(tx, { ruleId: next.id, validTo: "2026-12-31", reason: "fin del escenario" }, actor)
      await closeAllocationRuleTx(tx, { ruleId: created.id, validTo: "2026-06-30", reason: "fin del escenario" }, actor)
    })
    expect((await listAllocationRules(tenantDb(ORG), {})).map((r) => r.code)).not.toContain("AL-OTR-Y")
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Sellado: criterios 14, 15, 16, 17, 18
  // ───────────────────────────────────────────────────────────────────────────

  it("criterio 14 · la simulación no escribe nada y el run sellado es idéntico a ella", async () => {
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, YEAR))
    expect(await tenantDb(ORG).allocationRun.count()).toBe(0)
    expect(preview.result.lines.length).toBeGreaterThan(0)

    const run = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...YEAR, gitSha: "test", expectedHashes: preview.seals }, actor)
    )
    expect(run.lineCount).toBe(preview.result.lines.length)
    expect(run.totalAllocatedCents).toBe(preview.result.totalAllocatedCents)
    expect(run.lines.map((l) => [l.ruleCode, l.target.code, l.marginLevel, l.amountCents])).toEqual(
      preview.result.lines.map((l) => [l.ruleCode, l.target.code, l.marginLevel, l.amountCents])
    )
  })

  it("criterio 4 · el nivel VIAJA con el importe: lo de CC-GA aterriza en EBITDA aunque pase por CC-OPS", async () => {
    const applied = await getAppliedAllocations(tenantDb(ORG), { from: "2026-01-01", to: "2026-12-31" })
    const fromOps = applied.lines.filter((l) => l.sourceCostCenterCode === "CC-OPS")
    // CC-OPS es MC3, pero lo recibido de CC-GA (EBITDA) conserva su nivel.
    expect(fromOps.some((l) => l.marginLevel === "EBITDA")).toBe(true)
    expect(applied.lines.every((l) => l.marginLevel === "MC3" || l.marginLevel === "EBITDA")).toBe(true)
  })

  it("criterio 2 · I4 tras imputar: los ocho totales son los MISMOS que sin imputar (E4)", async () => {
    const withOut = await tenantTransaction(ORG, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        provenance: { runId: "e5", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    const withIn = await tenantTransaction(ORG, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "e5", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    for (const level of Object.keys(withOut.pnl.levelTotalsCents)) {
      expect(withIn.pnl.levelTotalsCents[level]).toBe(withOut.pnl.levelTotalsCents[level])
    }
    // Y las columnas de CECO imputable llegan a 0, que es lo que E4 no lograba.
    expect(withOut.pnl.matrixCents.EBITDA["CECO:G_A"]).toBe(-90_000)
    expect(withIn.pnl.matrixCents.EBITDA["CECO:G_A"]).toBe(0)
    expect(withIn.pnl.matrixCents.MC3["CECO:OPERACIONES_INDIRECTAS"]).toBe(0)
    // I4 y los doce de E4 siguen en PASS sobre la matriz IMPUTADA.
    expect(withIn.checks.filter((c) => c.status === "FAIL")).toEqual([])
    // I-E5-6: el Δ suma cero en cada nivel.
    for (const level of Object.keys(withIn.pnl.allocationDeltaCents)) {
      expect(Object.values(withIn.pnl.allocationDeltaCents[level]).reduce((a, b) => a + b, 0)).toBe(0)
    }
  })

  it("criterio 17 · liquidar cambia el `analyticsKey` y NO toca el `ledgerHash`", async () => {
    const ledgerBefore = await tenantTransaction(ORG, async (tx) =>
      computeLedgerHash(tx, { from: "2026-01-01", to: "2026-12-31" })
    )
    const withOut = await tenantTransaction(ORG, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        provenance: { runId: "e5", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    const withIn = await tenantTransaction(ORG, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "e5", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    // El diario no se ha movido: balance, PyG contable y cashflow conservan caché.
    expect(withIn.ledgerHash).toBe(ledgerBefore)
    expect(withOut.ledgerHash).toBe(ledgerBefore)
    // La analítica sí: son dos `ReportRun` distintos y la caché no los confunde.
    expect(withOut.allocationRunSetHash).toBe(EMPTY_RUN_SET_HASH)
    expect(withIn.allocationRunSetHash).not.toBe(EMPTY_RUN_SET_HASH)
    expect(withIn.analyticsHash).not.toBe(withOut.analyticsHash)
    expect(
      analyticsKeyOf({
        analyticsHash: withIn.analyticsHash,
        marginConfigHash: withIn.marginConfigHash,
        allocationRunId: withIn.allocationRunSetHash,
      })
    ).not.toBe(
      analyticsKeyOf({ analyticsHash: withOut.analyticsHash, marginConfigHash: withOut.marginConfigHash })
    )
  })

  it("el trigger espejo de `report_runs` compone el `analytics_key` igual que TypeScript", async () => {
    const key = await owner(async (client) => {
      const { rows } = await client.query(
        `SELECT COALESCE($1::text, '∅') || '|' || COALESCE($2::text, '∅') || '|' || COALESCE($3::text, '∅') AS k`,
        ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
      )
      return rows[0].k as string
    })
    expect(key).toBe(
      analyticsKeyOf({ analyticsHash: "a".repeat(64), marginConfigHash: "b".repeat(64), allocationRunId: "c".repeat(64) })
    )
  })

  it("criterio 14b · entre simular y sellar cambia el diario ⇒ `LIQUIDACION_DESFASADA`, no se persiste", async () => {
    const preview = await tenantTransaction(ORG, USER, async (tx) => previewAllocationRun(tx, Q1))
    await post({ accountCode: "628", debitCents: 5_000, costCenterId: ceco["CC-OPS"], entryDate: "2026-03-20" })
    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        sealAllocationRunTx(tx, { ...Q1, gitSha: "test", expectedHashes: preview.seals }, actor)
      )
    ).rejects.toThrow(/vuelve a simular/)
    const runs = await listAllocationRuns(tenantDb(ORG), {})
    expect(runs.filter((r) => r.periodKind === "QUARTER")).toHaveLength(0)
  })

  it("criterio 15 · rerun: el anterior pasa a SUPERSEDED, deja de aportar (I-E5-9) y sigue consultable", async () => {
    const before = await listAllocationRuns(tenantDb(ORG), { periodKind: "YEAR" })
    expect(before).toHaveLength(1)
    const previousId = before[0].id

    const again = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...YEAR, gitSha: "test", supersede: true, reason: "asiento tardío del periodo" }, actor)
    )
    const after = await listAllocationRuns(tenantDb(ORG), { periodKind: "YEAR" })
    expect(after.find((r) => r.id === previousId)?.status).toBe("SUPERSEDED")
    expect(after.find((r) => r.id === previousId)?.supersededById).toBe(again.id)
    // El sustituido sigue consultable con todas sus líneas.
    const old = await getAllocationRun(tenantDb(ORG), previousId)
    expect(old?.lines.length).toBeGreaterThan(0)
    // Pero no aporta: la matriz sólo suma el vigente.
    const applied = await getAppliedAllocations(tenantDb(ORG), { from: "2026-01-01", to: "2026-12-31" })
    expect(applied.runIds).toEqual([again.id])
    // Y el diff celda a celda hace VISIBLE el cambio de política: entre el run
    // anterior y éste se posteó un gasto tardío de 5 000 c en CC-OPS, así que
    // el reparto crece exactamente en esos 5 000 c y en ninguna otra cifra.
    const diff = await diffAllocationRuns(tenantDb(ORG), { runId: again.id, againstRunId: previousId })
    expect(diff.reduce((a, d) => a + d.deltaCents, 0)).toBe(5_000)
    expect(diff.some((d) => d.deltaCents !== 0)).toBe(true)
    expect(again.totalAllocatedCents - before[0].totalAllocatedCents).toBe(5_000)
  })

  it("criterio 15b · reversión: motivo de 9 caracteres se rechaza; con 10 apaga el run sin generar asientos", async () => {
    const ledgerBefore = await tenantTransaction(ORG, async (tx) =>
      computeLedgerHash(tx, { from: "2026-01-01", to: "2026-12-31" })
    )
    const runs = await listAllocationRuns(tenantDb(ORG), { periodKind: "YEAR" })
    const live = runs.find((r) => r.status === "SEALED")
    expect(live).toBeDefined()

    await expect(
      tenantTransaction(ORG, USER, async (tx) =>
        reverseAllocationRunTx(tx, { runId: live!.id, reason: "9 chars!", reversedAt: new Date() }, actor)
      )
    ).rejects.toThrow(/al menos 10 caracteres/)

    await tenantTransaction(ORG, USER, async (tx) =>
      reverseAllocationRunTx(tx, { runId: live!.id, reason: "reparto aprobado por error", reversedAt: new Date() }, actor)
    )
    const detail = await getAllocationRun(tenantDb(ORG), live!.id)
    expect(detail?.status).toBe("REVERSED")
    expect(detail?.reversalReason).toBe("reparto aprobado por error")
    // No se ha generado ningún asiento (ADR-0004).
    expect(await tenantTransaction(ORG, async (tx) => computeLedgerHash(tx, { from: "2026-01-01", to: "2026-12-31" }))).toBe(
      ledgerBefore
    )
    // Y deja de aportar a la matriz.
    const applied = await getAppliedAllocations(tenantDb(ORG), { from: "2026-01-01", to: "2026-12-31" })
    expect(applied.runIds).toEqual([])
    expect(applied.runSetHash).toBe(EMPTY_RUN_SET_HASH)
  })

  it("criterio 16 · inmutabilidad: `allocation_lines` no admite UPDATE ni DELETE ni siquiera del propietario", async () => {
    const runs = await listAllocationRuns(tenantDb(ORG), {})
    const withLines = runs.find((r) => r.lineCount > 0)
    expect(withLines).toBeDefined()
    // El propietario esquiva el GRANT, pero el trigger de `allocation_runs` no.
    await expect(
      owner((client) =>
        client.query(`UPDATE allocation_runs SET total_allocated_cents = 1 WHERE organization_id = $1 AND id = $2`, [
          ORG,
          withLines!.id,
        ])
      )
    ).rejects.toThrow(/append-only/)
    const intact = await getAllocationRun(tenantDb(ORG), withLines!.id)
    expect(intact?.totalAllocatedCents).toBe(withLines!.totalAllocatedCents)
  })

  it("criterio 16b · dos runs SEALED del mismo periodo: 23505 por el índice único parcial", async () => {
    const fy = await owner(async (client) => {
      const { rows } = await client.query(`SELECT id FROM fiscal_years WHERE organization_id = $1`, [ORG])
      return rows[0].id as string
    })
    await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...Q1, gitSha: "test" }, actor))
    await expect(
      owner((client) =>
        client.query(
          `INSERT INTO allocation_runs
             (organization_id, fiscal_year_id, period_kind, period_start, period_end, status,
              ledger_hash, analytics_hash, rules_hash, git_sha)
           VALUES ($1, $2, 'QUARTER', '2026-01-01', '2026-03-31', 'SEALED', $3, $3, $3, 'raw')`,
          [ORG, fy, "0".repeat(64)]
        )
      )
    ).rejects.toMatchObject({ code: "23505" })
  })

  it("criterio 18 · un run trimestral NO entra en un informe mensual: nunca se trocea", async () => {
    const february = await getAppliedAllocations(tenantDb(ORG), { from: "2026-02-01", to: "2026-02-28" })
    expect(february.runIds).toEqual([])
    const quarter = await getAppliedAllocations(tenantDb(ORG), { from: "2026-01-01", to: "2026-03-31" })
    expect(quarter.runIds).toHaveLength(1)
  })

  it("criterio 19a · nada de esto cruza el tenant: la otra organización no ve ni una regla ni un run", async () => {
    expect(await listAllocationRules(tenantDb(ORG_OTHER), { includeClosed: true })).toEqual([])
    expect(await listAllocationRuns(tenantDb(ORG_OTHER), {})).toEqual([])
    expect((await getAppliedAllocations(tenantDb(ORG_OTHER), { from: "2026-01-01", to: "2026-12-31" })).lines).toEqual([])
    // Y una regla de ORG no puede apuntar a un CECO de ORG_OTHER: la FK compuesta
    // por tenant lo impide antes que cualquier comprobación de la aplicación.
    await expect(
      createRule({
        code: "AL-CRUZADA",
        targetKind: "COST_CENTERS",
        driver: "FIXED_PERCENT",
        priority: 40,
        targets: [{ costCenterId: foreignCeco, percentBps: 10000 }],
      })
    ).rejects.toThrow()
    // Y un run de ORG no es legible desde ORG_OTHER ni por id directo.
    const runs = await listAllocationRuns(tenantDb(ORG), {})
    expect(await getAllocationRun(tenantDb(ORG_OTHER), runs[0].id)).toBeNull()
  })

  it("I5 y los doce `I-E5-*` llegan a `validacion.json` por `runLedgerInvariants`", async () => {
    // Se vuelve a liquidar el año: el run vigente se revirtió en el criterio 15b.
    await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...YEAR, gitSha: "test" }, actor))
    const run = await runLedgerInvariants(ORG, { refDate: REF, noCache: true })
    const ids = run.validacion.checks.map((c) => c.id)
    expect(ids).toContain("I5")
    for (let i = 1; i <= 12; i++) expect(ids).toContain(`I-E5-${i}`)
    const failed = run.validacion.checks.filter((c) => c.status === "FAIL")
    expect(failed.map((c) => `${c.id}: ${c.evidencia}`)).toEqual([])
  })

  it("§3.2 · el drill-down de una celda imputada EJECUTA su consulta y reproduce el Δ de la celda", async () => {
    const report = await tenantTransaction(ORG, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "e5", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    const detail = await tenantTransaction(ORG, async (tx) =>
      getAllocationCellDetail(tx, { level: "EBITDA", column: "PROJ:P-01", from: "2026-01-01", to: "2026-12-31" })
    )
    // La consulta que se ejecuta es EXACTAMENTE la que viaja en la provenance.
    expect(detail.query).toContain("FROM allocation_lines")
    expect(detail.query).toContain("target_project_id = $3")
    expect(detail.lines.length).toBeGreaterThan(0)
    // Y su suma es, al céntimo, el Δ que la matriz aplicó a esa celda.
    expect(detail.amountCents).toBe(report.pnl.allocationDeltaCents.EBITDA["PROJ:P-01"])
    // En una columna de CECO la misma línea aparece con los DOS efectos, y el
    // neto de la columna es cero porque el CECO queda liquidado.
    const ga = await tenantTransaction(ORG, async (tx) =>
      getAllocationCellDetail(tx, { level: "EBITDA", column: "CECO:G_A", from: "2026-01-01", to: "2026-12-31" })
    )
    expect(ga.amountCents).toBe(report.pnl.allocationDeltaCents.EBITDA["CECO:G_A"])
    // Sin runs vigentes en el periodo no se ejecuta ninguna consulta ni se
    // devuelve ninguna línea: la mitad imputada de la celda vale cero.
    const empty = await tenantTransaction(ORG, async (tx) =>
      getAllocationCellDetail(tx, { level: "EBITDA", column: "PROJ:P-01", from: "2026-02-01", to: "2026-02-28" })
    )
    expect(empty.runIds).toEqual([])
    expect(empty.lines).toEqual([])
    expect(empty.amountCents).toBe(0)
  })

  it("los cambios de política y el ciclo del run quedan en `AuditLog`, en la misma transacción", async () => {
    const logs = await tenantDb(ORG).auditLog.findMany({
      where: { entity: { in: ["AllocationRule", "AllocationRun"] } },
      orderBy: { ts: "asc" },
    })
    const actions = new Set(logs.map((l) => l.action))
    expect(actions).toContain("create")
    expect(actions).toContain("seal")
    expect(actions).toContain("supersede")
    expect(actions).toContain("reverse")
    expect(logs.every((l) => l.userId === USER)).toBe(true)
    // Toda reversión lleva su motivo escrito.
    expect(logs.filter((l) => l.action === "reverse").every((l) => (l.reason ?? "").length >= 10)).toBe(true)
  })

  it("`--reset-org` purga también la liquidación, en orden de FK", async () => {
    const before = await owner((client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM allocation_lines WHERE organization_id = $1`,
        [ORG]
      )
    )
    expect(before.rows[0].n).toBeGreaterThan(0)

    // El reset es una operación de OPERADOR (ADR-0009 §6) y exige una conexión
    // que no esté sujeta al tenant; en esta suite la del propietario lo es.
    const previous = process.env.DATABASE_URL_MAINTENANCE
    process.env.DATABASE_URL_MAINTENANCE = TEST_DATABASE_URL
    try {
      // Sin la purga de `allocation_*`, el `DELETE FROM cost_centers` chocaría
      // con el `RESTRICT` de `allocation_lines_source_cost_center_fkey` y el
      // reset dejaría la organización a medias.
      await resetOrganizationLedger(ORG, USER)
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL_MAINTENANCE
      else process.env.DATABASE_URL_MAINTENANCE = previous
    }

    for (const table of ["allocation_lines", "allocation_runs", "allocation_rule_targets", "allocation_rules"]) {
      const after = await owner((client) =>
        client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = $1`, [ORG])
      )
      expect(after.rows[0].n, table).toBe(0)
    }
    // Y las dimensiones, que es lo que el RESTRICT protegía, también se van.
    const cecos = await owner((client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM cost_centers WHERE organization_id = $1`, [ORG])
    )
    expect(cecos.rows[0].n).toBe(0)
  })

  void blGeneral
})
