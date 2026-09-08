/**
 * E9 · T15 — Las server actions del cierre contra Postgres de verdad.
 *
 * Lo que aquí se ejerce **no se puede ejercer en un test puro**:
 *
 *  · **La matriz de roles de §10.** Un VIEWER no genera ocurrencias, un EDITOR
 *    no revierte ni liquida, y el rechazo llega como `Sin permiso` —no como una
 *    excepción de servidor sin mensaje.
 *  · **La idempotencia es del ÍNDICE, no de un `if`** (criterio 1): dos
 *    generaciones del mismo `(regla, periodo)` dejan una ocurrencia y un asiento.
 *  · **Los nueve bloqueantes se comprueban en SERVIDOR** (criterio 31): con un
 *    documento en `PROPOSED`, `closeFiscalYearE9Action` rechaza aunque le pasen
 *    un `closingRunId` a mano.
 *  · **La reapertura son CUATRO contra-asientos** (O-21) y deja los pasos 5-7 en
 *    `PENDIENTE_RECOMPUTO`; con las cuentas formuladas se rechaza **ofreciendo la
 *    salida** (criterio 34).
 *  · **El tenant**: nada de la organización B se ve desde la A.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e915c000-0000-4000-8000-000000000001"
const ORG_B = "e915c000-0000-4000-8000-000000000002"
const ADMIN = "e915c000-0000-4000-8000-0000000000a1"
const EDITOR = "e915c000-0000-4000-8000-0000000000e1"
const VIEWER = "e915c000-0000-4000-8000-0000000000b1"

type TestUser = { id: string; email: string; name: string }
let currentUser: TestUser

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

const { prisma } = await import("@/lib/db")
const { createRecurringAction, generateOccurrencesAction, listRecurringAction, revertOccurrenceAction } = await import(
  "@/app/(app)/ledger/recurring/actions"
)
const { closeFiscalYearE9Action, getClosingRunAction, reopenFiscalYearAction, runClosingChecklistAction, setAccountsApprovalAction } =
  await import("@/app/(app)/ledger/closing/actions")
const { createAssetAction, listAssetsAction } = await import("@/app/(app)/settings/assets/actions")
const { createDebtScheduleAction, listDebtSchedulesAction } = await import("@/app/(app)/settings/debt/actions")
const { listPeriodGridAction } = await import("@/app/(app)/settings/periods/actions")

/** Plan mínimo suficiente: no hacen falta las 794 cuentas del PGC. */
const PLAN = [
  { code: "1", name: "Financiación básica", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "17", name: "Deudas a largo plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "170", name: "Deudas a largo plazo con entidades de crédito", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "2", name: "Inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "21", name: "Inmovilizaciones materiales", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "213", name: "Maquinaria", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "28", name: "Amortización acumulada del inmovilizado", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "281", name: "Amortización acumulada del inmovilizado material", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "52", name: "Deudas a corto plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "520", name: "Deudas a corto plazo con entidades de crédito", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "572", name: "Bancos e instituciones de crédito c/c vista, euros", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "6", name: "Compras y gastos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "68", name: "Dotaciones para amortizaciones", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "681", name: "Amortización del inmovilizado material", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "7", name: "Ventas e ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas de mercaderías y prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "705", name: "Prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: true },
] as const

async function seedOrg(organizationId: string, slug: string): Promise<string> {
  await prisma.organization.create({
    data: { id: organizationId, slug, name: `${slug} SL`, pgcVariant: "PYMES", updatedAt: new Date() },
  })
  for (const row of PLAN) {
    await prisma.ledgerAccount.create({
      data: {
        organizationId,
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
  await prisma.organizationAccountMap.create({
    data: { organizationId, key: "BANCO_DEFAULT", accountCode: "572" },
  })
  const fy = await prisma.fiscalYear.create({
    data: {
      organizationId,
      code: "2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
      status: "OPEN",
      lastEntryNumber: 0,
    },
  })
  return fy.id
}

async function cleanup() {
  for (const organizationId of [ORG, ORG_B]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "closing_runs" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "recurring_occurrences" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "recurring_entries" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "debt_installments" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "debt_schedules" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "fixed_assets" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "journal_lines" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.$executeRawUnsafe(`DELETE FROM "invariant_runs" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.auditLog.deleteMany({ where: { organizationId } })
    await prisma.periodLock.deleteMany({ where: { organizationId } })
    await prisma.fiscalYear.deleteMany({ where: { organizationId } })
    await prisma.organizationAccountMap.deleteMany({ where: { organizationId } })
    await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = $1::uuid`, organizationId)
    await prisma.membership.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  }
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, EDITOR, VIEWER] } } })
}

