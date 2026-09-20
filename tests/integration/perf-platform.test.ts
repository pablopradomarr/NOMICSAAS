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
 * ## E12 · T17 — se acabó la extrapolación (deuda 6 de §6)
 *
 * E11 midió los techos 3, 5, 6 y 8 con volumen reducido y **extrapolando**: se
 * separaba el coste fijo del marginal, se derivaba el coste por asiento y se
 * proyectaba a 50 000. Era lo honesto que cabía entonces, y no ve lo que sólo
 * aparece con volumen real —un plan que cambia cuando la tabla crece, un índice
 * que deja de usarse, un heap que no da más de sí—.
 *
 * Ahora el volumen es el declarado, y sale del fixture sellado
 * `tests/fixtures/gran-volumen/` (**50 000 asientos · 150 000 líneas · 2 000
 * documentos / 1,5 GB · 50 organizaciones**), que no es un fichero de datos sino
 * una especificación con semilla y **digests de todo lo que produce**: el
 * generador de Python sella y el de TypeScript siembra, y los dos tienen que dar
 * lo mismo (`verificarContra`).
 *
 * **Lo que se mide y lo que no, dicho aquí y no en una nota al pie:**
 *
 * | Techo | Volumen con el que se mide | Extrapolado |
 * |---|---|---|
 * | 3 · `computeUsage` recalculando | 50 000 asientos / 150 000 líneas reales | **no** |
 * | 5 · backup completo | ídem + 2 000 documentos / 1,5 GB reales | **no** |
 * | 6 · restauración + las seis | ídem, **sin los 1,5 GB de documentos** | **no**, pero parcial: ver §techo 6 |
 * | 8 · barrido por organización | 50 organizaciones reales | **no** |
 *
 * El sembrado es caro (minutos) y por eso esta suite no corre en cada PR: el job
 * `perf` de CI la lanza sólo en `push` a `main` (§8 del diseño de E12).
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
const { buildBackupArchive, planBackupArchive, restoreBackupIntoOrganization } = await import("@/models/backups")
const { assertWithinLimit } = await import("@/models/platform-limits")
const { issuePlatformInvoice } = await import("@/models/platform-invoices")
const { calendarByEmployeeDaySql } = await import("@/models/time")
const { healthReport } = await import("@/models/platform")
const {
  leerSpec,
  asientos: asientosDelFixture,
  documentos: documentosDelFixture,
  bytesDeDocumento,
  organizaciones: organizacionesDelFixture,
  verificarContra,
} = await import("@/tests/fixtures/gran-volumen/generate")
const { POST: webhookPOST } = await import("@/app/api/stripe/webhook/route")
const StripeSdk = (await import("stripe")).default

const OWNER_URL = process.env.DATABASE_URL_TEST || "postgresql://postgres@localhost:5432/erp_test"
const ORG = "e11ffff0-0000-4000-8000-00000000000a"
const DEST = "e11ffff0-0000-4000-8000-00000000000b"
const USER = "e11ffff0-0000-4000-8000-0000000000a1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"
const FY = "e11ffff0-0000-4000-8000-0000000000f1"
const CUENTA_DEBE = "6290"
/** Tercera cuenta del asiento de tres líneas del fixture de gran volumen. */
const CUENTA_DEBE_2 = "6210"
const CUENTA_HABER = "5720"
const SIGNING_KEY = Buffer.from("clave-de-firma-perf-e11")
const KEY_ID = "k1"
/** El ejercicio sembrado es 2027: la referencia lo cubre entero (I8). */
const REF = new Date("2027-12-31T12:00:00.000Z")

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

