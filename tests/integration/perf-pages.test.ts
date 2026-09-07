import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E6-perf · T1 — Rendimiento y coste en conexiones de los cargadores de página.
 *
 * Cierra la deuda «una transacción por operación» de `docs/ESTADO.md` con dos
 * medidas que se pueden repetir:
 *
 *  1. **Conexiones simultáneas por petición ≤ 2.** Un observador aparte muestrea
 *     `pg_stat_activity` mientras corre el cargador y se queda con el máximo de
 *     conexiones de la aplicación que están ocupadas a la vez (`active` o
 *     `idle in transaction`). Antes de E6-perf cada lectura de `tenantDb` abría
 *     su propia transacción, así que el máximo crecía con el número de lecturas
 *     de la pantalla y con `max: 10` de `pg` el pool se agotaba
 *     («Unable to start a transaction in the given time» en /settings/fiscal-years).
 *  2. **Un render = una transacción.** Se cuentan los `prisma.$transaction`
 *     —cada uno es un `BEGIN`— que abre el cargador completo. Con
 *     `runWithRequestTenant` tiene que ser exactamente **1**.
 *
 * Y un techo de tiempo (`MAX_MS`) sobre el fixture completo, para que una
 * regresión de N+1 se vea aquí y no en producción.
 *
 * Los cargadores replican las lecturas que hace cada Server Component: la
 * pantalla en sí (JSX, `requireOrg`, cookies) se ejerce en los e2e, que aquí no
 * se pueden montar. Lo que se mide es exactamente la capa que consume base.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
const APP_NAME = "erp-perf-pages"
if (TEST_DATABASE_URL) {
  // `application_name` marca las conexiones del pool de la aplicación para que
  // el observador las distinga de las suyas y de las de otros tests.
  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set("application_name", APP_NAME)
  process.env.DATABASE_URL = url.toString()
}

