import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E8 · T3 — las cuatro tablas de tenant y la de referencia global, vistas por
 * `app_runtime` (LOGIN, NOBYPASSRLS, no propietario), que es el rol con el que
 * la aplicación conecta de verdad (ADR-0009).
 *
 * Lo que se defiende aquí, y ninguna de las tres cosas es la misma:
 *
 *  1. **Aislamiento (I-E8-12).** Sin GUC, cero filas y el INSERT rechazado; con
 *     el GUC de A, ni una fila de B. Una fuga en `extraction_runs` es la salida
 *     cruda del modelo sobre las facturas de otra empresa.
 *  2. **Inmutabilidad (I-E8-3).** `extraction_runs` y `prompt_versions` son
 *     append-only: `UPDATE`/`DELETE` dan **42501**, por política RESTRICTIVE y
 *     por falta de privilegio. Un `ExtractionRun` editable vuelve a ser
 *     `cachedParseResult`, que es justo lo que la épica retira.
 *  3. **`exchange_rates` es global y sigue con FORCE** (ADR-0014 D7). No tiene
 *     `organization_id`, así que no pasa por `enforce_tenant_rls`, pero sí lleva
 *     `ENABLE` + `FORCE`, lectura e inserción abiertas y `UPDATE`/`DELETE`
 *     cerrados: una tasa publicada por el BCE es pública y no se reescribe.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e8c00000-0000-4000-8000-00000000000a"
const ORG_B = "e8c00000-0000-4000-8000-00000000000b"
const USER_A = "e8c00000-0000-4000-8000-0000000000a1"
const FILE_A = "e8c00000-0000-4000-8000-0000000000f1"
const FILE_B = "e8c00000-0000-4000-8000-0000000000f2"
const ORGS = [ORG_A, ORG_B]

/** Las CUATRO tablas de tenant que E8 añade. */
const TABLES = ["extraction_runs", "prompt_versions", "invoice_series", "counterparties"] as const
/** Las dos que además son append-only. */
const APPEND_ONLY = ["extraction_runs", "prompt_versions"] as const

const SHA = (c: string) => c.repeat(64)

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

function insertOf(table: (typeof TABLES)[number], organizationId: string, marker = ""): [string, unknown[]] {
  const fileId = organizationId === ORG_A ? FILE_A : FILE_B
  const sufijo = (organizationId === ORG_A ? "a" : "b") + marker
  switch (table) {
    case "extraction_runs":
      return [
        `INSERT INTO "extraction_runs"
           (id, organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
            prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, duration_ms, git_sha)
         VALUES (gen_random_uuid(), $1, $2, $3, 'LLM', 'openai', 'gpt-x', 'extraccion', 'GIT',
                 $4, '1', $5, 1, 1, '{"n":1}'::jsonb, 100, 'c0e828f')`,
        [organizationId, fileId, SHA("a"), SHA("b"), SHA("c")],
      ]
    case "prompt_versions":
      return [
        `INSERT INTO "prompt_versions" (id, organization_id, code, version, content, sha256)
         VALUES (gen_random_uuid(), $1, $2, 1, 'Analiza el documento.', $3)`,
        [organizationId, `extraccion-${sufijo}`, SHA("d")],
      ]
    case "invoice_series":
      return [
        `INSERT INTO "invoice_series" (id, organization_id, code, kind, prefix, next_number, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ORDINARIA', 'F-', 1, now())`,
        [organizationId, `ORD-${sufijo}`],
      ]
    case "counterparties":
      return [
        `INSERT INTO "counterparties" (id, organization_id, code, name, tax_id, withholding_regime, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'Proveedor', 'B12345674', 'PROFESIONAL', now())`,
        [organizationId, `PROV-${sufijo}`],
      ]
  }
}

