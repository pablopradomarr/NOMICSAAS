/**
 * E8 · ola B (T6, T10, T11, T12) — contra Postgres de verdad.
 *
 * Tres cosas que sólo se pueden demostrar con la base delante:
 *
 *  1. **El run es inmutable de verdad.** No «no exponemos un update»: el rol con
 *     el que la aplicación conecta (`app_runtime`, NOBYPASSRLS) recibe **42501**
 *     al intentar `UPDATE` o `DELETE` sobre `extraction_runs`. Si eso no fuera
 *     cierto, `ExtractionRun` sería `cachedParseResult` con otro nombre y la
 *     trazabilidad de cada asiento sería una promesa.
 *  2. **La revisión humana encadena, no pisa** (ADR-0014 D5): un run
 *     `kind = MANUAL` con `parentRunId` al run del LLM, y las dos versiones
 *     legibles.
 *  3. **La tasa se persiste y se reutiliza** (ADR-0014 D2, G-04): la primera
 *     conversión llama a la fuente única, la segunda **no**, y lo que se guarda
 *     es la fecha REAL de publicación del BCE, no la que se pidió.
 *
 * Más la bandeja sin N+1 y el append-only de `prompt_versions`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "pg"

import { appRuntimeDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e8b00000-0000-4000-8000-000000000001"
const USER = "e8b00000-0000-4000-8000-0000000000a1"
const FILE_A = "e8b00000-0000-4000-8000-0000000000f1"
const FILE_B = "e8b00000-0000-4000-8000-0000000000f2"
const FILE_C = "e8b00000-0000-4000-8000-0000000000f3"

/** Par de divisas de prueba de la ISO 4217 (XTS = «para pruebas»). */
const FROM = "XTS"
const TO = "XXX"

const SHA = (c: string) => c.repeat(64)

const { prisma, tenantDb } = await import("@/lib/db")
const {
  countPendingByStatus,
  createExtractionRun,
  createRevisionRun,
  getRunChain,
  listInboxWithLatestRun,
  listRunsForFile,
} = await import("@/models/extraction")
const { createPromptVersion, getActivePromptVersion, listPromptVersions, setActivePromptVersion } = await import(
  "@/models/prompts"
)
const { resolvePrompt } = await import("@/ai/prompt")
const { ExchangeRateUnavailableError, getOrFetchRate, listRatesForPeriod, newRateMemo } = await import("@/lib/fx/rates")
const { convertProposalToBase } = await import("@/models/fx")

const db = tenantDb(ORG)

type Proposal = import("@/lib/extraction/types").ExtractionProposal

const baseProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  version: 1,
  docKind: "FACTURA_RECIBIDA",
  documentNumber: "F-2026/1",
  counterparty: { name: "Acme", taxId: "B12345674", id: null },
  documentDate: "2026-03-04",
  receptionDate: "2026-03-10",
  currency: "EUR",
  lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA21" }],
  taxes: [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }],
  totalCents: 121_000,
  ...overrides,
})

const runInput = (fileId: string, extra: Record<string, unknown> = {}) => ({
  fileId,
  fileSha256: SHA("a"),
  kind: "LLM" as const,
  provider: "openai",
  model: "gpt-test",
  attempts: [{ provider: "openai", model: "gpt-test", ok: true, ms: 12 }],
  promptCode: "extraction",
  promptSource: "GIT" as const,
  promptSha: SHA("b"),
  schemaVersion: "v1",
  schemaSha: SHA("c"),
  pagesSent: 2,
  pagesTotal: 2,
  rawOutput: { totalCents: 121_000 },
  proposal: baseProposal(),
  fieldOrigins: { totalCents: { value: 121_000, origin: "llm", confidence: "interpretacion_ia" } },
  durationMs: 1_234,
  createdById: USER,
  ...extra,
})

/**
 * `exchange_rates` es append-only también para el propietario (FORCE +
 * RESTRICTIVE). Para dejar la base como estaba hay que levantar el FORCE, que
 * es el mismo patrón documentado para los backfills de las migraciones, y
 * volver a ponerlo. Si el test se cayera en medio, el `afterAll` lo restaura.
 */
async function purgeTestRates() {
  await prisma.$executeRawUnsafe(`ALTER TABLE exchange_rates NO FORCE ROW LEVEL SECURITY`)
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM exchange_rates WHERE "from" = $1`, FROM)
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY`)
  }
}

