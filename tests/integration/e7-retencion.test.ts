/**
 * E7 · T15 — Los dos scripts de operador de ADR-0015 **D3** y **D4**, contra
 * Postgres de verdad.
 *
 *  · `scripts/prune-runs.ts` — la política de retención, y sobre todo la
 *    **protección del `File` del extracto**: art. 30 CCom obliga a conservar los
 *    justificantes seis años (diez con bases imponibles negativas, art. 26.5
 *    LIS), y los soportes de la conciliación bancaria lo son. Un `File`
 *    referenciado por un `BankStatement` no se borra NUNCA.
 *  · `scripts/migrate-cashflow-report-type.ts` — la unificación de `CASHFLOW`,
 *    con **la comprobación que da sentido a la tarea**: los `ReportRun`
 *    migrados conservan un `paramsHash` CANÓNICO, el que la función de la
 *    aplicación calcula sobre sus `params` nuevos. Si el script hubiera
 *    reimplementado el sha256 en SQL, esta comprobación fallaría — que es
 *    exactamente la deriva que ADR-0011 corrigió.
 *
 * Los dos conectan como `app_maintenance` (BYPASSRLS): recorren varias
 * organizaciones y con `app_runtime` verían 0 filas en silencio.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { paramsHash } from "@/lib/ledger/report-run"
import { appMaintenanceDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const OWNER_URL = TEST_DATABASE_URL || ownerDatabaseUrl()

const ORG = "e7d00000-0000-4000-8000-00000000000a"
const USER = "e7d00000-0000-4000-8000-0000000000a1"
const FILE = "e7d00000-0000-4000-8000-0000000000f1"

let client: Client
let disponible = false

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

const SHA = (c: string) => c.repeat(64)

/** Un `ReportRun` con la antigüedad que se le diga. */
async function newReportRun(type: string, createdAt: string, params: Record<string, unknown>): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO report_runs
       (id, organization_id, type, period_start, period_end, params, params_hash, ledger_hash,
        git_sha, result, provenance, validation, seal, duration_ms, created_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::report_type, '2026-01-01', '2026-03-31', $3::jsonb, $4,
             $5, 'sha', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'VALIDADO_AUTOMATICAMENTE', 1, $6::timestamp)
     RETURNING id`,
    [ORG, type, JSON.stringify(params), paramsHash(params), SHA("1"), createdAt]
  )
  return row.id
}

/**
 * Un `ReportRun` HISTÓRICO con uno de los dos tipos viejos. El CHECK que la
 * migración M2 dejó es `NOT VALID`: no mira las filas que ya estaban, pero sí
 * rechaza las nuevas. Para fabricar el caso real —filas anteriores al CHECK— se
 * retira y se vuelve a poner tal cual, `NOT VALID` incluido.
 */
async function newLegacyRun(type: string, createdAt: string, params: Record<string, unknown>): Promise<string> {
  await q(`ALTER TABLE report_runs DROP CONSTRAINT report_runs_no_cashflow_legacy`)
  try {
    return await newReportRun(type, createdAt, params)
  } finally {
    await q(
      `ALTER TABLE report_runs ADD CONSTRAINT report_runs_no_cashflow_legacy
         CHECK (type NOT IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')) NOT VALID`
    )
  }
}

/** Ídem para `manual_review_flags.scope`. */
async function newLegacyFlag(scope: string): Promise<void> {
  await q(`ALTER TABLE manual_review_flags DROP CONSTRAINT manual_review_flags_no_cashflow_legacy`)
  try {
    await q(
      `INSERT INTO manual_review_flags
         (id, organization_id, period_start, period_end, scope, reason, created_by_id)
       VALUES (gen_random_uuid(), $1::uuid, '2025-01-01', '2025-03-31', $3::report_type,
               'revisión pendiente del cashflow de 2025', $2::uuid)`,
      [ORG, USER, scope]
    )
  } finally {
    await q(
      `ALTER TABLE manual_review_flags ADD CONSTRAINT manual_review_flags_no_cashflow_legacy
         CHECK (scope IS NULL OR scope NOT IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')) NOT VALID`
    )
  }
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  process.env.DATABASE_URL_MAINTENANCE ||= appMaintenanceDatabaseUrl(OWNER_URL)
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  await limpiar()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e7-retencion@test.local', 'E7', now(), now())`,
    [USER]
  )
  await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e7-retencion', 'E7 D3/D4', now())`, [
    ORG,
  ])
  await q(
    `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, '5720', 'Banco c/c', 4, 'DEUDORA', true, true, now())`,
    [ORG]
  )
  // El fichero del extracto: el que NUNCA se purga (O-22).
  await q(
    `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'marzo.n43', 'marzo.n43', 'text/plain', $4, 10)`,
    [FILE, ORG, USER, SHA("f")]
  )
  const [account] = await q<{ id: string }>(
    `INSERT INTO bank_accounts (id, organization_id, code, name, account_code, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'BBVA', 'BBVA', '5720', now()) RETURNING id`,
    [ORG]
  )
  await q(
    `INSERT INTO bank_statements
       (id, organization_id, bank_account_id, format, file_sha256, file_name, file_id, currency,
        period_start, period_end, opening_balance_cents, closing_balance_cents)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'N43', $3, 'marzo.n43', $4::uuid, 'EUR',
             '2026-03-01', '2026-03-31', 0, 0)`,
    [ORG, account.id, SHA("a"), FILE]
  )
  disponible = true
})

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  await limpiar().catch(() => undefined)
  await client.end()
})

