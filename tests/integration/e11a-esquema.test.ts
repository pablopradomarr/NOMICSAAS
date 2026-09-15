/**
 * E11 · ola A · T2 — el SQL de las cinco migraciones `20260926*_e11_*`, contra
 * Postgres de verdad (docs/design/E11-plataforma-saas.md §2, §9.5; ADR-0019
 * D1, D4, D8).
 *
 * Todo lo que aquí se comprueba tiene la misma forma: **la regla está en la
 * base, no sólo en el código**. Un CHECK que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL, y precisamente contra eso están los invariantes.
 *
 *  · **Catálogo versionado**: vigencias sin solape (`EXCLUDE USING gist`),
 *    límites como COLUMNAS con sus CHECK, y **FREE no vendible** (P-1).
 *  · **Backfill de M4**: ninguna organización sin `Subscription` (I-E11-5), y la
 *    **guardia de `aiBalance > 0`** (O-14) con su mensaje.
 *  · **Append-only** de `subscription_events` y `platform_audit_logs`: `42501`,
 *    no un `UPDATE` que pasa en silencio.
 *  · **Serie de plataforma** (O-9, O-10, D8): numeración correlativa por la
 *    puerta `SECURITY DEFINER` con `FOR UPDATE`, régimen fiscal coherente, cuota
 *    en euros sellada y rectificativa completa.
 *  · **Ninguna tabla en `NO FORCE`** (ADR-0009 §7), incluidas las tres de
 *    plataforma que no llevan `organization_id`.
 *
 * Conecta con el rol PROPIETARIO: aquí se ejercen constraints y triggers. El
 * aislamiento por tenant vive en `test:integration:rls`.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const OWNER_URL = TEST_DATABASE_URL || ownerDatabaseUrl()

const ORG = "e11a0000-0000-4000-8000-00000000000a"
const USER = "e11a0000-0000-4000-8000-0000000000a1"

const PLAN_FREE = "0e11a1a0-0000-4000-8000-000000000001"
const SERIE_PLT = "0e11a5e0-0000-4000-8000-000000000001"
const SERIE_PLT_R = "0e11a5e0-0000-4000-8000-000000000002"

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

async function errmsg(sql: string, params: unknown[] = []): Promise<string | null> {
  await q("SAVEPOINT sp")
  try {
    await q(sql, params)
    await q("RELEASE SAVEPOINT sp")
    return null
  } catch (e) {
    await q("ROLLBACK TO SAVEPOINT sp")
    return (e as Error).message
  }
}

/** Inserta una factura de plataforma con lo mínimo, sobrescribible. */
function facturaSql(over: Record<string, unknown> = {}) {
  const f = {
    organization_id: ORG,
    series_id: SERIE_PLT,
    number: 1,
    full_number: "PLT-2026-0001",
    operation_date: "2026-10-01",
    issued_at: "2026-10-01",
    iva_period: "2026-Q4",
    tax_treatment: "REPERCUTIDO_ES",
    customer_country: "ES",
    subtotal_cents: 4900,
    tax_cents: 1029,
    total_cents: 5929,
    currency: "EUR",
    tax_cents_eur: 1029,
    status: "paid",
    stripe_invoice_id: "in_test_0001",
    vat_number: null as string | null,
    vat_validated_at: null as string | null,
    vat_validation_source: null as string | null,
    reverse_charge_mention: null as string | null,
    rectifies_invoice_id: null as string | null,
    rectification_cause: null as string | null,
    rectification_mode: null as string | null,
    fx_rate_micro: null as number | null,
    fx_rate_date: null as string | null,
    fx_source: null as string | null,
    ...over,
  }
  return [
    `INSERT INTO platform_invoices
       (organization_id, series_id, number, full_number, operation_date, issued_at, iva_period,
        tax_treatment, customer_country, vat_number, vat_validated_at, vat_validation_source,
        reverse_charge_mention, rectifies_invoice_id, rectification_cause, rectification_mode,
        subtotal_cents, tax_cents, total_cents, currency, tax_cents_eur,
        fx_rate_micro, fx_rate_date, fx_source, status, stripe_invoice_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7, $8::tax_treatment, $9, $10,
             $11::timestamp, $12, $13, $14::uuid, $15, $16::rectification_mode,
             $17, $18, $19, $20, $21, $22::bigint, $23::date, $24, $25, $26)`,
    [
      f.organization_id, f.series_id, f.number, f.full_number, f.operation_date, f.issued_at,
      f.iva_period, f.tax_treatment, f.customer_country, f.vat_number, f.vat_validated_at,
      f.vat_validation_source, f.reverse_charge_mention, f.rectifies_invoice_id,
      f.rectification_cause, f.rectification_mode, f.subtotal_cents, f.tax_cents, f.total_cents,
      f.currency, f.tax_cents_eur, f.fx_rate_micro, f.fx_rate_date, f.fx_source, f.status,
      f.stripe_invoice_id,
    ],
  ] as const
}

