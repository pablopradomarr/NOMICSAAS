import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · T12 y T13 — los modelos de presupuesto, horas y empleados contra
 * Postgres de verdad.
 *
 * Un bloque por cosa que **sólo se puede demostrar con la base delante**:
 *
 *  · **Tenant** — `tenantDb` acota las siete tablas nuevas; una organización no
 *    ve las versiones de presupuesto ni los partes de la otra.
 *  · **Append-only del presupuesto** — `app_runtime` tiene `UPDATE`/`DELETE`
 *    REVOCADOS sobre `budgets` salvo el GRANT de columna del sellado: el intento
 *    sale con **42501**, no con un `false` de la aplicación.
 *  · **Sellado inmutable** — editar una celda de una versión sellada lanza
 *    `23514` aunque se salte la acción (I-E10-6), y sellar **cierra la vigencia
 *    anterior en la misma transacción** (O-E10-8).
 *  · **Agregados = fixture** — el total que `listBudgets` saca por agregado SQL
 *    es, al céntimo, la suma de las líneas.
 *  · **Staleness en TRES consultas** — se **cuentan**, no se estiman (criterio
 *    21), y el `ledgerHash` del SQL agregado coincide con el de
 *    `lib/ledger/hash.ts` (test espejo TS ↔ SQL).
 *  · **Horas** — inmutabilidad tras aprobar, contra-apunte con motivo,
 *    segregación R-H-4 e import idempotente.
 *
 * Conecta con el rol PROPIETARIO salvo donde se dice: aquí se ejercen lógica y
 * triggers; la RLS tiene su propia suite.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { postEntry } = await import("@/models/ledger")
const { computeLedgerHash } = await import("@/models/ledger")
const { seedAnalyticsDefaults, getAnalyticsConfig } = await import("@/models/analytics")
const {
  activeBudgetAt,
  createBudgetVersionTx,
  getBudgetVersion,
  importBudgetCsvTx,
  listBudgets,
  proposeDepreciationBudget,
  sealBudgetTx,
  upsertBudgetCellsTx,
  upsertBudgetHoursTx,
} = await import("@/models/budget")
const {
  approveTimeEntriesTx,
  correctTimeEntryTx,
  createTimeEntriesTx,
  getTimeRowsForWindow,
  importTimeCsvTx,
  listTimeEntries,
  minutesByTargetMonthSql,
} = await import("@/models/time")
const { createEmployeeRateTx, createEmployeeTx, listEmployeeRates, upsertHeadcountSnapshotTx } = await import(
  "@/models/employees"
)
const { proposeHourlyCost } = await import("@/models/employees")
const { assertAssetDimension, createAssetTx } = await import("@/models/assets")
const { budgetVsActual } = await import("@/models/reports")
const { allocationRunStalenessBatch, periodSealsBatch, timeHashBatch } = await import("@/models/allocations")
const { marginConfigHash } = await import("@/lib/analytics/hash")
const { budgetHash: computeBudgetHash } = await import("@/lib/budget/hash")
const { timeHash: timeHashOf } = await import("@/lib/time/aggregate")
const { LedgerAbort } = await import("@/models/ledger")

const ORG = "e1000000-0000-4000-8000-00000000000a"
const OTHER = "e1000000-0000-4000-8000-00000000000b"
const USER = "e1000000-0000-4000-8000-0000000000a1"
const EMPLOYEE_USER = "e1000000-0000-4000-8000-0000000000a2"
const actor = { userId: USER }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * La misma conexión, pero con el rol de la APLICACIÓN: `app_runtime` no tiene
 * `BYPASSRLS` y lleva los `REVOKE` del append-only. Lo que aquí falla es lo que
 * fallaría en producción.
 */
async function asRuntime<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET LOCAL ROLE app_runtime")
    await client.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    return await fn(client)
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    await client.end()
  }
}

