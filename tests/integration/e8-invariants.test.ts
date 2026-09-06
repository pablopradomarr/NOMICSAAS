/**
 * E8 · T14 — Los invariantes documentales contra Postgres de verdad, con el
 * error **inyectado por SQL**.
 *
 * Por qué por SQL y no por la aplicación: los invariantes existen justamente
 * para el caso en que alguien toca la base por fuera —una migración a mano, un
 * script de soporte, un `UPDATE` en la consola—. Un test que corrompe el estado
 * llamando a la propia aplicación comprueba la aplicación, no el invariante.
 *
 * Las tres corrupciones son las que la tarea nombra y las que un auditor
 * intentaría primero:
 *
 *  1. **Run editado**: `reconcile_status` pasa a `FAIL` con el asiento ya
 *     contabilizado. I-E8-1 lo ve.
 *  2. **sha256 alterado**: los bytes del fichero dejan de ser los que vio la
 *     extracción. I-E8-2 lo ve, y el periodo se sella `DOCUMENTO_ALTERADO`.
 *  3. **`POSTED` sin asiento**: se borra el `journal_entry_id` dejando el
 *     estado. I-E8-4 lo ve —y el `CHECK` de D1 debería haberlo impedido, así
 *     que el test comprueba **las dos** barreras.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  checkIE81,
  checkIE82,
  checkIE84,
  checkIE815a,
  ivaPeriodOf,
  vatBookRowFromProposal,
  type BookableProposal,
  type DocumentsInvariantInput,
} from "@/lib/ledger/invariants"
import type { PostedEntry } from "@/lib/ledger/types"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e8000000-0000-4000-8000-0000000000b0"
const USER = "e8000000-0000-4000-8000-0000000000b1"
const FILE = "e8000000-0000-4000-8000-0000000000b2"
const SHA = "a".repeat(64)

let client: Client
let runId = ""
let entryId = ""
let transactionId = ""
let fiscalYearId = ""

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await client.query<T>(sql, params)
  return result.rows
}

/** La propuesta que se sella en el run: el caso C01 del fixture de T8. */
const PROPOSAL: BookableProposal = {
  docKind: "FACTURA_RECIBIDA",
  lines: [{ kind: "OPERACION", baseCents: 100000, taxRateCode: "IVA_21", deductibility: "FULL" }],
  taxes: [{ taxRateCode: "IVA_21", baseCents: 100000, quotaCents: 21000 }],
}

/**
 * Borrado explícito y en orden: `journal_lines → journal_entries` es
 * `ON DELETE RESTRICT` a propósito (un asiento no se borra, se anula), así que
 * el `CASCADE` de la organización no basta. Aquí sí se borra porque son datos
 * de prueba, no un diario.
 */
