/**
 * E8 · T3 — El SQL de `20260913100000_e8_documentos` y
 * `20260914090000_e8_file_sha256_not_null`, contra Postgres de verdad.
 *
 * Todo lo que aquí se comprueba tiene la misma forma: **la regla está en la
 * base, no sólo en el código**. Un CHECK que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL, y precisamente contra eso están los invariantes de
 * la épica.
 *
 *  · **CHECK de D1** (O-9.ii): las cuatro ramas de `Transaction.status`. El de
 *    la ronda 1 dejaba pasar un `VOID` sin asiento anulado.
 *  · **Transiciones y traslado a `voided_entry_id`**: `VOID → PROPOSED` abierta,
 *    `POSTED → DRAFT|PROPOSED` cerrada, e histórico append-only.
 *  · **Trigger de `partial`** (G-02): lo escribe la base, no quien inserta.
 *  · **Append-only** de `extraction_runs` y `prompt_versions` (I-E8-3).
 *  · **`files.sha256 NOT NULL`** tras el backfill (I-E8-9).
 *  · Los CHECK de divisa en `journal_lines`, el techo de tolerancia (O-16), el
 *    veto al subgrupo 64 en `categories` (O-13) y la numeración sin huecos de
 *    las series (O-18).
 *
 * Conecta con el rol PROPIETARIO: aquí se ejercen constraints y triggers, no
 * RLS. El aislamiento por tenant vive en `tests/integration-rls/e8-tenant.test.ts`.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e8000000-0000-4000-8000-00000000000a"
const USER = "e8000000-0000-4000-8000-0000000000a1"
const FILE = "e8000000-0000-4000-8000-0000000000f1"

let client: Client

const SHA_A = "a".repeat(64)

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

async function newTransaction(status = "DRAFT"): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO transactions (id, organization_id, name, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'op', $2::transaction_status, now()) RETURNING id`,
    [ORG, status]
  )
  return rows[0].id
}

/**
 * Un asiento al que apuntar. No lleva líneas a propósito: aquí se ejercen los
 * CHECK de `transactions`, y el cuadre de I1 lo comprueban los triggers
 * DIFERIDOS de E3 al COMMIT — que nunca llega, porque el fichero entero corre
 * dentro de una transacción que se deshace.
 */
