/**
 * E11 · ola A · T16/T17/T18 — el webhook, el reloj y la serie propia, de punta a
 * punta (§7.2, §8.3; ADR-0019 D1.3, D4, D8).
 *
 * **Sin claves reales de Stripe.** La suite firma sus propios eventos con
 * `stripe.webhooks.generateTestHeaderString` y el `STRIPE_WEBHOOK_SECRET` de
 * prueba, de modo que la verificación de firma **se ejercita de verdad**: el
 * caso de firma inválida no es un mock que devuelve `false`, es la librería de
 * Stripe rechazando una cabecera que no cuadra.
 *
 * Criterios de §14 cubiertos aquí: **2** (el mismo evento tres veces ⇒ una
 * transición), **3** (`stripeCustomerId` desconocido ⇒ `200` + `ORPHAN_WEBHOOK`
 * y **ningún tenant creado**), **4** (evento no manejado ⇒ `200`), **9** (la
 * serie no tiene el hueco que Stripe sí tiene), **48** (dos invocaciones del
 * mismo periodo ⇒ una ejecuta) y **51** (`/api/cron/x` sin `Bearer` ⇒ `401`).
 */

import { Client } from "pg"
import Stripe from "stripe"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerDatabaseUrl } from "@/tests/support/env"

const OWNER_URL = process.env.DATABASE_URL_TEST || ownerDatabaseUrl()

const ORG = "e11b0000-0000-4000-8000-00000000000a"
const USER = "e11b0000-0000-4000-8000-0000000000a1"
const PLAN_FREE = "0e11a1a0-0000-4000-8000-000000000001"
const CUSTOMER = "cus_e11b_webhook"

const WEBHOOK_SECRET = "whsec_e11a_suite_de_pruebas"
const CRON_SECRET = "cron_e11a_suite_de_pruebas"

let client: Client
let webhookPOST: (r: Request) => Promise<Response>
let cronPOST: (r: Request, c: { params: Promise<{ job: string }> }) => Promise<Response>
let issuePlatformInvoice: typeof import("@/models/platform-invoices").issuePlatformInvoice
let checkPlatformSeriesIntegrity: typeof import("@/models/platform-invoices").checkPlatformSeriesIntegrity
let report349: typeof import("@/models/platform-invoices").report349
let tenantDb: typeof import("@/lib/db").tenantDb

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

/**
 * Un evento de Stripe **firmado de verdad**. `generateTestHeaderString` produce
 * la cabecera `Stripe-Signature` que `constructEvent` verifica: no hay mock de
 * la firma en ningún punto de esta suite.
 */
function signedRequest(payload: Record<string, unknown>, opts: { secret?: string } = {}): Request {
  const body = JSON.stringify(payload)
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: opts.secret ?? WEBHOOK_SECRET,
  })
  return new Request("https://erp.test/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    body,
  })
}

function subscriptionEvent(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(Date.UTC(2026, 9, 1) / 1000),
    data: {
      object: {
        id: "sub_e11b",
        object: "subscription",
        customer: CUSTOMER,
        status,
        cancel_at_period_end: false,
        trial_end: null,
        items: {
          data: [
            {
              id: "si_1",
              price: { id: "price_inexistente_en_el_catalogo" },
              current_period_start: Math.floor(Date.UTC(2026, 9, 1) / 1000),
              current_period_end: Math.floor(Date.UTC(2026, 10, 1) / 1000),
            },
          ],
        },
        ...over,
      },
    },
  }
}

