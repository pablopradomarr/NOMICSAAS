/**
 * E7 · **ronda 1 de corrección** — los siete hallazgos del `auditor-fiabilidad`
 * (`docs/design/E7-auditoria-informe.md`, veredicto DISCREPANCIA), medidos por
 * los caminos de PRODUCCIÓN y contra Postgres de verdad.
 *
 * Los tests unitarios de `lib/audit/*.test.ts` demuestran que el MOTOR hace lo
 * correcto. Lo que el auditor destapó, sin embargo, no fue un motor equivocado:
 * fueron **bordes sin conectar** —`fx` que nadie rellenaba, `pendingKind` que
 * nadie escribía, un sello que se calculaba antes que sus motivos, un periodo de
 * extracto que se deducía en vez de leerse—. Eso sólo se puede comprobar aquí.
 *
 * | Hallazgo | Qué se comprueba |
 * |---|---|
 * | **H-1** | Una cuenta en USD cuadra **en USD**; `createMatchGroup` compara en la divisa de la cuenta y a tasa ≠ 1 sigue conciliando |
 * | **H-2** | `headlineFigures` a 31-12 sobre el fixture completo: 13 673 820 / 13 673 820, no 0 / 0 |
 * | **H-3** | `readBankInvariantInput` rellena `fx` y el barrido mide de verdad la diferencia de cambio (WARN + motivo de sello) |
 * | **H-4** | Conciliación pendiente ⇒ el periodo se sella **REQUIERE REVISIÓN** |
 * | **H-5** | `pendingKind` se escribe al tipar y se borra al conciliar/ignorar; `resolvedLaterIds` sale poblado y el pendiente queda «explicado» |
 * | **H-6** | I-E7-14 se evalúa en el alcance `FISCAL_YEAR`, con la apertura del ejercicio siguiente |
 * | **H-7** | El periodo del extracto sale del **registro 11**, no del primer y el último movimiento |
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e7a10000-0000-4000-8000-00000000001a"
const ORG_FIX = "e7a10000-0000-4000-8000-00000000002a"
const USER = "e7a10000-0000-4000-8000-0000000a0001"
// La organización del fixture lleva SU usuario: la acción de servidor resuelve la
// organización desde la sesión, y un usuario con dos membresías la elegiría al azar.
const USER_FIX = "e7a10000-0000-4000-8000-0000000a0002"

let currentUser: { id: string; email: string; name: string }
const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { buildEntry } = await import("@/lib/ledger/post")
const { getLedgerContext, postEntry, runLedgerInvariants } = await import("@/models/ledger")
const { headlineFigures, auditBlock } = await import("@/models/audit")
const {
  createBankAccount,
  createMatchGroup,
  ignoreLine,
  importStatement,
  pendingItems,
  readBankInvariantInput,
} = await import("@/models/bank")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { parseN43 } = await import("@/lib/bank/n43")
const { toSummaryView, toAccountView } = await import("@/app/(app)/audit/bank/shared")

type ActionResult = { success: boolean; error?: string | null; data?: unknown }
const actions = async () => await import("@/app/(app)/audit/actions")

// ─────────────────────────────────────────────────────────────────────────────
// Un extracto Norma 43 por POSICIONES (ancho fijo: concatenar produce ficheros
// que «parecen» válidos y se parsean mal). Con divisa parametrizable, que es lo
// que H-1 necesita.
// ─────────────────────────────────────────────────────────────────────────────

function n43(opts: {
  account: string
  from: string
  to: string
  openingCents: number
  currency?: string
  movements: { date: string; amountCents: number; concept: string }[]
}): string {
  const currency = opts.currency ?? "978"
  const aammdd = (iso: string): string => `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
  const amount14 = (cents: number): string => String(Math.abs(cents)).padStart(14, "0")
  const record = (fields: [number, number, string][]): string => {
    const buf = new Array(80).fill(" ")
    for (const [from, to, value] of fields) {
      const width = to - from + 1
      const text = value.length > width ? value.slice(0, width) : value.padEnd(width, " ")
      for (let i = 0; i < width; i++) buf[from - 1 + i] = text[i]
    }
    return buf.join("")
  }

  const rows: string[] = []
  rows.push(
    record([
      [1, 2, "11"],
      [3, 6, "2100"],
      [7, 10, "0418"],
      [11, 20, opts.account.padStart(10, "0")],
      [21, 26, aammdd(opts.from)],
      [27, 32, aammdd(opts.to)],
      [33, 33, opts.openingCents < 0 ? "1" : "2"],
      [34, 47, amount14(opts.openingCents)],
      [48, 50, currency],
      [51, 51, "3"],
      [52, 77, "CUENTA DE PRUEBA"],
    ])
  )
  let closing = opts.openingCents
  for (const m of opts.movements) {
    closing += m.amountCents
    rows.push(
      record([
        [1, 2, "22"],
        [3, 6, "2100"],
        [7, 10, "0418"],
        [11, 16, aammdd(m.date)],
        [17, 22, aammdd(m.date)],
        [23, 24, "12"],
        [25, 27, "003"],
        [28, 28, m.amountCents < 0 ? "1" : "2"],
        [29, 42, amount14(m.amountCents)],
        [43, 52, "0000000000"],
        [53, 64, ""],
        [65, 80, ""],
      ])
    )
    rows.push(record([[1, 2, "23"], [3, 4, "01"], [5, 42, m.concept]]))
  }
  const debits = opts.movements.filter((m) => m.amountCents < 0)
  const credits = opts.movements.filter((m) => m.amountCents >= 0)
  rows.push(
    record([
      [1, 2, "33"],
      [3, 6, "2100"],
      [7, 10, "0418"],
      [11, 20, opts.account.padStart(10, "0")],
      [21, 25, String(debits.length).padStart(5, "0")],
      [26, 39, amount14(debits.reduce((a, m) => a + Math.abs(m.amountCents), 0))],
      [40, 44, String(credits.length).padStart(5, "0")],
      [45, 58, amount14(credits.reduce((a, m) => a + m.amountCents, 0))],
      [59, 59, closing < 0 ? "1" : "2"],
      [60, 73, amount14(closing)],
      [74, 76, currency],
    ])
  )
  rows.push(record([[1, 2, "88"], [3, 20, "9".repeat(18)], [21, 26, String(rows.length + 1).padStart(6, "0")]]))
  return rows.join("\n")
}

async function cleanupOrg(org: string): Promise<void> {
  await prisma
    .$executeRawUnsafe(`UPDATE journal_entries SET transaction_id = NULL WHERE organization_id = $1::uuid`, org)
    .catch(() => undefined)
  for (const table of [
    "transactions",
    "bank_pending_kinds",
    "bank_reconciliations",
    "bank_match_groups",
    "bank_statement_lines",
    "bank_statements",
    "bank_accounts",
    "invariant_runs",
    "store_sweeps",
    "manual_review_flags",
    "report_runs",
    "allocation_lines",
    "allocation_runs",
    "allocation_rule_targets",
    "allocation_rules",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org).catch(() => undefined)
  }
  // Las líneas y las cabeceras, en la MISMA transacción: el constraint trigger
  // diferido de «un asiento tiene al menos dos líneas» sólo se calla si al
  // COMMIT tampoco existe la cabecera.
  await prisma
    .$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, org),
      prisma.$executeRawUnsafe(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, org),
    ])
    .catch(() => undefined)
  for (const table of [
    "extraction_runs",
    "files",
    "audit_logs",
    "period_locks",
    "fiscal_years",
    "margin_level_configs",
    "currencies",
    "tax_rates",
    "organization_account_maps",
    "cost_centers",
    "projects",
    "business_lines",
    "accounts",
    "memberships",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org).catch(() => undefined)
  }
  await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, org).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · ronda 1 — los siete hallazgos de la auditoría", () => {
  let eurCode = ""
  let usdCode = ""
  let counterCode = ""
  let usdRateId = ""

  beforeAll(async () => {
    await cleanupOrg(ORG)
    await cleanupOrg(ORG_FIX)
    for (const id of [USER, USER_FIX]) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, id).catch(() => undefined)
    }
    await prisma.user.createMany({
      data: [
        { id: USER, email: "e7-ronda1@test.local", name: "Ronda 1" },
        { id: USER_FIX, email: "e7-ronda1-fixture@test.local", name: "Ronda 1 fixture" },
      ],
    })
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: USER } })

    for (const [id, slug, owner] of [
      [ORG, "e7-ronda1", USER],
      [ORG_FIX, "e7-ronda1-fixture", USER_FIX],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: slug, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await prisma.membership.create({
        data: { organizationId: id, userId: owner, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      })
    }

    // ORG: plan, DOS ejercicios (2026 y 2027: H-6 necesita el siguiente) y dimensiones.
    await importNpgc(ORG, "PYMES", { actor: { userId: USER }, now: new Date("2026-01-01"), useSubaccounts: true })
    for (const year of ["2026", "2027"] as const) {
      const fy = await openFiscalYear(
        ORG,
        { code: year, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
        { userId: USER }
      )
      if (!fy.ok) throw new Error(`no se pudo abrir el ejercicio ${year}`)
    }
    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
      await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${ORG}::uuid`
    })

    const db = tenantDb(ORG)
    eurCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "572" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code
    usdCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "573" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code
    counterCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "430" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code

    // La tasa de CONTABILIZACIÓN (0,92) y la de CIERRE (0,90). Que sean distintas
    // es lo que hace que I-E7-12 mida algo: con una sola tasa —o con paridad
    // 1:1— el invariante no puede fallar nunca, que es lo que encubría H-1.
    const rate = await prisma.exchangeRate.create({
      data: { date: new Date("2026-03-01"), from: "USD", to: "EUR", rateMicro: BigInt(920000), source: "test" },
    })
    usdRateId = rate.id
    await prisma.exchangeRate.create({
      data: { date: new Date("2026-12-31"), from: "USD", to: "EUR", rateMicro: BigInt(900000), source: "test" },
    })
  }, 300_000)

  afterAll(async () => {
    await cleanupOrg(ORG)
    await cleanupOrg(ORG_FIX)
    await prisma.$executeRawUnsafe(`DELETE FROM exchange_rates WHERE source = 'test'`).catch(() => undefined)
    for (const id of [USER, USER_FIX]) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, id).catch(() => undefined)
    }
    await prisma.$disconnect()
  })

  /** Un asiento cuadrado por el camino de la aplicación (`buildEntry` + `postEntry`). */
  async function post(input: {
    date: string
    lines: {
      accountCode: string
      debitCents?: number
      creditCents?: number
      originalCurrency?: string
      originalAmountCents?: number
      exchangeRateId?: string
    }[]
    description?: string
  }): Promise<{ entryId: string; lineIds: string[] }> {
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const context = await getLedgerContext(tx, input.date)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: input.date,
          description: input.description ?? "asiento de la ronda 1",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: input.lines.map((l, index) => ({
            lineNo: index + 1,
            accountCode: l.accountCode,
            debitCents: l.debitCents ?? 0,
            creditCents: l.creditCents ?? 0,
            ...(l.originalCurrency ? { originalCurrency: l.originalCurrency } : {}),
            ...(l.originalAmountCents !== undefined ? { originalAmountCents: l.originalAmountCents } : {}),
            ...(l.exchangeRateId ? { exchangeRateId: l.exchangeRateId } : {}),
          })),
        },
        context
      )
    })
    if (!draft.ok) throw new Error(`el asiento no se pudo construir: ${JSON.stringify(draft.errors)}`)
    const posted = await postEntry(ORG, draft.value, { userId: USER }, { refDate: input.date })
    if (!posted.ok) throw new Error(`el asiento no se pudo contabilizar: ${JSON.stringify(posted.errors)}`)
    const lines = await tenantDb(ORG).journalLine.findMany({
      where: { entryId: posted.value.id },
      orderBy: { lineNo: "asc" },
    })
    return { entryId: posted.value.id, lineIds: lines.map((l) => l.id) }
  }

  /** Importa un extracto por el camino real (`importStatement`, no transaccional). */
  const importN43 = async (bankAccountId: string, fileName: string, content: string) =>
    await importStatement(
      ORG,
      { bankAccountId, fileName, bytes: new TextEncoder().encode(content), format: "N43" },
      { userId: USER }
    )

  // ───────────────────────────────────────────────────────────────────────────
  // H-2 · las cuatro cifras del `headline` a fecha de cierre
  // ───────────────────────────────────────────────────────────────────────────

  it("H-2 · `headline.activo` y `pn_mas_pasivo` a 31-12 son 13 673 820, no 0: el asiento de CIERRE no entra", async () => {
    await loadFixtureIntoOrg({ fixture: "ejercicio-completo", organizationId: ORG_FIX, userId: USER_FIX })
    const figures = await tenantTransaction(ORG_FIX, USER_FIX, async (tx) =>
      headlineFigures(tx, {
        from: "2026-01-01",
        to: "2026-12-31",
        ledgerHash: "0".repeat(64),
        runId: "00000000-0000-4000-8000-000000000001",
        gitSha: "test",
        baseCurrency: "EUR",
      })
    )
    // La foto es la MISMA que sella el balance de E6 (`PRE_REGULARIZACION`):
    // activo 13 673 820 = PN 8 307 322 + pasivo 5 366 498.
    expect(figures.ACTIVO.cents).toBe(13_673_820)
    expect(figures.PN_MAS_PASIVO.cents).toBe(13_673_820)
    // Y las otras dos no se han movido con la corrección.
    expect(figures.RESULTADO.cents).toBe(1_497_322)
    expect(figures.TESORERIA.cents).toBe(2_943_920)
    // I2 deja de cumplirse por vacuidad: 0 = 0 no dice nada, 13 673 820 sí.
    expect(figures.ACTIVO.cents).not.toBe(0)
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-6 · I-E7-14 en el alcance con el que se sella un ejercicio
  // ───────────────────────────────────────────────────────────────────────────

  it("H-6 · I-E7-14 se EVALÚA en alcance FISCAL_YEAR: carga la apertura del ejercicio siguiente", async () => {
    const fiscalYear = await tenantTransaction(ORG_FIX, USER_FIX, async (tx) =>
      tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })
    )
    const block = await tenantTransaction(ORG_FIX, USER_FIX, async (tx) =>
      auditBlock(tx, {
        refDate: "2026-12-31",
        from: "2026-01-01",
        to: "2026-12-31",
        fiscalYearId: fiscalYear.id,
        baseCurrency: "EUR",
        isFiscalYearEnd: true,
      })
    )
    const check = block.checks.find((c) => c.id === "I-E7-14")
    expect(check).toBeDefined()
    // Antes de la corrección: `INFO · ningún ejercicio con asiento de apertura`,
    // justo en el alcance en el que la continuidad del art. 25 CCom importa.
    expect(check?.status).toBe("PASS")
    expect(check?.evidencia).toContain("apertura(s) cuadran cuenta a cuenta")
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-7 · el periodo del extracto
  // ───────────────────────────────────────────────────────────────────────────

  it("H-7 · el parser conserva el periodo DECLARADO en el registro 11", () => {
    const text = n43({
      account: "0000000001",
      from: "2026-07-01",
      to: "2026-07-31",
      openingCents: 0,
      movements: [
        { date: "2026-07-06", amountCents: 10000, concept: "COBRO" },
        { date: "2026-07-22", amountCents: -4000, concept: "PAGO" },
      ],
    })
    const parsed = parseN43(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.statement?.periodDeclared).toBe(true)
    expect(parsed.statement?.periodStart).toBe("2026-07-01")
    expect(parsed.statement?.periodEnd).toBe("2026-07-31")
  })

  it("H-7 · un extracto mensual sin movimientos en los extremos se guarda con SU mes, y la cadena no denuncia un hueco falso", async () => {
    const { account } = await createBankAccount(
      ORG,
      {
        code: "H7-BANCO",
        name: "Banco de H-7",
        accountCode: eurCode,
        currency: "EUR",
        reconciledFromDate: "2026-07-01",
        reconciledOpeningBalanceCents: 0,
        matchToleranceDays: 3,
        transitWarnDays: 90,
      },
      { userId: USER }
    )

    // Julio y agosto CONTIGUOS por cabecera, pero con el primer y el último
    // movimiento metidos hacia dentro: es el caso ordinario de una cartera real.
    for (const [from, to, day1, day2] of [
      ["2026-07-01", "2026-07-31", "2026-07-06", "2026-07-22"],
      ["2026-08-01", "2026-08-31", "2026-08-04", "2026-08-19"],
    ] as const) {
      const text = n43({
        account: "0000000001",
        from,
        to,
        openingCents: 0,
        movements: [
          { date: day1, amountCents: 10000, concept: "COBRO" },
          { date: day2, amountCents: -10000, concept: "PAGO" },
        ],
      })
      const result = await importN43(account.id, `extracto-${from}.n43`, text)
      expect(result.periodStart).toBe(from)
      expect(result.periodEnd).toBe(to)
    }

    const stored = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankStatement.findMany({ where: { bankAccountId: account.id }, orderBy: { periodStart: "asc" } })
    )
    expect(stored.map((s) => s.periodStart.toISOString().slice(0, 10))).toEqual(["2026-07-01", "2026-08-01"])
    expect(stored.map((s) => s.periodEnd.toISOString().slice(0, 10))).toEqual(["2026-07-31", "2026-08-31"])

    // Y la cadena de I-E7-6b cubre [anclaje, 31-08] sin el hueco 07-01…07-06 que
    // la ronda 1 inventaba.
    const [summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-08-31", baseCurrency: "EUR", bankAccountId: account.id })
    )
    expect(summary.chain.gaps).toEqual([])
    expect(summary.chain.covered).toBe(true)
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-1 y H-3 · la cuenta en divisa
  // ───────────────────────────────────────────────────────────────────────────

  it("H-1/H-3 · una cuenta en USD cuadra EN USD, se puede conciliar a tasa 0,92 y la diferencia de cambio sale medida", async () => {
    const { account } = await createBankAccount(
      ORG,
      {
        code: "H1-USD",
        name: "Cuenta en dólares",
        accountCode: usdCode,
        currency: "USD",
        reconciledFromDate: "2026-03-01",
        reconciledOpeningBalanceCents: 0,
        matchToleranceDays: 3,
        transitWarnDays: 90,
      },
      { userId: USER }
    )

    // Un cobro de 1 000,00 USD contabilizado a 0,92 ⇒ 920,00 € de contravalor.
    const asiento = await post({
      date: "2026-03-10",
      description: "cobro en dólares",
      lines: [
        {
          accountCode: usdCode,
          debitCents: 92000,
          originalCurrency: "USD",
          originalAmountCents: 100000,
          exchangeRateId: usdRateId,
        },
        {
          accountCode: counterCode,
          creditCents: 92000,
          originalCurrency: "USD",
          originalAmountCents: 100000,
          exchangeRateId: usdRateId,
        },
      ],
    })

    // El extracto viene en dólares (clave 840) y por 1 000,00 USD.
    const text = n43({
      account: "0000000002",
      from: "2026-03-01",
      to: "2026-03-31",
      openingCents: 0,
      currency: "840",
      movements: [{ date: "2026-03-10", amountCents: 100000, concept: "COBRO USD" }],
    })
    await importN43(account.id, "usd.n43", text)

    // **H-1 en `createMatchGroup`.** El extracto dice 100 000 (USD) y el apunte
    // 92 000 (EUR): la ronda 1 rechazaba esto con `MATCH_NOT_BALANCED`, de modo
    // que una cuenta en divisa sólo se podía conciliar a paridad 1:1.
    const stLine = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId: account.id } })
    )
    const group = await tenantTransaction(ORG, USER, async (tx) =>
      createMatchGroup(
        tx,
        { bankAccountId: account.id, statementLineIds: [stLine.id], journalLineIds: [asiento.lineIds[0]] },
        { userId: USER }
      )
    )
    expect(group.kind).toBe("SIMPLE")
    // La suma sellada del grupo está en la moneda de la cuenta.
    expect(group.sumCents).toBe(100000)

    // **H-1 en el cuadre.** `E`, `B`, `Ue` y `Ub` en USD, no dos monedas mezcladas.
    const input = await tenantTransaction(ORG, USER, async (tx) =>
      readBankInvariantInput(tx, { cutoff: "2026-12-31", baseCurrency: "EUR" })
    )
    expect(input).not.toBeNull()
    // **H-3**: `fx` lo rellena el borde, con la tasa de cierre publicada.
    const fx = (input?.fx ?? []).find((f) => f.bankAccountId === account.id)
    expect(fx, "readBankInvariantInput debe aportar el cierre en divisa de la cuenta USD").toBeDefined()
    expect(fx?.rateMicro).toBe(BigInt(900000))
    expect(fx?.baseBalanceCents).toBe(92000)
    expect(fx?.recognizedDifferenceCents).toBe(0)

    const [summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-12-31", baseCurrency: "EUR", bankAccountId: account.id })
    )
    expect(summary.moneda).toBe("USD")
    expect(summary.enDivisa).toBe(true)
    expect(summary.divisaCompleta).toBe(true)
    expect(summary.saldoContable).toBe(100000)
    expect(summary.saldoExtracto).toBe(100000)
    expect(summary.diferencia).toBe(0)
    // 1 000,00 USD × 0,90 = 900,00 € frente a 920,00 € contabilizados.
    expect(summary.fxDifferenceCents).toBe(-2000)

    // **H-3 en el panel**: la pantalla enseña la MISMA cifra, sin recalcularla.
    const accountRow = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankAccount.findFirstOrThrow({ where: { id: account.id } })
    )
    const view = toSummaryView(summary, { ...toAccountView(account), ...account }, { invariantsPass: true })
    expect(view.diferenciaDeCambioCents).toBe(-2000)
    expect(accountRow.currency).toBe("USD")

    // **H-3 en el barrido**: I-E7-12 pasa de INFO perpetuo a WARN con importe, y
    // el motivo de sello `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` deja de ser
    // inalcanzable.
    const block = await tenantTransaction(ORG, USER, async (tx) =>
      auditBlock(tx, { refDate: "2026-12-31", from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR" })
    )
    const ie712 = block.checks.find((c) => c.id === "I-E7-12")
    expect(ie712?.status).toBe("WARN")
    expect(ie712?.evidencia).toContain("diferencia de cambio")
    expect(block.reasons).toContain("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-5 · el tipado del pendiente y `resolvedLaterIds`
  // ───────────────────────────────────────────────────────────────────────────

  it("H-5 · `pendingKind` se escribe al tipar, llega al cuadre y desaparece al ignorar", async () => {
    const { account } = await createBankAccount(
      ORG,
      {
        code: "H5-BANCO",
        name: "Banco de H-5",
        accountCode: (
          await tenantDb(ORG).ledgerAccount.findFirstOrThrow({
            where: { code: { startsWith: "574" }, isPostable: true },
            orderBy: { code: "asc" },
          })
        ).code,
        currency: "EUR",
        reconciledFromDate: "2026-01-01",
        reconciledOpeningBalanceCents: 0,
        matchToleranceDays: 3,
        transitWarnDays: 90,
      },
      { userId: USER }
    )
    const text = n43({
      account: "0000000003",
      from: "2026-11-01",
      to: "2026-11-30",
      openingCents: 0,
      movements: [{ date: "2026-11-10", amountCents: -5000, concept: "CARGO SIN ASIENTO" }],
    })
    await importN43(account.id, "h5.n43", text)
    const line = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId: account.id } })
    )

    // Sin tipar, el pendiente no está explicado y el motivo lo dice.
    let [summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-11-30", baseCurrency: "EUR", bankAccountId: account.id })
    )
    expect(summary.pendientesBanco).toHaveLength(1)
    expect(summary.pendientesBanco[0].kind).toBeNull()

    // Se tipa por el camino de producción (acción de servidor).
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: USER } })
    const { typePendingAction } = await actions()
    const typed = (await typePendingAction({
      bankAccountId: account.id,
      side: "BANCO",
      id: line.id,
      kind: "MOVIMIENTO_BANCO_SIN_ASIENTO",
    })) as ActionResult
    expect(typed.error ?? null).toBeNull()

    ;[summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-11-30", baseCurrency: "EUR", bankAccountId: account.id })
    )
    expect(summary.pendientesBanco[0].kind).toBe("MOVIMIENTO_BANCO_SIN_ASIENTO")

    // Un pendiente tipado y por debajo del plazo declarado queda **explicado**,
    // con el texto del criterio 3 de §3.6.
    const view = toSummaryView(summary, { ...toAccountView(account), ...account }, { invariantsPass: true })
    expect(view.pendientesBanco[0].explicado).toBe(true)
    expect(view.pendientesBanco[0].motivo).toContain("partida en tránsito tipada MOVIMIENTO_BANCO_SIN_ASIENTO")

    // Y deja de estar tipado cuando deja de estar pendiente: al ignorarlo.
    await tenantTransaction(ORG, USER, async (tx) =>
      ignoreLine(tx, { id: line.id, reason: "NO_ES_NUESTRA_CUENTA" }, { userId: USER })
    )
    const left = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankPendingKind.count({ where: { statementLineId: line.id } })
    )
    expect(left, "un tipado huérfano explicaría algo que ya no existe").toBe(0)
  }, 300_000)

  it("H-5 · `resolvedLaterIds` se puebla: el cheque de diciembre que el banco carga en enero SIGUE pendiente a 31-12 y está EXPLICADO", async () => {
    const bankCode = (
      await tenantDb(ORG).ledgerAccount.findFirstOrThrow({
        where: { code: { startsWith: "575" }, isPostable: true },
        orderBy: { code: "asc" },
      })
    ).code
    const { account } = await createBankAccount(
      ORG,
      {
        code: "H5B-BANCO",
        name: "Banco del cheque",
        accountCode: bankCode,
        currency: "EUR",
        reconciledFromDate: "2026-12-01",
        reconciledOpeningBalanceCents: 0,
        matchToleranceDays: 5,
        transitWarnDays: 90,
      },
      { userId: USER }
    )
    // El cheque: contabilizado el 20-12 (sale de la 57x), cargado por el banco el
    // 15-01 del ejercicio siguiente.
    const cheque = await post({
      date: "2026-12-20",
      description: "cheque emitido a un proveedor",
      lines: [
        { accountCode: bankCode, creditCents: 30000 },
        { accountCode: counterCode, debitCents: 30000 },
      ],
    })
    // Diciembre trae un movimiento cualquiera —un extracto sin ninguna línea no
    // se importa— y enero, el cargo del cheque.
    for (const [from, to, day, amount] of [
      ["2026-12-01", "2026-12-31", "2026-12-05", 10000],
      ["2027-01-01", "2027-01-31", "2027-01-15", -30000],
    ] as const) {
      const text = n43({
        account: "0000000004",
        from,
        to,
        openingCents: 0,
        movements: [{ date: day, amountCents: amount, concept: "MOVIMIENTO" }],
      })
      await importN43(account.id, `cheque-${from}.n43`, text)
    }
    const eneroLine = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId: account.id, operationDate: new Date("2027-01-15") } })
    )
    await tenantTransaction(ORG, USER, async (tx) =>
      createMatchGroup(
        tx,
        { bankAccountId: account.id, statementLineIds: [eneroLine.id], journalLineIds: [cheque.lineIds[0]] },
        { userId: USER }
      )
    )

    const [summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-12-31", baseCurrency: "EUR", bankAccountId: account.id })
    )
    /**
     * A 31-12 el apunte SIGUE pendiente: `B` lo cuenta y, si `Ub` no lo contara,
     * la identidad `E − B = Ue − Ub` fallaría por sus 300,00 € exactos. Un grupo
     * sólo cancela si TODOS sus miembros caen dentro del corte.
     */
    expect(summary.pendientesLibros.map((p) => p.id)).toEqual([cheque.lineIds[0]])
    expect(summary.ub).toBe(-30000)
    expect(summary.diferencia).toBe(0)
    // Y está EXPLICADO por el criterio 2 de §3.6, que la ronda 1 dejó sin conectar.
    expect(summary.resolvedLaterIds).toContain(cheque.lineIds[0])
    const view = toSummaryView(summary, { ...toAccountView(account), ...account }, { invariantsPass: true })
    expect(view.pendientesLibros[0].explicado).toBe(true)
    expect(view.pendientesLibros[0].motivo).toContain("lo recoge una línea de extracto posterior ya conciliada")
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // H-4 · el sello
  // ───────────────────────────────────────────────────────────────────────────

  it("H-4 · con conciliación pendiente y partidas antiguas, el periodo se sella REQUIERE REVISIÓN", async () => {
    const run = await runLedgerInvariants(ORG, {
      from: "2026-01-01",
      to: "2026-12-31",
      refDate: "2026-12-31",
      noCache: true,
      // `audit: true` es lo que hace correr el bloque I-E7-1…17 sin persistir.
      audit: true,
      actor: { userId: USER },
    })
    expect(run.auditReasons ?? []).toContain("CONCILIACION_PENDIENTE")
    // Un AVISO que no mueve el sello es decorativo: la ronda 1 firmaba
    // «VALIDADO AUTOMÁTICAMENTE» con ocho pendientes de hasta 183 días.
    expect(run.sello.sello).toBe("REQUIERE REVISIÓN")
    expect(run.sello.razones.map((r) => r.code)).toContain("CONCILIACION_PENDIENTE")
  }, 300_000)
})