let entryNumber = 0
let fiscalYearId = ""
async function newEntry(): Promise<string> {
  entryNumber += 1
  const rows = await q<{ id: string }>(
    `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, description,
        posted_by_id, entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, CURRENT_DATE, 'asiento de prueba',
             $4::uuid, repeat('0', 64), 3)
     RETURNING id`,
    [ORG, fiscalYearId, entryNumber, USER]
  )
  return rows[0].id
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  await cleanup()

  await q(`INSERT INTO users (id, email, name, created_at, updated_at)
           VALUES ($1::uuid, 'e8-esquema@test.local', 'E8', now(), now())`, [USER])
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e8-esquema-org', 'E8 esquema', now())`,
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
  await q(
    `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'f.pdf', 'f.pdf', 'application/pdf', $4, 100)`,
    [FILE, ORG, USER, SHA_A]
  )
  // Todo el fichero corre dentro de UNA transacción con savepoints: así no deja
  // rastro y los CHECK se pueden provocar sin ensuciar la base.
  await q("BEGIN")
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

describe.skipIf(!TEST_DATABASE_URL)("E8 · T3 — CHECK y triggers del esquema", () => {
  // ───────────────────────────────────────────────────────────────────────────
  describe("CHECK de ADR-0014 D1 sobre `transactions` (O-9.ii)", () => {
    it("DRAFT sin asiento y sin anulado: válido", async () => {
      expect(await failure(`SELECT 1 FROM transactions WHERE id = $1::uuid`, [await newTransaction()])).toBeNull()
    })

    it("POSTED **exige** asiento: sin él, la base lo rechaza", async () => {
      const id = await newTransaction()
      const error = await failure(`UPDATE transactions SET status = 'POSTED' WHERE id = $1::uuid`, [id])
      expect(error).toMatch(/transactions_status_entry_d1/)
    })

    it("VOID sin asiento anulado NO pasa — el CHECK de la ronda 1 lo dejaba pasar", async () => {
      // Éste es exactamente el defecto que O-9.ii denunciaba: con la precedencia
      // de operadores del CHECK original, `VOID` con todo a NULL era válido.
      const id = await newTransaction()
      const error = await failure(
        `UPDATE transactions SET status = 'VOID', journal_entry_id = NULL, voided_entry_id = NULL
          WHERE id = $1::uuid`,
        [id]
      )
      expect(error).not.toBeNull()
    })

    it("DRAFT con `voided_entry_id` no es un estado legal", async () => {
      const id = await newTransaction()
      const entry = await newEntry()
      const error = await failure(`UPDATE transactions SET voided_entry_id = $2::uuid WHERE id = $1::uuid`, [
        id,
        entry,
      ])
      expect(error).toMatch(/transactions_status_entry_d1/)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("transiciones de estado y traslado del asiento anulado", () => {
    it("DRAFT → POSTED → VOID: el asiento se TRASLADA solo y se apila", async () => {
      const id = await newTransaction()
      const entry = await newEntry()
      await q(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [id, entry])
      await q(`UPDATE transactions SET status = 'VOID' WHERE id = $1::uuid`, [id])

      const [row] = await q<{ journal_entry_id: string | null; voided_entry_id: string; voided_entry_ids: string[] }>(
        `SELECT journal_entry_id, voided_entry_id, voided_entry_ids FROM transactions WHERE id = $1::uuid`,
        [id]
      )
      // Nada se pierde: el asiento anulado y su contra-asiento siguen en el diario.
      expect(row.journal_entry_id).toBeNull()
      expect(row.voided_entry_id).toBe(entry)
      expect(row.voided_entry_ids).toEqual([entry])
    })

    it("VOID → PROPOSED → POSTED: anular y rehacer, sin volver a subir el fichero", async () => {
      const id = await newTransaction()
      const first = await newEntry()
      await q(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [id, first])
      await q(`UPDATE transactions SET status = 'VOID' WHERE id = $1::uuid`, [id])
      expect(await failure(`UPDATE transactions SET status = 'PROPOSED' WHERE id = $1::uuid`, [id])).toBeNull()

      const second = await newEntry()
      expect(
        await failure(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [
          id,
          second,
        ])
      ).toBeNull()
    })

    it("POSTED → DRAFT y POSTED → PROPOSED están PROHIBIDAS", async () => {
      for (const destino of ["DRAFT", "PROPOSED"]) {
        const id = await newTransaction()
        const entry = await newEntry()
        await q(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [
          id,
          entry,
        ])
        const error = await failure(
          `UPDATE transactions SET status = $2::transaction_status, journal_entry_id = NULL WHERE id = $1::uuid`,
          [id, destino]
        )
        expect(error, destino).toMatch(/no permitida/)
      }
    })

    /**
     * Ronda 1 de corrección, revisor #6 (PUEDE) — migración
     * `20260915090000_e8_ronda1_transiciones`. §2.3 del diseño enumera
     * `DRAFT → PROPOSED → POSTED → VOID`, el atajo `DRAFT → POSTED` y la vuelta
     * `VOID → PROPOSED`. `PROPOSED → DRAFT` era una rama de más respecto del
     * contrato aprobado, inocua pero no enumerada, y se ha retirado.
     */
    it("PROPOSED → DRAFT está PROHIBIDA: no está en el contrato de ADR-0014 D1", async () => {
      const id = await newTransaction()
      await q(`UPDATE transactions SET status = 'PROPOSED' WHERE id = $1::uuid`, [id])
      const error = await failure(`UPDATE transactions SET status = 'DRAFT' WHERE id = $1::uuid`, [id])
      expect(error).toMatch(/no permitida/)
      // Y las que sí están en el contrato siguen abiertas.
      expect(await failure(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [
        id,
        await newEntry(),
      ])).toBeNull()
    })

    it("`voided_entry_ids` es APPEND-ONLY: no se puede vaciar ni acortar", async () => {
      const id = await newTransaction()
      const entry = await newEntry()
      await q(`UPDATE transactions SET status = 'POSTED', journal_entry_id = $2::uuid WHERE id = $1::uuid`, [id, entry])
      await q(`UPDATE transactions SET status = 'VOID' WHERE id = $1::uuid`, [id])
      const error = await failure(
        `UPDATE transactions SET voided_entry_ids = ARRAY[]::uuid[] WHERE id = $1::uuid`,
        [id]
      )
      expect(error).toMatch(/append-only/)
    })

    it("el motivo de un `convertedTotal` forzado no puede ser un «ok»", async () => {
      const id = await newTransaction()
      expect(
        await failure(`UPDATE transactions SET converted_total_override_reason = 'ok' WHERE id = $1::uuid`, [id])
      ).toMatch(/override_reason_len/)
      expect(
        await failure(
          `UPDATE transactions SET converted_total_override_reason = 'tasa del BCE no publicada ese día'
            WHERE id = $1::uuid`,
          [id]
        )
      ).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("`extraction_runs`: trigger de `partial`, CHECK y append-only", () => {
    const insertRun = (over: Partial<Record<string, unknown>> = {}) => {
      const v = {
        kind: "LLM",
        provider: "openai",
        model: "gpt-x",
        parent: null,
        sent: 4,
        total: 9,
        partial: false,
        ...over,
      }
      return q<{ id: string; partial: boolean }>(
        `INSERT INTO extraction_runs
           (organization_id, file_id, file_sha256, kind, parent_run_id, provider, model,
            prompt_code, prompt_source, prompt_sha, schema_version, schema_sha,
            pages_sent, pages_total, partial, raw_output, duration_ms, git_sha)
         VALUES ($1::uuid, $2::uuid, $3, $4::extraction_kind, $5::uuid, $6, $7,
                 'extraccion', 'GIT', repeat('b', 64), '1', repeat('c', 64),
                 $8, $9, $10, '{}'::jsonb, 120, 'abc1234')
         RETURNING id, partial`,
        [ORG, FILE, SHA_A, v.kind, v.parent, v.provider, v.model, v.sent, v.total, v.partial]
      )
    }

    it("**el trigger escribe `partial`, no quien inserta** (G-02)", async () => {
      // Se inserta mintiendo (`partial = false` con 4 de 9 páginas) y la base lo
      // corrige: si el modelo vio 4 páginas de 9, la propuesta no es incompleta,
      // es potencialmente falsa — el total puede estar en la página 9.
      const [parcial] = await insertRun({ sent: 4, total: 9, partial: false })
      expect(parcial.partial).toBe(true)

      // Y al revés: no se puede marcar parcial un run completo.
      const [completo] = await insertRun({ sent: 9, total: 9, partial: true })
      expect(completo.partial).toBe(false)
    })

    it("`pages_sent` nunca puede pasar de `pages_total`", async () => {
      const error = await failure(
        `INSERT INTO extraction_runs
           (organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
            prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, duration_ms, git_sha)
         VALUES ($1::uuid, $2::uuid, $3, 'LLM', 'openai', 'gpt-x', 'e', 'GIT',
                 repeat('b', 64), '1', repeat('c', 64), 12, 9, '{}'::jsonb, 1, 'abc')`,
        [ORG, FILE, SHA_A]
      )
      expect(error).toMatch(/pages_range/)
    })

    it("un run `MANUAL` sin padre y sin `provider = formulario` no es trazable: se rechaza", async () => {
      const error = await failure(
        `INSERT INTO extraction_runs
           (organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
            prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, duration_ms, git_sha)
         VALUES ($1::uuid, $2::uuid, $3, 'MANUAL', 'humano', '-', 'e', 'GIT',
                 repeat('b', 64), '1', repeat('c', 64), 0, 0, '{}'::jsonb, 1, 'abc')`,
        [ORG, FILE, SHA_A]
      )
      expect(error).toMatch(/manual_origin/)
    })

    it("un run `MANUAL` de formulario SÍ entra (D5: la revisión humana es un run nuevo)", async () => {
      const [padre] = await insertRun()
      expect(await failure(`SELECT 1`)).toBeNull()
      const [revision] = await insertRun({ kind: "MANUAL", provider: "humano", parent: padre.id, sent: 0, total: 0 })
      expect(revision.id).toBeTruthy()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("CHECK de divisa en `journal_lines` (T2b, ADR-0014 D2)", () => {
    it("`original_currency` y `original_amount_cents` van juntos o no van", async () => {
      const [row] = await q<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = 'journal_lines_original_currency_pair'`
      )
      expect(row?.conname).toBe("journal_lines_original_currency_pair")
    })

    it("con divisa hay tasa persistida sí o sí: sin tasa no se inventa nada (RC-14)", async () => {
      const [row] = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'journal_lines_original_currency_rate'`
      )
      expect(row.def).toContain("exchange_rate_id")
    })

    it("las tres columnas de divisa NO están en el GRANT UPDATE acotado de ADR-0010", async () => {
      // Son inmutables: si se pudieran actualizar, la valoración al cierre
      // dejaría de ser reconstruible desde el diario.
      const updatable = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'journal_lines' AND grantee = 'app_runtime' AND privilege_type = 'UPDATE'`
      )
      const names = updatable.map((r) => r.column_name)
      expect(names).not.toContain("original_currency")
      expect(names).not.toContain("original_amount_cents")
      expect(names).not.toContain("exchange_rate_id")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("los otros CHECK de la migración", () => {
    it("`redondeo_tolerancia_cents` tiene TECHO DURO de 5 c (O-16)", async () => {
      // La ronda 1 admitía que un ADMIN la subiera a 50, que es tanto como no
      // tener tolerancia.
      expect(
        await failure(`UPDATE organizations SET redondeo_tolerancia_cents = 50 WHERE id = $1::uuid`, [ORG])
      ).toMatch(/redondeo_tolerancia_range/)
      expect(
        await failure(`UPDATE organizations SET redondeo_tolerancia_cents = 5 WHERE id = $1::uuid`, [ORG])
      ).toBeNull()
    })

    it("ninguna categoría puede apuntar al subgrupo 64 (O-13)", async () => {
      await q(
        `INSERT INTO categories (id, organization_id, code, name) VALUES (gen_random_uuid(), $1::uuid, 'c1', 'C1')`,
        [ORG]
      )
      expect(
        await failure(`UPDATE categories SET default_account_code = '640' WHERE organization_id = $1::uuid`, [ORG])
      ).toMatch(/not_64/)
      expect(
        await failure(`UPDATE categories SET default_account_code = '629' WHERE organization_id = $1::uuid`, [ORG])
      ).toBeNull()
    })

    it("`exchange_rates`: tasa positiva, divisas distintas y de tres letras", async () => {
      expect(
        await failure(
          `INSERT INTO exchange_rates (date, "from", "to", rate_micro, source)
           VALUES ('2026-03-10', 'USD', 'EUR', 0, 'ECB_FRANKFURTER')`
        )
      ).toMatch(/rate_positive/)
      expect(
        await failure(
          `INSERT INTO exchange_rates (date, "from", "to", rate_micro, source)
           VALUES ('2026-03-10', 'EUR', 'EUR', 1000000, 'ECB_FRANKFURTER')`
        )
      ).toMatch(/distinct/)
      expect(
        await failure(
          `INSERT INTO exchange_rates (date, "from", "to", rate_micro, source)
           VALUES ('2026-03-10', 'USD', 'EUR', 920000, 'ECB_FRANKFURTER')`
        )
      ).toBeNull()
    })

    it("una tasa es única por (fecha, origen, destino, fuente)", async () => {
      await q(`INSERT INTO exchange_rates (date, "from", "to", rate_micro, source)
               VALUES ('2026-04-01', 'GBP', 'EUR', 1160000, 'ECB_FRANKFURTER')`)
      expect(
        await failure(`INSERT INTO exchange_rates (date, "from", "to", rate_micro, source)
                       VALUES ('2026-04-01', 'GBP', 'EUR', 1170000, 'ECB_FRANKFURTER')`)
      ).toMatch(/duplicate key|unique/i)
    })

    it("las series se numeran SIN HUECOS y no retroceden (O-18, I-E8-20)", async () => {
      const [serie] = await q<{ id: string }>(
        `INSERT INTO invoice_series (id, organization_id, code, kind, prefix, next_number, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 'ORD', 'ORDINARIA', 'F-', 1, now()) RETURNING id`,
        [ORG]
      )
      expect(
        await failure(`UPDATE invoice_series SET next_number = 2 WHERE id = $1::uuid`, [serie.id])
      ).toBeNull()
      expect(
        await failure(`UPDATE invoice_series SET next_number = 9 WHERE id = $1::uuid`, [serie.id])
      ).toMatch(/uno en uno/)
      expect(
        await failure(`UPDATE invoice_series SET next_number = 1 WHERE id = $1::uuid`, [serie.id])
      ).toMatch(/uno en uno/)
      // Y una serie rectificativa no se convierte en ordinaria: se crea otra.
      expect(
        await failure(`UPDATE invoice_series SET kind = 'RECTIFICATIVA' WHERE id = $1::uuid`, [serie.id])
      ).toMatch(/no se cambia/)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("`files.sha256` es NOT NULL tras el backfill (G-11, I-E8-9)", () => {
    it("la columna está declarada NOT NULL", async () => {
      const [row] = await q<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'files' AND column_name = 'sha256'`
      )
      expect(row.is_nullable).toBe("NO")
    })

    it("un fichero sin sha no entra: sin él no hay eslabón con el documento", async () => {
      const error = await failure(
        `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'x.pdf', 'x.pdf', 'application/pdf')`,
        [ORG, USER]
      )
      expect(error).toMatch(/sha256/)
    })

    it("`cached_parse_result` ya no existe (G-03)", async () => {
      const rows = await q(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'cached_parse_result'`
      )
      expect(rows).toHaveLength(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  it("la migración hace los backfills bajo el patrón NO FORCE → DML → FORCE", async () => {
    const { readFileSync } = await import("node:fs")
    const sql = readFileSync("prisma/migrations/20260913100000_e8_documentos/migration.sql", "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")

    const noForce = sql.indexOf('ALTER TABLE "files"                     NO FORCE ROW LEVEL SECURITY')
    const insert = sql.indexOf("INSERT INTO \"extraction_runs\"")
    const force = sql.indexOf('ALTER TABLE "files"                     FORCE ROW LEVEL SECURITY')
    const drop = sql.indexOf('ALTER TABLE "files" DROP COLUMN "cached_parse_result"')

    expect(noForce).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(noForce)
    expect(force).toBeGreaterThan(insert)
    // El DROP va DESPUÉS de haber convertido lo memorizado en evidencia.
    expect(drop).toBeGreaterThan(force)
  })
})
