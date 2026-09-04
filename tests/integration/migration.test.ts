import { execFileSync } from "node:child_process"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E1-fix (#11) — CA-1: la cadena completa de migraciones aplicada sobre un
 * volcado REAL pre-E1.
 *
 * Crea una base temporal, carga `tests/fixtures/taxhacker-pre-e1.sql` (esquema
 * heredado de TaxHacker + dos usuarios con códigos solapados) y ejecuta
 * `prisma migrate deploy`. Después comprueba lo que el backfill promete:
 * cero huérfanos, una organización personal por usuario, membresía ADMIN, y los
 * uniques compuestos `(organization_id, code)` en su sitio.
 *
 * Es el único test que ejerce el camino de ACTUALIZACIÓN (el resto parte de una
 * base ya migrada), que es justo el que rompe datos de clientes si falla.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const TEMP_DB = "erp_migration_test"

function adminUrl(database: string): string {
  const url = new URL(TEST_DATABASE_URL as string)
  url.pathname = `/${database}`
  return url.toString()
}

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl("postgres") })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("migración de una base TaxHacker pre-E1 (CA-1)", () => {
  let db: Client

  beforeAll(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${TEMP_DB}"`)
      await admin.query(`CREATE DATABASE "${TEMP_DB}"`)
    })

    const url = adminUrl(TEMP_DB)

    // 1. Volcado pre-E1 (esquema + datos + _prisma_migrations de las 10 heredadas)
    execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-f", "tests/fixtures/taxhacker-pre-e1.sql", url], {
      stdio: "pipe",
    })

    // 2. Todas las migraciones de E1 y E1-fix encima
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: "pipe",
    })

    db = new Client({ connectionString: url })
    await db.connect()
  }, 120_000)

  afterAll(async () => {
    if (db) await db.end()
    await withAdmin(async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${TEMP_DB}"`)
    })
  })

  it("no deja ninguna fila huérfana sin organization_id", async () => {
    const tables = ["settings", "categories", "projects", "fields", "files", "transactions", "app_data", "progress"]
    for (const table of tables) {
      const res = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE organization_id IS NULL`
      )
      expect({ table, huerfanos: Number(res.rows[0].n) }).toEqual({ table, huerfanos: 0 })
    }
  })

  it("crea una organización personal por usuario, con id = users.id", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "organizations" o JOIN "users" u ON u.id = o.id WHERE o.is_personal`
    )
    expect(Number(res.rows[0].n)).toBe(2)
    const total = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "organizations"`)
    expect(Number(total.rows[0].n)).toBe(2)
  })

  it("crea una membresía ADMIN aceptada por usuario", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "memberships" WHERE role = 'ADMIN' AND accepted_at IS NOT NULL`
    )
    expect(Number(res.rows[0].n)).toBe(2)
  })

  it("conserva los códigos solapados de los dos usuarios (unique compuesto)", async () => {
    const categorias = await db.query<{ organization_id: string }>(
      `SELECT organization_id FROM "categories" WHERE code = 'oficina'`
    )
    expect(categorias.rowCount).toBe(2)
    const proyectos = await db.query(`SELECT 1 FROM "projects" WHERE code = 'p1'`)
    expect(proyectos.rowCount).toBe(2)
  })

  it("los uniques compuestos existen y los heredados por user_id ya no", async () => {
    const res = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    )
    const nombres = res.rows.map((row) => row.indexname)
    for (const esperado of [
      "settings_organization_id_code_key",
      "categories_organization_id_code_key",
      "projects_organization_id_code_key",
      "fields_organization_id_code_key",
      "currencies_organization_id_code_key",
      "app_data_organization_id_user_id_app_key",
      "memberships_organization_id_user_id_key",
      "organizations_stripe_customer_id_key",
    ]) {
      expect(nombres).toContain(esperado)
    }
    for (const retirado of ["categories_user_id_code_key", "projects_user_id_code_key", "fields_user_id_code_key"]) {
      expect(nombres).not.toContain(retirado)
    }
  })

  it("traslada facturación y cuotas de users a organizations y limpia users", async () => {
    const org = await db.query<{ stripe_customer_id: string | null; membership_plan: string | null }>(
      `SELECT stripe_customer_id, membership_plan FROM "organizations" WHERE id = '11111111-1111-4111-8111-111111111111'`
    )
    expect(org.rows[0]).toEqual({ stripe_customer_id: "cus_ana_pre_e1", membership_plan: "unlimited" })

    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
    )
    const nombres = columnas.rows.map((row) => row.column_name)
    for (const retirada of ["stripe_customer_id", "membership_plan", "storage_used", "business_name"]) {
      expect(nombres).not.toContain(retirada)
    }
  })

  it("deja RLS habilitada y forzada en las tablas de negocio", async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('transactions','categories','organizations','memberships')`
    )
    expect(res.rowCount).toBe(4)
    expect(res.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true)
  })
})
