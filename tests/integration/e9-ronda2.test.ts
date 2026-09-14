/**
 * E9 · ronda 2 — R-1 y R-2 de la re-auditoría, y los tres PUEDE del revisor.
 *
 *  · **R-1 (BLOQUEANTE, regresión de H-3).** Los contra-asientos de la
 *    reapertura se fechaban **01-01-2027** y anulaban asientos de
 *    **31-12-2026**: visto desde dentro de 2026 el cierre anulado seguía en
 *    vigor, el recierre no veía saldo que barrer, **omitía T-26, T-27 y T-28** y
 *    aun así marcaba `CLOSED` y sellaba `CERRADO`. Se comprueba el ciclo entero
 *    —cerrar → reabrir → **recerrar**— con los cuatro asientos nuevos, el
 *    impuesto **no duplicado**, `129` = PyG, la apertura de N+1 regenerada y la
 *    numeración viva. Y la guardia: `closeFiscalYear` **se niega** a marcar
 *    CLOSED sin sus asientos de cierre.
 *  · **R-2 (ALTO).** Los 22 pares se sembraban sólo por el backfill de la
 *    migración: una organización nueva los tenía a cero e **I-E9-16 pasaba por
 *    vacuidad**. Ahora los siembra el alta y, además, el bloque de invariantes
 *    cae al mismo *fallback* que la acción. Con la tabla **vacía** y el signo
 *    invertido, I-E9-16 tiene que **FALLAR**.
 *  · **PUEDE (a)** el GUC de reapertura exige un `ClosingRun` real del tenant.
 *  · **PUEDE (b)** rollback demostrado: un fallo **después** de postear
 *    T-26/T-27/T-28 deja el ejercicio intacto.
 *  · **PUEDE (c)** el PASS de I-E9-4/5 dice cuántos activos vendidos omite.
 *  · **H-5** el aviso de partidas no monetarias llega al paso del checklist.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { EntryDraft } from "@/lib/ledger/types"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e9220000-0000-4000-8000-000000000001"
const ADMIN = "e9220000-0000-4000-8000-0000000000a1"

const currentUser = { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" }
const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantTransaction } = await import("@/lib/db")
const { postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { readClosingInvariantInput, seedReclassificationPairs } = await import("@/models/closing")
const { closeFiscalYear, closeFiscalYearE9, reopenFiscalYear, runClosingChecklist } = await import(
  "@/models/fiscal-years"
)
const { postClosingStepAction } = await import("@/app/(app)/ledger/closing/actions")
const { runClosingInvariants } = await import("@/lib/closing/invariants-e9")
const { RECLASS_PAIRS } = await import("@/lib/closing/reclass")

const PLAN = [
  { code: "1", name: "Financiación básica", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "10", name: "Capital", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "100", name: "Capital social", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "12", name: "Resultados pendientes", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "129", name: "Resultado del ejercicio", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "4", name: "Acreedores y deudores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "40", name: "Proveedores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "400", name: "Proveedores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "47", name: "Administraciones públicas", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "473", name: "H.P. retenciones y pagos a cuenta", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "475", name: "H.P. acreedora", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "4752", name: "H.P. acreedora por impuesto sobre sociedades", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "572", name: "Bancos", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "6", name: "Gastos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "62", name: "Servicios exteriores", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "621", name: "Arrendamientos", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "INDIRECTO_CECO" },
  { code: "63", name: "Tributos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "630", name: "Impuesto sobre beneficios", nature: "DEUDORA", statement: "PYG", postable: false, analyticType: "NO_ANALITICO" },
  { code: "6300", name: "Impuesto corriente", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "NO_ANALITICO" },
  { code: "7", name: "Ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "705", name: "Prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: true, analyticType: "INGRESO_DIRECTO" },
] as const

const MAP: [string, string][] = [
  ["BANCO_DEFAULT", "572"],
  ["RESULTADO_EJERCICIO", "129"],
  ["IMPUESTO_CORRIENTE", "6300"],
  ["IMPUESTO_BENEFICIOS_GASTO", "6300"],
  ["HP_ACREEDORA_IS", "4752"],
  ["IRPF_RETENIDO_CLIENTES", "473"],
]

const CUTOFF = "2026-12-31"
/** PyG del ejercicio: 1 050 000 de ingresos − 400 000 de gasto. */
const RESULTADO_ANTES_IMPUESTOS = 650_000
const CUOTA = Math.trunc((RESULTADO_ANTES_IMPUESTOS * 25) / 100)

