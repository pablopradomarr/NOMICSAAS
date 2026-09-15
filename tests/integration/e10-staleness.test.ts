import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · T14-bis (lote C4) — el espejo TS ↔ SQL del `marginConfigHash` y la
 * staleness de un run sellado.
 *
 * El hallazgo de C1: el espejo SQL de `periodSealsBatch` no reproducía
 * `canonicalMarginConfigForm` de `lib/analytics/hash.ts`, así que TODO run
 * sellado se derivaba `STALE` con el motivo «se ha reclasificado alguna línea
 * del periodo» aunque no hubiera cambiado nada. Ningún test lo veía porque los
 * dos casos de staleness existentes esperaban `STALE`.
 *
 * Aquí se ejerce lo contrario, que es lo que importa: **sellar y quedarse
 * VIGENTE**, y volverse `STALE` sólo cuando algo cambia de verdad.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { getAnalyticLines, getAnalyticsConfig, seedAnalyticsDefaults } = await import("@/models/analytics")
const {
  allocationRunStalenessBatch,
  createAllocationRuleTx,
  listAllocationRuns,
  marginConfigFormsBatch,
  periodSealsBatch,
  sealAllocationRunTx,
} = await import("@/models/allocations")
const { canonicalMarginConfigForm, dimensionsHash, marginConfigHash } = await import("@/lib/analytics/hash")