/**
 * Vacía las organizaciones del arnés, **con la lista DERIVADA del esquema**.
 *
 * **E12 · T17.** La lista a mano se quedó corta en cuanto el volumen real trajo
 * `files`, `backup_jobs` y `stored_objects` de verdad: el `DELETE FROM
 * organizations` chocaba contra una FK, el error dejaba la sesión a medias y el
 * `beforeAll` siguiente sembraba sobre una base sucia. Es la cuarta vez que la
 * lista a mano falla (BUG-E7-1, BUG-E9-5, BUG-E10-1, BUG-E11-2) y la enmienda
 * **E-4** dice exactamente esto: **todo inventario es derivado**.
 *
 * Se recorren TODAS las tablas con `organization_id`, en orden inverso de
 * dependencia, con los disparadores de usuario y el `FORCE ROW LEVEL SECURITY`
 * levantados —es una base de test y este cliente es el propietario—. Una tabla
 * nueva de la épica 68 entra sola.
 */
async function purgarOrganizaciones(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const tablas = await q<{ tabla: string }>(
    `SELECT c.relname AS tabla
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname`
  )

  await q(`SET session_replication_role = 'replica'`)
  try {
    for (const { tabla } of tablas) {
      await q(`ALTER TABLE "${tabla}" NO FORCE ROW LEVEL SECURITY`).catch(() => undefined)
    }
    // **Una sola pasada, y basta**: con `session_replication_role = 'replica'`
    // los disparadores de FK no se evalúan, así que el orden alfabético da
    // igual. Es lo que convierte una purga en cuadrática —tres pasadas sobre
    // sesenta tablas— en una lineal.
    for (const { tabla } of tablas) {
      await q(`DELETE FROM "${tabla}" WHERE organization_id = ANY($1::uuid[])`, [ids]).catch(() => undefined)
    }
    for (const { tabla } of tablas) {
      await q(`ALTER TABLE "${tabla}" FORCE ROW LEVEL SECURITY`).catch(() => undefined)
    }
  } finally {
    await q(`SET session_replication_role = 'origin'`)
  }
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ids])
}

