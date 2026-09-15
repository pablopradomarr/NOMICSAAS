/**
 * E11 · integración de las tres olas — **ADR-0019 D9 contra Postgres de verdad**
 * y las rutas de Stripe apagadas.
 *
 * Lo que aquí se comprueba es lo que un test puro no puede: que la migración
 * **M6** dejó en la base lo que D9 promete.
 *
 *  · el plan `ILIMITADO` existe, **no es vendible** y tiene los siete límites a
 *    `-1` (la retención, no: el CHECK de M1 exige `> 0`);
 *  · **ninguna organización se queda sin `Subscription`** (I-E11-5), y las que
 *    M4 dejó en `FREE` sin haber contratado nada están en `ILIMITADO`;
 *  · `storage_used` y `storage_limit` son **`bigint`** — `integer` topaba en
 *    2,147 GB contra un plan PRO de 100 GB (§2.7);
 *  · **`ai_balance` ya no existe** (ADR-0019 D1.5, O-14): era un saldo
 *    almacenado que P2/P4 prohíben y que además nunca se decrementó (G-12);
 *  · `plans` y `subscriptions` siguen en **`FORCE ROW LEVEL SECURITY`**: el baile
 *    `NO FORCE → backfill → FORCE` de M6 no dejó ninguna puerta abierta.
 *
 * Conecta con el rol PROPIETARIO, como `e11a-esquema.test.ts`: aquí se ejercen
 * constraints y catálogo, no el aislamiento por tenant.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerDatabaseUrl } from "@/tests/support/env"

const OWNER_URL = process.env.DATABASE_URL_TEST || ownerDatabaseUrl()

const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"

let client: Client

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

beforeAll(async () => {
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

describe("M6 · el plan ILIMITADO del modo interno (D9)", () => {
  it("existe, con su id estable y su código", async () => {
    const rows = await q<{ id: string; code: string; is_public: boolean; stripe_price_id: string | null }>(
      `SELECT "id", "code", "is_public", "stripe_price_id" FROM "plans" WHERE "code" = 'ILIMITADO'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(PLAN_ILIMITADO)
  })

  it("NO es vendible: ni público en el alta ni con precio en Stripe (P-1)", async () => {
    const [plan] = await q<{ is_public: boolean; stripe_price_id: string | null; list_price_cents: number }>(
      `SELECT "is_public", "stripe_price_id", "list_price_cents" FROM "plans" WHERE "code" = 'ILIMITADO'`
    )
    expect(plan.is_public).toBe(false)
    expect(plan.stripe_price_id).toBeNull()
    expect(plan.list_price_cents).toBe(0)
  })

  it("los siete límites son −1; la retención, no (el CHECK de M1 exige > 0)", async () => {
    const [plan] = await q<Record<string, string | number>>(
      `SELECT "max_members", "max_ocr_docs_month", "max_storage_bytes"::text AS "max_storage_bytes",
              "max_exports_month", "max_backups_month", "max_organizations",
              "soft_max_entries_month", "backup_retention_days"
         FROM "plans" WHERE "code" = 'ILIMITADO'`
    )
    expect(plan.max_members).toBe(-1)
    expect(plan.max_ocr_docs_month).toBe(-1)
    expect(plan.max_storage_bytes).toBe("-1")
    expect(plan.max_exports_month).toBe(-1)
    expect(plan.max_backups_month).toBe(-1)
    expect(plan.max_organizations).toBe(-1)
    expect(plan.soft_max_entries_month).toBe(-1)
    expect(Number(plan.backup_retention_days)).toBeGreaterThan(0)
  })

  it("el catálogo del modo `stripe` sigue completo: FREE, STARTER y PRO intactos", async () => {
    const rows = await q<{ code: string }>(`SELECT "code" FROM "plans" ORDER BY "code"`)
    expect(rows.map((r) => r.code)).toEqual(["FREE", "ILIMITADO", "PRO", "STARTER"])
  })
})

describe("M6 · backfill de suscripciones", () => {
  it("I-E11-5: ninguna organización se queda sin Subscription", async () => {
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM "organizations" o
        WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id")`
    )
    expect(n).toBe("0")
  })

  it("no queda ningún FREE sin contratar: el backfill los pasó a ILIMITADO", async () => {
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM "subscriptions"
        WHERE "plan_code" = 'FREE' AND "stripe_subscription_id" IS NULL`
    )
    expect(n).toBe("0")
  })

  it("y no se ha tocado ninguna suscripción CON identificador de Stripe", async () => {
    // Reescribir lo que alguien contrató sería lo contrario de lo que D1.2
    // promete: un cambio de límites no reescribe retroactivamente lo prometido.
    const rows = await q<{ plan_code: string }>(
      `SELECT "plan_code" FROM "subscriptions" WHERE "stripe_subscription_id" IS NOT NULL`
    )
    expect(rows.every((r) => r.plan_code !== "ILIMITADO")).toBe(true)
  })
})

describe("M6 · las dos columnas de §2.7 y la retirada de ai_balance", () => {
  it("storage_used y storage_limit son bigint", async () => {
    const rows = await q<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name IN ('storage_used', 'storage_limit')
        ORDER BY column_name`
    )
    expect(rows).toEqual([
      { column_name: "storage_limit", data_type: "bigint" },
      { column_name: "storage_used", data_type: "bigint" },
    ])
  })

  it("ai_balance ya no existe (O-14: se comprobó que valía 0 antes de retirarla)", async () => {
    const rows = await q(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name = 'ai_balance'`
    )
    expect(rows).toHaveLength(0)
  })
})

describe("M6 · el baile NO FORCE → backfill → FORCE no dejó ninguna puerta abierta", () => {
  it.each(["plans", "subscriptions"])("%s sigue en FORCE ROW LEVEL SECURITY", async (tabla) => {
    const [row] = await q<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [tabla]
    )
    expect(row.relforcerowsecurity).toBe(true)
  })
})
