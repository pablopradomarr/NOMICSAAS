import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * QA E4 — intento de ROTURA sobre criterios no cubiertos literalmente por
 * `tests/integration/e4-analytics.test.ts` / `e4-ui1-fixes.test.ts`:
 *  - autorización por rol en las server actions de `app/(app)/analytics/actions.ts`
 *    (VIEWER en toda mutación; EDITOR en cambios estructurales de CECO,
 *    `MarginLevelConfig`, política y `analyticType` de cuenta);
 *  - archivar un proyecto CON líneas: fila viva, `isActive = false`, nunca DELETE;
 *  - cerrar un proyecto: ¿existe de verdad la excepción "ADMIN con motivo" de
 *    `docs/design/E4-analitica.md` §2.4/I-E4-10, o `validateAnalytics()` bloquea
 *    sin excepción de rol?;
 *  - `MarginLevelConfig`: vigencias solapadas rechazadas por el `EXCLUDE` de BD.
 *
 * No se toca ningún test ni fixture existente.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
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
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults, closeProject, archiveDimension } = await import("@/models/analytics")

const ORG = "e4a00000-0000-4000-8000-00000000000a"
const VIEWER_USER = "e4a00000-0000-4000-8000-0000000000a1"
const EDITOR_USER = "e4a00000-0000-4000-8000-0000000000a2"
const ADMIN_USER = "e4a00000-0000-4000-8000-0000000000a3"

let currentUser: { id: string; email: string; name: string }
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

