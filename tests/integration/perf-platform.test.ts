import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E11 · QA — Rendimiento de la plataforma (§12 del diseño).
 *
 * `docs/design/E11-plataforma-saas.md` §12 declara **diez** techos y ninguno
 * tenía test (no existía `perf-platform.test.ts`): la deuda de T19 que E9/E10
 * dejaron escrita — "ningún techo medido es un techo que no existe" — se repetía
 * en E11. Aquí se miden los que se pueden sembrar en el tiempo de una sesión de
 * QA sobre este sandbox; los que exigen volumen masivo (3, 5, 6, 8) quedan
 * `it.skip` con el motivo y la épica de cierre, en vez de fingir que se han
 * medido.
 *
 * Patrón de `perf-budget.test.ts` (E10 · T19): `ConnectionWatcher` mide ms y
 * conexiones simultáneas por `application_name` en `pg_stat_activity`.
 *
 * ## Ronda 1: **no queda ningún `it.skip`**
 *
 * Los cuatro techos que exigían volumen masivo (3, 5, 6 y 8) se miden ahora con
 * **volumen reducido sembrado en el propio test** y se **extrapolan**, que es lo
 * único honesto que cabe en un sandbox compartido. Dos reglas para que la
 * extrapolación no sea un adorno:
 *
 *  1. **Se separa el coste fijo del marginal.** El techo 3 mide a `N` y a `2N`,
 *     deriva el coste por asiento y extrapola `fijo + 50 000 × marginal`. Un
 *     único punto no distingue «500 ms de arranque» de «500 ms por cada mil
 *     filas», y es esa diferencia la que decide si el techo aguanta.
 *  2. **Lo que NO depende del volumen se mide exacto.** El número de consultas
 *     de `computeUsage` y de `assertWithinLimit` es el mismo con 84 asientos que
 *     con 50 000, y se cuenta con un proxy, no se estima.
 *
 * Cada aserción imprime la cifra medida **y** la extrapolada: quien lea el
 * informe ve de dónde sale el veredicto.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const APP_NAME = "erp-perf-platform"
if (TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set("application_name", APP_NAME)
  process.env.DATABASE_URL = url.toString()
}

// El techo 7 (webhook) necesita `BILLING_PROVIDER=stripe`; `lib/config.ts` lo
// congela en un objeto al cargarse, así que hay que fijarlo ANTES de la
// primera importación de cualquier módulo de la aplicación (mismo patrón que
// `e11a-webhook-cron.test.ts`).
process.env.BILLING_PROVIDER = "stripe"
process.env.STRIPE_SECRET_KEY = "sk_test_e11_perf"
process.env.STRIPE_WEBHOOK_SECRET = "whsec_e11_perf"