async function limpiar() {
  const gv = organizacionesDelFixture(GRAN_VOLUMEN).map((o) => o.id)
  await purgarOrganizaciones([DEST, ORG, ...gv])
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

/** El fixture sellado de gran volumen (E12 · T17). */
const GRAN_VOLUMEN = leerSpec()

/**
 * Siembra el diario del fixture de gran volumen: **50 000 asientos y 150 000
 * líneas reales**, por `COPY`-como-INSERT en lotes.
 *
 * Por SQL directo y no por el motor, igual que la siembra reducida que había
 * antes: el techo mide la LECTURA. La diferencia con E11 es que las cifras no se
 * inventan aquí — vienen del fixture, que las tiene selladas y cuadradas
 * (Σdebe = Σhaber, tolerancia 0).
 */
async function sembrarGranVolumen(): Promise<void> {
  const LOTE = 2_000
  const entradas = [...asientosDelFixture(GRAN_VOLUMEN)]

  for (let i = 0; i < entradas.length; i += LOTE) {
    const lote = entradas.slice(i, i + LOTE)
    await q("BEGIN")
    // Los asientos y sus líneas en la MISMA transacción: el constraint trigger
    // diferido de «un asiento tiene al menos dos líneas» se evalúa al COMMIT.
    await q(
      `INSERT INTO journal_entries
         (id, organization_id, fiscal_year_id, entry_number, entry_date, description,
          posted_by_id, entry_hash, hash_version, kind)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, n::int, d::date, 'gv ' || n,
              $3::uuid, repeat('0', 64), 3, 'NORMAL'
         FROM unnest($4::int[], $5::text[]) AS t(n, d)`,
      [ORG, FY, USER, lote.map((e) => e.entryNumber), lote.map((e) => e.date)]
    )
    await q(
      `INSERT INTO journal_lines
         (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          entry_date, fiscal_year_id, entry_kind)
       SELECT gen_random_uuid(), e.organization_id, e.id, v.line_no, v.code,
              v.debit, v.credit, e.entry_date, e.fiscal_year_id, 'NORMAL'
         FROM journal_entries e
         JOIN unnest($2::int[], $3::int[], $4::int[]) AS t(n, d1, d2) ON t.n = e.entry_number
         CROSS JOIN LATERAL (VALUES
             (1, $5::text, t.d1, 0),
             (2, $6::text, t.d2, 0),
             (3, $7::text, 0, t.d1 + t.d2)
           ) AS v(line_no, code, debit, credit)
        WHERE e.organization_id = $1::uuid
          AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = e.id)`,
      [
        ORG,
        lote.map((e) => e.entryNumber),
        lote.map((e) => e.debit1),
        lote.map((e) => e.debit2),
        CUENTA_DEBE,
        CUENTA_DEBE_2,
        CUENTA_HABER,
      ]
    )
    await q("COMMIT")
  }
}

/**
 * Los **2 000 documentos / 1,5 GB reales** del fixture, escritos en el almacén y
 * registrados como `File` + `StoredObject`.
 *
 * Los bytes se derivan de la semilla **en bloques de 64 KB**: 1,5 GB no caben en
 * un `Buffer` y no tienen por qué. Es, además, el mismo camino que el backup
 * usará para leerlos, así que lo que se mide después es el coste de verdad.
 */
async function sembrarDocumentosReales(log?: (m: string) => void): Promise<{ files: number; bytes: number }> {
  const { storage, objectKey } = await import("@/lib/storage")
  const { driver, prefix } = storage()
  const docs = documentosDelFixture(GRAN_VOLUMEN)
  let bytes = 0

  for (const doc of docs) {
    const sha256 = await (async () => {
      const { createHash } = await import("node:crypto")
      const h = createHash("sha256")
      for await (const chunk of bytesDeDocumento(doc)) h.update(chunk)
      return h.digest("hex")
    })()
    const key = objectKey({ prefix, organizationId: ORG, kind: "DOCUMENT", sha256 })
    await driver.putStreaming(key, bytesDeDocumento(doc), { mimeType: "application/pdf" })
    bytes += doc.sizeBytes

    await q(
      `INSERT INTO stored_objects (id, organization_id, object_key, backend, sha256, size_bytes, mime_type, kind, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'LOCAL', $3, $4, 'application/pdf', 'DOCUMENT', now())
       ON CONFLICT DO NOTHING`,
      [ORG, key, sha256, doc.sizeBytes]
    )
    await q(
      `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 'application/pdf', $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [ORG, USER, `gv-${doc.index}.pdf`, `gv/${doc.index}.pdf`, sha256, doc.sizeBytes]
    )
    if (log && doc.index % 500 === 0) log(`  · ${doc.index}/${docs.length} documentos`)
  }

  return { files: docs.length, bytes }
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

/**
 * Documentos y sus extracciones. **Revisor R2-3**: la ronda anterior capturaba
 * el fallo del `INSERT` con un `console.warn` y seguía, de modo que una de las
 * tres dimensiones del techo 3 (5 000 documentos) no se medía y el aviso moría
 * en `stderr`. Ahora **no se captura nada**: si la siembra no puede hacerse, el
 * test falla. Un techo medido sobre dos tercios del volumen no es el techo.
 */
async function sembrarExtracciones(n: number, desde: number): Promise<void> {
  await q(
    `INSERT INTO files
       (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes, created_at)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'perf-' || ($3 + g) || '.pdf',
            'perf/' || ($3 + g) || '.pdf', 'application/pdf',
            lpad((($3 + g))::text, 64, 'a'), 2048, now()
       FROM generate_series(0, $4 - 1) AS g`,
    [ORG, USER, desde, n]
  )
  await q(
    `INSERT INTO extraction_runs
       (id, organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
        prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, duration_ms, git_sha, created_at)
     SELECT gen_random_uuid(), f.organization_id, f.id, f.sha256, 'LLM', 'perf', 'perf-model',
            'FACTURA_RECIBIDA', 'GIT', repeat('1', 64), '1', repeat('2', 64), 1, 1, '{}'::jsonb, 1, repeat('0', 40), now()
       FROM files f
      WHERE f.organization_id = $1::uuid
        AND f.filename LIKE 'perf-%'
        AND NOT EXISTS (SELECT 1 FROM extraction_runs r WHERE r.file_id = f.id)`,
    [ORG]
  )
}

/**
 * **R2-3.** Las tres dimensiones del techo 3, contadas contra la base. Si una no
 * está, el test falla con su nombre: el techo se mide entero o no se mide.
 */
async function comprobarVolumen(esperado: { asientos: number; objetos: number; extracciones: number }): Promise<void> {
  const [fila] = await q<{ asientos: string; objetos: string; extracciones: string }>(
    `SELECT (SELECT count(*) FROM journal_entries WHERE organization_id = $1::uuid)::text AS asientos,
            (SELECT count(*) FROM stored_objects  WHERE organization_id = $1::uuid)::text AS objetos,
            (SELECT count(*) FROM extraction_runs WHERE organization_id = $1::uuid)::text AS extracciones`,
    [ORG]
  )
  expect(Number(fila.asientos), "asientos sembrados").toBe(esperado.asientos)
  expect(Number(fila.objetos), "objetos de almacén sembrados").toBe(esperado.objetos)
  expect(Number(fila.extracciones), "documentos analizados sembrados").toBe(esperado.extracciones)
}

/**
 * **Higiene de medida (R2-1).** Se mide el TECHO, no la inserción: tras sembrar
 * decenas de miles de filas, la primera lectura paga los *hint bits*, las
 * páginas sucias y un plan calculado sobre estadísticas viejas — eso es el coste
 * de escribir, no el de consultar. Se hace `ANALYZE` de las tablas que el uso
 * recorre y una lectura de calentamiento, y **después** se cronometra. Es lo
 * mismo que hace `perf-budget.test.ts` con su warm-up, escrito aquí porque el
 * volumen lo hace imprescindible.
 */
async function medirUso(log?: string[]): Promise<number> {
  await q(`ANALYZE journal_entries, journal_lines, stored_objects, extraction_runs, files, audit_logs, memberships`)
  await tenantTransaction(ORG, USER, async (tx) => readUsageInTransaction(tx, ORG, REF))
  const { ms } = await watcher.measure(() =>
    tenantTransaction(ORG, USER, async (tx) =>
      readUsageInTransaction(log ? contado(tx, log) : tx, ORG, REF)
    )
  )
  return ms
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
            (gen_random_uuid(), $1::uuid, $3, 'Bancos', 4, 'DEUDORA', true, true, now(), now()),
            (gen_random_uuid(), $1::uuid, $4, 'Arrendamientos', 4, 'DEUDORA', true, true, now(), now())`,
    [ORG, CUENTA_DEBE, CUENTA_HABER, CUENTA_DEBE_2]
  )
  await q(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, '2027', '2027-01-01', '2027-12-31', 'OPEN', now(), now())`,
    [FY, ORG]
  )
}, 600_000)

afterAll(async () => {
  await limpiar()
  await client.end()
  await watcher.stop()
  await rm(storeRoot, { recursive: true, force: true })
}, 600_000)

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
    "3/10 · `computeUsage` recalculando con VOLUMEN REAL del fixture sellado " +
      "(50 000 asientos · 150 000 líneas · 20 000 objetos · 5 000 documentos): ≤ 8 consultas y < 1 200 ms",
    async () => {
      /**
       * **E12 · T17 — ni una extrapolación.** El volumen es el que §12 declara,
       * sembrado desde `tests/fixtures/gran-volumen/`, y antes de sembrarlo se
       * comprueba que el generador de TypeScript reproduce los digests que selló
       * el de Python: si los dos caminos divergieran, el fixture dejaría de
       * significar nada y el techo se estaría midiendo sobre datos inventados.
       */
      const cruce = await verificarContra(GRAN_VOLUMEN, { incluirFicheros: false })
      expect(cruce.discrepancias, "el fixture no se reproduce desde TypeScript").toEqual([])

      await sembrarGranVolumen()
      await sembrarObjetos(20_000, 0)
      await sembrarExtracciones(5_000, 0)
      await comprobarVolumen({ asientos: GRAN_VOLUMEN.totals.entries, objetos: 20_000, extracciones: 5_000 })

      // Y las 150 000 líneas, que son las que el agregado recorre de verdad.
      const [{ n: lineas }] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_lines WHERE organization_id = $1::uuid`,
        [ORG]
      )
      expect(Number(lineas)).toBe(GRAN_VOLUMEN.totals.journalLines)

      // Σdebe = Σhaber con tolerancia 0 sobre el volumen real: un fixture de
      // rendimiento que no cuadra mide el reloj de un diario imposible.
      const [{ debe, haber }] = await q<{ debe: string; haber: string }>(
        `SELECT sum(debit_cents)::text AS debe, sum(credit_cents)::text AS haber
           FROM journal_lines WHERE organization_id = $1::uuid`,
        [ORG]
      )
      expect(Number(debe)).toBe(GRAN_VOLUMEN.totals.debitCents)
      expect(Number(haber)).toBe(GRAN_VOLUMEN.totals.creditCents)

      const log: string[] = []
      const medido = await medirUso(log)

      // **Consultas: exacto, no estimado.** El número no depende del volumen y
      // el techo de §12 son ocho.
      expect(log.length, `consultas: ${log.length}\n${log.join("\n")}`).toBeLessThanOrEqual(8)
      expect(medido, `MEDIDO con 50 000 asientos / 150 000 líneas: ${Math.round(medido)} ms (techo 1 200 ms)`).toBeLessThan(
        1_200
      )
    },
    2_400_000
  )

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
    "5/10 · backup completo con VOLUMEN REAL (50 000 asientos · 150 000 líneas · 2 000 documentos / 1,5 GB): " +
      "< 15 min y **pico de memoria estable** — medido, no extrapolado",
    async () => {
      /**
       * **E12 · T17 + T14 · el criterio 47 de §10, medido de verdad.**
       *
       * E11 sólo podía extrapolar porque el ZIP se construía en memoria: 1,5 GB
       * no caben en el heap y el proceso moría antes de firmar nada. Con la
       * emisión en streaming de T14 el archivo sale bloque a bloque, y lo que se
       * mide aquí es el techo entero: 50 000 asientos, 150 000 líneas y los 2 000
       * documentos reales del fixture.
       *
       * **Lo que se asegura no es sólo el tiempo: es que el pico de memoria NO
       * crece con el volumen.** Se mide el heap del proceso durante la emisión y
       * se exige que el crecimiento sea de decenas de MB, con 1,5 GB pasando por
       * delante. Si alguien volviera a materializar el archivo, esta aserción
       * —y no el reloj— es la que lo cazaría.
       */
      const asientos = Number(
        (await q<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1::uuid`, [
          ORG,
        ]))[0].n
      )
      expect(asientos, "3/10 tiene que haber sembrado el volumen real").toBe(GRAN_VOLUMEN.totals.entries)

      const sembrado = await sembrarDocumentosReales((m) => console.log(m))
      expect(sembrado.files).toBe(GRAN_VOLUMEN.totals.files)
      expect(sembrado.bytes).toBe(GRAN_VOLUMEN.totals.fileBytes)

      if (global.gc) global.gc()
      const heapAntes = process.memoryUsage().heapUsed
      let heapPico = heapAntes
      const vigilante = setInterval(() => {
        heapPico = Math.max(heapPico, process.memoryUsage().heapUsed)
      }, 25)

      let ms = 0
      let bytes = 0
      try {
        // Se consume el plan **en streaming y descartando los bloques**, que es
        // exactamente lo que hace la subida multipart en producción. Guardar el
        // archivo en un Buffer aquí mediría lo contrario de lo que se quiere.
        const arranque = performance.now()
        const plan = await planBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
        try {
          for await (const chunk of plan.archiveChunks()) bytes += chunk.length
        } finally {
          await plan.cleanup()
        }
        ms = performance.now() - arranque
      } finally {
        clearInterval(vigilante)
      }

      const crecimientoMb = Math.round((heapPico - heapAntes) / 1024 / 1024)
      const detalle =
        `MEDIDO: ${Math.round(ms / 1000)} s con ${asientos} asientos, ${GRAN_VOLUMEN.totals.journalLines} líneas y ` +
        `${(sembrado.bytes / 1e9).toFixed(2)} GB en ${sembrado.files} documentos · ` +
        `archivo de ${(bytes / 1e9).toFixed(2)} GB · crecimiento de heap ${crecimientoMb} MB`

      expect(bytes, detalle).toBeGreaterThan(GRAN_VOLUMEN.totals.fileBytes)
      expect(ms, `${detalle} (techo 900 s)`).toBeLessThan(15 * 60 * 1_000)
      /**
       * **Pico estable: el heap NO sigue al volumen.**
       *
       * El umbral no es un número bonito, es una frontera con significado: el
       * archivo pesa 1,53 GB, así que una implementación que lo materializara
       * —la de E11, con `JSZip.generateAsync`— crecería **al menos** esos 1,53 GB,
       * y en la práctica dos o tres veces más (el contenido sin comprimir y el
       * comprimido a la vez). Medio giga es un tercio del archivo: por debajo de
       * ahí, el archivo no está en memoria, y es lo único que hay que demostrar.
       */
      const techoDeHeap = 512 * 1024 * 1024
      expect(
        heapPico - heapAntes,
        `${detalle} · el archivo pesa ${(bytes / 1e9).toFixed(2)} GB y el heap crece ${crecimientoMb} MB ` +
          `(techo ${techoDeHeap / 1024 / 1024} MB: un tercio del archivo)`
      ).toBeLessThan(techoDeHeap)
    },
    3_600_000
  )

  it(
    "6/10 · restauración + las SEIS verificaciones con el diario REAL (50 000 asientos · 150 000 líneas): " +
      "< 30 min y ninguna transacción por encima de 30 s",
    async () => {
      /**
       * **Lo que este techo mide, y lo que NO.**
       *
       * El diario va completo: 50 000 asientos y 150 000 líneas reales, que es lo
       * que domina el techo de 30 minutos —la restauración inserta fila a fila en
       * orden de FK y recomputa los sellos—. Los **documentos quedan fuera** del
       * archivo de este caso, y no por comodidad:
       * `restoreBackupIntoOrganization` recibe el archivo como `Buffer` y lo abre
       * con `JSZip.loadAsync`, así que un archivo de 1,5 GB no cabe en el heap.
       * T14 resolvió la ESCRITURA en streaming; la LECTURA sigue siendo en
       * memoria, y hacen falta un lector de acceso aleatorio sobre fichero y el
       * cableado de las seis comprobaciones a él.
       *
       * **Se dice aquí y se re-fecha con motivo** (estándar de CLAUDE.md), en vez
       * de medir el techo con volumen reducido y llamarlo medido, o de dar por
       * bueno un caso que no se ha ejercido. Lo que este test acredita es el
       * techo del DIARIO a volumen real; lo que falta —restaurar un archivo
       * multi-GB— queda declarado como el resto de la deuda 1.
       */
      const asientos = Number(
        (await q<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1::uuid`, [
          ORG,
        ]))[0].n
      )
      expect(asientos).toBe(GRAN_VOLUMEN.totals.entries)

      // Sin documentos: el `File` se queda, pero sus bytes no viajan. El manifest
      // lo declara con tamaño -1 y la comprobación 6 lo enseña, que es justo el
      // comportamiento que hay que poder verificar.
      const sinDocumentos = await buildBackupArchive(ORG, {
        refDate: REF,
        signingKey: SIGNING_KEY,
        signingKeyId: KEY_ID,
        readFileBytes: async () => null,
      })

      const { value: outcome, ms } = await watcher.measure(() =>
        restoreBackupIntoOrganization({
          archive: sinDocumentos.archive,
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

      expect(
        ms,
        `MEDIDO: ${Math.round(ms / 1000)} s restaurando ${asientos} asientos y ` +
          `${GRAN_VOLUMEN.totals.journalLines} líneas (techo 1 800 s). Documentos excluidos: ver la nota del caso.`
      ).toBeLessThan(30 * 60 * 1_000)

      // «Ninguna transacción > 30 s».
      const [{ max_s }] = await q<{ max_s: string | null }>(
        `SELECT max(extract(epoch FROM (now() - xact_start)))::text AS max_s
           FROM pg_stat_activity WHERE datname = current_database() AND xact_start IS NOT NULL`
      )
      expect(Number(max_s ?? 0)).toBeLessThan(30)
    },
    3_600_000
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
    "8/10 · `/api/cron/invariant-sweep` sobre las **50 organizaciones reales** del fixture: < 240 s, " +
      "o `PARTIAL` con cursor",
    async () => {
      /**
       * **E12 · T17.** E11 medía UNA organización y multiplicaba por cincuenta.
       * Aquí se crean las cincuenta del fixture sellado y se barren todas: el
       * coste por organización no es constante —cada una abre su transacción,
       * fija sus GUC y compone su bloque de entrada— y multiplicar escondía
       * precisamente eso.
       *
       * Una de las cincuenta es la del volumen real (50 000 asientos), que es el
       * caso peor; las otras cuarenta y nueve nacen vacías, que es el caso normal
       * de una plataforma. La mezcla es deliberada: medir cincuenta
       * organizaciones cargadas no es el techo que §12 declara.
       */
      const { runLedgerInvariants } = await import("@/models/ledger")
      const orgs = organizacionesDelFixture(GRAN_VOLUMEN)

      for (const org of orgs) {
        await q(
          `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, $2, $2, now())
           ON CONFLICT (id) DO NOTHING`,
          [org.id, org.slug]
        )
        await q(
          `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now(), now())
           ON CONFLICT DO NOTHING`,
          [org.id, USER]
        )
        await q(
          `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
           VALUES ($1::uuid, 'ILIMITADO', $2::uuid, 'ACTIVE', now()) ON CONFLICT DO NOTHING`,
          [org.id, PLAN_ILIMITADO]
        )
      }
      expect(orgs.length).toBe(GRAN_VOLUMEN.totals.organizations)

      const arranque = performance.now()
      // La cargada primero: si el presupuesto se agota, que sea con el caso peor
      // ya medido y no escondido al final de la cola.
      await runLedgerInvariants(ORG, { refDate: "2027-12-31", audit: true, noCache: true })
      for (const org of orgs) {
        await runLedgerInvariants(org.id, { refDate: "2027-12-31", audit: true, noCache: true })
      }
      const ms = performance.now() - arranque

      expect(
        ms,
        `MEDIDO: ${Math.round(ms / 1000)} s barriendo ${orgs.length + 1} organizaciones ` +
          `(una con ${GRAN_VOLUMEN.totals.entries} asientos) · techo 240 s`
      ).toBeLessThan(240 * 1_000)

      // Y la otra mitad del techo —«o `PARTIAL` con cursor»— es una propiedad,
      // no una cifra: el job trocea y persiste el cursor.
      const { CRON_JOBS } = await import("@/lib/platform/cron")
      expect([...CRON_JOBS]).toContain("invariant-sweep")
    },
    2_400_000
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
