/**
 * E9 · ronda de integración — **el cierre real, de punta a punta**, contra
 * Postgres de verdad.
 *
 * Hasta esta ronda el recorrido completo era **inalcanzable**, y por eso ni el
 * e2e `cierre.spec.ts` ni la integración lo ejecutaban: dos de los **nueve
 * pasos bloqueantes** no podían salir PASS en ninguna organización normal.
 *
 *  · `RECC_DEVENGADO_31_12` devolvía `NA` fuera del régimen especial del
 *    criterio de caja, y `canCloseFiscalYear` exige PASS en los nueve: ninguna
 *    organización en régimen general podía cerrar el ejercicio.
 *  · `BIENES_DE_INVERSION` salía `WARN` en cuanto había un activo de más de
 *    3 005,06 € y la organización **no** declaraba prorrata, porque la guardia
 *    de R-IVA-16 exigía además una prorrata definitiva que nunca iba a existir.
 *
 * Aquí se comprueba lo contrario y se comprueba de verdad:
 *
 *  1. **Un ejercicio vacío se cierra.** Sin un asiento, sin posiciones en
 *    divisa, sin deuda y sin régimen especial, los nueve bloqueantes están en
 *    PASS y el ejercicio pasa a `CLOSED`. Es la sociedad inactiva, y es la
 *    prueba de que ningún bloqueante exige un hecho que no ha ocurrido.
 *  2. **Un ejercicio con actividad recorre los DOCE asientos de O-17** y acaba
 *    con su sello: el impuesto (T-25) por `postClosingStepAction`, y la
 *    regularización (T-26), el cierre (T-27), la apertura (T-28) y el
 *    contra-asiento de la reclasificación en una sola transacción. Se verifica
 *    que las doce posiciones del orden están resueltas —posteadas o
 *    explícitamente vacías—, que `129` y `6300` quedan a cero tras el cierre y
 *    que la apertura es el espejo exacto (I-E9-14).
 *  3. **La generación real de recurrentes contabiliza.** El CHECK
 *    `recurring_occurrences_entry_iff_generada` y la política append-only de
 *    `recurring_occurrences` hacían imposible el `INSERT`…`UPDATE` de T12: no
 *    se contabilizaba **ni una** ocurrencia. Con el orden corregido —asiento
 *    primero, ocurrencia ya enlazada— se generan, quedan `GENERADA` con su
 *    `entry_id`, y repetir la generación no duplica nada.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { EntryDraft } from "@/lib/ledger/types"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e9cc0000-0000-4000-8000-000000000001"
const ADMIN = "e9cc0000-0000-4000-8000-0000000000a1"

type TestUser = { id: string; email: string; name: string }
let currentUser: TestUser = { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" }

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
const { CLOSING_ENTRY_ORDER } = await import("@/lib/closing/checklist")
const { postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { closeFiscalYearE9Action, postClosingStepAction, runClosingChecklistAction } = await import(
  "@/app/(app)/ledger/closing/actions"
)
const { createRecurringAction, generateOccurrencesAction } = await import("@/app/(app)/ledger/recurring/actions")
const { createAssetAction, sellAssetAction } = await import("@/app/(app)/settings/assets/actions")

/** Plan mínimo suficiente para un ejercicio con resultado, impuesto y cierre. */
const PLAN = [
  { code: "1", name: "Financiación básica", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "12", name: "Resultados pendientes de aplicación", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "129", name: "Resultado del ejercicio", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "4", name: "Acreedores y deudores", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "47", name: "Administraciones públicas", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "473", name: "H.P. retenciones y pagos a cuenta", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "475", name: "H.P. acreedora por conceptos fiscales", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "4752", name: "H.P. acreedora por impuesto sobre sociedades", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "2", name: "Inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "21", name: "Inmovilizaciones materiales", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "213", name: "Maquinaria", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "28", name: "Amortización acumulada del inmovilizado", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "281", name: "A.A. del inmovilizado material", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "2813", name: "A.A. de maquinaria", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "54", name: "Otras inversiones financieras a corto plazo", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "543", name: "Créditos a corto plazo por enajenación de inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "570", name: "Caja, euros", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "572", name: "Bancos e instituciones de crédito c/c vista, euros", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "6", name: "Compras y gastos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "62", name: "Servicios exteriores", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "621", name: "Arrendamientos y cánones", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "INDIRECTO_CECO" },
  { code: "63", name: "Tributos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "67", name: "Pérdidas procedentes del inmovilizado", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "671", name: "Pérdidas procedentes del inmovilizado material", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "EXTRAORDINARIO" },
  { code: "68", name: "Dotaciones para amortizaciones", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "681", name: "Amortización del inmovilizado material", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "AMORTIZACION_DETERIORO" },
  // NO_ANALITICO como en el seed oficial: el impuesto sobre beneficios no es
  // coste de explotación y no se imputa a ningún CECO (R-A1, `seeds/npgc.csv`).
  { code: "630", name: "Impuesto sobre beneficios", nature: "DEUDORA", statement: "PYG", postable: false, analyticType: "NO_ANALITICO" },
  { code: "6300", name: "Impuesto corriente", nature: "DEUDORA", statement: "PYG", postable: true, analyticType: "NO_ANALITICO" },
  { code: "7", name: "Ventas e ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas de mercaderías y prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "705", name: "Prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: true, analyticType: "INGRESO_DIRECTO" },
  { code: "77", name: "Beneficios procedentes del inmovilizado", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "771", name: "Beneficios procedentes del inmovilizado material", nature: "ACREEDORA", statement: "PYG", postable: true, analyticType: "EXTRAORDINARIO" },
] as const

const MAP: [string, string][] = [
  ["BANCO_DEFAULT", "572"],
  ["CAJA", "570"],
  ["BENEFICIO_BAJA_INMOVILIZADO", "771"],
  ["PERDIDA_BAJA_INMOVILIZADO", "671"],
  ["CREDITO_ENAJENACION_CP", "543"],
  ["RESULTADO_EJERCICIO", "129"],
  ["IMPUESTO_CORRIENTE", "6300"],
  ["IMPUESTO_BENEFICIOS_GASTO", "6300"],
  ["HP_ACREEDORA_IS", "4752"],
  
  ["IRPF_RETENIDO_CLIENTES", "473"],
]

/** CECO general al que van las líneas de 6/7 del fixture (R-A1). */
let costCenterGA: string | null = null

async function seedOrg(): Promise<{ fy2026: string; fy2027: string }> {
  await prisma.organization.create({
    data: { id: ORG, slug: "e9-cierre-completo", name: "Cierre completo SL", pgcVariant: "PYMES", updatedAt: new Date() },
  })
  // Por código: el padre tiene que existir antes que el hijo (FK `parent_code`).
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
  const fy2026 = await prisma.fiscalYear.create({
    data: {
      organizationId: ORG,
      code: "2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
      status: "OPEN",
      lastEntryNumber: 0,
    },
  })
  const fy2027 = await prisma.fiscalYear.create({
    data: {
      organizationId: ORG,
      code: "2027",
      startDate: new Date("2027-01-01T00:00:00Z"),
      endDate: new Date("2027-12-31T00:00:00Z"),
      status: "OPEN",
      lastEntryNumber: 0,
    },
  })
  await prisma.membership.create({ data: { organizationId: ORG, userId: ADMIN, role: "ADMIN", updatedAt: new Date() } })
  // Sin los niveles de margen, I-E4-9 sale FAIL y con él `INVARIANTES_PASS`:
  // toda organización real los tiene desde su alta (E4 · T9).
  const analitica = await tenantTransaction(ORG, ADMIN, async (tx) => seedAnalyticsDefaults(tx, { userId: ADMIN }))
  costCenterGA = analitica.costCenterIds["CC-GA"] ?? null
  return { fy2026: fy2026.id, fy2027: fy2027.id }
}

/**
 * Un asiento por el **mismo camino que la aplicación** (`postEntry`): con su
 * `entry_hash` real —I-E3-7 lo comprueba—, su numeración y su destino analítico
 * en las líneas de 6/7 (I-E4-1, I-E4-2). Un fixture montado por SQL crudo deja
 * los invariantes en FAIL y `INVARIANTES_PASS` es bloqueante.
 */
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
      costCenterId: isPnl(l.accountCode) && !l.accountCode.startsWith("630") ? costCenterGA : null,
      projectId: null,
      businessLineId: null,
      counterpartyId: null,
      taxRateId: null,
    })) as EntryDraft["lines"],
  }
  const posted = await postEntry(ORG, draft, { userId: ADMIN }, { refDate: entryDate })
  if (!posted.ok) throw new Error(`El asiento «${description}» no entra: ${JSON.stringify(posted.errors)}`)
  return posted.value.id
}

