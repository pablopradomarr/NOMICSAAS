/**
 * E12 · ronda 1 de corrección — **las claves ajenas entrantes desde las tablas
 * que se conservan** (BLOQUEA 1 y DEBE #3 de `docs/design/E12-revision.md`).
 *
 * Los dos borrados masivos del producto ignoraban las mismas aristas:
 *
 *  · `reset-org` sólo miraba las FK **entre las tablas que borra**, así que
 *    `invariant_runs→fiscal_years`, `invariant_runs→store_sweeps`,
 *    `closing_runs→fiscal_years` y `extraction_runs→files` —todas `RESTRICT`
 *    desde tablas preservadas por D2— reventaban el `DELETE` con `23503`. El
 *    test de T13 no lo veía porque su organización se sembraba **sin runs ni
 *    ficheros**, es decir, más pobre que cualquier organización real.
 *  · `purgeDerived` borraba en orden **alfabético** y no miraba
 *    `manual_review_flags→invariant_runs` ni los `closing_runs` sellados, que
 *    `filtroDe` conserva.
 *
 * Aquí se siembra justo lo que faltaba y se comprueba contra Postgres.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e12b0000-0000-4000-8000-000000000001"
const ADMIN = "e12b0000-0000-4000-8000-0000000000a1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"
const NOMBRE = "E12 Ronda Uno S.L."
const MOTIVO = "La organización de demostración quedó con barridos de una prueba y hay que dejarla vacía"
const NOW = new Date("2026-10-01T10:00:00.000Z")

const { prisma, prismaSchemaMeta, tenantTransaction } = await import("@/lib/db")
const { planResetOrg, runResetOrg, resetModels, tableOf, deletionOrder } = await import("@/app/(app)/admin/operations")
const { planDeletion, readForeignKeys, retainersOf } = await import("@/lib/platform/deletion-plan")
const { purgeDerived, derivedTables } = await import("@/models/purge-derived")
const { appMaintenanceDatabaseUrl, ownerDatabaseUrl } = await import("@/tests/support/env")

const ctx = () => ({
  actor: "operador@cfonomic.com",
  userId: ADMIN,
  reason: MOTIVO,
  confirmedName: NOMBRE,
  now: NOW,
})

async function withMaintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL_MAINTENANCE || appMaintenanceDatabaseUrl(ownerDatabaseUrl())
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Ids sembrados, para poder afirmar sobre filas concretas. */
const ids = {
  fiscalYear: "",
  storeSweep: "",
  invariantRun: "",
  closingSellado: "",
  closingBorrador: "",
  file: "",
  extractionRun: "",
  reportRun: "",
}

