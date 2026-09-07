import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * QA E4 — dos ataques adicionales como `app_runtime` (LOGIN, NOBYPASSRLS) que
 * `tests/integration-rls/e4-tenant.test.ts` no ejerce literalmente:
 *
 *  1. El `GRANT UPDATE` de columna de ADR-0010 se comprueba allí sobre el
 *     catálogo (`information_schema.column_privileges`). Aquí se dispara la
 *     sentencia real: un `UPDATE` que toca `project_id` (permitida) Y
 *     `debit_cents` (prohibida) EN LA MISMA sentencia debe fallar entera con
 *     42501 — Postgres exige el privilegio sobre TODAS las columnas objetivo
 *     antes de tocar una fila — y `debit_cents` no debe moverse ni un céntimo.
 *  2. El informe analítico (`getAnalyticPnl`) ejecutado con el rol de
 *     producción no debe filtrar líneas ni proyectos de otra organización.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e4900000-0000-4000-8000-00000000000a"
const ORG_B = "e4900000-0000-4000-8000-00000000000b"
const USER_A = "e4900000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const actor = { userId: USER_A }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function asRuntime<T>(organizationId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId])
    await client.query("SELECT set_config('app.current_user', $1, true)", [USER_A])
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { getLedgerContext, postEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { getAnalyticPnl } = await import("@/models/margins")

describe.skipIf(!OWNER_URL)("QA E4 · ataques adicionales como app_runtime", () => {
  let lineId = ""
  let debitBefore = 0
  let projectAId = ""
  let projectBId = ""

  beforeAll(async () => {
    await cleanup()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e4-qa-rls@test.local', 'E4 QA RLS', now())`,
        [USER_A]
      )
      await client.query(
        `INSERT INTO "organizations" (id, slug, name, pgc_variant, updated_at) VALUES
           ($1,'e4-qa-rls-a','E4 QA RLS A','PYMES', now()),
           ($2,'e4-qa-rls-b','E4 QA RLS B','PYMES', now())`,
        ORGS
      )
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now())`,
        [ORG_A, USER_A]
      )
    })
    for (const organizationId of ORGS) {
      await importNpgc(organizationId, "PYMES", { actor: { userId: null }, now: new Date("2026-01-01"), useSubaccounts: false })
      await tenantTransaction(organizationId, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
      })
      await openFiscalYear(organizationId, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    }

    const bl = { A: "", B: "" } as Record<"A" | "B", string>
    for (const [label, organizationId] of [
      ["A", ORG_A],
      ["B", ORG_B],
    ] as const) {
      await tenantTransaction(organizationId, async (tx) => {
        const generalBl = await tx.businessLine.findFirstOrThrow({ where: { code: "GENERAL" } })
        bl[label] = generalBl.id
        const p = await tx.project.create({
          data: { organizationId, code: `P-${label}`, name: `Proyecto ${label}`, businessLineId: generalBl.id },
        })
        if (label === "A") projectAId = p.id
        else projectBId = p.id
      })
    }

    for (const [organizationId, amount] of [
      [ORG_A, 111_100],
      [ORG_B, 222_200],
    ] as const) {
      const projectId = organizationId === ORG_A ? projectAId : projectBId
      const draft = await tenantTransaction(organizationId, USER_A, async (tx) => {
        const ctx = await getLedgerContext(tx, "2026-12-31")
        return buildEntry(
          {
            organizationId,
            entryDate: "2026-03-01",
            description: "Factura QA tenant",
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "4300", debitCents: amount, creditCents: 0 },
              { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: amount, projectId },
            ],
          },
          ctx
        )
      })
      if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
      const posted = await postEntry(organizationId, draft.value, actor, { refDate: "2026-12-31" })
      if (!posted.ok) throw new Error(JSON.stringify(posted.errors))
      if (organizationId === ORG_A) {
        const line = posted.value.lines.find((l) => l.accountCode === "4300")!
        lineId = line.id
        debitBefore = line.debitCents
      }
    }
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query("COMMIT")
      for (const table of ["fiscal_years", "margin_level_configs", "cost_centers", "projects", "business_lines", "tax_rates", "organization_account_maps", "accounts", "memberships"]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      }
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER_A])
    })
  }

  it("UPDATE que mezcla project_id (permitida) y debit_cents (prohibida) en la MISMA sentencia: 42501, nada se mueve", async () => {
    await expect(
      asRuntime(ORG_A, (client) =>
        client.query(`UPDATE journal_lines SET project_id = NULL, debit_cents = debit_cents + 999 WHERE id = $1::uuid`, [
          lineId,
        ])
      )
    ).rejects.toMatchObject({ code: "42501" })

    const after = await owner(async (client) =>
      // E7 · ADR-0015 D1: `debit_cents` es `bigint` desde M4 y el driver `pg`
      // devuelve `int8` como CADENA de dígitos. El valor es el mismo; sólo
      // cambia su representación al salir del driver crudo.
      client.query<{ debit_cents: string; project_id: string | null }>(
        `SELECT debit_cents, project_id FROM journal_lines WHERE id = $1::uuid`,
        [lineId]
      )
    )
    expect(Number(after.rows[0].debit_cents)).toBe(debitBefore)
  })

  it("el informe analítico (getAnalyticPnl) con app_runtime y GUC de A no ve el proyecto ni el importe de B", async () => {
    const report = await tenantTransaction(ORG_A, USER_A, (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        provenance: { runId: "qa-tenant-leak", gitSha: "0000000000000000000000000000000000000000", baseCurrency: "EUR" },
      })
    )
    // El total de INGRESOS solo puede contener el importe de A (111 100), nunca
    // sumado con el de B (222 200): si hubiera fuga, el total sería 333 300.
    expect(report.pnl.levelTotalsCents.INGRESOS).toBe(111_100)
    // Ninguna columna del proyecto de B ("PROJ:P-B") aparece en la matriz.
    const columns = Object.keys(report.pnl.matrixCents.INGRESOS ?? {})
    expect(columns).toContain("PROJ:P-A")
    expect(columns).not.toContain("PROJ:P-B")
  })
})
