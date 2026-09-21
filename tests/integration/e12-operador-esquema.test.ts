/**
 * E12 · T12 — el SQL de `20261001090000_e12_excepciones_de_operador`, contra
 * Postgres de verdad (ADR-0020 D2/D5; `docs/design/E12-fiabilidad-dod.md` §5.4).
 *
 * La misma forma que `e11a-esquema.test.ts`: **la regla está en la base, no sólo
 * en el código**. Un techo de 24 h que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL — y las excepciones de operador son justo el sitio
 * donde alguien con prisa intentaría esquivarlo.
 *
 *  · **CHECK de caducidad** (D5): `expires_at > created_at` y `<= +24 h`.
 *  · **CHECK de motivo**: ≥ 20 caracteres, en la base.
 *  · **Append-only** (`42501` a `UPDATE`/`DELETE` como `app_runtime`), no un
 *    `UPDATE` que pasa en silencio.
 *  · **Revocar es la función acotada** `app.revoke_operator_exception`, que
 *    escribe `revoked_at` y **no puede alargar** `expires_at`.
 *  · **RLS estricta**: `ENABLE` + `FORCE`, y la tabla no queda en `NO FORCE`.
 *  · **`ON DELETE RESTRICT`**: el registro de que alguien tocó la organización
 *    no desaparece por arrastre.
 *
 * Conecta con el rol PROPIETARIO; el aislamiento entre tenants vive en
 * `test:integration:rls`.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerDatabaseUrl } from "@/tests/support/env"

const OWNER_URL = process.env.DATABASE_URL_TEST || ownerDatabaseUrl()

const ORG = "e1200000-0000-4000-8000-00000000000a"
const OTRA = "e1200000-0000-4000-8000-00000000000b"
const LOCK = "e1200000-0000-4000-8000-0000000000c1"

const MOTIVO = "El bloqueo de septiembre se puso por error al importar el extracto"

let client: Client

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

/** SQLSTATE del fallo dentro de un savepoint, o `null` si pasó. */
async function errcode(sql: string, params: unknown[] = []): Promise<string | null> {
  await q("SAVEPOINT sp")
  try {
    await q(sql, params)
    await q("RELEASE SAVEPOINT sp")
    return null
  } catch (e) {
    await q("ROLLBACK TO SAVEPOINT sp")
    return (e as { code?: string }).code ?? "SIN_CODIGO"
  }
}

const insert = (over: Record<string, unknown> = {}) => {
  const f = {
    organization_id: ORG,
    kind: "UNBLOCK_PERIOD_LOCK",
    target_kind: "PERIOD_LOCK",
    target_id: LOCK,
    target_ref: null as string | null,
    reason: MOTIVO,
    requested_by: "pablo@cfonomic.com",
    created_at: "2026-10-01T10:00:00Z",
    expires_at: "2026-10-02T09:00:00Z",
    ...over,
  }
  return [
    `INSERT INTO operator_exceptions
       (organization_id, kind, target_kind, target_id, target_ref, reason, requested_by, created_at, expires_at)
     VALUES ($1::uuid, $2::operator_exception_kind, $3::operator_target_kind, $4::uuid, $5, $6, $7,
             $8::timestamp(3), $9::timestamp(3))
     RETURNING id`,
    [
      f.organization_id, f.kind, f.target_kind, f.target_id, f.target_ref,
      f.reason, f.requested_by, f.created_at, f.expires_at,
    ],
  ] as const
}

beforeAll(async () => {
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  // Todo el fichero en UNA transacción que se revierte al final.
  await q("BEGIN")
  await q(`DELETE FROM operator_exceptions WHERE organization_id IN ($1::uuid, $2::uuid)`, [ORG, OTRA])
  await q(`DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)`, [ORG, OTRA])
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at) VALUES
       ($1::uuid, 'e12-esquema-operador', 'E12 Operador S.L.', now()),
       ($2::uuid, 'e12-esquema-operador-2', 'E12 Otra S.L.', now())`,
    [ORG, OTRA]
  )
}, 60_000)

afterAll(async () => {
  if (client) {
    await q("ROLLBACK").catch(() => {})
    await client.end()
  }
})

describe("E12 · la tabla existe con la forma de ADR-0020", () => {
  it("los dos enums tienen exactamente los valores del ADR", async () => {
    const kinds = await q<{ v: string }>(
      `SELECT unnest(enum_range(NULL::operator_exception_kind))::text AS v ORDER BY 1`
    )
    expect(kinds.map((r) => r.v)).toEqual([
      "UNBLOCK_CLOSING_GUARD",
      "UNBLOCK_PERIOD_LOCK",
      "UNSTICK_CRON_JOB",
      "UNSTICK_RESTORE_JOB",
    ])
    const targets = await q<{ v: string }>(
      `SELECT unnest(enum_range(NULL::operator_target_kind))::text AS v ORDER BY 1`
    )
    expect(targets.map((r) => r.v)).toEqual(["CRON_JOB", "FISCAL_YEAR", "PERIOD_LOCK", "RESTORE_JOB"])
  })

  it("está en ENABLE + FORCE ROW LEVEL SECURITY y no queda en NO FORCE", async () => {
    const [row] = await q<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = 'operator_exceptions'`
    )
    expect(row).toEqual({ enabled: true, forced: true })
  })

  it("tiene las tres políticas: aislamiento + no_update + no_delete", async () => {
    const rows = await q<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'operator_exceptions' ORDER BY 1`
    )
    expect(rows.map((r) => r.policyname)).toEqual([
      "operator_exceptions_no_delete",
      "operator_exceptions_no_update",
      "tenant_isolation",
    ])
  })

  it("`app_runtime` no conserva UPDATE ni DELETE sobre la tabla (D2, vía 1)", async () => {
    const rows = await q<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'operator_exceptions' AND grantee = 'app_runtime' ORDER BY 1`
    )
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"])
  })
})

