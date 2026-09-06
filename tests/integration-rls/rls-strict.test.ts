import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E3 · T3 — RLS ESTRICTA (ADR-0009), ejercida como `app_runtime` (LOGIN,
 * NOBYPASSRLS, no propietario). Aquí no hay red de seguridad: cualquier política
 * mal escrita rompe el test.
 *
 * Lo que demuestra, tabla por tabla:
 *   1. **SIN GUC no se lee NADA** (0 filas), donde antes la cláusula de escape
 *      `OR app.current_org() IS NULL` las devolvía TODAS. Ésta es la prueba de
 *      que la deuda de ADR-0007 está retirada de verdad.
 *   2. **SIN GUC no se escribe NADA**: el `INSERT` lo rechaza la política
 *      (`new row violates row-level security policy`) o el privilegio.
 *   3. Ninguna tabla de negocio queda en `NO FORCE` al final de la cadena de
 *      migraciones (ADR-0009 §7: el patrón de backfill debe restaurar el FORCE).
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string
const MAINTENANCE_URL = process.env.DATABASE_URL_MAINTENANCE as string

const ORG_A = "e3c00000-0000-4000-8000-00000000000a"
const ORG_B = "e3c00000-0000-4000-8000-00000000000b"
const USER_A = "e3c00000-0000-4000-8000-0000000000a1"

/**
 * Tablas de negocio con `organization_id NOT NULL` y política estricta.
 * `currencies` va aparte (conserva el catálogo global) y
 * `organizations`/`memberships` también (se aíslan por pertenencia).
 */
const TABLAS_ESTRICTAS = [
  "settings",
  "categories",
  // E4: `business_lines` va ANTES que `projects`, que la referencia (D-E4-1).
  "business_lines",
  "projects",
  "fields",
  "files",
  "transactions",
  "app_data",
  "progress",
  "invitations",
  "accounts",
  "organization_account_maps",
  "tax_rates",
  "audit_logs",
  // E4 (criterio 17): las otras dos tablas de dimensiones analíticas.
  "cost_centers",
  "margin_level_configs",
] as const

/**
 * Todas las que deben llevar RLS + FORCE (las de arriba, más las sueltas).
 *
 * `exchange_rates` entra aquí aunque **no** sea de tenant: es referencia global
 * (ADR-0014 D7) y no tiene `organization_id`, así que su política no puede ser
 * la estricta —pero sí lleva `ENABLE` + `FORCE`, de modo que la regla «ninguna
 * tabla en NO FORCE» la cubre igual. Un backfill que la dejara en `NO FORCE`
 * dejaría sus políticas append-only sin efecto para el propietario.
 */
const TABLAS_CON_FORCE = [
  ...TABLAS_ESTRICTAS,
  "currencies",
  "organizations",
  "memberships",
  // E8 · T3: las cuatro de tenant (su aislamiento se ejerce fila a fila en
  // `e8-tenant.test.ts`; aquí sólo se vigila que ningún backfill las deje en
  // `NO FORCE`) y la de referencia global.
  "extraction_runs",
  "prompt_versions",
  "invoice_series",
  "counterparties",
  "exchange_rates",
]

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

