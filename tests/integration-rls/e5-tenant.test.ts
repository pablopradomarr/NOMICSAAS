import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E5 · T14 — Las cuatro tablas de la liquidación como `app_runtime` (LOGIN,
 * NOBYPASSRLS, no propietario), que es el rol con el que la aplicación conecta
 * en producción (ADR-0009). Criterios 16 y 19 de `E5-liquidacion.md` §8.1.
 *
 * Aquí no hay red: si una política o un `GRANT` están mal escritos, el test cae.
 *  - Sin GUC, las cuatro devuelven 0 filas y rechazan el INSERT con `42501`.
 *  - Con el GUC de A no se ve ni una fila de B.
 *  - `allocation_lines` es append-only PURO: ni UPDATE ni DELETE, con la fila
 *    intacta después del intento.
 *  - `allocation_runs` sólo admite UPDATE de las CINCO columnas de sustitución y
 *    reversión, comprobado además a nivel de PRIVILEGIO de columna.
 *  - Ninguna de las cuatro queda en `NO FORCE`.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e5c00000-0000-4000-8000-00000000000a"
const ORG_B = "e5c00000-0000-4000-8000-00000000000b"
const USER_A = "e5c00000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const TABLES = ["allocation_rules", "allocation_rule_targets", "allocation_runs", "allocation_lines"] as const

/** Las CINCO columnas de `allocation_runs` que admiten UPDATE (I-E5-11). */
const MUTABLE_RUN_COLUMNS = ["reversal_reason", "reversed_at", "reversed_by_id", "status", "superseded_by_id"]

/** Ids deterministas: los mismos en las dos organizaciones, con otro prefijo. */
const idOf = (org: string, suffix: string): string =>
  `${org === ORG_A ? "e5d1" : "e5d2"}0000-0000-4000-8000-0000000000${suffix}`

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

function insertOf(table: (typeof TABLES)[number], org: string): [string, unknown[]] {
  switch (table) {
    case "allocation_rules":
      return [
        `INSERT INTO "allocation_rules"
           (id, organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'AL-RLS-X', 'RLS', $2, 'PROJECTS', 'EQUAL', 'YEAR', 90, DATE '2026-01-01', now())`,
        [org, idOf(org, "c1")],
      ]
    case "allocation_rule_targets":
      return [
        `INSERT INTO "allocation_rule_targets" (id, organization_id, rule_id, cost_center_id, percent_bps)
         VALUES (gen_random_uuid(), $1, $2, $3, 10000)`,
        [org, idOf(org, "a2"), idOf(org, "c2")],
      ]
    case "allocation_runs":
      return [
        `INSERT INTO "allocation_runs"
           (id, organization_id, fiscal_year_id, period_kind, period_start, period_end, status,
            ledger_hash, analytics_hash, rules_hash, git_sha)
         VALUES (gen_random_uuid(), $1, $2, 'QUARTER', DATE '2026-04-01', DATE '2026-06-30', 'SEALED',
                 repeat('0', 64), repeat('0', 64), repeat('0', 64), 'rls')`,
        [org, idOf(org, "f1")],
      ]
    case "allocation_lines":
      return [
        `INSERT INTO "allocation_lines"
           (id, organization_id, run_id, rule_id, source_cost_center_id, target_project_id,
            margin_level, amount_cents, driver_base, driver_base_total, driver_share_bps)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'EBITDA', 1, 1, 1, 10000)`,
        [org, idOf(org, "a4"), idOf(org, "a2"), idOf(org, "c1"), idOf(org, "a1")],
      ]
  }
}