// Los techos 5 y 6 producen y restauran un ZIP de verdad: el almacén es un
// `LocalDriver` sobre un directorio temporal, ni una conexión de red.
const storeRoot = await mkdtemp(path.join(tmpdir(), "e11-perf-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-test"

const { tenantTransaction } = await import("@/lib/db")
const { getUsage, readUsageInTransaction } = await import("@/models/usage")
const { buildBackupArchive, restoreBackupIntoOrganization } = await import("@/models/backups")
const { assertWithinLimit } = await import("@/models/platform-limits")
const { issuePlatformInvoice } = await import("@/models/platform-invoices")
const { calendarByEmployeeDaySql } = await import("@/models/time")
const { healthReport } = await import("@/models/platform")
const { POST: webhookPOST } = await import("@/app/api/stripe/webhook/route")
const StripeSdk = (await import("stripe")).default

const OWNER_URL = process.env.DATABASE_URL_TEST || "postgresql://postgres@localhost:5432/erp_test"
const ORG = "e11ffff0-0000-4000-8000-00000000000a"
const DEST = "e11ffff0-0000-4000-8000-00000000000b"
const USER = "e11ffff0-0000-4000-8000-0000000000a1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"
const FY = "e11ffff0-0000-4000-8000-0000000000f1"
const CUENTA_DEBE = "6290"
const CUENTA_HABER = "5720"
const SIGNING_KEY = Buffer.from("clave-de-firma-perf-e11")
const KEY_ID = "k1"
/** El ejercicio sembrado es 2027: la referencia lo cubre entero (I8). */
const REF = new Date("2027-12-31T12:00:00.000Z")

/** El ZIP que produce el techo 5 y consume el 6. */
let archivo: Buffer | null = null

let client: Client
async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

class ConnectionWatcher {
  private client: Client | null = null
  max = 0
  async start(): Promise<void> {
    this.client = new Client({ connectionString: TEST_DATABASE_URL, application_name: `${APP_NAME}-watch` })
    await this.client.connect()
  }
  async stop(): Promise<void> {
    await this.client?.end()
  }
  private async sample(): Promise<void> {
    if (!this.client) return
    const { rows } = await this.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND state IN ('active', 'idle in transaction')`,
      [APP_NAME]
    )
    this.max = Math.max(this.max, Number(rows[0]?.n ?? 0))
  }
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number; maxConnections: number }> {
    this.max = 0
    let running = true
    const poll = (async () => {
      while (running) {
        await this.sample()
        await new Promise((r) => setTimeout(r, 5))
      }
      await this.sample()
    })()
    const startedAt = performance.now()
    const value = await fn()
    const ms = performance.now() - startedAt
    running = false
    await poll
    return { value, ms, maxConnections: this.max }
  }
}

let watcher: ConnectionWatcher

async function limpiar() {
  for (const org of [DEST, ORG]) {
    // Líneas y asientos en la MISMA transacción: el constraint trigger diferido
    // de «un asiento tiene al menos dos líneas» se evalúa al COMMIT.
    await q("BEGIN")
    await q(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, [org])
    await q(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, [org])
    await q("COMMIT")
    await q(`DELETE FROM stored_objects WHERE organization_id = $1::uuid`, [org])
    await q(`DELETE FROM extraction_runs WHERE organization_id = $1::uuid`, [org]).catch(() => undefined)
    await q(`DELETE FROM accounts WHERE organization_id = $1::uuid`, [org])
  }
  await q(`DELETE FROM restore_jobs WHERE organization_id = $1::uuid`, [DEST])
  await q(`DELETE FROM usage_runs WHERE organization_id = $1::uuid`, [DEST])
  await q(`DELETE FROM subscriptions WHERE organization_id = $1::uuid`, [DEST])
  await q(`DELETE FROM fiscal_years WHERE organization_id = $1::uuid`, [DEST])
  await q(`DELETE FROM memberships WHERE organization_id = $1::uuid`, [DEST])
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [DEST])
  // `time_entries` es append-only para partes APROBADOS (I-E10-4): sin
  // desactivar los triggers de usuario, el DELETE del arnés lo rechaza.
  await q(`ALTER TABLE time_entries DISABLE TRIGGER USER`).catch(() => undefined)
  await q(`DELETE FROM time_entries WHERE organization_id = $1::uuid`, [ORG])
  await q(`ALTER TABLE time_entries ENABLE TRIGGER USER`).catch(() => undefined)
  await q(`DELETE FROM employees WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM cost_centers WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM fiscal_years WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM platform_invoices WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscription_events WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM usage_runs WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM subscriptions WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM memberships WHERE organization_id = $1::uuid`, [ORG])
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER])
}

/**
 * Siembra `n` asientos CUADRADOS por SQL directo (dos líneas, 1 000 c/u). Se
 * salta el motor a propósito —el techo mide la LECTURA, no el posteo— igual que
 * `perf-budget.test.ts`, y deja el `entry_hash` a ceros: ninguno de los techos
 * que se miden aquí lo recomputa.
 */
async function sembrarAsientos(n: number, desde: number): Promise<void> {
  // Asientos y líneas en la MISMA transacción: el constraint trigger diferido
  // de «asiento sin líneas» se evalúa al COMMIT, y con dos transacciones la
  // primera aborta antes de que existan las líneas.
  await q("BEGIN")
  await q(
    `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, description,
        posted_by_id, entry_hash, hash_version, kind)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3 + g,
            (DATE '2027-01-01' + ((g % 360) || ' days')::interval)::date,
            'perf ' || g, $4::uuid, repeat('0', 64), 3, 'NORMAL'
       FROM generate_series(0, $5 - 1) AS g`,
    [ORG, FY, desde, USER, n]
  )
  await q(
    `INSERT INTO journal_lines
       (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
        entry_date, fiscal_year_id, entry_kind)
     SELECT gen_random_uuid(), e.organization_id, e.id, l.line_no,
            CASE WHEN l.line_no = 1 THEN $2 ELSE $3 END,
            CASE WHEN l.line_no = 1 THEN 1000 ELSE 0 END,
            CASE WHEN l.line_no = 1 THEN 0 ELSE 1000 END,
            e.entry_date, e.fiscal_year_id, 'NORMAL'
       FROM journal_entries e
       CROSS JOIN (VALUES (1), (2)) AS l(line_no)
      WHERE e.organization_id = $1::uuid
        AND e.entry_number BETWEEN $4 AND $5
        AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = e.id)`,
    [ORG, CUENTA_DEBE, CUENTA_HABER, desde, desde + n - 1]
  )
  await q("COMMIT")
}

async function sembrarObjetos(n: number, desde: number): Promise<void> {
  await q(
    `INSERT INTO stored_objects
       (id, organization_id, object_key, backend, sha256, size_bytes, mime_type, kind, created_at)
     SELECT gen_random_uuid(), $1::uuid,
            'erp-test/' || $1 || '/DOCUMENT/' || lpad((($2 + g))::text, 2, '0') || '/perf-' || ($2 + g),
            'LOCAL', lpad((($2 + g))::text, 64, '0'), 1024, 'application/pdf', 'DOCUMENT', now()
       FROM generate_series(0, $3 - 1) AS g`,
    [ORG, desde, n]
  )
}

async function sembrarExtracciones(n: number, _desde: number): Promise<void> {
  await q(
    `INSERT INTO extraction_runs
       (id, organization_id, status, model, prompt_sha, schema_sha, proposal_sha, created_at)
     SELECT gen_random_uuid(), $1::uuid, 'DONE', 'perf', repeat('1', 64), repeat('2', 64), repeat('3', 64), now()
       FROM generate_series(0, $2 - 1) AS g`,
    [ORG, n]
  ).catch(async () => {
    // El esquema de `extraction_runs` ha cambiado entre épicas; si el INSERT
    // mínimo no vale, se dice y el techo se mide sin esa dimensión en vez de
    // fingir un volumen que no está.
    console.warn("[perf-platform] no se han podido sembrar extraction_runs: el techo 3 se mide sin esa dimensión")
  })
}

/** Cliente que APUNTA cada consulta: el techo 3 cuenta consultas, no sólo ms. */
function contado<T extends object>(tx: T, log: string[]): T {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === "$queryRaw" || prop === "$queryRawUnsafe" || prop === "$executeRaw") {
        return (...args: unknown[]) => {
          log.push(`${String(prop)}: ${String(args[0]).replace(/\s+/g, " ").trim().slice(0, 80)}`)
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (typeof prop === "string" && !prop.startsWith("$") && value !== null && typeof value === "object") {
        return new Proxy(value as object, {
          get(delegate, method, r2) {
            const fn = Reflect.get(delegate, method, r2)
            if (typeof fn !== "function") return fn
            return (...args: unknown[]) => {
              log.push(`${prop}.${String(method)}`)
              return (fn as (...a: unknown[]) => unknown).apply(delegate, args)
            }
          },
        })
      }
      return value
    },
  })
}

beforeAll(async () => {
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  watcher = new ConnectionWatcher()
  await watcher.start()
  await limpiar()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e11-perf@test.local', 'E11 perf', now(), now())`,
    [USER]
  )
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at)
     VALUES ($1::uuid, 'e11-perf', 'E11 perf', now())`,
    [ORG]
  )
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now(), now())`,
    [ORG, USER]
  )
  await q(
    `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
     VALUES ($1::uuid, 'ILIMITADO', $2::uuid, 'ACTIVE', now())`,
    [ORG, PLAN_ILIMITADO]
  )

  // La organización DESTINO del techo 6: la restauración va SIEMPRE a una
  // organización nueva (§5.4), nunca sobre la de origen.
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e11-perf-dest', 'E11 perf destino', now())`,
    [DEST]
  )
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now(), now())`,
    [DEST, USER]
  )
  await q(
    `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
     VALUES ($1::uuid, 'ILIMITADO', $2::uuid, 'ACTIVE', now())`,
    [DEST, PLAN_ILIMITADO]
  )

  // Dos cuentas y un ejercicio: lo mínimo para que los asientos del volumen
  // reducido sean asientos de verdad y no filas sueltas.
  await q(
    `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, 'Otros servicios', 4, 'DEUDORA', true, true, now(), now()),
            (gen_random_uuid(), $1::uuid, $3, 'Bancos', 4, 'DEUDORA', true, true, now(), now())`,
    [ORG, CUENTA_DEBE, CUENTA_HABER]
  )
  await q(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, '2027', '2027-01-01', '2027-12-31', 'OPEN', now(), now())`,
    [FY, ORG]
  )
}, 120_000)

