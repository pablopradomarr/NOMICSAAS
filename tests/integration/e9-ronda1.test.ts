/**
 * E9 · ronda 1 de corrección — los tres BLOQUEANTES de la auditoría y el del
 * revisor, sobre Postgres de verdad.
 *
 * Cada bloque reproduce **el defecto tal y como se reportó** y comprueba que ya
 * no ocurre. No se repite aquí nada que `e9-cierre-completo.test.ts` ya cubra.
 *
 *  · **H-1 · la DIRECCIÓN de T-32.** `readMaturityPositions` devolvía
 *    `credit − debit` y `lib/closing/reclass.ts` espera **`debe − haber`**: el
 *    motor leía una deuda como un crédito y posteaba la reclasificación **al
 *    revés**. Se comprueba sobre un **pasivo real** (`173 → 523`: `173 (D) /
 *    523 (H)`) y sobre un **activo real** (`253 → 543`: `543 (D) / 253 (H)`),
 *    que es el par simétrico. Y se comprueba el saldo resultante: el pasivo
 *    corriente **no puede quedar deudor**.
 *  · **H-4 · el desempate del FIFO.** `entryNumber` es el del asiento vivo más
 *    antiguo del grupo, no `0`.
 *  · **H-2 · los 26 `I-E9-*` corren.** Sobre el ejercicio cerrado aparecen los
 *    veintisiete ids en el `InvariantRun` sellado, y **I-E9-16 caza el signo
 *    invertido** si se reintroduce por SQL.
 *  · **H-3 · la reapertura es posible.** Sobre un ejercicio cerrado **de
 *    verdad** —con sus cuatro asientos—, `reopenFiscalYear` postea los cuatro
 *    contra-asientos, deja el ejercicio `OPEN`, los pasos 5-7 en
 *    `PENDIENTE_RECOMPUTO` y `129`/`6300` a cero; y `voidEntry`, la anulación
 *    pública, **sigue rechazando** los tres kind de CA-1.
 *  · **BLOQUEA 1 + DEBE 7 · los DOCE asientos de O-17.** El paso 12 —el
 *    contra-asiento de la reclasificación, nº 2 de N+1— se postea y se sella en
 *    `reclass_reversal_entry_id`; `473` queda a **0** tras T-25.
 *  · **H-6 · alterar el cuadro de deuda tras el cierre deja traza**: I-E9-25 en
 *    FAIL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { EntryDraft } from "@/lib/ledger/types"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e9210000-0000-4000-8000-000000000001"
const ADMIN = "e9210000-0000-4000-8000-0000000000a1"

let currentUser = { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" }
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
const { postEntry, runLedgerInvariants, voidEntry } = await import("@/models/ledger")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { readClosingInput, readClosingInvariantInput, readMaturityPositions } = await import("@/models/closing")
const { closeFiscalYearE9, reopenFiscalYear, runClosingChecklist } = await import("@/models/fiscal-years")
const { postClosingStepAction } = await import("@/app/(app)/ledger/closing/actions")
const { E9_INVARIANT_IDS, runClosingInvariants } = await import("@/lib/closing/invariants-e9")

/** Plan con los DOS lados del par: pasivo (173/523) y activo (253/543). */
const PLAN = [
  { code: "1", name: "Financiación básica", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "10", name: "Capital", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "100", name: "Capital social", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "12", name: "Resultados pendientes", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "129", name: "Resultado del ejercicio", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "17", name: "Deudas a largo plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "173", name: "Proveedores de inmovilizado a largo plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "2", name: "Inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "25", name: "Otras inversiones financieras a largo plazo", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "253", name: "Créditos a largo plazo por enajenación de inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "4", name: "Acreedores y deudores", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "47", name: "Administraciones públicas", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "473", name: "H.P. retenciones y pagos a cuenta", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "475", name: "H.P. acreedora", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "4752", name: "H.P. acreedora por impuesto sobre sociedades", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "52", name: "Deudas a corto plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: false },
  { code: "523", name: "Proveedores de inmovilizado a corto plazo", nature: "ACREEDORA", statement: "BALANCE_PASIVO", postable: true },
  { code: "54", name: "Otras inversiones financieras a corto plazo", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "543", name: "Créditos a corto plazo por enajenación de inmovilizado", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
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
  ["DEUDA_LARGO_INMOVILIZADO", "173"],
  ["CREDITO_ENAJENACION_CP", "543"],
  ["CREDITO_ENAJENACION_LP", "253"],
]

const CUTOFF = "2026-12-31"
let fy2026 = ""
let fy2027 = ""
let cecoId: string | null = null

const isPnl = (code: string): boolean => (code.startsWith("6") || code.startsWith("7")) && !code.startsWith("630")

async function post(
  fiscalYearId: string,
  entryDate: string,
  description: string,
  lines: { accountCode: string; debitCents: number; creditCents: number; dueDate?: string }[]
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
      dueDate: l.dueDate ?? null,
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

async function balance(accountCode: string, cutoff = CUTOFF): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
    `SELECT SUM(credit_cents - debit_cents)::bigint AS saldo
       FROM journal_lines
      WHERE organization_id = $1::uuid AND account_code = $2 AND entry_date <= $3::date AND entry_kind <> 'CLOSING'`,
    ORG,
    accountCode,
    cutoff
  )
  return Number(row?.saldo ?? 0)
}

/** Las líneas de un asiento, en su orden, para leer la DIRECCIÓN. */
async function lineasDe(entryId: string): Promise<{ accountCode: string; debitCents: number; creditCents: number }[]> {
  const rows = await prisma.journalLine.findMany({ where: { entryId }, orderBy: { lineNo: "asc" } })
  return rows.map((l) => ({
    accountCode: l.accountCode,
    debitCents: Number(l.debitCents),
    creditCents: Number(l.creditCents),
  }))
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
    `DELETE FROM allocation_lines WHERE organization_id = $1::uuid`,
    `DELETE FROM allocation_runs WHERE organization_id = $1::uuid`,
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

describe.skipIf(!TEST_DATABASE_URL)("E9 · ronda 1 — los bloqueantes de la auditoría y la revisión", () => {
  beforeAll(async () => {
    await limpiar()
    await prisma.user.create({ data: { id: ADMIN, email: `${ADMIN}@test.local`, name: "Admin" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e9-ronda1", name: "Ronda 1 SL", pgcVariant: "PYMES", updatedAt: new Date() },
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
      await prisma.organizationAccountMap.create({ data: { organizationId: ORG, key: key as never, accountCode } }).catch(() => undefined)
    }
    // Los dos pares que este test ejercita, sembrados como en M4.
    for (const [longAccountCode, shortAccountCode] of [
      ["173", "523"],
      ["253", "543"],
    ]) {
      await prisma.reclassificationPair.create({
        data: { organizationId: ORG, longAccountCode, shortAccountCode, thresholdMonths: 12, isActive: true },
      })
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

    // ── El ejercicio: capital, resultado, retención en 473 y las DOS posiciones
    //    con vencimiento DENTRO del año siguiente, que son las que se reclasifican.
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
    // **El PASIVO**: proveedor de inmovilizado a largo, con 500 000 venciendo en 2027.
    await post(fy2026, "2026-11-30", "Compra de inmovilizado con pago aplazado", [
      { accountCode: "572", debitCents: 1_500_000, creditCents: 0 },
      { accountCode: "173", debitCents: 0, creditCents: 1_000_000, dueDate: "2028-06-30" },
      { accountCode: "173", debitCents: 0, creditCents: 500_000, dueDate: "2027-06-30" },
    ])
    // **El ACTIVO**: crédito por enajenación a largo, con 200 000 venciendo en 2027.
    await post(fy2026, "2026-12-01", "Crédito por enajenación de inmovilizado", [
      { accountCode: "253", debitCents: 200_000, creditCents: 0, dueDate: "2027-09-30" },
      { accountCode: "572", debitCents: 0, creditCents: 200_000 },
    ])

    // O-6: toda deuda viva de 17x/52x necesita su cuadro de vencimientos, o el
    // paso de reclasificación es un FAIL bloqueante (I-E9-25). Se declara con su
    // `scheduleHash` REAL: el cuadro alterado del bloque H-6 es otro.
    const { debtScheduleHashOf } = await import("@/models/debt")
    const vencimientos = [
      { seq: 1, dueDate: "2027-06-30", principalCents: 500_000, interestCents: 0 },
      { seq: 2, dueDate: "2028-06-30", principalCents: 1_000_000, interestCents: 0 },
    ]
    const cuadro = await prisma.debtSchedule.create({
      data: {
        organizationId: ORG,
        code: "PRE-2026",
        name: "Proveedor de inmovilizado aplazado",
        longAccountCode: "173",
        shortAccountCode: "523",
        principalCents: BigInt(1_500_000),
        currency: "EUR",
        startDate: new Date("2026-11-30T00:00:00Z"),
        scheduleHash: debtScheduleHashOf(vencimientos),
      },
    })
    // G-17 es un constraint DIFERIDO (`Σ principal = principal_cents`): las dos
    // cuotas tienen que entrar en la MISMA transacción o la suma parcial salta.
    await prisma.$transaction(
      vencimientos.map((v) =>
        prisma.debtInstallment.create({
          data: {
            organizationId: ORG,
            debtScheduleId: cuadro.id,
            seq: v.seq,
            dueDate: new Date(`${v.dueDate}T00:00:00Z`),
            principalCents: BigInt(v.principalCents),
            interestCents: BigInt(v.interestCents),
          },
        })
      )
    )

    // Y los cuatro trimestres liquidados: `IVA_LIQUIDADO` es bloqueante y lo es
    // con razón (cerrar con un trimestre sin presentar es cerrar sobre una cifra
    // que la AEAT todavía puede mover).
    await liquidarTrimestres()
  }, 180_000)

  /** Los periodos de IVA con movimiento del ejercicio, dados por liquidados. */
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

  afterAll(async () => {
    if (!process.env.E9_KEEP) await limpiar()
    await prisma.$disconnect()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // H-1 · la DIRECCIÓN de T-32, sobre un pasivo y un activo reales
  // ───────────────────────────────────────────────────────────────────────────

  it("H-1 · `readMaturityPositions` devuelve `debe − haber` y el desempate del FIFO (H-4)", async () => {
    const posiciones = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readMaturityPositions(tx as never, { cutoff: CUTOFF, accountCodes: ["173", "523", "253", "543"] })
    )
    const largoPasivo = posiciones.filter((p) => p.accountCode === "173")
    // Una deuda es saldo ACREEDOR: en `debe − haber` es NEGATIVA. Con la
    // convención invertida salía positiva y el motor la trataba como crédito.
    expect(largoPasivo.every((p) => p.openCents < 0), "una deuda de 173 tiene que salir negativa").toBe(true)
    expect(largoPasivo.map((p) => p.openCents).sort((a, b) => a - b)).toEqual([-1_000_000, -500_000])

    const largoActivo = posiciones.find((p) => p.accountCode === "253")!
    expect(largoActivo.openCents, "un crédito de 253 tiene que salir positivo").toBe(200_000)

    // **H-4.** El desempate declarado por R-RC-3 existe: es el nº del asiento
    // vivo más antiguo del grupo, no `0` para todas las posiciones.
    expect(posiciones.every((p) => p.entryNumber > 0)).toBe(true)
  }, 60_000)

  it("H-1 · T-32 mueve el PASIVO 173 → 523 y el ACTIVO 253 → 543, cada uno en su sentido", async () => {
    const previo = { l173: await balance("173"), l253: await balance("253") }

    const posteado = await postClosingStepAction({
      fiscalYearId: fy2026,
      step: "RECLASIFICACION_VENCIMIENTOS",
      dryRun: false,
      params: {},
    })
    expect(posteado.success, posteado.error).toBe(true)

    const lineas = await lineasDe(posteado.data!.entryId!)
    // **La dirección**, que es lo que H-1 denuncia: el pasivo sale de la cuenta
    // de largo (DEBE) y entra en la de corto (HABER).
    expect(lineas).toContainEqual({ accountCode: "173", debitCents: 500_000, creditCents: 0 })
    expect(lineas).toContainEqual({ accountCode: "523", debitCents: 0, creditCents: 500_000 })
    // Y el activo al revés: entra en la de corto por el DEBE.
    expect(lineas).toContainEqual({ accountCode: "543", debitCents: 200_000, creditCents: 0 })
    expect(lineas).toContainEqual({ accountCode: "253", debitCents: 0, creditCents: 200_000 })

    // El pasivo NO corriente baja y el corriente **no queda deudor**, que era el
    // síntoma visible del signo invertido.
    expect(await balance("173")).toBe(previo.l173 - 500_000)
    expect(await balance("523")).toBe(500_000)
    expect(await balance("523")).toBeGreaterThan(0)
    expect(await balance("253")).toBe(previo.l253 + 200_000)
    expect(await balance("543")).toBe(-200_000)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // BLOQUEA 1 + DEBE 7 · los doce asientos, `473 = 0` y el paso 12
  // ───────────────────────────────────────────────────────────────────────────

  it("los DOCE asientos de O-17: T-25 cancela 473, y el paso 12 se postea y se sella", async () => {
    const impuesto = await postClosingStepAction({
      fiscalYearId: fy2026,
      step: "IMPUESTO_BENEFICIOS",
      dryRun: false,
      params: { taxRateBps: 2_500 },
    })
    expect(impuesto.success, impuesto.error).toBe(true)

    // **DEBE 7.** El comentario del test anterior prometía que «T-25 cancela
    // 473» y no lo comprobaba nadie. Aquí sí.
    expect(await balance("473"), "T-25 tiene que cancelar 473 (O-26)").toBe(0)

    // T-32 y T-25 son asientos más y caen en su propio periodo de IVA.
    await liquidarTrimestres()
    await runLedgerInvariants(
      ORG,
      { fiscalYearId: fy2026, refDate: CUTOFF, noCache: true, actor: { userId: ADMIN }, persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: ADMIN } }
    )
    const comprobado = await runClosingChecklist(ORG, fy2026, { userId: ADMIN }, { refDate: CUTOFF })
    expect(comprobado.ok, comprobado.ok ? "" : JSON.stringify(comprobado.errors)).toBe(true)
    expect(comprobado.value.status, JSON.stringify(comprobado.value.steps.filter((s) => s.blocking && s.status !== "PASS"))).toBe(
      "COMPROBADO"
    )

    const cerrado = await closeFiscalYearE9(
      ORG,
      { fiscalYearId: fy2026, closingRunId: comprobado.value.id, reason: "Cierre del ejercicio 2026 de la ronda 1" },
      { userId: ADMIN }
    )
    expect(cerrado.ok, cerrado.ok ? "" : JSON.stringify(cerrado.errors)).toBe(true)

    // **BLOQUEA 1.** El paso 12 existe, es un contra-asiento de verdad y está
    // sellado en su columna —que antes no escribía nadie—.
    const reversalId = cerrado.value.reclassReversalEntryId
    expect(reversalId, "el contra-asiento de la reclasificación no se ha posteado").toBeTruthy()
    const reversal = await prisma.journalEntry.findFirst({ where: { id: reversalId! } })
    expect(reversal!.kind).toBe("REVERSAL")
    expect(reversal!.reversesEntryId).toBeTruthy()
    expect(reversal!.fiscalYearId, "el contra-asiento vive en N+1 (O-8)").toBe(fy2027)
    // Nº 2 de N+1: **después** de la apertura (R-RC-6); si fuera antes, el
    // OPENING dejaría de ser el nº 1 e I-E9-14 saldría FAIL.
    expect(reversal!.entryNumber).toBe(2)
    const apertura = await prisma.journalEntry.findFirst({ where: { id: cerrado.value.apertura!.id } })
    expect(apertura!.entryNumber).toBe(1)

    const run = (await prisma.closingRun.findFirst({ where: { id: comprobado.value.id } })) as unknown as Record<string, unknown>
    expect(run.reclassReversalEntryId).toBe(reversalId)
    expect(run.aperturaEntryId).toBe(cerrado.value.apertura!.id)
    expect(run.status).toBe("CERRADO")

    // La reclasificación queda **deshecha en N+1**: la apertura trae los 500 000
    // en `523` y el contra-asiento los devuelve a `173`, de modo que los pagos
    // de 2027 cancelan `173` y no `523` (consecuencia contable de D5.6/O-8).
    const [mov2027] = await prisma.$queryRawUnsafe<{ c523: bigint | null; c173: bigint | null }[]>(
      `SELECT SUM(CASE WHEN account_code = '523' THEN credit_cents - debit_cents ELSE 0 END)::bigint AS c523,
              SUM(CASE WHEN account_code = '173' THEN credit_cents - debit_cents ELSE 0 END)::bigint AS c173
         FROM journal_lines
        WHERE organization_id = $1::uuid AND fiscal_year_id = $2::uuid`,
      ORG,
      fy2027
    )
    expect(Number(mov2027.c523 ?? 0), "en N+1, la apertura y su contra-asiento dejan 523 a cero").toBe(0)
    expect(Number(mov2027.c173 ?? 0), "y la deuda vuelve entera a 173").toBe(1_500_000)
  }, 180_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-2 · los 26 I-E9-* corren de verdad, e I-E9-16 caza el signo invertido
  // ───────────────────────────────────────────────────────────────────────────

  it("H-2 · los veintisiete `I-E9-*` aparecen en el `InvariantRun` sellado del ejercicio cerrado", async () => {
    const run = await runLedgerInvariants(ORG, {
      fiscalYearId: fy2026,
      refDate: CUTOFF,
      noCache: true,
      actor: { userId: ADMIN },
      persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: ADMIN },
    })
    const ids = run.validacion.checks.map((c) => c.id)
    // Antes: 0 de 215. La lista completa, ni uno menos.
    for (const id of E9_INVARIANT_IDS) expect(ids, `falta ${id} en el barrido`).toContain(id)

    // Y quedan **persistidos**, que es la mitad que faltaba: §6.3 los quiere en
    // `invariant_runs` y en la familia CIERRE de /audit.
    const fila = await prisma.invariantRun.findFirst({ where: { fiscalYearId: fy2026 }, orderBy: { createdAt: "desc" } })
    const persistidos = (Array.isArray(fila!.checks) ? (fila!.checks as { id: string }[]) : []).map((c) => c.id)
    expect(persistidos.filter((id) => id.startsWith("I-E9-")).length).toBe(E9_INVARIANT_IDS.length)
  }, 180_000)

  it("H-2 · I-E9-16 CAZA el signo invertido si se reintroduce", async () => {
    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    // Con el signo correcto, PASS.
    const sano = runClosingInvariants(bloque).find((c) => c.id === "I-E9-16")!
    expect(sano.status, sano.evidencia).toBe("PASS")

    // Se reintroduce el defecto de H-1 —negar `openCents`, que es exactamente lo
    // que hacía `SUM(credit − debit)`— y el invariante lo delata.
    const invertido = runClosingInvariants({
      ...bloque,
      reclass: {
        ...bloque.reclass!,
        positionsAfter: bloque.reclass!.positionsAfter.map((p) => ({ ...p, openCents: -p.openCents })),
      },
    }).find((c) => c.id === "I-E9-16")!
    expect(invertido.status, "con el signo invertido I-E9-16 tiene que FALLAR").toBe("FAIL")
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-6 · alterar el cuadro de deuda tras el cierre deja traza
  // ───────────────────────────────────────────────────────────────────────────

  it("H-6 · cambiar un vencimiento del cuadro sellado deja I-E9-25 en FAIL", async () => {
    const schedule = await prisma.debtSchedule.create({
      data: {
        organizationId: ORG,
        code: "PRE-R1",
        name: "Préstamo de la ronda 1",
        longAccountCode: "173",
        shortAccountCode: "523",
        principalCents: BigInt(500_000),
        currency: "EUR",
        startDate: new Date("2026-11-30T00:00:00Z"),
        scheduleHash: "0".repeat(64),
      },
    })
    await prisma.debtInstallment.create({
      data: {
        organizationId: ORG,
        debtScheduleId: schedule.id,
        seq: 1,
        dueDate: new Date("2027-06-30T00:00:00Z"),
        principalCents: BigInt(500_000),
        interestCents: BigInt(0),
      },
    })
    // El sello guardado (ceros) no puede coincidir con el recomputado: es
    // exactamente la situación de «alguien cambió el cuadro después».
    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    expect(bloque.reclass!.tamperedSchedules!.map((t) => t.reference)).toContain("PRE-R1")
    const check = runClosingInvariants(bloque).find((c) => c.id === "I-E9-25")!
    expect(check.status).toBe("FAIL")
    expect(check.evidencia).toContain("PRE-R1")

    await prisma.debtInstallment.deleteMany({ where: { debtScheduleId: schedule.id } })
    await prisma.debtSchedule.delete({ where: { id: schedule.id } })
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-3 · la reapertura, sobre un ejercicio cerrado DE VERDAD
  // ───────────────────────────────────────────────────────────────────────────

  it("H-3 · `voidEntry` (la anulación pública) sigue rechazando OPENING, CLOSING y REGULARIZATION", async () => {
    for (const templateCode of ["APERTURA_EJERCICIO", "CIERRE_EJERCICIO", "REGULARIZACION_RESULTADO"]) {
      // Con filtro de tenant (ronda 1 de E12, la regla del DEBE #4): sin él, en
      // una base con más de una organización —la de la suite de aceptación, la
      // del fixture de CI— la consulta traía el asiento de OTRA y `voidEntry`
      // respondía ENTRY_NOT_FOUND, que no es lo que este test comprueba.
      const target = await prisma.journalEntry.findFirst({
        where: { organizationId: ORG, templateCode, voidedAt: null },
      })
      expect(target, `falta el asiento ${templateCode} del cierre real`).toBeTruthy()
      const r = await voidEntry(ORG, target!.id, "intento de anular un asiento de sistema desde fuera", { userId: ADMIN })
      expect(r.ok, `${templateCode} NO puede anularse por la vía pública (CA-1)`).toBe(false)
      if (!r.ok) expect(JSON.stringify(r.errors)).toContain("CA-1")
    }
  }, 120_000)

  it("H-3 · la reapertura postea los CUATRO contra-asientos y deja el ejercicio OPEN", async () => {
    const antes = { b129: await balance("129"), b6300: await balance("6300") }

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

    // O-21: T-28 → T-27 → T-26 → **T-25**. Los cuatro, no tres.
    expect(reabierto.value.reversalEntryIds.length, "la reapertura son CUATRO contra-asientos (O-21)").toBe(4)
    const revertidos = await prisma.journalEntry.findMany({
      where: { id: { in: [...reabierto.value.reversalEntryIds] } },
      select: { kind: true, reversesEntryId: true, templateCode: true },
    })
    // **R-1 (ronda 2).** El espejo de un asiento de sistema hereda su `kind`
    // —`OPENING`, `CLOSING`, `REGULARIZATION`— para que el par netee en todos los
    // filtros por `kind`; el de un asiento normal (T-25) sigue siendo `REVERSAL`.
    // Los cuatro son contra-asientos: `reversesEntryId` y plantilla.
    expect(
      revertidos.every(
        (r) =>
          r.reversesEntryId !== null &&
          r.templateCode === "CONTRA_ASIENTO" &&
          ["REVERSAL", "OPENING", "CLOSING", "REGULARIZATION"].includes(r.kind)
      )
    ).toBe(true)

    const fy = await prisma.fiscalYear.findFirst({ where: { id: fy2026 } })
    expect(fy!.status).toBe("OPEN")
    expect(fy!.closedAt).toBeNull()

    // **I-E9-21**: `129` y `6300` vuelven a cero tras deshacer el cierre. Se mide
    // acumulado y **excluyendo el cierre y la apertura**: los contra-asientos de
    // O-21 se fechan en el primer periodo abierto —2027—, así que un corte a
    // 31-12-2026 no los vería y la comprobación diría lo contrario de lo que
    // pasa. `antes` sí se midió a 2026 y por eso NO era cero.
    const saldoVivo = async (accountCode: string): Promise<number> => {
      const [row] = await prisma.$queryRawUnsafe<{ saldo: bigint | null }[]>(
        `SELECT SUM(credit_cents - debit_cents)::bigint AS saldo
           FROM journal_lines
          WHERE organization_id = $1::uuid AND account_code = $2
            AND entry_kind NOT IN ('CLOSING', 'OPENING')`,
        ORG,
        accountCode
      )
      return Number(row?.saldo ?? 0)
    }
    expect(antes.b129, "antes de reabrir, 129 llevaba el resultado del ejercicio").not.toBe(0)
    expect(await saldoVivo("129"), "tras la reapertura, 129 vuelve a cero (I-E9-21)").toBe(0)
    expect(await saldoVivo("6300"), "y 6300 también: T-25 se revierte (O-21)").toBe(0)

    // Los pasos 5-7 quedan a recomputar (O-21) y el run, REABIERTO.
    expect([...reabierto.value.pendingRecompute].sort()).toEqual(
      [
        "DIFERENCIAS_DE_CAMBIO",
        "IMPUESTO_BENEFICIOS",
        "IMPUESTO_DIFERIDO_RESPONDIDO",
        "RECLASIFICACION_VENCIMIENTOS",
        "VALOR_ACTUAL_APLAZAMIENTO",
      ].sort()
    )
    const run = await prisma.closingRun.findFirst({ where: { id: reabierto.value.closingRunId! } })
    expect(run!.status).toBe("REABIERTO")
    const steps = (Array.isArray(run!.steps) ? (run!.steps as { step: string; status: string }[]) : [])
    for (const code of reabierto.value.pendingRecompute) {
      expect(steps.find((s) => s.step === code)?.status, `${code} tiene que quedar PENDIENTE_RECOMPUTO`).toBe(
        "PENDIENTE_RECOMPUTO"
      )
    }

    // **El GUC muere con la transacción**: fuera de la reapertura, CA-1 vuelve a
    // ser absoluto. Se comprueba sobre el contra-asiento del cierre, que ahora
    // es el asiento vivo de kind CLOSING… y que además CA-2 protege.
    const closingVivo = await prisma.journalEntry.findFirst({ where: { kind: "CLOSING", voidedAt: null } })
    if (closingVivo) {
      const r = await voidEntry(ORG, closingVivo.id, "el GUC de reapertura no puede sobrevivir a su transacción", {
        userId: ADMIN,
      })
      expect(r.ok).toBe(false)
    }
  }, 180_000)

  it("el bloque `closing` de los invariantes se compone sin reventar tras la reapertura", async () => {
    const bloque = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInvariantInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    expect(runClosingInvariants(bloque).map((c) => c.id).sort()).toEqual([...E9_INVARIANT_IDS].sort())
    const input = await tenantTransaction(ORG, ADMIN, async (tx) =>
      readClosingInput(tx as never, { fiscalYearId: fy2026, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    expect(input.reclassificationPairs.length).toBe(2)
  }, 120_000)
})
