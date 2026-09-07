/**
 * E7 · **ronda 2 de corrección** — el bloqueante **N-1** de la re-auditoría
 * (`docs/design/E7-auditoria-informe.md` §«Re-auditoría»), medido por el camino
 * de producción y de punta a punta.
 *
 * **Qué era.** `fxDifferenceOf` restaba, además del contravalor contabilizado,
 * lo ya reconocido en `768`/`668`. Pero el asiento que reconoce una diferencia
 * de cambio **mueve la 57x** (`5740001 (D) / 768 (H)`, NRV 11ª.2.2), y
 * `readFxCloses` calcula `baseBalanceCents` como el saldo contable COMPLETO de
 * la cuenta: la reconocida entraba dos veces. Sobre una cuenta correctamente
 * regularizada el invariante daba `WARN` con la diferencia **cambiada de signo**
 * y una evidencia que se contradecía a sí misma («332,50 € valorados frente a
 * 332,50 € contabilizados … diferencia −10,50 €»). Y como H-4 hizo que
 * `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` **sí** mueva el sello, la cuenta quedaba
 * en `REQUIERE REVISIÓN` **para siempre por haber hecho lo correcto**.
 *
 * **Por qué este test y no uno unitario.** El de la ronda 1 pasaba con un
 * fixture que `readFxCloses` no puede producir jamás (saldo base sin mover y a
 * la vez diferencia reconocida). Aquí las tres cifras de `FxCloseRef` salen del
 * borde real, y el asiento de reconocimiento se contabiliza por `postEntry`.
 *
 * Se comprueban además las dos observaciones menores:
 *
 * · **O-1**: con la diferencia sin reconocer, la cuenta **no** luce
 *   `✓ validado contra fuente` —está validada en USD, pero el balance enseña su
 *   contravalor en euros y ése no lo está—; tras el asiento, sí.
 * · **O-2**: conciliar **no** destipa un pendiente a caballo del corte.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e7b20000-0000-4000-8000-00000000001a"
const USER = "e7b20000-0000-4000-8000-0000000a0001"

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
const { auditBlock } = await import("@/models/audit")
const { createBankAccount, createMatchGroup, importStatement, pendingItems, readBankInvariantInput, typePending } =
  await import("@/models/bank")
const { toAccountView, toSummaryView } = await import("@/app/(app)/audit/bank/shared")

/** Norma 43 por POSICIONES, con divisa parametrizable (ancho fijo: concatenar engaña). */
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