describe.skipIf(!TEST_DATABASE_URL)("E12 · ronda 1 — FK entrantes desde tablas preservadas", () => {
  beforeAll(async () => {
    await prisma.platformAuditLog.deleteMany({ where: { organizationId: ORG } })
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.user.deleteMany({ where: { id: ADMIN } })
    await prisma.user.create({
      data: { id: ADMIN, email: "e12-ronda1@test.local", name: "Operador ronda 1", updatedAt: new Date() },
    })
    await prisma.organization.create({
      data: { id: ORG, slug: "e12-ronda1", name: NOMBRE, pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: ADMIN, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
    await prisma.subscription.create({
      data: { organizationId: ORG, planCode: "ILIMITADO", planId: PLAN_ILIMITADO, status: "ACTIVE" },
    })

    /**
     * **El sustrato que al test de T13 le faltaba**: un ejercicio, un barrido
     * del almacén, un `InvariantRun` que señala a los dos, un documento con su
     * `ExtractionRun`, un cierre SELLADO y otro en BORRADOR, un `ReportRun` y una
     * marca de revisión manual. Y **ni un solo asiento**: con uno, `reset-org`
     * ni se ofrece (D1).
     */
    await withMaintenance(async (client) => {
      const fy = await client.query<{ id: string }>(
        `INSERT INTO "fiscal_years" (id, organization_id, code, start_date, end_date, status, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now()) RETURNING id`,
        [ORG]
      )
      ids.fiscalYear = fy.rows[0]!.id

      const sweep = await client.query<{ id: string }>(
        `INSERT INTO "store_sweeps" (id, organization_id, status, files_total, files_ok, finished_at)
         VALUES (gen_random_uuid(), $1::uuid, 'DONE', 1, 1, now()) RETURNING id`,
        [ORG]
      )
      ids.storeSweep = sweep.rows[0]!.id

      const run = await client.query<{ id: string }>(
        `INSERT INTO "invariant_runs" (id, organization_id, scope_kind, fiscal_year_id, trigger, ref_date,
            ledger_hash, plan_hash, account_map_hash, config_hash, git_sha, checks_hash, checks, counts,
            coverage, headline, seal, store_sweep_id, duration_ms)
         VALUES (gen_random_uuid(), $1::uuid, 'FISCAL_YEAR', $2::uuid, 'MANUAL', '2026-12-31',
            repeat('a',64), repeat('b',64), repeat('c',64), repeat('d',64), 'ronda1', repeat('e',64),
            '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'VALIDADO_AUTOMATICAMENTE', $3::uuid, 1)
         RETURNING id`,
        [ORG, ids.fiscalYear, ids.storeSweep]
      )
      ids.invariantRun = run.rows[0]!.id

      for (const [estado, clave] of [
        ["CERRADO", "closingSellado"],
        ["BORRADOR", "closingBorrador"],
      ] as const) {
        const closing = await client.query<{ id: string }>(
          `INSERT INTO "closing_runs" (id, organization_id, fiscal_year_id, status, ref_date, steps,
              ledger_hash, plan_hash, account_map_hash, config_hash, git_sha, invariant_run_id, seal, duration_ms,
              closed_at)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::closing_run_status, '2026-12-31', '[]'::jsonb,
              repeat('a',64), repeat('b',64), repeat('c',64), repeat('d',64), 'ronda1', $4::uuid,
              'VALIDADO_AUTOMATICAMENTE', 1,
              CASE WHEN $3 = 'CERRADO' THEN now() ELSE NULL END) RETURNING id`,
          [ORG, ids.fiscalYear, estado, ids.invariantRun]
        )
        ids[clave] = closing.rows[0]!.id
      }

      const file = await client.query<{ id: string }>(
        `INSERT INTO "files" (id, organization_id, filename, path, mimetype, sha256, size_bytes)
         VALUES (gen_random_uuid(), $1::uuid, 'factura.pdf', 'e12/ronda1/factura.pdf', 'application/pdf',
            repeat('f',64), 1024) RETURNING id`,
        [ORG]
      )
      ids.file = file.rows[0]!.id

      const extraction = await client.query<{ id: string }>(
        `INSERT INTO "extraction_runs" (id, organization_id, file_id, file_sha256, kind, provider, model,
            prompt_code, prompt_source, prompt_sha, schema_version, schema_sha, pages_sent, pages_total,
            raw_output, duration_ms, git_sha)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, repeat('f',64), 'LLM', 'openai', 'gpt-test',
            'invoice', 'GIT', repeat('1',64), 'v1', repeat('2',64), 1, 1, '{}'::jsonb, 1, 'ronda1')
         RETURNING id`,
        [ORG, ids.file]
      )
      ids.extractionRun = extraction.rows[0]!.id

      await client.query(
        `INSERT INTO "manual_review_flags"
            (id, organization_id, period_start, period_end, reason, created_by_id, invariant_run_id)
         VALUES (gen_random_uuid(), $1::uuid, '2026-01-01', '2026-12-31',
            'Marca de prueba de la ronda 1: revisión humana pendiente', $3::uuid, $2::uuid)`,
        [ORG, ids.invariantRun, ADMIN]
      )
    })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("BLOQUEA 1 · el orden sale del catálogo, con las aristas entrantes", () => {
    it("las cuatro FK `RESTRICT` desde tablas preservadas están en el plan, leídas de pg_constraint", async () => {
      const tablas = resetModels().map(tableOf)
      const plan = await tenantTransaction(ORG, async (tx) => await deletionOrder(tx, tablas))

      // Lo que el planificador anterior ignoraba por completo.
      expect(retainersOf("fiscal_years", plan)).toContain("invariant_runs")
      expect(retainersOf("fiscal_years", plan)).toContain("closing_runs")
      expect(retainersOf("store_sweeps", plan)).toContain("invariant_runs")
      expect(retainersOf("files", plan)).toContain("extraction_runs")
      expect(plan.cycles).toEqual([])
    })

    it("el plan del catálogo y el que se deriva del esquema coinciden: no hay lista a mano", async () => {
      const tablas = resetModels().map(tableOf)
      const delCatalogo = await tenantTransaction(ORG, async (tx) => await deletionOrder(tx, tablas))
      const edges = await withMaintenance(async (client) =>
        readForeignKeys(async (sql) => (await client.query(sql)).rows)
      )
      expect(planDeletion(tablas, edges).order).toEqual(delCatalogo.order)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("BLOQUEA 1 · `reset-org` sobre una organización SIN asientos pero CON runs", () => {
    it("la enumeración no bloquea y declara lo que se va a retener, con quién lo retiene", async () => {
      const plan = await planResetOrg(ORG)
      expect(plan.blocked).toBeNull()

      const retencion = plan.steps.find((s) => s.label.includes("se RETIENEN"))
      expect(retencion, "el plan no declara la retención: el operador no sabría qué se queda").toBeDefined()
      expect(retencion!.note).toContain("fiscal_years")
      expect(retencion!.note).toContain("invariant_runs")
      expect(retencion!.note).toContain("files")
      expect(retencion!.note).toContain("extraction_runs")
    })

    it("y el reset SE EJECUTA: antes abortaba con 23503 en la organización de demo típica", async () => {
      const resultado = await runResetOrg(ORG, ctx())
      expect(resultado.blocked).toBeNull()

      await withMaintenance(async (client) => {
        const cuenta = async (tabla: string) =>
          Number(
            (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${tabla}" WHERE organization_id = $1::uuid`, [ORG]))
              .rows[0]!.n
          )

        // Las seis de D2 intactas: el barrido, el cierre y la extracción siguen.
        expect(await cuenta("invariant_runs")).toBe(1)
        expect(await cuenta("closing_runs")).toBe(2)
        expect(await cuenta("extraction_runs")).toBe(1)

        // Y lo que ellas señalan se ha RETENIDO, no borrado: sin esto el
        // `DELETE` habría reventado.
        expect(await cuenta("fiscal_years")).toBe(1)
        expect(await cuenta("store_sweeps")).toBe(1)
        expect(await cuenta("files")).toBe(1)

        // La marca de revisión NO es de D2 y sí se vacía.
        expect(await cuenta("manual_review_flags")).toBe(0)
      })
    })

    it("los dos registros cuentan lo borrado Y lo retenido", async () => {
      const plataforma = await prisma.platformAuditLog.findMany({
        where: { organizationId: ORG, action: "admin.reset_org" },
      })
      expect(plataforma).toHaveLength(1)
      const detail = plataforma[0]!.detail as Record<string, unknown>
      const retenidas = detail.retenidas as Record<string, number>
      expect(retenidas["fiscal_years"]).toBe(1)
      expect(retenidas["files"]).toBe(1)
      expect(retenidas["store_sweeps"]).toBe(1)

      const cliente = await tenantTransaction(ORG, async (tx) =>
        tx.auditLog.findMany({ where: { action: "OPERATOR_RESET_ORG" } })
      )
      expect(cliente).toHaveLength(1)
      expect((cliente[0]!.after as Record<string, unknown>).filasRetenidas).toBe(3)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("DEBE #3 · `purgeDerived` usa el MISMO orden topológico", () => {
    it("con un cierre sellado y una marca de revisión, la purga no revienta: retiene y lo declara", async () => {
      // Se vuelve a sembrar lo que el reset retuvo más una marca de revisión
      // manual, que es la otra arista (`manual_review_flags→invariant_runs`).
      await withMaintenance(async (client) => {
        await client.query(
          `INSERT INTO "manual_review_flags"
              (id, organization_id, period_start, period_end, reason, created_by_id, invariant_run_id)
           VALUES (gen_random_uuid(), $1::uuid, '2026-01-01', '2026-12-31',
              'Marca que retiene el barrido durante la purga', $3::uuid, $2::uuid)`,
          [ORG, ids.invariantRun, ADMIN]
        )
        const report = await client.query<{ id: string }>(
          `INSERT INTO "report_runs" (id, organization_id, type, period_start, period_end, fiscal_year_id,
              params, params_hash, ledger_hash, git_sha, result, provenance, validation, seal, duration_ms)
           VALUES (gen_random_uuid(), $1::uuid, 'BALANCE', '2026-01-01', '2026-12-31', $2::uuid,
              '{}'::jsonb, repeat('a',64), repeat('b',64), 'ronda1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
              'VALIDADO_AUTOMATICAMENTE', 1) RETURNING id`,
          [ORG, ids.fiscalYear]
        )
        ids.reportRun = report.rows[0]!.id
      })

      const informe = await withMaintenance(async (client) =>
        purgeDerived(ORG, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
      )

      // El `report_run` —caché pura— se va.
      expect(informe.tables.find((t) => t.table === "report_runs")!.deleted).toBe(1)
      // El barrido NO: lo retienen la marca de revisión y el cierre sellado. Y
      // se dice quién lo retiene, en vez de fallar con 23503 o de borrarlo.
      const retenido = informe.retained.find((r) => r.table === "invariant_runs")
      expect(retenido, "el barrido retenido no aparece en el informe").toBeDefined()
      expect(retenido!.rows).toBe(1)
      expect(retenido!.retainedBy).toContain("manual_review_flags")
      expect(retenido!.retainedBy).toContain("closing_runs")

      // El cierre SELLADO sobrevive —es un sello, no una caché— y el BORRADOR no.
      await withMaintenance(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status::text FROM "closing_runs" WHERE organization_id = $1::uuid`,
          [ORG]
        )
        expect(rows.map((r) => r.status)).toEqual(["CERRADO"])
        expect(rows[0]!.id).toBe(ids.closingSellado)
      })
    })

    it("la MITAD de sellos se ejerce: una columna-sello recomputable se pone a NULL (H-7)", async () => {
      /**
       * **H-7 de la auditoría.** La mitad de `purgeDerived` que pone
       * columnas-sello a `NULL` no la ejercía nada: en el fixture, las filas que
       * las contienen se borran antes (`report_runs`, `invariant_runs`) y el
       * resto de columnas son `NOT NULL`. Aquí se siembra la única que
       * SOBREVIVE y es recomputable —el hash de cadena de una serie de
       * facturación, que se rehace desde sus facturas— y se comprueba que la
       * purga la vacía de verdad.
       */
      await withMaintenance(async (client) => {
        await client.query(
          `INSERT INTO "invoice_series" (id, organization_id, code, kind, prefix, next_number, year, last_hash,
              is_active, created_at, updated_at)
           VALUES (gen_random_uuid(), $1::uuid, 'FR-2026', 'ORDINARIA', 'FR', 7, 2026, repeat('c',64), true, now(), now())
           ON CONFLICT DO NOTHING`,
          [ORG]
        )
      })

      const informe = await withMaintenance(async (client) =>
        purgeDerived(ORG, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
      )
      const sello = informe.seals.find((s) => s.table === "invoice_series" && s.column === "last_hash")
      expect(sello, "«invoice_series.last_hash» no aparece en el informe de sellos").toBeDefined()
      expect(sello!.error).toBeUndefined()
      expect(sello!.nulled, "la columna-sello NO se ha puesto a NULL: la mitad de sellos sigue sin ejercerse").toBe(1)
      expect(informe.totalNulled).toBeGreaterThan(0)

      await withMaintenance(async (client) => {
        const { rows } = await client.query<{ last_hash: string | null }>(
          `SELECT last_hash FROM invoice_series WHERE organization_id = $1::uuid AND code = 'FR-2026'`,
          [ORG]
        )
        expect(rows[0]!.last_hash).toBeNull()
      })
    })

    it("el informe distingue «no había nada que anular» de «el UPDATE falló», y las NOT NULL se saltan (H-7)", async () => {
      const informe = await withMaintenance(async (client) =>
        purgeDerived(ORG, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
      )
      expect(informe.sealErrors, `columnas-sello con error: ${JSON.stringify(informe.seals.filter((s) => s.error))}`).toBe(0)
      for (const sello of informe.seals) {
        expect(sello.error, `${sello.table}.${sello.column}`).toBeUndefined()
      }
      // Y la mitad de sellos existe de verdad: hay columnas que mirar, y las
      // que no admiten NULL se saltan DECLARÁNDOLO en vez de fallar en silencio.
      expect(informe.seals.length).toBeGreaterThan(0)
      expect(informe.sealSkipped, "ninguna columna-sello NOT NULL declarada: el filtro no está mirando").toBeGreaterThan(0)
      for (const saltada of informe.seals.filter((s) => s.skipped)) {
        expect(saltada.skipped).toContain("NOT NULL")
      }
    })

    it("todas las tablas del registro tienen su entrada en el informe: ninguna se salta", async () => {
      const informe = await withMaintenance(async (client) =>
        purgeDerived(ORG, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
      )
      const enElInforme = informe.tables.map((t) => t.table).sort()
      const esperadas = derivedTables(prismaSchemaMeta())
        .map((t) => t.table)
        .sort()
      expect(enElInforme).toEqual(esperadas)
    })
  })
})