async function cleanup(): Promise<void> {
  for (const sql of [
    `DELETE FROM journal_lines WHERE organization_id = $1::uuid`,
    `DELETE FROM transactions WHERE organization_id = $1::uuid`,
    `DELETE FROM journal_entries WHERE organization_id = $1::uuid`,
    `DELETE FROM extraction_runs WHERE organization_id = $1::uuid`,
    `DELETE FROM files WHERE organization_id = $1::uuid`,
    `DELETE FROM organizations WHERE id = $1::uuid`,
  ]) {
    await q(sql, [ORG]).catch(() => undefined)
  }
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  await cleanup()

  // La siembra va en UNA transacción: el trigger de partida doble de E3 es
  // DIFERIDO y se comprueba al COMMIT, así que insertar el asiento y sus
  // líneas en autocommit fallaría por un estado intermedio que nunca existe.
  await q("BEGIN")
  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e8-invariantes@test.local', 'E8', now(), now())`,
    [USER]
  )
  await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e8-inv-org', 'E8 inv', now())`, [ORG])
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now())`,
    [ORG, USER]
  )
  const [fy] = await q<{ id: string }>(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now()) RETURNING id`,
    [ORG]
  )
  fiscalYearId = fy.id
  await q(
    `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'f.pdf', 'f.pdf', 'application/pdf', $4, 100)`,
    [FILE, ORG, USER, SHA]
  )
  const [run] = await q<{ id: string }>(
    `INSERT INTO extraction_runs
       (id, organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
        prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, proposal,
        reconcile, reconcile_status, duration_ms, git_sha)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'LLM', 'openai', 'gpt', 'extraccion', 'GIT',
             repeat('b', 64), '1', repeat('c', 64), 1, 1, '{}'::jsonb, $4::jsonb,
             $5::jsonb, 'PASS', 120, 'abc1234')
     RETURNING id`,
    [ORG, FILE, SHA, JSON.stringify(PROPOSAL), JSON.stringify({ status: "PASS", checks: [], sellos: [] })]
  )
  runId = run.id

  const [entry] = await q<{ id: string }>(
    `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date, reception_date,
        description, posted_by_id, entry_hash, hash_version, file_id, extraction_run_id, source_type)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '2026-03-28', '2026-03-28', '2026-05-04',
             'Factura recibida F-2026-0001', $3::uuid, repeat('0', 64), 3, $4::uuid, $5::uuid, 'INVOICE_IN')
     RETURNING id`,
    [ORG, fiscalYearId, USER, FILE, runId]
  )
  entryId = entry.id

  // El asiento lleva sus líneas: el trigger DIFERIDO de partida doble de E3 se
  // comprueba al COMMIT, y un asiento sin líneas no llega ni a existir.
  for (const [lineNo, code, debit, credit] of [
    [1, "607", 100000, 0],
    [2, "472", 21000, 0],
    [3, "400", 0, 121000],
  ] as [number, string, number, number][]) {
    await q(
      `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, origin, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, 3, 'DEUDORA', true, true, 'SEED', now())
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [ORG, code, `Cuenta ${code}`]
    )
    await q(
      `INSERT INTO journal_lines
         (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          entry_date, fiscal_year_id, entry_kind)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, '2026-03-28', $7::uuid, 'NORMAL')`,
      [ORG, entryId, lineNo, code, debit, credit, fiscalYearId]
    )
  }

  const [tx] = await q<{ id: string }>(
    `INSERT INTO transactions (id, organization_id, name, status, total, currency_code, journal_entry_id,
                               extraction_run_id, files, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'F-2026-0001', 'POSTED', 121000, 'EUR', $2::uuid,
             $3::uuid, $4::jsonb, now())
     RETURNING id`,
    [ORG, entryId, runId, JSON.stringify([FILE])]
  )
  transactionId = tx.id
  await q("COMMIT")
})

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  await cleanup()
  await client.end()
})

/**
 * Lee de la BASE lo que el bloque documental necesita. Deliberadamente por SQL
 * directo y no por `models/ledger.ts`: si el lector y el invariante compartieran
 * camino, una corrupción invisible para el lector sería invisible para el
 * invariante.
 */
async function readInput(): Promise<{ input: DocumentsInvariantInput; entries: PostedEntry[] }> {
  const runs = await q<{
    id: string
    file_id: string
    file_sha256: string
    kind: "LLM" | "MANUAL" | "IMPORTED"
    partial: boolean
    reconcile_status: "PASS" | "WARN" | "FAIL" | null
    prompt_sha: string
    provider: string
  }>(
    `SELECT id, file_id, file_sha256, kind, partial, reconcile_status, prompt_sha, provider
       FROM extraction_runs WHERE organization_id = $1::uuid`,
    [ORG]
  )
  const files = await q<{ id: string; sha256: string | null }>(
    `SELECT id, sha256 FROM files WHERE organization_id = $1::uuid`,
    [ORG]
  )
  const transactions = await q<{
    id: string
    status: "DRAFT" | "PROPOSED" | "POSTED" | "VOID"
    journal_entry_id: string | null
    voided_entry_id: string | null
    currency_code: string | null
    total: number | null
    extraction_run_id: string | null
  }>(
    `SELECT id, status, journal_entry_id, voided_entry_id, currency_code, total, extraction_run_id
       FROM transactions WHERE organization_id = $1::uuid`,
    [ORG]
  )
  const entryRows = await q<{
    id: string
    entry_number: number
    entry_date: Date
    document_date: Date | null
    reception_date: Date | null
    file_id: string | null
    extraction_run_id: string | null
  }>(
    `SELECT id, entry_number, entry_date, document_date, reception_date, file_id, extraction_run_id
       FROM journal_entries WHERE organization_id = $1::uuid`,
    [ORG]
  )

  const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10))
  const entries: PostedEntry[] = entryRows.map((e) => ({
    id: e.id,
    organizationId: ORG,
    fiscalYearId,
    entryNumber: e.entry_number,
    documentDate: iso(e.document_date),
    accrualDate: null,
    entryDate: iso(e.entry_date) as string,
    receptionDate: iso(e.reception_date),
    description: "Factura recibida F-2026-0001",
    kind: "NORMAL",
    taxRoundingMode: "PER_TIPO",
    sourceType: "INVOICE_IN",
    fileId: e.file_id,
    extractionRunId: e.extraction_run_id,
    lines: [],
  }))

  const documentDate = entries[0]?.documentDate ?? "2026-03-28"
  const receptionDate = entries[0]?.receptionDate ?? null
  const input: DocumentsInvariantInput = {
    runs: runs.map((r) => ({
      id: r.id,
      fileId: r.file_id,
      fileSha256: r.file_sha256,
      kind: r.kind,
      partial: r.partial,
      reconcileStatus: r.reconcile_status,
      promptSha: r.prompt_sha,
      provider: r.provider,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      status: t.status,
      journalEntryId: t.journal_entry_id,
      voidedEntryId: t.voided_entry_id,
      fileId: FILE,
      splitParentTransactionId: null,
      currency: t.currency_code ?? "EUR",
      totalCents: t.total ?? 0,
      convertedTotalCents: null,
      exchangeRateMicro: null,
      rateDate: null,
      rateSource: null,
      extractionRunId: t.extraction_run_id,
    })),
    files: files.map((f) => ({ id: f.id, sha256: f.sha256, diskSha256: f.sha256 })),
    vatBook: entries.map((e) =>
      vatBookRowFromProposal(PROPOSAL, {
        entryId: e.id,
        ivaPeriod: ivaPeriodOf(e.receptionDate ?? null, documentDate),
        documentDate,
        deductionDate: receptionDate ?? documentDate,
        prorrataBps: null,
      })
    ),
    vatBalances: [{ ivaPeriod: ivaPeriodOf(receptionDate, documentDate), saldo472Cents: 21000, saldo477Cents: 0 }],
    withholdings: [],
    exchangeRates: [],
    invoiceSeries: [],
    duplicates: [],
    accounts: { inputVat: "472", outputVat: "477", withholding: "4751" },
  }
  return { input, entries }
}

describe.skipIf(!TEST_DATABASE_URL)("E8 · T14 — invariantes con el error inyectado por SQL", () => {
  it("el estado limpio pasa I-E8-1, 2, 4 y el puente 15a", async () => {
    const { input, entries } = await readInput()
    expect(checkIE81(entries, input.runs).status).toBe("PASS")
    expect(checkIE82(input, entries).status).toBe("PASS")
    expect(checkIE84(input).status).toBe("PASS")
    expect(checkIE815a(input).status).toBe("PASS")
    // El periodo de IVA es el de la RECEPCIÓN (2T), no el del asiento (1T).
    expect(input.vatBook[0].ivaPeriod).toBe("2026-Q2")
  })

  it("run editado por SQL a FAIL ⇒ I-E8-1 delata el asiento sin respaldo", async () => {
    await q(`UPDATE extraction_runs SET reconcile_status = 'FAIL' WHERE id = $1::uuid`, [runId])
    const { input, entries } = await readInput()
    const result = checkIE81(entries, input.runs)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("FAIL")
    await q(`UPDATE extraction_runs SET reconcile_status = 'PASS' WHERE id = $1::uuid`, [runId])
    const { input: restored, entries: e2 } = await readInput()
    expect(checkIE81(e2, restored.runs).status).toBe("PASS")
  })

  it("sha256 alterado por SQL ⇒ I-E8-2 delata el documento cambiado", async () => {
    await q(`UPDATE files SET sha256 = $2 WHERE id = $1::uuid`, [FILE, "d".repeat(64)])
    const { input, entries } = await readInput()
    const result = checkIE82(input, entries)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("documento alterado")
    await q(`UPDATE files SET sha256 = $2 WHERE id = $1::uuid`, [FILE, SHA])
    const { input: restored, entries: e2 } = await readInput()
    expect(checkIE82(restored, e2).status).toBe("PASS")
  })

  it("POSTED sin asiento: lo impide el CHECK de D1 **y** lo delata I-E8-4", async () => {
    // Primera barrera: la BASE. El CHECK de ADR-0014 D1 rechaza el UPDATE.
    await expect(
      q(`UPDATE transactions SET journal_entry_id = NULL WHERE id = $1::uuid`, [transactionId])
    ).rejects.toThrow(/transactions_status_entry_chk|check constraint|violates/i)

    // Segunda barrera: el invariante, por si alguien desactivara el CHECK. Se
    // simula el estado imposible sobre los datos ya leídos, que es exactamente
    // lo que el auditor vería si la barrera de la base no estuviera.
    const { input, entries } = await readInput()
    const corrupted = { ...input, transactions: input.transactions.map((t) => ({ ...t, journalEntryId: null })) }
    const result = checkIE84(corrupted)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("POSTED sin asiento")
    expect(entries).toHaveLength(1)
  })

  it("el asiento referencia su fichero y su extracción: sin eso no hay trazabilidad", async () => {
    const { entries } = await readInput()
    expect(entries[0].fileId).toBe(FILE)
    expect(entries[0].extractionRunId).toBe(runId)
  })
})