async function cleanup() {
  // `extraction_runs` y `prompt_versions` no admiten DELETE ni para el
  // propietario; el borrado en cascada de la organización SÍ, porque la
  // integridad referencial no pasa por las políticas.
  await prisma.organization.deleteMany({ where: { id: ORG } })
  await prisma.user.deleteMany({ where: { id: USER } })
  await purgeTestRates()
}

describe.skipIf(!TEST_DATABASE_URL)("E8 ola B — extracción, prompts y divisa", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e8b@test.local", name: "Ola B" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e8-ola-b", name: "Ola B SL", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    for (const [id, name] of [
      [FILE_A, "a.pdf"],
      [FILE_B, "b.pdf"],
      [FILE_C, "c.pdf"],
    ] as const) {
      await prisma.file.create({
        data: {
          id,
          organizationId: ORG,
          filename: name,
          path: `/tmp/${name}`,
          mimetype: "application/pdf",
          sha256: SHA(id.slice(-1)),
        },
      })
    }
  }, 60_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("run inmutable (T11/T12, I-E8-3)", () => {
    it("app_runtime NO puede modificar ni borrar un run: 42501", async () => {
      const run = await createExtractionRun(db, runInput(FILE_A))

      const client = new Client({ connectionString: appRuntimeDatabaseUrl(ownerDatabaseUrl()) })
      await client.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.current_org', $1, true)", [ORG])
        await client.query("SELECT set_config('app.current_user', $1, true)", [USER])

        const visible = await client.query("SELECT id FROM extraction_runs WHERE id = $1::uuid", [run.id])
        expect(visible.rowCount).toBe(1)

        await expect(
          client.query("UPDATE extraction_runs SET model = 'trucado' WHERE id = $1::uuid", [run.id])
        ).rejects.toMatchObject({ code: "42501" })

        await client.query("ROLLBACK")
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.current_org', $1, true)", [ORG])

        await expect(
          client.query("DELETE FROM extraction_runs WHERE id = $1::uuid", [run.id])
        ).rejects.toMatchObject({ code: "42501" })
        await client.query("ROLLBACK")
      } finally {
        await client.end()
      }
    })

    it("el sello de la propuesta se calcula al insertar y no viene del llamante", async () => {
      const run = await createExtractionRun(db, runInput(FILE_A))
      expect(run.proposalSha).toMatch(/^[0-9a-f]{64}$/)
      const { proposalHash } = await import("@/lib/extraction/hash")
      expect(run.proposalSha).toBe(proposalHash(baseProposal()))
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("run de revisión encadenado (ADR-0014 D5)", () => {
    it("la revisión es un run NUEVO colgado del run del LLM, y el original sigue intacto", async () => {
      const parent = await createExtractionRun(db, runInput(FILE_B, { pagesSent: 4, pagesTotal: 9 }))
      expect(parent.partial).toBe(true) // lo escribe el trigger (G-02)

      const corrected = baseProposal({ totalCents: 121_050, documentNumber: "F-2026/1-BIS" })
      const revision = await createRevisionRun(db, {
        parentRunId: parent.id,
        proposal: corrected,
        fieldOrigins: { totalCents: { value: 121_050, origin: "usuario", confidence: "verificado" } },
        reconcile: { status: "PASS", detail: { checks: [] } },
        actorId: USER,
      })

      expect(revision.kind).toBe("MANUAL")
      expect(revision.parentRunId).toBe(parent.id)
      expect(revision.provider).toBe("humano")
      expect(revision.fileId).toBe(parent.fileId)
      expect(revision.fileSha256).toBe(parent.fileSha256)
      expect(revision.promptSha).toBe(parent.promptSha)
      // Una persona vio el documento entero: la revisión NUNCA es parcial (D5).
      expect(revision.partial).toBe(false)
      expect(revision.reconcileStatus).toBe("PASS")

      const original = await prisma.extractionRun.findUnique({ where: { id: parent.id } })
      expect((original?.proposal as { totalCents: number }).totalCents).toBe(121_000)

      const chain = await getRunChain(db, revision.id)
      expect(chain.map((run) => run.kind)).toEqual(["LLM", "MANUAL"])

      const runs = await listRunsForFile(db, FILE_B)
      expect(runs).toHaveLength(2)
    })

    it("no se puede encadenar a un run de otra organización", async () => {
      await expect(
        createRevisionRun(db, {
          parentRunId: "00000000-0000-4000-8000-000000000000",
          proposal: baseProposal(),
          fieldOrigins: {},
          actorId: USER,
        })
      ).rejects.toThrow(/no existe/)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("bandeja sin N+1 (T12, §9)", () => {
    it("devuelve el ÚLTIMO run de cada fichero y el total en una sola consulta", async () => {
      const page = await listInboxWithLatestRun(db, { limit: 50 })
      const byFile = new Map(page.rows.map((row) => [row.fileId, row]))

      expect(page.total).toBe(3)
      expect(byFile.get(FILE_C)?.runId).toBeNull() // subido y sin analizar
      expect(byFile.get(FILE_B)?.runKind).toBe("MANUAL") // el más reciente, no el primero
      expect(byFile.get(FILE_B)?.documentNumber).toBe("F-2026/1-BIS")
      expect(byFile.get(FILE_A)?.totalCents).toBe(121_000)
    })

    it("los recuentos salen agregados, sin materializar la bandeja", async () => {
      const counts = await countPendingByStatus(db)
      expect(counts.total).toBe(3)
      expect(counts.sinRun).toBe(1)
      expect(counts.pass).toBe(1)
      expect(counts.partial).toBe(0) // el último run de B es la revisión, no parcial
    })

    it("filtra por estado de reconciliación", async () => {
      const soloPass = await listInboxWithLatestRun(db, { status: "PASS" })
      expect(soloPass.rows.map((row) => row.fileId)).toEqual([FILE_B])
      const sinRun = await listInboxWithLatestRun(db, { status: "SIN_RUN" })
      expect(sinRun.rows.map((row) => row.fileId)).toEqual([FILE_C])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("prompts append-only (T6, G-10)", () => {
    it("una versión nueva se INSERTA; el mismo contenido no duplica", async () => {
      const first = await createPromptVersion(db, { code: "extraction", content: "Prompt propio v1", createdById: USER })
      expect(first.version).toBe(1)

      const same = await createPromptVersion(db, { code: "extraction", content: "Prompt propio v1" })
      expect(same.id).toBe(first.id)

      const second = await createPromptVersion(db, { code: "extraction", content: "Prompt propio v2" })
      expect(second.version).toBe(2)
      expect(second.sha256).not.toBe(first.sha256)

      expect(await listPromptVersions(db, "extraction")).toHaveLength(2)
    })

    it("la versión vigente es un Setting, y resolvePrompt la respeta", async () => {
      const versions = await listPromptVersions(db, "extraction")
      const v2 = versions.find((version) => version.version === 2)!

      expect(await resolvePrompt(db, "extraction")).toMatchObject({ source: "GIT" })

      await setActivePromptVersion(db, "extraction", v2.id)
      expect((await getActivePromptVersion(db, "extraction"))?.id).toBe(v2.id)

      const resolved = await resolvePrompt(db, "extraction")
      expect(resolved.source).toBe("ORG")
      expect(resolved.content).toBe("Prompt propio v2")
      expect(resolved.versionId).toBe(v2.id)

      await setActivePromptVersion(db, "extraction", null)
      expect(await resolvePrompt(db, "extraction")).toMatchObject({ source: "GIT" })
    })

    it("app_runtime tampoco puede reescribir una PromptVersion", async () => {
      const [version] = await listPromptVersions(db, "extraction")
      const client = new Client({ connectionString: appRuntimeDatabaseUrl(ownerDatabaseUrl()) })
      await client.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.current_org', $1, true)", [ORG])
        await expect(
          client.query("UPDATE prompt_versions SET content = 'trucado' WHERE id = $1::uuid", [version.id])
        ).rejects.toMatchObject({ code: "42501" })
        await client.query("ROLLBACK")
      } finally {
        await client.end()
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("tasa persistida y reutilizada (T10, ADR-0014 D2 / G-04)", () => {
    const realFetch = globalThis.fetch

    beforeEach(async () => {
      await purgeTestRates()
    })

    afterAll(() => {
      globalThis.fetch = realFetch
    })

    /** Frankfurter de mentira: publica el viernes, no el domingo. */
    function fakeFrankfurter(published: Record<string, number>) {
      return vi.fn(async () =>
        new Response(
          JSON.stringify({
            base: FROM,
            rates: Object.fromEntries(Object.entries(published).map(([day, rate]) => [day, { [TO]: rate }])),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    }

    it("la primera vez consulta la fuente; la segunda ya NO", async () => {
      const spy = fakeFrankfurter({ "2026-03-04": 1.083333 })
      globalThis.fetch = spy as unknown as typeof fetch

      const first = await getOrFetchRate(db, "2026-03-04", FROM, TO)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(first.rateMicro).toBe(BigInt(1_083_333))
      expect(first.source).toBe("ECB_FRANKFURTER")
      expect(first.rateDate).toBe("2026-03-04")
      expect(first.id).not.toBeNull()

      const second = await getOrFetchRate(db, "2026-03-04", FROM, TO)
      expect(spy).toHaveBeenCalledTimes(1) // la caché es la TABLA, no la memoria
      expect(second.id).toBe(first.id)
      expect(second.rateMicro).toBe(first.rateMicro)
    })

    it("si el BCE no publicó ese día, se persiste la fecha REAL, anterior", async () => {
      const spy = fakeFrankfurter({ "2026-03-06": 1.1, "2026-03-05": 1.09 })
      globalThis.fetch = spy as unknown as typeof fetch

      // 8 de marzo de 2026 es domingo.
      const hit = await getOrFetchRate(db, "2026-03-08", FROM, TO)
      expect(hit.rateDate).toBe("2026-03-06")
      expect(hit.rateMicro).toBe(BigInt(1_100_000))

      const stored = await listRatesForPeriod(db, "2026-03-01", "2026-03-31", { from: FROM, to: TO })
      expect(stored.map((rate) => rate.rateDate)).toEqual(["2026-03-06"])
    })

    it("el memo por PETICIÓN evita la ráfaga: 50 facturas del mismo día, una consulta", async () => {
      const spy = fakeFrankfurter({ "2026-03-04": 1.083333 })
      globalThis.fetch = spy as unknown as typeof fetch
      const memo = newRateMemo()

      for (let i = 0; i < 50; i += 1) {
        await getOrFetchRate(db, "2026-03-04", FROM, TO, memo)
      }
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it("misma moneda: identidad, sin red y sin fila", async () => {
      const spy = fakeFrankfurter({})
      globalThis.fetch = spy as unknown as typeof fetch
      const hit = await getOrFetchRate(db, "2026-03-04", "EUR", "EUR")
      expect(hit.rateMicro).toBe(BigInt(1_000_000))
      expect(hit.id).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    })

    it("si la fuente no responde, LANZA: no se inventa una tasa", async () => {
      globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
      await expect(getOrFetchRate(db, "2026-03-04", FROM, TO)).rejects.toBeInstanceOf(ExchangeRateUnavailableError)
    })

    it("si la fuente no publica ese par, LANZA en vez de devolver cero", async () => {
      globalThis.fetch = fakeFrankfurter({}) as unknown as typeof fetch
      await expect(getOrFetchRate(db, "2026-03-04", FROM, TO)).rejects.toThrow(/No hay tasa/)
    })

    it("convertProposalToBase resuelve la tasa del documento y cierra con residuo cero", async () => {
      globalThis.fetch = fakeFrankfurter({ "2026-03-04": 1.083333 }) as unknown as typeof fetch

      const { proposal, rate, report } = await convertProposalToBase(
        db,
        baseProposal({
          currency: FROM,
          lines: [
            { kind: "OPERACION", baseCents: 3_333, taxRateCode: "IVA21" },
            { kind: "OPERACION", baseCents: 3_334, taxRateCode: "IVA10" },
          ],
          taxes: [
            { taxRateCode: "IVA21", baseCents: 3_333, quotaCents: 700 },
            { taxRateCode: "IVA10", baseCents: 3_334, quotaCents: 333 },
          ],
          totalCents: 7_700,
        }),
        TO
      )

      expect(rate.rateDate).toBe("2026-03-04")
      expect(report.residualCents).toBe(0)
      expect(proposal.currency).toBe(TO)
      const suma =
        proposal.lines.reduce((acc, line) => acc + line.baseCents, 0) +
        proposal.taxes.reduce((acc, tax) => acc + tax.quotaCents, 0)
      expect(suma).toBe(proposal.totalCents)
    })

    it("sin fecha de documento no hay tasa que aplicar", async () => {
      await expect(
        convertProposalToBase(db, baseProposal({ currency: FROM, documentDate: null }), TO)
      ).rejects.toThrow(/Sin fecha de documento/)
    })
  })
})
