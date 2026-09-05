import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E6 · T21 — `report_runs` y `manual_review_flags` como `app_runtime` (LOGIN,
 * NOBYPASSRLS, no propietario), que es el rol con el que la aplicación conecta
 * de verdad (ADR-0009). Criterio 21 de `docs/design/E6-informes.md` §8.1.
 *
 * Aquí no hay red: si una política está mal escrita, el test se cae.
 *  - Sin GUC, las dos tablas devuelven 0 filas y rechazan el INSERT.
 *  - Con el GUC de A no se ve **ni un solo** informe de B: un balance sellado es
 *    la cifra más sensible del producto y una fuga aquí es una fuga de las
 *    cuentas anuales de otra empresa.
 *  - **I-E6-16**: `report_runs` es append-only — `UPDATE` y `DELETE` fallan con
 *    42501 tanto por política RESTRICTIVE como por falta de privilegio.
 *  - `manual_review_flags` es SEMI-append-only: `app_runtime` puede escribir las
 *    tres columnas de limpieza y ninguna más, y no puede borrar.
 *  - Ninguna de las dos queda en `NO FORCE`.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e6c00000-0000-4000-8000-00000000000a"
const ORG_B = "e6c00000-0000-4000-8000-00000000000b"
const USER_A = "e6c00000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const TABLES = ["report_runs", "manual_review_flags"] as const

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

const HASH = (c: string) => c.repeat(64)

function insertOf(table: (typeof TABLES)[number], organizationId: string, marker = ""): [string, unknown[]] {
  const sufijo = organizationId === ORG_A ? "a" : "b"
  switch (table) {
    case "report_runs":
      return [
        `INSERT INTO "report_runs"
           (id, organization_id, type, period_start, period_end, params, params_hash, ledger_hash,
            git_sha, result, provenance, validation, seal, duration_ms)
         VALUES (gen_random_uuid(), $1, 'BALANCE'::report_type, DATE '2026-01-01', DATE '2026-12-31',
                 '{"snapshot":"PRE_REGULARIZACION"}'::jsonb, $2, $3, 'c0e828f',
                 '{"totalActivoCents":1}'::jsonb, '{}'::jsonb, '{"checks":[]}'::jsonb,
                 'VALIDADO_AUTOMATICAMENTE'::seal, 1)`,
        [organizationId, HASH(sufijo === "a" ? "1" : "2") + marker.slice(0, 0), HASH(sufijo === "a" ? "3" : "4")],
      ]
    case "manual_review_flags":
      return [
        `INSERT INTO "manual_review_flags"
           (id, organization_id, period_start, period_end, reason, created_by_id)
         VALUES (gen_random_uuid(), $1, DATE '2026-01-01', DATE '2026-12-31',
                 'revisión de prueba del aislamiento${marker}', $2)`,
        [organizationId, USER_A],
      ]
  }
}