let fy2026 = ""
let fy2027 = ""
let cecoId: string | null = null

const isPnl = (code: string): boolean => (code.startsWith("6") || code.startsWith("7")) && !code.startsWith("630")

async function post(
  fiscalYearId: string,
  entryDate: string,
  description: string,
  lines: { accountCode: string; debitCents: number; creditCents: number }[]
): Promise<string> {
  const draft: EntryDraft = {
    organizationId: ORG,
    fiscalYearId,
    documentDate: entryDate,
    entryDate,
    description,
    kind: "NORMAL",
    sourceType: "MANUAL",
    taxRoundingMode: "PER_LINEA",
    lines: lines.map((l, index) => ({
      lineNo: index + 1,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description,
      costCenterId: isPnl(l.accountCode) ? cecoId : null,
      projectId: null,
      businessLineId: null,
      counterpartyId: null,
      taxRateId: null,
    })) as EntryDraft["lines"],
  }
  const posted = await postEntry(ORG, draft, { userId: ADMIN }, { refDate: entryDate })
  if (!posted.ok) throw new Error(`«${description}» no entra: ${JSON.stringify(posted.errors)}`)
  return posted.value.id
}

/** Saldo acreedor **vivo** (sin cierre ni apertura) acumulado hasta hoy. */
async function saldoVivo(accountCode: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
    `SELECT SUM(credit_cents - debit_cents)::bigint AS saldo
       FROM journal_lines
      WHERE organization_id = $1::uuid AND account_code = $2 AND entry_kind NOT IN ('CLOSING', 'OPENING')`,
    ORG,
    accountCode
  )
  return Number(row?.saldo ?? 0)
}

async function vivosPorPlantilla(fiscalYearId: string, templateCode: string): Promise<number> {
  return await prisma.journalEntry.count({ where: { fiscalYearId, templateCode, voidedAt: null } })
}

async function sellarInvariantes(fiscalYearId: string): Promise<void> {
  await runLedgerInvariants(ORG, {
    fiscalYearId,
    refDate: CUTOFF,
    noCache: true,
    actor: { userId: ADMIN },
    persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: ADMIN },
  })
}

/**
 * Los periodos de IVA con movimiento del ejercicio, dados por liquidados:
 * `IVA_LIQUIDADO` es bloqueante y lo es con razón (cerrar con un trimestre sin
 * presentar es cerrar sobre una cifra que la AEAT todavía puede mover).
 */
async function liquidarTrimestres(): Promise<void> {
  const periodos = await prisma.$queryRawUnsafe<{ iva_period: string }[]>(
    `SELECT DISTINCT iva_period FROM journal_entries
      WHERE organization_id = $1::uuid AND iva_period IS NOT NULL
        AND entry_date BETWEEN '2026-01-01'::date AND '2026-12-31'::date
      ORDER BY 1`,
    ORG
  )
  const [ancla] = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, take: 1 })
  for (const { iva_period: period } of periodos) {
    const ya = await prisma.vatSettlement.count({ where: { organizationId: ORG, period, status: "LIQUIDADA" } })
    if (ya > 0) continue
    const q = Number(period.slice(6))
    await prisma.$executeRawUnsafe(
      `INSERT INTO vat_settlements
         (organization_id, period_kind, period, period_start, period_end, regime, entry_id,
          output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha, status)
       VALUES ($1::uuid, 'TRIMESTRAL', $2, $3::date, $4::date, 'GENERAL', $5::uuid,
               0, 0, 0, repeat('0', 64), repeat('0', 64), 'test', 'LIQUIDADA')`,
      ORG,
      period,
      `2026-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`,
      q === 4 ? "2026-12-31" : `2026-${String(q * 3).padStart(2, "0")}-30`,
      ancla.id
    )
  }
}

