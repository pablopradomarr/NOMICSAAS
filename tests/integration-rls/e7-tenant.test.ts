import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E7 · T3/T14 — las siete tablas nuevas y **`users`**, vistas por `app_runtime`
 * (LOGIN, NOBYPASSRLS, no propietario), que es el rol con el que la aplicación
 * conecta de verdad (ADR-0009), y por `app_auth` (ADR-0015 D5).
 *
 * Tres cosas distintas, y ninguna se demuestra sola:
 *
 *  1. **Aislamiento.** Sin GUC, cero filas y el INSERT rechazado; con el GUC de
 *     A, ni una fila de B. Una fuga en `bank_statement_lines` es el extracto
 *     bancario de otra empresa.
 *  2. **Inmutabilidad.** `invariant_runs` es append-only —un barrido sellado que
 *     se pudiera editar no acreditaría nada, y I-E7-7 no tendría contra qué
 *     comparar—; `bank_statements`, `bank_statement_lines`, `bank_match_groups`
 *     y `bank_reconciliations` son semi: sólo las columnas que la épica declara.
 *  3. **`users` bajo RLS (ADR-0015 D5).** Hasta E7, un `SELECT * FROM users`
 *     desde `app_runtime` enumeraba los correos de todos los clientes del SaaS.
 *     Ahora `app_runtime` ve su propia fila y la de quien comparte la
 *     organización ACTIVA, y no puede dar de alta ni borrar; `app_auth`, que es
 *     el rol del camino de autenticación, sí lee y escribe sin sesión — que es
 *     exactamente lo que necesita, y nada más.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e7c00000-0000-4000-8000-00000000000a"
const ORG_B = "e7c00000-0000-4000-8000-00000000000b"
const USER_A = "e7c00000-0000-4000-8000-0000000000a1"
const USER_B = "e7c00000-0000-4000-8000-0000000000b1"

/** Las OCHO tablas de tenant que E7 añade (la última, en la ronda 1: H-5). */
const TABLES = [
  "invariant_runs",
  "store_sweeps",
  "bank_accounts",
  "bank_statements",
  "bank_statement_lines",
  "bank_match_groups",
  "bank_reconciliations",
  "bank_pending_kinds",
] as const

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

const owner = <T>(fn: (client: Client) => Promise<T>) => withClient(OWNER_URL, fn)

/** URL del rol `app_auth`, derivada de la del propietario como las demás. */
function authUrl(): string {
  const url = new URL(OWNER_URL)
  url.username = "app_auth"
  url.password = process.env.APP_AUTH_PASSWORD || "app_auth"
  return url.toString()
}

async function sinGuc<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return await withClient(process.env.DATABASE_URL as string, async (client) => {
    await client.query("BEGIN")
    try {
      return await fn(client)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

async function conGuc<T>(organizationId: string, userId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return await withClient(process.env.DATABASE_URL as string, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId])
      await client.query("SELECT set_config('app.current_user', $1, true)", [userId])
      return await fn(client)
    } finally {
      await client.query("ROLLBACK")
    }
  })
}