/** Conexión como `app_runtime` SIN fijar ningún GUC: el caso que esta épica cierra. */
async function sinGuc<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return await withClient(process.env.DATABASE_URL as string, async (client) => {
    await client.query("BEGIN")
    try {
      // Se comprueba que de verdad no hay contexto de tenant.
      const guc = await client.query<{ o: string | null; u: string | null }>(
        "SELECT app.current_org() AS o, app.current_user() AS u"
      )
      expect(guc.rows[0].o).toBeNull()
      expect(guc.rows[0].u).toBeNull()
      return await fn(client)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

/** Conexión como `app_runtime` con los GUC de una organización fijados. */
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

/**
 * `INSERT` COMPLETO (con todas las columnas obligatorias) para cada tabla
 * estricta. Se usa para sembrar los fixtures como propietario y, exactamente el
 * mismo SQL, para comprobar que SIN GUC lo rechaza la POLÍTICA (42501) y no un
 * `NOT NULL` cualquiera — que no probaría nada de RLS.
 */
function insertCompleto(tabla: (typeof TABLAS_ESTRICTAS)[number], organizationId: string): [string, unknown[]] {
  const sufijo = organizationId === ORG_A ? "a" : "b"
  switch (tabla) {
    case "settings":
      return [
        `INSERT INTO "settings" (id, organization_id, code, name, value, updated_at)
         VALUES (gen_random_uuid(), $1, 'e3-rls-${sufijo}', 'RLS', 'x', now())`,
        [organizationId],
      ]
    case "categories":
      return [
        `INSERT INTO "categories" (id, organization_id, code, name)
         VALUES (gen_random_uuid(), $1, 'e3-rls-${sufijo}', 'RLS')`,
        [organizationId],
      ]
    case "projects":
      // E4 (D-E4-1): `business_line_id` es NOT NULL y su FK es compuesta por
      // tenant, así que la línea de negocio del INSERT anterior es la única
      // que se puede referenciar — y sólo se ve con el GUC puesto.
      return [
        `INSERT INTO "projects" (id, organization_id, code, name, business_line_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'e3-rls-${sufijo}', 'RLS',
                 (SELECT id FROM "business_lines" WHERE organization_id = $1 ORDER BY code LIMIT 1), now())`,
        [organizationId],
      ]
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
    case "fields":
      return [
        `INSERT INTO "fields" (id, organization_id, code, name)
         VALUES (gen_random_uuid(), $1, 'e3-rls-${sufijo}', 'RLS')`,
        [organizationId],
      ]
    case "files":
      return [
        // E8 · T4: `sha256` es NOT NULL — sin el sha de los bytes no hay eslabón
        // entre el asiento y el documento (I-E8-2, I-E8-9).
        `INSERT INTO "files" (id, organization_id, filename, path, mimetype, sha256)
         VALUES (gen_random_uuid(), $1, 'f.pdf', 'e3/${sufijo}/f.pdf', 'application/pdf', repeat('a', 64))`,
        [organizationId],
      ]
    case "transactions":
      return [
        `INSERT INTO "transactions" (id, organization_id, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'T', now())`,
        [organizationId],
      ]
    case "app_data":
      return [
        `INSERT INTO "app_data" (id, organization_id, user_id, app, data)
         VALUES (gen_random_uuid(), $1, $2, 'e3-rls-${sufijo}', '{}'::jsonb)`,
        [organizationId, USER_A],
      ]
    case "progress":
      return [
        `INSERT INTO "progress" (id, organization_id, user_id, type)
         VALUES (gen_random_uuid(), $1, $2, 'e3-rls')`,
        [organizationId, USER_A],
      ]
    case "invitations":
      return [
        `INSERT INTO "invitations" (id, organization_id, email, role, token_hash, invited_by_id, expires_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'inv-${sufijo}@test.local', 'VIEWER', gen_random_uuid()::text, $2,
                 now() + interval '7 days', now())`,
        [organizationId, USER_A],
      ]
    case "accounts":
      return [
        `INSERT INTO "accounts" (id, organization_id, code, name, level, nature, updated_at)
         VALUES (gen_random_uuid(), $1, '9', 'Cuenta RLS', 1, 'DEUDORA', now())`,
        [organizationId],
      ]
    case "organization_account_maps":
      return [
        `INSERT INTO "organization_account_maps" (id, organization_id, key, account_code, updated_at)
         VALUES (gen_random_uuid(), $1, 'CAJA', '9', now())`,
        [organizationId],
      ]
    case "tax_rates":
      return [
        `INSERT INTO "tax_rates" (id, organization_id, code, name, kind, rate_bps, account_code, valid_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'e3-rls-${sufijo}', 'RLS', 'IVA', 2100, '9', now(), now())`,
        [organizationId],
      ]
    case "audit_logs":
      return [
        `INSERT INTO "audit_logs" (id, organization_id, entity, entity_id, action, ts)
         VALUES (gen_random_uuid(), $1::uuid, 'Organization', $1::text, 'seed', now())`,
        [organizationId],
      ]
  }
}

describe.skipIf(!OWNER_URL)("RLS estricta: sin GUC no se lee ni se escribe nada (ADR-0009)", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e3-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e3-rls-strict-a"],
        [ORG_B, "e3-rls-strict-b"],
      ]) {
        await client.query(
          `INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`,
          [id, slug]
        )
      }
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, accepted_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now(), now())`,
        [ORG_A, USER_A]
      )
      // Una fila de negocio en CADA tabla estricta, repartida entre A y B.
      for (const organizationId of [ORG_A, ORG_B]) {
        for (const tabla of TABLAS_ESTRICTAS) {
          const [sql, params] = insertCompleto(tabla, organizationId)
          await client.query(sql, params)
        }
        const sufijo = organizationId === ORG_A ? "A" : "B"
        await client.query(
          `INSERT INTO "currencies" (id, organization_id, code, name) VALUES (gen_random_uuid(), $1, $2, 'RLS')`,
          [organizationId, `E3${sufijo}`]
        )
      }
    })
  }, 90_000)

  afterAll(limpiar)

  async function limpiar() {
    await owner(async (client) => {
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
      await client.query(`DELETE FROM "users" WHERE id = $1`, [USER_A])
    })
  }

  it("los fixtures existen de verdad (si no, los ceros de abajo no probarían nada)", async () => {
    for (const tabla of TABLAS_ESTRICTAS) {
      const result = await owner(async (client) =>
        client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${tabla}" WHERE organization_id = ANY($1)`,
          [[ORG_A, ORG_B]]
        )
      )
      expect.soft(`${tabla}=${result.rows[0].n}`).toBe(`${tabla}=2`)
    }
  })

  it.each(TABLAS_ESTRICTAS)("SIN GUC, SELECT sobre %s devuelve 0 filas", async (tabla) => {
    const result = await sinGuc(async (client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tabla}"`)
    )
    expect(result.rows[0].n).toBe(0)
  })

  it("SIN GUC, `currencies` sólo deja ver el catálogo global (ninguna fila de organización)", async () => {
    const result = await sinGuc(async (client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "currencies" WHERE organization_id IS NOT NULL`)
    )
    expect(result.rows[0].n).toBe(0)
  })

  it("SIN GUC, `organizations` y `memberships` devuelven 0 filas", async () => {
    const result = await sinGuc(async (client) => ({
      orgs: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "organizations"`)).rows[0].n,
      members: (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "memberships"`)).rows[0].n,
    }))
    expect(result).toEqual({ orgs: 0, members: 0 })
  })

  it.each(TABLAS_ESTRICTAS)("SIN GUC, el INSERT en %s lo rechaza la POLÍTICA (42501)", async (tabla) => {
    const [sql, params] = insertCompleto(tabla, ORG_A)
    const resultado = await sinGuc(async (client) => {
      try {
        await client.query(sql, params)
        return "aceptado"
      } catch (error) {
        return (error as { code?: string }).code ?? "sin código"
      }
    })
    // 42501 = insufficient_privilege, que es como Postgres reporta tanto
    // «new row violates row-level security policy» como la falta de GRANT.
    expect(resultado).toBe("42501")
  })

  it("SIN GUC, UPDATE y DELETE afectan a 0 filas en todas las tablas estrictas", async () => {
    for (const tabla of TABLAS_ESTRICTAS) {
      const afectadas = await sinGuc(async (client) => {
        const del = await client.query(`DELETE FROM "${tabla}" WHERE organization_id = $1`, [ORG_A])
        return del.rowCount ?? 0
      }).catch(() => 0) // audit_logs: sin privilegio de DELETE, que también vale
      expect.soft(`${tabla}=${afectadas}`).toBe(`${tabla}=0`)
    }
  })

  it("CON GUC de A se ve exactamente lo de A y nada de B", async () => {
    for (const tabla of TABLAS_ESTRICTAS) {
      const filas = await conGuc(ORG_A, async (client) =>
        client.query<{ organization_id: string }>(`SELECT organization_id FROM "${tabla}"`)
      )
      expect.soft(`${tabla}:${filas.rows.map((r) => r.organization_id).join(",")}`).toBe(`${tabla}:${ORG_A}`)
    }
  })

  it("CON GUC de A, escribir una fila de B viola la política (no la silencia)", async () => {
    await expect(
      conGuc(ORG_A, async (client) =>
        client.query(
          `INSERT INTO "categories" (id, organization_id, code, name)
           VALUES (gen_random_uuid(), $1, 'intruso', 'Intruso')`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it("ninguna tabla de negocio queda en NO FORCE (ADR-0009 §7)", async () => {
    const result = await owner(async (client) =>
      client.query<{ relname: string; force: boolean; rls: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
        [TABLAS_CON_FORCE]
      )
    )
    expect(result.rows).toHaveLength(TABLAS_CON_FORCE.length)
    expect(result.rows.filter((row) => !row.rls || !row.force).map((row) => row.relname)).toEqual([])
  })

  it("ninguna política de negocio conserva la cláusula de escape de ADR-0007", async () => {
    const result = await owner(async (client) =>
      client.query<{ tablename: string; qual: string | null; with_check: string | null }>(
        `SELECT tablename, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`
      )
    )
    // El escape de ADR-0007 vivía en el USING de las dieciséis tablas.
    const conEscape = result.rows.filter((row) => (row.qual ?? "").includes("current_org() IS NULL"))
    expect(conEscape.map((row) => row.tablename)).toEqual([])

    // Y la deuda 1 de ESTADO.md, en el WITH CHECK de `organizations`: cualquier
    // usuario identificado podía insertar una organización con el id que quisiera.
    const organizations = result.rows.find((row) => row.tablename === "organizations")
    expect(organizations?.with_check).toBe("(id = app.current_org())")

    // `memberships` SÍ conserva `app.current_user()` en su WITH CHECK, y es
    // correcto: es lo que permite a quien acepta una invitación crear SU propia
    // membresía en una organización que todavía no es la activa. No es un escape:
    // acota a la fila del propio usuario.
    const memberships = result.rows.find((row) => row.tablename === "memberships")
    expect(memberships?.with_check).toContain("user_id = app.\"current_user\"()")
  })
})

describe.skipIf(!MAINTENANCE_URL)("rol app_maintenance (ADR-0009 §6)", () => {
  // El test SIEMBRA su propia organización en vez de depender de que otra suite
  // haya dejado alguna: el `afterAll` del bloque anterior las borra, así que
  // ejecutado solo (o el último) veía cero y fallaba por el estado, no por la
  // política (revisión E5 ronda 1: fallo «ajeno a E5» de `rls-strict.test.ts:389`).
  const ORG_MAINT = "e3c00000-0000-4000-8000-00000000000c"

  beforeAll(async () => {
    await owner((client) => client.query(`DELETE FROM "organizations" WHERE id = $1`, [ORG_MAINT]))
    await owner((client) =>
      client.query(`INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`, [
        ORG_MAINT,
        "e3-rls-maintenance",
      ])
    )
  })

  afterAll(async () => {
    await owner((client) => client.query(`DELETE FROM "organizations" WHERE id = $1`, [ORG_MAINT]))
  })

  it("tiene BYPASSRLS y ve más de una organización; `app_runtime` no", async () => {
    const maintenance = await withClient(MAINTENANCE_URL, async (client) => ({
      bypass: (
        await client.query<{ rolbypassrls: boolean }>(
          `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      ).rows[0].rolbypassrls,
      organizaciones: (
        await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "organizations"`)
      ).rows[0].n,
    }))
    expect(maintenance.bypass).toBe(true)
    expect(maintenance.organizaciones).toBeGreaterThan(0)

    const runtime = await withClient(process.env.DATABASE_URL as string, async (client) =>
      client.query<{ rolbypassrls: boolean }>(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`)
    )
    expect(runtime.rows[0].rolbypassrls).toBe(false)
  })
})
