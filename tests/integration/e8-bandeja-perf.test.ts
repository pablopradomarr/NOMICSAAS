/**
 * E8 · criterio 31 — **la bandeja se pinta en menos de 150 ms con 2 000
 * documentos y 6 000 extracciones**.
 *
 * El revisor lo anotó como el único criterio de la épica sin test (#11):
 * `e8-extraccion-fx.test.ts` demuestra que la bandeja **no hace N+1** —cuenta
 * consultas—, y eso no es lo mismo que medir el tiempo. Un `DISTINCT ON` sin el
 * índice adecuado tampoco hace N+1 y tarda un segundo.
 *
 * Qué se mide, exactamente lo que consume la pantalla `/unsorted`:
 *
 *  1. `countPendingByStatus` — los seis contadores de cabecera, en un agregado;
 *  2. `listInboxWithLatestRun` — la página de la bandeja con el último run de
 *     cada fichero (`DISTINCT ON (file_id)` sobre el índice
 *     `(organization_id, file_id, created_at DESC)` que creó T2);
 *  3. los veredictos sellados de los runs listados y el recuento de
 *     extracciones por fichero, que son las otras dos consultas fijas.
 *
 * Todo dentro de UNA transacción de tenant, como en el render real.
 *
 * El techo son 150 ms para la **mediana** de varias pasadas, no para la
 * primera: la primera paga la compilación del plan y el arranque del pool, que
 * no es lo que el criterio mide. Se registra también el peor caso, para que una
 * regresión que sólo se vea a ratos deje rastro en la salida.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const { prisma, tenantTransaction } = await import("@/lib/db")
const { countPendingByStatus, listInboxWithLatestRun } = await import("@/models/extraction")

const ORG = "e8bb0000-0000-4000-8000-00000000001a"
const USER = "e8bb0000-0000-4000-8000-0000000e0001"

/** Criterio 31 del diseño. */
const MAX_MS = 150
const FILES = 2_000
const RUNS_PER_FILE = 3
const PAGE_SIZE = 100

describe.skipIf(!TEST_DATABASE_URL)("E8 · criterio 31 · la bandeja con 2 000 ficheros y 6 000 extracciones", () => {
  async function cleanup(): Promise<void> {
    for (const table of ["extraction_runs", "files", "memberships"]) {
      await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
    }
    await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER).catch(() => undefined)
  }

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e8-bandeja-perf@test.local", name: "Perf" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e8-bandeja-perf", name: "E8 bandeja perf", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })

    /**
     * Siembra en SQL masivo y no por el camino de la aplicación: son 8 000
     * filas y lo que se mide es la lectura, no la escritura. Los `reconcile`
     * sellados llevan la forma real (`status`, `checks`, `elegibleParaLote`)
     * porque la bandeja los lee para decidir la elegibilidad de cada fila.
     */
    await prisma.$executeRawUnsafe(
      `INSERT INTO files (id, organization_id, uploaded_by_id, filename, path, mimetype, sha256, size_bytes, is_reviewed, created_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid,
              'doc-' || i || '.pdf', 'unsorted/doc-' || i || '.pdf', 'application/pdf',
              lpad(to_hex(i), 64, '0'), 2048, false,
              now() - (i || ' minutes')::interval
         FROM generate_series(1, ${FILES}) AS i`,
      ORG,
      USER
    )
    await prisma.$executeRawUnsafe(
      `INSERT INTO extraction_runs
         (id, organization_id, file_id, file_sha256, kind, provider, model, prompt_code, prompt_source,
          prompt_sha, schema_version, schema_sha, pages_sent, pages_total, raw_output, proposal,
          reconcile, reconcile_status, duration_ms, git_sha, created_at)
       SELECT gen_random_uuid(), $1::uuid, f.id, f.sha256, 'LLM', 'openai', 'gpt-4o-mini', 'extraccion', 'GIT',
              repeat('b', 64), 'v1', repeat('c', 64), 1, 1, '{}'::jsonb,
              jsonb_build_object(
                'docKind', 'FACTURA_RECIBIDA',
                'documentNumber', 'FRA-' || f.filename,
                'currency', 'EUR',
                'totalCents', 121000
              ),
              jsonb_build_object('status', 'PASS', 'elegibleParaLote', true, 'checks', '[]'::jsonb, 'sellos', '[]'::jsonb),
              'PASS', 120, 'abc1234',
              f.created_at + (r || ' seconds')::interval
         FROM files f, generate_series(1, ${RUNS_PER_FILE}) AS r
        WHERE f.organization_id = $1::uuid`,
      ORG
    )

    // Estadísticas frescas: sin ANALYZE el planificador improvisa y la medida
    // dice más del optimizador que de la consulta.
    await prisma.$executeRawUnsafe("ANALYZE files")
    await prisma.$executeRawUnsafe("ANALYZE extraction_runs")
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it(`carga 8 000 filas y las lee en menos de ${MAX_MS} ms (criterio 31)`, async () => {
    const files = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM files WHERE organization_id = $1::uuid`,
      ORG
    )
    const runs = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM extraction_runs WHERE organization_id = $1::uuid`,
      ORG
    )
    expect(Number(files[0].n)).toBe(FILES)
    expect(Number(runs[0].n)).toBe(FILES * RUNS_PER_FILE)

    /** Exactamente las cuatro consultas del render de `/unsorted`. */
    const render = async (offset: number): Promise<number> =>
      await tenantTransaction(ORG, USER, async (tx) => {
        await countPendingByStatus(tx)
        const inbox = await listInboxWithLatestRun(tx, { limit: PAGE_SIZE, offset })
        const runIds = inbox.rows.map((row) => row.runId).filter((id): id is string => Boolean(id))
        await tx.extractionRun.findMany({ where: { id: { in: runIds } }, select: { id: true, reconcile: true } })
        await tx.extractionRun.groupBy({
          by: ["fileId"],
          where: { fileId: { in: inbox.rows.map((row) => row.fileId) } },
          _count: { _all: true },
        })
        return inbox.total
      })

    // Calentamiento: plan de consulta y conexión del pool. No cuenta.
    const total = await render(0)
    expect(total).toBe(FILES)

    const samples: number[] = []
    // Páginas distintas a propósito: el `OFFSET` de la paginación (revisor #10)
    // también entra en la medida, no sólo la primera página.
    for (const offset of [0, 100, 500, 1_000, 1_900, 0, 300]) {
      const started = performance.now()
      await render(offset)
      samples.push(performance.now() - started)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const worst = sorted[sorted.length - 1]

    expect(
      `mediana ${median.toFixed(1)} ms · peor ${worst.toFixed(1)} ms · ${FILES} ficheros / ${FILES * RUNS_PER_FILE} runs`
    ).toBeTruthy()
    expect(median, `la bandeja tarda ${median.toFixed(1)} ms (peor caso ${worst.toFixed(1)} ms)`).toBeLessThan(MAX_MS)
  }, 300_000)

  it("la paginación no trunca en silencio: la última página existe y el total es el de la base", async () => {
    const ultima = await tenantTransaction(
      ORG,
      USER,
      async (tx) => await listInboxWithLatestRun(tx, { limit: PAGE_SIZE, offset: FILES - PAGE_SIZE })
    )
    expect(ultima.rows).toHaveLength(PAGE_SIZE)
    expect(ultima.total).toBe(FILES)
    const masAlla = await tenantTransaction(
      ORG,
      USER,
      async (tx) => await listInboxWithLatestRun(tx, { limit: PAGE_SIZE, offset: FILES })
    )
    expect(masAlla.rows).toHaveLength(0)
  }, 120_000)
})
