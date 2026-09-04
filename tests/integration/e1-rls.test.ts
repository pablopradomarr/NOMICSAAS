import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma } = await import("@/lib/db")

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa40"
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb40"
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa41"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb41"

function runtimeUrl(): string {
  const url = new URL(TEST_DATABASE_URL as string)
  url.username = "app_runtime"
  url.password = ""
  return url.toString()
}

/**
 * QA adversarial E1 — barrera 2 (RLS), CA-4 y §8.3 punto 8. Se conecta como
 * `app_runtime` (rol NOBYPASSRLS creado por la migración 20260904120300_e1_rls)
 * FUERA de tenantDb/Prisma, y fija `app.current_org` a mano con SQL crudo.
 */
describe.skipIf(!TEST_DATABASE_URL)("QA adversarial — RLS con rol app_runtime", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: USER_A, email: "qa-rls-a@test.local", name: "A" },
        { id: USER_B, email: "qa-rls-b@test.local", name: "B" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "qa-rls-org-a", name: "QA RLS A", updatedAt: new Date() },
        { id: ORG_B, slug: "qa-rls-org-b", name: "QA RLS B", updatedAt: new Date() },
      ],
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: USER_A, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG_B, userId: USER_B, role: "ADMIN", updatedAt: new Date() },
      ],
    })
    await prisma.transaction.createMany({
      data: [
        { organizationId: ORG_A, name: "tx A", type: "expense", total: 10, currencyCode: "EUR", issuedAt: new Date() },
        { organizationId: ORG_B, name: "tx B", type: "expense", total: 20, currencyCode: "EUR", issuedAt: new Date() },
      ],
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.transaction.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
  }

  // NOTA: `app.current_org` con `set_config(..., true)` (is_local) sólo dura
  // dentro de una transacción — igual que `SET LOCAL`. Por eso cada test abre
  // BEGIN…COMMIT/ROLLBACK explícito, igual que `lib/db.ts::tenantTransaction`
  // y el test que ya existe en `lib/db.test.ts`.
  it("SELECT con app.current_org=A no devuelve filas de B (CA-4)", async () => {
    const client = new Client({ connectionString: runtimeUrl() })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      const res = await client.query('SELECT organization_id, name FROM "transactions" ORDER BY name')
      await client.query("COMMIT")
      expect(res.rows.map((r) => r.name)).toEqual(["tx A"])
      expect(res.rows.every((r) => r.organization_id === ORG_A)).toBe(true)
    } finally {
      await client.end()
    }
  })

  it("UPDATE con app.current_org=A afecta 0 filas de B (CA-4)", async () => {
    const client = new Client({ connectionString: runtimeUrl() })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      const res = await client.query('UPDATE "transactions" SET name = $1 WHERE organization_id = $2', [
        "hijacked-by-rls-test",
        ORG_B,
      ])
      await client.query("COMMIT")
      expect(res.rowCount).toBe(0)
    } finally {
      await client.end()
    }
    const bRow = await prisma.transaction.findFirst({ where: { organizationId: ORG_B } })
    expect(bRow?.name).toBe("tx B")
  })

  it("INSERT con organization_id=B mientras app.current_org=A es rechazado por WITH CHECK", async () => {
    const client = new Client({ connectionString: runtimeUrl() })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      await expect(
        client.query(
          `INSERT INTO "transactions" (id, organization_id, name, type, total, currency_code, issued_at, items, files)
           VALUES (gen_random_uuid(), $1, 'intento', 'expense', 1, 'EUR', now(), '[]', '[]')`,
          [ORG_B]
        )
      ).rejects.toThrow(/row-level security/i)
      await client.query("ROLLBACK")
    } finally {
      await client.end()
    }
  })

  // RESUELTO en E1-fix (#1): antes este test dejaba constancia de que
  // `tenantTransaction` no se invocaba desde ninguna parte y la barrera 2 era
  // inerte. Ahora la extensión de `tenantDb` fija los GUC en CADA operación, así
  // que se comprueba lo contrario: que el cableado existe en lib/db.ts.
  it("RESUELTO: tenantDb fija app.current_org en toda operación (barrera 2 activa)", async () => {
    const { readFile } = await import("node:fs/promises")
    const dbSource = await readFile("lib/db.ts", "utf8")
    expect(dbSource).toContain("set_config('app.current_org'")
    expect(dbSource).toContain("set_config('app.current_user'")
    expect(dbSource).toContain("runWithTenantGucs")

    // Y se verifica en caliente: una lectura corriente por tenantDb deja el GUC
    // fijado durante su transacción.
    const { tenantTransaction } = await import("@/lib/db")
    const guc = await tenantTransaction(ORG_A, USER_A, async (tx) =>
      tx.$queryRawUnsafe<{ o: string | null; u: string | null }[]>(
        "SELECT app.current_org() AS o, app.current_user() AS u"
      )
    )
    expect(guc[0].o).toBe(ORG_A)
    expect(guc[0].u).toBe(USER_A)
  })

  it("DOCUMENTADO COMO DEUDA (no FORCE RLS): sin app.current_org fijado, app_runtime ve filas de ambas orgs", async () => {
    // La política usa `OR app.current_org() IS NULL` como cláusula de escape (E3
    // la retirará junto con FORCE ROW LEVEL SECURITY, ver migración 20260904120300).
    // Este test deja constancia explícita del riesgo: si el código de aplicación
    // alguna vez omite fijar el GUC, RLS NO protege por sí sola.
    const client = new Client({ connectionString: runtimeUrl() })
    await client.connect()
    try {
      const res = await client.query(
        'SELECT organization_id FROM "transactions" WHERE organization_id IN ($1, $2)',
        [ORG_A, ORG_B]
      )
      expect(res.rows.length).toBe(2)
    } finally {
      await client.end()
    }
  })
})