/** Siembra por el PROPIETARIO una fila de cada tabla en las dos organizaciones. */
async function seed(client: Client, organizationId: string, userId: string): Promise<void> {
  const suf = organizationId === ORG_A ? "a" : "b"
  await client.query(
    `INSERT INTO "accounts" (id, organization_id, code, name, level, nature, is_postable, is_active, updated_at)
     VALUES (gen_random_uuid(), $1, '5720', 'Banco c/c', 4, 'DEUDORA', true, true, now()),
            (gen_random_uuid(), $1, '626', 'Servicios bancarios', 3, 'DEUDORA', true, true, now())`,
    [organizationId]
  )
  await client.query(
    `INSERT INTO "invariant_runs"
       (id, organization_id, scope_kind, trigger, ref_date, ledger_hash, plan_hash, account_map_hash,
        config_hash, git_sha, checks_hash, checks, counts, coverage, headline, seal, duration_ms, run_by_id)
     VALUES (gen_random_uuid(), $1, 'ORGANIZATION', 'MANUAL', DATE '2026-03-31', $2, $3, $4, $5, 'sha', $6,
             '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'VALIDADO_AUTOMATICAMENTE', 0, $7)`,
    [organizationId, SHA("1"), SHA("2"), SHA("3"), SHA("4"), SHA("5"), userId]
  )
  await client.query(`INSERT INTO "store_sweeps" (id, organization_id, run_by_id) VALUES (gen_random_uuid(), $1, $2)`, [
    organizationId,
    userId,
  ])
  const account = await client.query<{ id: string }>(
    `INSERT INTO "bank_accounts" (id, organization_id, code, name, account_code, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Banco', '5720', now()) RETURNING id`,
    [organizationId, `BK-${suf}`]
  )
  const statement = await client.query<{ id: string }>(
    `INSERT INTO "bank_statements"
       (id, organization_id, bank_account_id, format, file_sha256, file_name, currency,
        period_start, period_end, opening_balance_cents, closing_balance_cents)
     VALUES (gen_random_uuid(), $1, $2, 'CSV', $3, 'extracto.csv', 'EUR',
             '2026-03-01', '2026-03-31', 0, 0) RETURNING id`,
    [organizationId, account.rows[0].id, SHA(suf === "a" ? "a" : "b")]
  )
  await client.query(
    `INSERT INTO "bank_statement_lines"
       (id, organization_id, statement_id, bank_account_id, line_no, operation_date, value_date,
        amount_cents, currency, description, sha256)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, '2026-03-10', '2026-03-10', -1000, 'EUR', 'cargo', $4)`,
    [organizationId, statement.rows[0].id, account.rows[0].id, SHA(suf === "a" ? "c" : "d")]
  )
  const line = await client.query<{ id: string }>(`SELECT id FROM "bank_statement_lines" WHERE organization_id = $1`, [
    organizationId,
  ])
  const group = await client.query<{ id: string }>(
    `INSERT INTO "bank_match_groups" (id, organization_id, bank_account_id, kind, created_by_id)
     VALUES (gen_random_uuid(), $1, $2, 'SIMPLE', $3) RETURNING id`,
    [organizationId, account.rows[0].id, userId]
  )

  // Y una conciliación de verdad, para que la prueba de aislamiento de
  // `bank_reconciliations` no pase por estar la tabla vacía. El apunte tiene que
  // ser de la MISMA subcuenta y del MISMO importe con signo (I-E7-2, D6.4).
  const fy = await client.query<{ id: string }>(
    `INSERT INTO "fiscal_years" (id, organization_id, code, start_date, end_date, status, updated_at)
     VALUES (gen_random_uuid(), $1, '2026', '2026-01-01', '2026-12-31', 'OPEN', now()) RETURNING id`,
    [organizationId]
  )
  const entry = await client.query<{ id: string }>(
    `INSERT INTO "journal_entries"
       (id, organization_id, fiscal_year_id, entry_number, entry_date, description, posted_by_id,
        entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1, $2, 1, DATE '2026-03-10', 'pago', $3, repeat('0', 64), 3) RETURNING id`,
    [organizationId, fy.rows[0].id, userId]
  )
  const journalLine = await client.query<{ id: string }>(
    `INSERT INTO "journal_lines"
       (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
        entry_date, fiscal_year_id, entry_kind)
     VALUES (gen_random_uuid(), $1, $2, 1, '5720', 0, 1000, DATE '2026-03-10', $3, 'NORMAL'),
            (gen_random_uuid(), $1, $2, 2, '626', 1000, 0, DATE '2026-03-10', $3, 'NORMAL')
     RETURNING id`,
    [organizationId, entry.rows[0].id, fy.rows[0].id]
  )
  await client.query(
    `INSERT INTO "bank_reconciliations"
       (id, organization_id, group_id, statement_line_id, journal_line_id, method, date_gap_days, matched_by_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MANUAL', 0, $5)`,
    [organizationId, group.rows[0].id, line.rows[0].id, journalLine.rows[0].id, userId]
  )
  // E7 · ronda 1 (H-5): el tipado del pendiente es tan sensible como el resto
  // —dice qué es un movimiento de una cuenta bancaria— y lleva la misma RLS.
  // Se tipa el apunte de LIBROS, que es el lado que no se puede tipar en el
  // diario porque `journal_lines` es append-only.
  await client.query(
    `INSERT INTO "bank_pending_kinds"
       (id, organization_id, bank_account_id, journal_line_id, kind, declared_by_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 'CHEQUE_EMITIDO_NO_CARGADO', $4)`,
    [organizationId, account.rows[0].id, journalLine.rows[0].id, userId]
  )
}

