import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · **ronda 1 de corrección** — los hallazgos del auditor y de QA que sólo
 * se demuestran con la base delante.
 *
 *  · **H-1 (GRAVE)** — los dieciocho `I-E10-*` eran código muerto: nadie
 *    rellenaba los bloques `budget` / `time` de `runInvariants`. Aquí se
 *    comprueba que **aparecen los dieciocho** sobre datos reales y que las
 *    **tres inyecciones del auditor** dan FAIL *en el producto*:
 *      (a) un céntimo alterado en una línea de una versión SELLADA → I-E10-6,
 *      (b) una `driverBase` manipulada en `allocation_lines`      → I-E10-3,
 *      (c) un parte APROBADO retocado por SQL                     → I-E10-3/17.
 *    Antes de esta ronda, ninguna de las tres la podía ver el producto.
 *  · **H-2 / H-3 y BLOQUEA 3** — `budgetHash` sin `valid_to` y CON las líneas de
 *    horas: I-E10-6 **PASS sobre datos íntegros tras sellar la REV1** (que es
 *    justo cuando la BASE recibe su `validTo`), y FAIL con un céntimo cambiado.
 *  · **H-4** — el CHECK de signo sólo admite la excepción en una cuenta de
 *    familia con excepción declarada.
 *  · **QA BUG-E10-2** — un parte aprobado se borra **sólo** desde el vaciado de
 *    operador, con el GUC registrado y verificado.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { getAnalyticsConfig, seedAnalyticsDefaults } = await import("@/models/analytics")
const { createAllocationRuleTx, previewAllocationRun, sealAllocationRunTx } = await import("@/models/allocations")
const { approveTimeEntriesTx, correctTimeEntryTx, createTimeEntriesTx } = await import("@/models/time")
const { createEmployeeTx, createEmployeeRateTx } = await import("@/models/employees")
const { createBudgetVersionTx, sealBudgetTx, upsertBudgetCellsTx, upsertBudgetHoursTx } = await import(
  "@/models/budget"
)
const { marginConfigHash } = await import("@/lib/analytics/hash")

const ORG = "e1010000-0000-4000-8000-00000000000a"
const USER = "e1010000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const REF = "2026-12-31"
type BudgetCellProvenanceRow = {
  metrica: string
  registros_origen: Record<string, string>
}

const REGULARIZATION_ENTRY = "e1010000-0000-4000-8000-0000000000e1"
const YEAR = { periodKind: "YEAR" as const, periodStart: "2026-01-01" as const, periodEnd: "2026-12-31" as const }

