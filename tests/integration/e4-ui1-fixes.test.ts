import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E4-UI-1 — los tres bugs que dev-frontend reportó al cerrar la épica
 * (`docs/ESTADO.md` §SIGUIENTE.a), contra Postgres de verdad.
 *
 *  b) una línea 6/7 con CECO y `analytic_type` NULL NO puede tumbar
 *     `/ledger/sumas-saldos`: el motor la resuelve por el default de la cuenta
 *     (R-A4) o la sirve en NO_ANALITICO con I-E4-1 en WARN/FAIL, y el sello del
 *     informe pasa a REQUIERE REVISIÓN en vez de lanzar.
 *  c) el `AuditLog` de `reclassifyLines` con muchas líneas: `entity_id` es
 *     `VARCHAR(64)`, así que se escribe UNA FILA POR LÍNEA más una de resumen,
 *     nunca los ids concatenados. 50 líneas.
 *  ·) la caché de `getAnalyticPnl` es por petición y su clave incluye las
 *     dimensiones: crear un proyecto o reclasificar la invalida.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry, computeLedgerHash, runLedgerInvariants } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { getAnalyticLines, getAnalyticsConfig, reclassifyLines, seedAnalyticsDefaults } = await import(
  "@/models/analytics"
)
const { getAnalyticPnl, analyticPnlCacheKey } = await import("@/models/margins")
const { analyticsHash: computeAnalyticsHash, marginConfigHash } = await import("@/lib/analytics/hash")
const { runAnalyticInvariants } = await import("@/lib/analytics/invariants")
const { reportHeader } = await import("@/app/(app)/ledger/shared")

