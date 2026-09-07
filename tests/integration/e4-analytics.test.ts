import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// E7 · ADR-0015 D1: `journal_lines` es `bigint` en la base. Este fichero lee
// filas EN CRUDO de Prisma (no por `models/ledger.ts`), así que tiene que
// cruzar el borde igual que lo cruza la aplicación.
import { centsFromDb } from "@/lib/money"

/**
 * E4 · T16 — Integración de la analítica contra Postgres de verdad
 * (`docs/design/E4-analitica.md` §8.1, criterios 1–7 y 11–16).
 *
 * Lo que se ejerce aquí y no se puede ejercer con funciones puras:
 *  - C-9 muerde en el posteo, y la BD lo repite con FK compuesta y CHECK.
 *  - la reclasificación analítica (ADR-0010): `ledgerHash` intacto, `entryHash`
 *    recalculado, `analyticsHash` distinto, `AuditLog` y ventana por rol.
 *  - I4 sobre el fixture completo cargado en la BD = 0.
 *
 * La suite conecta con el rol PROPIETARIO: aquí se ejercen la lógica y los
 * triggers. La RLS efectiva se ejerce en `tests/integration-rls/e4-tenant.test.ts`.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod } = await import("@/models/period-locks")
const { computeLedgerHash, getLedgerContext, postEntry, voidEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const {
  getAnalyticsConfig,
  getAnalyticLines,
  reclassifyLines,
  seedAnalyticsDefaults,
  updateAccountAnalyticType,
} = await import("@/models/analytics")
const { getAnalyticPnl, getCellDetail } = await import("@/models/margins")
const { runAnalyticInvariants, checkIE411 } = await import("@/lib/analytics/invariants")
const { marginConfigHash, analyticsHash } = await import("@/lib/analytics/hash")
const { entryHash } = await import("@/lib/ledger/hash")

const ORG = "e4000000-0000-4000-8000-00000000000a"
const ORG_FULL = "e4000000-0000-4000-8000-00000000000b"
const ORG_OTHER = "e4000000-0000-4000-8000-00000000000c"
const ORG_RELAXED = "e4000000-0000-4000-8000-00000000000d"
const USER = "e4000000-0000-4000-8000-0000000000a1"
const ALL_ORGS = [ORG, ORG_FULL, ORG_OTHER, ORG_RELAXED]

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

describe.skipIf(!TEST_DATABASE_URL)("E4 · analítica en base de datos", () => {
  let fiscalYearId = ""
  let projectId = ""
  let otherProjectId = ""
  let foreignProjectId = ""
  const ceco: Record<string, string> = {}

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e4@test.local", name: "E4" } })
    await prisma.organization.createMany({
      data: ALL_ORGS.map((id, index) => ({
        id,
        slug: `e4-org-${index}`,
        name: `E4 Org ${index}`,
        pgcVariant: "PYMES" as const,
        updatedAt: new Date(),
      })),
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })

    for (const organizationId of [ORG, ORG_OTHER, ORG_RELAXED]) {
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
      const bl2 = await tx.businessLine.create({
        data: { organizationId: ORG, code: "BL-DEV", name: "Desarrollo", sortOrder: 2 },
      })
      projectId = (
        await tx.project.create({
          data: { organizationId: ORG, code: "P-01", name: "Alfa", businessLineId: bl.id, sortOrder: 1 },
        })
      ).id
      otherProjectId = (
        await tx.project.create({
          data: { organizationId: ORG, code: "P-02", name: "Beta", businessLineId: bl2.id, sortOrder: 2 },
        })
      ).id
      for (const c of await tx.costCenter.findMany()) ceco[c.code] = c.id
    })

    await tenantTransaction(ORG_OTHER, USER, async (tx) => {
      const bl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
      foreignProjectId = (
        await tx.project.create({
          data: { organizationId: ORG_OTHER, code: "P-AJENO", name: "Ajeno", businessLineId: bl.id },
        })
      ).id
    })

    await tenantTransaction(ORG_RELAXED, USER, async (tx) => {
      await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${ORG_RELAXED}::uuid`
    })
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
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
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      }
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    })
  }

  /** Factura de servicio: `430` al debe, `705` al haber con el destino dado. */
  async function invoiceDraft(
    organizationId: string,
    dest: { projectId?: string; costCenterId?: string },
    opts: { entryDate?: string; accountCode?: string } = {}
  ) {
    return await tenantTransaction(organizationId, USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId,
          entryDate: opts.entryDate ?? "2026-03-10",
          description: "Factura de servicios",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "4300", debitCents: 100_000, creditCents: 0 },
            {
              lineNo: 2,
              accountCode: opts.accountCode ?? "705",
              debitCents: opts.accountCode ? 100_000 : 0,
              creditCents: opts.accountCode ? 0 : 100_000,
              projectId: dest.projectId ?? null,
              costCenterId: dest.costCenterId ?? null,
            },
            ...(opts.accountCode
              ? [{ lineNo: 3, accountCode: "4300", debitCents: 0, creditCents: 200_000 }]
              : []),
          ],
        },
        ctx
      )
    })
  }

  // ── Criterio 1 y 2 · C-9 muerde, y CC-NA con la regla relajada ────────────

  it("criterio 1 · sin destino y con `analyticsRequired`: ANALYTIC_DEST_MISSING y no avanza el número", async () => {
    const before = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } })
    const draft = await invoiceDraft(ORG, {})
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_DEST_MISSING")
    expect(draft.errors[0].lineNo).toBe(2)
    const after = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } })
    expect(after.lastEntryNumber).toBe(before.lastEntryNumber)
  })

  it("criterio 2 · con `analyticsRequired = false` la línea acaba en CC-NA (R-A8)", async () => {
    const draft = await invoiceDraft(ORG_RELAXED, {})
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    const posted = await postEntry(ORG_RELAXED, draft.value, actor, { refDate: REF })
    expect(posted.ok, JSON.stringify(posted)).toBe(true)
    if (!posted.ok) return
    const line = posted.value.lines.find((l) => l.accountCode === "705")
    const unassigned = await tenantTransaction(ORG_RELAXED, USER, async (tx) =>
      tx.costCenter.findFirstOrThrow({ where: { code: "CC-NA" } })
    )
    expect(line?.costCenterId).toBe(unassigned.id)
    // R-A4: una cuenta de tipo directo posteada a un CECO es indirecta de hecho.
    expect(line?.analyticType).toBe("INDIRECTO_CECO")
  })

  // ── Criterio 3 y 4 · overrides implícitos R-A3 / R-A4 ─────────────────────

  it("criterio 3 · R-A3: `623` con proyecto se persiste como COSTE_DIRECTO_MC2", async () => {
    const draft = await invoiceDraft(ORG, { projectId }, { accountCode: "623" })
    expect(draft.ok, JSON.stringify(draft)).toBe(true)
    if (!draft.ok) return
    const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
    expect(posted.ok, JSON.stringify(posted)).toBe(true)
    if (!posted.ok) return
    const line = posted.value.lines.find((l) => l.accountCode === "623")
    expect(line?.analyticType).toBe("COSTE_DIRECTO_MC2")
    expect(line?.projectId).toBe(projectId)
  })

  it("criterio 4 · R-A4: `640` con CECO se persiste como INDIRECTO_CECO", async () => {
    const draft = await invoiceDraft(ORG, { costCenterId: ceco["CC-GA"] }, { accountCode: "640" })
    expect(draft.ok, JSON.stringify(draft)).toBe(true)
    if (!draft.ok) return
    const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
    expect(posted.ok).toBe(true)
    if (!posted.ok) return
    const line = posted.value.lines.find((l) => l.accountCode === "640")
    expect(line?.analyticType).toBe("INDIRECTO_CECO")
    expect(line?.businessLineId).toBeNull()
  })

  // ── Criterio 5 · R-A1 e I-E4-4 ────────────────────────────────────────────

  it("criterio 5 · una línea de `430` con proyecto: la rechaza el motor y, sin motor, el CHECK", async () => {
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: "2026-03-10",
          description: "IVA con destino",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "4300", debitCents: 1_000, creditCents: 0, projectId },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 1_000, projectId },
          ],
        },
        ctx
      )
    })
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_DIM_ON_NON_PNL")

    // Saltándose el motor: el CHECK de la BD dice lo mismo.
    await expect(
      owner(async (client) =>
        client.query(
          `UPDATE journal_lines SET project_id = $1::uuid
            WHERE organization_id = $2::uuid AND account_code = '4300' LIMIT 0`,
          [projectId, ORG]
        )
      )
    ).rejects.toThrow()
  })

  it("criterio 5 · `6300` (NO_ANALITICO) con CECO: ANALYTIC_DIM_ON_NON_ANALYTIC", async () => {
    const draft = await invoiceDraft(ORG, { costCenterId: ceco["CC-GA"] }, { accountCode: "6300" })
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_DIM_ON_NON_ANALYTIC")
  })

  // ── Criterio 6 · destino excluyente y del tenant ──────────────────────────

  it("criterio 6 · proyecto de otra organización: ANALYTIC_DEST_UNKNOWN y, sin motor, 23503", async () => {
    const draft = await invoiceDraft(ORG, { projectId: foreignProjectId })
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_DEST_UNKNOWN")

    const line = await prisma.journalLine.findFirstOrThrow({
      where: { organizationId: ORG, accountCode: "623" },
    })
    await expect(
      owner(async (client) => {
        await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
        try {
          await client.query(`UPDATE journal_lines SET project_id = $1::uuid WHERE id = $2::uuid`, [
            foreignProjectId,
            line.id,
          ])
        } finally {
          await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
        }
      })
    ).rejects.toThrow(/23503|foreign key|línea de negocio/)
  })

  it("criterio 6 · proyecto Y CECO a la vez: ANALYTIC_DEST_BOTH y, sin motor, el CHECK xor", async () => {
    const draft = await invoiceDraft(ORG, { projectId, costCenterId: ceco["CC-GA"] })
    expect(draft.ok).toBe(false)
    if (draft.ok) return
    expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_DEST_BOTH")

    const line = await prisma.journalLine.findFirstOrThrow({
      where: { organizationId: ORG, accountCode: "623" },
    })
    await expect(
      owner(async (client) =>
        client.query(`UPDATE journal_lines SET cost_center_id = $1::uuid WHERE id = $2::uuid`, [ceco["CC-GA"], line.id])
      )
    ).rejects.toThrow(/journal_lines_analytic_dest_xor|23514/)
  })

  // ── Criterio 7 · denormalización de la línea de negocio (R-A9) ────────────

  it("criterio 7 · `business_line_id` es el del proyecto; desalinearlo por SQL da 23514", async () => {
    const line = await prisma.journalLine.findFirstOrThrow({
      where: { organizationId: ORG, accountCode: "623" },
    })
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(line.businessLineId).toBe(project.businessLineId)

    const otherProject = await prisma.project.findUniqueOrThrow({ where: { id: otherProjectId } })
    await expect(
      owner(async (client) =>
        client.query(`UPDATE journal_lines SET business_line_id = $1::uuid WHERE id = $2::uuid`, [
          otherProject.businessLineId,
          line.id,
        ])
      )
    ).rejects.toThrow(/no coincide con la del proyecto|23514/)
  })

  // ── Criterio 11 y 12 · reclasificación (E4-D2 y ventana) ──────────────────

  it("criterio 11 · reclasificar: `ledgerHash` intacto, `entryHash` y `analyticsHash` distintos, AuditLog", async () => {
    const line = await prisma.journalLine.findFirstOrThrow({
      where: { organizationId: ORG, accountCode: "623" },
      include: { entry: true },
    })
    const before = {
      ledgerHash: await tenantTransaction(ORG, USER, async (tx) => computeLedgerHash(tx, { fiscalYearId })),
      entryHash: line.entry.entryHash,
      analyticsHash: await analyticsHashOf(),
    }

    const result = await reclassifyLines(
      ORG,
      { reason: "El gasto pertenece al proyecto Beta, no al Alfa", targets: [{ lineId: line.id, projectId: otherProjectId }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.value.applied).toHaveLength(1)

    const after = {
      ledgerHash: await tenantTransaction(ORG, USER, async (tx) => computeLedgerHash(tx, { fiscalYearId })),
      entryHash: (await prisma.journalEntry.findUniqueOrThrow({ where: { id: line.entryId } })).entryHash,
      analyticsHash: await analyticsHashOf(),
    }

    // El sello FINANCIERO no se mueve: balance, PyG contable, cashflow y diario
    // ya sellados siguen vigentes (E4-D2).
    expect(after.ledgerHash).toBe(before.ledgerHash)
    // El sello DE FILA sí: I-E3-7 sigue en PASS porque se recalcula.
    expect(after.entryHash).not.toBe(before.entryHash)
    expect(after.analyticsHash).not.toBe(before.analyticsHash)

    // I-E3-7 recomputado sobre las líneas leídas.
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: line.entryId },
      include: { lines: true },
    })
    expect(
      entryHash(
        entry.lines.map((l) => ({
          entryId: entry.id,
          entryNumber: entry.entryNumber,
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          // E7 · ADR-0015 D1: leído en crudo de Prisma llega como `BigInt`;
          // el motor sólo admite `number` y el borde es quien convierte.
          debitCents: centsFromDb(l.debitCents),
          creditCents: centsFromDb(l.creditCents),
          entryDate: l.entryDate.toISOString().slice(0, 10),
          fiscalYearId: l.fiscalYearId,
          entryKind: l.entryKind,
          taxRateId: l.taxRateId,
          taxBaseCents: l.taxBaseCents,
          counterpartyId: l.counterpartyId,
          dueDate: l.dueDate ? l.dueDate.toISOString().slice(0, 10) : null,
          description: l.description,
          analyticType: l.analyticType,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
        }))
      )
    ).toBe(entry.entryHash)

    // La línea de negocio se ha movido con el proyecto (R-A9 en el destino).
    const moved = await prisma.journalLine.findUniqueOrThrow({ where: { id: line.id } })
    const otherProject = await prisma.project.findUniqueOrThrow({ where: { id: otherProjectId } })
    expect(moved.projectId).toBe(otherProjectId)
    expect(moved.businessLineId).toBe(otherProject.businessLineId)

    const log = await prisma.auditLog.findFirst({
      where: { organizationId: ORG, entity: "JournalLine", action: "RECLASSIFY_ANALYTICS" },
      orderBy: { ts: "desc" },
    })
    expect(log?.reason).toBe("El gasto pertenece al proyecto Beta, no al Alfa")
    expect(log?.userId).toBe(USER)
  })

  it("criterio 12 · motivo corto rechazado; mes bloqueado: EDITOR no, ADMIN sí", async () => {
    const line = await prisma.journalLine.findFirstOrThrow({
      where: { organizationId: ORG, accountCode: "640" },
    })
    const short = await reclassifyLines(
      ORG,
      { reason: "malo", targets: [{ lineId: line.id, costCenterId: ceco["CC-MKT"] }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(short.ok).toBe(false)

    // El bloqueo es secuencial (E3): enero, febrero y marzo.
    for (const month of [1, 2, 3]) {
      const locked = await lockPeriod(ORG, { fiscalYearId, month, reason: "cierre mensual" }, actor)
      expect(locked.ok, JSON.stringify(locked)).toBe(true)
    }

    const asEditor = await reclassifyLines(
      ORG,
      { reason: "Reparto de marketing acordado en comité", targets: [{ lineId: line.id, costCenterId: ceco["CC-MKT"] }] },
      { userId: USER, role: "EDITOR" },
      { refDate: REF }
    )
    expect(asEditor.ok).toBe(false)
    if (!asEditor.ok) expect(asEditor.errors[0].code).toBe("MONTH_LOCKED")

    const asAdmin = await reclassifyLines(
      ORG,
      { reason: "Reparto de marketing acordado en comité", targets: [{ lineId: line.id, costCenterId: ceco["CC-MKT"] }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(asAdmin.ok, JSON.stringify(asAdmin)).toBe(true)
  })

  it("criterio 12 · con el ejercicio CLOSED lo corta el trigger, saltándose la acción", async () => {
    const line = await prisma.journalLine.findFirstOrThrow({ where: { organizationId: ORG, accountCode: "640" } })
    await owner(async (client) => {
      await client.query(`UPDATE fiscal_years SET status = 'CLOSED' WHERE id = $1::uuid`, [fiscalYearId])
    })
    try {
      await expect(
        owner(async (client) =>
          client.query(`UPDATE journal_lines SET cost_center_id = $1::uuid WHERE id = $2::uuid`, [
            ceco["CC-OTR"],
            line.id,
          ])
        )
      ).rejects.toThrow(/ejercicio está cerrado|23514/)
    } finally {
      await owner(async (client) => {
        await client.query(`UPDATE fiscal_years SET status = 'OPEN' WHERE id = $1::uuid`, [fiscalYearId])
      })
    }
  })

  // ── Criterio 13 · el REVERSAL hereda el destino y no pasa validateAnalytics ─

  it("criterio 13 · el contra-asiento copia la dimensión aunque el proyecto se cierre", async () => {
    const draft = await invoiceDraft(ORG, { projectId }, { accountCode: "621", entryDate: "2026-06-10" })
    expect(draft.ok, JSON.stringify(draft)).toBe(true)
    if (!draft.ok) return
    const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
    expect(posted.ok, JSON.stringify(posted)).toBe(true)
    if (!posted.ok) return

    await tenantTransaction(ORG, USER, async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { status: "CLOSED", closedAt: new Date("2026-06-30") },
      })
    })

    const voided = await voidEntry(ORG, posted.value.id, "Anulación por error material del documento", actor, {
      refDate: REF,
    })
    expect(voided.ok, JSON.stringify(voided)).toBe(true)
    if (!voided.ok) return
    const mirror = voided.value.reversal.lines.find((l) => l.accountCode === "621")
    const original = posted.value.lines.find((l) => l.accountCode === "621")
    expect(mirror?.projectId).toBe(original?.projectId)
    expect(mirror?.analyticType).toBe(original?.analyticType)
    expect(mirror?.businessLineId).toBe(original?.businessLineId)

    await tenantTransaction(ORG, USER, async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { status: "ACTIVE", closedAt: null } })
    })
  })

  // ── Criterio 15 y 16 · nada se borra, y MarginLevelConfig ────────────────

  it("criterio 15 · un proyecto con líneas no se borra: DIMENSION_IN_USE", async () => {
    const { deleteProject, DimensionInUseError } = await import("@/models/projects")
    const { tenantDb } = await import("@/lib/db")
    await expect(deleteProject(tenantDb(ORG), "P-02")).rejects.toBeInstanceOf(DimensionInUseError)
  })

  it("criterio 16 · MLC-2: guardar INDIRECTO_CECO en MC3 lo rechaza el CHECK de la BD", async () => {
    await expect(
      owner(async (client) =>
        client.query(
          `UPDATE margin_level_configs SET analytic_types = ARRAY['INDIRECTO_CECO']::analytic_type[]
            WHERE organization_id = $1::uuid AND level = 'MC3'`,
          [ORG]
        )
      )
    ).rejects.toThrow(/margin_level_configs_no_indirect_list|23514/)
  })

  it("O-A9 · cambiar el `analyticType` de una cuenta exige motivo y deja AuditLog", async () => {
    const result = await (
      await import("@/models/ledger")
    ).runLedgerTransaction(ORG, USER, async (tx) =>
      updateAccountAnalyticType(tx, "629", "COSTE_DIRECTO_MC2", "Los eventos se facturan al cliente", { userId: USER })
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const log = await prisma.auditLog.findFirst({
      where: { organizationId: ORG, entity: "LedgerAccount", action: "update" },
      orderBy: { ts: "desc" },
    })
    expect(log?.reason).toBe("Los eventos se facturan al cliente")
  })

  // ── Criterio 8 · el fixture completo en la BD: I4 = 0 ─────────────────────

  it(
    "criterio 8 · fixture completo cargado en la BD: I4 en PASS y RESULTADO = 1 497 322",
    async () => {
      const report = await loadFixtureIntoOrg({ organizationId: ORG_FULL, fixture: "ejercicio-completo", userId: USER })
      expect(report.mismatches).toEqual([])

      const result = await tenantTransaction(ORG_FULL, USER, async (tx) => {
        const config = await getAnalyticsConfig(tx, { periodEnd: "2026-12-31" })
        const lines = await getAnalyticLines(tx, { from: "2026-01-01", to: "2026-12-31" })
        const checks = runAnalyticInvariants({
          lines,
          config,
          period: { from: "2026-01-01", to: "2026-12-31" },
        })
        const pnl = await getAnalyticPnl(tx, {
          from: "2026-01-01",
          to: "2026-12-31",
          provenance: { runId: "run-e4", gitSha: "c0e828f", baseCurrency: "EUR" },
        })
        return { checks, pnl }
      })

      const bad = result.checks.filter((c) => c.status !== "PASS" && c.status !== "INFO")
      expect(bad.map((c) => `${c.id}: ${c.evidencia}`)).toEqual([])
      expect(result.pnl.pnl.levelTotalsCents.RESULTADO).toBe(1_497_322)
      expect(result.pnl.pnl.levelTotalsCents.BAI).toBe(1_996_430)
      expect(result.pnl.pnl.levelTotalsCents.MC3).toBe(3_084_110)
      expect(result.pnl.pnl.lineCount67).toBe(85)
      expect(result.pnl.ledgerHash).toHaveLength(64)
      expect(result.pnl.analyticsHash).toHaveLength(64)
    },
    300_000
  )

  it("criterio 11 · ninguna fila lleva una forma canónica que no sepamos verificar", async () => {
    // E4 dejó TODO el histórico en `hash_version = 2` y este criterio lo
    // comprobaba con un `<> 2`. Desde E8 · T2b conviven la v2 (lo ya escrito) y
    // la v3 (lo que nace con divisa, ADR-0014 D2), así que lo que hay que
    // defender ya no es «todas son 2» —eso sería negar la convivencia— sino que
    // no aparezca una versión que ni el código ni el SQL saben recomponer.
    const rows = await owner(async (client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM journal_entries WHERE hash_version NOT IN (2, 3)`)
    )
    expect(rows.rows[0].n).toBe(0)
  })

  // ── Revisión ronda 1 ──────────────────────────────────────────────────────

  it("BLOQUEA #2 · un contra-asiento no se reclasifica, y su original anulado tampoco", async () => {
    // Se postea un gasto con destino, se anula, y se intenta mover cualquiera
    // de las dos patas. I-E4-11 tiene que seguir en PASS después.
    const draft = await invoiceDraft(ORG, { projectId: otherProjectId }, { accountCode: "629", entryDate: "2026-07-10" })
    expect(draft.ok, JSON.stringify(draft)).toBe(true)
    if (!draft.ok) return
    const posted = await postEntry(ORG, draft.value, actor, { refDate: REF })
    expect(posted.ok, JSON.stringify(posted)).toBe(true)
    if (!posted.ok) return
    const voided = await voidEntry(ORG, posted.value.id, "Anulación por duplicado del proveedor", actor, {
      refDate: REF,
    })
    expect(voided.ok, JSON.stringify(voided)).toBe(true)
    if (!voided.ok) return

    const originalLine = await prisma.journalLine.findFirstOrThrow({
      where: { entryId: posted.value.id, accountCode: "629" },
    })
    const reversalLine = await prisma.journalLine.findFirstOrThrow({
      where: { entryId: voided.value.reversal.id, accountCode: "629" },
    })

    // (a) El contra-asiento: rechazado por la acción…
    const onReversal = await reclassifyLines(
      ORG,
      { reason: "Mover el contra-asiento a otro proyecto", targets: [{ lineId: reversalLine.id, projectId }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(onReversal.ok).toBe(false)
    if (!onReversal.ok) expect(onReversal.errors[0].message).toMatch(/contra-asiento/)

    // … y, saltándose la acción, por el trigger. Se mueve también
    // `business_line_id` para que el UPDATE sea coherente y llegue de verdad al
    // trigger de ventana, en vez de pararse antes en el de denormalización.
    const targetBl = (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).businessLineId
    await expect(
      owner(async (client) =>
        client.query(
          `UPDATE journal_lines SET project_id = $1::uuid, business_line_id = $2::uuid WHERE id = $3::uuid`,
          [projectId, targetBl, reversalLine.id]
        )
      )
    ).rejects.toThrow(/contra-asiento hereda el destino/)

    // (b) El original anulado: mismo rechazo por los dos caminos.
    const onVoided = await reclassifyLines(
      ORG,
      { reason: "Mover el asiento anulado a otro proyecto", targets: [{ lineId: originalLine.id, projectId }] },
      { userId: USER, role: "ADMIN" },
      { refDate: REF }
    )
    expect(onVoided.ok).toBe(false)
    if (!onVoided.ok) expect(onVoided.errors[0].message).toMatch(/anulado/)

    await expect(
      owner(async (client) =>
        client.query(
          `UPDATE journal_lines SET project_id = $1::uuid, business_line_id = $2::uuid WHERE id = $3::uuid`,
          [projectId, targetBl, originalLine.id]
        )
      )
    ).rejects.toThrow(/está anulado/)

    // I-E4-11 sigue en PASS: el par no se ha movido.
    const entries = await tenantTransaction(ORG, USER, async (tx) =>
      tx.journalEntry.findMany({ where: { id: { in: [posted.value.id, voided.value.reversal.id] } }, include: { lines: true } })
    )
    const asPosted = entries.map((e) => ({
      id: e.id,
      organizationId: e.organizationId,
      fiscalYearId: e.fiscalYearId,
      entryNumber: e.entryNumber,
      entryDate: e.entryDate.toISOString().slice(0, 10),
      description: e.description,
      kind: e.kind,
      taxRoundingMode: e.taxRoundingMode,
      sourceType: e.sourceType,
      reversesEntryId: e.reversesEntryId,
      lines: e.lines.map((l) => ({
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debitCents: centsFromDb(l.debitCents),
        creditCents: centsFromDb(l.creditCents),
        analyticType: l.analyticType,
        projectId: l.projectId,
        costCenterId: l.costCenterId,
        businessLineId: l.businessLineId,
        entryDate: l.entryDate.toISOString().slice(0, 10),
        fiscalYearId: l.fiscalYearId,
        entryKind: l.entryKind,
      })),
    }))
    expect(checkIE411(asPosted).status).toBe("PASS")
  })

  it("#4 · el recálculo SQL de `entry_hash` coincide con `lib/ledger/hash.ts` en TODO el diario", async () => {
    const entries = await prisma.journalEntry.findMany({
      where: { organizationId: { in: [ORG, ORG_FULL, ORG_RELAXED] } },
      include: { lines: true },
    })
    expect(entries.length).toBeGreaterThan(80)

    const bySql = await owner(async (client) =>
      client.query<{ id: string; hash: string; stored: string; version: number }>(
        `SELECT id, app.journal_entry_hash(id) AS hash, entry_hash AS stored, hash_version AS version
           FROM journal_entries WHERE organization_id = ANY($1::uuid[])`,
        [[ORG, ORG_FULL, ORG_RELAXED]]
      )
    )
    const sqlById = new Map(bySql.rows.map((r) => [r.id, r]))

    for (const e of entries) {
      const ts = entryHash(
        e.lines.map((l) => ({
          entryId: e.id,
          entryNumber: e.entryNumber,
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          // E7 · ADR-0015 D1: leído en crudo de Prisma llega como `BigInt`;
          // el motor sólo admite `number` y el borde es quien convierte.
          debitCents: centsFromDb(l.debitCents),
          creditCents: centsFromDb(l.creditCents),
          entryDate: l.entryDate.toISOString().slice(0, 10),
          fiscalYearId: l.fiscalYearId,
          entryKind: l.entryKind,
          taxRateId: l.taxRateId,
          taxBaseCents: l.taxBaseCents,
          counterpartyId: l.counterpartyId,
          dueDate: l.dueDate ? l.dueDate.toISOString().slice(0, 10) : null,
          description: l.description,
          analyticType: l.analyticType,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
          // E8 · T2b: las tres columnas de divisa entran en la forma v3.
          originalCurrency: l.originalCurrency,
          originalAmountCents: l.originalAmountCents,
          exchangeRateId: l.exchangeRateId,
        })),
        // Cada fila se verifica con SU forma canónica: v2 para el histórico,
        // v3 para lo que nace desde E8. Mezclarlas daría un falso FAIL de
        // I-E3-7 sin que nadie haya tocado un céntimo (riesgo R5).
        e.hashVersion === 2 ? 2 : 3
      )
      const row = sqlById.get(e.id)
      expect(row, `asiento ${e.entryNumber}`).toBeDefined()
      // Los tres caminos coinciden: TypeScript, SQL y lo almacenado (I-E3-7).
      expect(row?.hash, `SQL vs TS en el asiento ${e.entryNumber}`).toBe(ts)
      expect(row?.stored, `almacenado vs TS en el asiento ${e.entryNumber}`).toBe(ts)
      // E8 · T2b: `postEntryTx` sella en v3 y la fila lo DECLARA.
      expect(row?.version).toBe(3)
    }
  })

  it("#8 · escribir un `entry_hash` que no es el de sus líneas lo corta el trigger", async () => {
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { organizationId: ORG } })
    await expect(
      owner(async (client) =>
        client.query(`UPDATE journal_entries SET entry_hash = $1 WHERE id = $2::uuid`, ["0".repeat(64), entry.id])
      )
    ).rejects.toThrow(/entry_hash sólo admite el sello recalculado|23514/)
    // El valor correcto sí pasa: es lo que hace la reclasificación.
    await owner(async (client) =>
      client.query(`UPDATE journal_entries SET entry_hash = app.journal_entry_hash(id) WHERE id = $1::uuid`, [entry.id])
    )
  })

  it("#7 · una línea NO_ANALITICO con dimensión la corta el CHECK de la BD", async () => {
    /**
     * **Determinismo (E7 · ronda 1).** `findFirstOrThrow` sin `orderBy` deja que
     * Postgres devuelva la fila que quiera, y el orden físico cambia según lo
     * que haya hecho el resto de la suite: en una ejecución completa podía tocar
     * la línea de un asiento ANULADO, cuyo `UPDATE` bloquea otro trigger
     * («reclasificarlo rompería el espejo con su contra-asiento», I-E4-11) y el
     * test fallaba con un mensaje que no era el que buscaba. Se elige la línea
     * de forma determinista y sobre un asiento vivo, que es lo que el CHECK que
     * se quiere ejercer necesita.
     */
    const reversals = await prisma.journalEntry.findMany({
      where: { organizationId: ORG, reversesEntryId: { not: null } },
      select: { id: true, reversesEntryId: true },
    })
    const excluded = [...reversals.map((r) => r.id), ...reversals.map((r) => r.reversesEntryId as string)]
    const line = await prisma.journalLine.findFirstOrThrow({
      where: {
        organizationId: ORG,
        accountCode: "4300",
        entry: { voidedAt: null, id: { notIn: excluded } },
      },
      orderBy: [{ entryDate: "asc" }, { lineNo: "asc" }, { id: "asc" }],
    })
    await expect(
      owner(async (client) =>
        client.query(
          `UPDATE journal_lines SET analytic_type = 'NO_ANALITICO', cost_center_id = $1::uuid WHERE id = $2::uuid`,
          [ceco["CC-GA"], line.id]
        )
      )
    ).rejects.toThrow(/journal_lines_non_analytic_has_no_dimension|journal_lines_analytics_only_pnl/)
  })

  it("#3 · la consulta de provenance de tres celdas reproduce el valor mostrado", async () => {
    const result = await tenantTransaction(ORG_FULL, USER, async (tx) => {
      const report = await getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        provenance: { runId: "run-prov", gitSha: "c0e828f", baseCurrency: "EUR" },
      })
      const cells: { key: string; shown: number; fromQuery: number; query: string }[] = []
      for (const [level, column] of [
        ["MC2", "PROJ:P-01"],
        ["EBITDA", "CECO:G_A"],
        ["RESULTADO", "NO_ANALITICO"],
      ] as const) {
        const detail = await getCellDetail(tx, { level, column, from: "2026-01-01", to: "2026-12-31" })
        cells.push({
          key: `${level}|${column}`,
          shown: report.pnl.matrixCents[level][column],
          fromQuery: detail.amountCents,
          query: detail.query,
        })
      }
      return { cells, provenance: report.pnl.provenance }
    })

    for (const cell of result.cells) {
      // La celda es CUMULATIVA y la consulta la reproduce EXACTAMENTE.
      expect(cell.fromQuery, cell.key).toBe(cell.shown)
      // Y va parametrizada: ni un solo literal de negocio interpolado.
      expect(cell.query).not.toMatch(/P-01|CC-GA/)
    }
    expect(result.cells.find((c) => c.key === "MC2|PROJ:P-01")?.shown).toBe(316_000)
    expect(result.cells.find((c) => c.key === "EBITDA|CECO:G_A")?.shown).toBe(-633_180)
    expect(result.cells.find((c) => c.key === "RESULTADO|NO_ANALITICO")?.shown).toBe(-499_108)

    const prov = result.provenance.get("EBITDA|CECO:G_A")
    expect(prov?.registros_origen).toContain("cost_center_id = ANY($4::uuid[])")
    expect(Array.isArray(prov?.parametros[3])).toBe(true)
  })

  it("QA · postear a un proyecto CLOSED: sólo ADMIN con motivo, y queda en AuditLog", async () => {
    await tenantTransaction(ORG, USER, async (tx) => {
      await tx.project.update({
        where: { id: otherProjectId },
        data: { status: "CLOSED", closedAt: new Date("2026-08-01") },
      })
    })
    try {
      const build = async (override?: { role: "ADMIN" | "EDITOR"; reason: string }) =>
        await tenantTransaction(ORG, USER, async (tx) => {
          const ctx = await getLedgerContext(tx, REF)
          return buildEntry(
            {
              organizationId: ORG,
              entryDate: "2026-09-10",
              description: "Última factura del subcontratista",
              kind: "NORMAL",
              sourceType: "MANUAL",
              lines: [
                { lineNo: 1, accountCode: "607", debitCents: 50_000, creditCents: 0, projectId: otherProjectId },
                { lineNo: 2, accountCode: "4000", debitCents: 0, creditCents: 50_000 },
              ],
            },
            ctx,
            override ? { closedProjectOverride: override } : {}
          )
        })

      // Sin excepción: bloqueado.
      const plain = await build()
      expect(plain.ok).toBe(false)
      if (!plain.ok) expect(plain.errors[0].code).toBe("ANALYTIC_PROJECT_CLOSED")

      // EDITOR con motivo: sigue bloqueado (la excepción es de ADMIN).
      const asEditor = await build({ role: "EDITOR", reason: "Llega tarde la factura del subcontratista" })
      expect(asEditor.ok).toBe(false)

      // ADMIN con motivo corto: bloqueado.
      const shortReason = await build({ role: "ADMIN", reason: "tarde" })
      expect(shortReason.ok).toBe(false)

      // ADMIN con motivo: pasa, y el motivo queda en el AuditLog del asiento.
      const reason = "Última certificación del subcontratista, posterior al cierre del proyecto"
      const ok = await build({ role: "ADMIN", reason })
      expect(ok.ok, JSON.stringify(ok)).toBe(true)
      if (!ok.ok) return
      const posted = await postEntry(ORG, ok.value, actor, {
        refDate: REF,
        check: { closedProjectOverride: { role: "ADMIN", reason } },
      })
      expect(posted.ok, JSON.stringify(posted)).toBe(true)
      if (!posted.ok) return

      const log = await prisma.auditLog.findFirst({
        where: { organizationId: ORG, entity: "JournalEntry", entityId: posted.value.id, action: "post" },
      })
      expect(log?.reason).toBe(reason)
      expect(JSON.stringify(log?.after)).toContain("closedProjectOverride")
    } finally {
      await tenantTransaction(ORG, USER, async (tx) => {
        await tx.project.update({ where: { id: otherProjectId }, data: { status: "ACTIVE", closedAt: null } })
      })
    }
  })

  /** `analyticsHash` del ejercicio de ORG, tal y como lo compone el informe. */
  async function analyticsHashOf(): Promise<string> {
    return await tenantTransaction(ORG, USER, async (tx) => {
      const config = await getAnalyticsConfig(tx, { periodEnd: REF })
      const lines = await getAnalyticLines(tx, { from: "2026-01-01", to: "2026-12-31" })
      return analyticsHash(
        lines.map((l) => ({
          entryId: l.entryId,
          lineNo: l.lineNo,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
          analyticType: l.analyticType,
        })),
        marginConfigHash(config)
      )
    })
  }
})