describe("E8 · RLS de las tablas de documentos como app_runtime", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e8-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e8-rls-a"],
        [ORG_B, "e8-rls-b"],
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
      for (const [fileId, organizationId] of [
        [FILE_A, ORG_A],
        [FILE_B, ORG_B],
      ]) {
        await client.query(
          `INSERT INTO "files" (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256)
           VALUES ($1, $2, $3, 'f.pdf', 'f.pdf', 'application/pdf', $4)`,
          [fileId, organizationId, organizationId === ORG_A ? USER_A : null, SHA("a")]
        )
      }
      for (const organizationId of ORGS) {
        for (const table of TABLES) {
          const [sql, params] = insertOf(table, organizationId)
          await client.query(sql, params)
        }
      }
      await client.query(
        `INSERT INTO "exchange_rates" (id, date, "from", "to", rate_micro, source)
         VALUES (gen_random_uuid(), DATE '2026-03-10', 'USD', 'EUR', 920000, 'ECB_FRANKFURTER')
         ON CONFLICT DO NOTHING`
      )
    })
  }, 90_000)

  afterAll(limpiar)

  async function limpiar() {
    await owner(async (client) => {
      for (const table of TABLES) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
      }
      await client.query(`DELETE FROM "files" WHERE organization_id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "users" WHERE id = $1`, [USER_A])
      await client.query(
        `DELETE FROM "exchange_rates" WHERE date = DATE '2026-03-10' AND "from" = 'USD' AND "to" = 'EUR'`
      )
    })
  }

  // ── 1. Aislamiento (I-E8-12) ───────────────────────────────────────────────

  it("los fixtures existen de verdad (si no, los ceros de abajo no probarían nada)", async () => {
    for (const table of TABLES) {
      const result = await owner(async (client) =>
        client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = ANY($1)`, [
          ORGS,
        ])
      )
      expect(result.rows[0].n, table).toBe(2)
    }
  })

  it.each(TABLES)("SIN GUC, SELECT sobre %s devuelve 0 filas", async (table) => {
    const result = await sinGuc(async (client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)
    )
    expect(result.rows[0].n).toBe(0)
  })

  it.each(TABLES)("SIN GUC, el INSERT en %s lo rechaza la política o el privilegio (42501)", async (table) => {
    const [sql, params] = insertOf(table, ORG_A, "-x")
    await expect(sinGuc(async (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  it.each(TABLES)("con el GUC de A, %s NO deja ver ni una fila de B", async (table) => {
    const rows = await conGuc(ORG_A, async (client) =>
      client.query<{ organization_id: string }>(`SELECT organization_id FROM "${table}"`)
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows.every((r) => r.organization_id === ORG_A)).toBe(true)
  })

  it("con el GUC de A no se puede insertar una extracción a nombre de B", async () => {
    const [sql, params] = insertOf("extraction_runs", ORG_B, "-x")
    await expect(conGuc(ORG_A, async (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  // ── 2. Inmutabilidad (I-E8-3) ──────────────────────────────────────────────

  it.each(APPEND_ONLY)("I-E8-3: app_runtime NO puede hacer UPDATE sobre %s (42501)", async (table) => {
    await expect(
      conGuc(ORG_A, async (client) =>
        client.query(`UPDATE "${table}" SET organization_id = organization_id WHERE organization_id = $1`, [ORG_A])
      )
    ).rejects.toMatchObject({ code: "42501" })
  })

  it.each(APPEND_ONLY)("I-E8-3: app_runtime NO puede hacer DELETE sobre %s (42501)", async (table) => {
    await expect(
      conGuc(ORG_A, async (client) => client.query(`DELETE FROM "${table}" WHERE organization_id = $1`, [ORG_A]))
    ).rejects.toMatchObject({ code: "42501" })
  })

  it.each(APPEND_ONLY)("I-E8-3: %s tampoco TIENE el privilegio de UPDATE/DELETE", async (table) => {
    // La política RESTRICTIVE es el candado; esto comprueba la SEGUNDA
    // cerradura, la que sigue en pie el día que alguien añada una política
    // permisiva genérica.
    const rows = await owner(async (client) =>
      client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee = 'app_runtime'`,
        [table]
      )
    )
    const privileges = rows.rows.map((r) => r.privilege_type)
    expect(privileges).not.toContain("UPDATE")
    expect(privileges).not.toContain("DELETE")
    expect(privileges).toContain("SELECT")
    expect(privileges).toContain("INSERT")
  })

  it("la fila del run sigue INTACTA después de los intentos", async () => {
    const rows = await owner(async (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "extraction_runs" WHERE organization_id = ANY($1)`,
        [ORGS]
      )
    )
    expect(rows.rows[0].n).toBe(2)
  })

  it("una serie de facturación no se BORRA: se desactiva (O-18)", async () => {
    await expect(
      conGuc(ORG_A, async (client) => client.query(`DELETE FROM "invoice_series" WHERE organization_id = $1`, [ORG_A]))
    ).rejects.toMatchObject({ code: "42501" })
  })

  // ── 3. `exchange_rates`: referencia global con FORCE (ADR-0014 D7) ─────────

  it("`exchange_rates` se LEE sin GUC: es un catálogo público, no un dato de nadie", async () => {
    const rows = await sinGuc(async (client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "exchange_rates"`)
    )
    expect(rows.rows[0].n).toBeGreaterThan(0)
  })

  it("`exchange_rates` lleva ENABLE **y FORCE**, aunque no tenga organization_id", async () => {
    // Es lo que mantiene válido el test de «ninguna tabla en NO FORCE»: la
    // excepción es la ausencia de `organization_id`, no la de RLS.
    const rows = await owner(async (client) =>
      client.query<{ rls: boolean; force: boolean }>(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'exchange_rates'`
      )
    )
    expect(rows.rows[0]).toEqual({ rls: true, force: true })
  })

  it("I-E8-14: `exchange_rates` es append-only — UPDATE y DELETE dan 42501", async () => {
    for (const sql of [
      `UPDATE "exchange_rates" SET rate_micro = 1 WHERE "from" = 'USD'`,
      `DELETE FROM "exchange_rates" WHERE "from" = 'USD'`,
    ]) {
      await expect(conGuc(ORG_A, async (client) => client.query(sql))).rejects.toMatchObject({ code: "42501" })
    }
  })

  // ── 4. El contrato del código coincide con el de la base ──────────────────

  it("las cuatro tablas de tenant están en `TENANT_MODELS`", async () => {
    const { TENANT_MODELS } = await import("@/lib/db")
    for (const model of ["ExtractionRun", "PromptVersion", "InvoiceSeries", "Counterparty"]) {
      expect(TENANT_MODELS.has(model), model).toBe(true)
    }
  })

  it("`ExchangeRate` está en `GLOBAL_REFERENCE_MODELS` y NO en `TENANT_MODELS`", async () => {
    // Si estuviera en `TENANT_MODELS`, `tenantDb` le inyectaría un filtro por
    // `organizationId` —una columna que no existe— y toda lectura fallaría.
    const { GLOBAL_REFERENCE_MODELS, TENANT_MODELS } = await import("@/lib/db")
    expect(GLOBAL_REFERENCE_MODELS.has("ExchangeRate")).toBe(true)
    expect(TENANT_MODELS.has("ExchangeRate")).toBe(false)
  })

  it("ninguna tabla de E8 tiene la cláusula de escape de ADR-0007", async () => {
    const rows = await owner(async (client) =>
      client.query<{ tablename: string; qual: string | null }>(
        `SELECT tablename, qual FROM pg_policies
          WHERE schemaname = 'public' AND policyname = 'tenant_isolation' AND tablename = ANY($1)`,
        [TABLES]
      )
    )
    expect(rows.rows).toHaveLength(TABLES.length)
    expect(rows.rows.filter((r) => (r.qual ?? "").includes("current_org() IS NULL"))).toEqual([])
  })
})