const E10_IDS = [
  "I-E10-1", "I-E10-2", "I-E10-3", "I-E10-4", "I-E10-5", "I-E10-6",
  "I-E10-7", "I-E10-8", "I-E10-9", "I-E10-10", "I-E10-11", "I-E10-12",
  "I-E10-13", "I-E10-14", "I-E10-15", "I-E10-16", "I-E10-17", "I-E10-18",
]

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · ronda 1 (auditoría H-1…H-4 y QA BUG-E10-2)", () => {
  const ceco: Record<string, string> = {}
  let projectA = ""
  let projectB = ""
  let fiscalYearId = ""
  let employeeId = ""
  let baseBudgetId = ""
  let rev1BudgetId = ""
  let approvedEntryId = ""
  let sealedRunId = ""
  let secondRunId = ""
  let configHash = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e10-ronda1@test.local", name: "E10 ronda 1" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e10-ronda1", name: "E10 ronda 1", pgcVariant: "PYMES", updatedAt: new Date() },
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
      await createEmployeeRateTx(
        tx,
        { employeeId, hourlyCostCents: 3_000, basis: "COSTE_EMPRESA_CON_SS", validFrom: "2026-01-01" },
        actor
      )
    })

    await post({ accountCode: "705", creditCents: 1_200_000, projectId: projectA })
    await post({ accountCode: "705", creditCents: 800_000, projectId: projectB })
    await post({ accountCode: "640", debitCents: 300_000, costCenterId: ceco["CC-GA"] })

    // Partes: 720 min aprobados en P-01 y 480 en P-02 (base del driver HORAS).
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      createTimeEntriesTx(
        tx,
        [
          { employeeId, date: "2026-11-03", projectId: projectA, minutes: 720 },
          { employeeId, date: "2026-11-04", projectId: projectB, minutes: 480 },
        ],
        actor
      )
    )
    approvedEntryId = created.ids[0]
    await tenantTransaction(ORG, USER, async (tx) =>
      approveTimeEntriesTx(tx, { ids: created.ids, approvedAt: new Date("2026-11-05"), actorIsAdmin: true }, actor)
    )

    // Un run de liquidación SELLADO con driver HORAS: es lo que I-E10-3 y
    // I-E10-17 vigilan, y sin él las dos inyecciones (b) y (c) no tendrían nada
    // que delatar.
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
          priority: 10,
          sourceShareBps: 10_000,
          zeroBaseFallback: "SKIP_WARN",
          targetFilter: { projectStatus: ["ACTIVE"] },
          validFrom: "2026-01-01",
          validTo: null,
          targets: [],
        } as never,
        actor
      )
    })
    await tenantTransaction(ORG, USER, async (tx) => {
      const preview = await previewAllocationRun(tx, YEAR)
      if (preview.result.lines.length === 0) {
        throw new Error(`el run no reparte nada: ${JSON.stringify(preview.result.warnings)}`)
      }
      sealedRunId = (await sealAllocationRunTx(tx, { ...YEAR, gitSha: "ronda1" }, actor)).id
    })

    // **Re-auditoría, punto 4.** Un SEGUNDO run sellado con driver de actividad,
    // con la MISMA ventana y el mismo `timeHash` que el primero. No es adorno:
    // I-E10-17 recorre `time.runs` entero, y con un solo run el test no podía
    // distinguir «los comprueba todos» de «comprueba el último». Con dos, un
    // parte alterado tiene que ponerlos a los DOS en FAIL.
    const primero = await prisma.allocationRun.findFirstOrThrow({ where: { id: sealedRunId } })
    // Va en OTRO periodo (el cuarto trimestre): `allocation_runs_one_sealed_per_period`
    // admite un solo run SEALED por periodo, y con razón. La ventana sellada es
    // la misma —la de la regla anual, que es de actividad—, así que contiene el
    // trimestre y el `timeHash` recomputado sobre ella es el mismo.
    secondRunId = (
      await prisma.allocationRun.create({
        data: {
          organizationId: ORG,
          fiscalYearId,
          periodKind: "QUARTER",
          periodStart: new Date("2026-10-01T00:00:00Z"),
          periodEnd: new Date("2026-12-31T00:00:00Z"),
          status: "SEALED",
          ledgerHash: primero.ledgerHash,
          analyticsHash: primero.analyticsHash,
          rulesHash: primero.rulesHash,
          // Sin sello de SALIDA: el run copiado no tiene líneas, y copiarle el
          // `linesHash` del primero lo dejaría en FAIL permanente por I-E5-12.
          // `NULL` es el caso que I-E5-12 declara INFO (runs sellados antes de
          // que existiera el sello de líneas), que es lo que este run es aquí.
          linesHash: null,
          timeHash: primero.timeHash,
          timeHashWindowStart: primero.timeHashWindowStart,
          timeHashWindowEnd: primero.timeHashWindowEnd,
          gitSha: "ronda1",
        },
      })
    ).id

    // Dos versiones de presupuesto: la BASE de los doce meses y una REV1 PARCIAL
    // desde julio. Al sellar la REV1, `sealBudgetTx` escribe `validTo` en la
    // BASE (O-E10-8) — el instante exacto que hacía irreproducible su hash.
    await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: REF })
      configHash = marginConfigHash(config)
      const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`)

      const base = await createBudgetVersionTx(
        tx,
        { fiscalYearId, scenario: "BASE", name: "Base 2026", validFrom: "2026-01-01" },
        actor
      )
      baseBudgetId = base.id
      await upsertBudgetCellsTx(
        tx,
        {
          budgetId: base.id,
          config,
          cells: months.map((month) => ({
            month,
            accountCode: "705",
            projectId: projectA,
            analyticType: "INGRESO_DIRECTO" as const,
            amountCents: 100_000,
          })),
        },
        actor
      )
      await upsertBudgetHoursTx(
        tx,
        { budgetId: base.id, rows: months.map((month) => ({ month, projectId: projectA, minutes: 6_000 })) },
        actor
      )
      await sealBudgetTx(
        tx,
        { budgetId: base.id, gitSha: "ronda1", marginConfigHash: configHash, sealedAt: new Date("2026-01-02") },
        actor
      )
    })

    await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: REF })
      const h2 = Array.from({ length: 6 }, (_, i) => `2026-${String(i + 7).padStart(2, "0")}-01`)
      const rev1 = await createBudgetVersionTx(
        tx,
        {
          fiscalYearId,
          scenario: "REVISADO",
          name: "Revisión 1",
          validFrom: "2026-07-01",
          partialFrom: "2026-07-01",
        },
        actor
      )
      rev1BudgetId = rev1.id
      await upsertBudgetCellsTx(
        tx,
        {
          budgetId: rev1.id,
          config,
          cells: h2.map((month) => ({
            month,
            accountCode: "705",
            projectId: projectA,
            analyticType: "INGRESO_DIRECTO" as const,
            amountCents: 110_000,
          })),
        },
        actor
      )
      await upsertBudgetHoursTx(
        tx,
        { budgetId: rev1.id, rows: h2.map((month) => ({ month, projectId: projectA, minutes: 6_600 })) },
        actor
      )
      await sealBudgetTx(
        tx,
        { budgetId: rev1.id, gitSha: "ronda1", marginConfigHash: configHash, sealedAt: new Date("2026-07-01") },
        actor
      )
    })
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
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
          description: "Movimiento de la ronda 1 de E10",
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

  const sweep = async () =>
    await runLedgerInvariants(ORG, { refDate: REF, fiscalYearId, gitSha: "ronda1", audit: true, noCache: true })

  const checkOf = (run: Awaited<ReturnType<typeof sweep>>, id: string) =>
    run.validacion.checks.find((c) => c.id === id)

  const i17Evidencia = (run: Awaited<ReturnType<typeof sweep>>): string =>
    checkOf(run, "I-E10-17")?.evidencia ?? ""

  // ───────────────────────────────────────────────────────────────────────
  // H-1 — los dieciocho invariantes EXISTEN en el barrido
  // ───────────────────────────────────────────────────────────────────────

  it("H-1 · el barrido de auditoría emite los DIECIOCHO `I-E10-*`, y no `SIN_EVALUAR`", async () => {
    const run = await sweep()
    const ids = run.validacion.checks.map((c) => c.id)
    for (const id of E10_IDS) expect(ids).toContain(id)

    // Y no son dieciocho INFO de relleno: los que tienen datos se pronuncian.
    for (const id of ["I-E10-1", "I-E10-3", "I-E10-4", "I-E10-6", "I-E10-8", "I-E10-9", "I-E10-10", "I-E10-17"]) {
      expect(checkOf(run, id)?.status, `${id}: ${checkOf(run, id)?.evidencia}`).toBe("PASS")
    }
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────
  // H-2 / H-3 — el sello es reproducible tras relevar, y cubre las horas
  // ───────────────────────────────────────────────────────────────────────

  it("H-2 · sellada la REV1, la BASE tiene `validTo` y su `budgetHash` SIGUE siendo reproducible", async () => {
    const base = await prisma.budget.findFirstOrThrow({ where: { id: baseBudgetId } })
    // El instante que la ronda 0 no soportaba: la BASE se selló con
    // `validTo = NULL` y la REV1 se lo ha escrito en la misma transacción.
    expect(base.validTo?.toISOString().slice(0, 10)).toBe("2026-06-30")

    const run = await sweep()
    const i6 = checkOf(run, "I-E10-6")
    expect(i6?.status, i6?.evidencia).toBe("PASS")
  }, 300_000)

  it("inyección (a) · un céntimo alterado en una versión SELLADA lo caza I-E10-6 EN EL PRODUCTO", async () => {
    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE budget_lines SET amount_cents = amount_cents + 1
          WHERE organization_id = $1::uuid AND budget_id = $2::uuid
            AND id = (SELECT id FROM budget_lines WHERE budget_id = $2::uuid ORDER BY month LIMIT 1)`,
        [ORG, baseBudgetId]
      )
      await client.query(`ALTER TABLE budget_lines ENABLE TRIGGER USER`)
    })
    const run = await sweep()
    const i6 = checkOf(run, "I-E10-6")
    expect(i6?.status).toBe("FAIL")
    expect(run.sello.sello).toBe("REQUIERE REVISIÓN")

    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE budget_lines SET amount_cents = amount_cents - 1
          WHERE organization_id = $1::uuid AND budget_id = $2::uuid
            AND id = (SELECT id FROM budget_lines WHERE budget_id = $2::uuid ORDER BY month LIMIT 1)`,
        [ORG, baseBudgetId]
      )
      await client.query(`ALTER TABLE budget_lines ENABLE TRIGGER USER`)
    })
    expect(checkOf(await sweep(), "I-E10-6")?.status).toBe("PASS")
  }, 300_000)

  it("H-3 · un minuto cambiado en las HORAS de una versión sellada también rompe I-E10-6", async () => {
    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_hours_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE budget_hours_lines SET minutes = minutes + 1
          WHERE organization_id = $1::uuid
            AND id = (SELECT id FROM budget_hours_lines WHERE budget_id = $2::uuid ORDER BY month LIMIT 1)`,
        [ORG, baseBudgetId]
      )
      await client.query(`ALTER TABLE budget_hours_lines ENABLE TRIGGER USER`)
    })
    // Esto es EXACTAMENTE lo que el sello de la ronda 0 no veía: las horas
    // alimentan la liquidación presupuestaria en dry-run, o sea las celdas de
    // MC3 por dimensión del informe.
    expect(checkOf(await sweep(), "I-E10-6")?.status).toBe("FAIL")

    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_hours_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE budget_hours_lines SET minutes = minutes - 1
          WHERE organization_id = $1::uuid
            AND id = (SELECT id FROM budget_hours_lines WHERE budget_id = $2::uuid ORDER BY month LIMIT 1)`,
        [ORG, baseBudgetId]
      )
      await client.query(`ALTER TABLE budget_hours_lines ENABLE TRIGGER USER`)
    })
    expect(checkOf(await sweep(), "I-E10-6")?.status).toBe("PASS")
  }, 300_000)

  it("inyección (b) · una `driverBase` manipulada la caza I-E10-3", async () => {
    await owner(async (client) => {
      await client.query(
        `UPDATE allocation_lines SET driver_base = driver_base + 60
          WHERE organization_id = $1::uuid
            AND id = (SELECT id FROM allocation_lines WHERE organization_id = $1::uuid ORDER BY id LIMIT 1)`,
        [ORG]
      )
    })
    const run = await sweep()
    expect(checkOf(run, "I-E10-3")?.status).toBe("FAIL")

    await owner(async (client) => {
      await client.query(
        `UPDATE allocation_lines SET driver_base = driver_base - 60
          WHERE organization_id = $1::uuid
            AND id = (SELECT id FROM allocation_lines WHERE organization_id = $1::uuid ORDER BY id LIMIT 1)`,
        [ORG]
      )
    })
    expect(checkOf(await sweep(), "I-E10-3")?.status).toBe("PASS")
  }, 300_000)

  it("punto 4 · I-E10-17 compara el `timeHash` de TODOS los runs con driver de actividad", async () => {
    const run = await sweep()
    const i17 = checkOf(run, "I-E10-17")
    expect(i17?.status, i17?.evidencia).toBe("PASS")
    // Dos runs con driver de actividad en el alcance, y los DOS comprobados: la
    // evidencia lo dice con su número, no «el último».
    expect(i17?.evidencia).toContain("2 run(s)")
  }, 300_000)

  it("inyección (c) · un parte APROBADO retocado por SQL rompe la base del reparto y el `timeHash`", async () => {
    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      await client.query(`UPDATE time_entries SET minutes = minutes + 60 WHERE id = $1::uuid`, [approvedEntryId])
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
    })
    const run = await sweep()
    // Dos caminos independientes lo delatan: la base del driver ya no cuadra
    // (I-E10-3) y el `timeHash` recomputado sobre la ventana sellada difiere
    // del sellado (I-E10-17, la cuarta causa de STALE).
    expect(checkOf(run, "I-E10-3")?.status).toBe("FAIL")
    expect(checkOf(run, "I-E10-17")?.status).toBe("FAIL")
    expect(run.sello.sello).toBe("REQUIERE REVISIÓN")

    // El mismo parte pone en FAIL a los DOS runs de actividad, no sólo al
    // último (punto 4 de la re-auditoría): la evidencia nombra los dos.
    expect(i17Evidencia(run)).toContain(sealedRunId)
    expect(i17Evidencia(run)).toContain(secondRunId)

    // Y la cuarta causa de STALE lo dice por el camino del producto, no sólo
    // por el barrido: `allocationRunStaleness` sobre el run sellado.
    const staleness = await tenantTransaction(ORG, USER, async (tx) => {
      const { allocationRunStaleness, listAllocationRuns } = await import("@/models/allocations")
      const runs = await listAllocationRuns(tx, { fiscalYearId })
      const sealed = runs.find((r) => r.id === sealedRunId)
      if (!sealed) throw new Error("el run sellado ha desaparecido")
      return allocationRunStaleness(tx, sealed)
    })
    expect(staleness.isStale).toBe(true)
    expect(staleness.reasons.join(" ")).toMatch(/timeHash|horas/i)

    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      await client.query(`UPDATE time_entries SET minutes = minutes - 60 WHERE id = $1::uuid`, [approvedEntryId])
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
    })
    const clean = await sweep()
    expect(checkOf(clean, "I-E10-3")?.status).toBe("PASS")
    expect(checkOf(clean, "I-E10-17")?.status).toBe("PASS")
  }, 300_000)

  it("inyección (b) · una `allocation_line` de una regla HORAS alterada rompe I5 e I-E5-12", async () => {
    // El sello de SALIDA del run (`linesHash`) y la base liquidable del CECO son
    // dos caminos independientes del que emitió las líneas: mover un céntimo de
    // reparto los rompe a los dos. Con `driverBase` intacta, I-E10-3 no lo ve
    // —mide la BASE, no el importe—, y por eso hacen falta los dos invariantes.
    await owner(async (client) => {
      await client.query(
        `UPDATE allocation_lines SET amount_cents = amount_cents + 100
          WHERE organization_id = $1::uuid AND run_id = $2::uuid
            AND id = (SELECT id FROM allocation_lines WHERE run_id = $2::uuid ORDER BY id LIMIT 1)`,
        [ORG, sealedRunId]
      )
    })
    const run = await sweep()
    const roto = ["I5", "I-E5-12"].filter((id) => checkOf(run, id)?.status === "FAIL")
    expect(roto, JSON.stringify(["I5", "I-E5-12"].map((id) => [id, checkOf(run, id)?.status]))).not.toEqual([])
    expect(run.sello.sello).toBe("REQUIERE REVISIÓN")

    await owner(async (client) => {
      await client.query(
        `UPDATE allocation_lines SET amount_cents = amount_cents - 100
          WHERE organization_id = $1::uuid AND run_id = $2::uuid
            AND id = (SELECT id FROM allocation_lines WHERE run_id = $2::uuid ORDER BY id LIMIT 1)`,
        [ORG, sealedRunId]
      )
    })
    const clean = await sweep()
    for (const id of ["I5", "I-E5-12"]) expect(checkOf(clean, id)?.status, id).not.toBe("FAIL")
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────
  // Re-auditoría · regresión GRAVE — I-E10-12 sobre un ejercicio regularizado
  // ───────────────────────────────────────────────────────────────────────

  it("regresión · el asiento de REGULARIZACIÓN no convierte I-E10-12 en un FAIL permanente", async () => {
    // El asiento de regularización ABONA las 640/642 para llevarlas a la 129.
    // Sin excluir su `entry_kind`, la nómina de diciembre salía NEGATIVA y la
    // guarda leía `0 ≤ −300 000` como un exceso: **todo ejercicio cerrado**
    // quedaba con la familia PRESUPUESTO en FAIL y el periodo en REQUIERE
    // REVISIÓN, con los datos intactos.
    const antes = checkOf(await sweep(), "I-E10-12")
    expect(antes?.status, antes?.evidencia).toBe("PASS")

    await owner(async (client) => {
      await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER USER`)
      await client.query(`ALTER TABLE journal_entries DISABLE TRIGGER USER`)
      await client.query(
        `INSERT INTO journal_entries (id, organization_id, fiscal_year_id, entry_number, entry_date,
                                      description, kind, source_type, entry_hash, posted_by_id, posted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 99001, '2026-12-31'::date,
                 'Regularización de cuentas de gestión (T-24)', 'REGULARIZATION', 'MANUAL',
                 repeat('0', 64), $4::uuid, now())`,
        [REGULARIZATION_ENTRY, ORG, fiscalYearId, USER]
      )
      // Debe 129 / Haber 640: el mismo asiento que cierra el ejercicio.
      await client.query(
        `INSERT INTO journal_lines (id, organization_id, entry_id, line_no, account_code, debit_cents,
                                    credit_cents, entry_date, fiscal_year_id, entry_kind, cost_center_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '129', 300000, 0,
                 '2026-12-31'::date, $3::uuid, 'REGULARIZATION', NULL),
                (gen_random_uuid(), $1::uuid, $2::uuid, 2, '640', 0, 300000,
                 '2026-12-31'::date, $3::uuid, 'REGULARIZATION', $4::uuid)`,
        [ORG, REGULARIZATION_ENTRY, fiscalYearId, ceco["CC-GA"]]
      )
      await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER USER`)
      await client.query(`ALTER TABLE journal_entries ENABLE TRIGGER USER`)
    })

    const conRegularizacion = checkOf(await sweep(), "I-E10-12")
    expect(conRegularizacion?.status, conRegularizacion?.evidencia).toBe("PASS")

    // Y la guarda SIGUE viva: una 640 alterada por SQL para que la nómina
    // contabilizada quede por debajo de lo imputado la caza igual.
    await owner(async (client) => {
      await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE journal_lines SET debit_cents = 0, credit_cents = 400000
          WHERE organization_id = $1::uuid AND account_code = '640' AND entry_kind = 'NORMAL'`,
        [ORG]
      )
      await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER USER`)
    })
    const alterada = checkOf(await sweep(), "I-E10-12")
    expect(alterada?.status, alterada?.evidencia).toBe("FAIL")

    // Y la guarda compara el EJERCICIO, no mes a mes: la evidencia lo nombra con
    // el código del ejercicio, no con un `AAAA-MM`.
    expect(alterada?.evidencia).toContain("2026:")

    await owner(async (client) => {
      await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE journal_lines SET debit_cents = 300000, credit_cents = 0
          WHERE organization_id = $1::uuid AND account_code = '640' AND entry_kind = 'NORMAL'`,
        [ORG]
      )
      await client.query(`DELETE FROM journal_lines WHERE entry_id = $1::uuid`, [REGULARIZATION_ENTRY])
      await client.query(`DELETE FROM journal_entries WHERE id = $1::uuid`, [REGULARIZATION_ENTRY])
      await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER USER`)
    })
    expect(checkOf(await sweep(), "I-E10-12")?.status).toBe("PASS")
  }, 300_000)

  it("residual · con un receptor SIN TARIFA, I-E10-12 sale NO EVALUABLE y nunca PASS", async () => {
    // `costOfTime` deja FUERA del numerador al receptor entero cuando uno de sus
    // partes no tiene tarifa vigente ese día (I-E10-5: jamás 0 ni la anterior).
    // Comparar un numerador al que le falta un receptor contra la nómina
    // COMPLETA es una cota floja **justo donde falta el dato**, y decir PASS ahí
    // es afirmar algo que no se ha comprobado.
    const created = await tenantTransaction(ORG, USER, async (tx) => {
      const empleado = await createEmployeeTx(
        tx,
        { code: "E-SIN-TARIFA", name: "Sin tarifa", defaultCostCenterId: ceco["CC-GA"] },
        actor
      )
      // Ni una `EmployeeRate`: el receptor al que impute queda NO EVALUABLE.
      return createTimeEntriesTx(
        tx,
        [{ employeeId: empleado.id, date: "2026-11-10", projectId: projectA, minutes: 300 }],
        actor
      )
    })
    await tenantTransaction(ORG, USER, async (tx) =>
      approveTimeEntriesTx(tx, { ids: created.ids, approvedAt: new Date("2026-11-11"), actorIsAdmin: true }, actor)
    )

    const i12 = checkOf(await sweep(), "I-E10-12")
    expect(i12?.status, i12?.evidencia).toBe("INFO")
    expect(i12?.evidencia).toContain("NO EVALUABLES")
    // Y NOMBRA al receptor y el motivo: un INFO mudo no sirve para arreglarlo.
    expect(i12?.evidencia).toContain("P-01")
    expect(i12?.evidencia).toContain("TARIFA_AUSENTE")

    // Con el dato puesto, la guarda vuelve a pronunciarse.
    await tenantTransaction(ORG, USER, async (tx) => {
      const empleado = await tx.employee.findFirstOrThrow({ where: { code: "E-SIN-TARIFA" } })
      await createEmployeeRateTx(
        tx,
        { employeeId: empleado.id, hourlyCostCents: 2_000, basis: "COSTE_EMPRESA_CON_SS", validFrom: "2026-01-01" },
        actor
      )
    })
    const conTarifa = checkOf(await sweep(), "I-E10-12")
    expect(conTarifa?.status, conTarifa?.evidencia).toBe("PASS")

    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      await client.query(`DELETE FROM time_entries WHERE id = ANY($1::uuid[])`, [created.ids])
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
      await client.query(`DELETE FROM employee_rates WHERE organization_id = $1::uuid AND employee_id IN
        (SELECT id FROM employees WHERE organization_id = $1::uuid AND code = 'E-SIN-TARIFA')`, [ORG])
      await client.query(`DELETE FROM employees WHERE organization_id = $1::uuid AND code = 'E-SIN-TARIFA'`, [ORG])
    })
    expect(checkOf(await sweep(), "I-E10-12")?.status).toBe("PASS")
  }, 300_000)

  it("residual · el contra-apunte lleva la FECHA DEL ORIGINAL; con otra, la base lo rechaza", async () => {
    // §3, tabla de triggers de M3: «contra-apunte que no case con su original:
    // distinto empleado, DISTINTA FECHA, distinta dimensión». No es formalismo:
    // el parte dice cuándo se TRABAJÓ, y el techo diario agregado por
    // (empleado, día) sólo netea si el par comparte día. El fixture sellado
    // fechaba el suyo tres días después y la base lo habría rechazado: el
    // contrato y el producto decían cosas distintas (fixture v1.3).
    const original = await prisma.timeEntry.findFirstOrThrow({
      where: { id: approvedEntryId },
      select: { id: true, date: true, employeeId: true, projectId: true },
    })
    const dia = original.date.toISOString().slice(0, 10)

    // Por SQL, con OTRA fecha: la base lo rechaza. (Por la acción no se puede
    // ni intentar: `correctTimeEntryTx` copia la fecha del original, que es la
    // barrera 1; ésta es la barrera 2.)
    await owner(async (client) => {
      await expect(
        client.query(
          `INSERT INTO time_entries (id, organization_id, employee_id, date, project_id, business_line_id,
                                     minutes, productive, status, source, corrects_entry_id, correction_reason)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '2026-11-30'::date, $3::uuid,
                   (SELECT business_line_id FROM projects WHERE id = $3::uuid), -60,
                   true, 'BORRADOR', 'MANUAL', $4::uuid, 'Corrección con fecha distinta')`,
          [ORG, original.employeeId, original.projectId, original.id]
        )
      ).rejects.toThrow(/no casa con el parte/)
    })

    // Con la fecha del original —la que el modelo copia— entra.
    const contra = await tenantTransaction(ORG, USER, async (tx) =>
      correctTimeEntryTx(
        tx,
        {
          entryId: original.id,
          minutes: -60,
          reason: "Corrección de imputación del parte",
          approvedAt: new Date("2026-11-20"),
        },
        actor
      )
    )
    const fila = await prisma.timeEntry.findFirstOrThrow({ where: { id: contra.id } })
    expect(fila.date.toISOString().slice(0, 10)).toBe(dia)

    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      await client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [contra.id])
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
    })
  }, 300_000)

  it("ronda 3 · un reparto por HORAS de un CECO con 628 NO cuenta como personal imputado", async () => {
    // El auditor de la ronda 3: `imputado` contaba **toda** `allocation_line` de
    // una regla con driver `HOURS`, y el driver dice CÓMO se reparte un saldo,
    // no QUÉ es: el de `CC-OPS` lleva su 628 de suministros además de la nómina.
    // Con una regla mensual repartiendo un saldo que es 628 puro, la guarda daba
    // FAIL sobre datos íntegros con la regla del propio diseño.
    await post({ accountCode: "628", debitCents: 900_000, costCenterId: ceco["CC-OPS"] })
    await tenantTransaction(ORG, USER, async (tx) => {
      await createAllocationRuleTx(
        tx,
        {
          code: "AL-OPS-M",
          name: "Operaciones a proyectos por horas, mensual",
          sourceCostCenterId: ceco["CC-OPS"],
          targetKind: "PROJECTS",
          driver: "HOURS",
          period: "MONTH",
          priority: 5,
          sourceShareBps: 10_000,
          zeroBaseFallback: "SKIP_WARN",
          targetFilter: { projectStatus: ["ACTIVE"] },
          validFrom: "2026-01-01",
          validTo: null,
          targets: [],
        } as never,
        actor
      )
    })
    const FEBRERO = { periodKind: "MONTH" as const, periodStart: "2026-02-01", periodEnd: "2026-02-28" }
    await tenantTransaction(ORG, USER, async (tx) => {
      await sealAllocationRunTx(tx, { ...FEBRERO, gitSha: "ronda3" }, actor)
    })

    // Con el run mensual de `HORAS` sellado y 900 000 c de 628 repartidos a
    // proyectos, I-E10-12 sigue en PASS: lo imputado por PERSONAL son los
    // 60 000 c de horas valoradas a tarifa, muy por debajo de los 300 000 c
    // de 64x del ejercicio.
    const run = await sweep()
    const i12 = checkOf(run, "I-E10-12")
    expect(i12?.status, i12?.evidencia).toBe("PASS")

    await owner(async (client) => {
      await client.query(`DELETE FROM allocation_lines WHERE organization_id = $1::uuid AND run_id IN
        (SELECT id FROM allocation_runs WHERE organization_id = $1::uuid AND period_kind = 'MONTH')`, [ORG])
      await client.query(
        `DELETE FROM allocation_runs WHERE organization_id = $1::uuid AND period_kind = 'MONTH'`,
        [ORG]
      )
      await client.query(`DELETE FROM allocation_rule_targets WHERE organization_id = $1::uuid AND rule_id IN
        (SELECT id FROM allocation_rules WHERE organization_id = $1::uuid AND code = 'AL-OPS-M')`, [ORG])
      await client.query(`DELETE FROM allocation_rules WHERE organization_id = $1::uuid AND code = 'AL-OPS-M'`, [ORG])
      await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER USER`)
      await client.query(
        `DELETE FROM journal_lines WHERE organization_id = $1::uuid AND entry_id IN
           (SELECT entry_id FROM journal_lines WHERE organization_id = $1::uuid AND account_code = '628')`,
        [ORG]
      )
      await client.query(
        `DELETE FROM journal_entries WHERE organization_id = $1::uuid AND id NOT IN
           (SELECT DISTINCT entry_id FROM journal_lines WHERE organization_id = $1::uuid)`,
        [ORG]
      )
      await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER USER`)
    })
    expect(checkOf(await sweep(), "I-E10-12")?.status).toBe("PASS")
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────
  // Re-auditoría · punto 3 — la provenance por celda REPRODUCE la celda
  // ───────────────────────────────────────────────────────────────────────

  it("punto 3 · las consultas de una celda de MC3 devuelven filas cuya Σ es la celda", async () => {
    // La ronda 1 dejó la provenance por celda con dos errores hermanos: filtraba
    // por los tipos DEL NIVEL —y la matriz es ACUMULATIVA, así que MC3 devolvía
    // 0 filas— y fijaba una celda anual a `month = '<año>-01-01'`. Una
    // provenance que devuelve cero filas sobre una celda con importe es peor que
    // ninguna: dice que no hay origen.
    const { budgetVsActual } = await import("@/models/reports")
    const view = await budgetVsActual(ORG, {
      fiscalYearId,
      periodStart: "2026-01-01",
      periodEnd: REF,
      granularity: "YTD",
      withAllocations: false,
      actor,
      noCache: true,
    })
    const stored = await prisma.reportRun.findFirstOrThrow({
      where: { id: view.runId },
      select: { provenance: true },
    })
    const byCell = (stored.provenance as { byCell: BudgetCellProvenanceRow[] }).byCell
    expect(byCell.length).toBeGreaterThan(0)

    const celda = byCell.find((c) => c.metrica === "desviacion.mc3.PROJ:P-01.periodo")
    expect(celda, `celdas: ${byCell.map((c) => c.metrica).slice(0, 12).join(", ")}`).toBeTruthy()
    if (!celda) return
    const cell = view.result.variance.find((v) => v.level === "MC3" && v.column === "PROJ:P-01")
    expect(cell).toBeTruthy()
    if (!cell) return

    // Las consultas se EJECUTAN, no se leen: la Σ del aporte de las líneas que
    // devuelven tiene que ser la celda, al céntimo.
    const sumaReal = await owner(async (client) => {
      const { rows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(credit_cents - debit_cents), 0)::text AS total
           FROM journal_lines WHERE id IN (${celda.registros_origen.real})`
      )
      return Number(rows[0].total)
    })
    expect(sumaReal).toBe(cell.actualCents)

    const sumaPresupuesto = await owner(async (client) => {
      const { rows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
           FROM budget_lines WHERE id IN (${celda.registros_origen.presupuesto})`
      )
      return Number(rows[0].total)
    })
    expect(sumaPresupuesto).toBe(cell.budgetCents)

    // Y el nivel base sigue cuadrando: la corrección no rompe lo que ya iba.
    const ingresos = byCell.find((c) => c.metrica === "desviacion.ingresos.PROJ:P-01.periodo")
    expect(ingresos).toBeTruthy()
    if (!ingresos) return
    const celdaIngresos = view.result.variance.find((v) => v.level === "INGRESOS" && v.column === "PROJ:P-01")
    const sumaIngresos = await owner(async (client) => {
      const { rows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(credit_cents - debit_cents), 0)::text AS total
           FROM journal_lines WHERE id IN (${ingresos.registros_origen.real})`
      )
      return Number(rows[0].total)
    })
    expect(sumaIngresos).toBe(celdaIngresos?.actualCents)
  }, 300_000)

  it("punto 3-bis · con imputaciones, la consulta `horas` devuelve los minutos presupuestados de la celda", async () => {
    const { budgetVsActual } = await import("@/models/reports")
    const view = await budgetVsActual(ORG, {
      fiscalYearId,
      periodStart: "2026-01-01",
      periodEnd: REF,
      granularity: "YTD",
      withAllocations: true,
      actor,
      noCache: true,
    })
    const stored = await prisma.reportRun.findFirstOrThrow({
      where: { id: view.runId },
      select: { provenance: true },
    })
    const byCell = (stored.provenance as { byCell: BudgetCellProvenanceRow[] }).byCell
    const celda = byCell.find((c) => c.metrica === "desviacion.mc3.PROJ:P-01.periodo")
    expect(celda).toBeTruthy()
    if (!celda) return
    expect(Object.keys(celda.registros_origen).sort()).toEqual(["horas", "imputado", "presupuesto", "real"])

    // Los minutos que el dry-run de O-E10-4 usó como base para llegar a esta
    // celda: 6 000/mes en enero-junio (BASE) y 6 600 en julio-diciembre (REV1).
    const minutos = await owner(async (client) => {
      const { rows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(minutes), 0)::text AS total
           FROM budget_hours_lines WHERE id IN (${celda.registros_origen.horas})`
      )
      return Number(rows[0].total)
    })
    expect(minutos).toBe(6_000 * 6 + 6_600 * 6)
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────
  // H-4 — el CHECK de signo mira la familia de la cuenta
  // ───────────────────────────────────────────────────────────────────────

  it("H-4 · `sign_exception` NO salva una `640` en positivo; sí una `706`", async () => {
    const insert = (accountCode: string, amountCents: number) =>
      owner(async (client) => {
        await client.query(`ALTER TABLE budget_lines DISABLE TRIGGER USER`)
        try {
          await client.query(
            `INSERT INTO budget_lines
               (id, organization_id, budget_id, month, account_code, project_id, analytic_type,
                margin_level, amount_cents, sign_exception, source)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '2026-03-01'::date, $3, $4::uuid,
                     'COSTE_DIRECTO_MC2'::analytic_type, 'MC2'::margin_level, $5, true, 'MANUAL')`,
            [ORG, rev1BudgetId, accountCode, projectA, amountCents]
          )
        } finally {
          await client.query(`ALTER TABLE budget_lines ENABLE TRIGGER USER`)
        }
      })

    // La línea del auditor: `640` de +123 456 c con la bandera puesta. La
    // aplicación ya la rechazaba (`WRONG_SIGN`); ahora la base también.
    await expect(insert("640", 123_456)).rejects.toThrow(/budget_lines_sign_by_type/)

    // Y la excepción sigue siendo posible donde está DECLARADA: un rappel
    // (`706`) con signo contrario es legítimo.
    await expect(insert("706", 123_456)).resolves.toBeUndefined()
    await owner(async (client) => {
      await client.query(`ALTER TABLE budget_lines DISABLE TRIGGER USER`)
      await client.query(`DELETE FROM budget_lines WHERE organization_id = $1::uuid AND account_code = '706'`, [ORG])
      await client.query(`ALTER TABLE budget_lines ENABLE TRIGGER USER`)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // QA BUG-E10-2 — el borrado de operador, registrado y verificado
  // ───────────────────────────────────────────────────────────────────────

  describe("QA BUG-E10-2 · borrado de un parte APROBADO", () => {
    const maintenanceUrl = process.env.DATABASE_URL_MAINTENANCE_TEST ?? "postgresql://app_maintenance:app_maintenance@localhost:5432/erp_test"
    const runtimeUrl = process.env.DATABASE_URL_RUNTIME_TEST ?? "postgresql://app_runtime:app_runtime@localhost:5432/erp_test"

    async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
      const client = new Client({ connectionString: url })
      await client.connect()
      try {
        return await fn(client)
      } finally {
        await client.end()
      }
    }

    async function seedApproved(): Promise<string> {
      const created = await tenantTransaction(ORG, USER, async (tx) =>
        createTimeEntriesTx(tx, [{ employeeId, date: "2026-10-06", projectId: projectB, minutes: 120 }], actor)
      )
      await tenantTransaction(ORG, USER, async (tx) =>
        approveTimeEntriesTx(
          tx,
          { ids: created.ids, approvedAt: new Date("2026-10-07"), actorIsAdmin: true },
          actor
        )
      )
      return created.ids[0]
    }

    it("sin el GUC, ni `app_maintenance` puede borrarlo: se contra-apunta (I-E10-4)", async () => {
      const id = await seedApproved()
      await withClient(maintenanceUrl as string, async (client) => {
        await expect(client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])).rejects.toThrow(
          /está aprobado: no se borra/
        )
      })
      // Y el camino del producto tampoco, con GUC o sin él: `app_runtime` no es
      // operador. Se comprueba con el GUC PUESTO, que es el flanco que importa.
      await withClient(runtimeUrl as string, async (client) => {
        await client.query("BEGIN")
        await client.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
        await client.query(`SELECT set_config('app.maintenance_reset_org', $1, true)`, [ORG])
        await expect(client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])).rejects.toThrow()
        await client.query("ROLLBACK")
      })
      // Sigue vivo.
      expect(await prisma.timeEntry.count({ where: { id } })).toBe(1)
    })

    it("con el GUC de la MISMA organización y desde `app_maintenance`, el vaciado lo borra", async () => {
      const id = await seedApproved()
      await withClient(maintenanceUrl as string, async (client) => {
        await client.query("BEGIN")
        // Otra organización en el GUC no vale: el trigger compara contra la
        // `organization_id` de la fila.
        await client.query(`SET LOCAL app.maintenance_reset_org = '00000000-0000-4000-8000-000000000000'`)
        await expect(client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])).rejects.toThrow(
          /está aprobado: no se borra/
        )
        await client.query("ROLLBACK")

        await client.query("BEGIN")
        await client.query(`SET LOCAL app.maintenance_reset_org = '${ORG}'`)
        const res = await client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])
        expect(res.rowCount).toBe(1)
        await client.query("COMMIT")
      })
      expect(await prisma.timeEntry.count({ where: { id } })).toBe(0)
    })

    it("el GUC muere con la transacción: fuera de ella vuelve a ser NULL", async () => {
      const id = await seedApproved()
      await withClient(maintenanceUrl as string, async (client) => {
        await client.query("BEGIN")
        await client.query(`SET LOCAL app.maintenance_reset_org = '${ORG}'`)
        await client.query("ROLLBACK")
        const { rows } = await client.query(`SELECT app.maintenance_reset_org() AS org`)
        expect(rows[0].org).toBeNull()
        await expect(client.query(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])).rejects.toThrow(
          /está aprobado: no se borra/
        )
      })
    })
  })
})
