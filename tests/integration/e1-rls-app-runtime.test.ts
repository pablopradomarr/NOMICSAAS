import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E1-fix (#1, #2) — HUMO de RLS efectiva con el rol de runtime.
 *
 * Se conecta como `app_runtime` (LOGIN, NOBYPASSRLS, no propietario: el rol con
 * el que la app conecta en producción según `.env.example` y docker-compose) y
 * recorre el flujo completo tal como lo ejecuta la aplicación:
 *
 *   1. crear organización + membresía ADMIN en UNA transacción con
 *      `app.current_user` fijado (política de `organizations` por pertenencia),
 *   2. crear una categoría y una transacción con `app.current_org` fijado,
 *   3. leer desde la OTRA organización → 0 filas,
 *   4. escribir en la otra organización → la BASE DE DATOS lo rechaza.
 *
 * Si este test pasa, la barrera 2 no es una capa provisionada e inerte: filtra.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST

const ORG_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee10"
const ORG_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee20"
const USER_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee11"
const USER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee21"

function runtimeUrl(): string {
  const url = new URL(TEST_DATABASE_URL as string)
  url.username = "app_runtime"
  url.password = "app_runtime"
  return url.toString()
}

async function runtimeClient(): Promise<Client> {
  const client = new Client({ connectionString: runtimeUrl() })
  await client.connect()
  return client
}

/** Crea organización + membresía ADMIN como lo hace `createOrganizationWithOwner`. */
async function createOrgWithOwner(client: Client, orgId: string, userId: string, slug: string) {
  await client.query("BEGIN")
  await client.query("SELECT set_config('app.current_org', '', true)")
  await client.query("SELECT set_config('app.current_user', $1, true)", [userId])
  await client.query(
    `INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`,
    [orgId, slug]
  )
  await client.query(
    `INSERT INTO "memberships" (id, organization_id, user_id, role, accepted_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now(), now())`,
    [orgId, userId]
  )
  await client.query("COMMIT")
}

/** Datos de negocio como los escribe `tenantDb`: transacción + `app.current_org`. */
async function seedBusinessData(client: Client, orgId: string, suffix: string) {
  await client.query("BEGIN")
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId])
  await client.query("SELECT set_config('app.current_user', '', true)")
  await client.query(`INSERT INTO "categories" (id, organization_id, code, name) VALUES (gen_random_uuid(), $1, $2, $2)`, [
    orgId,
    `cat-${suffix}`,
  ])
  await client.query(
    `INSERT INTO "transactions" (id, organization_id, name, type, total, currency_code, issued_at, items, files, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'expense', 12345, 'EUR', now(), '[]', '[]', now())`,
    [orgId, `tx-${suffix}`]
  )
  await client.query("COMMIT")
}

describe.skipIf(!TEST_DATABASE_URL)("HUMO — RLS efectiva conectando como app_runtime", () => {
  let owner: Client

  beforeAll(async () => {
    // Los usuarios son pre-tenant: los crea el rol propietario (así hace la app,
    // que da de alta la cuenta antes de que exista organización alguna).
    owner = new Client({ connectionString: TEST_DATABASE_URL as string })
    await owner.connect()
    await cleanup()
    await owner.query(
      `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'rls-a@test.local', 'A', now()), ($2, 'rls-b@test.local', 'B', now())`,
      [USER_A, USER_B]
    )

    const client = await runtimeClient()
    try {
      await createOrgWithOwner(client, ORG_A, USER_A, "humo-rls-a")
      await createOrgWithOwner(client, ORG_B, USER_B, "humo-rls-b")
      await seedBusinessData(client, ORG_A, "a")
      await seedBusinessData(client, ORG_B, "b")
    } finally {
      await client.end()
    }
  })

  afterAll(async () => {
    await cleanup()
    await owner.end()
  })

  async function cleanup() {
    await owner.query(`DELETE FROM "transactions" WHERE organization_id = ANY($1)`, [[ORG_A, ORG_B]])
    await owner.query(`DELETE FROM "categories" WHERE organization_id = ANY($1)`, [[ORG_A, ORG_B]])
    await owner.query(`DELETE FROM "memberships" WHERE organization_id = ANY($1)`, [[ORG_A, ORG_B]])
    await owner.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
    await owner.query(`DELETE FROM "users" WHERE id = ANY($1)`, [[USER_A, USER_B]])
  }

  it("el alta de organización + membresía funciona como app_runtime (BLOQUEA-2)", async () => {
    // Si la política de `organizations` siguiera exigiendo id = app.current_org(),
    // el INSERT del beforeAll habría reventado y no habría filas.
    const rows = await owner.query(`SELECT id FROM "organizations" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
    expect(rows.rowCount).toBe(2)
  })

  it("con app.current_user = A sólo se ven las organizaciones y membresías de A (#21)", async () => {
    const client = await runtimeClient()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_user', $1, true)", [USER_A])
      const orgs = await client.query(`SELECT id FROM "organizations" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
      const memberships = await client.query(`SELECT organization_id FROM "memberships" WHERE organization_id = ANY($1)`, [
        [ORG_A, ORG_B],
      ])
      await client.query("COMMIT")
      expect(orgs.rows.map((r) => r.id)).toEqual([ORG_A])
      expect(memberships.rows.map((r) => r.organization_id)).toEqual([ORG_A])
    } finally {
      await client.end()
    }
  })

  it("lectura cruzada de datos de negocio = 0 filas", async () => {
    const client = await runtimeClient()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      const categories = await client.query(`SELECT code FROM "categories" WHERE organization_id = $1`, [ORG_B])
      const transactions = await client.query(`SELECT name FROM "transactions" WHERE organization_id = $1`, [ORG_B])
      const propias = await client.query(`SELECT name FROM "transactions"`)
      await client.query("COMMIT")
      expect(categories.rowCount).toBe(0)
      expect(transactions.rowCount).toBe(0)
      expect(propias.rows.map((r) => r.name)).toEqual(["tx-a"])
    } finally {
      await client.end()
    }
  })

  it("escritura cruzada rechazada por la BASE DE DATOS, no por la app", async () => {
    const client = await runtimeClient()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      await expect(
        client.query(
          `INSERT INTO "transactions" (id, organization_id, name, type, total, currency_code, issued_at, items, files, updated_at)
           VALUES (gen_random_uuid(), $1, 'intruso', 'expense', 1, 'EUR', now(), '[]', '[]', now())`,
          [ORG_B]
        )
      ).rejects.toThrow(/row-level security/i)
      await client.query("ROLLBACK")

      // Y el UPDATE dirigido a B no alcanza ninguna fila.
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      const updated = await client.query(`UPDATE "transactions" SET name = 'robado' WHERE organization_id = $1`, [ORG_B])
      await client.query("COMMIT")
      expect(updated.rowCount).toBe(0)
    } finally {
      await client.end()
    }

    const intacta = await owner.query(`SELECT name FROM "transactions" WHERE organization_id = $1`, [ORG_B])
    expect(intacta.rows.map((r) => r.name)).toEqual(["tx-b"])
  })

  it("FORCE ROW LEVEL SECURITY está activo en todas las tablas de negocio (#1)", async () => {
    const res = await owner.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) ORDER BY relname`,
      [
        [
          "settings",
          "categories",
          "projects",
          "fields",
          "files",
          "transactions",
          "currencies",
          "app_data",
          "progress",
          "memberships",
          "invitations",
          "organizations",
        ],
      ]
    )
    expect(res.rows.length).toBe(12)
    expect(res.rows.filter((row) => !row.relforcerowsecurity).map((row) => row.relname)).toEqual([])
  })
})