beforeAll(async () => {
  // El entorno se fija ANTES de importar nada de la aplicación: `lib/config.ts`
  // valida el entorno al cargarse, y `lib/stripe.ts` construye (o no) el cliente
  // en función de `STRIPE_SECRET_KEY`.
  process.env.DATABASE_URL = OWNER_URL
  process.env.DIRECT_URL = OWNER_URL
  // **ADR-0019 D9** — esta suite describe el modo de PAGO, que sigue existiendo
  // y no cambia. Se enciende explícitamente: el modo por defecto de la
  // instalación es `none` (INTERNO) y ahí `/api/stripe/*` responde 404.
  process.env.BILLING_PROVIDER = "stripe"
  process.env.STRIPE_SECRET_KEY = "sk_test_e11a_suite"
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.CRON_SECRET = CRON_SECRET

  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  await limpiar()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e11b@test.local', 'E11 webhook', now(), now())`,
    [USER]
  )
  await q(
    `INSERT INTO organizations (id, slug, name, stripe_customer_id, updated_at)
     VALUES ($1::uuid, 'e11b-webhook', 'E11 webhook', $2, now())`,
    [ORG, CUSTOMER]
  )
  await q(
    `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
     VALUES ($1::uuid, 'FREE', $2::uuid, 'ACTIVE', now())`,
    [ORG, PLAN_FREE]
  )

  const webhook = await import("@/app/api/stripe/webhook/route")
  webhookPOST = webhook.POST as typeof webhookPOST
  const cron = await import("@/app/api/cron/[job]/route")
  cronPOST = cron.POST as typeof cronPOST
  const invoices = await import("@/models/platform-invoices")
  issuePlatformInvoice = invoices.issuePlatformInvoice
  checkPlatformSeriesIntegrity = invoices.checkPlatformSeriesIntegrity
  report349 = invoices.report349
  tenantDb = (await import("@/lib/db")).tenantDb
})

async function limpiar() {
  await q(`DELETE FROM platform_invoices WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscription_events WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscriptions WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM organizations WHERE id = $1::uuid OR stripe_customer_id = $2`, [ORG, CUSTOMER])
  await q(`DELETE FROM users WHERE id = $1::uuid OR email = 'huerfano@test.local'`, [USER])
  await q(`UPDATE platform_invoice_series SET last_number = 0`)
  await q(`DELETE FROM cron_runs WHERE job = 'retention' AND period_key LIKE 'W2026-%'`)
}

afterAll(async () => {
  if (!client) return
  await limpiar()
  await client.end()
})

// ─────────────────────────────────────────────────────────────────────────────
// Webhook (§8.3)
// ─────────────────────────────────────────────────────────────────────────────

