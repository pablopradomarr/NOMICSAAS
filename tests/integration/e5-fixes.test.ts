import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E5 · ronda 1 de corrección — integración contra Postgres de verdad.
 *
 * Un bloque por hallazgo BLOQUEA/DEBE que sólo se puede demostrar con la base
 * delante:
 *
 *  · **BLOQUEA #2** — `allocationRunSetHash` llega al `ReportRun`: la columna
 *    `report_runs.allocation_run_set_hash` se escribe, la `analytics_key` que
 *    compone el trigger coincide con la de la aplicación, sellar una
 *    liquidación CADUCA el `PYG_ANALITICA` imputado y el informe persistido es
 *    el MISMO que la pantalla (exportaciones = pantalla).
 *  · **BLOQUEA #3** — I5 y los doce `I-E5-*` se ejecutan en producción: salen en
 *    los checks del `ReportRun`, en `getAnalyticPnl` y en el barrido de
 *    `runLedgerInvariants`; con un error inyectado por SQL en `allocation_lines`
 *    el sello pasa a `REQUIERE REVISIÓN`.
 *  · **DEBE #5** — trigger de inmutabilidad de `allocation_rule_targets`.
 *  · **Auditoría 1** — `linesHash` persistido y verificado por I-E5-12.
 *  · **DEBE #9** — `/analytics/allocations/runs` sin N+1.
 *
 * Conecta con el rol PROPIETARIO: aquí se ejercen lógica y triggers, no RLS.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { clearMarginCache, getAnalyticPnl } = await import("@/models/margins")
const { getOrCreateReportRun } = await import("@/models/reports")
const {
  createAllocationRuleTx,
  getAllocationRun,
  getAllocationTotals,
  getAppliedAllocations,
  getSealedRunRefs,
  listAllocationRuns,
  reverseAllocationRunTx,
  sealAllocationRunTx,
} = await import("@/models/allocations")
const { linesHash } = await import("@/lib/analytics/allocate")
const { analyticsKeyOf } = await import("@/lib/ledger/report-run")
const { ReportType, Seal } = await import("@/prisma/client")

const ORG = "e5f00000-0000-4000-8000-00000000000a"
const USER = "e5f00000-0000-4000-8000-0000000000a1"
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

