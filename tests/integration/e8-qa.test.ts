/**
 * QA E8 — casos adversariales de `docs/design/E8-documentos-asientos.md` §12.1
 * y `E8-validacion-documentos.md` que no tenían test propio tras revisar la
 * suite existente (`lib/extraction/reconcile.test.ts`,
 * `lib/extraction/split.test.ts`, `lib/ledger/postFromProposal.test.ts`,
 * `tests/integration/e8-*.test.ts`). No repite golden cases: cada `it` de
 * aquí cubre una rama de `reconcile()` o un invariante que el fixture de 15
 * casos no ejercía.
 *
 * Puro (RC-04/05/12/21): reutiliza el puente `reconcile.fixture.ts` para no
 * inventar un contexto desde cero. Integración (I-E8-5): base `erp_test` real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { FILE_UPLOAD_PATH } from "@/lib/files"

import {
  caseById,
  inputProposalFor,
  reconcileContextFor,
} from "@/lib/extraction/reconcile.fixture"
import { reconcile } from "@/lib/extraction/reconcile"
import { checkIE85, type DocumentsInvariantInput, type TransactionDocRef } from "@/lib/ledger/invariants"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

// ─────────────────────────────────────────────────────────────────────────────
// RC-04 · moneda inválida
// ─────────────────────────────────────────────────────────────────────────────

describe("RC-04 · moneda", () => {
  it("una moneda que no es un código ISO-4217 conocido del contexto ⇒ FAIL, bloquea lote, cero asientos posibles", () => {
    const c = caseById("C01")
    const proposal = { ...inputProposalFor(c), currency: "ZZZ" }
    const ctx = reconcileContextFor(c)
    const r = reconcile(proposal, ctx)
    const rc04 = r.checks.find((k) => k.id === "RC-04")
    expect(rc04?.status).toBe("FAIL")
    expect(rc04?.blocksBatch).toBe(true)
    expect(r.elegibleParaLote).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RC-05 · fecha futura y fecha fuera de todo ejercicio abierto
// ─────────────────────────────────────────────────────────────────────────────

describe("RC-05 · fechas", () => {
  it("fecha de expedición POSTERIOR a refDate ⇒ FAIL explícito, no una fecha silenciosamente truncada", () => {
    const c = caseById("C01")
    const ctx = reconcileContextFor(c)
    const proposal = { ...inputProposalFor(c), documentDate: "2099-01-01" }
    const r = reconcile(proposal, ctx)
    const rc05 = r.checks.find((k) => k.id === "RC-05")
    expect(rc05?.status).toBe("FAIL")
    expect(rc05?.blocksBatch).toBe(true)
    expect(rc05?.message).toMatch(/futura/)
  })

  it("fecha que no cae en NINGÚN ejercicio configurado (ni 2025 ni 2026) ⇒ FAIL, no un ejercicio cerrado", () => {
    const c = caseById("C01")
    const ctx = reconcileContextFor(c)
    // 2024 no existe en FIXTURE_FISCAL_YEARS (sólo 2025 CLOSED y 2026 OPEN) y
    // no es futura respecto de refDate (2026-12-31): ejercita la rama distinta
    // de "fecha futura" y de "ejercicio cerrado".
    const proposal = { ...inputProposalFor(c), documentDate: "2024-06-15", accrualDate: null }
    const r = reconcile(proposal, ctx)
    const rc05 = r.checks.find((k) => k.id === "RC-05")
    expect(rc05?.status).toBe("FAIL")
    expect(rc05?.blocksBatch).toBe(true)
    expect(rc05?.message).toMatch(/ningún ejercicio/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RC-12 · duplicado por sha256 Y por (taxId, número, ejercicio) — dos vías distintas
// ─────────────────────────────────────────────────────────────────────────────

describe("RC-12 · duplicados — las dos vías del criterio 28/O-... no se confunden", () => {
  it("duplicado por sha256 ⇒ WARN con el mensaje del sha, no el del número de documento", () => {
    const c = caseById("C01")
    const ctx = reconcileContextFor(c, { duplicate: { bySha256: true, byDocumentNumber: false } })
    const r = reconcile(inputProposalFor(c), ctx)
    const rc12 = r.checks.find((k) => k.id === "RC-12")
    expect(rc12?.status).toBe("WARN")
    expect(rc12?.message).toMatch(/sha256/)
  })

  it("duplicado por (taxId, número de documento, ejercicio) sin coincidir el sha256 ⇒ WARN con el mensaje de número/NIF/ejercicio", () => {
    const c = caseById("C01")
    const ctx = reconcileContextFor(c, { duplicate: { bySha256: false, byDocumentNumber: true } })
    const r = reconcile(inputProposalFor(c), ctx)
    const rc12 = r.checks.find((k) => k.id === "RC-12")
    expect(rc12?.status).toBe("WARN")
    expect(rc12?.message).toMatch(/número/)
    expect(rc12?.message).not.toMatch(/sha256/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RC-21 · rectificativa sin documento rectificado
// ─────────────────────────────────────────────────────────────────────────────

describe("RC-21 · rectificativas sin respaldo", () => {
  it("un ABONO sin `rectifies` en absoluto ⇒ FAIL, no construible, sin importar el modo", () => {
    const c = caseById("C06") // Abono recibido, modo DIFERENCIAS
    const ctx = reconcileContextFor(c)
    const proposal = { ...inputProposalFor(c), rectifies: null }
    const r = reconcile(proposal, ctx)
    const rc21 = r.checks.find((k) => k.id === "RC-21")
    expect(rc21?.status).toBe("FAIL")
    expect(rc21?.blocksBatch).toBe(true)
  })

  it("modo SUSTITUCIÓN con `rectifies` completo pero SIN el asiento rectificado resuelto en contexto ⇒ WARN bloqueante (no se inventa la diferencia)", () => {
    const c = caseById("C07") // Abono emitido por SUSTITUCION
    // reconcileContextFor añade rectifiedEntry automáticamente para C07: lo
    // retiramos para simular que el documento rectificado no se ha localizado.
    const ctxConRectificado = reconcileContextFor(c)
    const ctxSinRectificado = { ...ctxConRectificado, rectifiedEntry: undefined }
    const r = reconcile(inputProposalFor(c), ctxSinRectificado)
    const rc21 = r.checks.find((k) => k.id === "RC-21")
    expect(rc21?.status).toBe("WARN")
    expect(rc21?.blocksBatch).toBe(true)
    expect(rc21?.message).toMatch(/no se ha resuelto/)
    // Control: con el rectificado sí resuelto, el mismo documento pasa.
    const rOk = reconcile(inputProposalFor(c), ctxConRectificado)
    expect(rOk.checks.find((k) => k.id === "RC-21")?.status).toBe("PASS")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// I-E8-5 · una tasa alterada delata la conversión (criterio 30, tercera rama)
// ─────────────────────────────────────────────────────────────────────────────
//
// `e8-invariants.test.ts` ya demuestra por SQL real sobre Postgres las otras
// dos ramas del criterio 30: I-E8-1 (run editado) e I-E8-2 (sha256 alterado).
// La de la tasa se demuestra aquí a nivel del invariante puro (mismo patrón
// que I-E8-1/2/4 usan por dentro, antes de la consulta SQL): construir el
// input tal como lo dejaría una fila corrompida y comprobar que checkIE85 la
// delata. No repite el fixture de conexión a Postgres de e8-invariants.test.ts
// para no duplicar ~300 líneas de arnés por una sola rama del criterio.

describe("I-E8-5 · convertedTotal no sale de otro sitio que la tasa persistida", () => {
  const baseTx: TransactionDocRef = {
    id: "e8qa-tx-1",
    status: "POSTED",
    journalEntryId: "e8qa-entry-1",
    voidedEntryId: null,
    fileId: "e8qa-file-1",
    splitParentTransactionId: null,
    currency: "USD",
    totalCents: 1_000_000,
    convertedTotalCents: 925_926,
    exchangeRateMicro: 925_926n,
    rateDate: "2026-11-20",
    rateSource: "frankfurter",
    extractionRunId: "e8qa-run-1",
  }
  // Tasa real: 1 USD = 0,925926 EUR ⇒ rateMicro = 925_926 (6 decimales), y
  // convertWithRateMicro(1_000_000, 925_926) = 925_926 al céntimo (I-E8-5 PASS).
  const okTx: TransactionDocRef = { ...baseTx, exchangeRateMicro: 925_926n }

  const inputWith = (transactions: readonly TransactionDocRef[]): DocumentsInvariantInput =>
    ({
      runs: [],
      transactions,
      files: [],
      vatBook: [],
      vatBalances: [],
      withholdings: [],
      exchangeRates: [{ id: "rate-1", date: "2026-11-20", from: "USD", to: "EUR", rateMicro: 925_926n, source: "frankfurter" }],
    }) as unknown as DocumentsInvariantInput

  it("estado limpio: la tasa persistida reproduce convertedTotal al céntimo ⇒ PASS", () => {
    const r = checkIE85(inputWith([okTx]))
    expect(r.status).toBe("PASS")
  })

  it("`convertedTotalCents` reescrito por fuera (SQL) sin tocar la tasa ⇒ FAIL, delata la transacción", () => {
    const corrupted: TransactionDocRef = { ...okTx, convertedTotalCents: 900_000 }
    const r = checkIE85(inputWith([corrupted]))
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toMatch(new RegExp(corrupted.id))
  })

  it("la fila de `exchange_rates` que respalda la tasa sellada desaparece/cambia (purgada o alterada por SQL) ⇒ FAIL", () => {
    const input: DocumentsInvariantInput = { ...inputWith([okTx]), exchangeRates: [] }
    const r = checkIE85(input)
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toMatch(/no está en exchange_rates/)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// BUG-E8-1 (ronda 1 de corrección · auditor H-3) — **CERRADO**
//
// El QA de E8 demostró que I-E8-2 no podía llegar nunca a FAIL por los bytes
// del documento: `diskSha256` estaba declarado y consumido, y **no había un
// solo productor en el repositorio**, así que el camino real de producción
// (`runLedgerInvariants`, el de la pestaña Auditoría y el de
// `scripts/run-invariants.ts`) se quedaba en un WARN permanente de «sin
// comprobar en disco» que empujaba el sello a REQUIERE REVISIÓN en toda
// ejecución, con datos buenos y con datos malos por igual.
//
// Ahora `readDocumentsInvariantInput` lee del almacén, en streaming, los bytes
// de los ficheros que respaldan un asiento. Los dos casos del criterio 30:
//
//   (a) el documento **no está** en el almacén        ⇒ I-E8-2 FAIL con su ruta
//   (b) los **bytes cambiaron** bajo los pies del ERP ⇒ I-E8-2 FAIL con los sha
//
// y en los dos el sello del run es **REQUIERE REVISIÓN**, que es lo que hace
// que el hallazgo se vea sin tener que ir a buscarlo.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_DATABASE_URL)("BUG-E8-1 · I-E8-2 compara los bytes del almacén en el camino REAL de producción", () => {
  const ORG = "e8000000-0000-4000-8000-0000000000c1"
  const USER = "e8000000-0000-4000-8000-0000000000c2"
  const FILE_AUSENTE = "e8000000-0000-4000-8000-0000000000c3"
  const FILE_ALTERADO = "e8000000-0000-4000-8000-0000000000c4"
  const SHA_AUSENTE = "e".repeat(64)

  /** Bytes que se escriben en disco y cuyo sha256 se registra en `files`. */
  const BYTES_ORIGINALES = Buffer.from("%PDF-1.4 documento original de BUG-E8-1\n", "utf8")

  let client: import("pg").Client
  let fiscalYearId = ""
  let shaOriginal = ""
  let rutaAlterado = ""

  async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await client.query<T>(sql, params)).rows
  }

  async function cleanup(): Promise<void> {
    for (const sql of [
      `DELETE FROM journal_lines WHERE organization_id = $1::uuid`,
      `DELETE FROM transactions WHERE organization_id = $1::uuid`,
      `DELETE FROM journal_entries WHERE organization_id = $1::uuid`,
      `DELETE FROM extraction_runs WHERE organization_id = $1::uuid`,
      `DELETE FROM files WHERE organization_id = $1::uuid`,
      `DELETE FROM accounts WHERE organization_id = $1::uuid`,
      `DELETE FROM fiscal_years WHERE organization_id = $1::uuid`,
      `DELETE FROM memberships WHERE organization_id = $1::uuid`,
      `DELETE FROM organizations WHERE id = $1::uuid`,
    ]) {
      await q(sql, [ORG]).catch(() => undefined)
    }
    await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
    await rm(join(FILE_UPLOAD_PATH, ORG), { recursive: true, force: true }).catch(() => undefined)
  }

  /** Un documento + su run + su asiento POSTED, todo coherente. */
  async function seedDocument(fileId: string, sha256: string, filePath: string, entryNumber: number): Promise<void> {
    await q(
      `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'application/pdf', $6, 100)`,
      [fileId, ORG, USER, `bug-e8-1-${entryNumber}.pdf`, filePath, sha256]
    )
    const proposal = {
      version: 1,
      docKind: "FACTURA_RECIBIDA",
      documentNumber: `BUG-E8-1-${entryNumber}`,
      counterparty: { name: "Proveedor QA", taxId: "B58818501" },
      documentDate: "2026-03-28",
      receptionDate: "2026-03-28",
      currency: "EUR",
      lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA_21", accountCode: "629", deductibility: "FULL" }],
      taxes: [{ taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 }],
      totalCents: 121_000,
    }
    const [run] = await q<{ id: string }>(
      `INSERT INTO extraction_runs
         (id, organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
          prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, proposal,
          reconcile, reconcile_status, duration_ms, git_sha)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'LLM', 'openai', 'gpt', 'extraccion', 'GIT',
               repeat('b', 64), 'v-qa', repeat('c', 64), 1, 1, '{}'::jsonb, $4::jsonb,
               $5::jsonb, 'PASS', 120, 'abc1234')
       RETURNING id`,
      [ORG, fileId, sha256, JSON.stringify(proposal), JSON.stringify({ status: "PASS", checks: [], sellos: [] })]
    )
    const [entry] = await q<{ id: string }>(
      `INSERT INTO journal_entries
         (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date, reception_date,
          description, posted_by_id, entry_hash, hash_version, file_id, extraction_run_id, source_type)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $6, '2026-03-28', '2026-03-28', '2026-03-28',
               'BUG-E8-1', $3::uuid, repeat('0', 64), 3, $4::uuid, $5::uuid, 'INVOICE_IN')
       RETURNING id`,
      [ORG, fiscalYearId, USER, fileId, run.id, entryNumber]
    )
    for (const [lineNo, code, debit, credit] of [
      [1, "629", 100_000, 0],
      [2, "472", 21_000, 0],
      [3, "400", 0, 121_000],
    ] as [number, string, number, number][]) {
      await q(
        `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, origin, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, 3, 'DEUDORA', true, true, 'SEED', now())
         ON CONFLICT (organization_id, code) DO NOTHING`,
        [ORG, code, `Cuenta ${code}`]
      )
      await q(
        `INSERT INTO journal_lines (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents, entry_date, fiscal_year_id, entry_kind)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, '2026-03-28', $7::uuid, 'NORMAL')`,
        [ORG, entry.id, lineNo, code, debit, credit, fiscalYearId]
      )
    }
    await q(
      `INSERT INTO transactions (id, organization_id, name, status, total, currency_code, journal_entry_id, extraction_run_id, files, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'POSTED', 121000, 'EUR', $3::uuid, $4::uuid, $5::jsonb, now())`,
      [ORG, `BUG-E8-1-${entryNumber}`, entry.id, run.id, JSON.stringify([fileId])]
    )
  }

  beforeAll(async () => {
    const { Client } = await import("pg")
    client = new Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    await cleanup()

    await q("BEGIN")
    await q(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1::uuid, 'e8-qa-bug1@test.local', 'QA', now(), now())`, [USER])
    await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e8-qa-bug1', 'e8-qa-bug1', now())`, [ORG])
    await q(`INSERT INTO memberships (id, organization_id, user_id, role, updated_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now())`, [ORG, USER])
    const [fy] = await q<{ id: string }>(
      `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now()) RETURNING id`,
      [ORG]
    )
    fiscalYearId = fy.id

    // (a) documento que NUNCA se escribió en disco.
    await seedDocument(FILE_AUSENTE, SHA_AUSENTE, "unsorted/no-existe-en-disco.pdf", 1)

    // (b) documento que SÍ existe, con su sha real: los bytes se alteran en el test.
    shaOriginal = createHash("sha256").update(BYTES_ORIGINALES).digest("hex")
    const relativo = "unsorted/bug-e8-1-alterado.pdf"
    rutaAlterado = join(FILE_UPLOAD_PATH, ORG, relativo)
    await mkdir(dirname(rutaAlterado), { recursive: true })
    await writeFile(rutaAlterado, BYTES_ORIGINALES)
    await seedDocument(FILE_ALTERADO, shaOriginal, relativo, 2)

    await q("COMMIT")
  }, 120_000)

  afterAll(async () => {
    await cleanup()
    await client.end()
  })

  async function invariante(): Promise<{ status: string; evidencia: string; sello: string }> {
    const { runLedgerInvariants } = await import("@/models/ledger")
    const { sha256OfStoredFile } = await import("@/lib/files-integrity")
    const validation = await runLedgerInvariants(ORG, {
      refDate: "2026-06-01",
      fiscalYearId,
      noCache: true,
      actor: { userId: USER },
      readStoredFile: sha256OfStoredFile,
    })
    const check = validation.validacion.checks.find((c) => c.id === "I-E8-2")
    return { status: check?.status ?? "AUSENTE", evidencia: check?.evidencia ?? "", sello: validation.sello.sello }
  }

  it("el documento que respalda un asiento ya no está en el almacén ⇒ I-E8-2 FAIL con su ruta y sello REQUIERE REVISIÓN", async () => {
    // Los bytes del segundo documento siguen intactos: el FAIL nombra sólo al ausente.
    const r = await invariante()
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toMatch(/no-existe-en-disco\.pdf/)
    expect(r.evidencia).toMatch(/no está en el almacén/)
    expect(r.sello).toBe("REQUIERE REVISIÓN")
  }, 60_000)

  it("los bytes del documento cambian bajo los pies del ERP ⇒ I-E8-2 FAIL comparando el sha del disco con el registrado", async () => {
    await writeFile(rutaAlterado, Buffer.concat([BYTES_ORIGINALES, Buffer.from("  <-- alterado por fuera\n", "utf8")]))
    const r = await invariante()
    expect(r.status).toBe("FAIL")
    expect(r.evidencia).toMatch(/bug-e8-1-alterado\.pdf/)
    expect(r.evidencia).toMatch(/los bytes en disco no son los registrados/)
    expect(r.sello).toBe("REQUIERE REVISIÓN")
    // Y se restaura: el estado limpio deja de nombrar a este fichero.
    await writeFile(rutaAlterado, BYTES_ORIGINALES)
    const limpio = await invariante()
    expect(limpio.evidencia).not.toMatch(/bug-e8-1-alterado\.pdf/)
  }, 60_000)
})
