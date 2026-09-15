import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E10 · criterio 24 — Aislamiento. `docs/design/E10-presupuesto-horas.md` §12.1
 * nombra explícitamente este fichero como el que debe existir; no existía
 * (BUG-E10-1). Cubre, como `app_runtime` (LOGIN, NOBYPASSRLS, ADR-0009), las
 * SIETE tablas de E10 registradas en `TENANT_MODELS` (`lib/db.ts`):
 * `budgets`, `budget_lines`, `budget_hours_lines`, `time_entries`,
 * `employees`, `employee_rates`, `headcount_snapshots`. El foco explícito de
 * la tarea de QA son `budgets`, `time_entries` y `employee_rates`.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e10a0000-0000-4000-8000-00000000000a"
const ORG_B = "e10a0000-0000-4000-8000-00000000000b"
const USER_A = "e10a0000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const TABLES = [
  "budgets",
  "budget_lines",
  "budget_hours_lines",
  "time_entries",
  "employees",
  "employee_rates",
  "headcount_snapshots",
] as const

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

// IDs fijos por organización, para poder referenciarlos entre tablas.
function fyId(org: string) {
  return org === ORG_A ? "e10a0000-0000-4000-8000-0000000000f1" : "e10a0000-0000-4000-8000-0000000000f2"
}
function ccId(org: string) {
  return org === ORG_A ? "e10a0000-0000-4000-8000-0000000000c1" : "e10a0000-0000-4000-8000-0000000000c2"
}
function budgetId(org: string) {
  return org === ORG_A ? "e10a0000-0000-4000-8000-0000000000b1" : "e10a0000-0000-4000-8000-0000000000b2"
}
function employeeId(org: string) {
  return org === ORG_A ? "e10a0000-0000-4000-8000-0000000000e1" : "e10a0000-0000-4000-8000-0000000000e2"
}

function insertOf(table: (typeof TABLES)[number], organizationId: string, marker = ""): [string, unknown[]] {
  const sufijo = (organizationId === ORG_A ? "a" : "b") + marker
  switch (table) {
    case "budgets":
      return [
        `INSERT INTO "budgets" (id, organization_id, fiscal_year_id, scenario, revision, name, status, valid_from, updated_at)
         VALUES ($2, $1, $3, 'BASE', 0, 'RLS-${sufijo}', 'BORRADOR', DATE '2026-01-01', now())`,
        [organizationId, budgetId(organizationId), fyId(organizationId)],
      ]
    case "budget_lines":
      return [
        `INSERT INTO "budget_lines" (id, organization_id, budget_id, month, cost_center_id, analytic_type, margin_level, amount_cents)
         VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-01', $3, 'INDIRECTO_CECO'::analytic_type, 'EBITDA'::margin_level, -100000)`,
        [organizationId, budgetId(organizationId), ccId(organizationId)],
      ]
    case "budget_hours_lines":
      return [
        `INSERT INTO "budget_hours_lines" (id, organization_id, budget_id, month, cost_center_id, minutes)
         VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-01', $3, 480)`,
        [organizationId, budgetId(organizationId), ccId(organizationId)],
      ]
    case "employees":
      return [
        `INSERT INTO "employees" (id, organization_id, code, name, updated_at)
         VALUES ($2, $1, 'EMP-${sufijo}', 'RLS', now())`,
        [organizationId, employeeId(organizationId)],
      ]
    case "time_entries":
      return [
        `INSERT INTO "time_entries" (id, organization_id, employee_id, date, cost_center_id, minutes)
         VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-05', $3, 60)`,
        [organizationId, employeeId(organizationId), ccId(organizationId)],
      ]
    case "employee_rates":
      return [
        `INSERT INTO "employee_rates" (id, organization_id, employee_id, hourly_cost_cents, basis, valid_from)
         VALUES (gen_random_uuid(), $1, $2, 2500, 'COSTE_EMPRESA_CON_SS'::employee_rate_basis, DATE '2026-01-01')`,
        [organizationId, employeeId(organizationId)],
      ]
    case "headcount_snapshots":
      return [
        `INSERT INTO "headcount_snapshots" (id, organization_id, cost_center_id, period_end, fte_milli, headcount)
         VALUES (gen_random_uuid(), $1, $2, DATE '2026-01-31', 1000, 1)`,
        [organizationId, ccId(organizationId)],
      ]
  }
}