describe.skipIf(!OWNER_URL)("E5 · liquidación bajo RLS estricta", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e5-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e5-rls-a"],
        [ORG_B, "e5-rls-b"],
      ]) {
        await client.query(`INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`, [id, slug])
      }
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, accepted_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now(), now())`,
        [ORG_A, USER_A]
      )

      for (const org of ORGS) {
        await client.query(
          `INSERT INTO "fiscal_years" (id, organization_id, code, start_date, end_date, updated_at)
           VALUES ($1, $2, '2026', DATE '2026-01-01', DATE '2026-12-31', now())`,
          [idOf(org, "f1"), org]
        )
        await client.query(
          `INSERT INTO "business_lines" (id, organization_id, code, name, updated_at)
           VALUES ($1, $2, 'GENERAL', 'General', now())`,
          [idOf(org, "b1"), org]
        )
        await client.query(
          `INSERT INTO "projects" (id, organization_id, code, name, business_line_id, updated_at)
           VALUES ($1, $2, 'P-RLS', 'RLS', $3, now())`,
          [idOf(org, "a1"), org, idOf(org, "b1")]
        )
        for (const [suffix, code] of [
          ["c1", "CC-GA"],
          ["c2", "CC-OPS"],
        ]) {
          await client.query(
            `INSERT INTO "cost_centers" (id, organization_id, code, name, kind, margin_level, updated_at)
             VALUES ($1, $2, $3, 'RLS', 'G_A'::cost_center_kind, 'EBITDA'::margin_level, now())`,
            [idOf(org, suffix), org, code]
          )
        }
        await client.query(
          `INSERT INTO "allocation_rules"
             (id, organization_id, code, name, source_cost_center_id, target_kind, driver, period, priority, valid_from, updated_at)
           VALUES ($1, $2, 'AL-RLS', 'RLS', $3, 'PROJECTS', 'EQUAL', 'YEAR', 10, DATE '2026-01-01', now())`,
          [idOf(org, "a2"), org, idOf(org, "c1")]
        )
        await client.query(
          `INSERT INTO "allocation_rule_targets" (id, organization_id, rule_id, project_id, percent_bps)
           VALUES ($1, $2, $3, $4, 10000)`,
          [idOf(org, "a3"), org, idOf(org, "a2"), idOf(org, "a1")]
        )
        await client.query(
          `INSERT INTO "allocation_runs"
             (id, organization_id, fiscal_year_id, period_kind, period_start, period_end, status,
              ledger_hash, analytics_hash, rules_hash, git_sha, line_count, total_allocated_cents)
           VALUES ($1, $2, $3, 'YEAR', DATE '2026-01-01', DATE '2026-12-31', 'SEALED',
                   repeat('0', 64), repeat('0', 64), repeat('0', 64), 'rls', 1, 12345)`,
          [idOf(org, "a4"), org, idOf(org, "f1")]
        )
        await client.query(
          `INSERT INTO "allocation_lines"
             (id, organization_id, run_id, rule_id, source_cost_center_id, target_project_id,
              margin_level, amount_cents, driver_base, driver_base_total, driver_share_bps)
           VALUES ($1, $2, $3, $4, $5, $6, 'EBITDA', 12345, 1, 1, 10000)`,
          [idOf(org, "a5"), org, idOf(org, "a4"), idOf(org, "a2"), idOf(org, "c1"), idOf(org, "a1")]
        )
      }
    })
  }, 90_000)

  afterAll(limpiar)

  async function limpiar() {
    await owner(async (client) => {
      for (const table of ["allocation_lines", "allocation_runs", "allocation_rule_targets", "allocation_rules"]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
      }
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "users" WHERE id = $1`, [USER_A])
    })
  }

  it("los fixtures existen de verdad (si no, los ceros de abajo no probarían nada)", async () => {
    for (const table of TABLES) {
      const result = await owner((client) =>
        client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
      )
      expect(result.rows[0].n, table).toBe(2)
    }
  })

  it.each(TABLES)("SIN GUC, SELECT sobre %s devuelve 0 filas", async (table) => {
    const result = await sinGuc((client) => client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))
    expect(result.rows[0].n).toBe(0)
  })

  /**
   * Las dos barreras de un `INSERT` que no debería ocurrir se disparan en este
   * orden: primero el trigger `BEFORE INSERT` de imputabilidad, después el
   * `WITH CHECK` de la política. Sin GUC el trigger tampoco ve el CECO —también
   * está bajo RLS— y aborta con `23514` antes de que la política llegue a
   * hablar. Las dos son rechazos y la fila no entra en ninguno de los dos
   * casos; lo que NO puede pasar es que el `INSERT` prospere.
   */
  const RECHAZOS = ["42501", "23514"]

  it.each(TABLES)("SIN GUC, el INSERT en %s se rechaza y la fila no entra", async (table) => {
    const [sql, params] = insertOf(table, ORG_A)
    const error = await sinGuc((client) => client.query(sql, params)).catch((e: { code?: string }) => e)
    expect(RECHAZOS, `${table} devolvió ${(error as { code?: string }).code}`).toContain(
      (error as { code?: string }).code
    )
    const after = await owner((client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
    )
    expect(after.rows[0].n, table).toBe(2)
  })

  it("SIN GUC, el INSERT en `allocation_runs` lo rechaza LA POLÍTICA (42501), sin trigger de por medio", async () => {
    // `allocation_runs` no tiene trigger `BEFORE INSERT`, así que aquí el 42501
    // prueba la política y nada más.
    const [sql, params] = insertOf("allocation_runs", ORG_A)
    await expect(sinGuc((client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  it("CON el GUC de A se ve exactamente lo de A y nada de B", async () => {
    for (const table of TABLES) {
      const rows = await conGuc(ORG_A, (client) =>
        client.query<{ organization_id: string }>(`SELECT organization_id FROM "${table}"`)
      )
      expect(rows.rows.length, table).toBe(1)
      expect(rows.rows[0].organization_id, table).toBe(ORG_A)
    }
  })

  it("CON el GUC de A, escribir una fila de B se rechaza (no se silencia) y no entra", async () => {
    for (const table of TABLES) {
      const [sql, params] = insertOf(table, ORG_B)
      const error = await conGuc(ORG_A, (client) => client.query(sql, params)).catch((e: { code?: string }) => e)
      expect(RECHAZOS, `${table} devolvió ${(error as { code?: string }).code}`).toContain(
        (error as { code?: string }).code
      )
    }
    // Y sobre `allocation_runs`, que no tiene trigger, es la política sin más.
    const [sql, params] = insertOf("allocation_runs", ORG_B)
    await expect(conGuc(ORG_A, (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  it("criterio 16 · `allocation_lines` es append-only PURO: 42501 y la fila intacta", async () => {
    await expect(
      conGuc(ORG_A, (client) => client.query(`UPDATE "allocation_lines" SET amount_cents = 1`))
    ).rejects.toMatchObject({ code: "42501" })
    await expect(conGuc(ORG_A, (client) => client.query(`DELETE FROM "allocation_lines"`))).rejects.toMatchObject({
      code: "42501",
    })
    const intact = await owner((client) =>
      client.query<{ amount_cents: number }>(`SELECT amount_cents FROM "allocation_lines" WHERE id = $1`, [
        idOf(ORG_A, "a5"),
      ])
    )
    // `bigint` en BD desde 20260910110000: `pg` lo devuelve como cadena.
    expect(Number(intact.rows[0].amount_cents)).toBe(12345)
  })

  it("criterio 16 · en `allocation_runs` sólo se puede tocar el estado, nunca el importe", async () => {
    await expect(
      conGuc(ORG_A, (client) => client.query(`UPDATE "allocation_runs" SET total_allocated_cents = 1`))
    ).rejects.toMatchObject({ code: "42501" })
    await expect(
      conGuc(ORG_A, (client) => client.query(`UPDATE "allocation_runs" SET ledger_hash = repeat('9', 64)`))
    ).rejects.toMatchObject({ code: "42501" })
    await expect(conGuc(ORG_A, (client) => client.query(`DELETE FROM "allocation_runs"`))).rejects.toMatchObject({
      code: "42501",
    })
    // La reversión SÍ se puede escribir: es la puerta acotada del append-only.
    const reversed = await conGuc(ORG_A, (client) =>
      client.query(
        `UPDATE "allocation_runs"
            SET status = 'REVERSED', reversed_at = now(), reversal_reason = 'motivo suficientemente largo'`
      )
    )
    expect(reversed.rowCount).toBe(1)
    const intact = await owner((client) =>
      client.query<{ total_allocated_cents: number; status: string }>(
        `SELECT total_allocated_cents, status FROM "allocation_runs" WHERE id = $1`,
        [idOf(ORG_A, "a4")]
      )
    )
    // El ROLLBACK del helper deja la fila como estaba: nada se ha persistido.
    expect(Number(intact.rows[0].total_allocated_cents)).toBe(12345)
    expect(intact.rows[0].status).toBe("SEALED")
  })

  it("`app_runtime` sólo tiene UPDATE sobre las CINCO columnas de `allocation_runs`", async () => {
    const rows = await owner((client) =>
      client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'allocation_runs' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'
          ORDER BY column_name`
      )
    )
    expect(rows.rows.map((r) => r.column_name)).toEqual(MUTABLE_RUN_COLUMNS)
  })

  it("`app_runtime` no tiene UPDATE ni DELETE sobre `allocation_lines`", async () => {
    const rows = await owner((client) =>
      client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE table_name = 'allocation_lines' AND grantee = 'app_runtime'
          ORDER BY privilege_type`
      )
    )
    expect(rows.rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"])
  })

  it("las reglas y sus destinos no se pueden borrar: se cierran con `valid_to`", async () => {
    for (const table of ["allocation_rules", "allocation_rule_targets"]) {
      await expect(conGuc(ORG_A, (client) => client.query(`DELETE FROM "${table}"`))).rejects.toMatchObject({
        code: "42501",
      })
    }
  })

  it("criterio 19 · ninguna de las cuatro queda en NO FORCE (ADR-0009 §7)", async () => {
    const rows = await owner((client) =>
      client.query<{ relname: string; relforcerowsecurity: boolean; relrowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity, relrowsecurity FROM pg_class WHERE relname = ANY($1)`,
        [[...TABLES]]
      )
    )
    expect(rows.rows).toHaveLength(4)
    for (const row of rows.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.relforcerowsecurity, row.relname).toBe(true)
    }
  })
})