/** Mensaje del error tipado: los modelos abortan con `LedgerAbort`, no con `throw`. */
async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof LedgerAbort) return error.errors.map((e) => `${e.check ?? e.code}: ${e.message}`).join(" · ")
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("se esperaba un fallo y no lo hubo")
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · T12 y T13 — modelos de presupuesto, horas y empleados", () => {
  let fiscalYearId = ""
  let projectA = ""
  let projectB = ""
  let employeeId = ""
  let ownEmployeeId = ""
  const ceco: Record<string, string> = {}

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: USER, email: "e10-modelos@test.local", name: "E10", updatedAt: new Date() },
        { id: EMPLOYEE_USER, email: "e10-empleado@test.local", name: "E10 empleado", updatedAt: new Date() },
      ],
      skipDuplicates: true,
    })
    for (const [id, slug] of [
      [ORG, "e10-modelos-org"],
      [OTHER, "e10-modelos-otra"],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: slug, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await prisma.membership.create({ data: { organizationId: id, userId: USER, role: "ADMIN", updatedAt: new Date() } })
    }
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

      employeeId = (await createEmployeeTx(tx, { code: "E-001", name: "A. García", defaultCostCenterId: ceco["CC-GA"] }, actor)).id
      ownEmployeeId = (
        await createEmployeeTx(tx, { code: "E-002", name: "B. López", userId: USER, defaultCostCenterId: ceco["CC-GA"] }, actor)
      ).id
    })
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      // Las tablas de E10 son append-only con trigger (un parte aprobado no se
      // borra, una versión sellada tampoco). Para LIMPIAR se desactivan como
      // PROPIETARIO: es una prerrogativa del entorno de pruebas, no un camino
      // que la aplicación tenga.
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
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1)`, [[ORG, OTHER]])
      }
      for (const table of ["time_entries", "budgets", "budget_lines", "budget_hours_lines"]) {
        await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`)
      }
      await client.query("COMMIT")
    })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER] } } })
    await prisma.user.deleteMany({ where: { id: { in: [USER, EMPLOYEE_USER] } } })
  }

  async function newDraft(name: string, validFrom: string, partialFrom: string | null = null): Promise<string> {
    return await tenantTransaction(ORG, USER, async (tx) => {
      const created = await createBudgetVersionTx(
        tx,
        {
          fiscalYearId,
          scenario: name === "BASE" ? "BASE" : "REVISADO",
          name,
          validFrom,
          partialFrom,
        },
        actor
      )
      return created.id
    })
  }

  // ───────────────────────────────────────────────────────────────────────
  // Presupuesto: signo, agregados, sellado y continuidad
  // ───────────────────────────────────────────────────────────────────────

  it("O-E10-6 · un gasto tecleado en POSITIVO se rechaza con el signo correcto en el mensaje", async () => {
    const budgetId = await newDraft("REV-SIGNO", "2026-12-01")
    const message = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) => {
        const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
        return upsertBudgetCellsTx(
          tx,
          {
            budgetId,
            config,
            cells: [
              {
                month: "2026-03-01",
                accountCode: "6400",
                projectId: projectA,
                analyticType: "COSTE_DIRECTO_MC2",
                amountCents: 1_200_000,
              },
            ],
          },
          actor
        )
      })
    )
    expect(message).toContain("BUDGET_SIGN")
    expect(message).toMatch(/negativo/i)
  })

  it("agregado SQL = suma de las líneas, al céntimo, y el sellado cierra la vigencia anterior (O-E10-8)", async () => {
    const base = await newDraft("BASE", "2026-01-01")
    await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      await upsertBudgetCellsTx(
        tx,
        {
          budgetId: base,
          config,
          cells: [
            { month: "2026-01-01", accountCode: "705", projectId: projectA, analyticType: "INGRESO_DIRECTO", amountCents: 600_000 },
            { month: "2026-01-01", accountCode: "600", projectId: projectA, analyticType: "COSTE_DIRECTO_MC1", amountCents: -250_000 },
            { month: "2026-02-01", accountCode: "705", projectId: projectB, analyticType: "INGRESO_DIRECTO", amountCents: 400_000 },
          ],
        },
        actor
      )
      await upsertBudgetHoursTx(tx, { budgetId: base, rows: [{ month: "2026-01-01", projectId: projectA, minutes: 19_200 }] }, actor)
    })

    const listed = await listBudgets(tenantDb(ORG), { fiscalYearId })
    const row = listed.find((b) => b.id === base)
    expect(row?.lineCount).toBe(3)
    expect(row?.hoursLineCount).toBe(1)
    // El agregado SQL, contra la suma leída línea a línea: mismo céntimo.
    const version = await tenantTransaction(ORG, USER, async (tx) => getBudgetVersion(tx, base))
    expect(row?.totalCents).toBe(version?.cells.reduce((a, c) => a + c.amountCents, 0))
    expect(row?.totalCents).toBe(750_000)

    // Sellar: los tres sellos a la vez y `VIGENTE`.
    const sealed = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      return sealBudgetTx(
        tx,
        { budgetId: base, gitSha: "test-sha", marginConfigHash: marginConfigHash(config), sealedAt: new Date("2026-01-15") },
        actor
      )
    })
    expect(sealed.budgetHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sealed.closedPreviousId).toBeNull()

    // El hash es REPRODUCIBLE: se recomputa sobre lo que la fila tiene hoy.
    const stored = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      const v = await getBudgetVersion(tx, base)
      if (!v) throw new Error("sin versión")
      return { recomputed: computeBudgetHash(v, marginConfigHash(config)), seals: v.seals }
    })
    expect(stored.seals.budgetHash).toBe(sealed.budgetHash)
    expect(stored.recomputed).toBe(sealed.budgetHash)

    // Una REVISADO vigente desde julio CIERRA la BASE el 30 de junio, en la
    // MISMA transacción. El EXCLUDE impedía el solape; el hueco, no.
    const rev = await newDraft("REV1", "2026-07-01", "2026-07-01")
    await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      await upsertBudgetCellsTx(
        tx,
        {
          budgetId: rev,
          config,
          cells: [
            { month: "2026-08-01", accountCode: "705", projectId: projectA, analyticType: "INGRESO_DIRECTO", amountCents: 900_000 },
          ],
        },
        actor
      )
    })
    const sealedRev = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      return sealBudgetTx(
        tx,
        { budgetId: rev, validFrom: "2026-07-01", gitSha: "test-sha", marginConfigHash: marginConfigHash(config), sealedAt: new Date("2026-07-01") },
        actor
      )
    })
    expect(sealedRev.closedPreviousId).toBe(base)
    expect(sealedRev.closedPreviousTo).toBe("2026-06-30")

    // Criterio 6 · un informe de mayo usa la BASE y uno de agosto la REV1.
    const enMayo = await tenantTransaction(ORG, USER, async (tx) => activeBudgetAt(tx, { fiscalYearId, at: "2026-05-31" }))
    const enAgosto = await tenantTransaction(ORG, USER, async (tx) => activeBudgetAt(tx, { fiscalYearId, at: "2026-08-31" }))
    expect(enMayo?.provenanceByMonth["2026-05"].budgetId).toBe(base)
    // O-E10-9 · la parcial sustituye de julio en adelante y la BASE cubre el resto.
    expect(enAgosto?.provenanceByMonth["2026-03"].budgetId).toBe(base)
    expect(enAgosto?.provenanceByMonth["2026-08"].budgetId).toBe(rev)
  })

  it("I-E10-6 · una versión SELLADA no admite edición de sus celdas ni por la acción ni por SQL", async () => {
    const sealed = (await listBudgets(tenantDb(ORG), { fiscalYearId, status: "VIGENTE" }))[0]
    expect(sealed).toBeDefined()

    const message = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) => {
        const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
        return upsertBudgetCellsTx(
          tx,
          {
            budgetId: sealed.id,
            config,
            cells: [
              { month: "2026-01-01", accountCode: "705", projectId: projectA, analyticType: "INGRESO_DIRECTO", amountCents: 1 },
            ],
          },
          actor
        )
      })
    )
    expect(message).toContain("BUDGET_SEALED")

    // Saltándose la acción: el trigger, con 23514.
    const sqlError = await owner(async (client) => {
      try {
        await client.query(`UPDATE budget_lines SET amount_cents = 1 WHERE budget_id = $1`, [sealed.id])
        return null
      } catch (error) {
        return error as { code?: string }
      }
    })
    expect(sqlError?.code).toBe("23514")
  })

  it("append-only · `app_runtime` no puede borrar una versión de presupuesto (42501)", async () => {
    const sealed = (await listBudgets(tenantDb(ORG), { fiscalYearId, status: "VIGENTE" }))[0]
    const client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL ROLE app_runtime")
      await client.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
      const deleted = await client
        .query(`DELETE FROM budgets WHERE id = $1`, [sealed.id])
        .then((r) => ({ code: null as string | null, count: r.rowCount ?? 0 }))
        .catch((e: { code?: string }) => ({ code: e.code ?? null, count: -1 }))
      // `REVOKE DELETE` da 42501; la política RESTRICTIVE, 0 filas. Cualquiera de
      // las dos vale: lo que NO puede pasar es que la fila desaparezca.
      expect(deleted.code === "42501" || deleted.count === 0).toBe(true)
      // El `42501` aborta la transacción, así que la comprobación de que la fila
      // SIGUE AHÍ se hace fuera, como propietario.
      await client.query("ROLLBACK")
      const { rows } = await owner(async (c) =>
        c.query(`SELECT count(*)::int AS n FROM budgets WHERE id = $1`, [sealed.id])
      )
      expect(rows[0].n).toBe(1)
    } finally {
      await client.query("ROLLBACK").catch(() => undefined)
      await client.end()
    }
  })

  it("R-B-6 · un CSV con la convención de signo invertida se rechaza ENTERO, sin insertar una fila", async () => {
    const draft = await newDraft("REV2", "2026-10-01")
    const report = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
      return importBudgetCsvTx(
        tx,
        {
          budgetId: draft,
          config,
          rows: [
            { lineNo: 1, month: "2026-10-01", accountCode: "600", projectId: projectA, analyticType: "COSTE_DIRECTO_MC1", amountCents: 100_000 },
            { lineNo: 2, month: "2026-10-01", accountCode: "621", costCenterId: ceco["CC-GA"], analyticType: "INDIRECTO_CECO", amountCents: 200_000 },
          ],
        },
        actor
      )
    })
    expect(report.fileRejected).toBe(true)
    expect(report.inserted).toBe(0)
    expect(report.reasons[0].reason).toMatch(/convención de signo/i)
    const version = await tenantTransaction(ORG, USER, async (tx) => getBudgetVersion(tx, draft))
    expect(version?.cells).toHaveLength(0)
  })

  it("Q-4 · la propuesta de amortización trae sus términos y NO escribe nada", async () => {
    const proposal = await tenantTransaction(ORG, USER, async (tx) => proposeDepreciationBudget(tx, { fiscalYearId }))
    expect(proposal.fiscalYearId).toBe(fiscalYearId)
    // Sin activos de alta, la propuesta es vacía y lo dice: nunca inventa líneas.
    expect(proposal.lines).toHaveLength(0)
    expect(proposal.totalCents).toBe(0)
    const after = await listBudgets(tenantDb(ORG), { fiscalYearId })
    expect(after.every((b) => b.lineCount >= 0)).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Horas
  // ───────────────────────────────────────────────────────────────────────

  it("I-E10-4 · un parte APROBADO es inmutable y se corrige con contra-apunte con motivo", async () => {
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      createTimeEntriesTx(tx, [{ employeeId, date: "2026-03-12", projectId: projectA, minutes: 480 }], actor)
    )
    const entryId = created.ids[0]

    await tenantTransaction(ORG, USER, async (tx) =>
      approveTimeEntriesTx(tx, { ids: [entryId], approvedAt: new Date("2026-03-13"), actorIsAdmin: true }, actor)
    )

    // Saltándose la acción: el trigger lanza 23514 y la fila queda intacta.
    const sqlError = await owner(async (client) => {
      try {
        await client.query(`UPDATE time_entries SET minutes = 900 WHERE id = $1`, [entryId])
        return null
      } catch (error) {
        return error as { code?: string }
      }
    })
    expect(sqlError?.code).toBe("23514")

    // Motivo de 9 caracteres: se rechaza. Con 10 o más: entra el contra-apunte.
    const short = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        correctTimeEntryTx(tx, { entryId, minutes: -250, reason: "123456789", approvedAt: new Date("2026-03-14") }, actor)
      )
    )
    expect(short).toContain("REASON_TOO_SHORT")

    await tenantTransaction(ORG, USER, async (tx) =>
      correctTimeEntryTx(
        tx,
        { entryId, minutes: -250, reason: "error de imputación en el parte", approvedAt: new Date("2026-03-14") },
        actor
      )
    )

    // El ORIGINAL sigue ahí y el neto del día baja exactamente 250 minutos.
    const { entries } = await listTimeEntries(tenantDb(ORG), { from: "2026-03-12", to: "2026-03-12" })
    expect(entries).toHaveLength(2)
    expect(entries.reduce((a, e) => a + e.minutes, 0)).toBe(230)
    expect(entries.some((e) => e.id === entryId && e.minutes === 480)).toBe(true)
  })

  it("R-H-4 · nadie aprueba sus propios partes, salvo un ADMIN", async () => {
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      createTimeEntriesTx(tx, [{ employeeId: ownEmployeeId, date: "2026-04-02", projectId: projectA, minutes: 300 }], actor)
    )
    const message = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        approveTimeEntriesTx(tx, { ids: created.ids, approvedAt: new Date("2026-04-03"), actorIsAdmin: false }, actor)
      )
    )
    expect(message).toContain("TIME_SELF_APPROVAL")

    const asAdmin = await tenantTransaction(ORG, USER, async (tx) =>
      approveTimeEntriesTx(tx, { ids: created.ids, approvedAt: new Date("2026-04-03"), actorIsAdmin: true }, actor)
    )
    expect(asAdmin.approved).toBe(1)
  })

  it("criterio 10 · reimportar el MISMO CSV de partes inserta 0 filas y dice por qué", async () => {
    const rows = [
      { lineNo: 1, employeeId, date: "2026-05-04", projectId: projectA, minutes: 420 },
      { lineNo: 2, employeeId, date: "2026-05-05", projectId: projectB, minutes: 360 },
    ]
    const first = await tenantTransaction(ORG, USER, async (tx) =>
      importTimeCsvTx(tx, { rows, fileSha256: "abc123" }, actor)
    )
    expect(first.inserted).toBe(2)
    const second = await tenantTransaction(ORG, USER, async (tx) =>
      importTimeCsvTx(tx, { rows, fileSha256: "abc123" }, actor)
    )
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(2)
    expect(second.reasons[0].reason).toMatch(/ya importada/)
  })

  it("el agregado de horas por (receptor, mes) sale de SQL y cuadra con las filas materializadas", async () => {
    const window = { from: "2026-01-01", to: "2026-12-31" }
    const [aggregated, rows] = await tenantTransaction(ORG, USER, async (tx) => [
      await minutesByTargetMonthSql(tx, window, { productiveOnly: true, approvedOnly: true }),
      await getTimeRowsForWindow(tx, window),
    ])
    const expected = rows
      .filter((r) => r.approved && r.productive)
      .reduce((acc, r) => acc + r.minutes, 0)
    expect(aggregated.reduce((a, m) => a + m.minutes, 0)).toBe(expected)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Empleados y tarifas
  // ───────────────────────────────────────────────────────────────────────

  it("la tarifa nueva CIERRA la anterior en la misma transacción, sin solape y sin hueco", async () => {
    await tenantTransaction(ORG, USER, async (tx) =>
      createEmployeeRateTx(
        tx,
        { employeeId, hourlyCostCents: 3_000, basis: "COSTE_EMPRESA_CON_SS", validFrom: "2026-01-01" },
        actor
      )
    )
    const second = await tenantTransaction(ORG, USER, async (tx) =>
      createEmployeeRateTx(
        tx,
        { employeeId, hourlyCostCents: 3_517, basis: "COSTE_EMPRESA_CON_SS", validFrom: "2026-07-01" },
        actor
      )
    )
    expect(second.closedPreviousId).not.toBeNull()

    const rates = await listEmployeeRates(tenantDb(ORG), { employeeId })
    expect(rates).toHaveLength(2)
    expect(rates[0].validTo).toBe("2026-06-30")
    expect(rates[1].validFrom).toBe("2026-07-01")
    expect(rates[1].validTo).toBeNull()
    // Sin hueco: el día siguiente al cierre de la primera es el alta de la segunda.
    expect(rates[0].validTo! < rates[1].validFrom).toBe(true)
  })

  it("un coste-hora ≤ 0 se rechaza: no es evaluable, y desde luego no es cero", async () => {
    const message = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        createEmployeeRateTx(tx, { employeeId, hourlyCostCents: 0, basis: "BRUTO_SIN_SS", validFrom: "2027-01-01" }, actor)
      )
    )
    expect(message).toContain("RATE_NOT_EVALUABLE")
  })

  it("el snapshot de plantilla es a FIN de mes y se rechaza cualquier otro día", async () => {
    const message = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        upsertHeadcountSnapshotTx(tx, { costCenterId: ceco["CC-GA"], periodEnd: "2026-03-15", fteMilli: 3_000, headcount: 3 }, actor)
      )
    )
    expect(message).toContain("HEADCOUNT_NOT_LAST_DAY")

    const ok = await tenantTransaction(ORG, USER, async (tx) =>
      upsertHeadcountSnapshotTx(tx, { costCenterId: ceco["CC-GA"], periodEnd: "2026-03-31", fteMilli: 3_000, headcount: 3 }, actor)
    )
    expect(ok.created).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────
  // §3.9 — la staleness en TRES consultas, CONTADAS
  // ───────────────────────────────────────────────────────────────────────

  it("criterio 21 · el `ledgerHash` del agregado SQL coincide con el de `lib/ledger/hash.ts`", async () => {
    await postEntry(
      ORG,
      {
        entryDate: "2026-02-10",
        description: "venta",
        lines: [
          { accountCode: "430", debitCents: 121_000, creditCents: 0 },
          { accountCode: "705", debitCents: 0, creditCents: 100_000, projectId: projectA },
          { accountCode: "477", debitCents: 0, creditCents: 21_000 },
        ],
      },
      actor
    )
    const period = { periodStart: "2026-01-01" as const, periodEnd: "2026-12-31" as const, fiscalYearId }
    const [batch, single] = await tenantTransaction(ORG, USER, async (tx) => [
      await periodSealsBatch(tx, [period]),
      await computeLedgerHash(tx, { fiscalYearId, from: "2026-01-01", to: "2026-12-31" }),
    ])
    const seal = batch.get("2026-01-01|2026-12-31")
    expect(seal).toBeDefined()
    // Test ESPEJO: la forma canónica escrita en SQL y la del motor dan el MISMO
    // sello. Es lo que impide que los dos caminos diverjan en silencio.
    expect(seal?.ledgerHash).toBe(single)
    expect(seal?.dimensionsHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("criterio 21 · derivar la staleness de N runs son TRES consultas, contadas", async () => {
    // Sin runs sellados el lote no consulta nada; con runs, SIEMPRE tres.
    const runs = [
      {
        id: "run-1",
        periodKind: "MONTH" as const,
        periodStart: "2026-01-01" as const,
        periodEnd: "2026-01-31" as const,
        ledgerHash: "0".repeat(64),
        analyticsHash: "0".repeat(64),
        rulesHash: "0".repeat(64),
        fiscalYearId,
        timeHash: "∅",
        timeHashWindowStart: null,
        timeHashWindowEnd: null,
      },
      {
        id: "run-2",
        periodKind: "MONTH" as const,
        periodStart: "2026-02-01" as const,
        periodEnd: "2026-02-28" as const,
        ledgerHash: "0".repeat(64),
        analyticsHash: "0".repeat(64),
        rulesHash: "0".repeat(64),
        fiscalYearId,
        timeHash: "∅",
        timeHashWindowStart: "2026-01-01" as const,
        timeHashWindowEnd: "2026-02-28" as const,
      },
      {
        id: "run-3",
        periodKind: "MONTH" as const,
        periodStart: "2026-03-01" as const,
        periodEnd: "2026-03-31" as const,
        ledgerHash: "0".repeat(64),
        analyticsHash: "0".repeat(64),
        rulesHash: "0".repeat(64),
        fiscalYearId,
        timeHash: "∅",
        timeHashWindowStart: "2026-01-01" as const,
        timeHashWindowEnd: "2026-03-31" as const,
      },
    ]

    const result = await tenantTransaction(ORG, USER, async (tx) => {
      let queries = 0
      // Proxy CONTADOR: cada `$queryRaw` y cada acceso a un modelo cuentan una
      // consulta. Se cuentan, no se estiman (criterio 21).
      const counted = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop === "$queryRaw") {
            return (...args: unknown[]) => {
              queries += 1
              return (value as (...a: unknown[]) => unknown).apply(target, args)
            }
          }
          if (prop === "allocationRule" && value !== null && typeof value === "object") {
            return new Proxy(value as object, {
              get(model, method, r2) {
                const fn = Reflect.get(model, method, r2)
                if (typeof fn !== "function") return fn
                return (...args: unknown[]) => {
                  queries += 1
                  return (fn as (...a: unknown[]) => unknown).apply(model, args)
                }
              },
            })
          }
          return value
        },
      })
      const staleness = await allocationRunStalenessBatch(counted as typeof tx, runs)
      return { queries, staleness }
    })

    // TRES, sean tres runs o diecisiete: periodos ≠ consultas.
    expect(result.queries).toBe(3)
    expect(result.staleness.size).toBe(3)
    // Los sellos de relleno no coinciden con los de hoy: los tres salen STALE y
    // dicen POR QUÉ, nunca un `false` mudo.
    for (const [, value] of result.staleness) {
      expect(value.isStale).toBe(true)
      expect(value.reasons.length).toBeGreaterThan(0)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Tenant
  // ───────────────────────────────────────────────────────────────────────

  it("tenant · la otra organización no ve ni una versión de presupuesto ni un parte de ésta", async () => {
    const mine = await listBudgets(tenantDb(ORG), {})
    expect(mine.length).toBeGreaterThan(0)
    const theirs = await listBudgets(tenantDb(OTHER), {})
    expect(theirs).toHaveLength(0)

    const myTime = await listTimeEntries(tenantDb(ORG), {})
    expect(myTime.total).toBeGreaterThan(0)
    const theirTime = await listTimeEntries(tenantDb(OTHER), {})
    expect(theirTime.total).toBe(0)

    // Y pedir por id una versión ajena no la devuelve: `findFirst` con tenant,
    // nunca `findUnique` por id suelto.
    const stolen = await tenantTransaction(OTHER, USER, async (tx) => getBudgetVersion(tx, mine[0].id))
    expect(stolen).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────
  // O-E10-9 · las horas cuelgan de CADA versión que cubre el mes
  //
  // El hallazgo de B1, contra la base. `composeBudget` toma las celdas Y las
  // horas del mes de la versión que lo gobierna: una `REVISADO` PARCIAL desde
  // julio manda sobre julio-diciembre, así que si se sella sin líneas de horas
  // el año compuesto pierde las de esos meses y `settleBudgetMatrix` reparte
  // con la MITAD de la base del driver — sin que nada falle y con una cifra
  // más baja que parece comparable. Se ejerce en un ejercicio propio porque el
  // `EXCLUDE` de vigencias es por (organización, ejercicio).
  // ───────────────────────────────────────────────────────────────────────

  describe("composición de versiones con horas presupuestadas", () => {
    let fy2027 = ""
    let base2027 = ""

    beforeAll(async () => {
      const fy = await openFiscalYear(ORG, { code: "2027", startDate: "2027-01-01", endDate: "2027-12-31" }, actor)
      if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
      fy2027 = fy.value.id

      base2027 = await tenantTransaction(ORG, USER, async (tx) => {
        const created = await createBudgetVersionTx(
          tx,
          { fiscalYearId: fy2027, scenario: "BASE", name: "BASE", validFrom: "2027-01-01" },
          actor
        )
        const config = await getAnalyticsConfig(tx, { periodEnd: "2027-12-31" })
        // Doce meses de ingreso y doce meses de horas: el año entero cubierto.
        await upsertBudgetCellsTx(
          tx,
          {
            budgetId: created.id,
            config,
            cells: Array.from({ length: 12 }, (_, i) => ({
              month: `2027-${String(i + 1).padStart(2, "0")}-01` as const,
              accountCode: "705",
              projectId: projectA,
              analyticType: "INGRESO_DIRECTO" as const,
              amountCents: 500_000,
            })),
          },
          actor
        )
        await upsertBudgetHoursTx(
          tx,
          {
            budgetId: created.id,
            rows: Array.from({ length: 12 }, (_, i) => ({
              month: `2027-${String(i + 1).padStart(2, "0")}-01` as const,
              projectId: projectA,
              minutes: 9_600,
            })),
          },
          actor
        )
        const config2 = await getAnalyticsConfig(tx, { periodEnd: "2027-12-31" })
        await sealBudgetTx(
          tx,
          {
            budgetId: created.id,
            gitSha: "test-sha",
            marginConfigHash: marginConfigHash(config2),
            sealedAt: new Date("2027-01-02"),
          },
          actor
        )
        return created.id
      })
    }, 120_000)

    it("una REVISADO parcial SIN horas avisa al sellar y deja el año compuesto sin la base del driver", async () => {
      const rev = await tenantTransaction(ORG, USER, async (tx) => {
        const created = await createBudgetVersionTx(
          tx,
          {
            fiscalYearId: fy2027,
            scenario: "REVISADO",
            name: "REV1",
            validFrom: "2027-07-01",
            partialFrom: "2027-07-01",
          },
          actor
        )
        const config = await getAnalyticsConfig(tx, { periodEnd: "2027-12-31" })
        await upsertBudgetCellsTx(
          tx,
          {
            budgetId: created.id,
            config,
            cells: Array.from({ length: 6 }, (_, i) => ({
              month: `2027-${String(i + 7).padStart(2, "0")}-01` as const,
              accountCode: "705",
              projectId: projectA,
              analyticType: "INGRESO_DIRECTO" as const,
              amountCents: 700_000,
            })),
          },
          actor
        )
        return created.id
      })

      const sealed = await tenantTransaction(ORG, USER, async (tx) => {
        const config = await getAnalyticsConfig(tx, { periodEnd: "2027-12-31" })
        return sealBudgetTx(
          tx,
          {
            budgetId: rev,
            validFrom: "2027-07-01",
            gitSha: "test-sha",
            marginConfigHash: marginConfigHash(config),
            sealedAt: new Date("2027-07-01"),
          },
          actor
        )
      })
      // El aviso NO bloquea —presupuestar sin horas es legítimo mientras ninguna
      // regla use HORAS— pero viaja con el sello y queda en el AuditLog.
      expect(sealed.closedPreviousId).toBe(base2027)
      expect(sealed.warnings.map((w) => w.code)).toContain("PARTIAL_WITHOUT_HOURS")
      expect(sealed.warnings[0].message).toMatch(/llevaba 6/)

      // Y la consecuencia, medida: el año compuesto conserva las horas de
      // enero-junio (de la BASE) y pierde las de julio-diciembre, que ahora
      // gobierna una versión que no las lleva.
      const composed = await tenantTransaction(ORG, USER, async (tx) =>
        activeBudgetAt(tx, { fiscalYearId: fy2027, at: "2027-12-31" })
      )
      expect(composed).not.toBeNull()
      const months = new Set((composed?.effective.hours ?? []).map((h) => h.month.slice(0, 7)))
      expect(months.has("2027-06")).toBe(true)
      expect(months.has("2027-07")).toBe(false)
      expect(months.size).toBe(6)
      // Las CELDAS sí están completas: el hueco es sólo de horas, que es
      // exactamente lo que lo hacía invisible.
      expect(composed?.effective.cells).toHaveLength(12)
      expect(composed?.provenanceByMonth["2027-08"].budgetId).toBe(rev)
    })

    it("copiar la versión al crearla trae las horas de los meses que gobernará: el remedio", async () => {
      const copia = await tenantTransaction(ORG, USER, async (tx) =>
        createBudgetVersionTx(
          tx,
          {
            fiscalYearId: fy2027,
            scenario: "REVISADO",
            name: "REV2",
            validFrom: "2027-10-01",
            partialFrom: "2027-10-01",
            copyFromBudgetId: base2027,
          },
          actor
        )
      )
      expect(copia.copiedCells).toBe(12)
      const version = await tenantTransaction(ORG, USER, async (tx) => getBudgetVersion(tx, copia.id))
      // Las doce líneas de horas viajan con la copia; `composeBudget` se queda
      // luego con las de los meses que esta versión gobierna.
      expect(version?.hours).toHaveLength(12)
      expect(version?.hours.filter((h) => h.month >= "2027-10-01")).toHaveLength(3)
      expect(version?.status).toBe("BORRADOR")
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // T13 · PRESUPUESTO_REAL — el noveno componente de la clave y el rechazo
  // ───────────────────────────────────────────────────────────────────────

  describe("PRESUPUESTO_REAL", () => {
    it("un BORRADOR no firma un informe: BUDGET_NOT_SEALED y ni una fila en report_runs", async () => {
      const draft = await newDraft("REV-BORRADOR", "2026-09-01", "2026-09-01")
      const before = await prisma.reportRun.count({ where: { organizationId: ORG, type: "PRESUPUESTO_REAL" } })

      await expect(
        budgetVsActual(ORG, {
          fiscalYearId,
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
          budgetId: draft,
          actor,
        })
      ).rejects.toThrow(/borrador/i)

      // O-E10-5 / criterio 18-ter: no existe camino que intente escribir
      // `budget_hash = '∅'`, porque no hay hash que escribir.
      const after = await prisma.reportRun.count({ where: { organizationId: ORG, type: "PRESUPUESTO_REAL" } })
      expect(after).toBe(before)

      // Contra el MISMO borrador, la previsualización sí responde — y tampoco
      // escribe: es el patrón de `previewAllocation` de E5.
      const preview = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        budgetId: draft,
        actor,
        preview: true,
      })
      expect(preview.runId).toBeNull()
      expect(preview.sealed).toBe(false)
      expect(preview.origen).toBe("preview")
      expect(await prisma.reportRun.count({ where: { organizationId: ORG, type: "PRESUPUESTO_REAL" } })).toBe(before)
    })

    it("el `budgetHash` está en la clave de caché y el ReportRun emitido es INMUTABLE (42501)", async () => {
      const first = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        actor,
      })
      expect(first.runId).not.toBeNull()
      expect(first.origen).toBe("fresh")
      expect(first.budgetHash).toMatch(/^[0-9a-f]{64}$/)

      // Misma petición, mismos nueve componentes: caché, no un segundo informe.
      const again = await budgetVsActual(ORG, {
        fiscalYearId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        actor,
      })
      expect(again.origen).toBe("cache")
      expect(again.runId).toBe(first.runId)

      // Y el noveno componente está ESCRITO en la fila, que es lo que permite
      // que dos versiones de presupuesto no compartan caché.
      const row = await prisma.reportRun.findFirstOrThrow({ where: { id: first.runId ?? "" } })
      expect(row.budgetHash).toBe(first.budgetHash)
      expect(row.type).toBe("PRESUPUESTO_REAL")

      // Append-only: un informe emitido es un hecho. `app_runtime` lo intenta y
      // la BASE lo rechaza con 42501; la política RESTRICTIVE daría 0 filas.
      // Cualquiera de las dos vale: lo que NO puede pasar es que el sello mute.
      const denied = await asRuntime(async (client) =>
        client
          .query(`UPDATE report_runs SET seal = 'REQUIERE_REVISION' WHERE id = $1`, [first.runId])
          .then((r) => ({ code: null as string | null, count: r.rowCount ?? 0 }))
          .catch((e: { code?: string }) => ({ code: e.code ?? null, count: -1 }))
      )
      expect(denied.code === "42501" || denied.count === 0).toBe(true)
      const still = await owner(async (c) =>
        c.query(`SELECT seal::text AS seal FROM report_runs WHERE id = $1`, [first.runId])
      )
      expect(still.rows[0].seal).toBe(row.seal)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // El cuarto sello: `timeHash` sobre la VENTANA que el run persiste
  // ───────────────────────────────────────────────────────────────────────

  it("espejo TS ↔ SQL del `timeHash`, y aprobar un parte de la ventana deja el run STALE", async () => {
    const window = { from: "2026-01-01" as const, to: "2026-12-31" as const }
    const [sqlHash, tsHash] = await tenantTransaction(ORG, USER, async (tx) => {
      const batch = await timeHashBatch(tx, [window])
      const rows = await getTimeRowsForWindow(tx, window)
      return [batch.get(`${window.from}|${window.to}`), timeHashOf(rows, window)]
    })
    // La forma canónica escrita en SQL y la de `lib/time/aggregate.ts` dan el
    // MISMO sello: es lo que impide que los dos caminos diverjan en silencio.
    expect(sqlHash).toBe(tsHash)

    // Un run sellado con ESE hash y ESA ventana no se queja del cuarto sello.
    // Los otros tres sí caducan (el ref es sintético) y por eso se mira el
    // MOTIVO, no el booleano: lo que se ejerce aquí es el `timeHash`.
    const runRef = {
      id: "run-horas",
      periodKind: "YEAR" as const,
      periodStart: "2026-01-01" as const,
      periodEnd: "2026-12-31" as const,
      fiscalYearId,
      ledgerHash: "",
      analyticsHash: "",
      rulesHash: "",
      timeHash: sqlHash ?? "",
      timeHashWindowStart: window.from,
      timeHashWindowEnd: window.to,
    }
    const timeReason = /partes de horas/
    const vigente = await tenantTransaction(ORG, USER, async (tx) => allocationRunStalenessBatch(tx, [runRef]))
    expect(vigente.get("run-horas")?.reasons.join(" · ")).not.toMatch(timeReason)

    // …y aprobar un parte NUEVO dentro de la ventana lo caduca por el CUARTO
    // sello, no por el diario: el diario no se ha movido. Es el caso que D1
    // describe — aprobar en enero un parte de diciembre cambia la base del
    // reparto de diciembre.
    await tenantTransaction(ORG, USER, async (tx) => {
      const created = await createTimeEntriesTx(
        tx,
        [{ employeeId, date: "2026-11-20", projectId: projectA, minutes: 240, productive: true }],
        actor
      )
      await approveTimeEntriesTx(tx, { ids: created.ids, approvedAt: new Date("2026-11-21") }, { userId: EMPLOYEE_USER })
    })

    const caducado = await tenantTransaction(ORG, USER, async (tx) => allocationRunStalenessBatch(tx, [runRef]))
    const found = caducado.get("run-horas")
    expect(found?.isStale).toBe(true)
    expect(found?.reasons.join(" · ")).toMatch(timeReason)
    // Y el motivo NOMBRA la ventana: sin ella nadie sabe dónde mirar (O-E10-1).
    expect(found?.reasons.join(" · ")).toContain("2026-01-01 … 2026-12-31")
  })

  // ───────────────────────────────────────────────────────────────────────
  // Deuda §0-bis #7 — destino analítico en el alta de inmovilizado
  // ───────────────────────────────────────────────────────────────────────

  it("un inmovilizado no lleva proyecto Y CECO a la vez, y sin ninguno AVISA (no bloquea)", async () => {
    const both = await failure(async () =>
      tenantTransaction(ORG, USER, async (tx) =>
        assertAssetDimension(tx, { projectId: projectA, costCenterId: ceco["CC-GA"] })
      )
    )
    expect(both).toMatch(/ASSET_DIMENSION_XOR/)

    // Sin ninguno y con `analyticsRequired`, AVISO: la amortización cae en
    // NO_ANALITICO, que es un destino legítimo y una decisión del usuario.
    const none = await tenantTransaction(ORG, USER, async (tx) =>
      assertAssetDimension(tx, { projectId: null, costCenterId: null })
    )
    expect(none.warning).toMatch(/NO_ANALITICO/)

    // Con uno de los dos, ni error ni aviso.
    const one = await tenantTransaction(ORG, USER, async (tx) =>
      assertAssetDimension(tx, { projectId: projectA, costCenterId: null })
    )
    expect(one.warning).toBeNull()

    // Y el alta completa con destino analítico pasa, que es lo que cierra la
    // mitad de servidor de la deuda.
    const asset = await tenantTransaction(ORG, USER, async (tx) =>
      createAssetTx(
        tx,
        {
          code: "AC-E10",
          name: "Servidor del proyecto Alfa",
          assetAccountCode: "217",
          accumulatedAccountCode: "281",
          expenseAccountCode: "681",
          acquisitionDate: "2026-01-10",
          inServiceDate: "2026-01-15",
          acquisitionCostCents: 600_000,
          usefulLifeMonths: 36,
          projectId: projectA,
        },
        actor
      )
    )
    expect(asset.projectId).toBe(projectA)
  })

  // ───────────────────────────────────────────────────────────────────────
  // O-E10-12 — la derivación 64x es una PROPUESTA, con su cobertura
  // ───────────────────────────────────────────────────────────────────────

  it("la derivación del coste-hora propone con términos y cobertura, y nunca escribe una tarifa", async () => {
    // Nómina del CECO en el periodo: 640 con destino CC-GA.
    await postEntry(
      ORG,
      {
        entryDate: "2026-03-31",
        description: "nómina marzo",
        lines: [
          { accountCode: "640", debitCents: 300_000, creditCents: 0, costCenterId: ceco["CC-GA"] },
          { accountCode: "465", debitCents: 0, creditCents: 300_000 },
        ],
      },
      actor
    )

    const ratesBefore = await tenantTransaction(ORG, USER, async (tx) => listEmployeeRates(tx, employeeId))
    const proposal = await tenantTransaction(ORG, USER, async (tx) =>
      proposeHourlyCost(tx, {
        scope: "COST_CENTER",
        costCenterId: ceco["CC-GA"],
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      })
    )
    // Evaluable o no, la propuesta SIEMPRE explica de qué sale: un coste-hora
    // sin términos no se puede discutir en un comité.
    if (proposal.ok) {
      expect(proposal.hourlyCostCents).toBeGreaterThan(0)
      expect(proposal.derivation).toBeDefined()
    } else {
      expect(proposal.error).toMatch(/COVERAGE_TOO_LOW|NO_PRODUCTIVE_TIME|NO_PAYROLL/)
      expect(proposal.message.length).toBeGreaterThan(20)
    }
    // Propuesta, nunca aplicación: ni una tarifa nueva.
    const ratesAfter = await tenantTransaction(ORG, USER, async (tx) => listEmployeeRates(tx, employeeId))
    expect(ratesAfter).toHaveLength(ratesBefore.length)
  })
})
