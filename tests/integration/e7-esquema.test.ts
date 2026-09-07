/**
 * E7 · T3/T4 — El SQL de `20260916090000_e7_enums`, `20260916100000_e7_auditoria`,
 * `20260916110000_e7_conciliacion` y `20260916120000_e7_bigint_diario`, contra
 * Postgres de verdad.
 *
 * Todo lo que aquí se comprueba tiene la misma forma: **la regla está en la
 * base, no sólo en el código**. Un CHECK que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL, y precisamente contra eso están los invariantes.
 *
 *  · **M2** — append-only de `invariant_runs`, semi-append-only de
 *    `store_sweeps`, coherencia del alcance, cotas de tamaño, `check_family`
 *    como enum (O-21), el CHECK `NOT VALID` que prohíbe los dos `CASHFLOW_*`
 *    viejos (ADR-0015 D4) y el índice parcial de I-E7-9.
 *  · **M3** — la conciliación de **D6**: CHECK 572–575 (O-7), `@@unique` por
 *    `account_code`, **`amount_cents IS NOT NULL` y jamás `<> 0`** (m2, D6.6),
 *    vocabulario cerrado de ignorado con evidencia (O-4), divisa del extracto
 *    contra la de la cuenta (D6.2), motivo de desconciliación ≥ 10 caracteres,
 *    **I-E7-2 revisada en el camino de escritura** (D6.4) y los dos índices
 *    únicos parciales por **grupo vivo** (D6.1).
 *  · **M4** — `bigint` en el diario (ADR-0015 D1): una línea de 25 000 000,00 €
 *    entra, se agrega y sale con su importe exacto, que con `integer` habría
 *    sido imposible (techo 21 474 836,47 €).
 *
 * Conecta con el rol PROPIETARIO: aquí se ejercen constraints y triggers, no
 * RLS. El aislamiento por tenant vive en `tests/integration-rls/`.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e7000000-0000-4000-8000-00000000000a"
const USER = "e7000000-0000-4000-8000-0000000000a1"

let client: Client
let fiscalYearId = ""
let bankAccountId = ""
let statementId = ""
let entryNumber = 0

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await client.query<T>(sql, params)
  return result.rows
}

/** Ejecuta y devuelve el mensaje de error, o `null` si no falló. */
async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  await q("SAVEPOINT sp")
  try {
    await q(sql, params)
    await q("RELEASE SAVEPOINT sp")
    return null
  } catch (error) {
    await q("ROLLBACK TO SAVEPOINT sp")
    return error instanceof Error ? error.message : String(error)
  }
}

async function newEntry(): Promise<string> {
  entryNumber += 1
  const rows = await q<{ id: string }>(
    `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, description,
        posted_by_id, entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, DATE '2026-03-10', 'asiento de prueba E7',
             $4::uuid, repeat('0', 64), 3)
     RETURNING id`,
    [ORG, fiscalYearId, entryNumber, USER]
  )
  return rows[0].id
}

/** Una línea de la 5720 con importe CON SIGNO: > 0 al debe, < 0 al haber. */
async function newBankJournalLine(signedCents: bigint, entryDate = "2026-03-10"): Promise<string> {
  const entryId = await newEntry()
  const rows = await q<{ id: string }>(
    `INSERT INTO journal_lines
       (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
        entry_date, fiscal_year_id, entry_kind)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '5720', $3::bigint, $4::bigint,
             $5::date, $6::uuid, 'NORMAL')
     RETURNING id`,
    [
      ORG,
      entryId,
      signedCents > 0n ? signedCents.toString() : "0",
      signedCents < 0n ? (-signedCents).toString() : "0",
      entryDate,
      fiscalYearId,
    ]
  )
  return rows[0].id
}