async function limpiar(): Promise<void> {
  await owner(async (client) => {
    await client.query(`DELETE FROM "organizations" WHERE id = ANY($1::uuid[])`, [[ORG_A, ORG_B]])
    await client.query(`DELETE FROM "users" WHERE id = ANY($1::uuid[])`, [[USER_A, USER_B]])
  })
}

// La siembra y la limpieza van a NIVEL DE FICHERO: registradas dentro del primer
// `describe`, su `afterAll` corría antes del segundo bloque y éste se encontraba
// la tabla `users` ya vacía.
beforeAll(async () => {
  await limpiar()
  await owner(async (client) => {
    // El cuadre de I1 lo comprueban triggers DIFERIDOS al COMMIT: la siembra
    // entera va en UNA transacción o el asiento se rechaza «sin líneas» en
    // cuanto se inserta la cabecera.
    await client.query("BEGIN")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
    for (const [id, email] of [
      [USER_A, "e7-rls-a@test.local"],
      [USER_B, "e7-rls-b@test.local"],
    ]) {
      await client.query(`INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, $2, 'U', now())`, [id, email])
    }
    for (const [id, slug] of [
      [ORG_A, "e7-rls-a"],
      [ORG_B, "e7-rls-b"],
    ]) {
      await client.query(`INSERT INTO "organizations" (id, slug, name, updated_at) VALUES ($1, $2, $2, now())`, [
        id,
        slug,
      ])
    }
    for (const [org, user] of [
      [ORG_A, USER_A],
      [ORG_B, USER_B],
    ]) {
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now())`,
        [org, user]
      )
      await seed(client, org, user)
    }
    await client.query("COMMIT")
  })
})

afterAll(limpiar)

describe("E7 · RLS de auditoría y conciliación como app_runtime", () => {
  it.each(TABLES)("`%s`: sin GUC no se ve NADA (la RLS no da error: devuelve vacío)", async (table) => {
    const rows = await sinGuc(async (client) => (await client.query(`SELECT * FROM "${table}"`)).rows)
    expect(rows).toHaveLength(0)
  })

  it.each(TABLES)("`%s`: con el GUC de A, ni una fila de B", async (table) => {
    const rows = await conGuc(
      ORG_A,
      USER_A,
      async (client) => (await client.query<{ organization_id: string }>(`SELECT organization_id FROM "${table}"`)).rows
    )
    for (const row of rows) expect(row.organization_id).toBe(ORG_A)
    expect(rows.every((r) => r.organization_id !== ORG_B)).toBe(true)
  })

  it("`invariant_runs` es APPEND-ONLY: UPDATE y DELETE dan 42501", async () => {
    await conGuc(ORG_A, USER_A, async (client) => {
      for (const sql of [`UPDATE "invariant_runs" SET checks_hash = repeat('9', 64)`, `DELETE FROM "invariant_runs"`]) {
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" })
        await client.query("ROLLBACK")
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A])
      }
    })
  })

  it.each(["bank_statements", "bank_statement_lines", "bank_match_groups", "bank_reconciliations"] as const)(
    "`%s`: nada se borra (42501 al DELETE)",
    async (table) => {
      await conGuc(ORG_A, USER_A, async (client) => {
        await expect(client.query(`DELETE FROM "${table}"`)).rejects.toMatchObject({ code: "42501" })
      })
    }
  )

  it("una organización no puede sembrar una fila con el `organization_id` de otra", async () => {
    await conGuc(ORG_A, USER_A, async (client) => {
      await expect(
        client.query(`INSERT INTO "store_sweeps" (id, organization_id) VALUES (gen_random_uuid(), $1)`, [ORG_B])
      ).rejects.toMatchObject({ code: "42501" })
    })
  })
})

describe("E7 · T14 — `users` bajo RLS con políticas por rol (ADR-0015 D5)", () => {
  it("`app_runtime` ve su propia fila y la de quien comparte la organización ACTIVA, y NADA más", async () => {
    const emails = await conGuc(ORG_A, USER_A, async (client) =>
      (await client.query<{ email: string }>(`SELECT email FROM "users" ORDER BY email`)).rows.map((r) => r.email)
    )
    expect(emails).toContain("e7-rls-a@test.local")
    // Éste es el agujero que la épica cierra: el correo de un cliente de otra
    // organización se enumeraba con un `SELECT *`.
    expect(emails).not.toContain("e7-rls-b@test.local")
  })

  it("sin organización activa, `app_runtime` no ve ni su propia fila si no se identifica", async () => {
    const rows = await sinGuc(async (client) => (await client.query(`SELECT * FROM "users"`)).rows)
    expect(rows).toHaveLength(0)
  })

  it("`app_runtime` no da de alta usuarios ni los borra: eso es del camino de autenticación", async () => {
    await conGuc(ORG_A, USER_A, async (client) => {
      await expect(
        client.query(`INSERT INTO "users" (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, 'X', now())`, [
          "colado@test.local",
        ])
      ).rejects.toMatchObject({ code: "42501" })
    })
    await conGuc(ORG_A, USER_A, async (client) => {
      await expect(client.query(`DELETE FROM "users"`)).rejects.toMatchObject({ code: "42501" })
    })
  })

  it("`app_runtime` sólo actualiza SU fila", async () => {
    await conGuc(ORG_A, USER_A, async (client) => {
      const propia = await client.query(`UPDATE "users" SET name = 'Yo mismo' WHERE id = $1`, [USER_A])
      expect(propia.rowCount).toBe(1)
      // La de otro no da error: la política la deja fuera y no hay fila que tocar.
      const ajena = await client.query(`UPDATE "users" SET name = 'Otro' WHERE id = $1`, [USER_B])
      expect(ajena.rowCount).toBe(0)
    })
  })

  it("`app_auth` —y sólo él— lee y escribe SIN sesión: es lo que el alta necesita", async () => {
    await withClient(authUrl(), async (client) => {
      await client.query("BEGIN")
      try {
        const rows = await client.query<{ email: string }>(`SELECT email FROM "users" WHERE id = ANY($1::uuid[])`, [
          [USER_A, USER_B],
        ])
        expect(rows.rowCount).toBe(2)
        const alta = await client.query(
          `INSERT INTO "users" (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, 'Alta', now())`,
          ["e7-rls-alta@test.local"]
        )
        expect(alta.rowCount).toBe(1)
        // …pero NO borra: la política de DELETE es RESTRICTIVE y aplica a todos.
        await expect(client.query(`DELETE FROM "users" WHERE email = $1`, ["e7-rls-alta@test.local"])).rejects.toThrow()
      } finally {
        await client.query("ROLLBACK")
      }
    })
  })

  it("`app_auth` NO es un segundo `app_runtime`: no tiene privilegio sobre el negocio", async () => {
    await withClient(authUrl(), async (client) => {
      await expect(client.query(`SELECT * FROM "journal_lines"`)).rejects.toMatchObject({ code: "42501" })
      await expect(client.query(`SELECT * FROM "bank_statement_lines"`)).rejects.toMatchObject({ code: "42501" })
    })
  })

  it("**el camino de alta REAL sigue funcionando**: `models/users.ts` sobre `app_auth`", async () => {
    // Sustituto del e2e de login para lo único que M5 podía romper: que el alta
    // y la lectura por identidad ocurren SIN sesión y ya no las hace
    // `app_runtime`. Es el código de producción, no una consulta escrita aquí.
    const { getOrCreateInvitedUser, updateUser } = await import("@/models/users")
    const email = "e7-rls-invitado@test.local"
    try {
      const creado = await getOrCreateInvitedUser(email, "Invitado")
      expect(creado.email).toBe(email)
      expect(creado.emailVerified).toBe(false)
      // Idempotente: la segunda llamada devuelve el mismo usuario.
      expect((await getOrCreateInvitedUser(email)).id).toBe(creado.id)
      // Y better-auth marca la verificación por este mismo camino.
      const verificado = await updateUser(creado.id, { emailVerified: true })
      expect(verificado.emailVerified).toBe(true)
    } finally {
      await owner(async (client) => {
        await client.query(`DELETE FROM "users" WHERE email = $1`, [email])
      })
    }
  })

  it("`users` lleva ENABLE + FORCE: el propietario tampoco se salta las políticas", async () => {
    const [row] = await owner(
      async (client) =>
        (
          await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'`
          )
        ).rows
    )
    expect(row.relrowsecurity).toBe(true)
    expect(row.relforcerowsecurity).toBe(true)
  })
})