describe.skipIf(!OWNER_URL)("E10 · RLS de presupuesto y horas como app_runtime (criterio 24)", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e10-rls-a@test.local', 'A', now())`,
        [USER_A]
      )
      for (const [id, slug] of [
        [ORG_A, "e10-rls-a"],
        [ORG_B, "e10-rls-b"],
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
        await client.query(
          `INSERT INTO "fiscal_years" (id, organization_id, code, start_date, end_date, updated_at)
           VALUES ($1, $2, '2026', DATE '2026-01-01', DATE '2026-12-31', now())`,
          [fyId(organizationId), organizationId]
        )
        await client.query(
          `INSERT INTO "cost_centers" (id, organization_id, code, name, kind, margin_level, updated_at)
           VALUES ($1, $2, 'CC-RLS', 'RLS', 'G_A'::cost_center_kind, 'EBITDA'::margin_level, now())`,
          [ccId(organizationId), organizationId]
        )
      }
      // Orden por dependencias: employees antes de time_entries/employee_rates;
      // budgets antes de budget_lines/budget_hours_lines.
      for (const table of ["employees", "budgets", "budget_lines", "budget_hours_lines", "time_entries", "employee_rates", "headcount_snapshots"] as const) {
        for (const organizationId of ORGS) {
          const [sql, params] = insertOf(table, organizationId)
          await client.query(sql, params)
        }
      }
    })
  }, 90_000)

  afterAll(limpiar)

  async function limpiar() {
    await owner(async (client) => {
      const deleteOrder = [
        "budget_hours_lines",
        "budget_lines",
        "time_entries",
        "employee_rates",
        "headcount_snapshots",
        "budgets",
        "employees",
      ] as const
      for (const table of deleteOrder) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = ANY($1)`, [ORGS])
      }
      await client.query(`DELETE FROM "cost_centers" WHERE organization_id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "fiscal_years" WHERE organization_id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "organizations" WHERE id = ANY($1)`, [ORGS])
      await client.query(`DELETE FROM "users" WHERE id = $1`, [USER_A])
    })
  }

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

  // `budget_hours_lines` y `time_entries` llevan además un trigger de negocio
  // (E10 T15/T17) que resuelve la versión de presupuesto o el ejercicio fiscal
  // con una SELECT sujeta a la MISMA RLS: sin GUC esa SELECT ya ve 0 filas y el
  // trigger aborta con su propio mensaje de dominio ANTES de que la política
  // WITH CHECK llegue a evaluarse — el resultado es el mismo (nada se escribe
  // sin GUC), pero el código de error no es 42501 sino el del trigger.
  const TRIGGER_GUARDED = new Set<(typeof TABLES)[number]>(["budget_lines", "budget_hours_lines", "time_entries"])

  it.each(TABLES)("SIN GUC, el INSERT en %s lo rechaza (política 42501, o el trigger de negocio vía RLS)", async (table) => {
    const [sql, params] = insertOf(table, ORG_A, "-x")
    const rejection = sinGuc(async (client) => client.query(sql, params))
    if (TRIGGER_GUARDED.has(table)) {
      await expect(rejection).rejects.toBeInstanceOf(Error)
    } else {
      await expect(rejection).rejects.toMatchObject({ code: "42501" })
    }
  })

  it.each(TABLES)("con el GUC de A, %s NO deja ver ni una fila de B", async (table) => {
    const rows = await conGuc(ORG_A, async (client) =>
      client.query<{ organization_id: string }>(`SELECT organization_id FROM "${table}"`)
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows.every((r) => r.organization_id === ORG_A)).toBe(true)
  })

  it("con el GUC de A no se puede insertar un presupuesto a nombre de B (42501)", async () => {
    const [sql, params] = insertOf("budgets", ORG_B, "-x")
    await expect(conGuc(ORG_A, async (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  it("con el GUC de A no se puede insertar un parte de horas a nombre de B", async () => {
    // Igual que arriba: el trigger de T17 busca el ejercicio de B con el GUC de
    // A puesto, no lo encuentra (RLS) y aborta con su propio mensaje — nunca
    // llega a existir la fila cruzada, que es lo que importa.
    const [sql, params] = insertOf("time_entries", ORG_B, "-x")
    await expect(conGuc(ORG_A, async (client) => client.query(sql, params))).rejects.toBeInstanceOf(Error)
  })

  it("con el GUC de A no se puede insertar una tarifa a nombre de B (42501)", async () => {
    const [sql, params] = insertOf("employee_rates", ORG_B, "-x")
    await expect(conGuc(ORG_A, async (client) => client.query(sql, params))).rejects.toMatchObject({ code: "42501" })
  })

  it("ninguna de las siete tablas queda en NO FORCE", async () => {
    const result = await owner(async (client) =>
      client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1) AND NOT c.relforcerowsecurity`,
        [TABLES]
      )
    )
    expect(result.rows.map((r) => r.relname)).toEqual([])
  })
})