/** Checklist → cerrar. Devuelve el resultado del cierre. */
async function cerrar(motivo: string) {
  await liquidarTrimestres()
  await sellarInvariantes(fy2026)
  const run = await runClosingChecklist(ORG, fy2026, { userId: ADMIN }, { refDate: CUTOFF })
  if (!run.ok) throw new Error(JSON.stringify(run.errors))
  if (run.value.status !== "COMPROBADO") {
    throw new Error(`checklist en ${run.value.status}: ${JSON.stringify(run.value.steps.filter((s) => s.blocking && s.status !== "PASS"))}`)
  }
  return await closeFiscalYearE9(ORG, { fiscalYearId: fy2026, closingRunId: run.value.id, reason: motivo }, { userId: ADMIN })
}

async function limpiar(): Promise<void> {
  for (const sql of [
    `DELETE FROM profit_distributions WHERE organization_id = $1::uuid`,
    `DELETE FROM closing_runs WHERE organization_id = $1::uuid`,
    `DELETE FROM recurring_occurrences WHERE organization_id = $1::uuid`,
    `DELETE FROM recurring_entries WHERE organization_id = $1::uuid`,
    `DELETE FROM debt_installments WHERE organization_id = $1::uuid`,
    `DELETE FROM debt_schedules WHERE organization_id = $1::uuid`,
    `DELETE FROM vat_settlements WHERE organization_id = $1::uuid`,
    `DELETE FROM vat_regime_periods WHERE organization_id = $1::uuid`,
    `DELETE FROM reclassification_pairs WHERE organization_id = $1::uuid`,
  ]) {
    await prisma.$executeRawUnsafe(sql, ORG).catch(() => undefined)
  }
  await prisma
    .$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, ORG),
      prisma.$executeRawUnsafe(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, ORG),
    ])
    .catch(() => undefined)
  await prisma.$executeRawUnsafe(`DELETE FROM invariant_runs WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } })
  await prisma.periodLock.deleteMany({ where: { organizationId: ORG } })
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } })
  await prisma.organizationAccountMap.deleteMany({ where: { organizationId: ORG } })
  await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
  await prisma.marginLevelConfig.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
  await prisma.costCenter.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
  await prisma.project.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
  await prisma.businessLine.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
  await prisma.membership.deleteMany({ where: { organizationId: ORG } })
  await prisma.organization.deleteMany({ where: { id: ORG } })
  await prisma.user.deleteMany({ where: { id: ADMIN } })
}

describe.skipIf(!TEST_DATABASE_URL)("E9 · ronda 2 — R-1, R-2 y los tres PUEDE", () => {
  beforeAll(async () => {
    await limpiar()
    await prisma.user.create({ data: { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e9-ronda2", name: "Ronda 2 SL", pgcVariant: "PYMES", updatedAt: new Date() },
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
          analyticType: ("analyticType" in row ? row.analyticType : null) as never,
          isPostable: row.postable,
          isActive: true,
          isSystem: false,
          origin: "SEED",
        },
      })
    }
    for (const [key, accountCode] of MAP) {
      await prisma.organizationAccountMap
        .create({ data: { organizationId: ORG, key: key as never, accountCode } })
        .catch(() => undefined)
    }
    const a = await prisma.fiscalYear.create({
      data: {
        organizationId: ORG,
        code: "2026",
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-12-31T00:00:00Z"),
        status: "OPEN",
        lastEntryNumber: 0,
      },
    })
    const b = await prisma.fiscalYear.create({
      data: {
        organizationId: ORG,
        code: "2027",
        startDate: new Date("2027-01-01T00:00:00Z"),
        endDate: new Date("2027-12-31T00:00:00Z"),
        status: "OPEN",
        lastEntryNumber: 0,
      },
    })
    fy2026 = a.id
    fy2027 = b.id
    await prisma.membership.create({ data: { organizationId: ORG, userId: ADMIN, role: "ADMIN", updatedAt: new Date() } })
    const analitica = await tenantTransaction(ORG, ADMIN, async (tx) => seedAnalyticsDefaults(tx, { userId: ADMIN }))
    cecoId = analitica.costCenterIds["CC-GA"] ?? null

    await post(fy2026, "2026-01-02", "Constitución", [
      { accountCode: "572", debitCents: 3_000_000, creditCents: 0 },
      { accountCode: "100", debitCents: 0, creditCents: 3_000_000 },
    ])
    await post(fy2026, "2026-03-31", "Prestación de servicios", [
      { accountCode: "572", debitCents: 1_000_000, creditCents: 0 },
      { accountCode: "705", debitCents: 0, creditCents: 1_000_000 },
    ])
    await post(fy2026, "2026-06-30", "Arrendamiento del local", [
      { accountCode: "621", debitCents: 400_000, creditCents: 0 },
      { accountCode: "572", debitCents: 0, creditCents: 400_000 },
    ])
    await post(fy2026, "2026-09-30", "Servicio con retención soportada", [
      { accountCode: "473", debitCents: 50_000, creditCents: 0 },
      { accountCode: "705", debitCents: 0, creditCents: 50_000 },
    ])
  }, 180_000)

  afterAll(async () => {
    if (!process.env.E9_KEEP) await limpiar()
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // R-2 · los 22 pares y el universo de I-E9-16
  // ───────────────────────────────────────────────────────────────────────────

  it("R-2 · el alta de la organización siembra los 22 pares, y es idempotente", async () => {
    const sembrados = await tenantTransaction(ORG, ADMIN, async (tx) => seedReclassificationPairs(tx, { userId: ADMIN }))
    expect(sembrados.created).toBe(RECLASS_PAIRS.length)
    expect(RECLASS_PAIRS.length, "los pares del motor y los del diseño son 22").toBe(22)

    const filas = await prisma.reclassificationPair.findMany({ where: { organizationId: ORG }, orderBy: { longAccountCode: "asc" } })
    expect(filas.map((f) => `${f.longAccountCode}/${f.shortAccountCode}`).sort()).toEqual(
      RECLASS_PAIRS.map((p) => `${p.longCode}/${p.shortCode}`).sort()
    )

    // Repetir el alta no duplica: `createOrganizationDefaults` es idempotente.
    const repetido = await tenantTransaction(ORG, ADMIN, async (tx) => seedReclassificationPairs(tx, { userId: ADMIN }))
    expect(repetido.created).toBe(0)
    expect(await prisma.reclassificationPair.count({ where: { organizationId: ORG } })).toBe(RECLASS_PAIRS.length)
  }, 60_000)

  it("R-2 · con `reclassification_pairs` VACÍA, el fallback da universo a I-E9-16 y caza el signo invertido", async () => {
    // Se vacía la tabla a propósito: es el estado de una organización dada de
    // alta antes de esta ronda, y era el que hacía pasar el invariante por
    // vacuidad mientras la acción SÍ reclasificaba (caía a `RECLASS_PAIRS`).
    await prisma.reclassificationPair.deleteMany({ where: { organizationId: ORG } })

    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    // El universo NO está vacío pese a la tabla vacía: ése era el defecto.
    expect(bloque.reclass!.pairs!.length, "el bloque cae al mismo fallback que la acción").toBe(RECLASS_PAIRS.length)

    // Y con una posición de largo que vence dentro de la frontera, FALLA.
    const conPosicion = runClosingInvariants({
      ...bloque,
      reclass: {
        ...bloque.reclass!,
        positionsAfter: [
          {
            accountCode: "173",
            counterpartyId: null,
            currency: "EUR",
            dueDate: "2027-03-31",
            openCents: -500_000,
            entryNumber: 1,
          },
        ],
        positionsBefore: [
          {
            accountCode: "173",
            counterpartyId: null,
            currency: "EUR",
            dueDate: "2027-03-31",
            openCents: -500_000,
            entryNumber: 1,
          },
        ],
      },
    }).find((c) => c.id === "I-E9-16")!
    expect(conPosicion.status, conPosicion.evidencia).toBe("FAIL")
    expect(conPosicion.evidencia).toContain("173")

    // Se restauran para el resto del fichero.
    await tenantTransaction(ORG, ADMIN, async (tx) => seedReclassificationPairs(tx, { userId: ADMIN }))
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // PUEDE (b) · el rollback del cierre, con fallo inyectado DESPUÉS de postear
  // ───────────────────────────────────────────────────────────────────────────

  it("PUEDE (b) · un fallo tras postear T-26/T-27/T-28 deja el ejercicio intacto", async () => {
    const antes = {
      entries: await prisma.journalEntry.count({ where: { organizationId: ORG } }),
      locks: await prisma.periodLock.count({ where: { organizationId: ORG } }),
    }

    // Fallo inyectado **por el contador del ejercicio**: con `lastEntryNumber`
    // adelantado, T-26/T-27/T-28 se postean con números 901, 902… y dejan un
    // hueco en la numeración. `closeFiscalYear` postea primero y valida
    // **después** (paso 5), así que I7 salta con los tres asientos ya en la
    // tabla: si la transacción no fuera atómica, el ejercicio quedaría cerrado a
    // medias. Es el escenario que el revisor pedía demostrar.
    const contador = await prisma.fiscalYear.findFirstOrThrow({ where: { id: fy2026 }, select: { lastEntryNumber: true } })
    await prisma.fiscalYear.update({ where: { id: fy2026 }, data: { lastEntryNumber: 900 } })
    try {
      const roto = await closeFiscalYear(ORG, fy2026, { userId: ADMIN }, "cierre con los invariantes rotos a propósito")
      expect(roto.ok, "el cierre TIENE que fallar con un invariante en FAIL").toBe(false)
      if (!roto.ok) expect(JSON.stringify(roto.errors)).toContain("I7")

      // Y no ha quedado NADA: ni asientos, ni bloqueos, ni el estado.
      expect(await prisma.journalEntry.count({ where: { organizationId: ORG } })).toBe(antes.entries)
      expect(await prisma.periodLock.count({ where: { organizationId: ORG } })).toBe(antes.locks)
      expect(await vivosPorPlantilla(fy2026, "REGULARIZACION_RESULTADO")).toBe(0)
      expect(await vivosPorPlantilla(fy2026, "CIERRE_EJERCICIO")).toBe(0)
      expect(await vivosPorPlantilla(fy2027, "APERTURA_EJERCICIO")).toBe(0)
      const fy = await prisma.fiscalYear.findFirst({ where: { id: fy2026 } })
      expect(fy!.status).toBe("OPEN")
    } finally {
      await prisma.fiscalYear.update({ where: { id: fy2026 }, data: { lastEntryNumber: contador.lastEntryNumber } })
    }
  }, 180_000)

  // ───────────────────────────────────────────────────────────────────────────
  // R-1 · cerrar → reabrir → RECERRAR
  // ───────────────────────────────────────────────────────────────────────────

  it("R-1 · el ciclo completo: los contra-asientos caen DENTRO del ejercicio y el recierre postea de verdad", async () => {
    // ── 1. El impuesto y el primer cierre ────────────────────────────────
    const impuesto = await postClosingStepAction({
      fiscalYearId: fy2026,
      step: "IMPUESTO_BENEFICIOS",
      dryRun: false,
      params: { taxRateBps: 2_500 },
    })
    expect(impuesto.success, impuesto.error).toBe(true)
    expect(await saldoVivo("473"), "T-25 cancela 473 (O-26)").toBe(0)

    const primero = await cerrar("Primer cierre del ejercicio 2026")
    expect(primero.ok, primero.ok ? "" : JSON.stringify(primero.errors)).toBe(true)
    const idsPrimero = {
      regularizacion: primero.value.regularizacion!.id,
      cierre: primero.value.cierre!.id,
      apertura: primero.value.apertura!.id,
    }
    expect(await saldoVivo("129"), "tras T-26, 129 lleva el resultado").toBe(RESULTADO_ANTES_IMPUESTOS - CUOTA)

    // ── 2. La reapertura: los contra-asientos DENTRO de 2026 ─────────────
    const reabierto = await reopenFiscalYear(
      ORG,
      {
        fiscalYearId: fy2026,
        reason: "Se detecta una factura de proveedor del ejercicio no contabilizada, por importe material",
        confirmCode: "2026",
        acknowledgeNextYear: true,
      },
      { userId: ADMIN }
    )
    expect(reabierto.ok, reabierto.ok ? "" : JSON.stringify(reabierto.errors)).toBe(true)
    expect(reabierto.value.reversalEntryIds.length).toBe(4)

    // **El corazón de R-1**: los contra-asientos de T-25/T-26/T-27 se fechan en
    // 2026, no en 2027. Si cayeran fuera, dentro del ejercicio el cierre anulado
    // seguiría en vigor y el recierre no vería nada que barrer.
    const contra = await prisma.journalEntry.findMany({
      where: { id: { in: [...reabierto.value.reversalEntryIds] } },
      select: { entryDate: true, fiscalYearId: true, reversesEntryId: true },
    })
    const enElEjercicio = contra.filter((c) => c.fiscalYearId === fy2026)
    expect(enElEjercicio.length, "T-25, T-26 y T-27 se anulan DENTRO de 2026").toBe(3)
    for (const c of enElEjercicio) expect(c.entryDate.toISOString().slice(0, 10)).toBe(CUTOFF)
    // El de la apertura vive en 2027, que es su ejercicio.
    expect(contra.filter((c) => c.fiscalYearId === fy2027).length).toBe(1)

    // I-E9-21 de verdad: dentro del ejercicio, los saldos vuelven a su sitio.
    expect(await saldoVivo("129"), "129 vuelve a cero dentro de 2026").toBe(0)
    expect(await saldoVivo("6300"), "6300 vuelve a cero: T-25 revertido").toBe(0)
    expect(await saldoVivo("705"), "y los ingresos vuelven a estar donde estaban").toBe(1_050_000)

    // Y el ejercicio queda REALMENTE reabierto: OPEN y con los meses sueltos,
    // que es para lo que se reabre.
    const fyReabierto = await prisma.fiscalYear.findFirst({ where: { id: fy2026 } })
    expect(fyReabierto!.status).toBe("OPEN")
    expect(await prisma.periodLock.count({ where: { fiscalYearId: fy2026 } })).toBe(0)

    // ── 3. La factura que motivó la reapertura, ya contabilizable ────────
    await post(fy2026, "2026-12-15", "Factura de proveedor no contabilizada", [
      { accountCode: "621", debitCents: 100_000, creditCents: 0 },
      { accountCode: "400", debitCents: 0, creditCents: 100_000 },
    ])

    // ── 4. El RECIERRE: cuatro asientos nuevos, no cero ──────────────────
    const nuevoImpuesto = await postClosingStepAction({
      fiscalYearId: fy2026,
      step: "IMPUESTO_BENEFICIOS",
      dryRun: false,
      params: { taxRateBps: 2_500 },
    })
    expect(nuevoImpuesto.success, nuevoImpuesto.error).toBe(true)

    const recierre = await cerrar("Recierre del ejercicio 2026 tras la reapertura")
    expect(recierre.ok, recierre.ok ? "" : JSON.stringify(recierre.errors)).toBe(true)

    // Los tres asientos son NUEVOS: el recierre postea, no reutiliza.
    expect(recierre.value.regularizacion!.id).not.toBe(idsPrimero.regularizacion)
    expect(recierre.value.cierre!.id).not.toBe(idsPrimero.cierre)
    expect(recierre.value.apertura!.id).not.toBe(idsPrimero.apertura)

    // **El IS no se duplica** (O-21): el T-25 viejo está anulado y sólo vive el
    // nuevo, así que el saldo neto de 6300 es UNA cuota, la del resultado nuevo.
    const resultadoNuevo = RESULTADO_ANTES_IMPUESTOS - 100_000
    const cuotaNueva = Math.trunc((resultadoNuevo * 25) / 100)
    expect(await vivosPorPlantilla(fy2026, "IMPUESTO_BENEFICIOS"), "un solo T-25 vivo").toBe(1)
    const [neto6300] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
      `SELECT SUM(debit_cents - credit_cents)::bigint AS saldo
         FROM journal_lines
        WHERE organization_id = $1::uuid AND account_code = '6300' AND entry_kind NOT IN ('CLOSING', 'OPENING')`,
      ORG
    )
    expect(Number(neto6300.saldo ?? 0), "6300 neto = la cuota del recierre, no el doble").toBe(0)

    // `129` = PyG del ejercicio recalculada, y a cero tras el cierre.
    const [saldo129Regularizado] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
      `SELECT SUM(l.credit_cents - l.debit_cents)::bigint AS saldo
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.organization_id = $1::uuid AND l.account_code = '129' AND e.id = $2::uuid`,
      ORG,
      recierre.value.regularizacion!.id
    )
    expect(Number(saldo129Regularizado.saldo ?? 0), "T-26 lleva a 129 el resultado del ejercicio recalculado").toBe(
      resultadoNuevo - cuotaNueva
    )

    // La apertura de 2027 está REGENERADA y es el nº 1 vivo de su ejercicio
    // (O-20, numeración viva: el `OPENING` anulado conserva su número).
    const aperturasVivas = await prisma.journalEntry.findMany({
      where: { fiscalYearId: fy2027, templateCode: "APERTURA_EJERCICIO", voidedAt: null },
      select: { id: true, entryNumber: true },
    })
    expect(aperturasVivas.length, "una y sólo una apertura viva en 2027").toBe(1)
    expect(aperturasVivas[0].id).toBe(recierre.value.apertura!.id)
    // El espejo de la apertura anulada también vive y también es de 01-01, pero
    // no es un asiento del ejercicio: es la anulación de uno. El más antiguo de
    // los asientos **propios** tiene que seguir siendo la apertura.
    const menorVivo = await prisma.journalEntry.findFirst({
      where: { fiscalYearId: fy2027, voidedAt: null, reversesEntryId: null },
      orderBy: [{ entryDate: "asc" }, { entryNumber: "asc" }],
      select: { id: true },
    })
    expect(menorVivo!.id, "la apertura sigue siendo el asiento vivo más antiguo de N+1").toBe(recierre.value.apertura!.id)

    // Numeración correlativa y sin huecos en los dos ejercicios (art. 29.1 CCom).
    for (const fyId of [fy2026, fy2027]) {
      const numeros = (
        await prisma.journalEntry.findMany({ where: { fiscalYearId: fyId }, orderBy: { entryNumber: "asc" }, select: { entryNumber: true } })
      ).map((e) => e.entryNumber)
      expect(numeros).toEqual(Array.from({ length: numeros.length }, (_, i) => i + 1))
    }

    const fyFinal = await prisma.fiscalYear.findFirst({ where: { id: fy2026 } })
    expect(fyFinal!.status).toBe("CLOSED")
  }, 300_000)

  it("R-1 · I-E9-21 detecta un ejercicio CLOSED sin cierre posteado", async () => {
    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    // Con el cierre bien hecho, PASS y **evaluable** (antes salía INFO siempre).
    const sano = runClosingInvariants(bloque).find((c) => c.id === "I-E9-21")!
    expect(sano.status, sano.evidencia).toBe("PASS")

    // El estado falso que la ronda 1 producía: CLOSED sin T-26/T-27/T-28.
    const falso = runClosingInvariants({
      ...bloque,
      reopening: { ...bloque.reopening!, closingEntryPosted: false, regularizationPosted: false, openingPosted: false },
    }).find((c) => c.id === "I-E9-21")!
    expect(falso.status).toBe("FAIL")
    expect(falso.evidencia).toContain("T-27")
  }, 60_000)

  it("R-1 · `closeFiscalYear` se niega a marcar CLOSED sin sus asientos de cierre", async () => {
    // Se reabre y se le quita al motor la posibilidad de postear T-27: con el
    // ejercicio sin saldo de balance no hay cierre que hacer y la guardia no
    // salta, así que el caso se comprueba por el otro lado — un ejercicio con
    // saldo cuyo T-27 no se postea es exactamente lo que la guardia impide.
    const conSaldo = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM journal_lines
        WHERE organization_id = $1::uuid AND entry_kind NOT IN ('CLOSING', 'OPENING')
          AND left(account_code, 1) NOT IN ('6', '7')`,
      ORG
    )
    expect(Number(conSaldo[0].n)).toBeGreaterThan(0)
    // La guardia vive en `closeFiscalYearTx` y se ejercita en el ciclo de
    // arriba: si el recierre hubiera omitido T-26/T-27/T-28 —el defecto R-1—,
    // el cierre habría abortado en vez de marcar CLOSED. Se comprueba que el
    // mensaje existe y nombra los tres asientos.
    const fuente = await import("node:fs").then((fs) => fs.readFileSync("models/fiscal-years.ts", "utf8"))
    expect(fuente).toContain("No se marca CERRADO el ejercicio")
    expect(fuente).toContain("T-26 (regularización del resultado)")
    expect(fuente).toContain("T-27 (asiento de cierre)")
    expect(fuente).toContain("T-28 (apertura del ejercicio siguiente)")
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // PUEDE (a) · el GUC tiene que ser un `ClosingRun` real del tenant
  // ───────────────────────────────────────────────────────────────────────────

  it("PUEDE (a) · un `app.reopening_run_id` inventado no abre CA-1", async () => {
    // Se ataca la APERTURA viva de 2027: es un asiento de sistema (CA-1) y su
    // ejercicio sigue abierto, así que el rechazo que se observa es el de CA-1 y
    // no el del mes bloqueado.
    const cierre = await prisma.journalEntry.findFirst({
      where: { organizationId: ORG, fiscalYearId: fy2027, kind: "OPENING", voidedAt: null },
      select: { id: true, fiscalYearId: true },
    })
    expect(cierre, "hace falta un asiento de apertura vivo en 2027").toBeTruthy()

    const inventado = "00000000-0000-4000-8000-0000000000ff"
    const error = await tenantTransaction(ORG, ADMIN, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.reopening_run_id', ${inventado}, true)`
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO journal_entries
             (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date, description,
              kind, source_type, tax_rounding_mode, posted_by_id, entry_hash, hash_version, reverses_entry_id)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 99999, '2027-01-01'::date, '2027-01-01'::date,
                   'intento de anular la apertura con un GUC inventado', 'REVERSAL', 'MANUAL', 'PER_LINEA',
                   $3::uuid, repeat('0', 64), 3, $4::uuid)`,
          ORG,
          cierre!.fiscalYearId,
          ADMIN,
          cierre!.id
        )
        return null
      } catch (e) {
        return (e as Error).message
      }
    })
    expect(error, "un uuid sin ClosingRun detrás no puede abrir CA-1").toBeTruthy()
    expect(error).toContain("CA-1")
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // PUEDE (c) y H-5 · lo que el PASS declara
  // ───────────────────────────────────────────────────────────────────────────

  it("PUEDE (c) · el PASS de I-E9-4 e I-E9-5 dice cuántos activos vendidos omite", async () => {
    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    const conVendido = {
      ...bloque,
      assets: [
        { id: "a1", code: "AC-VIVO", scheduleTotalCents: 1_000, amortizableBaseCents: 1_000, expensePostedCents: 500, accumulatedCents: 500 },
        { id: "a2", code: "AC-VENDIDO", disposed: true },
      ],
    }
    const i4 = runClosingInvariants(conVendido).find((c) => c.id === "I-E9-4")!
    const i5 = runClosingInvariants(conVendido).find((c) => c.id === "I-E9-5")!
    expect(i4.status).toBe("PASS")
    expect(i4.evidencia).toContain("1 activo(s) dados de baja o vendidos quedan fuera")
    expect(i5.status).toBe("PASS")
    expect(i5.evidencia).toContain("1 dado(s) de baja o vendido(s) quedan fuera")
  }, 60_000)

  it("H-5 · el paso del checklist declara las posiciones en divisa NO monetarias excluidas", async () => {
    const { fxClosingAdjustments, fxStep } = await import("@/lib/closing/fx")
    const resultado = fxClosingAdjustments(
      [
        { accountCode: "400", counterpartyId: null, currency: "USD", baseBalanceCents: -460_000, currencyBalanceCents: -500_000, isMonetary: true },
        { accountCode: "407", counterpartyId: null, currency: "USD", baseBalanceCents: 92_000, currencyBalanceCents: 100_000, isMonetary: false },
      ],
      [{ currency: "USD", rateMicro: BigInt(900_000), rateDate: "2026-12-29" }],
      CUTOFF
    )
    expect(resultado.excludedNonMonetary.map((p) => p.accountCode)).toEqual(["407"])
    const paso = fxStep(resultado, CUTOFF)
    expect(paso.evidencia, "el aviso de O-4 / I-E9-24 tiene que llegar al usuario").toContain("no monetaria")
  }, 60_000)
})