describe.skipIf(!OWNER_URL)("E6 · informes y avisos de revisión bajo RLS estricta", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e6-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e6-rls-a"],
        [ORG_B, "e6-rls-b"],
      ]) {
        await client.query(`INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`, [id, slug])
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
      await client.query(`DELETE FROM "report_runs" WHERE organization_id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "manual_review_flags" WHERE organization_id = ANY($1)`, [ORGS])
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

  it("con el GUC de A no se puede INSERTAR un informe a nombre de B", async () => {
    const [sql, params] = insertOf("report_runs", ORG_B, "-x")
    await expect(conGuc(ORG_A, async (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  // ── I-E6-16 ────────────────────────────────────────────────────────────────

  it("I-E6-16: app_runtime NO puede hacer UPDATE sobre `report_runs` (42501)", async () => {
    await expect(
      conGuc(ORG_A, async (client) =>
        client.query(`UPDATE "report_runs" SET seal = 'REQUIERE_REVISION'::seal WHERE organization_id = $1`, [ORG_A])
      )
    ).rejects.toMatchObject({ code: "42501" })
  })

  it("I-E6-16: app_runtime NO puede hacer DELETE sobre `report_runs` (42501)", async () => {
    await expect(
      conGuc(ORG_A, async (client) => client.query(`DELETE FROM "report_runs" WHERE organization_id = $1`, [ORG_A]))
    ).rejects.toMatchObject({ code: "42501" })
  })

  it("I-E6-16: app_runtime tampoco TIENE el privilegio de UPDATE/DELETE sobre `report_runs`", async () => {
    // Las políticas RESTRICTIVE son el candado; esto comprueba la SEGUNDA
    // cerradura, la de privilegio, que es la que sigue en pie el día que alguien
    // añada una política permisiva genérica.
    const rows = await owner(async (client) =>
      client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = 'report_runs' AND grantee = 'app_runtime'`
      )
    )
    const privileges = rows.rows.map((r) => r.privilege_type).sort()
    expect(privileges).not.toContain("UPDATE")
    expect(privileges).not.toContain("DELETE")
    expect(privileges).toContain("SELECT")
    expect(privileges).toContain("INSERT")
  })

  // ── manual_review_flags: semi-append-only ─────────────────────────────────

  it("app_runtime puede escribir SÓLO las tres columnas de limpieza", async () => {
    const rows = await owner(async (client) =>
      client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'public' AND table_name = 'manual_review_flags'
            AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'`
      )
    )
    expect(rows.rows.map((r) => r.column_name).sort()).toEqual(["clear_reason", "cleared_at", "cleared_by_id"])
  })

  it("levantar un aviso SÍ se puede: escribe las tres columnas y nada más", async () => {
    const updated = await conGuc(ORG_A, async (client) =>
      client.query(
        `UPDATE "manual_review_flags"
            SET cleared_at = now(), cleared_by_id = $2, clear_reason = 'revisado y conforme'
          WHERE organization_id = $1`,
        [ORG_A, USER_A]
      )
    )
    expect(updated.rowCount).toBe(1)
  })

  it("cambiar el MOTIVO de un aviso está prohibido (falta el privilegio de columna)", async () => {
    await expect(
      conGuc(ORG_A, async (client) =>
        client.query(`UPDATE "manual_review_flags" SET reason = 'otra cosa' WHERE organization_id = $1`, [ORG_A])
      )
    ).rejects.toMatchObject({ code: "42501" })
  })

  it("borrar un aviso está prohibido: se levanta, no se borra", async () => {
    await expect(
      conGuc(ORG_A, async (client) => client.query(`DELETE FROM "manual_review_flags" WHERE organization_id = $1`, [ORG_A]))
    ).rejects.toMatchObject({ code: "42501" })
  })

  // ── FORCE ─────────────────────────────────────────────────────────────────

  it.each(TABLES)("%s tiene RLS habilitada y FORZADA (nunca `NO FORCE`)", async (table) => {
    const rows = await owner(async (client) =>
      client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table]
      )
    )
    expect(rows.rows[0].relrowsecurity).toBe(true)
    expect(rows.rows[0].relforcerowsecurity).toBe(true)
  })

  // ── E6-UI-1: modelos NO tenant dentro de `tenantTransaction`, como app_runtime ──

  it("E6-UI-1: `tx.organization.*` ve su fila dentro de tenantTransaction (GUC fijados)", async () => {
    // Éste es el caso que la extensión rompía: los modelos sin `organization_id`
    // salían de la transacción y por tanto SIN `app.current_org`. Con RLS
    // estricta y como `app_runtime` —el rol real de la aplicación—, eso deja la
    // fila invisible y `findUniqueOrThrow` lanza «No record was found».
    const { tenantTransaction } = await import("@/lib/db")
    const org = await tenantTransaction(ORG_A, USER_A, async (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: ORG_A }, select: { id: true, slug: true } })
    )
    expect(org.id).toBe(ORG_A)
    expect(org.slug).toBe("e6-rls-a")
  })

  it("#16: pedir la organización AJENA por id LANZA, no devuelve null", async () => {
    // Un selector cruzado es un bug del llamante, no algo que silenciar: se
    // trata igual que en `scopeUniqueWhere` para los modelos de negocio.
    const { tenantTransaction, TenantError } = await import("@/lib/db")
    await expect(
      tenantTransaction(ORG_A, USER_A, async (tx) =>
        tx.organization.findFirst({ where: { id: ORG_B }, select: { id: true } })
      )
    ).rejects.toBeInstanceOf(TenantError)
  })

  it("#16: un `findFirst` SIN `where` no puede devolver otra organización", async () => {
    // Éste es el caso que se coló en E6: `Organization` no lleva
    // `organization_id`, así que la extensión no le inyectaba nada y
    // `findFirst()` devolvía cualquier fila visible por la política — la del
    // usuario, no necesariamente la del informe.
    const { tenantTransaction } = await import("@/lib/db")
    const org = await tenantTransaction(ORG_A, USER_A, async (tx) =>
      tx.organization.findFirst({ select: { id: true } })
    )
    expect(org?.id).toBe(ORG_A)
  })

  it("#16: `User` es pre-tenant y NO se acota por id (no está en el conjunto)", async () => {
    const { NON_TENANT_SCOPED_BY_ID } = await import("@/lib/db")
    expect(NON_TENANT_SCOPED_BY_ID.has("Organization")).toBe(true)
    expect(NON_TENANT_SCOPED_BY_ID.has("User")).toBe(false)
  })

  it("las dos tablas están en `TENANT_MODELS`", async () => {
    const { TENANT_MODELS } = await import("@/lib/db")
    expect(TENANT_MODELS.has("ReportRun")).toBe(true)
    expect(TENANT_MODELS.has("ManualReviewFlag")).toBe(true)
  })
})