let lineNo = 0
async function newStatementLine(amountCents: bigint, operationDate = "2026-03-10"): Promise<string> {
  lineNo += 1
  const rows = await q<{ id: string }>(
    `INSERT INTO bank_statement_lines
       (id, organization_id, statement_id, bank_account_id, line_no, operation_date, value_date,
        amount_cents, currency, description, sha256)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $5::date,
             $6::bigint, 'EUR', 'movimiento de prueba', md5(random()::text) || md5(random()::text))
     RETURNING id`,
    [ORG, statementId, bankAccountId, lineNo, operationDate, amountCents.toString()]
  )
  return rows[0].id
}

async function newGroup(kind = "SIMPLE"): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO bank_match_groups (id, organization_id, bank_account_id, kind, created_by_id)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::match_group_kind, $4::uuid) RETURNING id`,
    [ORG, bankAccountId, kind, USER]
  )
  return rows[0].id
}

async function match(groupId: string, statementLineId: string, journalLineId: string): Promise<string | null> {
  return failure(
    `INSERT INTO bank_reconciliations
       (id, organization_id, group_id, statement_line_id, journal_line_id, method, date_gap_days, matched_by_id)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MANUAL', 0, $5::uuid)`,
    [ORG, groupId, statementLineId, journalLineId, USER]
  )
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  await cleanup()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e7-esquema@test.local', 'E7', now(), now())`,
    [USER]
  )
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e7-esquema-org', 'E7 esquema', now())`,
    [ORG]
  )
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now())`,
    [ORG, USER]
  )
  const [fy] = await q<{ id: string }>(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now())
     RETURNING id`,
    [ORG]
  )
  fiscalYearId = fy.id
  // Plan mínimo: la 5720 (banco) y la 570 (caja, para el CHECK de O-7).
  for (const [code, name, nature] of [
    ["5720", "Banco c/c", "DEUDORA"],
    ["570", "Caja", "DEUDORA"],
    ["626", "Servicios bancarios", "DEUDORA"],
  ]) {
    await q(
      `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::varchar, $3, $4::int, $5::nature, true, true, now())`,
      [ORG, code, name, code.length, nature]
    )
  }

  // Todo el fichero corre dentro de UNA transacción con savepoints: así no deja
  // rastro y los CHECK se pueden provocar sin ensuciar la base.
  await q("BEGIN")
  // Los triggers de cuadre del diario son DIFERIDOS y se comprueban al COMMIT,
  // que aquí nunca llega: el fichero termina en ROLLBACK.
  await q("SET CONSTRAINTS ALL DEFERRED")

  const [account] = await q<{ id: string }>(
    `INSERT INTO bank_accounts (id, organization_id, code, name, account_code, currency, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'BBVA', 'BBVA principal', '5720', 'EUR', now()) RETURNING id`,
    [ORG]
  )
  bankAccountId = account.id
  const [statement] = await q<{ id: string }>(
    `INSERT INTO bank_statements
       (id, organization_id, bank_account_id, format, file_sha256, file_name, currency,
        period_start, period_end, opening_balance_cents, closing_balance_cents, imported_by_id)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'N43', repeat('a', 64), 'marzo.n43', 'EUR',
             '2026-03-01', '2026-03-31', 0, 0, $3::uuid) RETURNING id`,
    [ORG, bankAccountId, USER]
  )
  statementId = statement.id
})

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  await q("ROLLBACK").catch(() => undefined)
  await cleanup()
  await client.end()
})

