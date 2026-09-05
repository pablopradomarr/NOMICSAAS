import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E4 · T16 — Las tres tablas de dimensiones analíticas como `app_runtime`
 * (LOGIN, NOBYPASSRLS, no propietario), que es el rol con el que conecta la
 * aplicación (ADR-0009). Criterio 17 de `docs/design/E4-analitica.md` §8.1.
 *
 * Aquí no hay red: si una política está mal escrita, el test se cae.
 *  - Sin GUC, `business_lines`, `cost_centers` y `margin_level_configs`
 *    devuelven 0 filas y rechazan el INSERT.
 *  - Con el GUC de A no se ve nada de B (I-E4-7, extensión de I10).
 *  - `app_runtime` puede reclasificar **sólo** las cuatro columnas analíticas
 *    (ADR-0010, salvaguarda 1) y ninguna otra.
 *  - Ninguna de las tres queda en `NO FORCE`.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e4c00000-0000-4000-8000-00000000000a"
const ORG_B = "e4c00000-0000-4000-8000-00000000000b"
const USER_A = "e4c00000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const TABLES = ["business_lines", "cost_centers", "margin_level_configs"] as const

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const owner = <T,>(fn: (client: Client) => Promise<T>) => withClient(OWNER_URL, fn)

/** `app_runtime` SIN GUC: el caso que ADR-0009 cierra. */
async function sinGuc<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return await withClient(process.env.DATABASE_URL as string, async (client) => {
    await client.query("BEGIN")
    try {
      const guc = await client.query<{ o: string | null }>("SELECT app.current_org() AS o")
      expect(guc.rows[0].o).toBeNull()
      return await fn(client)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

async function conGuc<T>(organizationId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return await withClient(process.env.DATABASE_URL as string, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId])
      await client.query("SELECT set_config('app.current_user', $1, true)", [USER_A])
      return await fn(client)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

function insertOf(table: (typeof TABLES)[number], organizationId: string): [string, unknown[]] {
  const sufijo = organizationId === ORG_A ? "a" : "b"
  switch (table) {
    case "business_lines":
      return [
        `INSERT INTO "business_lines" (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'BL-${sufijo}', 'RLS', now())`,
        [organizationId],
      ]
    case "cost_centers":
      return [
        `INSERT INTO "cost_centers" (id, organization_id, code, name, kind, margin_level, updated_at)
         VALUES (gen_random_uuid(), $1, 'CC-${sufijo}', 'RLS', 'G_A'::cost_center_kind, 'EBITDA'::margin_level, now())`,
        [organizationId],
      ]
    case "margin_level_configs":
      return [
        `INSERT INTO "margin_level_configs" (id, organization_id, level, label, sort_order, valid_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'INGRESOS'::margin_level, 'RLS', 1, DATE '1970-01-01', now())`,
        [organizationId],
      ]
  }
}

describe.skipIf(!OWNER_URL)("E4 · dimensiones analíticas bajo RLS estricta", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e4-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e4-rls-a"],
        [ORG_B, "e4-rls-b"],
      ]) {
        await client.query(`INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`, [
          id,
          slug,
        ])
      }
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, accepted_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now(), now())`,
        [ORG_A, USER_A]
      )
      for (const organizationId of ORGS) {
        for (const table of TABLES) {
          const [sql, params] = insertOf(table, organizationId)
          await client.query(sql, params)
        }
      }
    })
  }, 90_000)

  afterAll(limpiar)

  async function limpiar() {
    await owner(async (client) => {
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "users" WHERE id = $1`, [USER_A])
    })
  }

  it("los fixtures existen de verdad (si no, los ceros de abajo no probarían nada)", async () => {
    for (const table of TABLES) {
      const result = await owner(async (client) =>
        client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
      )
      expect(result.rows[0].n, table).toBe(2)
    }
  })

  it.each(TABLES)("SIN GUC, SELECT sobre %s devuelve 0 filas", async (table) => {
    const result = await sinGuc(async (client) => client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))
    expect(result.rows[0].n).toBe(0)
  })

  it.each(TABLES)("SIN GUC, el INSERT en %s lo rechaza la política (42501)", async (table) => {
    const [sql, params] = insertOf(table, ORG_A)
    await expect(sinGuc(async (client) => client.query(sql.replace("-a'", "-x'"), params))).rejects.toMatchObject({
      code: "42501",
    })
  })

  it("CON el GUC de A se ve exactamente lo de A y nada de B (I-E4-7)", async () => {
    for (const table of TABLES) {
      const rows = await conGuc(ORG_A, async (client) =>
        client.query<{ organization_id: string }>(`SELECT organization_id FROM "${table}"`)
      )
      expect(rows.rows.length, table).toBe(1)
      expect(rows.rows[0].organization_id, table).toBe(ORG_A)
    }
  })

  it("CON el GUC de A, escribir una fila de B viola la política (no la silencia)", async () => {
    for (const table of TABLES) {
      const [sql, params] = insertOf(table, ORG_B)
      await expect(conGuc(ORG_A, async (client) => client.query(sql.replace("-b'", "-y'"), params))).rejects.toMatchObject(
        { code: "42501" }
      )
    }
  })

  it("ninguna DELETE: las dimensiones se archivan, no se borran", async () => {
    for (const table of TABLES) {
      const result = await conGuc(ORG_A, async (client) => client.query(`DELETE FROM "${table}"`))
      expect(result.rowCount, table).toBe(0)
    }
  })

  it("ninguna de las tres queda en NO FORCE (ADR-0009 §7)", async () => {
    const rows = await owner(async (client) =>
      client.query<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity, relrowsecurity FROM pg_class WHERE relname = ANY($1)`,
        [[...TABLES]]
      )
    )
    expect(rows.rows).toHaveLength(3)
    for (const row of rows.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.relforcerowsecurity, row.relname).toBe(true)
    }
  })

  it("ADR-0010 · `app_runtime` sólo tiene UPDATE sobre las cuatro columnas analíticas", async () => {
    const rows = await owner(async (client) =>
      client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'journal_lines' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'
          ORDER BY column_name`
      )
    )
    expect(rows.rows.map((r) => r.column_name)).toEqual([
      "analytic_type",
      "business_line_id",
      "cost_center_id",
      "project_id",
    ])
  })

  it("ADR-0010 · `app_runtime` sólo tiene UPDATE sobre `entry_hash` y las tres de anulación", async () => {
    const rows = await owner(async (client) =>
      client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'journal_entries' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'
          ORDER BY column_name`
      )
    )
    expect(rows.rows.map((r) => r.column_name)).toEqual(["entry_hash", "void_reason", "voided_at", "voided_by_id"])
  })
})