async function limpiar() {
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG]).catch(() => undefined)
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · D3 — retención de runs (`scripts/prune-runs.ts`)", () => {
  it("**O-22 · el `File` de un extracto está protegido y el script lo declara**", async () => {
    expect(disponible).toBe(true)
    const { comprobarFicherosDeExtracto } = await import("@/scripts/prune-runs")
    const protegidos = await comprobarFicherosDeExtracto(client, ORG)
    expect(protegidos).toEqual([FILE])
  })

  it("O-22 · y la base lo repite: borrar ese `File` es imposible (FK RESTRICT)", async () => {
    await expect(q(`DELETE FROM files WHERE id = $1::uuid`, [FILE])).rejects.toMatchObject({ code: "23503" })
  })

  it("conserva 24 meses, el último de cada tipo y mes histórico, y purga el resto", async () => {
    const { pruneRuns } = await import("@/scripts/prune-runs")
    // Dos runs de BALANCE del mismo mes histórico (2023-01) y uno reciente.
    const viejoA = await newReportRun("BALANCE", "2023-01-10", { snapshot: "PRE_REGULARIZACION", n: 1 })
    const viejoB = await newReportRun("BALANCE", "2023-01-20", { snapshot: "PRE_REGULARIZACION", n: 2 })
    const reciente = await newReportRun("BALANCE", "2026-05-01", { snapshot: "PRE_REGULARIZACION", n: 3 })

    const simulacion = await pruneRuns({ org: ORG, refDate: "2026-06-01" })
    expect(simulacion.apply).toBe(false)
    expect(simulacion.reportRuns).toBe(1) // sólo `viejoA`: de enero de 2023 sobrevive el último
    // Simulación: no ha borrado nada.
    expect(await q(`SELECT id FROM report_runs WHERE id = $1::uuid`, [viejoA])).toHaveLength(1)

    const aplicado = await pruneRuns({ org: ORG, refDate: "2026-06-01", apply: true })
    expect(aplicado.reportRuns).toBe(1)
    expect(await q(`SELECT id FROM report_runs WHERE id = $1::uuid`, [viejoA])).toHaveLength(0)
    expect(await q(`SELECT id FROM report_runs WHERE id = $1::uuid`, [viejoB])).toHaveLength(1)
    expect(await q(`SELECT id FROM report_runs WHERE id = $1::uuid`, [reciente])).toHaveLength(1)
  })

  it("`report_runs` vuelve a FORCE después de purgar (ninguna tabla se queda abierta)", async () => {
    const [row] = await q<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'report_runs'`
    )
    expect(row.relforcerowsecurity).toBe(true)
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E7 · D4 — unificación de `CASHFLOW`", () => {
  it("**los `ReportRun` migrados conservan un `paramsHash` CANÓNICO**", async () => {
    const { migrateCashflowReportType, MARKER_CODE } = await import("@/scripts/migrate-cashflow-report-type")

    // Dos runs con los tipos viejos. El CHECK es `NOT VALID`, así que las filas
    // históricas siguen entrando: es exactamente el caso que el script migra.
    const directo = await newLegacyRun("CASHFLOW_DIRECTO", "2026-05-02", {
      granularity: "MENSUAL",
      view: "GESTION",
    })
    const indirecto = await newLegacyRun("CASHFLOW_INDIRECTO", "2026-05-03", {
      granularity: "ANUAL",
      view: "GESTION",
    })

    const aplicado = await migrateCashflowReportType({ org: ORG, apply: true })
    expect(aplicado.runs).toBe(2)
    expect(aplicado.colisiones).toBe(0)

    const rows = await q<{ id: string; type: string; params: Record<string, unknown>; params_hash: string }>(
      `SELECT id, type::text AS type, params, params_hash FROM report_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[directo, indirecto]]
    )
    expect(rows.map((r) => r.type)).toEqual(["CASHFLOW", "CASHFLOW"])
    // El método que el TIPO declaraba se conserva como PARÁMETRO.
    expect(rows[0].params.method).toBe("DIRECTO")
    expect(rows[1].params.method).toBe("INDIRECTO")
    // …y el hash es el que la función de la APLICACIÓN calcula sobre esos
    // `params`. Es la comprobación que da sentido a hacerlo en TypeScript y no
    // en PL/pgSQL: dos implementaciones del mismo sha256 acabarían divergiendo.
    for (const row of rows) {
      expect(row.params_hash).toBe(paramsHash(row.params))
    }
    // Y los dos métodos dan claves DISTINTAS: el parámetro discrimina igual que
    // discriminaba el tipo, que es lo único que había que preservar.
    expect(rows[0].params_hash).not.toBe(rows[1].params_hash)

    // La marca queda cerrada, y se escribió ANTES del backfill.
    const [marca] = await q<{ value: string }>(`SELECT value FROM settings WHERE organization_id = $1::uuid AND code = $2`, [
      ORG,
      MARKER_CODE,
    ])
    expect(marca.value).toBe("DONE:2")
  })

  it("`ManualReviewFlag.scope` se reapunta al tipo unificado", async () => {
    const { migrateCashflowReportType } = await import("@/scripts/migrate-cashflow-report-type")
    await newLegacyFlag("CASHFLOW_INDIRECTO")
    const report = await migrateCashflowReportType({ org: ORG, apply: true })
    expect(report.flags).toBe(1)
    const [flag] = await q<{ scope: string }>(
      `SELECT scope::text AS scope FROM manual_review_flags WHERE organization_id = $1::uuid`,
      [ORG]
    )
    expect(flag.scope).toBe("CASHFLOW")
  })

  it("después de migrar, un run NUEVO con el tipo viejo ya no entra", async () => {
    await expect(newReportRun("CASHFLOW_DIRECTO", "2026-05-04", { granularity: "MENSUAL" })).rejects.toMatchObject({
      code: "23514",
    })
  })
})