describe.skipIf(!TEST_DATABASE_URL)("QA E4 · ataques dirigidos", () => {
  let costCenterId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: VIEWER_USER, email: "e4qa-viewer@test.local", name: "Viewer" },
        { id: EDITOR_USER, email: "e4qa-editor@test.local", name: "Editor" },
        { id: ADMIN_USER, email: "e4qa-admin@test.local", name: "Admin" },
      ],
    })
    await prisma.organization.create({
      data: { id: ORG, slug: "e4-qa-org", name: "E4 QA Org", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: EDITOR_USER, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })
    await importNpgc(ORG, "PYMES", { actor: { userId: ADMIN_USER }, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, { userId: ADMIN_USER })
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    await tenantTransaction(ORG, ADMIN_USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: ADMIN_USER })
      const ceco = await tx.costCenter.findFirstOrThrow({ where: { code: "CC-GA" } })
      costCenterId = ceco.id
    })
  }, 120_000)

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
        "audit_logs",
        "period_locks",
        "fiscal_years",
        "margin_level_configs",
        "cost_centers",
        "projects",
        "business_lines",
        "tax_rates",
        "organization_account_maps",
        "accounts",
        "memberships",
      ]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1::uuid`, [ORG])
      }
      await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])
      await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[VIEWER_USER, EDITOR_USER, ADMIN_USER]])
    })
  }

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    currentUser = { id: row.id, email: row.email, name: row.name }
    return await fn()
  }

  // ── VIEWER: rechazado en TODAS las mutaciones de analytics/actions.ts ────

  it("VIEWER: createProjectAction rechazada, nada escrito", async () => {
    const { createProjectAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(VIEWER_USER, () =>
      createProjectAction({ code: "QA-V", name: "Intento viewer", businessLineId: null })
    )
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("VIEWER: createBusinessLineAction rechazada", async () => {
    const { createBusinessLineAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(VIEWER_USER, () => createBusinessLineAction({ code: "QA-BL-V", name: "Intento" }))
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("VIEWER: createCostCenterAction rechazada", async () => {
    const { createCostCenterAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(VIEWER_USER, () =>
      createCostCenterAction({ code: "QA-CC-V", name: "Intento", kind: "OTROS", marginLevel: "EBITDA", allocatable: true })
    )
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("VIEWER: archiveDimensionAction rechazada", async () => {
    const { archiveDimensionAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(VIEWER_USER, () =>
      archiveDimensionAction({ kind: "CostCenter", id: costCenterId, reason: "intento de viewer, motivo largo" })
    )
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("VIEWER: reclassifyLinesAction rechazada", async () => {
    const { reclassifyLinesAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(VIEWER_USER, () =>
      reclassifyLinesAction({ reason: "intento de viewer, motivo largo y valido", targets: [] })
    )
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("VIEWER: updateMarginLevelConfigAction / setAnalyticsPolicyAction / updateAccountAnalyticTypeAction rechazadas", async () => {
    const { updateMarginLevelConfigAction, setAnalyticsPolicyAction, updateAccountAnalyticTypeAction } = await import(
      "@/app/(app)/analytics/actions"
    )
    await asUser(VIEWER_USER, async () => {
      expect(await updateMarginLevelConfigAction({ rows: [], validFrom: "2027-01-01" })).toEqual({
        success: false,
        error: "Sin permiso",
      })
      expect(await setAnalyticsPolicyAction({ analyticsRequired: false })).toEqual({ success: false, error: "Sin permiso" })
      expect(
        await updateAccountAnalyticTypeAction({ accountCode: "623", analyticType: "COSTE_DIRECTO_MC2", reason: "motivo largo de sobra" })
      ).toEqual({ success: false, error: "Sin permiso" })
    })
  })

  it("nada de lo anterior escribió una fila (VIEWER no tiene ningún efecto colateral)", async () => {
    const projects = await prisma.project.count({ where: { organizationId: ORG, code: { startsWith: "QA-" } } })
    const bls = await prisma.businessLine.count({ where: { organizationId: ORG, code: { startsWith: "QA-" } } })
    const cecos = await prisma.costCenter.count({ where: { organizationId: ORG, code: { startsWith: "QA-" } } })
    expect({ projects, bls, cecos }).toEqual({ projects: 0, bls: 0, cecos: 0 })
  })

  // ── EDITOR: rechazado en cambios estructurales / config / archivar ───────

  it("EDITOR: updateCostCenterAction con `kind`/`marginLevel`/`allocatable` rechazada (solo ADMIN)", async () => {
    const { updateCostCenterAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(EDITOR_USER, () => updateCostCenterAction({ id: costCenterId, kind: "OTROS" }))
    expect(result.success).toBe(false)
    const after = await prisma.costCenter.findUniqueOrThrow({ where: { id: costCenterId } })
    expect(after.kind).toBe("G_A") // sin cambios
  })

  it("EDITOR: archiveDimensionAction rechazada (Sin permiso, es ADMIN)", async () => {
    const { archiveDimensionAction } = await import("@/app/(app)/analytics/actions")
    const result = await asUser(EDITOR_USER, () =>
      archiveDimensionAction({ kind: "CostCenter", id: costCenterId, reason: "intento de editor, motivo largo" })
    )
    expect(result).toEqual({ success: false, error: "Sin permiso" })
    const after = await prisma.costCenter.findUniqueOrThrow({ where: { id: costCenterId } })
    expect(after.isActive).toBe(true)
  })

  it("EDITOR: updateMarginLevelConfigAction / setAnalyticsPolicyAction / updateAccountAnalyticTypeAction rechazadas (ADMIN)", async () => {
    const { updateMarginLevelConfigAction, setAnalyticsPolicyAction, updateAccountAnalyticTypeAction } = await import(
      "@/app/(app)/analytics/actions"
    )
    await asUser(EDITOR_USER, async () => {
      expect(await updateMarginLevelConfigAction({ rows: [], validFrom: "2027-01-01" })).toEqual({
        success: false,
        error: "Sin permiso",
      })
      expect(await setAnalyticsPolicyAction({ analyticsRequired: false })).toEqual({ success: false, error: "Sin permiso" })
      expect(
        await updateAccountAnalyticTypeAction({ accountCode: "623", analyticType: "COSTE_DIRECTO_MC2", reason: "motivo largo de sobra" })
      ).toEqual({ success: false, error: "Sin permiso" })
    })
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: ORG } })
    expect(org.analyticsRequired).toBe(true) // sin cambios
  })

  // ── Archivar proyecto CON líneas: solo isActive=false, nunca DELETE ──────

  it("archivar un proyecto con líneas posteadas: la fila sigue viva, isActive=false, las líneas siguen apuntándolo", async () => {
    const bl = await tenantTransaction(ORG, ADMIN_USER, (tx) => tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } }))
    const project = await tenantTransaction(ORG, ADMIN_USER, (tx) =>
      tx.project.create({ data: { organizationId: ORG, code: "QA-ARCH", name: "A archivar", businessLineId: bl.id } })
    )
    const draft = await tenantTransaction(ORG, ADMIN_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: "2026-03-01",
          description: "Factura para archivar después",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "4300", debitCents: 10_000, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 10_000, projectId: project.id },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG, draft.value, { userId: ADMIN_USER }, { refDate: REF })
    expect(posted.ok, JSON.stringify(posted)).toBe(true)

    const archived = await tenantTransaction(ORG, ADMIN_USER, (tx) =>
      archiveDimension(tx, "Project", project.id, "cliente perdido, proyecto sin actividad futura", { userId: ADMIN_USER }, new Date())
    )
    expect(archived.isActive).toBe(false)
    expect(archived.archivedAt).toBeTruthy()

    // La fila NO desaparece.
    const stillThere = await prisma.project.findUnique({ where: { id: project.id } })
    expect(stillThere).not.toBeNull()
    expect(stillThere?.id).toBe(project.id)

    // Sus líneas de diario siguen apuntándolo: el archivado no reescribe el diario.
    const line = await prisma.journalLine.findFirst({ where: { projectId: project.id, accountCode: "705" } })
    expect(line).not.toBeNull()
  })

  // ── Cerrar proyecto: ¿existe la excepción "ADMIN con motivo"? ────────────

  it(
    "proyecto CLOSED: postEntry lo rechaza incluso pasando actor ADMIN — no hay excepción de rol en validateAnalytics()",
    async () => {
      const bl = await tenantTransaction(ORG, ADMIN_USER, (tx) => tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } }))
      const project = await tenantTransaction(ORG, ADMIN_USER, (tx) =>
        tx.project.create({ data: { organizationId: ORG, code: "QA-CLOSED", name: "A cerrar", businessLineId: bl.id } })
      )
      const closed = await tenantTransaction(ORG, ADMIN_USER, (tx) => closeProject(tx, project.id, "2026-06-30", { userId: ADMIN_USER }))
      expect(closed.status).toBe("CLOSED")

      const draft = await tenantTransaction(ORG, ADMIN_USER, async (tx) => {
        const ctx = await getLedgerContext(tx, REF)
        return buildEntry(
          {
            organizationId: ORG,
            entryDate: "2026-07-01",
            description: "Intento de línea nueva tras cierre, con motivo de excepción",
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "4300", debitCents: 5_000, creditCents: 0 },
              { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 5_000, projectId: project.id },
            ],
          },
          ctx
        )
      })
      // `postEntry`/`Actor` no tienen ningún campo de rol ni de motivo de
      // excepción: quien llama aquí es, a todos los efectos, un ADMIN (mismo
      // actor que cerró el proyecto) y aun así el motor rechaza la línea.
      expect(draft.ok, "se esperaba ANALYTIC_PROJECT_CLOSED, no un draft válido").toBe(false)
      if (draft.ok) return
      expect(draft.errors.map((e) => e.code)).toContain("ANALYTIC_PROJECT_CLOSED")
    }
  )

  // ── MarginLevelConfig: vigencias solapadas — EXCLUDE de BD ───────────────

  it("MarginLevelConfig: dos vigencias solapadas para el mismo nivel las rechaza el EXCLUDE de BD", async () => {
    await owner(async (client) => {
      const row = await client.query<{ id: string }>(
        `SELECT id FROM margin_level_configs WHERE organization_id = $1::uuid AND level = 'EBIT' LIMIT 1`,
        [ORG]
      )
      expect(row.rows.length).toBe(1)
      // La fila existente cubre [2026-01-01, ∞). Insertar otra que solapa
      // (arranca antes de que la primera termine, y la primera no tiene fin)
      // debe violar `margin_level_configs_no_overlap` (23P01).
      await expect(
        client.query(
          `INSERT INTO margin_level_configs
             (id, organization_id, level, label, analytic_types, sort_order, is_visible, valid_from, valid_to, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 'EBIT', 'EBIT duplicado', '{AMORTIZACION_DETERIORO}', 6, true, '2026-06-01', NULL, now())`,
          [ORG]
        )
      ).rejects.toMatchObject({ code: "23P01" })
    })
  })

  it("MarginLevelConfig: una vigencia que NO solapa (empieza tras cerrar la anterior) se acepta", async () => {
    await owner(async (client) => {
      // Cierra la vigencia de EBIT en 2026-05-31 y abre una nueva desde 2026-06-01:
      // no deben solaparse.
      await client.query(`BEGIN`)
      try {
        await client.query(
          `UPDATE margin_level_configs SET valid_to = '2026-05-31' WHERE organization_id = $1::uuid AND level = 'EBIT' AND valid_to IS NULL`,
          [ORG]
        )
        await client.query(
          `INSERT INTO margin_level_configs
             (id, organization_id, level, label, analytic_types, sort_order, is_visible, valid_from, valid_to, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 'EBIT', 'EBIT v2', '{AMORTIZACION_DETERIORO}', 6, true, '2026-06-01', NULL, now())`,
          [ORG]
        )
        await client.query(`COMMIT`)
      } catch (e) {
        await client.query(`ROLLBACK`)
        throw e
      }
    })
    const rows = await owner(async (client) =>
      client.query(`SELECT valid_from, valid_to FROM margin_level_configs WHERE organization_id = $1::uuid AND level = 'EBIT' ORDER BY valid_from`, [ORG])
    )
    expect(rows.rows.length).toBe(2)
  })
})