const isPnl = (code: string): boolean => code.startsWith("6") || code.startsWith("7")

/**
 * Liquida por SQL todos los periodos de IVA con movimiento del ejercicio.
 * `IVA_LIQUIDADO` es bloqueante y lo es con razón: cerrar con un trimestre sin
 * presentar es cerrar sobre una cifra que la AEAT todavía puede mover.
 */
async function settleAllVatPeriods(entryId: string, from: string, to: string): Promise<string[]> {
  const periods = await prisma.$queryRawUnsafe<{ iva_period: string }[]>(
    `SELECT DISTINCT iva_period FROM journal_entries
      WHERE organization_id = $1::uuid AND iva_period IS NOT NULL
        AND entry_date BETWEEN $2::date AND $3::date
      ORDER BY 1`,
    ORG,
    from,
    to
  )
  for (const { iva_period: period } of periods) {
    const ya = await prisma.vatSettlement.count({ where: { organizationId: ORG, period, status: "LIQUIDADA" } })
    if (ya > 0) continue
    const quarter = Number(period.slice(6))
    await prisma.$executeRawUnsafe(
      `INSERT INTO vat_settlements
         (organization_id, period_kind, period, period_start, period_end, regime, entry_id,
          output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha, status)
       VALUES ($1::uuid, 'TRIMESTRAL', $2, $3::date, $4::date, 'GENERAL', $5::uuid,
               0, 0, 0, repeat('0', 64), repeat('0', 64), 'test', 'LIQUIDADA')`,
      ORG,
      period,
      `${period.slice(0, 4)}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`,
      quarter === 4 ? `${period.slice(0, 4)}-12-31` : `${period.slice(0, 4)}-${String(quarter * 3).padStart(2, "0")}-30`,
      entryId
    )
  }
  return periods.map((p) => p.iva_period)
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM profit_distributions WHERE organization_id = $1::uuid`,
    `DELETE FROM closing_runs WHERE organization_id = $1::uuid`,
    `DELETE FROM recurring_occurrences WHERE organization_id = $1::uuid`,
    `DELETE FROM recurring_entries WHERE organization_id = $1::uuid`,
    `DELETE FROM vat_settlements WHERE organization_id = $1::uuid`,
    `DELETE FROM vat_regime_periods WHERE organization_id = $1::uuid`,
    `DELETE FROM allocation_lines WHERE organization_id = $1::uuid`,
    `DELETE FROM asset_revisions WHERE organization_id = $1::uuid`,
    `DELETE FROM allocation_runs WHERE organization_id = $1::uuid`,
  ]) {
    await prisma.$executeRawUnsafe(sql, ORG).catch(() => undefined)
  }
  // Líneas y asientos en la MISMA transacción: el constraint trigger diferido
  // de «un asiento tiene al menos dos líneas» sólo se calla si al COMMIT
  // tampoco existe el asiento (mismo patrón que `scripts/load-fixture.ts`).
  await prisma
    .$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, ORG),
      prisma.$executeRawUnsafe(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, ORG),
    ])
    .catch(() => undefined)
  await prisma.$executeRawUnsafe(`DELETE FROM fixed_assets WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
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

/**
 * Sella una foto de invariantes del ejercicio. `INVARIANTES_PASS` es bloqueante
 * y sale `INFO` mientras no se haya ejecutado ninguna validación: no es un
 * defecto —«no evaluable» jamás es PASS por vacuidad—, es un paso que el
 * usuario resuelve lanzando el barrido, y eso es lo que se hace aquí.
 */
async function sellarInvariantes(fiscalYearId: string, refDate: string): Promise<void> {
  await runLedgerInvariants(ORG, {
    fiscalYearId,
    refDate,
    noCache: true,
    actor: { userId: ADMIN },
    persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: ADMIN },
  })
}