const { prisma, runWithRequestTenant, tenantDb, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { getPlan } = await import("@/models/accounts")
const { getAccountMap } = await import("@/models/account-map")
const { listFiscalYears } = await import("@/models/fiscal-years")
const { listPeriodLocks } = await import("@/models/period-locks")
const { computeLedgerHash, getEntries, getLinesForPeriod } = await import("@/models/ledger")
const { clearMarginCache, getAnalyticPnl } = await import("@/models/margins")
const { getDashboard } = await import("@/models/reports")
const { countUnpostedTransactions } = await import("@/models/transactions")
const { latestInvariantRun, listInvariantRuns, listAllocationRunIntegrityRefs } = await import("@/models/audit")
const { latestSweep } = await import("@/models/store-sweep")
const { readDataQuality } = await import("@/app/(app)/audit/shared")
const { listAuditLog } = await import("@/models/audit-log")
const { listBankAccounts, pendingItems } = await import("@/models/bank")
const { accountNames, entryExtras, postableAccounts } = await import("@/app/(app)/ledger/shared")
const {
  listAllocationRules,
  listAllocationRuns,
  allocationRunStaleness,
  createAllocationRulesTx,
  reverseAllocationRunTx,
  sealAllocationRunTx,
  allocationPeriodBounds,
} = await import("@/models/allocations")

const ORG = "efff0000-0000-4000-8000-00000000000a"
const USER = "efff0000-0000-4000-8000-0000000000a1"
const PERIOD = { from: "2026-01-01", to: "2026-12-31" } as const

/** Techo por cargador en local. Holgado a propósito: vigila regresiones, no microsegundos. */
const MAX_MS = 1500
/**
 * Criterio 20 de `docs/design/E5-liquidacion.md` §8.1 (revisión ronda 1, #7):
 * los DOS umbrales del diseño, medidos con los cargadores reales sobre el
 * fixture completo. No son techos genéricos: son el compromiso de la épica.
 */
const MAX_MS_LIQUIDACION_ANUAL = 400
const MAX_MS_PYG_IMPUTADA = 800
/** Objetivo del diseño: una petición no puede ocupar más de dos conexiones a la vez. */
const MAX_CONNECTIONS = 2

// ─────────────────────────────────────────────────────────────────────────────
// Instrumentación
// ─────────────────────────────────────────────────────────────────────────────

/** Muestrea `pg_stat_activity` y devuelve el máximo de conexiones ocupadas. */
class ConnectionWatcher {
  private client: Client | null = null
  private timer: NodeJS.Timeout | null = null
  max = 0

  async start(): Promise<void> {
    this.client = new Client({ connectionString: TEST_DATABASE_URL, application_name: `${APP_NAME}-watch` })
    await this.client.connect()
  }

  async sample(): Promise<void> {
    if (!this.client) return
    const { rows } = await this.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = $1
          AND state IN ('active', 'idle in transaction')`,
      [APP_NAME]
    )
    this.max = Math.max(this.max, Number(rows[0]?.n ?? 0))
  }

  /** Ejecuta `fn` muestreando en paralelo cada 5 ms. */
  async measure<T>(fn: () => Promise<T>): Promise<{ value: T; maxConnections: number; ms: number }> {
    this.max = 0
    let running = true
    const poll = (async () => {
      while (running) {
        await this.sample()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await this.sample()
    })()
    const startedAt = performance.now()
    try {
      const value = await fn()
      const ms = performance.now() - startedAt
      return { value, maxConnections: this.max, ms }
    } finally {
      running = false
      await poll
      if (this.timer) clearInterval(this.timer)
    }
  }

  async stop(): Promise<void> {
    await this.client?.end()
    this.client = null
  }
}

/**
 * Cuenta los `BEGIN` que abre `fn`: envuelve `prisma.$transaction`, que es por
 * donde pasan `tenantTransaction`, `withTenantGucs` y la envoltura por operación
 * de `tenantDb`. Si un cargador abriera una transacción por lectura, se vería.
 */
type Transactional = { $transaction: (...args: unknown[]) => unknown }

async function countTransactions<T>(fn: () => Promise<T>): Promise<{ value: T; transactions: number }> {
  const client = prisma as unknown as Transactional
  const original = client.$transaction.bind(prisma) as (...args: unknown[]) => unknown
  let transactions = 0
  client.$transaction = (...args: unknown[]) => {
    transactions += 1
    return original(...args)
  }
  try {
    const value = await fn()
    return { value, transactions }
  } finally {
    client.$transaction = original
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cargadores — las lecturas de seis pantallas reales
// ─────────────────────────────────────────────────────────────────────────────

type Loader = { route: string; run: (fiscalYearId: string) => Promise<unknown> }

const loaders: Loader[] = [
  {
    // El síntoma original: tres lecturas seguidas y el pool agotado.
    route: "/settings/fiscal-years",
    run: async () =>
      await runWithRequestTenant(
        ORG,
        USER,
        async () => {
          const db = tenantDb(ORG)
          const rows = await listFiscalYears(db)
          const locks = await listPeriodLocks(db)
          const counts = await db.journalEntry.groupBy({ by: ["fiscalYearId"], _count: { _all: true } })
          return { rows, locks, counts }
        },
        { readOnly: true }
      ),
  },
  {
    route: "/ledger",
    run: async (fiscalYearId) =>
      await runWithRequestTenant(
        ORG,
        USER,
        async () => {
          const db = tenantDb(ORG)
          const { entries } = await getEntries(db, { fiscalYearId }, { skip: 0, take: 50 })
          const names = await accountNames(db)
          const extras = await entryExtras(
            db,
            entries.map((entry) => entry.id)
          )
          const fiscalYears = await listFiscalYears(db)
          const locks = await listPeriodLocks(db)
          const accounts = await postableAccounts(db)
          return { entries, names, extras, fiscalYears, locks, accounts }
        },
        { readOnly: true }
      ),
  },
  {
    route: "/ledger/sumas-saldos",
    run: async (fiscalYearId) =>
      await runWithRequestTenant(
        ORG,
        USER,
        async (tx) => {
          const db = tenantDb(ORG)
          const fiscalYears = await listFiscalYears(db)
          const names = await accountNames(db)
          const lines = await getLinesForPeriod(tx, { ...PERIOD, fiscalYearId })
          const ledgerHash = await computeLedgerHash(tx, { ...PERIOD, fiscalYearId })
          return { fiscalYears, names, lines, ledgerHash }
        },
        { readOnly: true }
      ),
  },
  {
    route: "/settings/accounts",
    run: async () =>
      await runWithRequestTenant(
        ORG,
        USER,
        async () => {
          const db = tenantDb(ORG)
          const plan = await getPlan(db)
          const mapEntries = await getAccountMap(db)
          return { plan, mapEntries }
        },
        { readOnly: true }
      ),
  },
  {
    route: "/analytics/pyg",
    run: async (fiscalYearId) =>
      await runWithRequestTenant(ORG, USER, async (tx) => {
        const report = await getAnalyticPnl(tx, {
          ...PERIOD,
          fiscalYearId,
          provenance: { runId: "00000000-0000-4000-8000-000000000001", gitSha: "test", baseCurrency: "EUR" },
        })
        const names = await accountNames(tenantDb(ORG))
        return { report, names }
      }),
  },
  {
    // E5 · T11 — las mismas lecturas que hace `/analytics/allocations`.
    route: "/analytics/allocations",
    run: async () =>
      await runWithRequestTenant(
        ORG,
        USER,
        async () => {
          const db = tenantDb(ORG)
          const rules = await listAllocationRules(db, { includeClosed: true })
          const costCenters = await db.costCenter.findMany({ orderBy: { code: "asc" } })
          const projects = await db.project.findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
          const businessLines = await db.businessLine.findMany({ where: { isActive: true }, orderBy: { code: "asc" } })
          const fiscalYears = await db.fiscalYear.findMany({ where: { status: "OPEN" }, take: 1 })
          return { rules, costCenters, projects, businessLines, fiscalYears }
        },
        { readOnly: true }
      ),
  },
  {
    // E5 · T12 — `/analytics/allocations/runs`, con el `STALE` DERIVADO de cada
    // run: es la pantalla con más riesgo de N+1 de la épica, porque cada run
    // exige recomponer sus tres sellos.
    route: "/analytics/allocations/runs",
    run: async () =>
      await runWithRequestTenant(
        ORG,
        USER,
        async (tx) => {
          const fiscalYears = await listFiscalYears(tx)
          const runs = await listAllocationRuns(tx, {})
          const stale: unknown[] = []
          for (const run of runs) {
            if (run.status !== "SEALED") continue
            stale.push(await allocationRunStaleness(tx, run))
          }
          return { fiscalYears, runs, stale }
        },
        { readOnly: true }
      ),
  },
  {
    // E5 · criterio 20 — la PyG analítica IMPUTADA: el camino nuevo más caro
    // (matriz + imputaciones + I5 y los doce `I-E5-*`). No se medía.
    route: "/analytics/pyg?imputaciones=si",
    run: async (fiscalYearId) =>
      await runWithRequestTenant(ORG, USER, async (tx) => {
        const report = await getAnalyticPnl(tx, {
          ...PERIOD,
          fiscalYearId,
          withAllocations: true,
          provenance: { runId: "00000000-0000-4000-8000-000000000002", gitSha: "test", baseCurrency: "EUR" },
        })
        const names = await accountNames(tenantDb(ORG))
        return { report, names }
      }),
  },
  {
    /**
     * **E7 · ronda 1 (revisor DEBE 3 / BUG-E7-2).** `/audit` entró en E7 sin
     * medición y es la pantalla nueva más pesada: siete lecturas en serie y
     * `readDataQuality` con tres `take: 5000`. Los techos propios de §8 —y con
     * volumen de verdad— viven en `perf-audit.test.ts`; aquí entra en la lista
     * común para que una regresión de N+1 o de conexiones se vea junto a las
     * demás pantallas.
     */
    route: "/audit",
    run: async () =>
      await runWithRequestTenant(
        ORG,
        USER,
        async () => {
          const db = tenantDb(ORG)
          const fiscalYears = await listFiscalYears(db)
          const run = await latestInvariantRun(db)
          const history = await listInvariantRuns(db, { take: 25 })
          const sweep = await latestSweep(db)
          const dataQuality = await readDataQuality(db)
          const allocationRuns = await listAllocationRunIntegrityRefs(db)
          const logs = await listAuditLog(db, { take: 50 })
          return { fiscalYears, run, history, sweep, dataQuality, allocationRuns, logs }
        },
        { readOnly: true }
      ),
  },
  {
    /**
     * `/audit/bank`: el listado de cuentas bancarias con su cuadre. `pendingItems`
     * resuelve TODAS las cuentas en cuatro consultas agregadas; una regresión
     * que volviera a una consulta por cuenta se vería aquí.
     */
    route: "/audit/bank",
    run: async () =>
      await runWithRequestTenant(ORG, USER, async (tx) => {
        const accounts = await listBankAccounts(tx)
        const summaries = accounts.length > 0 ? await pendingItems(tx, { cutoff: PERIOD.to, baseCurrency: "EUR" }) : []
        const run = await latestInvariantRun(tx)
        return { accounts, summaries, run }
      }),
  },
  {
    // El panel EMITE un `ReportRun`: la transacción de la petición no es READ ONLY.
    route: "/dashboard",
    run: async (fiscalYearId) =>
      await runWithRequestTenant(ORG, USER, async () => {
        const db = tenantDb(ORG)
        const fiscalYears = await listFiscalYears(db)
        const unpostedDocumentCount = await countUnpostedTransactions(db)
        const run = await getDashboard(ORG, {
          periodStart: PERIOD.from,
          periodEnd: PERIOD.to,
          fiscalYearId,
          params: { refDate: PERIOD.to, variant: "PYMES", unpostedDocumentCount },
          actor: { userId: USER },
        })
        return { fiscalYears, run }
      }),
  },
]

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_DATABASE_URL)("E6-perf · una transacción por petición", () => {
  const watcher = new ConnectionWatcher()
  let fiscalYearId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "perf@test.local", name: "Perf" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "perf-org", name: "Perf Org", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })
    await loadFixtureIntoOrg({ fixture: "ejercicio-completo", organizationId: ORG, userId: USER })
    fiscalYearId = await tenantTransaction(
      ORG,
      USER,
      async (tx) => (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
    )
    // E5: la pantalla de runs sólo es representativa con runs de verdad. Una
    // regla mensual y los doce runs de 2026 ejercen el `STALE` DERIVADO, que es
    // donde una regresión de N+1 dolería (tres sellos por run).
    await tenantTransaction(ORG, USER, async (tx) => {
      const source = await tx.costCenter.findFirstOrThrow({ where: { code: "CC-OPS" } })
      await createAllocationRulesTx(
        tx,
        [
          {
            code: "AL-PERF-M",
            name: "Operaciones indirectas a proyectos (mensual)",
            sourceCostCenterId: source.id,
            targetKind: "PROJECTS",
            driver: "DIRECT_COST_SHARE",
            period: "MONTH",
            priority: 10,
            sourceShareBps: 10000,
            zeroBaseFallback: "YTD",
            targetFilter: { projectStatus: ["ACTIVE"] },
            validFrom: "2026-01-01",
            validTo: null,
            targets: [],
          },
        ],
        { userId: USER }
      )
    })
    for (let month = 1; month <= 12; month++) {
      const label = `2026-${String(month).padStart(2, "0")}`
      const bounds = allocationPeriodBounds(label)
      await tenantTransaction(ORG, USER, async (tx) =>
        sealAllocationRunTx(
          tx,
          { periodKind: "MONTH", periodStart: bounds.from, periodEnd: bounds.to, gitSha: "test" },
          { userId: USER }
        )
      )
    }

    await watcher.start()
    // Precalienta: la primera conexión del pool y el primer `ReportRun` pagan un
    // arranque que no es representativo de una petición en caliente.
    for (const loader of loaders) await loader.run(fiscalYearId)
  }, 600_000)

  afterAll(async () => {
    await watcher.stop()
    await cleanup()
    await prisma.$disconnect()
  })

  for (const loader of loaders) {
    it(`${loader.route}: ≤ ${MAX_CONNECTIONS} conexiones simultáneas y < ${MAX_MS} ms`, async () => {
      const { maxConnections, ms } = await watcher.measure(async () => loader.run(fiscalYearId))
      expect(
        maxConnections,
        `${loader.route} ocupó ${maxConnections} conexiones a la vez (máximo ${MAX_CONNECTIONS})`
      ).toBeLessThanOrEqual(MAX_CONNECTIONS)
      expect(ms, `${loader.route} tardó ${Math.round(ms)} ms (máximo ${MAX_MS} ms)`).toBeLessThan(MAX_MS)
    }, 120_000)

    it(`${loader.route}: el render abre UNA sola transacción`, async () => {
      const { transactions } = await countTransactions(async () => loader.run(fiscalYearId))
      expect(transactions, `${loader.route} abrió ${transactions} transacciones`).toBe(1)
    }, 120_000)
  }

  // ───────────────────────────────────────────────────────────────────────
  // E5 · criterio 20 (revisión ronda 1, #7)
  // ───────────────────────────────────────────────────────────────────────

  it(`criterio 20 · la liquidación ANUAL del fixture se sella en < ${MAX_MS_LIQUIDACION_ANUAL} ms`, async () => {
    // Se mide `sealAllocationRunTx` del ejercicio entero: leer el diario del
    // año, componer los tres sellos, ejecutar el motor y persistir el run.
    const started = performance.now()
    const run = await tenantTransaction(ORG, USER, async (tx) =>
      sealAllocationRunTx(
        tx,
        { periodKind: "YEAR", periodStart: PERIOD.from, periodEnd: PERIOD.to, gitSha: "test" },
        { userId: USER }
      )
    )
    const ms = performance.now() - started
    expect(run.status).toBe("SEALED")
    expect(ms, `la liquidación anual tardó ${Math.round(ms)} ms (máximo ${MAX_MS_LIQUIDACION_ANUAL} ms)`).toBeLessThan(
      MAX_MS_LIQUIDACION_ANUAL
    )
    // Se revierte para no dejar el estado del resto de mediciones tocado.
    await tenantTransaction(ORG, USER, async (tx) =>
      reverseAllocationRunTx(
        tx,
        { runId: run.id, reason: "limpieza de la medición de rendimiento", reversedAt: new Date() },
        { userId: USER }
      )
    )
  }, 120_000)

  it(`criterio 20 · la PyG analítica IMPUTADA del ejercicio se construye en < ${MAX_MS_PYG_IMPUTADA} ms`, async () => {
    clearMarginCache()
    const started = performance.now()
    const report = await runWithRequestTenant(ORG, USER, async (tx) =>
      getAnalyticPnl(tx, {
        ...PERIOD,
        fiscalYearId,
        withAllocations: true,
        provenance: { runId: "00000000-0000-4000-8000-000000000003", gitSha: "test", baseCurrency: "EUR" },
      })
    )
    const ms = performance.now() - started
    expect(report.withAllocations).toBe(true)
    // La medición no vale nada si la matriz no lleva imputaciones de verdad.
    expect(report.allocationRunIds.length).toBeGreaterThan(0)
    expect(report.checks.map((c) => c.id)).toContain("I5")
    expect(ms, `la PyG imputada tardó ${Math.round(ms)} ms (máximo ${MAX_MS_PYG_IMPUTADA} ms)`).toBeLessThan(
      MAX_MS_PYG_IMPUTADA
    )
  }, 120_000)

  it("sin runWithRequestTenant, cada operación de tenantDb abre la suya (la deuda que se cierra)", async () => {
    const db = tenantDb(ORG)
    const { transactions } = await countTransactions(async () => {
      await listFiscalYears(db)
      await listPeriodLocks(db)
      await db.journalEntry.groupBy({ by: ["fiscalYearId"], _count: { _all: true } })
    })
    // Tres lecturas sueltas = tres BEGIN. Es justamente lo que `tenantPage`
    // evita en `app/(app)/**`; el camino suelto se conserva para scripts y cron.
    expect(transactions).toBe(3)
  }, 60_000)

  it("una transacción READ ONLY rechaza cualquier escritura desde un Server Component", async () => {
    await expect(
      runWithRequestTenant(
        ORG,
        USER,
        async (tx) => tx.fiscalYear.updateMany({ data: { lastEntryNumber: 0 } }),
        { readOnly: true }
      )
    ).rejects.toThrow(/read-only|solo lectura|25006/i)
  }, 60_000)
})

async function cleanup(): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    await client.query("DELETE FROM organizations WHERE id = $1", [ORG])
    await client.query("DELETE FROM users WHERE id = $1", [USER])
  } finally {
    await client.end()
  }
}
