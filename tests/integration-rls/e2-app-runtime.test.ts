import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E2 · T8 — RLS EFECTIVA de las cuatro tablas nuevas (ADR-0008), ejecutada como
 * `app_runtime` (LOGIN, NOBYPASSRLS, no propietario). Aquí no hay red: una
 * política mal escrita rompe el test.
 *
 * Criterio 11 del diseño: con `app.current_org = A`, `SELECT count(*)` de datos
 * de B devuelve 0, y `UPDATE`/`DELETE` sobre `audit_logs` afectan a 0 filas.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e2c00000-0000-4000-8000-00000000000a"
const ORG_B = "e2c00000-0000-4000-8000-00000000000b"
const USER_A = "e2c00000-0000-4000-8000-0000000000a1"

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Conexión CRUDA como app_runtime, para ejercer las políticas sin `tenantDb`. */
async function asRuntime<T>(organizationId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId ?? ""])
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

const { importNpgc, getPlan } = await import("@/models/accounts")
const { listAuditLog } = await import("@/models/audit-log")
const { tenantDb, prisma } = await import("@/lib/db")

describe.skipIf(!OWNER_URL)("E2 · accounts / maps / tax_rates / audit_logs como app_runtime", () => {
  beforeAll(async () => {
    await cleanup()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e2-rls@test.local', 'E2 RLS', now())`,
        [USER_A]
      )
      await client.query(
        `INSERT INTO "organizations" (id, slug, name, pgc_variant, updated_at) VALUES
           ($1,'e2-rls-a','E2 RLS A','PYMES', now()),
           ($2,'e2-rls-b','E2 RLS B','PYMES', now())`,
        [ORG_A, ORG_B]
      )
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now())`,
        [ORG_A, USER_A]
      )
    })
  }, 60_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [[ORG_A, ORG_B]])
      await client.query(`DELETE FROM "users" WHERE id = ANY($1)`, [[USER_A]])
    })
  }

  it("importNpgc() siembra las cuatro tablas bajo RLS (WITH CHECK incluido)", async () => {
    const a = await importNpgc(ORG_A, "PYMES", { actor: { userId: USER_A }, now: new Date("2026-09-04") })
    const b = await importNpgc(ORG_B, "PYMES", { actor: { userId: null }, now: new Date("2026-09-04") })
    expect(a.created).toBe(798)
    expect(b.created).toBe(798)
    expect(a.unresolvedKeys).toEqual([])

    // El log de sistema (CLI/alta) va sin usuario; el de sesión, con él.
    const logsA = await listAuditLog(tenantDb(ORG_A), { entity: "Organization", action: "seed" })
    const logsB = await listAuditLog(tenantDb(ORG_B), { entity: "Organization", action: "seed" })
    expect(logsA[0].userId).toBe(USER_A)
    expect(logsB[0].userId).toBeNull()
  }, 180_000)

  it("criterio 11 · con app.current_org = A no se ve NADA de B en las cuatro tablas", async () => {
    await asRuntime(ORG_A, async (client) => {
      for (const table of ["accounts", "organization_account_maps", "tax_rates", "audit_logs"]) {
        const propias = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = $1`, [ORG_A])
        const ajenas = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE organization_id = $1`, [ORG_B])
        expect(propias.rows[0].n, table).toBeGreaterThan(0)
        expect(ajenas.rows[0].n, table).toBe(0)
      }
    })
  })

  it("el WITH CHECK corta la escritura cruzada (sin escape, nunca)", async () => {
    await expect(
      asRuntime(ORG_A, async (client) =>
        client.query(
          `INSERT INTO "accounts" (id, organization_id, code, name, level, nature, updated_at)
           VALUES (gen_random_uuid(), $1, '999', 'Intrusa', 3, 'DEUDORA', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i)

    await expect(
      asRuntime(ORG_A, async (client) =>
        client.query(
          `INSERT INTO "audit_logs" (id, organization_id, entity, entity_id, action, ts)
           VALUES (gen_random_uuid(), $1, 'LedgerAccount', 'x', 'create', now())`,
          [ORG_B]
        )
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it("no se puede actualizar ni borrar una cuenta de otra organización (0 filas)", async () => {
    await asRuntime(ORG_A, async (client) => {
      const update = await client.query(
        `UPDATE "accounts" SET name = 'Secuestrada' WHERE organization_id = $1 AND code = '705'`,
        [ORG_B]
      )
      expect(update.rowCount).toBe(0)
      const del = await client.query(`DELETE FROM "accounts" WHERE organization_id = $1 AND code = '705'`, [ORG_B])
      expect(del.rowCount).toBe(0)
    })
    const planB = await getPlan(tenantDb(ORG_B))
    expect(planB.byCode.get("705")?.name).not.toBe("Secuestrada")
  })

  it("ADR-0008 · audit_logs es append-only: UPDATE y DELETE afectan a 0 filas propias", async () => {
    await asRuntime(ORG_A, async (client) => {
      const antes = await client.query(`SELECT count(*)::int AS n FROM "audit_logs" WHERE organization_id = $1`, [ORG_A])
      expect(antes.rows[0].n).toBeGreaterThan(0)

      // Ni siquiera sobre las PROPIAS filas: la política RESTRICTIVE es USING(false).
      const update = await client.query(`UPDATE "audit_logs" SET reason = 'manipulado' WHERE organization_id = $1`, [ORG_A])
      expect(update.rowCount).toBe(0)
      const del = await client.query(`DELETE FROM "audit_logs" WHERE organization_id = $1`, [ORG_A])
      expect(del.rowCount).toBe(0)

      const despues = await client.query(`SELECT count(*)::int AS n FROM "audit_logs" WHERE organization_id = $1`, [ORG_A])
      expect(despues.rows[0].n).toBe(antes.rows[0].n)
      const manipulados = await client.query(
        `SELECT count(*)::int AS n FROM "audit_logs" WHERE reason = 'manipulado'`
      )
      expect(manipulados.rows[0].n).toBe(0)
    })
  })

  it("ADR-0008 · audit_logs lleva las dos políticas RESTRICTIVE que la hacen inmutable", async () => {
    // La garantía real es la política, no el GRANT: `vitest.integration.rls.setup.ts`
    // concede UPDATE/DELETE sobre TODAS las tablas al preparar la base (y el
    // `ALTER DEFAULT PRIVILEGES` de E1 hace lo propio con las tablas nuevas), así
    // que el privilegio no es comprobable aquí. La migración de E2 sólo concede
    // SELECT+INSERT sobre `audit_logs`; el candado que sí se puede afirmar en
    // cualquier entorno es `USING (false)` en UPDATE y DELETE.
    const politicas = await owner(async (client) =>
      client.query(
        `SELECT policyname, cmd, permissive, qual
         FROM pg_policies WHERE tablename = 'audit_logs' ORDER BY policyname`
      )
    )
    const byName = new Map(politicas.rows.map((r) => [r.policyname, r]))
    for (const nombre of ["audit_logs_no_update", "audit_logs_no_delete"]) {
      const politica = byName.get(nombre)
      expect(politica, nombre).toBeTruthy()
      expect(politica.permissive).toBe("RESTRICTIVE")
      expect(String(politica.qual)).toBe("false")
    }
    expect(byName.get("audit_logs_no_update")?.cmd).toBe("UPDATE")
    expect(byName.get("audit_logs_no_delete")?.cmd).toBe("DELETE")
  })

  it("las cuatro tablas tienen RLS habilitada y su política tenant_isolation", async () => {
    const estado = await owner(async (client) =>
      client.query(
        `SELECT c.relname, c.relrowsecurity,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS politicas
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1) ORDER BY c.relname`,
        [["accounts", "organization_account_maps", "tax_rates", "audit_logs"]]
      )
    )
    expect(estado.rows).toHaveLength(4)
    for (const row of estado.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.politicas, row.relname).toBe(1)
    }
  })

  it("mutaciones de plan e impuestos por los models reales, bajo RLS", async () => {
    const { createAccount, deleteAccount } = await import("@/models/accounts")
    const { setAccountMapEntry } = await import("@/models/account-map")

    const creada = await createAccount(ORG_A, { code: "7050001", name: "Cliente X" }, { userId: USER_A })
    expect(creada.ok).toBe(true)

    const remap = await setAccountMapEntry(ORG_A, "COMPRAS_DEFAULT", "607", { userId: USER_A }, "servicios")
    expect(remap.ok).toBe(true)

    const borrada = await deleteAccount(ORG_A, "7050001", { userId: USER_A }, "limpieza")
    expect(borrada.ok).toBe(true)

    // Todo ello dejó rastro, y el rastro es de A.
    const logs = await listAuditLog(tenantDb(ORG_A), { entity: "LedgerAccount" })
    expect(logs.map((l) => l.action)).toContain("delete")
    expect(logs.every((l) => l.organizationId === ORG_A)).toBe(true)
  }, 60_000)
})