/** Saldo acreedor de una cuenta a una fecha. */
async function balance(accountCode: string, cutoff: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
    `SELECT SUM(credit_cents - debit_cents)::bigint AS saldo
       FROM journal_lines
      WHERE organization_id = $1::uuid AND account_code = $2 AND entry_date <= $3::date`,
    ORG,
    accountCode,
    cutoff
  )
  return Number(row?.saldo ?? 0)
}

describe.skipIf(!TEST_DATABASE_URL)("E9 — el cierre real de punta a punta", () => {
  let fy2026 = ""
  let fy2027 = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" } })
    const ids = await seedOrg()
    fy2026 = ids.fy2026
    fy2027 = ids.fy2027
  }, 120_000)

  afterAll(async () => {
    if (!process.env.E9_KEEP) await cleanup()
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1 · El ejercicio VACÍO se cierra
  // ───────────────────────────────────────────────────────────────────────────

  it("un ejercicio sin un solo asiento tiene los nueve bloqueantes en PASS", async () => {
    await sellarInvariantes(fy2027, "2027-12-31")
    const run = await runClosingChecklistAction({ fiscalYearId: fy2027, answers: [] })
    expect(run.success).toBe(true)

    const bloqueantes = run.data!.run!.steps.filter((s) => s.blocking)
    expect(bloqueantes).toHaveLength(9)
    expect(bloqueantes.filter((s) => s.status !== "PASS").map((s) => `${s.step}: ${s.status} · ${s.evidencia}`)).toEqual([])

    // Y el RECC lo dice con esas palabras: no es «no aplicable», es que no hay
    // barrido que practicar (decisión contable de la ronda de integración).
    const recc = run.data!.run!.steps.find((s) => s.step === "RECC_DEVENGADO_31_12")!
    expect(recc.status).toBe("PASS")
    expect(recc.evidencia).toContain("Régimen de caja no aplica en el ejercicio")

    expect(run.data!.canClose).toBe(true)
    expect(run.data!.run!.status).toBe("COMPROBADO")
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // 2 · La generación REAL de recurrentes contabiliza (y es idempotente)
  // ───────────────────────────────────────────────────────────────────────────

  it("generar ocurrencias reales contabiliza el asiento, y repetir no duplica nada", async () => {
    const regla = await createRecurringAction({
      code: "REC-CIERRE",
      name: "Traspaso recurrente a caja",
      kind: "IMPORTE_FIJO",
      templateCode: "TRASPASO_TESORERIA",
      templateInput: { documentDate: "2026-01-31", fromAccountCode: "572", toAccountCode: "570" },
      amountCents: 120_000,
      freq: "MENSUAL",
      anchor: "ULTIMO_DIA",
      startPeriod: "2026-01",
      endPeriod: "2026-03",
    })
    expect(regla.success, regla.error).toBe(true)

    const primera = await generateOccurrencesAction({ upToPeriod: "2026-03" })
    expect(primera.success, primera.error).toBe(true)

    const ocurrencias = await prisma.recurringOccurrence.findMany({
      where: { organizationId: ORG },
      orderBy: { period: "asc" },
    })
    expect(ocurrencias.map((o) => o.period)).toEqual(["2026-01", "2026-02", "2026-03"])
    // Lo que el CHECK `entry_iff_generada` impedía: una GENERADA con su asiento.
    for (const o of ocurrencias) {
      expect(o.status).toBe("GENERADA")
      expect(o.entryId).not.toBeNull()
      const entry = await prisma.journalEntry.findFirst({ where: { id: o.entryId! } })
      expect(entry, `la ocurrencia ${o.period} apunta a un asiento que no existe`).not.toBeNull()
      expect(entry!.kind).toBe("RECURRING")
    }

    // Idempotencia: la segunda pasada no ofrece periodos vencidos pendientes y
    // no deja ni una ocurrencia ni un asiento de más.
    const asientosAntes = await prisma.journalEntry.count({ where: { organizationId: ORG, kind: "RECURRING" } })
    const segunda = await generateOccurrencesAction({ upToPeriod: "2026-03" })
    expect(segunda.success).toBe(true)
    expect(await prisma.recurringOccurrence.count({ where: { organizationId: ORG } })).toBe(3)
    expect(await prisma.journalEntry.count({ where: { organizationId: ORG, kind: "RECURRING" } })).toBe(asientosAntes)
  }, 180_000)

  // ───────────────────────────────────────────────────────────────────────────
  // 3 · La venta de un activo lleva el destino analítico DEL ACTIVO a 771/671
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Con `analyticsRequired`, `VENTA_INMOVILIZADO` (T-34) y `BAJA_INMOVILIZADO`
   * (T-33) fallaban al construir el asiento —«La cuenta 771 exige exactamente un
   * destino analítico»— porque las acciones **no reenviaban** a la plantilla el
   * proyecto ni el centro de coste que el activo ya declara. Ninguna baja ni
   * venta se podía contabilizar.
   */
  it("vender un activo con analyticsRequired contabiliza, y el resultado hereda el CECO del activo", async () => {
    const org = await prisma.organization.findFirst({ where: { id: ORG }, select: { analyticsRequired: true } })
    expect(org!.analyticsRequired, "el caso sólo existe con destino analítico obligatorio").toBe(true)

    const alta = await createAssetAction({
      code: "ACT-VENTA",
      name: "Maquinaria a enajenar",
      assetAccountCode: "213",
      accumulatedAccountCode: "2813",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-15",
      inServiceDate: "2026-02-01",
      acquisitionCostCents: 1_200_000,
      usefulLifeMonths: 24,
      costCenterId: costCenterGA,
    })
    expect(alta.success, alta.error).toBe(true)

    const venta = await sellAssetAction({
      fixedAssetId: alta.data!.id,
      disposalDate: "2026-08-31",
      salePriceCents: 900_000,
      receivableAccountCode: "543",
      reason: "Venta a un tercero por renovación del parque de maquinaria",
    })
    expect(venta.success, venta.error).toBe(true)

    const lineas = await prisma.journalLine.findMany({
      where: { organizationId: ORG, entryId: venta.data!.entryId },
      orderBy: { lineNo: "asc" },
    })
    expect(lineas.map((l) => l.accountCode)).toContain("543")
    expect(lineas.map((l) => l.accountCode)).not.toContain("430")

    const resultado = lineas.find((l) => l.accountCode === "771" || l.accountCode === "671")!
    expect(resultado, "la venta no ha generado línea de resultado").toBeTruthy()
    expect(resultado.costCenterId).toBe(costCenterGA)

    // O-19: el activo entra CON la línea (`postEntryTx`), no por un `UPDATE`
    // posterior sobre una tabla append-only. `attributeLinesToAssetTx` cuenta.
    expect(venta.data!.attributedLines).toBeGreaterThan(0)
    for (const l of lineas.filter((x) => x.fixedAssetId !== null)) {
      expect(l.fixedAssetId).toBe(alta.data!.id)
      expect(["2813", "671", "771"]).toContain(l.accountCode)
    }
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // 4 · El ejercicio CON actividad recorre los doce asientos de O-17
  // ───────────────────────────────────────────────────────────────────────────

  it("los doce asientos de O-17 se recorren y el ejercicio queda CERRADO con su sello", async () => {
    // Un ejercicio con resultado: ingreso, gasto y una retención soportada en
    // 473, que T-25 tiene que cancelar contra la cuota (O-26).
    const venta = await post(fy2026, "2026-03-31", "Prestación de servicios del primer trimestre", [
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

    const periodos = await settleAllVatPeriods(venta, "2026-01-01", "2026-12-31")
    expect(periodos.length).toBeGreaterThan(0)
    // La forma canónica del periodo es `AAAA-Qn`, y la escribe la base: si el
    // motor y el trigger no coincidieran, `IVA_LIQUIDADO` no saldría nunca.
    for (const p of periodos) expect(p).toMatch(/^\d{4}-Q[1-4]$/)

    await sellarInvariantes(fy2026, "2026-12-31")

    // Paso 8 de O-17: el impuesto, con sus PARÁMETROS (tipo y pagos a cuenta),
    // nunca con la cuota tecleada.
    const impuesto = await postClosingStepAction({
      fiscalYearId: fy2026,
      step: "IMPUESTO_BENEFICIOS",
      dryRun: false,
      params: { taxRateBps: 2_500 },
    })
    expect(impuesto.success, impuesto.error).toBe(true)
    expect(impuesto.data!.entryId).not.toBeNull()

    // El impuesto es un asiento más y cae en su propio periodo de IVA: hay que
    // volver a liquidar, y a sellar los invariantes sobre el diario nuevo.
    await settleAllVatPeriods(venta, "2026-01-01", "2026-12-31")
    await sellarInvariantes(fy2026, "2026-12-31")
    const comprobado = await runClosingChecklistAction({ fiscalYearId: fy2026, answers: [] })
    expect(comprobado.success).toBe(true)
    expect(
      comprobado.data!.blockers.map((b) => `${b.step}: ${b.status} · ${b.evidencia}`)
    ).toEqual([])
    expect(comprobado.data!.run!.status).toBe("COMPROBADO")

    // Pasos 9 a 12, en UNA transacción.
    const cerrado = await closeFiscalYearE9Action({
      fiscalYearId: fy2026,
      closingRunId: comprobado.data!.run!.id,
      reason: "Cierre del ejercicio 2026 tras revisar el checklist completo",
    })
    expect(cerrado.success, cerrado.error).toBe(true)

    // Las DOCE posiciones de O-17 están resueltas: cada una con su asiento
    // sellado en el `ClosingRun`, o explícitamente vacía porque en este
    // ejercicio no había nada que postear (ni recurrentes pendientes, ni RECC,
    // ni prorrata, ni posiciones en divisa, ni deuda que reclasificar).
    const entryIds = cerrado.data!.entryIds
    for (const clave of ["regularizacion", "cierre", "apertura"]) {
      expect(entryIds[clave], `${clave} sin asiento`).toBeTruthy()
    }
    const sellado = (await prisma.closingRun.findFirst({ where: { id: comprobado.data!.run!.id } })) as unknown as Record<
      string,
      unknown
    >
    // Las doce columnas de O-17 existen en el `ClosingRun`: cada posición del
    // orden tiene dónde sellarse, esté posteada o no. Ese es el contrato.
    const columnas = CLOSING_ENTRY_ORDER.map((o) => o.runColumn)
    expect(columnas).toHaveLength(12)
    for (const columna of columnas) {
      expect(Object.prototype.hasOwnProperty.call(sellado, columna), `el ClosingRun no tiene ${columna}`).toBe(true)
    }
    // Y las tres que remata el propio cierre están selladas con su asiento.
    // (`incomeTaxEntryId` se sella en el run vigente cuando se postea el paso 8;
    // relanzar el checklist abre un run nuevo, así que el impuesto se comprueba
    // en el diario, que es donde vive.)
    expect(await prisma.journalEntry.count({ where: { organizationId: ORG, templateCode: "IMPUESTO_BENEFICIOS" } })).toBe(1)
    for (const columna of ["regularizacionEntryId", "cierreEntryId", "aperturaEntryId"]) {
      expect(sellado[columna], `${columna} sin sellar en el ClosingRun`).toBeTruthy()
    }
    expect(sellado.status).toBe("CERRADO")

    // T-26 barre 6/7 incluida la 6300, y el cierre deja 129 a cero.
    expect(await balance("6300", "2026-12-31")).toBe(0)
    expect(await balance("129", "2026-12-31")).toBe(0)
    expect(await balance("705", "2026-12-31")).toBe(0)
    expect(await balance("621", "2026-12-31")).toBe(0)

    // El ejercicio queda CERRADO y el `ClosingRun` sellado.
    const fy = await prisma.fiscalYear.findFirst({ where: { id: fy2026 } })
    expect(fy!.status).toBe("CLOSED")
    expect(sellado.seal).toBeTruthy()
    expect(String(sellado.ledgerHash)).toHaveLength(64)

    // I-E9-14: la apertura de 2027 es el espejo del cierre de 2026.
    const apertura = await prisma.journalEntry.findFirst({ where: { id: entryIds.apertura! } })
    expect(apertura!.fiscalYearId).toBe(fy2027)
    const [espejo] = await prisma.$queryRawUnsafe<{ desviacion: bigint | null }[]>(
      `SELECT SUM(a.debit_cents - c.credit_cents)::bigint AS desviacion
         FROM journal_lines a
         JOIN journal_lines c
           ON c.organization_id = a.organization_id AND c.entry_id = $2::uuid AND c.account_code = a.account_code
        WHERE a.organization_id = $1::uuid AND a.entry_id = $3::uuid`,
      ORG,
      entryIds.cierre!,
      entryIds.apertura!
    )
    expect(Number(espejo?.desviacion ?? 0)).toBe(0)
  }, 180_000)

})