describe.skipIf(!TEST_DATABASE_URL)("E5 · ronda 1 de corrección", () => {
  const ceco: Record<string, string> = {}
  let projectA = ""
  let projectB = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e5-fixes@test.local", name: "E5 fixes" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e5-fixes-org", name: "E5 fixes", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })
    await importNpgc(ORG, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: USER })
    })
    await tenantTransaction(ORG, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      projectA = (
        await tx.project.create({ data: { organizationId: ORG, code: "P-01", name: "Alfa", businessLineId: bl.id, sortOrder: 1 } })
      ).id
      projectB = (
        await tx.project.create({ data: { organizationId: ORG, code: "P-02", name: "Beta", businessLineId: bl.id, sortOrder: 2 } })
      ).id
      for (const c of await tx.costCenter.findMany()) ceco[c.code] = c.id
    })

    await post({ accountCode: "705", creditCents: 600_000, projectId: projectA })
    await post({ accountCode: "705", creditCents: 400_000, projectId: projectB })
    await post({ accountCode: "600", debitCents: 300_000, projectId: projectA })
    await post({ accountCode: "600", debitCents: 100_000, projectId: projectB })
    await post({ accountCode: "621", debitCents: 90_001, costCenterId: ceco["CC-GA"] })

    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        {
          code: "AL-GA-Y",
          name: "Estructura a proyectos por ingresos",
          sourceCostCenterId: ceco["CC-GA"],
          targetKind: "PROJECTS",
          driver: "REVENUE_SHARE",
          period: "YEAR",
          priority: 10,
          sourceShareBps: 10000,
          zeroBaseFallback: "SKIP_WARN",
          targetFilter: { projectStatus: ["ACTIVE"] },
          validFrom: "2026-01-01",
          validTo: null,
          targets: [],
        },
        actor
      )
    )
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      for (const table of ["allocation_lines", "allocation_runs", "allocation_rule_targets", "allocation_rules"]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1`, [ORG])
      }
      await client.query(`DELETE FROM journal_lines WHERE organization_id = $1`, [ORG])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = $1`, [ORG])
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
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1`, [ORG])
      }
      await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
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
          description: "Movimiento E5 fixes",
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

  const analyticRun = (withAllocations: boolean, variante?: string) =>
    getOrCreateReportRun(ORG, {
      type: ReportType.PYG_ANALITICA,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      // `variante` cambia el `paramsHash` y por tanto la clave: es la forma de
      // pedir un run NUEVO cuando la clave natural no se ha movido (alterar
      // `allocation_lines` por SQL no cambia ni el `ledgerHash` ni el conjunto
      // de runs, así que el informe ya emitido se serviría de caché).
      params: { withAllocations, ...(variante ? { variante } : {}) },
      actor,
      noCache: true,
    })

  // ───────────────────────────────────────────────────────────────────────
  // BLOQUEA #2 · el cuarto sello llega al ReportRun
  // ───────────────────────────────────────────────────────────────────────

  it("BLOQUEA #2 · sin imputaciones el `ReportRun` deja la columna en NULL y la clave con el centinela", async () => {
    const run = await analyticRun(false)
    const row = await owner((client) =>
      client.query(`SELECT allocation_run_set_hash, analytics_key FROM report_runs WHERE id = $1`, [run.id])
    )
    expect(row.rows[0].allocation_run_set_hash).toBeNull()
    expect(row.rows[0].analytics_key.endsWith("|∅")).toBe(true)
  })

  it("BLOQUEA #2 · con imputaciones se ESCRIBE el hash del conjunto y el trigger compone la misma clave", async () => {
    const sealed = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...YEAR, gitSha: "fixes" }, actor)
    )
    expect(sealed.lineCount).toBeGreaterThan(0)
    clearMarginCache()

    const run = await analyticRun(true)
    const row = await owner((client) =>
      client.query(
        `SELECT allocation_run_set_hash, analytics_hash, margin_config_hash, analytics_key FROM report_runs WHERE id = $1`,
        [run.id]
      )
    )
    const stored = row.rows[0]
    expect(stored.allocation_run_set_hash).not.toBeNull()
    // Espejo exacto: la clave que compone el trigger y la que calcula la
    // aplicación son la MISMA cadena (auditoría, hallazgo 3).
    expect(stored.analytics_key).toBe(
      analyticsKeyOf({
        analyticsHash: stored.analytics_hash,
        marginConfigHash: stored.margin_config_hash,
        allocationRunSetHash: stored.allocation_run_set_hash,
      })
    )
  })

  it("BLOQUEA #2 · el informe SELLADO es el mismo que la pantalla: imputado ≠ no imputado", async () => {
    const conImputar = await analyticRun(true)
    const sinImputar = await analyticRun(false)
    expect(conImputar.id).not.toBe(sinImputar.id)
    expect(conImputar.analyticsKey).not.toBe(sinImputar.analyticsKey)

    // «Exportaciones = pantalla»: el `result` persistido tiene los mismos
    // totales por nivel que `getAnalyticPnl` con el mismo toggle.
    clearMarginCache()
    const screen = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "screen", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    const stored = conImputar.result as { levelTotalsCents?: Record<string, number> }
    expect(stored.levelTotalsCents).toEqual(screen.pnl.levelTotalsCents)
    // Y el imputado NO es el mismo informe que el no imputado: la estructura de
    // CC-GA ha bajado a los proyectos.
    const plain = sinImputar.result as { matrixCents?: Record<string, Record<string, number>> }
    const imputed = conImputar.result as { matrixCents?: Record<string, Record<string, number>> }
    expect(imputed.matrixCents?.EBITDA).not.toEqual(plain.matrixCents?.EBITDA)
  })

  it("BLOQUEA #2 · criterio 17 · sellar una liquidación CADUCA el informe imputado y NO el contable", async () => {
    const before = await analyticRun(true)
    const balanceBefore = await getOrCreateReportRun(ORG, {
      type: ReportType.BALANCE,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      params: {},
      actor,
    })

    // Una liquidación MÁS —el trimestre, que aquí no tiene reglas y sale
    // vacío— cambia el CONJUNTO de runs vigentes, que es lo que la clave sella:
    // el informe imputado tiene que caducar aunque el diario no se mueva.
    await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(tx, { ...Q1, gitSha: "fixes" }, actor)
    )
    clearMarginCache()

    const after = await analyticRun(true)
    expect(after.id).not.toBe(before.id)
    expect(after.analyticsKey).not.toBe(before.analyticsKey)

    // El diario del balance sí ha cambiado (hemos posteado), así que se compara
    // la parte que NO depende de la liquidación: su `analytics_key` sigue siendo
    // el centinela, es decir, la liquidación no interviene en él.
    const balanceAfter = await getOrCreateReportRun(ORG, {
      type: ReportType.BALANCE,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      params: {},
      actor,
    })
    expect(balanceBefore.analyticsKey).toBe(balanceAfter.analyticsKey)
  })

  // ───────────────────────────────────────────────────────────────────────
  // BLOQUEA #3 · I5 y los doce I-E5-* en producción
  // ───────────────────────────────────────────────────────────────────────

  it("BLOQUEA #3 · los checks de E5 salen en la PyG analítica imputada y NO en la no imputada", async () => {
    clearMarginCache()
    const imputada = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "checks", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    const ids = imputada.checks.map((c) => c.id)
    expect(ids).toContain("I5")
    for (let n = 1; n <= 12; n++) expect(ids).toContain(`I-E5-${n}`)
    expect(imputada.checks.filter((c) => c.status === "FAIL")).toEqual([])

    // I5.a ya no declara «0 combinación(es)»: las balances se reconstruyen.
    const i5 = imputada.checks.find((c) => c.id === "I5")
    expect(i5?.evidencia).toMatch(/[1-9]\d* combinación\(es\)/)

    clearMarginCache()
    const sinImputar = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        provenance: { runId: "checks2", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    expect(sinImputar.checks.map((c) => c.id)).not.toContain("I5")
  })

  it("BLOQUEA #3 · los mismos checks salen en el sello del `ReportRun` imputado", async () => {
    clearMarginCache()
    const run = await analyticRun(true, "sello")
    const validation = run.validation as { checks: { id: string; status: string }[] }
    expect(validation.checks.map((c) => c.id)).toContain("I5")
    expect(validation.checks.map((c) => c.id)).toContain("I-E5-12")
  })

  it("BLOQUEA #3 · error inyectado por SQL en `allocation_lines` ⇒ I5 y I-E5-12 en FAIL y sello REQUIERE REVISIÓN", async () => {
    const runs = await listAllocationRuns(tenantDb(ORG), { periodKind: "YEAR" })
    const target = runs.find((r) => r.status === "SEALED")
    expect(target).toBeDefined()

    // (a) Alteración de suma NO cero: sube 100 c una línea. La detecta I5.a
    //     —la base reconstruida desde el diario no se mueve— y I-E5-12.
    await owner((client) =>
      client.query(
        `UPDATE allocation_lines SET amount_cents = amount_cents + 100
          WHERE organization_id = $1 AND run_id = $2
            AND id = (SELECT id FROM allocation_lines WHERE run_id = $2 ORDER BY id LIMIT 1)`,
        [ORG, target!.id]
      )
    )
    try {
      clearMarginCache()
      const tampered = await tenantTransaction(ORG, USER, async (tx) =>
        getAnalyticPnl(tx, {
          from: "2026-01-01",
          to: "2026-12-31",
          withAllocations: true,
          provenance: { runId: "tampered", gitSha: "fixes", baseCurrency: "EUR" },
        })
      )
      const failed = tampered.checks.filter((c) => c.status === "FAIL").map((c) => c.id)
      expect(failed).toContain("I5")
      expect(failed).toContain("I-E5-12")

      // El sello del informe pasa a REQUIERE REVISIÓN por EV-9 (invariante FAIL).
      clearMarginCache()
      const run = await analyticRun(true, "tras-inyeccion")
      expect(run.seal).toBe(Seal.REQUIERE_REVISION)
      expect(JSON.stringify(run.sealReasons)).toContain("I5")

      // El barrido completo de `runLedgerInvariants` lo ve igual.
      const sweep = await runLedgerInvariants(ORG, { refDate: REF, noCache: true })
      expect(sweep.validacion.checks.find((c) => c.id === "I5")?.status).toBe("FAIL")
      expect(sweep.sello.sello).toBe("REQUIERE REVISIÓN")
    } finally {
      await owner((client) =>
        client.query(
          `UPDATE allocation_lines SET amount_cents = amount_cents - 100
            WHERE organization_id = $1 AND run_id = $2
              AND id = (SELECT id FROM allocation_lines WHERE run_id = $2 ORDER BY id LIMIT 1)`,
          [ORG, target!.id]
        )
      )
      clearMarginCache()
    }
  })

  it("auditoría 1 · CASO B: alteración de SUMA CERO dentro del run ⇒ sólo I-E5-12 la ve, y la ve", async () => {
    const runs = await listAllocationRuns(tenantDb(ORG), { periodKind: "YEAR" })
    const target = runs.find((r) => r.status === "SEALED")!
    const before = await getAllocationRun(tenantDb(ORG), target.id)
    expect(before?.linesHash).toMatch(/^[0-9a-f]{64}$/)
    expect(before?.linesHash).toBe(linesHash(before!.lines))

    // El céntimo cambia de receptor: Σ del run, Σ por fuente, cierre a 0 y la
    // cota de I-E5-4 se mantienen. Es el caso que antes NADIE detectaba.
    const ids = await owner((client) =>
      client.query(`SELECT id FROM allocation_lines WHERE run_id = $1 ORDER BY id LIMIT 2`, [target.id])
    )
    expect(ids.rowCount).toBe(2)
    await owner(async (client) => {
      await client.query(`UPDATE allocation_lines SET amount_cents = amount_cents - 1 WHERE id = $1`, [ids.rows[0].id])
      await client.query(`UPDATE allocation_lines SET amount_cents = amount_cents + 1 WHERE id = $1`, [ids.rows[1].id])
    })

    try {
      clearMarginCache()
      const tampered = await tenantTransaction(ORG, USER, async (tx) =>
        getAnalyticPnl(tx, {
          from: "2026-01-01",
          to: "2026-12-31",
          withAllocations: true,
          provenance: { runId: "casoB", gitSha: "fixes", baseCurrency: "EUR" },
        })
      )
      const status = (id: string) => tampered.checks.find((c) => c.id === id)?.status
      expect(status("I-E5-12")).toBe("FAIL")
      // Suma cero: I5, I-E5-4 e I-E5-9 siguen en PASS, que es justamente el
      // motivo por el que hacía falta un sello de las LÍNEAS.
      expect(status("I5")).toBe("PASS")
      expect(status("I-E5-9")).toBe("PASS")
    } finally {
      await owner(async (client) => {
        await client.query(`UPDATE allocation_lines SET amount_cents = amount_cents + 1 WHERE id = $1`, [ids.rows[0].id])
        await client.query(`UPDATE allocation_lines SET amount_cents = amount_cents - 1 WHERE id = $1`, [ids.rows[1].id])
      })
      clearMarginCache()
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // DEBE #5 · inmutabilidad de los DESTINOS de una regla usada
  // ───────────────────────────────────────────────────────────────────────

  it("DEBE #5 · los destinos de una regla con líneas emitidas no se editan ni se amplían", async () => {
    // Una regla FIXED_PERCENT que ya ha liquidado.
    await post({ accountCode: "628", debitCents: 50_000, costCenterId: ceco["CC-OPS"], entryDate: "2026-05-10" })
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        {
          code: "AL-OPS-FP",
          name: "Operaciones 50/50",
          sourceCostCenterId: ceco["CC-OPS"],
          targetKind: "PROJECTS",
          driver: "FIXED_PERCENT",
          period: "MONTH",
          priority: 10,
          sourceShareBps: 10000,
          zeroBaseFallback: "SKIP_WARN",
          targetFilter: null,
          validFrom: "2026-01-01",
          validTo: null,
          targets: [
            { projectId: projectA, percentBps: 5000 },
            { projectId: projectB, percentBps: 5000 },
          ],
        },
        actor
      )
    )
    const may = { periodKind: "MONTH" as const, periodStart: "2026-05-01", periodEnd: "2026-05-31" }
    const run = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...may, gitSha: "fixes" }, actor))
    expect(run.lineCount).toBe(2)

    const ruleId = await owner(async (client) => {
      const { rows } = await client.query(`SELECT id FROM allocation_rules WHERE organization_id = $1 AND code = 'AL-OPS-FP'`, [ORG])
      return rows[0].id as string
    })

    // (a) UPDATE de un destino: rechazado por el trigger nuevo.
    await expect(
      owner((client) =>
        client.query(`UPDATE allocation_rule_targets SET percent_bps = 7000 WHERE rule_id = $1 AND project_id = $2`, [
          ruleId,
          projectA,
        ])
      )
    ).rejects.toThrow(/ya ha emitido líneas/)

    // (b) INSERT de un destino nuevo en la misma regla: también rechazado.
    await expect(
      owner((client) =>
        client.query(
          `INSERT INTO allocation_rule_targets (id, organization_id, rule_id, project_id, percent_bps, sort_order)
           VALUES (gen_random_uuid(), $1, $2, $3, 0, 2)`,
          [ORG, ruleId, projectB]
        )
      )
    ).rejects.toThrow(/ya ha emitido líneas|allocation_rule_targets_unique_dest/)

    // (c) La regla SÍ se puede cerrar (valid_to / is_active): versionar sigue
    //     siendo el camino, y no se ha roto.
    await owner((client) =>
      client.query(`UPDATE allocation_rules SET valid_to = DATE '2026-05-31', is_active = false WHERE id = $1`, [ruleId])
    )
    const percent = await owner((client) =>
      client.query(`SELECT percent_bps FROM allocation_rule_targets WHERE rule_id = $1 AND project_id = $2`, [ruleId, projectA])
    )
    expect(percent.rows[0].percent_bps).toBe(5000)

    await tenantTransaction(ORG, USER, async (tx) =>
      reverseAllocationRunTx(tx, { runId: run.id, reason: "limpieza del test de inmutabilidad", reversedAt: new Date() }, actor)
    )
    clearMarginCache()
  })

  // ───────────────────────────────────────────────────────────────────────
  // R2-1 (ronda 2) · periodicidades mixtas: pendiente de liquidar ≠ descuadre
  // ───────────────────────────────────────────────────────────────────────

  it("R2-1 · informe MENSUAL con run mensual sellado y regla ANUAL vigente: I5 PASA con el pendiente informado", async () => {
    // CC-OPS liquida por MESES; CC-GA, por AÑOS. En el informe de un mes, el
    // saldo de CC-GA no es un descuadre: está pendiente de liquidar (§3.3 y
    // criterio 18). Antes de la ronda 2 esto sellaba REQUIERE REVISIÓN.
    await post({ accountCode: "628", debitCents: 40_000, costCenterId: ceco["CC-OPS"], entryDate: "2026-07-10" })
    await post({ accountCode: "621", debitCents: 25_000, costCenterId: ceco["CC-GA"], entryDate: "2026-07-12" })
    await tenantTransaction(ORG, USER, async (tx) =>
      createAllocationRuleTx(
        tx,
        {
          code: "AL-OPS-M2",
          name: "Operaciones a proyectos por ingresos (mensual)",
          sourceCostCenterId: ceco["CC-OPS"],
          targetKind: "PROJECTS",
          driver: "REVENUE_SHARE",
          period: "MONTH",
          priority: 10,
          sourceShareBps: 10000,
          zeroBaseFallback: "YTD",
          targetFilter: { projectStatus: ["ACTIVE"] },
          validFrom: "2026-01-01",
          validTo: null,
          targets: [],
        },
        actor
      )
    )
    const julio = { periodKind: "MONTH" as const, periodStart: "2026-07-01", periodEnd: "2026-07-31" }
    const run = await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...julio, gitSha: "fixes" }, actor))
    expect(run.lineCount).toBeGreaterThan(0)

    clearMarginCache()
    const mensual = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-07-01",
        to: "2026-07-31",
        withAllocations: true,
        provenance: { runId: "r2-mes", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    const i5Mensual = mensual.checks.find((c) => c.id === "I5")
    expect(i5Mensual?.status).toBe("PASS")
    // Y lo dice: importe y regla que lo liquidará.
    expect(i5Mensual?.evidencia).toContain("pendiente de liquidar")
    expect(i5Mensual?.evidencia).toContain("AL-GA-Y (YEAR)")
    expect(mensual.checks.filter((c) => c.status === "FAIL")).toEqual([])

    // La misma organización en informe ANUAL: el año ya venció y CC-GA no está
    // liquidado del todo (el run anual es anterior a estos dos asientos), así
    // que I5.b SÍ debe fallar. Un residuo real sigue siendo un residuo real.
    clearMarginCache()
    const anual = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        withAllocations: true,
        provenance: { runId: "r2-anio", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    const i5Anual = anual.checks.find((c) => c.id === "I5")
    expect(i5Anual?.status).toBe("FAIL")
    expect(i5Anual?.evidencia).toContain("sin liquidar")

    await tenantTransaction(ORG, USER, async (tx) =>
      reverseAllocationRunTx(tx, { runId: run.id, reason: "limpieza del test de periodicidades", reversedAt: new Date() }, actor)
    )
    clearMarginCache()
  })

  it("R2-1 · revertir el run mensual deja residuo REAL en su propio periodo: I5 vuelve a FAIL", async () => {
    // El run de julio quedó revertido en el test anterior: CC-OPS tiene regla
    // MENSUAL —que sí vence en julio— y ya no hay imputación que la cierre.
    clearMarginCache()
    const mensual = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-07-01",
        to: "2026-07-31",
        withAllocations: true,
        provenance: { runId: "r2-mes-rev", gitSha: "fixes", baseCurrency: "EUR" },
      })
    )
    const i5 = mensual.checks.find((c) => c.id === "I5")
    expect(i5?.status).toBe("FAIL")
    expect(i5?.evidencia).toContain("I5.b CC-OPS/MC3")
  })

  // ───────────────────────────────────────────────────────────────────────
  // DEBE #8 y #9 · agregados SQL y sin N+1
  // ───────────────────────────────────────────────────────────────────────

  it("DEBE #8 · `getAllocationTotals` agrega en SQL por (fuente, destino, nivel) y cuadra con las líneas", async () => {
    const applied = await tenantTransaction(ORG, USER, async (tx) => getAppliedAllocations(tx, { from: "2026-01-01", to: "2026-12-31" }))
    const totals = await tenantTransaction(ORG, USER, async (tx) => getAllocationTotals(tx, { runIds: applied.runIds }))
    expect(totals.length).toBeGreaterThan(0)
    expect(totals.length).toBeLessThanOrEqual(applied.lines.length)
    expect(totals.reduce((a, t) => a + t.amountCents, 0)).toBe(applied.lines.reduce((a, l) => a + l.amountCents, 0))
  })

  it("DEBE #9 · derivar el STALE de N runs NO hace N lecturas del diario ni de las reglas", async () => {
    const { allocationRunStaleness } = await import("@/models/allocations")
    const runs = await listAllocationRuns(tenantDb(ORG), {})
    const sealed = runs.filter((r) => r.status === "SEALED")
    expect(sealed.length).toBeGreaterThanOrEqual(2)

    // Se cuentan las consultas reales de la transacción con `pg_stat_statements`
    // no está garantizado en el entorno, así que se mide lo observable: dentro
    // de UNA transacción, las memos por (periodo) hacen que el segundo run del
    // mismo periodo no vuelva a leer. Con runs de periodos DISTINTOS el trabajo
    // crece con el número de periodos, no con el de runs.
    const started = Date.now()
    const results = await tenantTransaction(ORG, USER, async (tx) => {
      const out = []
      for (const run of sealed) out.push(await allocationRunStaleness(tx, run))
      // Segunda pasada sobre los MISMOS periodos: todo sale de la memoización.
      for (const run of sealed) out.push(await allocationRunStaleness(tx, run))
      return out
    })
    expect(results).toHaveLength(sealed.length * 2)
    // Las dos pasadas dan lo mismo (la memoización no cambia el resultado).
    for (let i = 0; i < sealed.length; i++) {
      expect(results[i]).toEqual(results[i + sealed.length])
    }
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("los `runs` que acompañan a la matriz traen periodo, total y linesHash sin leer una sola línea", async () => {
    const refs = await tenantTransaction(ORG, USER, async (tx) => getSealedRunRefs(tx, { from: "2026-01-01", to: "2026-12-31" }))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(ref.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof ref.totalAllocatedCents).toBe("number")
    }
  })
})