describe("E12 · los CHECK de D5 están en la BASE, no en TypeScript", () => {
  it("admite una excepción de 23 h", async () => {
    expect(await errcode(...insert())).toBeNull()
  })

  it("admite una excepción de exactamente 24 h (el borde cabe)", async () => {
    expect(await errcode(...insert({ expires_at: "2026-10-02T10:00:00Z" }))).toBeNull()
  })

  it("RECHAZA una excepción de 24 h y un segundo", async () => {
    expect(await errcode(...insert({ expires_at: "2026-10-02T10:00:01Z" }))).toBe("23514")
  })

  it("RECHAZA una excepción que caduca antes de nacer", async () => {
    expect(await errcode(...insert({ expires_at: "2026-10-01T09:00:00Z" }))).toBe("23514")
  })

  it("RECHAZA una excepción que caduca en el mismo instante en que nace", async () => {
    expect(await errcode(...insert({ expires_at: "2026-10-01T10:00:00Z" }))).toBe("23514")
  })

  it("RECHAZA un motivo de menos de 20 caracteres, y el relleno de espacios no cuenta", async () => {
    expect(await errcode(...insert({ reason: "arreglo" }))).toBe("23514")
    expect(await errcode(...insert({ reason: "  arreglo               " }))).toBe("23514")
  })

  it("RECHAZA una revocación anterior a la creación", async () => {
    const [{ id }] = await q<{ id: string }>(...insert())
    expect(
      await errcode(`UPDATE operator_exceptions SET revoked_at = $2::timestamp WHERE id = $1::uuid`, [
        id,
        "2026-10-01T09:00:00Z",
      ])
    ).toBe("23514")
  })

  it("la organización no se puede borrar mientras tenga una excepción (ON DELETE RESTRICT)", async () => {
    await q(...insert())
    expect(await errcode(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])).toBe("23503")
  })
})

describe("E12 · append-only y la función de revocación", () => {
  let id: string

  beforeAll(async () => {
    ;[{ id }] = await q<{ id: string }>(...insert())
  })

  it("`app_runtime` recibe 42501 al intentar UPDATE, no un silencio", async () => {
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const code = await errcode(`UPDATE operator_exceptions SET expires_at = now() + interval '10 days' WHERE id = $1::uuid`, [id])
    expect(code).toBe("42501")
    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })

  it("`app_runtime` recibe 42501 al intentar DELETE", async () => {
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const code = await errcode(`DELETE FROM operator_exceptions WHERE id = $1::uuid`, [id])
    expect(code).toBe("42501")
    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })

  it("la función acotada SÍ revoca, y devuelve `true` una sola vez", async () => {
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])

    const [primera] = await q<{ ok: boolean }>(
      `SELECT app.revoke_operator_exception($1::uuid, '2026-10-01T11:00:00Z'::timestamp(3)) AS ok`,
      [id]
    )
    expect(primera!.ok).toBe(true)

    // Revocar dos veces no es un error: simplemente no hace nada.
    const [segunda] = await q<{ ok: boolean }>(
      `SELECT app.revoke_operator_exception($1::uuid, '2026-10-01T12:00:00Z'::timestamp(3)) AS ok`,
      [id]
    )
    expect(segunda!.ok).toBe(false)

    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })

  it("la función NO puede revocar una excepción de OTRA organización", async () => {
    const [{ id: ajena }] = await q<{ id: string }>(...insert({ organization_id: OTRA }))
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const [r] = await q<{ ok: boolean }>(
      `SELECT app.revoke_operator_exception($1::uuid, '2026-10-01T11:00:00Z'::timestamp(3)) AS ok`,
      [ajena]
    )
    expect(r!.ok).toBe(false)
    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })

  it("la función sólo toca `revoked_at`: no existe camino para alargar la caducidad", async () => {
    const def = await q<{ src: string }>(
      `SELECT pg_get_functiondef(p.oid) AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'revoke_operator_exception'`
    )
    expect(def).toHaveLength(1)
    const src = def[0]!.src
    expect(src).toContain('SET "revoked_at"')
    expect(src).not.toContain("expires_at")
    // `SECURITY DEFINER` con `search_path` fijo (endurecimiento de Supabase).
    expect(src).toContain("SECURITY DEFINER")
    expect(src).toContain("search_path")
  })
})

describe("E12 · aislamiento por tenant sobre la tabla nueva", () => {
  it("`app_runtime` de una organización NO ve las excepciones de otra", async () => {
    await q(...insert({ organization_id: OTRA }))
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const filas = await q<{ organization_id: string }>(`SELECT organization_id FROM operator_exceptions`)
    expect(filas.every((f) => f.organization_id === ORG)).toBe(true)
    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })

  it("`app_runtime` no puede insertar una excepción en OTRA organización (WITH CHECK)", async () => {
    await q("SAVEPOINT rol")
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const code = await errcode(...insert({ organization_id: OTRA }))
    expect(code).toBe("42501")
    await q("ROLLBACK TO SAVEPOINT rol")
    await q(`RESET ROLE`)
  })
})