describe("webhook de Stripe", () => {
  it("firma inválida ⇒ **400**. Es el ÚNICO 4xx de esta ruta", async () => {
    const res = await webhookPOST(signedRequest(subscriptionEvent("evt_mal", "active"), { secret: "whsec_otro" }))
    expect(res.status).toBe(400)
  })

  it("sin cabecera de firma ⇒ 400, y no se procesa nada", async () => {
    const res = await webhookPOST(
      new Request("https://erp.test/api/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscriptionEvent("evt_sin_firma", "active")),
      })
    )
    expect(res.status).toBe(400)
  })

  // Criterio 4
  it("evento de tipo NO MANEJADO ⇒ **200**. Un 400 haría que Stripe reintentara sin fin", async () => {
    const res = await webhookPOST(
      signedRequest({
        id: "evt_no_manejado",
        object: "event",
        type: "customer.source.created",
        created: 1790000000,
        data: { object: { customer: CUSTOMER } },
      })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ handled: false })
  })

  // Criterio 3
  it("`stripeCustomerId` desconocido ⇒ **200 + ORPHAN_WEBHOOK**, y NINGÚN tenant creado", async () => {
    const [{ organizaciones: antes }] = await q<{ organizaciones: string }>(
      `SELECT count(*)::text AS organizaciones FROM organizations`
    )
    const [{ usuarios: antesU }] = await q<{ usuarios: string }>(`SELECT count(*)::text AS usuarios FROM users`)

    const res = await webhookPOST(
      signedRequest(subscriptionEvent("evt_huerfano", "active", { customer: "cus_que_no_existe" }))
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orphan: "ORPHAN_WEBHOOK" })

    const [{ organizaciones: despues }] = await q<{ organizaciones: string }>(
      `SELECT count(*)::text AS organizaciones FROM organizations`
    )
    const [{ usuarios: despuesU }] = await q<{ usuarios: string }>(`SELECT count(*)::text AS usuarios FROM users`)
    expect(despues).toBe(antes)
    expect(despuesU).toBe(antesU)
  })

  // Criterio 2 — I-E11-9
  it("**el mismo evento tres veces ⇒ UN evento, UNA transición, 200 las tres**", async () => {
    const evento = subscriptionEvent("evt_idempotente", "past_due")

    const r1 = await webhookPOST(signedRequest(evento))
    const r2 = await webhookPOST(signedRequest(evento))
    const r3 = await webhookPOST(signedRequest(evento))

    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200])
    expect(await r2.json()).toMatchObject({ duplicate: true })

    const eventos = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM subscription_events WHERE stripe_event_id = 'evt_idempotente'`
    )
    expect(eventos[0].n).toBe("1")

    const [sub] = await q<{ status: string; grace_until: Date | null }>(
      `SELECT status::text, grace_until FROM subscriptions WHERE organization_id = $1::uuid`,
      [ORG]
    )
    expect(sub.status).toBe("PAST_DUE")
    // FREE tiene `graceDays = 0` (§17.1): la gracia existe como fecha, y es la
    // del propio corte. **Nunca se bloquea por impago** (ADR-0019 D6).
    expect(sub.grace_until).not.toBeNull()
  })

  it("la transición encadena `statusBefore` → `statusAfter` sin hueco (I-E11-9)", async () => {
    const [ev] = await q<{ status_before: string | null; status_after: string }>(
      `SELECT status_before::text, status_after::text FROM subscription_events
        WHERE stripe_event_id = 'evt_idempotente'`
    )
    expect(ev.status_before).toBe("ACTIVE")
    expect(ev.status_after).toBe("PAST_DUE")
  })

  it("**§9.2** · el payload persistido está RECORTADO: ni email, ni dirección, ni importes", async () => {
    const [ev] = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM subscription_events WHERE stripe_event_id = 'evt_idempotente'`
    )
    expect(Object.keys(ev.payload).sort()).toEqual([
      "planCode",
      "stripeCustomerId",
      "stripePriceId",
      "stripeStatus",
      "stripeSubscriptionId",
    ])
  })

  it("un `price` que no está en el catálogo NO inventa un plan: el plan no cambia", async () => {
    const [sub] = await q<{ plan_code: string }>(
      `SELECT plan_code FROM subscriptions WHERE organization_id = $1::uuid`,
      [ORG]
    )
    expect(sub.plan_code).toBe("FREE")
  })

  it("todo webhook deja línea en `platform_audit_logs`, con id y tipo y nada más", async () => {
    const filas = await q<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM platform_audit_logs
        WHERE detail->>'stripeEventId' = 'evt_idempotente' ORDER BY at`
    )
    expect(filas.length).toBeGreaterThanOrEqual(2)
    expect(filas.map((f) => f.action)).toContain("webhook.received")
    expect(filas.map((f) => f.action)).toContain("webhook.duplicate")
    for (const f of filas) {
      expect(Object.keys(f.detail)).not.toContain("email")
      expect(Object.keys(f.detail)).not.toContain("customer_email")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reloj (§7.2)
// ─────────────────────────────────────────────────────────────────────────────

function cronRequest(token: string | null, refDate: string): Request {
  return new Request("https://erp.test/api/cron/retention", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ refDate }),
  })
}

const params = (job: string) => ({ params: Promise.resolve({ job }) })

describe("`POST /api/cron/[job]`", () => {
  // Criterio 51
  it("sin `Bearer` correcto ⇒ **401, sin pista**", async () => {
    const sinToken = await cronPOST(cronRequest(null, "2026-09-27T04:00:00Z"), params("retention"))
    const conTokenMalo = await cronPOST(cronRequest("cron_equivocado", "2026-09-27T04:00:00Z"), params("retention"))
    expect(sinToken.status).toBe(401)
    expect(conTokenMalo.status).toBe(401)
    // Mismo cuerpo en los dos: no se dice cuál de las dos cosas falló.
    expect(await sinToken.json()).toEqual(await conTokenMalo.json())
  })

  it("un job inexistente responde igual que un token malo: 401, no 404", async () => {
    // **E12 · T20**: `email-sync` ya NO es un nombre inventado — es uno de los
    // seis jobs del reloj (deuda 14 de §6, cerrada). El caso que este test
    // protege —que un nombre desconocido no revele el catálogo respondiendo 404—
    // se ejerce con uno que de verdad no existe.
    const res = await cronPOST(cronRequest(CRON_SECRET, "2026-09-27T04:00:00Z"), params("job-que-no-existe"))
    expect(res.status).toBe(401)
  })

  it("el intento rechazado CONSUME cubo: no hay reintentos gratis", async () => {
    const [fila] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM rate_limit_buckets WHERE scope = 'cron:ip'`
    )
    expect(Number(fila.n)).toBeGreaterThan(0)
  })

  it("el 401 queda registrado en `platform_audit_logs`", async () => {
    const [fila] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_audit_logs WHERE action = 'cron.unauthorized'`
    )
    expect(Number(fila.n)).toBeGreaterThanOrEqual(2)
  })

  it("sin `DATABASE_URL_MAINTENANCE` el job no miente: cierra **202 PARTIAL**, no DONE", async () => {
    const primera = await cronPOST(cronRequest(CRON_SECRET, "2026-09-27T04:00:00Z"), params("retention"))
    // `prune-runs` necesita `app_maintenance` (BYPASSRLS). Sin esa credencial no
    // purga, y declararse `DONE` sería exactamente el fallo de G-15 —contar como
    // hecho lo que no se hizo— trasladado al reloj.
    expect(primera.status).toBe(202)
    const [run] = await q<{ status: string; error: string | null }>(
      `SELECT status::text, error FROM cron_runs WHERE job = 'retention' ORDER BY started_at DESC LIMIT 1`
    )
    expect(run.status).toBe("PARTIAL")
    expect(run.error).toMatch(/DATABASE_URL_MAINTENANCE/)
  })

  it("un PARTIAL SIEMPRE se reanuda: el troceado no puede quedarse a medias", async () => {
    const otra = await cronPOST(cronRequest(CRON_SECRET, "2026-09-27T06:00:00Z"), params("retention"))
    expect(otra.status).toBe(202)
  })

  // Criterio 48
  it("terminado el periodo, **la segunda llamada del mismo periodo se salta**", async () => {
    await q(
      `UPDATE cron_runs SET status = 'DONE', finished_at = now(), error = NULL
        WHERE job = 'retention' AND period_key = 'W2026-09-21'`
    )
    const segunda = await cronPOST(cronRequest(CRON_SECRET, "2026-09-27T04:00:00Z"), params("retention"))
    expect(segunda.status).toBe(200)
    const cuerpo = (await segunda.json()) as { skipped?: boolean; periodKey?: string }
    expect(cuerpo.skipped).toBe(true)
    expect(cuerpo.periodKey).toBe("W2026-09-21")
  })

  it("**O-13** · el `refDate` con el que se invocó queda PERSISTIDO en `cron_runs`", async () => {
    const [run] = await q<{ job: string; period_key: string; ref_date: Date; status: string }>(
      `SELECT job, period_key, ref_date, status::text FROM cron_runs
        WHERE job = 'retention' ORDER BY started_at DESC LIMIT 1`
    )
    expect(run.period_key).toBe("W2026-09-21") // lunes de la semana del 27 (domingo)
    expect(run.ref_date.toISOString().slice(0, 10)).toBe("2026-09-27")
    expect(["DONE", "PARTIAL"]).toContain(run.status)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Serie propia (T18, O-9, O-10, I-E11-13)
// ─────────────────────────────────────────────────────────────────────────────

describe("serie de facturación de la plataforma", () => {
  const facts = (id: string, periodStart: Date) => ({
    stripeInvoiceId: id,
    subscriptionId: null,
    periodStart,
    periodEnd: null,
    paidAt: null,
    issuedAt: periodStart,
    subtotalCents: 4900,
    taxCents: 1029,
    totalCents: 5929,
    currency: "EUR",
    status: "paid",
    hostedInvoiceUrl: null,
  })

  it("numera 0001, 0002, 0003 en NUESTRA serie, con el devengo y su periodo de IVA", async () => {
    const a = await issuePlatformInvoice({
      organizationId: ORG,
      facts: facts("in_serie_1", new Date("2026-08-01T00:00:00Z")),
      recipient: { country: "ES", vatNumber: "ESB12345678", viesValid: true },
    })
    const b = await issuePlatformInvoice({
      organizationId: ORG,
      facts: facts("in_serie_2", new Date("2026-09-01T00:00:00Z")),
      recipient: { country: "ES", vatNumber: "ESB12345678", viesValid: true },
    })
    const c = await issuePlatformInvoice({
      organizationId: ORG,
      facts: facts("in_serie_3", new Date("2026-10-01T00:00:00Z")),
      recipient: { country: "ES", vatNumber: "ESB12345678", viesValid: true },
    })

    expect([a.fullNumber, b.fullNumber, c.fullNumber]).toEqual(["PLT-2026-0001", "PLT-2026-0002", "PLT-2026-0003"])
    expect([a.ivaPeriod, b.ivaPeriod, c.ivaPeriod]).toEqual(["2026-Q3", "2026-Q3", "2026-Q4"])
    expect(a.taxTreatment).toBe("REPERCUTIDO_ES")
  })

  it("el mismo `stripeInvoiceId` NO consume otro número: devuelve la ya emitida", async () => {
    const repetida = await issuePlatformInvoice({
      organizationId: ORG,
      facts: facts("in_serie_2", new Date("2026-09-01T00:00:00Z")),
      recipient: { country: "ES", vatNumber: "ESB12345678", viesValid: true },
    })
    expect(repetida.fullNumber).toBe("PLT-2026-0002")
    const [fila] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_invoices WHERE organization_id = $1::uuid`,
      [ORG]
    )
    expect(fila.n).toBe("3")
  })

  // Criterio 9
  it("**I-E11-13** · la serie es correlativa, sin huecos ni duplicados y con devengo no decreciente", async () => {
    const integridad = await checkPlatformSeriesIntegrity(tenantDb(ORG))
    const plt = integridad.find((s) => s.seriesCode === "PLT")!
    expect(plt.lastNumber).toBe(3)
    expect(plt.count).toBe(3)
    expect(plt.gaps).toEqual([])
    expect(plt.duplicates).toEqual([])
    expect(plt.outOfOrder).toEqual([])
  })

  it("**C-1** · cliente UE con NIF-IVA validado ⇒ no sujeto, cuota 0 y mención impresa", async () => {
    const ue = await issuePlatformInvoice({
      organizationId: ORG,
      facts: {
        ...facts("in_serie_ue", new Date("2026-10-01T00:00:00Z")),
        subtotalCents: 4900,
        taxCents: 0,
        totalCents: 4900,
      },
      recipient: { country: "FR", vatNumber: "FR12345678901", viesValid: true },
      vatValidatedAt: new Date("2026-10-01T08:00:00Z"),
      vatValidationSource: "VIES",
      vatValidationRef: "WAPIAAAA",
    })
    expect(ue.taxTreatment).toBe("NO_SUJETO_LOCALIZACION_UE")
    expect(ue.taxCents).toBe(0)
    expect(ue.taxCentsEur).toBe(0)

    const [fila] = await q<{ reverse_charge_mention: string | null; vat_validated_at: Date | null }>(
      `SELECT reverse_charge_mention, vat_validated_at FROM platform_invoices WHERE full_number = $1`,
      [ue.fullNumber]
    )
    expect(fila.reverse_charge_mention).toMatch(/inversión del sujeto pasivo/i)
    // **Del DEVENGO, no del alta** (C-1).
    expect(fila.vat_validated_at?.toISOString().slice(0, 10)).toBe("2026-10-01")
  })

  it("**R-5** · una cuota que el régimen no admite NO se sella: se para antes de emitir", async () => {
    await expect(
      issuePlatformInvoice({
        organizationId: ORG,
        // Régimen de no sujeción (tercer país) pero Stripe repercutió cuota.
        facts: facts("in_serie_incoherente", new Date("2026-10-01T00:00:00Z")),
        recipient: { country: "US", vatNumber: null, viesValid: null },
      })
    ).rejects.toThrow(/no se sella una factura con una cuota/)
  })

  // Criterio 60 — O-17
  it("**O-17** · la consulta del 349 agrupa por DEVENGO y devuelve la base en céntimos", async () => {
    const filas = await report349(tenantDb(ORG), new Date("2026-10-01"), new Date("2027-01-01"))
    expect(filas).toEqual([{ vatNumber: "FR12345678901", country: "FR", baseCents: 4900, invoices: 1 }])
  })
})