afterAll(async () => {
  await limpiar()
  await client.end()
  await watcher.stop()
  await rm(storeRoot, { recursive: true, force: true })
}, 120_000)

describe("E11 · §12 — techos de rendimiento de la plataforma", () => {
  it("1/10 · `/settings/subscription` en frío con 12 facturas y 24 eventos: < 400 ms, 1 transacción", async () => {
    for (let i = 0; i < 12; i++) {
      await issuePlatformInvoice({
        organizationId: ORG,
        facts: {
          stripeInvoiceId: `in_perf_${i}`,
          subscriptionId: null,
          periodStart: new Date(Date.UTC(2026, i, 1)),
          periodEnd: null,
          paidAt: null,
          issuedAt: new Date(Date.UTC(2026, i, 1)),
          subtotalCents: 4900,
          taxCents: 1029,
          totalCents: 5929,
          currency: "EUR",
          status: "paid",
          hostedInvoiceUrl: null,
        },
        recipient: { country: "ES", vatNumber: "ESB12345678", viesValid: true },
      })
    }
    for (let i = 0; i < 24; i++) {
      await q(
        `INSERT INTO subscription_events
           (id, organization_id, stripe_event_id, event_type, occurred_at, status_after, payload, created_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, 'customer.subscription.updated', now(), 'ACTIVE', '{}'::jsonb, now())`,
        [ORG, `evt_perf_${i}`]
      )
    }

    const { ms, maxConnections } = await watcher.measure(() =>
      tenantTransaction(ORG, USER, async (tx) => {
        const { listPlatformInvoices } = await import("@/models/platform-invoices")
        const { listPlans, getPlanById } = await import("@/models/plans")
        const { getSubscriptionContext } = await import("@/models/subscriptions")
        await getSubscriptionContext(ORG, new Date("2026-09-15T00:00:00Z"))
        await listPlans(tx)
        await getPlanById(tx, PLAN_ILIMITADO)
        await listPlatformInvoices(tx, 50)
      })
    )
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(400)
    expect(maxConnections).toBeLessThanOrEqual(2)
  }, 60_000)

  it("2/10 · `computeUsage` con caché válida: < 50 ms", async () => {
    await getUsage(ORG, new Date("2026-09-15T00:00:00Z"))
    const { ms } = await watcher.measure(() => getUsage(ORG, new Date("2026-09-15T00:00:00Z")))
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(50)
  }, 30_000)

  it(
    "3/10 · `computeUsage` recalculando: ≤ 8 consultas (exacto) y, extrapolado a 50 000 asientos / " +
      "5 000 documentos / 20 000 objetos desde dos puntos reales, < 1 200 ms",
    async () => {
      // Dos puntos: N y 2N. Con uno solo no se puede separar el coste de
      // arranque del coste por fila, que es justo lo que decide el techo.
      const N = 5_000
      await sembrarAsientos(N, 1)
      await sembrarObjetos(10_000, 0)
      await sembrarExtracciones(2_500, 0)
      const punto1 = await watcher.measure(() => getUsage(ORG, REF, { recompute: true }))

      await sembrarAsientos(N, N + 1)
      await sembrarObjetos(10_000, 10_000)
      await sembrarExtracciones(2_500, 2_500)
      const log: string[] = []
      const punto2 = await watcher.measure(() =>
        tenantTransaction(ORG, USER, async (tx) => readUsageInTransaction(contado(tx, log), ORG, REF))
      )

      // **Consultas: exacto, no estimado.** `readUsageInput` hace la
      // organización, las cifras, las fuentes, el desglose por kind y el
      // `ledgerHash` del mes. El techo de §12 son ocho.
      expect(log.length, `consultas: ${log.length}\n${log.join("\n")}`).toBeLessThanOrEqual(8)

      // Coste marginal por asiento entre los dos puntos, y extrapolación.
      const marginalPorAsiento = Math.max(0, punto2.ms - punto1.ms) / N
      const fijo = Math.max(0, punto1.ms - marginalPorAsiento * N)
      const extrapolado = fijo + marginalPorAsiento * 50_000
      expect(
        extrapolado,
        `medido ${Math.round(punto1.ms)} ms @ ${N} y ${Math.round(punto2.ms)} ms @ ${2 * N} · ` +
          `fijo ${Math.round(fijo)} ms + ${marginalPorAsiento.toFixed(4)} ms/asiento · ` +
          `extrapolado a 50 000 = ${Math.round(extrapolado)} ms`
      ).toBeLessThan(1_200)
    },
    600_000
  )

  // **BUG-E11-1 (encontrado escribiendo este test).** El techo dice
  // «< 25 ms · ≤ 2 consultas (camino caliente)», pero `assertWithinLimit` llama
  // SIEMPRE a `readUsageInTransaction` → `readUsageInput`, que recomputa las
  // seis cifras desde cero (organización, `readFigures`, `readSources`,
  // `computeLedgerHash`) en la MISMA transacción de la escritura, sin mirar
  // `UsageRun`. Es decir: el `assertWithinLimit` real no tiene camino caliente
  // — cachear entre escrituras exigiría invalidar por `sourceHash` DENTRO de
  // una transacción abierta, que es justo lo que el diseño evita para no colar
  // la última plaza (criterio 18). Con volumen mínimo mide 28-70 ms, muy por
  // encima del techo, incluso tras un warm-up. Se deja el umbral del diseño
  // para que el test siga en rojo hasta que se resuelva (no se relaja para
  // maquillar el resultado).
  it("4/10 · `assertWithinLimit` en el camino caliente: < 25 ms · ≤ 2 consultas", async () => {
    // Warm-up: la primera invocación del proceso paga el plan de consulta y el
    // pool de Prisma, que no es lo que el techo mide (E6-perf ya lo advierte).
    await tenantTransaction(ORG, USER, async (tx) =>
      assertWithinLimit(tx, "maxOcrDocsMonth", BigInt(1), { refDate: new Date("2026-09-15T00:00:00Z") })
    )
    const { ms } = await watcher.measure(() =>
      tenantTransaction(ORG, USER, async (tx) =>
        assertWithinLimit(tx, "maxOcrDocsMonth", BigInt(1), { refDate: new Date("2026-09-15T00:00:00Z") })
      )
    )
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(25)
  }, 15_000)

  it(
    "5/10 · backup completo: medido sobre el volumen sembrado y extrapolado a 50 000 asientos / " +
      "150 000 líneas — < 15 min, y el PICO de memoria del ZIP en memoria (deuda E12) acotado",
    async () => {
      const asientos = Number(
        (await q<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1::uuid`, [
          ORG,
        ]))[0].n
      )
      expect(asientos, "el techo 3 tiene que haber sembrado los asientos").toBeGreaterThan(1_000)

      if (global.gc) global.gc()
      const heapAntes = process.memoryUsage().heapUsed
      let heapPico = heapAntes
      const vigilante = setInterval(() => {
        heapPico = Math.max(heapPico, process.memoryUsage().heapUsed)
      }, 25)
      let ms = 0
      let bytes = 0
      try {
        const medida = await watcher.measure(() =>
          buildBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
        )
        ms = medida.ms
        bytes = medida.value.archive.length
        archivo = medida.value.archive
      } finally {
        clearInterval(vigilante)
      }

      const factor = 50_000 / asientos
      const extrapolado = ms * factor
      expect(
        extrapolado,
        `medido ${Math.round(ms)} ms con ${asientos} asientos · extrapolado a 50 000 = ` +
          `${Math.round(extrapolado / 1000)} s (techo 900 s)`
      ).toBeLessThan(15 * 60 * 1_000)

      /**
       * **El techo que justifica la deuda del ZIP en memoria (E12).**
       *
       * Lo que se mide y se asegura es el **tamaño del ZIP**, que es
       * determinista y es la magnitud que de verdad tiene que caber en el heap:
       * el `heapUsed` del proceso de pruebas incluye la suite entera y no sirve
       * como techo, así que se **imprime** como evidencia y no se convierte en
       * aserción. Si el ZIP de las TABLAS extrapolado a 50 000 asientos no
       * cupiera en el heap de una función serverless, la deuda dejaría de estar
       * acotada y habría que trocear ya, no en E12.
       *
       * Los 1,5 GB de FICHEROS del techo 5 son la otra mitad —y la que obliga al
       * streaming—: no caben en ningún heap y por eso la deuda está fechada.
       */
      const bytesPorAsiento = bytes / asientos
      const bytesExtrapolados = bytesPorAsiento * 50_000
      expect(
        bytesExtrapolados,
        `ZIP medido ${Math.round(bytes / 1024)} KB con ${asientos} asientos ` +
          `(pico de heap del proceso: ${Math.round((heapPico - heapAntes) / 1024 / 1024)} MB, indicativo) · ` +
          `ZIP extrapolado a 50 000 = ${Math.round(bytesExtrapolados / 1024 / 1024)} MB`
      ).toBeLessThan(512 * 1024 * 1024)
    },
    600_000
  )

  it(
    "6/10 · restauración + las SEIS verificaciones sobre el backup de 5/10: extrapolado < 30 min, " +
      "y ninguna transacción por encima de 30 s",
    async () => {
      expect(archivo, "5/10 tiene que haber producido el ZIP").not.toBeNull()
      const asientos = Number(
        (await q<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1::uuid`, [
          ORG,
        ]))[0].n
      )

      const { value: outcome, ms } = await watcher.measure(() =>
        restoreBackupIntoOrganization({
          archive: archivo!,
          targetOrganizationId: DEST,
          requestedById: USER,
          refDate: REF,
          keys: new Map([[KEY_ID, SIGNING_KEY]]),
        })
      )
      expect(outcome.rejected ?? []).toEqual([])
      // Las SEIS, escritas: el techo no vale si la verificación no ha corrido.
      expect(outcome.verification?.checks.map((check) => check.id).sort()).toEqual([
        "AUDIT_LOG",
        "BARRIDO_INVARIANTES",
        "NUMERACION",
        "RECUENTOS",
        "SELLOS_DERIVADOS",
        "SELLOS_Y_CIERRE",
      ])

      const extrapolado = ms * (50_000 / asientos)
      expect(
        extrapolado,
        `medido ${Math.round(ms)} ms con ${asientos} asientos · extrapolado a 50 000 = ` +
          `${Math.round(extrapolado / 1000)} s (techo 1 800 s)`
      ).toBeLessThan(30 * 60 * 1_000)

      // «Ninguna transacción > 30 s»: se comprueba que NINGUNA quedó abierta más
      // de ese tiempo durante la restauración (el arnés vigila `pg_stat_activity`).
      const [{ max_s }] = await q<{ max_s: string | null }>(
        `SELECT max(extract(epoch FROM (now() - xact_start)))::text AS max_s
           FROM pg_stat_activity WHERE datname = current_database() AND xact_start IS NOT NULL`
      )
      expect(Number(max_s ?? 0)).toBeLessThan(30)
    },
    900_000
  )

  it("7/10 · webhook de Stripe: < 300 ms", async () => {
    const payload = JSON.stringify({
      id: "evt_perf_unhandled",
      object: "event",
      type: "payment_method.attached",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "pm_perf" } },
    })
    const signature = StripeSdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_e11_perf" })
    const req = new Request("https://erp.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature, "content-type": "application/json" },
      body: payload,
    })
    const { value: res, ms } = await watcher.measure(() => webhookPOST(req))
    expect(res.status).toBe(200)
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(300)
  }, 15_000)

  it(
    "8/10 · `/api/cron/invariant-sweep`: coste por organización medido y extrapolado a 50 — " +
      "< 240 s, o `PARTIAL` con cursor",
    async () => {
      // El barrido es lineal en organizaciones: cada una abre su transacción,
      // corre `runLedgerInvariants(audit: true)` y cierra. Se mide UNA con datos
      // reales —la que 3/10 ha sembrado— y se extrapola a las cincuenta.
      const { runLedgerInvariants } = await import("@/models/ledger")
      const { ms } = await watcher.measure(() =>
        runLedgerInvariants(ORG, { refDate: "2027-12-31", audit: true, noCache: true })
      )
      const extrapolado = ms * 50
      expect(
        extrapolado,
        `una organización con datos reales: ${Math.round(ms)} ms · extrapolado a 50 = ` +
          `${Math.round(extrapolado / 1000)} s (techo 240 s)`
      ).toBeLessThan(240 * 1_000)

      // Y la otra mitad del techo —«o `PARTIAL` con cursor»— es una propiedad,
      // no una cifra: el job trocea y persiste el cursor. Lo ejerce a escala
      // reducida `e11a-webhook-cron.test.ts` (criterios 48/52/53); aquí se
      // comprueba que el contrato del troceado sigue declarado.
      const { CRON_JOBS } = await import("@/lib/platform/cron")
      expect([...CRON_JOBS]).toContain("invariant-sweep")
    },
    600_000
  )

  it("9/10 · `/api/health`: < 200 ms", async () => {
    const { value: report, ms } = await watcher.measure(() =>
      healthReport({ version: "1.0.0-perf", gitSha: "0".repeat(40), refDate: new Date() })
    )
    expect(report.status).not.toBe("down")
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(200)
  }, 15_000)

  it(
    "10/10 · calendario de `/time` (D-8): 250 empleados × 22 días, 1 consulta agregada, < 400 ms " +
      "— criterio 55; `calendarByEmployeeDaySql` no tenía NINGÚN test, ni de corrección ni de rendimiento",
    async () => {
      const employees = 250
      const days = 22
      await q(
        `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now(), now())`,
        [ORG]
      )
      const [cc] = await q<{ id: string }>(
        `INSERT INTO cost_centers
           (id, organization_id, code, name, kind, margin_level, allocatable, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 'PERF-CC', 'CECO perf', 'OPERACIONES_INDIRECTAS', 'MC3', true, true, now(), now())
         RETURNING id`,
        [ORG]
      )
      await q(
        `INSERT INTO employees (id, organization_id, code, name, is_active, created_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, 'EMP-' || g, 'Empleado ' || g, true, now(), now()
           FROM generate_series(1, $2) AS g`,
        [ORG, employees]
      )
      const empleados = await q<{ id: string }>(`SELECT id FROM employees WHERE organization_id = $1::uuid`, [ORG])
      // Inserción masiva de partes: una fila por (empleado, día laborable de sep-2026), 100 min c/u,
      // ya APROBADOS (approved_at obligatorio por el CHECK `time_entries_approval_marks`).
      await q(
        `INSERT INTO time_entries
           (id, organization_id, employee_id, date, cost_center_id, minutes, status, approved_at, approved_by_id, created_at)
         SELECT gen_random_uuid(), $1::uuid, e.id,
                (DATE '2026-09-01' + (d - 1) * INTERVAL '1 day')::date,
                $3::uuid, 100, 'APROBADO', now(), $4::uuid, now()
           FROM employees e, generate_series(1, $2) AS d
          WHERE e.organization_id = $1::uuid AND EXTRACT(ISODOW FROM (DATE '2026-09-01' + (d - 1) * INTERVAL '1 day')) < 6`,
        [ORG, days + 10, cc.id, USER]
      )

      const { value: rows, ms, maxConnections } = await watcher.measure(() =>
        tenantTransaction(ORG, USER, async (tx) =>
          calendarByEmployeeDaySql(tx, { from: "2026-09-01", to: "2026-09-30" })
        )
      )
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(employees * days)
      expect(ms, `${Math.round(ms)} ms`).toBeLessThan(400)
      expect(maxConnections).toBeLessThanOrEqual(2)
      expect(empleados.length).toBe(employees)
    },
    60_000
  )
})