async function cleanup(): Promise<void> {
  await prisma
    .$executeRawUnsafe(`UPDATE journal_entries SET transaction_id = NULL WHERE organization_id = $1::uuid`, ORG)
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
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
  }
  await prisma
    .$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, ORG),
      prisma.$executeRawUnsafe(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, ORG),
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
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
  }
  await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG).catch(() => undefined)
  await prisma.$executeRawUnsafe(`DELETE FROM exchange_rates WHERE source = 'test-r2'`).catch(() => undefined)
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · ronda 2 — N-1: reconocer la diferencia de cambio no la duplica", () => {
  let usdCode = ""
  let counterCode = ""
  let fxAccountCode = ""
  let rateId = ""
  let bankAccountId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e7-ronda2@test.local", name: "Ronda 2" } })
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: USER } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e7-ronda2", name: "E7 ronda 2", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
    await importNpgc(ORG, "PYMES", { actor: { userId: USER }, now: new Date("2026-01-01"), useSubaccounts: true })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, { userId: USER })
    if (!fy.ok) throw new Error("no se pudo abrir el ejercicio 2026")
    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
      await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${ORG}::uuid`
    })

    const db = tenantDb(ORG)
    usdCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "574" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code
    counterCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "430" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code
    // `768` — Diferencias positivas de cambio. Es la cuenta con la que la
    // NRV 11ª.2.2 reconoce la diferencia, y su asiento **mueve la 57x**.
    fxAccountCode = (
      await db.ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "768" }, isPostable: true }, orderBy: { code: "asc" } })
    ).code

    // Tasa de contabilización 0,92 y tasa de CIERRE 0,95: la diferencia es real.
    const rate = await prisma.exchangeRate.create({
      data: { date: new Date("2026-03-01"), from: "USD", to: "EUR", rateMicro: BigInt(920000), source: "test-r2" },
    })
    rateId = rate.id
    await prisma.exchangeRate.create({
      data: { date: new Date("2026-12-31"), from: "USD", to: "EUR", rateMicro: BigInt(950000), source: "test-r2" },
    })
  }, 300_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function post(input: {
    date: string
    description: string
    lines: {
      accountCode: string
      debitCents?: number
      creditCents?: number
      originalCurrency?: string
      originalAmountCents?: number
      exchangeRateId?: string
    }[]
  }): Promise<{ entryId: string; lineIds: string[] }> {
    const draft = await tenantTransaction(ORG, USER, async (tx) => {
      const context = await getLedgerContext(tx, input.date)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: input.date,
          description: input.description,
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
    if (!draft.ok) throw new Error(`no se pudo construir: ${JSON.stringify(draft.errors)}`)
    const posted = await postEntry(ORG, draft.value, { userId: USER }, { refDate: input.date })
    if (!posted.ok) throw new Error(`no se pudo contabilizar: ${JSON.stringify(posted.errors)}`)
    const lines = await tenantDb(ORG).journalLine.findMany({ where: { entryId: posted.value.id }, orderBy: { lineNo: "asc" } })
    return { entryId: posted.value.id, lineIds: lines.map((l) => l.id) }
  }

  const summaryAt = async (cutoff: string) =>
    (await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff, baseCurrency: "EUR", bankAccountId })
    ))[0]

  const accountRow = async () =>
    await tenantTransaction(ORG, USER, async (tx) => tx.bankAccount.findFirstOrThrow({ where: { id: bankAccountId } }))

  it("escenario: cuenta USD con 350,00 USD contabilizados a 0,92 (322,00 €) y extracto en dólares", async () => {
    const { account } = await createBankAccount(
      ORG,
      {
        code: "R2-USD",
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
    bankAccountId = account.id

    const cobro = await post({
      date: "2026-03-10",
      description: "cobro de 350,00 USD a 0,92",
      lines: [
        { accountCode: usdCode, debitCents: 32200, originalCurrency: "USD", originalAmountCents: 35000, exchangeRateId: rateId },
        { accountCode: counterCode, creditCents: 32200, originalCurrency: "USD", originalAmountCents: 35000, exchangeRateId: rateId },
      ],
    })

    const text = n43({
      account: "0000000001",
      from: "2026-03-01",
      to: "2026-12-31",
      openingCents: 0,
      currency: "840",
      movements: [{ date: "2026-03-10", amountCents: 35000, concept: "COBRO USD" }],
    })
    await importStatement(
      ORG,
      { bankAccountId, fileName: "usd-r2.n43", bytes: new TextEncoder().encode(text), format: "N43" },
      { userId: USER }
    )
    const stLine = await tenantTransaction(ORG, USER, async (tx) =>
      tx.bankStatementLine.findFirstOrThrow({ where: { bankAccountId } })
    )
    await tenantTransaction(ORG, USER, async (tx) =>
      createMatchGroup(tx, { bankAccountId, statementLineIds: [stLine.id], journalLineIds: [cobro.lineIds[0]] }, { userId: USER })
    )

    // El cuadre, en USD y sin pendientes: la cuenta está conciliada contra fuente.
    const summary = await summaryAt("2026-12-31")
    expect(summary.moneda).toBe("USD")
    expect(summary.saldoContable).toBe(35000)
    expect(summary.saldoExtracto).toBe(35000)
    expect(summary.diferencia).toBe(0)
    expect(summary.pendientesBanco).toEqual([])
    expect(summary.pendientesLibros).toEqual([])
  }, 300_000)

  it("N-1 · ANTES de reconocer: `fx` sale del borde, I-E7-12 avisa de 10,50 € y O-1 retira el badge", async () => {
    const input = await tenantTransaction(ORG, USER, async (tx) =>
      readBankInvariantInput(tx, { cutoff: "2026-12-31", baseCurrency: "EUR" })
    )
    const fx = (input?.fx ?? []).find((f) => f.bankAccountId === bankAccountId)
    expect(fx?.rateMicro).toBe(BigInt(950000))
    expect(fx?.baseBalanceCents).toBe(32200) // los 322,00 € contabilizados
    expect(fx?.recognizedDifferenceCents).toBe(0)

    // 350,00 USD × 0,95 = 332,50 € valorados frente a 322,00 € contabilizados.
    const summary = await summaryAt("2026-12-31")
    expect(summary.fxDifferenceCents).toBe(1050)

    const block = await tenantTransaction(ORG, USER, async (tx) =>
      auditBlock(tx, { refDate: "2026-12-31", from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR", isFiscalYearEnd: true })
    )
    const check = block.checks.find((c) => c.id === "I-E7-12")
    expect(check?.status).toBe("WARN")
    expect(check?.evidencia).toContain("10,50 €")
    expect(block.reasons).toContain("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")

    // **O-1**: conciliada en USD, pero su contravalor en euros no está validado.
    const view = toSummaryView(summary, { ...toAccountView(await accountRow()), ...(await accountRow()) }, { invariantsPass: true })
    expect(view.badge).toBe("comprobado")
    expect(view.diferenciaDeCambioCents).toBe(1050)
  }, 300_000)

  it("N-1 · TRAS reconocer 10,50 € en 768 (asiento que mueve la 57x): PASS, badge `validado` y sello VALIDADO", async () => {
    // El asiento de la NRV 11ª.2.2: la 57x sube hasta su valor al tipo de cierre
    // y el ingreso va a `768`. Es lo que `readFxCloses` ve como saldo base.
    await post({
      date: "2026-12-31",
      description: "diferencia positiva de cambio al cierre (NRV 11ª.2.2)",
      lines: [
        { accountCode: usdCode, debitCents: 1050, originalCurrency: "USD", originalAmountCents: 0, exchangeRateId: rateId },
        { accountCode: fxAccountCode, creditCents: 1050 },
      ],
    })

    const input = await tenantTransaction(ORG, USER, async (tx) =>
      readBankInvariantInput(tx, { cutoff: "2026-12-31", baseCurrency: "EUR" })
    )
    const fx = (input?.fx ?? []).find((f) => f.bankAccountId === bankAccountId)
    // El saldo base **ya contiene** el reconocimiento: 322,00 + 10,50 = 332,50 €.
    expect(fx?.baseBalanceCents).toBe(33250)
    expect(fx?.recognizedDifferenceCents).toBe(1050)

    const summary = await summaryAt("2026-12-31")
    // 350,00 USD × 0,95 = 332,50 € valorados = 332,50 € contabilizados ⇒ 0.
    // La ronda 1 daba aquí −10,50 €, restando dos veces lo reconocido.
    expect(summary.fxDifferenceCents).toBe(0)
    // Y el cuadre en divisa no se ha movido: el asiento de 768 no lleva importe
    // en divisa, así que no toca `B` ni `Ub`.
    expect(summary.saldoContable).toBe(35000)
    expect(summary.diferencia).toBe(0)

    const block = await tenantTransaction(ORG, USER, async (tx) =>
      auditBlock(tx, { refDate: "2026-12-31", from: "2026-01-01", to: "2026-12-31", baseCurrency: "EUR", isFiscalYearEnd: true })
    )
    const check = block.checks.find((c) => c.id === "I-E7-12")
    expect(check?.status).toBe("PASS")
    expect(block.reasons).not.toContain("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")

    // **O-1**: con la diferencia reconocida, el badge vuelve solo.
    const account = await accountRow()
    const view = toSummaryView(summary, { ...toAccountView(account), ...account }, { invariantsPass: true })
    expect(view.badge).toBe("validado")
    expect(view.diferenciaDeCambioCents).toBe(0)

    // Y el sello del periodo: una cuenta en divisa correctamente regularizada NO
    // puede quedarse en «REQUIERE REVISIÓN» para siempre por haber hecho lo
    // correcto, que es lo que H-4 + N-1 producían juntos.
    const run = await runLedgerInvariants(ORG, {
      from: "2026-01-01",
      to: "2026-12-31",
      refDate: "2026-12-31",
      noCache: true,
      audit: true,
      actor: { userId: USER },
    })
    expect(run.auditReasons ?? []).not.toContain("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")
    expect(run.sello.razones.map((r) => r.code ?? "")).not.toContain("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")
    /**
     * Y **I-E7-12 no aparece en ningún motivo del sello**. Lo que pueda seguir
     * moviéndolo en este escenario mínimo son avisos de otras familias sobre el
     * propio fixture (I-E7-15, saldos contrarios a su naturaleza; I-E4-1), no la
     * diferencia de cambio. Ésa era la consecuencia grave de N-1 junto con H-4:
     * una cuenta en divisa **correctamente regularizada** se quedaba en
     * «REQUIERE REVISIÓN» para siempre por haber hecho lo correcto.
     */
    for (const razon of run.sello.razones) {
      expect(razon.message).not.toContain("I-E7-12")
      expect(razon.code ?? "").not.toBe("DIFERENCIA_DE_CAMBIO_SIN_RECONOCER")
    }
    expect(run.validacion.checks.find((c) => c.id === "I-E7-12")?.status).toBe("PASS")
  }, 300_000)

  it("O-2 · conciliar NO destipa un pendiente a caballo del corte", async () => {
    const bankCode = (
      await tenantDb(ORG).ledgerAccount.findFirstOrThrow({
        where: { code: { startsWith: "575" }, isPostable: true },
        orderBy: { code: "asc" },
      })
    ).code
    const { account } = await createBankAccount(
      ORG,
      {
        code: "R2-CHEQUE",
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
    const cheque = await post({
      date: "2026-12-20",
      description: "cheque emitido a un proveedor",
      lines: [
        { accountCode: bankCode, creditCents: 30000 },
        { accountCode: counterCode, debitCents: 30000 },
      ],
    })
    for (const [from, to, day, amount] of [
      ["2026-12-01", "2026-12-31", "2026-12-05", 10000],
      ["2027-01-01", "2027-01-31", "2027-01-15", -30000],
    ] as const) {
      const text = n43({
        account: "0000000002",
        from,
        to,
        openingCents: 0,
        movements: [{ date: day, amountCents: amount, concept: "MOVIMIENTO" }],
      })
      await importStatement(
        ORG,
        { bankAccountId: account.id, fileName: `cheque-r2-${from}.n43`, bytes: new TextEncoder().encode(text), format: "N43" },
        { userId: USER }
      )
    }

    // Una persona lo tipa: es un cheque emitido y no cargado.
    await tenantTransaction(ORG, USER, async (tx) =>
      typePending(
        tx,
        { bankAccountId: account.id, side: "LIBROS", id: cheque.lineIds[0], kind: "CHEQUE_EMITIDO_NO_CARGADO" },
        { userId: USER }
      )
    )

    // Y en enero el banco lo carga: se concilia contra la línea del 15-01.
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

    // A 31-12 el apunte SIGUE pendiente, y **conserva su tipo**: la ronda 1 lo
    // enseñaba como «sin tipar» justo cuando alguien acababa de describirlo.
    const [summary] = await tenantTransaction(ORG, USER, async (tx) =>
      pendingItems(tx, { cutoff: "2026-12-31", baseCurrency: "EUR", bankAccountId: account.id })
    )
    expect(summary.pendientesLibros.map((p) => p.id)).toEqual([cheque.lineIds[0]])
    expect(summary.pendientesLibros[0].kind).toBe("CHEQUE_EMITIDO_NO_CARGADO")
    expect(summary.resolvedLaterIds).toContain(cheque.lineIds[0])
    expect(summary.diferencia).toBe(0)
  }, 300_000)
})