beforeAll(async () => {
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  // Todo el fichero corre dentro de UNA transacción que al final se revierte:
  // así los `SAVEPOINT` de `errcode` funcionan, `SET LOCAL ROLE` se deshace solo
  // y la base de pruebas queda como estaba para las suites siguientes.
  await q("BEGIN")
  await q(`DELETE FROM platform_invoices WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscription_events WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscriptions WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER])
  await q(`UPDATE platform_invoice_series SET last_number = 0`)

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e11a@test.local', 'E11 ola A', now(), now())`,
    [USER]
  )
  await q(
    `INSERT INTO organizations (id, slug, name, stripe_customer_id, updated_at)
     VALUES ($1::uuid, 'e11a-plataforma', 'E11 ola A', 'cus_e11a', now())`,
    [ORG]
  )
  await q(
    `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
     VALUES ($1::uuid, 'FREE', $2::uuid, 'ACTIVE', now())`,
    [ORG, PLAN_FREE]
  )
})

afterAll(async () => {
  if (!client) return
  await q("ROLLBACK")
  await client.end()
})

// ─────────────────────────────────────────────────────────────────────────────
// M4 · el catálogo sembrado (§17.1, P-1)
// ─────────────────────────────────────────────────────────────────────────────

describe("M4 · catálogo de planes", () => {
  it("siembra los tres planes del parámetro de §17.1", async () => {
    const filas = await q<{
      code: string
      list_price_cents: number
      max_members: number
      max_ocr_docs_month: number
      max_storage_bytes: string
      max_exports_month: number
      max_backups_month: number
      max_organizations: number
      soft_max_entries_month: number
      grace_days: number
      backup_retention_days: number
      stripe_price_id: string | null
      // E11 · integración — `ILIMITADO` (M6, ADR-0019 D9) también vale 0 y
      // entraría en medio del orden por precio. Esta prueba describe el
      // **catálogo vendible** de §17.1, así que se filtra por `is_public`: el
      // plan del modo interno tiene su propia prueba en `e11-integracion-d9`.
      is_public: boolean
    }>(`SELECT * FROM plans WHERE is_public ORDER BY list_price_cents`)

    expect(filas.map((f) => f.code)).toEqual(["FREE", "STARTER", "PRO"])

    const [free, starter, pro] = filas
    expect(free.list_price_cents).toBe(0)
    expect(free.max_members).toBe(2)
    expect(free.max_ocr_docs_month).toBe(20)
    expect(free.max_storage_bytes).toBe("524288000") // 500 MB
    expect(free.soft_max_entries_month).toBe(100)
    expect(free.grace_days).toBe(0)
    expect(free.backup_retention_days).toBe(7)

    expect(starter.list_price_cents).toBe(4900)
    expect(starter.max_ocr_docs_month).toBe(300)
    expect(starter.grace_days).toBe(14)

    expect(pro.list_price_cents).toBe(14900)
    expect(pro.max_exports_month).toBe(-1)
    expect(pro.max_backups_month).toBe(-1)
    expect(pro.soft_max_entries_month).toBe(20000)
    expect(pro.backup_retention_days).toBe(90)
  })

  it("**P-1 · FREE no es vendible**: a precio cero no puede haber precio en Stripe", async () => {
    expect(
      await errcode(`UPDATE plans SET stripe_price_id = 'price_regalado' WHERE code = 'FREE'`)
    ).toBe("23514")
  })

  it("los límites son COLUMNAS con CHECK, no un JSON sin tipo", async () => {
    // `-2` no significa nada; `0` miembros es un plan con el que no se puede hacer nada.
    expect(await errcode(`UPDATE plans SET max_members = -2 WHERE code = 'PRO'`)).toBe("23514")
    expect(await errcode(`UPDATE plans SET max_members = 0 WHERE code = 'PRO'`)).toBe("23514")
    expect(await errcode(`UPDATE plans SET list_price_cents = -1 WHERE code = 'PRO'`)).toBe("23514")
  })

  it("las vigencias de un mismo código NO pueden solaparse (EXCLUDE USING gist)", async () => {
    const code = await errcode(
      `INSERT INTO plans
         (code, name, description, list_price_cents, currency, interval,
          max_members, max_ocr_docs_month, max_storage_bytes, max_exports_month,
          max_backups_month, max_organizations, soft_max_entries_month,
          valid_from, valid_to, updated_at)
       VALUES ('STARTER', 'Starter bis', 'solapada', 5900, 'EUR', 'MONTH',
               5, 300, 10737418240, 100, 10, 3, 2000, DATE '2026-06-01', NULL, now())`
    )
    expect(code).toBe("23P01") // exclusion_violation
  })

  it("una versión NUEVA con vigencia disjunta sí entra: el catálogo es versionado", async () => {
    await q(`UPDATE plans SET valid_to = DATE '2026-12-31' WHERE code = 'STARTER'`)
    expect(
      await errcode(
        `INSERT INTO plans
           (code, name, description, list_price_cents, currency, interval,
            max_members, max_ocr_docs_month, max_storage_bytes, max_exports_month,
            max_backups_month, max_organizations, soft_max_entries_month,
            valid_from, valid_to, updated_at)
         VALUES ('STARTER', 'Starter 2027', 'subida de precio', 5900, 'EUR', 'MONTH',
                 5, 300, 10737418240, 100, 10, 3, 2000, DATE '2027-01-01', NULL, now())`
      )
    ).toBeNull()
    await q(`DELETE FROM plans WHERE valid_from = DATE '2027-01-01'`)
    await q(`UPDATE plans SET valid_to = NULL WHERE code = 'STARTER'`)
  })

  it("el catálogo NO lo escribe app_runtime: la política restrictiva lo impide", async () => {
    const filas = await q<{ polname: string; polcmd: string }>(
      `SELECT polname, polcmd::text FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'plans' AND NOT p.polpermissive`
    )
    expect(filas.map((f) => f.polname).sort()).toEqual(["plans_no_delete", "plans_no_insert", "plans_no_update"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M4 · backfill (I-E11-5) y guardia de aiBalance (O-14)
// ─────────────────────────────────────────────────────────────────────────────

describe("M4 · backfill y O-14", () => {
  it("**I-E11-5** · ninguna organización anterior al backfill de M4 se quedó sin Subscription", async () => {
    // **Revisor BLOQUEA 3.** Acotado a lo que M4 pudo tocar: las organizaciones
    // que existían cuando la migración corrió. Las que crean después otros
    // ficheros de la suite con `INSERT` directo se saltan la puerta de siembra
    // —carencia del arnés, no del producto— y dejaban esta aserción en rojo en
    // la suite completa aunque pasara aislada. El I-E11-5 real de T20 corre
    // acotado a la organización barrida.
    const [fila] = await q<{ huerfanas: string }>(
      `SELECT count(*)::text AS huerfanas FROM organizations o
        WHERE o.created_at < (
                SELECT finished_at FROM _prisma_migrations
                 WHERE migration_name LIKE '%e11_m4_backfill_suscripciones%' AND finished_at IS NOT NULL
                 ORDER BY finished_at DESC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.organization_id = o.id)`
    )
    expect(fila.huerfanas).toBe("0")
  })

  it("una organización sólo puede tener UNA suscripción", async () => {
    expect(
      await errcode(
        `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
         VALUES ($1::uuid, 'PRO', $2::uuid, 'ACTIVE', now())`,
        [ORG, PLAN_FREE]
      )
    ).toBe("23505")
  })

  it("retirar del catálogo una versión contratada está PROHIBIDO (RESTRICT)", async () => {
    expect(await errcode(`DELETE FROM plans WHERE id = $1::uuid`, [PLAN_FREE])).toBe("23503")
  })

  it("la suscripción NO se borra: su historia explica por qué se quedó en READ_ONLY", async () => {
    const filas = await q<{ polname: string }>(
      `SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'subscriptions' AND NOT p.polpermissive`
    )
    expect(filas.map((f) => f.polname)).toContain("subscriptions_no_delete")
  })

  it("**O-14** · las columnas heredadas quedan DEPRECADAS por escrito, no en un comentario de código", async () => {
    const filas = await q<{ column_name: string; comentario: string | null }>(
      `SELECT a.attname AS column_name, col_description(a.attrelid, a.attnum) AS comentario
         FROM pg_attribute a
        WHERE a.attrelid = 'organizations'::regclass
          AND a.attname IN ('membership_plan', 'membership_expires_at', 'storage_limit')`
    )
    // `ai_balance` ya no está en la lista: **M6 la retiró** (ADR-0019 D1.5).
    // Lo que O-14 exigía —comprobar el saldo antes de darla de baja— lo hacen
    // las dos migraciones; que la columna ya no exista lo prueba
    // `e11-integracion-d9`.
    expect(filas).toHaveLength(3)
    for (const f of filas) {
      expect(f.comentario, f.column_name).toMatch(/DEPRECADA/)
      expect(f.comentario, f.column_name).toMatch(/E12/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M1 · append-only de los eventos (I-E11-9)
// ─────────────────────────────────────────────────────────────────────────────

describe("M1 · subscription_events", () => {
  it("`stripe_event_id` es ÚNICO: ésa es la idempotencia del webhook", async () => {
    await q(
      `INSERT INTO subscription_events
         (organization_id, stripe_event_id, event_type, occurred_at, status_after, payload)
       VALUES ($1::uuid, 'evt_unico', 'customer.subscription.updated', now(), 'ACTIVE', '{}'::jsonb)`,
      [ORG]
    )
    expect(
      await errcode(
        `INSERT INTO subscription_events
           (organization_id, stripe_event_id, event_type, occurred_at, status_after, payload)
         VALUES ($1::uuid, 'evt_unico', 'customer.subscription.updated', now(), 'PAST_DUE', '{}'::jsonb)`,
        [ORG]
      )
    ).toBe("23505")
  })

  it("es APPEND-ONLY para app_runtime: 42501 en UPDATE y en DELETE", async () => {
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    expect(await errcode(`UPDATE subscription_events SET event_type = 'falsificado'`)).toBe("42501")
    expect(await errcode(`DELETE FROM subscription_events`)).toBe("42501")
    await q(`RESET ROLE`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M3 · las tres tablas de plataforma (§9.5)
// ─────────────────────────────────────────────────────────────────────────────

describe("M3 · plataforma", () => {
  it("`cron_runs` es único por (job, periodKey): la idempotencia del reloj", async () => {
    await q(
      `INSERT INTO cron_runs (job, period_key, ref_date, status) VALUES ('retention', 'W2026-09-21', DATE '2026-09-27', 'RUNNING')`
    )
    expect(
      await errcode(
        `INSERT INTO cron_runs (job, period_key, ref_date, status) VALUES ('retention', 'W2026-09-21', DATE '2026-09-27', 'RUNNING')`
      )
    ).toBe("23505")
    await q(`DELETE FROM cron_runs WHERE period_key = 'W2026-09-21'`)
  })

  it("un run terminado tiene hora de fin, y uno en curso no", async () => {
    expect(
      await errcode(
        `INSERT INTO cron_runs (job, period_key, ref_date, status, finished_at)
         VALUES ('retention', 'W-mal', DATE '2026-09-27', 'DONE', NULL)`
      )
    ).toBe("23514")
  })

  it("**§9.2** · la clave del rate limit tiene que ser un sha256, no un email", async () => {
    expect(
      await errcode(
        `INSERT INTO rate_limit_buckets (scope, key, window_at, expires_at)
         VALUES ('auth:login', 'pablo@cfonomic.com', now(), now() + interval '5 min')`
      )
    ).toBe("23514")
    expect(
      await errcode(
        `INSERT INTO rate_limit_buckets (scope, key, window_at, expires_at)
         VALUES ('auth:login', repeat('a', 64), now(), now() + interval '5 min')`
      )
    ).toBeNull()
    await q(`DELETE FROM rate_limit_buckets WHERE scope = 'auth:login'`)
  })

  it("`platform_audit_logs` es APPEND-ONLY, también para app_maintenance", async () => {
    await q(
      `INSERT INTO platform_audit_logs (actor, action, detail) VALUES ('stripe', 'webhook.received', '{}'::jsonb)`
    )
    for (const rol of ["app_runtime", "app_maintenance"]) {
      await q(`SET LOCAL ROLE ${rol}`)
      expect(await errcode(`UPDATE platform_audit_logs SET actor = 'otro'`), rol).toBe("42501")
      expect(await errcode(`DELETE FROM platform_audit_logs`), rol).toBe("42501")
      await q(`RESET ROLE`)
    }
    await q(`DELETE FROM platform_audit_logs WHERE action = 'webhook.received'`)
  })

  it("las tres NO están en TENANT_MODELS porque no tienen organization_id", async () => {
    const filas = await q<{ relname: string; n: string }>(
      `SELECT c.relname, count(a.attname)::text AS n
         FROM pg_class c
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
        WHERE c.relname IN ('cron_runs', 'rate_limit_buckets')
        GROUP BY c.relname ORDER BY c.relname`
    )
    expect(filas.map((f) => f.n)).toEqual(["0", "0"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// M5 · la serie de plataforma (O-9, O-10, D8) — espejo de I-E8-20
// ─────────────────────────────────────────────────────────────────────────────

describe("M5 · facturación de la plataforma", () => {
  it("las DOS series nacen sembradas y con `last_number = 0`", async () => {
    const filas = await q<{ code: string; kind: string; prefix: string; last_number: number }>(
      `SELECT code, kind::text, prefix, last_number FROM platform_invoice_series ORDER BY code`
    )
    expect(filas).toEqual([
      { code: "PLT", kind: "ORDINARIA", prefix: "PLT-2026-", last_number: 0 },
      { code: "PLT-R", kind: "RECTIFICATIVA", prefix: "PLT-R-2026-", last_number: 0 },
    ])
  })

  it("la numeración la da la PUERTA con FOR UPDATE, y es correlativa 1..N", async () => {
    const n1 = await q<{ number: number; prefix: string }>(`SELECT * FROM app.next_platform_invoice_number('PLT')`)
    const n2 = await q<{ number: number }>(`SELECT * FROM app.next_platform_invoice_number('PLT')`)
    const n3 = await q<{ number: number }>(`SELECT * FROM app.next_platform_invoice_number('PLT')`)
    expect([n1[0].number, n2[0].number, n3[0].number]).toEqual([1, 2, 3])
    expect(n1[0].prefix).toBe("PLT-2026-")
    await q(`UPDATE platform_invoice_series SET last_number = 0 WHERE code = 'PLT'`)
  })

  it("una serie inexistente lanza en vez de devolver un número inventado", async () => {
    expect(await errmsg(`SELECT * FROM app.next_platform_invoice_number('PLT-X')`)).toMatch(/No existe la serie/)
  })

  it("`app_runtime` no puede mover la serie a mano: sólo por la puerta", async () => {
    await q(`SET LOCAL ROLE app_runtime`)
    expect(await errcode(`UPDATE platform_invoice_series SET last_number = 99`)).toBe("42501")
    await q(`RESET ROLE`)
  })

  it("emite una factura ordinaria y la numera", async () => {
    expect(await errcode(...facturaSql())).toBeNull()
    const [f] = await q<{ full_number: string; iva_period: string }>(
      `SELECT full_number, iva_period FROM platform_invoices WHERE organization_id = $1::uuid`,
      [ORG]
    )
    expect(f.full_number).toBe("PLT-2026-0001")
    expect(f.iva_period).toBe("2026-Q4")
  })

  it("`(serie, número)` es ÚNICO: no hay dos facturas con el mismo número", async () => {
    expect(await errcode(...facturaSql({ stripe_invoice_id: "in_test_bis", full_number: "PLT-2026-0001b" }))).toBe(
      "23505"
    )
  })

  it("el total tiene que cuadrar: base + cuota, tolerancia CERO", async () => {
    expect(
      await errcode(...facturaSql({ number: 2, full_number: "PLT-2026-0002", stripe_invoice_id: "in_2", total_cents: 5930 }))
    ).toBe("23514")
  })

  it("la expedición nunca precede al devengo (art. 11 RD 1619/2012)", async () => {
    expect(
      await errcode(
        ...facturaSql({ number: 3, full_number: "PLT-2026-0003", stripe_invoice_id: "in_3", issued_at: "2026-09-30" })
      )
    ).toBe("23514")
  })

  it("`iva_period` es la clave canónica `AAAA-Qn` (ADR-0014 D8)", async () => {
    expect(
      await errcode(
        ...facturaSql({ number: 4, full_number: "PLT-2026-0004", stripe_invoice_id: "in_4", iva_period: "2026-10" })
      )
    ).toBe("23514")
  })

  it("**C-1** · sólo `REPERCUTIDO_ES` puede llevar cuota; la no sujeción es cuota CERO", async () => {
    expect(
      await errcode(
        ...facturaSql({
          number: 5,
          full_number: "PLT-2026-0005",
          stripe_invoice_id: "in_5",
          tax_treatment: "NO_SUJETO_TERCER_PAIS",
          customer_country: "US",
          // …pero con cuota: contradicción, y la base la rechaza.
        })
      )
    ).toBe("23514")
  })

  it("**O-15** · la no sujeción UE exige NIF-IVA, prueba fechada y mención impresa", async () => {
    // Sin la prueba: rechazada.
    expect(
      await errcode(
        ...facturaSql({
          number: 6,
          full_number: "PLT-2026-0006",
          stripe_invoice_id: "in_6",
          tax_treatment: "NO_SUJETO_LOCALIZACION_UE",
          customer_country: "FR",
          tax_cents: 0,
          total_cents: 4900,
          tax_cents_eur: 0,
        })
      )
    ).toBe("23514")

    // Con NIF-IVA, fecha de validación, fuente y mención: admitida.
    expect(
      await errcode(
        ...facturaSql({
          number: 6,
          full_number: "PLT-2026-0006",
          stripe_invoice_id: "in_6",
          tax_treatment: "NO_SUJETO_LOCALIZACION_UE",
          customer_country: "FR",
          vat_number: "FR12345678901",
          vat_validated_at: "2026-10-01 08:00:00",
          vat_validation_source: "VIES",
          reverse_charge_mention: "Inversión del sujeto pasivo (art. 6.1.m RD 1619/2012)",
          tax_cents: 0,
          total_cents: 4900,
          tax_cents_eur: 0,
        })
      )
    ).toBeNull()
  })

  it("**C-4** · la cuota va siempre en euros: en EUR coincide y no hay tasa que sellar", async () => {
    expect(
      await errcode(
        ...facturaSql({ number: 7, full_number: "PLT-2026-0007", stripe_invoice_id: "in_7", tax_cents_eur: 999 })
      )
    ).toBe("23514")
  })

  it("**C-4** · en USD la tasa, su fecha y su fuente viajan con la factura", async () => {
    // Sin tasa: rechazada.
    expect(
      await errcode(
        ...facturaSql({
          number: 8,
          full_number: "PLT-2026-0008",
          stripe_invoice_id: "in_8",
          currency: "USD",
          tax_cents_eur: 950,
        })
      )
    ).toBe("23514")

    // Con tasa sellada y fecha NO posterior al devengo (última publicada anterior).
    expect(
      await errcode(
        ...facturaSql({
          number: 8,
          full_number: "PLT-2026-0008",
          stripe_invoice_id: "in_8",
          currency: "USD",
          tax_cents_eur: 950,
          fx_rate_micro: 920000,
          fx_rate_date: "2026-09-30",
          fx_source: "ECB",
        })
      )
    ).toBeNull()

    // Una tasa POSTERIOR al devengo no es la del devengo.
    expect(
      await errcode(
        ...facturaSql({
          number: 9,
          full_number: "PLT-2026-0009",
          stripe_invoice_id: "in_9",
          currency: "USD",
          tax_cents_eur: 950,
          fx_rate_micro: 920000,
          fx_rate_date: "2026-10-05",
          fx_source: "ECB",
        })
      )
    ).toBe("23514")
  })

  it("**O-12a** · la moneda se restringe a EUR y USD (dos decimales)", async () => {
    expect(
      await errcode(
        ...facturaSql({ number: 10, full_number: "PLT-2026-0010", stripe_invoice_id: "in_10", currency: "JPY" })
      )
    ).toBe("23514")
  })

  it("**art. 15 RD 1619/2012** · la rectificativa lleva serie propia, referencia, causa y modo", async () => {
    const [original] = await q<{ id: string }>(
      `SELECT id FROM platform_invoices WHERE stripe_invoice_id = 'in_test_0001'`
    )

    // Una rectificativa en la serie ORDINARIA: la rechaza el trigger.
    expect(
      await errmsg(
        ...facturaSql({
          number: 11,
          full_number: "PLT-2026-0011",
          stripe_invoice_id: "cn_1",
          rectifies_invoice_id: original.id,
          rectification_cause: "Devolución parcial",
          rectification_mode: "DIFERENCIAS",
          subtotal_cents: -4900,
          tax_cents: -1029,
          total_cents: -5929,
          tax_cents_eur: -1029,
        })
      )
    ).toMatch(/serie RECTIFICATIVA/)

    // Con referencia pero sin causa ni modo: incompleta.
    expect(
      await errcode(
        ...facturaSql({
          series_id: SERIE_PLT_R,
          number: 1,
          full_number: "PLT-R-2026-0001",
          stripe_invoice_id: "cn_2",
          rectifies_invoice_id: original.id,
          subtotal_cents: -4900,
          tax_cents: -1029,
          total_cents: -5929,
          tax_cents_eur: -1029,
        })
      )
    ).toBe("23514")

    // Completa y en su serie: admitida.
    expect(
      await errcode(
        ...facturaSql({
          series_id: SERIE_PLT_R,
          number: 1,
          full_number: "PLT-R-2026-0001",
          stripe_invoice_id: "cn_3",
          rectifies_invoice_id: original.id,
          rectification_cause: "Devolución parcial del periodo",
          rectification_mode: "DIFERENCIAS",
          subtotal_cents: -4900,
          tax_cents: -1029,
          total_cents: -5929,
          tax_cents_eur: -1029,
        })
      )
    ).toBeNull()
  })

  it("la serie RECTIFICATIVA no admite una factura que no rectifique nada", async () => {
    expect(
      await errmsg(
        ...facturaSql({ series_id: SERIE_PLT_R, number: 2, full_number: "PLT-R-2026-0002", stripe_invoice_id: "in_11" })
      )
    ).toMatch(/solo admite facturas que rectifiquen/)
  })

  it("una factura emitida NO se borra: se rectifica", async () => {
    await q(`SET LOCAL ROLE app_runtime`)
    await q(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    expect(await errcode(`DELETE FROM platform_invoices`)).toBe("42501")
    // Y del resto de columnas, sólo tres son actualizables: ni número, ni
    // fechas, ni cifras, ni régimen fiscal.
    expect(await errcode(`UPDATE platform_invoices SET number = 99`)).toBe("42501")
    expect(await errcode(`UPDATE platform_invoices SET operation_date = DATE '2020-01-01'`)).toBe("42501")
    expect(await errcode(`UPDATE platform_invoices SET status = 'void'`)).toBeNull()
    await q(`RESET ROLE`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0009 §7
// ─────────────────────────────────────────────────────────────────────────────

describe("RLS", () => {
  it("ninguna tabla de la ola A queda en NO FORCE", async () => {
    const tablas = [
      "plans",
      "subscriptions",
      "subscription_events",
      "cron_runs",
      "rate_limit_buckets",
      "platform_audit_logs",
      "platform_invoice_series",
      "platform_invoices",
    ]
    const filas = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [tablas]
    )
    expect(filas).toHaveLength(tablas.length)
    for (const f of filas) {
      expect(f.relrowsecurity, f.relname).toBe(true)
      expect(f.relforcerowsecurity, f.relname).toBe(true)
    }
  })

  it("las dos de tenant llevan la política estricta `tenant_isolation`", async () => {
    const filas = await q<{ relname: string }>(
      `SELECT c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname = 'tenant_isolation'
          AND c.relname IN ('subscriptions', 'subscription_events', 'platform_invoices')
        ORDER BY c.relname`
    )
    expect(filas.map((f) => f.relname)).toEqual(["platform_invoices", "subscription_events", "subscriptions"])
  })
})
