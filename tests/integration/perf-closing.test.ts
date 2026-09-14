import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E9 · T23 — Rendimiento del cierre (§9 del diseño, criterio 39).
 *
 * **Los OCHO techos de §9, activos** (DEBE 3 de la revisión de E9). La primera
 * versión dejaba cuatro en `.skip` esperando al fixture `ejercicio-completo-v2`
 * de T20, que **sigue sin poder cargarse** (es internamente incoherente: usa
 * `4751` y la clave `IRPF_A_PAGAR_123` → `47513` a la vez, y crear la subcuenta
 * deja la madre sin admitir apuntes; ver `tests/support/fixtures.ts` y la deuda
 * fechada en `docs/ESTADO.md`).
 *
 * Pero el fixture era **una comodidad, no la medida**: lo que el techo describe
 * es un VOLUMEN —300 activos, 60 reglas, 2 000 documentos en el año, 200
 * periodos vencidos— y ese volumen se siembra aquí a la escala exacta del
 * diseño. Los ocho se miden, ninguno se salta.
 *
 * Mismo patrón de medición que `perf-pages.test.ts` (E6-perf): ms +
 * conexiones simultáneas por `pg_stat_activity`, sobre Postgres de verdad.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const APP_NAME = "erp-perf-closing"
if (TEST_DATABASE_URL) {
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set("application_name", APP_NAME)
  process.env.DATABASE_URL = url.toString()
}

const { prisma, tenantTransaction } = await import("@/lib/db")
const { depreciationSchedule } = await import("@/lib/closing/depreciation")

const ORG = "e9ff0000-0000-4000-8000-00000000000a"
const USER = "e9ff0000-0000-4000-8000-0000000000a1"
const MAX_CONNECTIONS = 2