const ORG = "ea000000-0000-4000-8000-00000000000a"
const USER = "ea000000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const REF = "2026-12-31"
const YEAR = { periodKind: "YEAR" as const, periodStart: "2026-01-01" as const, periodEnd: "2026-12-31" as const }
const KEY = `${YEAR.periodStart}|${YEAR.periodEnd}`

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · espejo TS ↔ SQL de `marginConfigHash` y staleness", () => {
  const ceco: Record<string, string> = {}
  let projectA = ""
  let projectB = ""
  let fiscalYearId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e10-staleness@test.local", name: "E10 staleness" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e10-staleness", name: "E10 staleness", pgcVariant: "PYMES", updatedAt: new Date() },
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
    })

    await post({ accountCode: "705", creditCents: 600_000, projectId: projectA })
    await post({ accountCode: "705", creditCents: 400_000, projectId: projectB })
    await post({ accountCode: "600", debitCents: 300_000, projectId: projectA })
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
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1::uuid`, [ORG])
      }
      await client.query(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, [ORG])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, [ORG])
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
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1::uuid`, [ORG])
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
          description: "Movimiento E10",
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

  /** Los sellos de HOY, tal y como los deriva la staleness. */
  const sealsNow = () => tenantTransaction(ORG, USER, async (tx) => periodSealsBatch(tx, [YEAR]))

  /** Deriva la staleness del único run vigente del ejercicio. */
  async function stalenessOfSealedRun(): Promise<{ isStale: boolean; reasons: string[] }> {
    const runs = await tenantTransaction(ORG, USER, async (tx) =>
      listAllocationRuns(tx, { fiscalYearId, deriveStaleness: true })
    )
    const sealed = runs.filter((r) => r.status === "SEALED")
    expect(sealed).toHaveLength(1)
    return { isStale: sealed[0].isStale, reasons: sealed[0].staleReasons }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1 · El espejo TS ↔ SQL, que es lo que faltaba
  // ───────────────────────────────────────────────────────────────────────────

  it("espejo TS ↔ SQL · la FORMA canónica de `marginConfigHash` coincide byte a byte", async () => {
    const { formTs, formSql, hashTs, seal } = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: YEAR.periodEnd })
      const forms = await marginConfigFormsBatch(tx, [YEAR])
      const seals = await periodSealsBatch(tx, [YEAR])
      return {
        formTs: canonicalMarginConfigForm(config),
        formSql: forms.get(KEY),
        hashTs: marginConfigHash(config),
        seal: seals.get(KEY),
      }
    })

    // Comparar la FORMA y no sólo el sello: un hash distinto dice que divergen,
    // la forma dice DÓNDE. El defecto de T12 era que `concat_ws` omitía el campo
    // de tipos de los niveles con `analytic_types = '{}'` (MC3 y EBITDA en la
    // configuración por defecto): cuatro campos donde TS escribe cinco.
    expect(formSql).toBe(formTs)
    expect(formTs).toContain("\nMC3\t4\t\t2026-01-01\t∅\n")
    expect(seal?.marginConfigHash).toBe(hashTs)
  })

  it("espejo TS ↔ SQL · el `dimensionsHash` del lote es el del motor, con las MISMAS líneas", async () => {
    const { sqlHash, tsHash } = await tenantTransaction(ORG, USER, async (tx) => {
      const seals = await periodSealsBatch(tx, [YEAR])
      const config = await getAnalyticsConfig(tx, { periodEnd: YEAR.periodEnd })
      const lines = await getAnalyticLines(tx, { from: YEAR.periodStart, to: YEAR.periodEnd, fiscalYearId })
      return {
        sqlHash: seals.get(KEY)?.dimensionsHash,
        tsHash: dimensionsHash(
          lines.map((l) => ({
            entryId: l.entryId,
            lineNo: l.lineNo,
            projectId: l.projectId,
            costCenterId: l.costCenterId,
            businessLineId: l.businessLineId,
            analyticType: l.analyticType,
          })),
          marginConfigHash(config)
        ),
      }
    })
    expect(sqlHash).toBe(tsHash)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2 · Un run sellado está VIGENTE — el hallazgo de C1, al derecho
  // ───────────────────────────────────────────────────────────────────────────

  it("un run recién sellado se deriva VIGENTE, sin un solo motivo", async () => {
    await tenantTransaction(ORG, USER, async (tx) => {
      await createAllocationRuleTx(
        tx,
        {
          code: "AL-GA-Y",
          name: "G&A a proyectos a partes iguales",
          sourceCostCenterId: ceco["CC-GA"],
          targetKind: "PROJECTS",
          driver: "EQUAL",
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
    await tenantTransaction(ORG, USER, async (tx) => sealAllocationRunTx(tx, { ...YEAR, gitSha: "test" }, actor))

    const staleness = await stalenessOfSealedRun()
    // Antes de este lote AQUÍ salía `true` con «se ha reclasificado alguna línea
    // del periodo» sin que nadie hubiera tocado nada.
    expect(staleness.reasons).toEqual([])
    expect(staleness.isStale).toBe(false)
  })

  it("criterio 21 · derivar la staleness de N runs son ≤ 3 consultas, con el log delante", async () => {
    const runs = await tenantTransaction(ORG, USER, async (tx) => listAllocationRuns(tx, { fiscalYearId }))
    const sealed = runs.filter((r) => r.status === "SEALED")
    // Veintidós referencias sobre el mismo run, cinco de ellas con ventana de
    // horas (dos ventanas distintas): el lote agrupa por periodo y por ventana,
    // así que el número de consultas no depende de N.
    const plain = Array.from({ length: 17 }, (_, i) => ({ ...sealed[0], id: `${sealed[0].id}#${i}` }))
    const withWindow = Array.from({ length: 5 }, (_, i) => ({
      ...sealed[0],
      id: `${sealed[0].id}#h${i}`,
      timeHashWindowStart: "2026-01-01" as const,
      timeHashWindowEnd: (i % 2 === 0 ? "2026-06-30" : "2026-12-31") as const,
    }))
    const many = [...plain, ...withWindow]

    const { log, staleness } = await tenantTransaction(ORG, USER, async (tx) => {
      const log: string[] = []
      const counted = new Proxy(tx, {
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
      })
      const staleness = await allocationRunStalenessBatch(counted as typeof tx, many)
      return { log, staleness }
    })

    console.log("consultas del lote:\n" + log.map((q, i) => ` ${i + 1}. ${q}`).join("\n"))
    // TRES: los sellos del periodo, las reglas activas y el `timeHash` de las
    // ventanas. Ni una más, sean 22 referencias o 220.
    expect(log).toHaveLength(3)
    expect(staleness.size).toBe(22)
    for (const run of plain) expect(staleness.get(run.id)).toEqual({ isStale: false, reasons: [] })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3 · Lo que SÍ debe caducar un run
  // ───────────────────────────────────────────────────────────────────────────

  it("un cambio REAL de `MarginLevelConfig` deja el run STALE con causa CONFIGURACIÓN", async () => {
    const before = await sealsNow()
    // Cambio real y contable: lo EXTRAORDINARIO deja de caer en BAI y pasa a
    // MC3. Mueve importe entre niveles sin tocar una sola línea del diario.
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(
        `UPDATE margin_level_configs
            SET analytic_types = ARRAY['FINANCIERO']::analytic_type[], updated_at = now()
          WHERE organization_id = $1::uuid AND level = 'BAI'`,
        [ORG]
      )
      await client.query(
        `UPDATE margin_level_configs
            SET analytic_types = ARRAY['EXTRAORDINARIO']::analytic_type[], updated_at = now()
          WHERE organization_id = $1::uuid AND level = 'MC3'`,
        [ORG]
      )
      await client.query("COMMIT")
    })
    const after = await sealsNow()
    expect(after.get(KEY)?.marginConfigHash).not.toBe(before.get(KEY)?.marginConfigHash)
    // Y el espejo sigue siendo espejo DESPUÉS del cambio.
    const tsAfter = await tenantTransaction(ORG, USER, async (tx) =>
      marginConfigHash(await getAnalyticsConfig(tx, { periodEnd: YEAR.periodEnd }))
    )
    expect(after.get(KEY)?.marginConfigHash).toBe(tsAfter)

    const staleness = await stalenessOfSealedRun()
    expect(staleness.isStale).toBe(true)
    expect(staleness.reasons).toEqual(["ha cambiado la configuración analítica del periodo (niveles de margen o CECOs)"])
  })

  it("y una reclasificación de verdad dice que es una reclasificación, no la configuración", async () => {
    // Se vuelve a liquidar con la configuración nueva: el run pasa a estar
    // VIGENTE otra vez y su sellado es POSTERIOR al cambio de configuración.
    await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(
        tx,
        { ...YEAR, gitSha: "test", supersede: true, reason: "nueva configuración de márgenes" },
        actor
      )
    )
    expect(await stalenessOfSealedRun()).toEqual({ isStale: false, reasons: [] })

    // Reclasificar: la línea de coste directo de P-01 pasa a P-02. No toca el
    // diario (mismo importe, misma cuenta) ni la configuración.
    await owner(async (client) => {
      await client.query(
        `UPDATE journal_lines SET project_id = $2::uuid
          WHERE organization_id = $1::uuid AND account_code = '600' AND project_id = $3::uuid`,
        [ORG, projectB, projectA]
      )
    })

    const staleness = await stalenessOfSealedRun()
    expect(staleness.isStale).toBe(true)
    expect(staleness.reasons).toEqual(["se ha reclasificado alguna línea del periodo"])
  })
})