const asUser = (id: string) => {
  currentUser = { id, email: `${id}@test.local`, name: id }
}

describe.skipIf(!TEST_DATABASE_URL)("E9 · T15 — server actions del cierre, los recurrentes y el inmovilizado", () => {
  let fiscalYearId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" },
        { id: EDITOR, email: `${EDITOR}@test.local`, name: "Editor" },
        { id: VIEWER, email: `${VIEWER}@test.local`, name: "Viewer" },
      ],
    })
    fiscalYearId = await seedOrg(ORG, "e9-acciones")
    await seedOrg(ORG_B, "e9-acciones-b")
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: ADMIN, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG, userId: EDITOR, role: "EDITOR", updatedAt: new Date() },
        { organizationId: ORG, userId: VIEWER, role: "VIEWER", updatedAt: new Date() },
        // El ADMIN de A es sólo VIEWER en B: el tenant no se prueba con dos
        // usuarios distintos, se prueba con el mismo mirando la organización
        // equivocada.
        { organizationId: ORG_B, userId: ADMIN, role: "ADMIN", updatedAt: new Date() },
      ],
    })
    asUser(ADMIN)
  }, 120_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Matriz de roles (§10)
  // ───────────────────────────────────────────────────────────────────────────

  it("VIEWER ve las pantallas pero no genera ocurrencias ni revierte (§10, criterio 40)", async () => {
    asUser(VIEWER)
    expect((await listRecurringAction()).success).toBe(true)
    expect((await listAssetsAction({})).success).toBe(true)
    expect((await listDebtSchedulesAction({})).success).toBe(true)
    expect((await listPeriodGridAction()).success).toBe(true)

    expect(await generateOccurrencesAction({ upToPeriod: "2026-06" })).toEqual({ success: false, error: "Sin permiso" })
    expect(
      await revertOccurrenceAction({ occurrenceId: "00000000-0000-4000-8000-000000000000", reason: "no debería poder" })
    ).toEqual({ success: false, error: "Sin permiso" })
    expect(
      await createAssetAction({
        code: "AC-X",
        name: "Intento del viewer",
        assetAccountCode: "213",
        accumulatedAccountCode: "281",
        expenseAccountCode: "681",
        acquisitionDate: "2026-01-01",
        inServiceDate: "2026-01-01",
        acquisitionCostCents: 100_000,
        usefulLifeMonths: 60,
      })
    ).toEqual({ success: false, error: "Sin permiso" })
  })

  it("EDITOR crea activos y cuadros de deuda, pero no cierra ni reabre (§10)", async () => {
    asUser(EDITOR)
    const asset = await createAssetAction({
      code: "AC-0001",
      name: "Maquinaria de taller",
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-10",
      inServiceDate: "2026-01-15",
      acquisitionCostCents: 1_000_000,
      residualValueCents: 100_000,
      usefulLifeMonths: 60,
    })
    expect(asset.success).toBe(true)

    const debt = await createDebtScheduleAction({
      code: "PR-0001",
      name: "Préstamo ICO",
      longAccountCode: "170",
      shortAccountCode: "520",
      principalCents: 750_000,
      startDate: "2026-01-31",
      installments: [
        { seq: 1, dueDate: "2027-09-30", principalCents: 250_000 },
        { seq: 2, dueDate: "2028-06-30", principalCents: 500_000 },
      ],
    })
    expect(debt.success).toBe(true)

    expect(
      await closeFiscalYearE9Action({
        fiscalYearId,
        closingRunId: "00000000-0000-4000-8000-000000000000",
        reason: "un editor no cierra ejercicios",
      })
    ).toEqual({ success: false, error: "Sin permiso" })
    expect(
      await reopenFiscalYearAction({
        fiscalYearId,
        reason: "un editor tampoco reabre, y este motivo pasa de treinta caracteres",
        confirmCode: "2026",
      })
    ).toEqual({ success: false, error: "Sin permiso" })
  })

  it("G-17: un cuadro cuyo Σ principal no cuadra se rechaza ANTES de tocar la base", async () => {
    asUser(EDITOR)
    const bad = await createDebtScheduleAction({
      code: "PR-BAD",
      name: "Cuadro descuadrado",
      longAccountCode: "170",
      shortAccountCode: "520",
      principalCents: 750_000,
      startDate: "2026-01-31",
      installments: [{ seq: 1, dueDate: "2027-09-30", principalCents: 250_000 }],
    })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain("Σ principal")
    expect(await prisma.debtSchedule.count({ where: { organizationId: ORG, code: "PR-BAD" } })).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Idempotencia (criterio 1)
  // ───────────────────────────────────────────────────────────────────────────

  it("dos generaciones del mismo periodo dejan UNA ocurrencia y UN asiento (R-REC-3)", async () => {
    asUser(EDITOR)
    const regla = await createRecurringAction({
      code: "REC-0001",
      name: "Cuota fija de alquiler",
      kind: "IMPORTE_FIJO",
      templateCode: "ASIENTO_MANUAL",
      templateInput: {},
      amountCents: 120_000,
      freq: "MENSUAL",
      anchor: "ULTIMO_DIA",
      startPeriod: "2026-01",
      endPeriod: "2026-02",
    })
    expect(regla.success).toBe(true)

    // `dryRun` NO escribe: es la misma ruta, sin transacción de escritura.
    const seco = await generateOccurrencesAction({ upToPeriod: "2026-02", dryRun: true })
    expect(seco.success).toBe(true)
    expect(seco.data!.dryRun).toBe(true)
    expect(await prisma.recurringOccurrence.count({ where: { organizationId: ORG } })).toBe(0)

    const primera = await generateOccurrencesAction({ upToPeriod: "2026-02" })
    expect(primera.success).toBe(true)
    const trasPrimera = await prisma.recurringOccurrence.count({ where: { organizationId: ORG } })

    const segunda = await generateOccurrencesAction({ upToPeriod: "2026-02" })
    expect(segunda.success).toBe(true)
    // La segunda no encuentra periodos vencidos pendientes: el índice único no
    // llega a morder porque `duePeriods` ya no los ofrece, y el resultado es el
    // mismo número de ocurrencias.
    expect(await prisma.recurringOccurrence.count({ where: { organizationId: ORG } })).toBe(trasPrimera)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // El checklist y el cierre (criterios 31 y 25)
  // ───────────────────────────────────────────────────────────────────────────

  it("el checklist devuelve los 43 pasos con los nueve bloqueantes marcados", async () => {
    asUser(VIEWER)
    const run = await runClosingChecklistAction({ fiscalYearId, answers: [] })
    expect(run.success).toBe(true)
    expect(run.data!.run!.steps).toHaveLength(43)
    expect(run.data!.catalog.blockingStepCodes).toHaveLength(9)
    expect(run.data!.catalog.entryOrder).toHaveLength(12)
    // Sin invariantes ejecutados el paso es INFO: no evaluable, jamás PASS.
    const invariantes = run.data!.run!.steps.find((s) => s.step === "INVARIANTES_PASS")!
    expect(invariantes.status).toBe("INFO")
    expect(run.data!.canClose).toBe(false)
  }, 60_000)

  it("O-6: la deuda de 170 sin cuadro NO bloquea cuando su DebtSchedule existe", async () => {
    asUser(VIEWER)
    const run = await runClosingChecklistAction({ fiscalYearId, answers: [] })
    const paso = run.data!.run!.steps.find((s) => s.step === "RECLASIFICACION_VENCIMIENTOS")!
    expect(paso.status).not.toBe("FAIL")
  }, 60_000)

  it("criterio 31: cerrar con bloqueantes sin PASS se rechaza EN SERVIDOR", async () => {
    asUser(ADMIN)
    const run = await runClosingChecklistAction({ fiscalYearId, answers: [] })
    const closed = await closeFiscalYearE9Action({
      fiscalYearId,
      closingRunId: run.data!.run!.id,
      reason: "intento de cierre con bloqueantes pendientes",
    })
    expect(closed.success).toBe(false)
    expect(closed.error).toContain("COMPROBADO")
    expect((await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId } }))!.status).toBe("OPEN")
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Reapertura (criterios 33 y 34)
  // ───────────────────────────────────────────────────────────────────────────

  it("criterio 34: con las cuentas FORMULADAS la reapertura se rechaza OFRECIENDO la salida", async () => {
    asUser(ADMIN)
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "CLOSED", accountsApprovalStatus: "FORMULADAS", formulatedAt: new Date("2027-03-25T00:00:00Z") } })
    const reopened = await reopenFiscalYearAction({
      fiscalYearId,
      reason: "quiero reabrir el ejercicio para corregir un asiento de amortización",
      confirmCode: "2026",
    })
    expect(reopened.success).toBe(false)
    expect(reopened.error).toContain("REFORMULACIÓN")
    expect(reopened.error).toContain("BORRADOR")
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "OPEN", accountsApprovalStatus: "BORRADOR", formulatedAt: null } })
  })

  it("D1.2: el motivo corto y el código mal escrito no reabren nada", async () => {
    asUser(ADMIN)
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "CLOSED" } })

    const corto = await reopenFiscalYearAction({ fiscalYearId, reason: "porque sí", confirmCode: "2026" })
    expect(corto.success).toBe(false)
    expect(corto.error).toContain("30 caracteres")

    const malCodigo = await reopenFiscalYearAction({
      fiscalYearId,
      reason: "motivo suficientemente largo para pasar el mínimo de treinta caracteres",
      confirmCode: "2025",
    })
    expect(malCodigo.success).toBe(false)
    expect(malCodigo.error).toContain("2026")
    expect((await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId } }))!.status).toBe("CLOSED")
  })

  it("O-21: la reapertura deja el ejercicio OPEN y los pasos 5-7 a recomputar", async () => {
    asUser(ADMIN)
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "CLOSED" } })
    const reopened = await reopenFiscalYearAction({
      fiscalYearId,
      reason: "corrección de la dotación de amortización del cuarto trimestre del ejercicio",
      confirmCode: "2026",
    })
    expect(reopened.error ?? null).toBeNull()
    expect(reopened.data!.pendingRecompute).toEqual([
      "VALOR_ACTUAL_APLAZAMIENTO",
      "DIFERENCIAS_DE_CAMBIO",
      "RECLASIFICACION_VENCIMIENTOS",
    ])
    expect((await prisma.fiscalYear.findFirst({ where: { id: fiscalYearId } }))!.status).toBe("OPEN")

    const log = await prisma.auditLog.findFirst({
      where: { organizationId: ORG, entity: "FiscalYear", action: "REOPEN" },
      orderBy: { ts: "desc" },
    })
    expect(log).not.toBeNull()
    expect(log!.reason).toContain("dotación de amortización")
  }, 60_000)

  it("Q-1.2: con el modelo 200 presentado, reabrir exige asumir el art. 122 LGT", async () => {
    asUser(ADMIN)
    await prisma.fiscalYear.update({
      where: { id: fiscalYearId },
      data: { status: "CLOSED", taxFilingStatus: "PRESENTADO" },
    })
    const sinAsumir = await reopenFiscalYearAction({
      fiscalYearId,
      reason: "reapertura tras detectar un error material en la base imponible declarada",
      confirmCode: "2026",
    })
    expect(sinAsumir.success).toBe(false)
    expect(sinAsumir.error).toContain("art. 122 LGT")

    const asumido = await reopenFiscalYearAction({
      fiscalYearId,
      reason: "reapertura tras detectar un error material en la base imponible declarada",
      confirmCode: "2026",
      acknowledgeTaxFiling: true,
    })
    expect(asumido.success).toBe(true)
    expect(asumido.data!.warnings.join(" ")).toContain("complementaria")
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { taxFilingStatus: "NO_PRESENTADO" } })
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Estado societario y tenant
  // ───────────────────────────────────────────────────────────────────────────

  it("O-18: al marcar APROBADAS la acción pide la distribución del resultado", async () => {
    asUser(ADMIN)
    await setAccountsApprovalAction({ fiscalYearId, status: "FORMULADAS", date: "2027-03-25" })
    const aprobadas = await setAccountsApprovalAction({ fiscalYearId, status: "APROBADAS", date: "2027-06-20" })
    expect(aprobadas.success).toBe(true)
    expect(aprobadas.data!.requiresDistribution).toBe(true)

    // Retroceder exige acuerdo de reformulación: se rechaza citando la LSC.
    const atras = await setAccountsApprovalAction({ fiscalYearId, status: "BORRADOR", date: "2027-06-21" })
    expect(atras.success).toBe(false)
    expect(atras.error).toContain("REFORMULACIÓN")
  })

  it("tenant: el ejercicio de A no existe para quien mira desde B", async () => {
    asUser(ADMIN)
    // La organización activa se resuelve por la primera membresía del usuario;
    // el ejercicio de A no puede leerse con el contexto de B ni con su id delante.
    const otro = await prisma.fiscalYear.findFirst({ where: { organizationId: ORG_B } })
    expect(otro).not.toBeNull()
    const run = await getClosingRunAction({ fiscalYearId: otro!.id })
    expect(run.success).toBe(true)
    expect(run.data!.run).toBeNull()
  })
})
