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
const { approveTimeEntriesTx, createTimeEntriesTx } = await import("@/models/time")
const { createEmployeeTx, createEmployeeRateTx } = await import("@/models/employees")
const { createBudgetVersionTx, sealBudgetTx, upsertBudgetCellsTx, upsertBudgetHoursTx } = await import(
  "@/models/budget"
)
const { marginConfigHash } = await import("@/lib/analytics/hash")

const ORG = "e1010000-0000-4000-8000-00000000000a"
const USER = "e1010000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const REF = "2026-12-31"
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
      await sealAllocationRunTx(tx, { ...YEAR, gitSha: "ronda1" }, actor)
    })

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

    await owner(async (client) => {
      await client.query(`ALTER TABLE time_entries DISABLE TRIGGER USER`)
      await client.query(`UPDATE time_entries SET minutes = minutes - 60 WHERE id = $1::uuid`, [approvedEntryId])
      await client.query(`ALTER TABLE time_entries ENABLE TRIGGER USER`)
    })
    const clean = await sweep()
    expect(checkOf(clean, "I-E10-3")?.status).toBe("PASS")
    expect(checkOf(clean, "I-E10-17")?.status).toBe("PASS")
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
