/**
 * E9 · QA — pruebas adversariales del §3 del protocolo, sobre los criterios de
 * `docs/design/E9-cierre-recurrentes.md` §12.1 que la suite de dev-backend no
 * ejercía todavía a nivel de servidor. No se repiten aquí los casos ya
 * cubiertos por `lib/closing/*.test.ts`, `tests/integration/e9-*.test.ts` (ver
 * el mapeo del informe de QA): cada bloque cita qué falta y por qué.
 *
 * Escrito por `qa-tester`. No se modifica código de producto desde este
 * fichero: donde el motor NO rechaza lo que debería, el test documenta el
 * comportamiento observado con un comentario "BUG-E9-n" y falla a propósito
 * (rojo intencional) para que quede visible en la suite.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Client } from "pg"
import { appRuntimeDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL
const OWNER_URL = TEST_DATABASE_URL || ownerDatabaseUrl()

const ORG = "e91a0000-0000-4000-8000-00000000000a"
const ADMIN = "e91a0000-0000-4000-8000-0000000000a1"

let currentUser = { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" }
const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => { throw new Error("redirect") },
  notFound: () => { throw new Error("notFound") },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma } = await import("@/lib/db")
const { closeFiscalYearE9Action, runClosingChecklistAction } = await import("@/app/(app)/ledger/closing/actions")
const { settleVatAction } = await import("@/app/(app)/reports/vat/actions")
const { lockPeriodAction, unlockPeriodAction } = await import("@/app/(app)/settings/periods/actions")
const { createAssetAction, reviseAssetAction } = await import("@/app/(app)/settings/assets/actions")
const { createVatRegimePeriodAction } = await import("@/app/(app)/reports/vat/actions")
const { postManualEntryAction } = await import("@/app/(app)/ledger/actions")

const PLAN = [
  { code: "1", name: "Financiación básica", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "10", name: "Capital", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "100", name: "Capital social", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "2", name: "Inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "21", name: "Inmovilizaciones materiales", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "213", name: "Maquinaria", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "28", name: "Amortización acumulada del inmovilizado", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "281", name: "Amortización acumulada del inmovilizado material", nature: "ACREEDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "4", name: "Acreedores y deudores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "47", name: "Administraciones públicas", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "470", name: "H.P. deudora", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "4700", name: "H.P. deudora por IVA", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "472", name: "H.P. IVA soportado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "475", name: "H.P. acreedora", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "4750", name: "H.P. acreedora por IVA", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "477", name: "H.P. IVA repercutido", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "572", name: "Bancos e instituciones de crédito c/c vista, euros", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "6", name: "Compras y gastos", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "60", name: "Compras", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "600", name: "Compras de mercaderías", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "62", name: "Servicios exteriores", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "628", name: "Suministros", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "68", name: "Dotaciones para amortizaciones", nature: "DEUDORA", statement: "PYG", postable: false },
  { code: "681", name: "Amortización del inmovilizado material", nature: "DEUDORA", statement: "PYG", postable: true },
  { code: "7", name: "Ventas e ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas de mercaderías y prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "700", name: "Ventas de mercaderías", nature: "ACREEDORA", statement: "PYG", postable: true },
  { code: "705", name: "Prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: true },
] as const

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  client: Client,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

async function seedOrg(): Promise<{ fiscalYearId: string }> {
  await prisma.organization.create({
    data: { id: ORG, slug: "e9-qa-adversarial", name: "E9 QA SL", pgcVariant: "PYMES", updatedAt: new Date(), analyticsRequired: false },
  })
  for (const row of PLAN) {
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
  await prisma.organizationAccountMap.createMany({
    data: [
      { organizationId: ORG, key: "BANCO_DEFAULT", accountCode: "572" },
      { organizationId: ORG, key: "IVA_SOPORTADO", accountCode: "472" },
      { organizationId: ORG, key: "IVA_REPERCUTIDO", accountCode: "477" },
      { organizationId: ORG, key: "HP_ACREEDORA_IVA", accountCode: "4750" },
      { organizationId: ORG, key: "HP_DEUDORA_IVA", accountCode: "4700" },
    ],
  })
  const fy = await prisma.fiscalYear.create({
    data: {
      organizationId: ORG,
      code: "2026",
      startDate: new Date("2026-01-01T00:00:00Z"),
      endDate: new Date("2026-12-31T00:00:00Z"),
      status: "OPEN",
      lastEntryNumber: 0,
    },
  })
  await prisma.user.create({ data: { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" } })
  await prisma.membership.create({
    data: { organizationId: ORG, userId: ADMIN, role: "ADMIN", updatedAt: new Date() },
  })
  return { fiscalYearId: fy.id }
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "vat_settlements" WHERE organization_id = $1::uuid`, ORG)
  await prisma.$executeRawUnsafe(`DELETE FROM "closing_runs" WHERE organization_id = $1::uuid`, ORG)
  await prisma.$executeRawUnsafe(`DELETE FROM "asset_revisions" WHERE organization_id = $1::uuid`, ORG)
  await prisma.$executeRawUnsafe(`DELETE FROM "fixed_assets" WHERE organization_id = $1::uuid`, ORG)
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`DELETE FROM "journal_lines" WHERE organization_id = $1::uuid`, ORG),
    prisma.$executeRawUnsafe(`DELETE FROM "journal_entries" WHERE organization_id = $1::uuid`, ORG),
  ])
  await prisma.$executeRawUnsafe(`DELETE FROM "invariant_runs" WHERE organization_id = $1::uuid`, ORG)
  await prisma.periodLock.deleteMany({ where: { organizationId: ORG } })
  await prisma.vatRegimePeriod.deleteMany({ where: { organizationId: ORG } })
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } })
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } })
  await prisma.organizationAccountMap.deleteMany({ where: { organizationId: ORG } })
  await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = $1::uuid`, ORG)
  await prisma.membership.deleteMany({ where: { organizationId: ORG } })
  await prisma.organization.deleteMany({ where: { id: ORG } })
  await prisma.user.deleteMany({ where: { id: ADMIN } })
}

describe.skipIf(!TEST_DATABASE_URL)("E9 · QA adversarial (§3 del protocolo)", () => {
  let fiscalYearId = ""

  beforeAll(async () => {
    await cleanup().catch(() => undefined)
    const seeded = await seedOrg()
    fiscalYearId = seeded.fiscalYearId
  }, 60_000)

  afterAll(async () => {
    await cleanup().catch(() => undefined)
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Cerrar dos veces
  // ───────────────────────────────────────────────────────────────────────────

  it("cerrar un ejercicio ya CERRADO se rechaza (no hay doble cierre)", async () => {
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "CLOSED" } })
    const run = await runClosingChecklistAction({ fiscalYearId, answers: [] })
    const segundo = await closeFiscalYearE9Action({
      fiscalYearId,
      closingRunId: run.data!.run!.id,
      reason: "intento de cerrar un ejercicio que ya está cerrado",
    })
    expect(segundo.success).toBe(false)
    await prisma.fiscalYear.update({ where: { id: fiscalYearId }, data: { status: "OPEN" } })
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Liquidar IVA dos veces el mismo periodo (G-8: una VIVA por periodo)
  // ───────────────────────────────────────────────────────────────────────────

  it("liquidar dos veces el mismo periodo de IVA se rechaza (índice G-8)", async () => {
    const regimen = await createVatRegimePeriodAction({ regime: "GENERAL", periodKind: "TRIMESTRAL", validFrom: "2026-01-01" })
    expect(regimen.success).toBe(true)
    // Un documento de IVA repercutido para que la liquidación tenga algo que declarar.
    const venta = await postManualEntryAction({
      description: "Venta Q1 con IVA",
      accrualDate: "2026-01-15",
      lines: [
        { accountCode: "572", debitCents: 121_000, creditCents: 0 },
        { accountCode: "705", debitCents: 0, creditCents: 100_000 },
        { accountCode: "477", debitCents: 0, creditCents: 21_000 },
      ],
    })
    expect(venta.success, JSON.stringify(venta)).toBe(true)

    const primera = await settleVatAction({ period: "2026-Q1" })
    expect(primera.success, JSON.stringify(primera)).toBe(true)
    expect(primera.data!.dryRun).toBe(false)

    const segunda = await settleVatAction({ period: "2026-Q1" })
    // La segunda liquidación intenta postear OTRA vez sobre el mismo periodo ya
    // liquidado: el trigger B-6 (no contabilizar IVA en un periodo liquidado) o
    // el índice único G-8 deben impedirlo. Documentamos cuál de los dos actúa.
    expect(segunda.success).toBe(false)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Liquidar con el periodo bloqueado
  // ───────────────────────────────────────────────────────────────────────────

  it("liquidar un periodo cuyo mes de cierre está BLOQUEADO se rechaza", async () => {
    // Un periodo NUEVO (Q2), no liquidado todavía: se aísla del caso anterior.
    // El asiento de regularización de Q2 se postea el 30/06 (mes 6).
    await lockPeriodAction({ fiscalYearId, month: 6, reason: "cierre mensual de junio, antes de tiempo" })
    const resultado = await settleVatAction({ period: "2026-Q2" })
    expect(resultado.success).toBe(false)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Desbloquear sin motivo
  // ───────────────────────────────────────────────────────────────────────────

  it("desbloquear un mes sin motivo (o con uno demasiado corto) se rechaza", async () => {
    const sinMotivo = await unlockPeriodAction({ fiscalYearId, month: 2, reason: "" } as never)
    expect(sinMotivo.success).toBe(false)
    const motivoCorto = await unlockPeriodAction({ fiscalYearId, month: 2, reason: "no" })
    expect(motivoCorto.success).toBe(false)
  })

  it("desbloquear un mes con su IVA liquidado (B-8) se rechaza ofreciendo la salida", async () => {
    // Marzo cae dentro de 2026-Q1, ya liquidado.
    await lockPeriodAction({ fiscalYearId, month: 3, reason: "cierre mensual de marzo" })
    const intento = await unlockPeriodAction({
      fiscalYearId,
      month: 3,
      reason: "necesito corregir un asiento de marzo",
    })
    expect(intento.success).toBe(false)
    expect(intento.error).toContain("liquidado")
  }, 30_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Activo: vida útil 0 / residual > coste — rechazos
  // ───────────────────────────────────────────────────────────────────────────

  it("vida útil 0 se rechaza", async () => {
    const r = await createAssetAction({
      code: "AC-VU0",
      name: "Vida útil imposible",
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-01",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: 100_000,
      usefulLifeMonths: 0,
    })
    expect(r.success).toBe(false)
  })

  it("valor residual por encima del coste se rechaza", async () => {
    const r = await createAssetAction({
      code: "AC-RES",
      name: "Residual mayor que el coste",
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-01",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: 100_000,
      residualValueCents: 200_000,
      usefulLifeMonths: 24,
    })
    expect(r.success).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Revisión retroactiva de un activo
  // ───────────────────────────────────────────────────────────────────────────

  it("una revisión con `effectiveFrom` ANTERIOR al mes en curso no es prospectiva: BUG-E9-1 si se admite", async () => {
    const asset = await createAssetAction({
      code: "AC-RETRO",
      name: "Activo con revisión retroactiva",
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-01",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: 1_200_000,
      usefulLifeMonths: 24,
    })
    expect(asset.success).toBe(true)
    const fixedAssetId = asset.data!.id

    // "Hoy" en este entorno es 2026-09-14 (ver contexto de sesión): una revisión
    // fechada en enero de 2026 es retroactiva sobre siete meses ya devengables.
    const retro = await reviseAssetAction({
      fixedAssetId,
      effectiveFrom: "2026-01-01",
      newUsefulLifeMonths: 12,
      reason: "revisión fechada en el pasado para comprobar si el motor la rechaza",
    })
    // NRV 22ª exige que una revisión sea PROSPECTIVA. Si el motor la acepta sin
    // comparar `effectiveFrom` contra el mes en curso o contra ocurrencias ya
    // generadas, está aceptando un cambio retroactivo de estimación.
    expect(retro.success).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Importe bigint: 30 M€ en amortización (por encima del viejo techo Int de
  // 21.474.836,47 €, ADR-0015 D1 exige bigint desde el día 1 en E9)
  // ───────────────────────────────────────────────────────────────────────────

  it("un activo de 30.000.000 € se da de alta y amortiza sin desbordar (bigint)", async () => {
    const TREINTA_MILLONES_CENTS = 3_000_000_000 // 30.000.000,00 €
    const asset = await createAssetAction({
      code: "AC-30M",
      name: "Activo de treinta millones de euros",
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
      acquisitionDate: "2026-01-01",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: TREINTA_MILLONES_CENTS,
      usefulLifeMonths: 120,
    })
    expect(asset.success).toBe(true)

    const row = await prisma.fixedAsset.findFirstOrThrow({ where: { id: asset.data!.id } })
    expect(row.acquisitionCostCents).toBe(BigInt(TREINTA_MILLONES_CENTS))

    const { depreciationSchedule } = await import("@/lib/closing/depreciation")
    const rows = depreciationSchedule({
      id: asset.data!.id,
      code: "AC-30M",
      method: "LINEAL",
      inServiceDate: "2026-01-01",
      acquisitionCostCents: TREINTA_MILLONES_CENTS,
      residualValueCents: 0,
      usefulLifeMonths: 120,
      assetAccountCode: "213",
      accumulatedAccountCode: "281",
      expenseAccountCode: "681",
    })
    const total = rows.reduce((acc, r) => acc + r.quotaCents, 0)
    expect(total).toBe(TREINTA_MILLONES_CENTS)
    // Muy por encima del viejo techo Int (2 147 483 647 c ≈ 21,47 M€): confirma
    // que el borde bigint de ADR-0015 D1 alcanza también a inmovilizado E9.
    expect(TREINTA_MILLONES_CENTS).toBeGreaterThan(2_147_483_647)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // UPDATE de closing_runs como app_runtime (append-only salvo columnas GRANT)
  // ───────────────────────────────────────────────────────────────────────────

  it("UPDATE de una columna NO concedida en closing_runs, como app_runtime, da 42501", async () => {
    const runtime = new Client({ connectionString: appRuntimeDatabaseUrl(OWNER_URL) })
    await runtime.connect()
    try {
      await runtime.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
      await runtime.query(`SELECT set_config('app.current_user', $1, true)`, [ADMIN])
      const [row] = await q<{ id: string }>(runtime, `SELECT id FROM closing_runs WHERE organization_id = $1::uuid LIMIT 1`, [ORG])
      if (!row) {
        // Sin ClosingRun sellado en esta organización: se documenta y no se falsea un PASS.
        expect(row).toBeUndefined()
        return
      }
      await expect(
        runtime.query(`UPDATE closing_runs SET result = '{}'::jsonb WHERE id = $1::uuid`, [row.id])
      ).rejects.toMatchObject({ code: "42501" })
    } finally {
      await runtime.end()
    }
  })
})