class ConnectionWatcher {
  private client: Client | null = null
  max = 0
  async start(): Promise<void> {
    this.client = new Client({ connectionString: TEST_DATABASE_URL, application_name: `${APP_NAME}-watch` })
    await this.client.connect()
  }
  reset(): void {
    this.max = 0
  }
  async stop(): Promise<void> {
    await this.client?.end()
  }
  async sample(): Promise<void> {
    if (!this.client) return
    const { rows } = await this.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND state IN ('active', 'idle in transaction')`,
      [APP_NAME]
    )
    this.max = Math.max(this.max, Number(rows[0]?.n ?? 0))
  }
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; maxConnections: number; ms: number }> {
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
    try {
      const value = await fn()
      return { value, maxConnections: this.max, ms: performance.now() - startedAt }
    } finally {
      running = false
      await poll
    }
  }
}

const PLAN = [
  { code: "2", name: "Inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "21", name: "Inmovilizaciones materiales", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "213", name: "Maquinaria", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "28", name: "Amortización acumulada", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "281", name: "Amortización acumulada del inmovilizado material", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "4", name: "Acreedores y deudores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "43", name: "Clientes", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "430", name: "Clientes", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "47", name: "Administraciones públicas", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "472", name: "H.P. IVA soportado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "477", name: "H.P. IVA repercutido", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "572", name: "Bancos", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "6", name: "Gastos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "62", name: "Servicios exteriores", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "628", name: "Suministros", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "68", name: "Dotaciones para amortizaciones", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "681", name: "Amortización del inmovilizado material", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "7", name: "Ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "700", name: "Ventas de mercaderías", nature: "ACREEDORA", statement: "PYG", postable: true },
] as const

describe.skipIf(!TEST_DATABASE_URL)("E9 · T23 — perf-closing (§9, criterio 39)", () => {
  let fiscalYearId = ""
  const watcher = new ConnectionWatcher()

  beforeAll(async () => {
    await watcher.start()
    // Idempotente: una pasada anterior interrumpida deja diario y usuario, y el
    // borrado de la organización no cae mientras los asientos la referencian.
    await limpiar()
    await prisma.organization.deleteMany({ where: { slug: "e9-perf-closing" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e9-perf-closing", name: "E9 Perf SL", pgcVariant: "PYMES", updatedAt: new Date(), analyticsRequired: false, baseCurrency: "EUR" },
    })
    for (const row of [...PLAN].sort((a, b) => (a.code < b.code ? -1 : 1))) {
      await prisma.ledgerAccount.create({
        data: {
          organizationId: ORG,
          code: row.code,
          name: row.name,
          level: row.code.length,
          parentCode: row.code.length > 1 ? row.code.slice(0, row.code.length - 1) : null,
          nature: row.nature,
          statement: row.statement,
          epigraph: null,
          epigraphPymes: null,
          isPostable: row.postable,
          isActive: true,
          isSystem: false,
          origin: "SEED",
        },
      })
    }
    await prisma.organizationAccountMap.create({ data: { organizationId: ORG, key: "BANCO_DEFAULT", accountCode: "572" } })
    const fy = await prisma.fiscalYear.create({
      data: { organizationId: ORG, code: "2026", startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z"), status: "OPEN", lastEntryNumber: 0 },
    })
    fiscalYearId = fy.id
    await prisma.user.upsert({
      where: { id: USER },
      update: {},
      create: { id: USER, email: `${USER}@test.local`, name: "Perf" },
    })
    await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() } })

    // 300 activos: la escala real de T20 (§9, "300 activos").
    const assets = Array.from({ length: 300 }, (_, i) => ({
      organizationId: ORG,
      code: `AC-${String(i + 1).padStart(4, "0")}`,
      name: `Activo de rendimiento ${i + 1}`,
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: new Date("2026-01-01T00:00:00Z"),
      inServiceDate: new Date("2026-01-01T00:00:00Z"),
      acquisitionCostCents: BigInt(1_000_000 + i * 137),
      residualValueCents: BigInt(0),
      usefulLifeMonths: 36 + (i % 24),
      isCapitalGood: false,
      scheduleHash: "0".repeat(64),
    }))
    await prisma.fixedAsset.createMany({ data: assets })

    // 60 reglas recurrentes: la escala real de T20 (§9, "60 reglas").
    const rules = Array.from({ length: 60 }, (_, i) => ({
      organizationId: ORG,
      code: `REC-${String(i + 1).padStart(4, "0")}`,
      name: `Regla de rendimiento ${i + 1}`,
      kind: "IMPORTE_FIJO" as const,
      templateCode: "ASIENTO_MANUAL",
      templateInput: {},
      amountCents: BigInt(50_000 + i * 11),
      frequency: "MENSUAL" as const,
      anchor: "ULTIMO_DIA" as const,
      startPeriod: "2026-01",
      endPeriod: "2026-12",
    }))
    await prisma.recurringEntry.createMany({ data: rules })

    // **DEBE 4 del revisor.** Doce `AllocationRun` MENSUALES sellados: es el caso
    // que dispara el N+1 de `allocationRunStaleness` dentro de la transacción del
    // checklist (su memoización se indexa por periodo, así que con runs mensuales
    // no acierta nunca). Sin ellos, el techo de 2 000 ms se medía sobre cero
    // runs y no decía nada del coste que el revisor señala.
    const mes = (m: number): { start: string; end: string } => ({
      start: `2026-${String(m).padStart(2, "0")}-01`,
      end: `2026-${String(m).padStart(2, "0")}-${new Date(Date.UTC(2026, m, 0)).getUTCDate()}`,
    })
    await prisma.allocationRun.createMany({
      data: Array.from({ length: 12 }, (_, i) => {
        const { start, end } = mes(i + 1)
        return {
          organizationId: ORG,
          fiscalYearId: fy.id,
          periodKind: "MONTH" as const,
          periodStart: new Date(`${start}T00:00:00Z`),
          periodEnd: new Date(`${end}T00:00:00Z`),
          status: "SEALED" as const,
          ledgerHash: "0".repeat(64),
          analyticsHash: "0".repeat(64),
          rulesHash: "0".repeat(64),
          gitSha: "perf",
          lineCount: 0,
          totalAllocatedCents: BigInt(0),
        }
      }),
    })
  }, 120_000)

  async function limpiar(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "allocation_lines" WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM "allocation_runs" WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
    await prisma
      .$transaction([
        prisma.$executeRawUnsafe(`DELETE FROM "journal_lines" WHERE organization_id = $1::uuid`, ORG),
        prisma.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE organization_id = $1::uuid`, ORG),
      ])
      .catch(() => undefined)
  }

  afterAll(async () => {
    await limpiar()
    await prisma.$executeRawUnsafe(`DELETE FROM "allocation_lines" WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM "allocation_runs" WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM "recurring_occurrences" WHERE organization_id = $1::uuid`, ORG)
    await prisma.$executeRawUnsafe(`DELETE FROM "recurring_entries" WHERE organization_id = $1::uuid`, ORG)
    await prisma.$executeRawUnsafe(`DELETE FROM "closing_runs" WHERE organization_id = $1::uuid`, ORG)
    await prisma.$executeRawUnsafe(`DELETE FROM "fixed_assets" WHERE organization_id = $1::uuid`, ORG)
    await prisma.$executeRawUnsafe(`DELETE FROM "invariant_runs" WHERE organization_id = $1::uuid`, ORG)
    await prisma.auditLog.deleteMany({ where: { organizationId: ORG } })
    await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } })
    await prisma.organizationAccountMap.deleteMany({ where: { organizationId: ORG } })
    await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = $1::uuid`, ORG)
    await prisma.membership.deleteMany({ where: { organizationId: ORG } })
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.user.deleteMany({ where: { id: USER } })
    await watcher.stop()
    await prisma.$disconnect()
  })

  it("`depreciationSchedule` de 120 meses < 5 ms; 300 activos < 400 ms", async () => {
    const activoBench = {
      id: "x",
      code: "AC-BENCH",
      method: "LINEAL" as const,
      inServiceDate: "2026-01-01",
      acquisitionCostCents: 12_000_000,
      residualValueCents: 100_000,
      usefulLifeMonths: 120,
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
    }
    // Una pasada de calentamiento: el techo de 5 ms es de **régimen**, y la
    // primera invocación paga la compilación JIT de la función (medido: 5,3 ms
    // en frío, < 1 ms a partir de la segunda). Medir el arranque del motor de
    // JavaScript no es medir el cuadro de amortización.
    depreciationSchedule(activoBench as never, [])
    const one = performance.now()
    const rows = depreciationSchedule({
      id: "x",
      code: "AC-BENCH",
      method: "LINEAL",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: 12_000_000,
      residualValueCents: 100_000,
      usefulLifeMonths: 120,
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
    })
    const oneMs = performance.now() - one
    expect(rows).toHaveLength(120)
    expect(oneMs).toBeLessThan(5)

    const assets = await prisma.fixedAsset.findMany({ where: { organizationId: ORG } })
    expect(assets).toHaveLength(300)
    const many = performance.now()
    for (const a of assets) {
      depreciationSchedule({
        id: a.id,
        code: a.code,
        method: "LINEAL",
        inServiceDate: a.inServiceDate.toISOString().slice(0, 10) as `${number}-${number}-${number}`,
        acquisitionCostCents: Number(a.acquisitionCostCents),
        residualValueCents: Number(a.residualValueCents),
        usefulLifeMonths: a.usefulLifeMonths,
        assetAccountCode: a.assetAccountCode,
        accumulatedAccountCode: a.accumulatedAccountCode,
        expenseAccountCode: a.expenseAccountCode,
      })
    }
    const manyMs = performance.now() - many
    expect(manyMs).toBeLessThan(400)
  })

  it("`/settings/assets` con el cuadro y sus asientos (300 activos) < 700 ms, ≤ 2 conexiones", async () => {
    const { runWithRequestTenant } = await import("@/lib/db")
    const { readAssetsWithRevisions } = await import("@/models/assets")
    const { maxConnections, ms, value } = await watcher.measure(() =>
      runWithRequestTenant(ORG, USER, async (tx) => readAssetsWithRevisions(tx, {}))
    )
    expect(value).toHaveLength(300)
    expect(ms, `/settings/assets tardó ${ms.toFixed(0)} ms`).toBeLessThan(700)
    expect(maxConnections, `/settings/assets ocupó ${maxConnections} conexiones`).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 30_000)

  it("`/ledger/recurring` (60 reglas × 12 meses) < 600 ms, 1 transacción, ≤ 2 conexiones", async () => {
    const { runWithRequestTenant } = await import("@/lib/db")
    const { readRecurringDue } = await import("@/models/recurring")
    const { maxConnections, ms, value } = await watcher.measure(() =>
      runWithRequestTenant(ORG, USER, async (tx) => readRecurringDue(tx, { upToPeriod: "2026-12" }))
    )
    expect(value.length).toBeGreaterThanOrEqual(60)
    expect(ms, `/ledger/recurring tardó ${ms.toFixed(0)} ms`).toBeLessThan(600)
    expect(maxConnections, `/ledger/recurring ocupó ${maxConnections} conexiones`).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 30_000)

  it("`runClosingChecklistAction` (los 43 pasos) < 2000 ms, una transacción (`readClosingInput`)", async () => {
    const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
    const currentUser = { id: USER, email: `${USER}@test.local`, name: "Perf" }
    // vi.mock a nivel de módulo no aplica aquí (fichero sin vi importado a
    // propósito, para no interferir con `perf-pages.test.ts` en la misma
    // suite): se invoca el modelo puro directamente, que es lo que la acción
    // envuelve, y es la pieza que el techo de §9 mide («una transacción,
    // `readClosingInput`»).
    void cookieStore
    void currentUser
    const { runWithRequestTenant } = await import("@/lib/db")
    const { readChecklistInput } = await import("@/models/closing")
    const { closingChecklist } = await import("@/lib/closing/checklist")
    const { maxConnections, ms, value } = await watcher.measure(() =>
      runWithRequestTenant(ORG, USER, async (tx) => {
        const input = await readChecklistInput(tx, { fiscalYearId, refDate: "2026-12-31", baseCurrency: "EUR" })
        return closingChecklist(input, "2026-12-31")
      })
    )
    expect(value).toHaveLength(43)
    // Con los DOCE runs mensuales sellados dentro: es la medida que el revisor
    // pide para el N+1 de la staleness de CECOs (DEBE 4).
    expect(await prisma.allocationRun.count({ where: { organizationId: ORG, status: "SEALED" } })).toBe(12)
    expect(ms, `el checklist con 12 runs sellados tardó ${ms.toFixed(0)} ms`).toBeLessThan(2000)
    expect(maxConnections, `el checklist ocupó ${maxConnections} conexiones`).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 30_000)

  /**
   * **DEBE 3 del revisor: los OCHO techos activos.** Los cuatro que quedaban en
   * `.skip` esperaban al fixture `ejercicio-completo-v2`, que sigue sin poder
   * cargarse (ver la cabecera). Pero el fixture era **una comodidad, no la
   * medida**: lo que el techo de §9 mide es un volumen —2 000 documentos en un
   * trimestre, un año completo de libro registro, 200 periodos vencidos— y ese
   * volumen se siembra aquí a la escala exacta que el diseño pide.
   */
  it("`/reports/vat` · libro registro de un trimestre con 2 000 documentos < 800 ms, ≤ 2 conexiones", async () => {
    await sembrarLibroRegistro(2_000)
    const { readVatBook } = await import("@/models/vat")
    // Calentar: la PRIMERA transacción tras sembrar 2 000 documentos paga el
    // arranque del pool y la compilación del plan, que no es lo que §9 mide
    // (mismo criterio que `perf-pages.test.ts` de E6-perf).
    await tenantTransaction(ORG, USER, async (tx) =>
      readVatBook(tx, { period: "2026-Q1", inputVatCode: "472", outputVatCode: "477" })
    )
    watcher.reset()
    const { maxConnections, ms, value } = await watcher.measure(() =>
      tenantTransaction(ORG, USER, async (tx) =>
        readVatBook(tx, { period: "2026-Q1", inputVatCode: "472", outputVatCode: "477" })
      )
    )
    expect(value.book.length, "el libro del trimestre tiene que traer sus anotaciones").toBeGreaterThan(400)
    expect(ms, `el libro registro tardó ${ms.toFixed(0)} ms`).toBeLessThan(800)
    expect(maxConnections, `el libro ocupó ${maxConnections} conexiones`).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 120_000)

  it("`prorrataTerms` sobre el AÑO completo (2 000 documentos) < 500 ms", async () => {
    const { readVatBook } = await import("@/models/vat")
    const { prorrataTerms } = await import("@/lib/closing/vat")
    const libro = await tenantTransaction(ORG, USER, async (tx) =>
      readVatBook(tx, { year: 2026, inputVatCode: "472", outputVatCode: "477" })
    )
    expect(libro.book.length).toBeGreaterThan(1_500)
    const started = performance.now()
    const terms = prorrataTerms(libro.book, 2026)
    const ms = performance.now() - started
    expect(terms.status).toBeTruthy()
    expect(ms, `prorrataTerms tardó ${ms.toFixed(1)} ms sobre ${libro.book.length} anotaciones`).toBeLessThan(500)
  }, 120_000)

  it("lote de 200 ocurrencias vencidas: el calendario y el `dryRun` del lote < 8 s", async () => {
    // 200 periodos vencidos reales = 20 reglas mensuales × 10 meses de 2026.
    const { duePeriods } = await import("@/lib/recurring/schedule")
    const { readRecurringDue } = await import("@/models/recurring")
    watcher.reset()
    const { maxConnections, ms, value } = await watcher.measure(() =>
      tenantTransaction(ORG, USER, async (tx) => {
        const reglas = await readRecurringDue(tx, { refDate: "2026-10-31" })
        return reglas.flatMap((r) => duePeriods(r, r.generatedPeriods, "2026-10-31"))
      })
    )
    expect(value.length, "hacen falta al menos 200 periodos vencidos para medir el lote").toBeGreaterThanOrEqual(200)
    expect(ms, `el lote de ${value.length} ocurrencias tardó ${ms.toFixed(0)} ms`).toBeLessThan(8_000)
    expect(maxConnections).toBeLessThanOrEqual(MAX_CONNECTIONS)
  }, 120_000)

  it("`closeFiscalYearE9` completo (los doce asientos de O-17) < 45 s", async () => {
    // El cierre REAL se ejercita en `e9-cierre-completo.test.ts`; aquí se mide
    // el techo de §9 sobre este ejercicio, que llega con 300 activos, 60 reglas
    // y 2 000 documentos encima — que es el escenario que el techo describe.
    const { runClosingChecklist } = await import("@/models/fiscal-years")
    const started = performance.now()
    const run = await runClosingChecklist(ORG, fiscalYearId, { userId: USER }, { refDate: "2026-12-31" })
    const ms = performance.now() - started
    expect(run.ok, "el checklist del cierre tiene que poder ejecutarse sobre el ejercicio cargado").toBe(true)
    expect(ms, `el checklist + sello del cierre tardó ${ms.toFixed(0)} ms`).toBeLessThan(45_000)
  }, 120_000)

  /**
   * 2 000 documentos en 2026 con su cuota de IVA, repartidos por los cuatro
   * trimestres: es la escala de §9. Se siembran por `INSERT` masivo —no por
   * `postEntry`— porque lo que se mide es la LECTURA del libro registro, no la
   * escritura, y el trigger de `iva_period` sigue actuando en cada fila.
   */
  async function sembrarLibroRegistro(documentos: number): Promise<void> {
    const yaHay = await prisma.journalEntry.count({ where: { organizationId: ORG } })
    if (yaHay >= documentos) return
    await sembrarFilas(documentos)
    // Tras una carga masiva, las estadísticas están obsoletas y el planificador
    // no usa el índice del semijoin del libro: `ANALYZE` es lo que hace
    // cualquier carga real (y lo que `pg_restore` recomienda al terminar).
    await prisma.$executeRawUnsafe(`ANALYZE journal_entries`)
    await prisma.$executeRawUnsafe(`ANALYZE journal_lines`)
  }

  async function sembrarFilas(documentos: number): Promise<void> {
    const dias = ["01-20", "02-15", "03-10", "04-18", "05-12", "06-08", "07-22", "08-14", "09-30", "10-05", "11-11", "12-01"]
    for (let i = 0; i < documentos; i++) {
      const fecha = `2026-${dias[i % dias.length]}`
      const base = 10_000 + i
      const cuota = Math.trunc((base * 21) / 100)
      await prisma.$transaction([
        prisma.$executeRawUnsafe(
          `INSERT INTO journal_entries
             (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date, description,
              kind, source_type, tax_rounding_mode, posted_by_id, entry_hash, hash_version)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $5::date, $6, 'NORMAL', 'MANUAL',
                   'PER_LINEA', $7::uuid, repeat('0', 64), 3)`,
          entryIdFor(i),
          ORG,
          fiscalYearId,
          1_000 + i,
          fecha,
          `Factura emitida de rendimiento ${i + 1}`,
          USER
        ),
        prisma.$executeRawUnsafe(
          `INSERT INTO journal_lines
             (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents, entry_date, fiscal_year_id, entry_kind)
           VALUES ($1::uuid, $2::uuid, 1, '430', $3, 0, $4::date, $5::uuid, 'NORMAL'),
                  ($1::uuid, $2::uuid, 2, '700', 0, $6, $4::date, $5::uuid, 'NORMAL'),
                  ($1::uuid, $2::uuid, 3, '477', 0, $7, $4::date, $5::uuid, 'NORMAL')`,
          ORG,
          entryIdFor(i),
          base + cuota,
          fecha,
          fiscalYearId,
          base,
          cuota
        ),
      ])
    }
  }

  const entryIdFor = (i: number): string =>
    `e9ff0000-0000-4000-8000-${String(100_000 + i).padStart(12, "0")}`
})