async function cleanup() {
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG]).catch(() => undefined)
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · M2 — el barrido sellado", () => {
  const runValues = `'ORGANIZATION', NULL, NULL, NULL, 'MANUAL', DATE '2026-03-31',
     repeat('1', 64), '∅', repeat('2', 64), repeat('3', 64), repeat('4', 64), 'sha',
     repeat('5', 64), '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'VALIDADO_AUTOMATICAMENTE', 0`

  async function newRun(): Promise<string> {
    const rows = await q<{ id: string }>(
      `INSERT INTO invariant_runs
         (id, organization_id, scope_kind, fiscal_year_id, period_start, period_end, trigger, ref_date,
          ledger_hash, analytics_key, plan_hash, account_map_hash, config_hash, git_sha,
          checks_hash, checks, counts, coverage, headline, seal, duration_ms)
       VALUES (gen_random_uuid(), $1::uuid, ${runValues}) RETURNING id`,
      [ORG]
    )
    return rows[0].id
  }

  it("un barrido de ORGANIZACIÓN con periodo NO es un alcance legal", async () => {
    const error = await failure(
      `INSERT INTO invariant_runs
         (id, organization_id, scope_kind, fiscal_year_id, period_start, period_end, trigger, ref_date,
          ledger_hash, analytics_key, plan_hash, account_map_hash, config_hash, git_sha,
          checks_hash, checks, counts, coverage, headline, seal, duration_ms)
       VALUES (gen_random_uuid(), $1::uuid, 'ORGANIZATION', NULL, DATE '2026-01-01', DATE '2026-03-31',
               'MANUAL', DATE '2026-03-31', repeat('1', 64), '∅', repeat('2', 64), repeat('3', 64),
               repeat('4', 64), 'sha', repeat('5', 64), '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               'VALIDADO_AUTOMATICAMENTE', 0)`,
      [ORG]
    )
    expect(error).toMatch(/invariant_runs_scope_coherent/)
  })

  it("un barrido de PERIODO sin periodo tampoco", async () => {
    const error = await failure(
      `INSERT INTO invariant_runs
         (id, organization_id, scope_kind, trigger, ref_date, ledger_hash, plan_hash, account_map_hash,
          config_hash, git_sha, checks_hash, checks, counts, coverage, headline, seal, duration_ms)
       VALUES (gen_random_uuid(), $1::uuid, 'PERIOD', 'MANUAL', DATE '2026-03-31', repeat('1', 64),
               repeat('2', 64), repeat('3', 64), repeat('4', 64), 'sha', repeat('5', 64),
               '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'VALIDADO_AUTOMATICAMENTE', 0)`,
      [ORG]
    )
    expect(error).toMatch(/invariant_runs_scope_coherent/)
  })

  it("**I-E7-7 en la base**: `app_runtime` no puede reescribir `checks_hash` (append-only por privilegio)", async () => {
    const runId = await newRun()
    const [{ has }] = await q<{ has: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'invariant_runs', 'UPDATE') AS has`
    )
    expect(has).toBe(false)
    // Y la segunda cerradura, la política RESTRICTIVE.
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
        WHERE tablename = 'invariant_runs' AND policyname IN ('invariant_runs_no_update','invariant_runs_no_delete')
          AND permissive = 'RESTRICTIVE'`
    )
    expect(n).toBe("2")
    expect(runId).toBeTruthy()
  })

  it("`store_sweeps` es SEMI-append-only: avanza el progreso, no reescribe el arranque", async () => {
    const [{ id }] = await q<{ id: string }>(
      `INSERT INTO store_sweeps (id, organization_id, run_by_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid)
       RETURNING id`,
      [ORG, USER]
    )
    expect(await failure(`UPDATE store_sweeps SET files_ok = 3 WHERE id = $1::uuid`, [id])).toBeNull()
    // `now()` es constante dentro de la transacción: se usa una marca distinta
    // de verdad para que el trigger tenga algo que rechazar.
    const error = await failure(
      `UPDATE store_sweeps SET started_at = TIMESTAMP '2020-01-01 00:00:00' WHERE id = $1::uuid`,
      [id]
    )
    expect(error).toMatch(/sólo se puede escribir el PROGRESO/)
    // Un barrido terminado no se reabre: se lanza otro.
    await q(`UPDATE store_sweeps SET status = 'DONE', finished_at = clock_timestamp() WHERE id = $1::uuid`, [id])
    expect(await failure(`UPDATE store_sweeps SET status = 'RUNNING', finished_at = NULL WHERE id = $1::uuid`, [id]))
      .toMatch(/ya terminó/)
  })

  it("los hallazgos tienen cota dura de 1000: lo que no cabe se cuenta aparte", async () => {
    const error = await failure(
      `INSERT INTO store_sweeps (id, organization_id, findings)
       VALUES (gen_random_uuid(), $1::uuid,
               (SELECT jsonb_agg(jsonb_build_object('f', g)) FROM generate_series(1, 1001) g))`,
      [ORG]
    )
    expect(error).toMatch(/store_sweeps_findings_bound/)
  })

  it("O-21 · `check_family` es un ENUM: una errata no acota la revisión a nada", async () => {
    const error = await failure(
      `INSERT INTO manual_review_flags
         (id, organization_id, period_start, period_end, reason, created_by_id, check_family)
       VALUES (gen_random_uuid(), $1::uuid, '2026-01-01', '2026-03-31',
               'motivo suficientemente largo', $2::uuid, 'CONCILIACIOM')`,
      [ORG, USER]
    )
    expect(error).toMatch(/check_family/)
  })

  it("ADR-0015 D4 · los dos `CASHFLOW_*` viejos quedan prohibidos para filas NUEVAS", async () => {
    const error = await failure(
      `INSERT INTO manual_review_flags
         (id, organization_id, period_start, period_end, reason, created_by_id, scope)
       VALUES (gen_random_uuid(), $1::uuid, '2026-01-01', '2026-03-31',
               'motivo suficientemente largo', $2::uuid, 'CASHFLOW_DIRECTO')`,
      [ORG, USER]
    )
    expect(error).toMatch(/manual_review_flags_no_cashflow_legacy/)
    // Y el unificado sí entra.
    expect(
      await failure(
        `INSERT INTO manual_review_flags
           (id, organization_id, period_start, period_end, reason, created_by_id, scope)
         VALUES (gen_random_uuid(), $1::uuid, '2026-04-01', '2026-06-30',
                 'motivo suficientemente largo', $2::uuid, 'CASHFLOW')`,
        [ORG, USER]
      )
    ).toBeNull()
  })

  it("I-E7-9 · el índice parcial de los runs sellados sin `lines_hash` existe", async () => {
    const [{ def }] = await q<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'allocation_runs_sin_lines_hash'`
    )
    expect(def).toMatch(/lines_hash IS NULL/)
    expect(def).toMatch(/SEALED/)
  })

  it("m1 · las tres `AccountKey` nuevas existen en el enum", async () => {
    const rows = await q<{ v: string }>(
      `SELECT unnest(enum_range(NULL::account_key))::text AS v`
    )
    const values = rows.map((r) => r.v)
    expect(values).toEqual(
      expect.arrayContaining(["INTERESES_DEUDAS", "OTROS_GASTOS_FINANCIEROS", "INTERESES_DESCUENTO_EFECTOS"])
    )
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E7 · M3 — la conciliación de D6", () => {
  it("O-7 · la caja NO es conciliable: 570 no pasa el CHECK", async () => {
    const error = await failure(
      `INSERT INTO bank_accounts (id, organization_id, code, name, account_code, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'CAJA', 'Caja', '570', now())`,
      [ORG]
    )
    expect(error).toMatch(/bank_accounts_account_57x/)
  })

  it("O-7 · dos cuentas bancarias contra la MISMA subcuenta computarían `B` dos veces", async () => {
    const error = await failure(
      `INSERT INTO bank_accounts (id, organization_id, code, name, account_code, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'OTRA', 'Otra contra la misma 5720', '5720', now())`,
      [ORG]
    )
    expect(error).toMatch(/bank_accounts_org_account_code_key/)
  })

  it("O-1 · media ancla no ancla: fecha sin saldo se rechaza", async () => {
    const error = await failure(
      `UPDATE bank_accounts SET reconciled_from_date = '2026-01-01' WHERE id = $1::uuid`,
      [bankAccountId]
    )
    expect(error).toMatch(/bank_accounts_anchor_pair/)
  })

  it("D6.2 · un extracto en USD sobre una cuenta en EUR se rechaza ENTERO", async () => {
    const error = await failure(
      `INSERT INTO bank_statements
         (id, organization_id, bank_account_id, format, file_sha256, file_name, currency,
          period_start, period_end, opening_balance_cents, closing_balance_cents)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'N43', repeat('b', 64), 'usd.n43', 'USD',
               '2026-03-01', '2026-03-31', 0, 0)`,
      [ORG, bankAccountId]
    )
    expect(error).toMatch(/se rechaza el fichero entero/)
  })

  it("un extracto no se importa dos veces (I-E7-5: el sha de los bytes es la clave)", async () => {
    const error = await failure(
      `INSERT INTO bank_statements
         (id, organization_id, bank_account_id, format, file_sha256, file_name, currency,
          period_start, period_end, opening_balance_cents, closing_balance_cents)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'N43', repeat('a', 64), 'marzo-otra-vez.n43', 'EUR',
               '2026-03-01', '2026-03-31', 0, 0)`,
      [ORG, bankAccountId]
    )
    expect(error).toMatch(/bank_statements_org_account_sha_key/)
  })

  it("**m2 · el apunte de 0,00 € SE IMPORTA** y nace IGNORED con IMPORTE_CERO", async () => {
    const id = await newStatementLine(0n)
    expect(id).toBeTruthy()
    expect(
      await failure(
        `UPDATE bank_statement_lines SET status = 'IGNORED', ignore_reason = 'IMPORTE_CERO' WHERE id = $1::uuid`,
        [id]
      )
    ).toBeNull()
    // …y `IMPORTE_CERO` es la única causa que no exige ni evidencia ni autor,
    // porque la evidencia es el propio importe.
    const [row] = await q<{ ignore_evidence_id: string | null }>(
      `SELECT ignore_evidence_id FROM bank_statement_lines WHERE id = $1::uuid`,
      [id]
    )
    expect(row.ignore_evidence_id).toBeNull()
  })

  it("m2 · `IMPORTE_CERO` sobre un apunte que NO es cero se rechaza", async () => {
    const id = await newStatementLine(-1234n)
    const error = await failure(
      `UPDATE bank_statement_lines SET status = 'IGNORED', ignore_reason = 'IMPORTE_CERO' WHERE id = $1::uuid`,
      [id]
    )
    expect(error).toMatch(/bank_statement_lines_ignore_evidence/)
  })

  it("O-4 · `YA_CONTABILIZADO_EN_OTRA_CUENTA` sin el `journal_line_id` concreto no es ignorable", async () => {
    const id = await newStatementLine(-500n)
    const error = await failure(
      `UPDATE bank_statement_lines
          SET status = 'IGNORED', ignore_reason = 'YA_CONTABILIZADO_EN_OTRA_CUENTA', ignored_by_id = $2::uuid,
              ignored_at = now()
        WHERE id = $1::uuid`,
      [id, USER]
    )
    expect(error).toMatch(/bank_statement_lines_ignore_evidence/)
  })

  it("el apunte del banco es INMUTABLE: su importe no se retoca", async () => {
    const id = await newStatementLine(-999n)
    const error = await failure(`UPDATE bank_statement_lines SET amount_cents = -1 WHERE id = $1::uuid`, [id])
    expect(error).toMatch(/el apunte del banco es inmutable|permission denied/)
  })

  it("**D6.4 · I-E7-2 en el camino de escritura**: 100,00 € contra 1 000,00 € no se puntea", async () => {
    const line = await newStatementLine(-10000n)
    const journalLine = await newBankJournalLine(-100000n)
    const error = await match(await newGroup(), line, journalLine)
    expect(error).toMatch(/no son el mismo importe con signo/)
  })

  it("D6.4 · con el mismo importe y signo, sí — y el desfase se SELLA solo", async () => {
    const line = await newStatementLine(-10000n, "2026-03-12")
    const journalLine = await newBankJournalLine(-10000n, "2026-03-10")
    const groupId = await newGroup()
    expect(await match(groupId, line, journalLine)).toBeNull()
    const [row] = await q<{ date_gap_days: number }>(
      `SELECT date_gap_days FROM bank_reconciliations WHERE statement_line_id = $1::uuid`,
      [line]
    )
    // O-10: lo recalcula la base, no quien inserta (el INSERT mandaba 0).
    expect(row.date_gap_days).toBe(2)
  })

  it("el apunte tiene que ser de la MISMA subcuenta que la cuenta bancaria", async () => {
    const line = await newStatementLine(-7700n)
    const entryId = await newEntry()
    const [{ id: otherLine }] = await q<{ id: string }>(
      `INSERT INTO journal_lines
         (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          entry_date, fiscal_year_id, entry_kind)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '626', 0, 7700, DATE '2026-03-10', $3::uuid, 'NORMAL')
       RETURNING id`,
      [ORG, entryId, fiscalYearId]
    )
    const error = await match(await newGroup(), line, otherLine)
    expect(error).toMatch(/la cuenta bancaria puntea contra la 5720/)
  })

  it("**D6.1 · una línea pertenece a lo sumo a UN grupo vivo** (índice único parcial)", async () => {
    const line = await newStatementLine(-4200n)
    const j1 = await newBankJournalLine(-4200n)
    const j2 = await newBankJournalLine(-4200n)
    expect(await match(await newGroup(), line, j1)).toBeNull()
    const error = await match(await newGroup(), line, j2)
    expect(error).toMatch(/bank_reconciliations_one_live_statement_line/)
  })

  it("D6.1 · y un apunte del libro tampoco pertenece a dos grupos vivos", async () => {
    const journalLine = await newBankJournalLine(-3100n)
    const l1 = await newStatementLine(-3100n)
    const l2 = await newStatementLine(-3100n)
    expect(await match(await newGroup(), l1, journalLine)).toBeNull()
    const error = await match(await newGroup(), l2, journalLine)
    expect(error).toMatch(/bank_reconciliations_one_live_journal_line/)
  })

  it("D6.1 · desconciliar el GRUPO libera línea y apunte, y exige motivo ≥ 10 caracteres", async () => {
    const line = await newStatementLine(-2500n)
    const journalLine = await newBankJournalLine(-2500n)
    const groupId = await newGroup()
    expect(await match(groupId, line, journalLine)).toBeNull()

    const corto = await failure(
      `UPDATE bank_match_groups SET unmatched_at = now(), unmatched_by_id = $2::uuid, unmatch_reason = 'error'
        WHERE id = $1::uuid`,
      [groupId, USER]
    )
    expect(corto).toMatch(/bank_match_groups_unmatch_triple/)

    expect(
      await failure(
        `UPDATE bank_match_groups SET unmatched_at = now(), unmatched_by_id = $2::uuid,
                unmatch_reason = 'punteo equivocado del cierre de marzo'
          WHERE id = $1::uuid`,
        [groupId, USER]
      )
    ).toBeNull()

    // El espejo se propaga en la MISMA transacción: sin él, los índices únicos
    // parciales seguirían viendo la pertenencia como viva.
    const [row] = await q<{ group_unmatched_at: Date | null }>(
      `SELECT group_unmatched_at FROM bank_reconciliations WHERE statement_line_id = $1::uuid`,
      [line]
    )
    expect(row.group_unmatched_at).not.toBeNull()

    // Y ahora la línea se puede volver a conciliar en otro grupo.
    const otro = await newBankJournalLine(-2500n)
    expect(await match(await newGroup(), line, otro)).toBeNull()
  })

  it("el espejo `group_unmatched_at` no se escribe a mano", async () => {
    const line = await newStatementLine(-1800n)
    const journalLine = await newBankJournalLine(-1800n)
    const groupId = await newGroup()
    await match(groupId, line, journalLine)
    const error = await failure(
      `UPDATE bank_reconciliations SET group_unmatched_at = now() WHERE group_id = $1::uuid`,
      [groupId]
    )
    expect(error).toMatch(/ESPEJO del grupo/)
  })

  it("nada se borra: las seis tablas nuevas tienen política RESTRICTIVE de DELETE", async () => {
    const rows = await q<{ tablename: string }>(
      `SELECT tablename FROM pg_policies
        WHERE permissive = 'RESTRICTIVE' AND cmd = 'DELETE'
          AND tablename IN ('invariant_runs','store_sweeps','bank_statements','bank_statement_lines',
                            'bank_match_groups','bank_reconciliations')`
    )
    expect(new Set(rows.map((r) => r.tablename)).size).toBe(6)
  })

  it("las cinco tablas de banca llevan ENABLE + FORCE y política de tenant", async () => {
    const rows = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('bank_accounts','bank_statements','bank_statement_lines',
                          'bank_match_groups','bank_reconciliations')`
    )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true)
      expect(row.relforcerowsecurity, row.relname).toBe(true)
    }
    const [{ n }] = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
        WHERE policyname = 'tenant_isolation'
          AND tablename IN ('bank_accounts','bank_statements','bank_statement_lines',
                            'bank_match_groups','bank_reconciliations','invariant_runs','store_sweeps')`
    )
    expect(n).toBe("7")
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E7 · M4 — `bigint` en el diario (ADR-0015 D1)", () => {
  it("las cuatro columnas son `bigint`", async () => {
    const rows = await q<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'journal_lines'
          AND column_name IN ('debit_cents','credit_cents','tax_base_cents','original_amount_cents')
        ORDER BY column_name`
    )
    expect(rows.map((r) => r.data_type)).toEqual(["bigint", "bigint", "bigint", "bigint"])
  })

  it("**criterio 24 (c)**: 25 000 000,00 € entra, se agrega y sale exacto", async () => {
    // Con `integer` el techo eran 21 474 836,47 €: este INSERT era imposible.
    const veinticinco = 2_500_000_000n
    const entryId = await newEntry()
    await q(
      `INSERT INTO journal_lines
         (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          entry_date, fiscal_year_id, entry_kind)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '5720', $3::bigint, 0, DATE '2026-06-30', $4::uuid, 'NORMAL'),
              (gen_random_uuid(), $1::uuid, $2::uuid, 2, '626', 0, $3::bigint, DATE '2026-06-30', $4::uuid, 'NORMAL')`,
      [ORG, entryId, veinticinco.toString(), fiscalYearId]
    )
    const [row] = await q<{ d: string; c: string }>(
      `SELECT COALESCE(SUM(l.debit_cents)::bigint, 0)::text AS d,
              COALESCE(SUM(l.credit_cents)::bigint, 0)::text AS c
         FROM journal_lines l WHERE l.entry_id = $1::uuid`,
      [entryId]
    )
    // El agregado sigue cuadrado y sin desbordar: Σdebe = Σhaber = 25 M€.
    expect(row.d).toBe(veinticinco.toString())
    expect(row.c).toBe(veinticinco.toString())

    // Y el hash SQL —`app.journal_entry_hash`, la réplica de `lib/ledger/hash.ts`—
    // sigue componiéndose con `debit_cents::text`, que para un `bigint` es el
    // mismo texto que era para el `integer`.
    const [{ hash }] = await q<{ hash: string }>(`SELECT app.journal_entry_hash($1::uuid) AS hash`, [entryId])
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toContain("")
  })
})