const ORG = "e4110000-0000-4000-8000-00000000000a"
const USER = "e4110000-0000-4000-8000-0000000000a1"
const actor = { userId: USER }
const REF = "2026-12-31"
const PERIOD = { from: "2026-01-01", to: "2026-12-31" }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E4-UI-1 · robustez del motor analítico, AuditLog y caché", () => {
  let fiscalYearId = ""
  let projectId = ""
  const ceco: Record<string, string> = {}
  /** Ids de las 50 líneas 640 imputadas a CC-GA, para reclasificarlas en bloque. */
  const bulkLineIds: string[] = []

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e4ui1@test.local", name: "E4-UI-1" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e4-ui1-org", name: "E4 UI1", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })

    await importNpgc(ORG, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    fiscalYearId = fy.value.id

    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: USER })
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      projectId = (
        await tx.project.create({
          data: { organizationId: ORG, code: "P-01", name: "Alfa", businessLineId: bl.id, sortOrder: 1 },
        })
      ).id
      for (const c of await tx.costCenter.findMany()) ceco[c.code] = c.id
    })

    // 50 asientos de sueldos imputados a CC-GA: el lote que reventaba el
    // `AuditLog` cuando `entity_id` llevaba los ids concatenados.
    for (let i = 0; i < 50; i++) {
      const draft = await tenantTransaction(ORG, USER, async (tx) => {
        const ctx = await getLedgerContext(tx, REF)
        return buildEntry(
          {
            organizationId: ORG,
            entryDate: "2026-06-10",
            description: `Nómina ${i + 1}`,
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "640", debitCents: 100_000, creditCents: 0, costCenterId: ceco["CC-GA"] },
              { lineNo: 2, accountCode: "465", debitCents: 0, creditCents: 100_000 },
            ],
          },
          ctx
        )
      })
      if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
      const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
      if (!posted.ok) throw new Error(JSON.stringify(posted.errors))
      const line = await prisma.journalLine.findFirstOrThrow({
        where: { organizationId: ORG, entryId: posted.value.id, accountCode: "640" },
      })
      bulkLineIds.push(line.id)
    }
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, [ORG])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, [ORG])
      await client.query("COMMIT")
      for (const table of [
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
      await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    })
  }

  // ── b) el motor analítico no lanza y la pantalla no se cae ────────────────

  it("una línea 6/7 con CECO y `analytic_type` NULL no lanza: se resuelve por R-A4", async () => {
    const victim = bulkLineIds[0]
    await owner(async (client) => {
      await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
      await client.query(`UPDATE journal_lines SET analytic_type = NULL WHERE id = $1::uuid`, [victim])
      await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
    })

    const { checks, pnl } = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: PERIOD.to })
      const lines = await getAnalyticLines(tx, PERIOD)
      expect(lines.some((l) => l.id === victim && l.analyticType === null)).toBe(true)
      return {
        checks: runAnalyticInvariants({ lines, config, period: PERIOD }),
        pnl: await getAnalyticPnl(tx, {
          ...PERIOD,
          provenance: { runId: "run-ui1", gitSha: "c0e828f", baseCurrency: "EUR" },
        }),
      }
    })

    // 640 → INDIRECTO_CECO por el plan; con CC-GA la línea cae en su columna.
    expect(pnl.pnl.unresolved).toEqual([])
    expect(pnl.pnl.matrixCents.EBITDA["CECO:G_A"]).toBe(-5_000_000)
    expect(checks.find((c) => c.id === "I4")?.status).toBe("PASS")
    expect(checks.find((c) => c.id === "I-E4-1")?.status).toBe("PASS")
  })

  it("sin default de cuenta cae en NO_ANALITICO con I-E4-1 en FAIL, y /ledger/sumas-saldos no lanza", async () => {
    const victim = bulkLineIds[0]
    // Se deja la cuenta 640 (y su rama) sin tipo analítico: ya no hay default.
    await owner(async (client) => {
      await client.query(`ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY`)
      await client.query(
        `UPDATE accounts SET analytic_type = NULL WHERE organization_id = $1::uuid AND code IN ('6','64','640')`,
        [ORG]
      )
      await client.query(`ALTER TABLE accounts FORCE ROW LEVEL SECURITY`)
    })

    const { checks, pnl } = await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: PERIOD.to })
      const lines = await getAnalyticLines(tx, PERIOD)
      return {
        checks: runAnalyticInvariants({ lines, config, period: PERIOD }),
        pnl: await getAnalyticPnl(tx, {
          ...PERIOD,
          provenance: { runId: "run-ui1b", gitSha: "c0e828f", baseCurrency: "EUR" },
        }),
      }
    })

    expect(pnl.pnl.unresolved.map((u) => u.code)).toEqual(["TYPE_UNKNOWN"])
    expect(pnl.pnl.matrixCents.EBITDA.NO_ANALITICO).toBe(-100_000)
    // El total NO se pierde: I4 sigue en PASS aunque el dato esté sucio.
    expect(checks.find((c) => c.id === "I4")?.status).toBe("PASS")
    expect(checks.find((c) => c.id === "I-E4-1")?.status).toBe("FAIL")

    // Y la cabecera del informe se sirve: sello REQUIERE REVISIÓN, no excepción.
    const header = await reportHeader(ORG, USER, {
      ...PERIOD,
      baseCurrency: "EUR",
      fiscalYearId,
      refDate: REF,
    })
    expect(header.seal.sello).toBe("REQUIERE REVISIÓN")
    expect(header.seal.motivos.length).toBeGreaterThan(0)
    expect(header.checks.find((c) => c.id === "I-E4-1")?.status).toBe("FAIL")

    // Se restaura el plan y el tipo de la línea para los tests siguientes.
    await owner(async (client) => {
      await client.query(`ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY`)
      await client.query(
        `UPDATE accounts SET analytic_type = 'INDIRECTO_CECO'::analytic_type
          WHERE organization_id = $1::uuid AND code IN ('6','64','640')`,
        [ORG]
      )
      await client.query(`ALTER TABLE accounts FORCE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
      await client.query(
        `UPDATE journal_lines SET analytic_type = 'INDIRECTO_CECO'::analytic_type WHERE id = $1::uuid`,
        [victim]
      )
      await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
    })
  })

  // ── c) AuditLog de una reclasificación de 50 líneas ───────────────────────

  it("reclasificar 50 líneas escribe 51 filas de AuditLog (resumen + una por línea), sin «value too long»", async () => {
    const reason = "Las nóminas del semestre son coste directo del proyecto Alfa"
    const result = await reclassifyLines(
      ORG,
      { reason, targets: bulkLineIds.map((lineId) => ({ lineId, projectId })) },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(result.ok, JSON.stringify(result.ok ? {} : result.errors)).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toHaveLength(50)

    const logs = await prisma.auditLog.findMany({
      where: { organizationId: ORG, entity: "JournalLine", action: "RECLASSIFY_ANALYTICS" },
    })
    expect(logs).toHaveLength(51)
    // Ningún `entityId` es una lista concatenada: todos caben en VARCHAR(64).
    for (const log of logs) {
      expect(log.entityId).not.toContain(",")
      expect(log.entityId.length).toBeLessThanOrEqual(64)
      expect(log.reason).toBe(reason)
      expect(log.userId).toBe(USER)
    }
    // Una fila por línea tocada, direccionable por el id de la línea.
    const porLinea = logs.filter((l) => bulkLineIds.includes(l.entityId))
    expect(porLinea).toHaveLength(50)
    // Y una de resumen con el recuento y el detalle en JSON.
    const resumen = logs.filter((l) => !bulkLineIds.includes(l.entityId))
    expect(resumen).toHaveLength(1)
    expect((resumen[0].after as { lineCount: number }).lineCount).toBe(50)
    expect((resumen[0].after as { lineIds: string[] }).lineIds).toHaveLength(50)

    const movidas = await prisma.journalLine.count({ where: { organizationId: ORG, projectId } })
    expect(movidas).toBe(50)
  }, 120_000)

  // ── caché de getAnalyticPnl: por petición, acotada y con dimensiones ──────

  it("la clave de caché cambia al crear un proyecto y al reclasificar", async () => {
    const keyNow = async (): Promise<string> =>
      await tenantTransaction(ORG, USER, async (tx) => {
        const config = await getAnalyticsConfig(tx, { periodEnd: PERIOD.to })
        const lines = await getAnalyticLines(tx, PERIOD)
        const configHash = marginConfigHash(config)
        return analyticPnlCacheKey({
          organizationId: ORG,
          ...PERIOD,
          fiscalYearId,
          ledgerHash: await computeLedgerHash(tx, { ...PERIOD, fiscalYearId }),
          analyticsHash: computeAnalyticsHash(
            lines.map((l) => ({
              entryId: l.entryId,
              lineNo: l.lineNo,
              projectId: l.projectId,
              costCenterId: l.costCenterId,
              businessLineId: l.businessLineId,
              analyticType: l.analyticType,
            })),
            configHash,
            null
          ),
          marginConfigHash: configHash,
          config,
        })
      })

    const inicial = await keyNow()

    // 1. Alta de proyecto: el diario no cambia, pero la matriz gana una columna.
    const created = await tenantTransaction(ORG, USER, async (tx) =>
      tx.project.create({
        data: {
          organizationId: ORG,
          code: "P-99",
          name: "Gamma",
          businessLineId: (await tx.businessLine.findFirstOrThrow()).id,
          sortOrder: 9,
        },
      })
    )
    const trasProyecto = await keyNow()
    expect(trasProyecto).not.toBe(inicial)

    const conColumna = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, { ...PERIOD, fiscalYearId, provenance: { runId: "r", gitSha: "c0e828f", baseCurrency: "EUR" } })
    )
    expect(conColumna.pnl.columns).toContain("PROJ:P-99")

    // 2. Reclasificar una línea: mismo `ledgerHash`, distinto `analyticsHash`.
    const antesLedger = conColumna.ledgerHash
    const moved = await reclassifyLines(
      ORG,
      { reason: "Una nómina vuelve a estructura general", targets: [{ lineId: bulkLineIds[0], costCenterId: ceco["CC-GA"] }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(moved.ok, JSON.stringify(moved.ok ? {} : moved.errors)).toBe(true)

    const trasReclasificar = await keyNow()
    expect(trasReclasificar).not.toBe(trasProyecto)

    const despues = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, { ...PERIOD, fiscalYearId, provenance: { runId: "r", gitSha: "c0e828f", baseCurrency: "EUR" } })
    )
    expect(despues.ledgerHash).toBe(antesLedger)
    expect(despues.analyticsHash).not.toBe(conColumna.analyticsHash)
    // Y la cifra servida es la nueva, no la cacheada.
    expect(despues.pnl.matrixCents.EBITDA["CECO:G_A"]).toBe(-100_000)
    expect(created.id).toBeTruthy()
  }, 120_000)

  it("la caché no sobrevive a la petición: dos lecturas independientes recalculan", async () => {
    const a = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, { ...PERIOD, fiscalYearId, provenance: { runId: "a", gitSha: "c0e828f", baseCurrency: "EUR" } })
    )
    const b = await tenantTransaction(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, { ...PERIOD, fiscalYearId, provenance: { runId: "b", gitSha: "c0e828f", baseCurrency: "EUR" } })
    )
    // Mismas cifras (determinismo, I-E4-8) pero provenance del run que las pidió:
    // si la caché hubiera sobrevivido, `b` traería el `run_id` de `a`.
    expect(b.pnl.levelTotalsCents).toEqual(a.pnl.levelTotalsCents)
    const cell = [...b.pnl.provenance.values()][0]
    expect(cell.run_id).toBe("b")
  })

  it("runLedgerInvariants no lanza y expone el bloque analítico completo", async () => {
    const run = await runLedgerInvariants(ORG, { refDate: REF, fiscalYearId, actor, noCache: true })
    expect(run.validacion.checks.map((c) => c.id)).toContain("I-E4-1")
    expect(run.validacion.checks.find((c) => c.id === "I4")?.status).toBe("PASS")
  }, 120_000)
})
