/**
 * E7 · T9/T10/T11/T18/T23 — La conciliación bancaria y el barrido sellado,
 * contra Postgres de verdad, con la matriz de roles puesta y la RLS activa.
 *
 * Lo que se ejerce aquí y no se puede ejercer en un test puro:
 *
 *  · **La importación**: idempotente por `fileSha256`, con el apunte de 0,00 €
 *    que NACE `IGNORED/IMPORTE_CERO` (m2) y con el **solape** que importa sólo
 *    los nuevos y ajusta la apertura declarada para que I-E7-6a siga cuadrando.
 *  · **El hueco en la cadena** (I-E7-6b): dos extractos con un mes sin cubrir
 *    dejan I-E7-6b en FAIL y I-E7-1 en INFO, jamás en PASS.
 *  · **El grupo N-a-M**: catorce recibos contra un abono cuadran por Σ
 *    (I-E7-11) y un punteo desigual **se rechaza en el servidor** (I-E7-2).
 *  · **Conciliar no toca el diario**: el `ledgerHash` del periodo es idéntico
 *    antes y después de conciliar y de desconciliar (O-13, criterio 14).
 *  · **El ignorado acotado**: `YA_CONTABILIZADO_EN_OTRA_CUENTA` sin evidencia se
 *    rechaza; con el apunte concreto, se acepta y queda auditado.
 *  · **T23**: una comisión sin asiento no es ignorable —se propone `626 / 572`
 *    **sin cuota** (art. 20.Uno.18º)— y al confirmar nacen **asiento y
 *    conciliación en la misma transacción**.
 *  · **Roles y tenant**: un `VIEWER` lee y no muta; un `EDITOR` concilia pero no
 *    da de alta cuentas ni barre el almacén; una línea de otra organización
 *    sencillamente no existe.
 *  · **El run persistido es inmutable**: `UPDATE` como `app_runtime` → `42501`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { centsFromDb } from "@/lib/money"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e7110000-0000-4000-8000-00000000001a"
const ORG_B = "e7110000-0000-4000-8000-00000000002a"
const ADMIN_USER = "e7110000-0000-4000-8000-0000000a0001"
const EDITOR_USER = "e7110000-0000-4000-8000-0000000e0002"
const VIEWER_USER = "e7110000-0000-4000-8000-0000000f0003"
const OTHER_USER = "e7110000-0000-4000-8000-0000000b0004"

const REF = "2026-12-31"

let currentUser: { id: string; email: string; name: string }

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

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { DEFAULT_CURRENCIES } = await import("@/models/defaults-data")
const { buildEntry } = await import("@/lib/ledger/post")
const { computeLedgerHash, getLedgerContext, postEntry } = await import("@/models/ledger")
const { getAccountMapByKey, setAccountMapEntry } = await import("@/models/account-map")

type ActionResult = { success: boolean; error?: string | null; data?: unknown }

const actions = async () => await import("@/app/(app)/audit/actions")

/**
 * Un extracto **Norma 43** montado por POSICIONES, no por concatenación: el
 * cuaderno es de ancho fijo y un campo desplazado produce un fichero que
 * «parece» válido y se parsea mal, que es justo el error silencioso que R9
 * describe. Cada campo se escribe en su posición 1-based, como lo lee el parser.
 */
function n43(opts: {
  account: string
  from: string
  to: string
  openingCents: number
  movements: { date: string; amountCents: number; concept: string; reference1?: string }[]
}): string {
  /** El cuaderno escribe **AAMMDD**, no DDMMAA: invertirlo es el error del siglo. */
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
      // El saldo se declara con el MISMO indicador que un movimiento: 1 = debe
      // (saldo deudor para el banco, o sea negativo para el titular), 2 = haber.
      [33, 33, opts.openingCents < 0 ? "1" : "2"],
      [34, 47, amount14(opts.openingCents)],
      [48, 50, "978"],
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
        // 1 = cargo (disminuye el saldo del titular), 2 = abono.
        [28, 28, m.amountCents < 0 ? "1" : "2"],
        [29, 42, amount14(m.amountCents)],
        [43, 52, "0000000000"],
        [53, 64, m.reference1 ?? ""],
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
      [74, 76, "978"],
    ])
  )
  rows.push(record([[1, 2, "88"], [3, 20, "9".repeat(18)], [21, 26, String(rows.length + 1).padStart(6, "0")]]))
  return rows.join("\n")
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · conciliación bancaria y barrido sellado", () => {
  let bankAccountCode = ""
  let bankAccountId = ""
  let counterAccountCode = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_USER, email: "e7-admin@test.local", name: "Admin" },
        { id: EDITOR_USER, email: "e7-editor@test.local", name: "Editor" },
        { id: VIEWER_USER, email: "e7-viewer@test.local", name: "Viewer" },
        { id: OTHER_USER, email: "e7-otro@test.local", name: "Otro" },
      ],
    })
    for (const [id, slug] of [
      [ORG, "e7-t11-org"],
      [ORG_B, "e7-t11-org-b"],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: slug, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await importNpgc(id, "PYMES", { actor: { userId: ADMIN_USER }, now: new Date("2026-01-01"), useSubaccounts: true })
      const fy = await openFiscalYear(id, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, { userId: ADMIN_USER })
      if (!fy.ok) throw new Error(`no se pudo abrir el ejercicio de ${slug}`)
      await tenantTransaction(id, ADMIN_USER, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
        await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${id}::uuid`
        await tx.currency.createMany({ data: DEFAULT_CURRENCIES.map((c) => ({ ...c, organizationId: id })) })
        // El banco vive en el maestro con su NIF: un gasto sin identificación
        // del expedidor no se contabiliza a ciegas (RC-11).
        await tx.counterparty.create({
          data: { organizationId: id, code: "BBVA", name: "BBVA cuenta corriente", taxId: "A48265169", countryCode: "ES" },
        })
      })
    }
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: EDITOR_USER, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_B, userId: OTHER_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })

    // La subcuenta bancaria POSTABLE del plan sembrado y una contrapartida de
    // ingreso: el fixture no traduce cuentas a mano, las busca en el plan real.
    const db = tenantDb(ORG)
    const bank = await db.ledgerAccount.findFirstOrThrow({
      where: { code: { startsWith: "572" }, isPostable: true },
      orderBy: { code: "asc" },
    })
    bankAccountCode = bank.code
    const counter = await db.ledgerAccount.findFirstOrThrow({
      where: { code: { startsWith: "430" }, isPostable: true },
      orderBy: { code: "asc" },
    })
    counterAccountCode = counter.code

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER } })
    const { createBankAccountAction } = await actions()
    const created = (await createBankAccountAction({
      code: "BBVA-01",
      name: "BBVA cuenta corriente",
      accountCode: bankAccountCode,
      currency: "EUR",
      reconciledFromDate: "2026-01-01",
      reconciledOpeningBalanceCents: 0,
      matchToleranceDays: 3,
      transitWarnDays: 90,
    })) as ActionResult
    expect(created.error ?? null).toBeNull()
    expect(created).toMatchObject({ success: true })
    bankAccountId = (created.data as { id: string }).id
  }, 300_000)

  beforeEach(async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    for (const org of [ORG, ORG_B]) {
      for (const table of [
        "bank_reconciliations",
        "bank_match_groups",
        "bank_statement_lines",
        "bank_statements",
        "bank_accounts",
        "invariant_runs",
        "store_sweeps",
        "manual_review_flags",
      ]) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org).catch(() => undefined)
      }
      await prisma
        .$transaction([
          prisma.$executeRawUnsafe(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, org),
          prisma.$executeRawUnsafe(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, org),
        ])
        .catch(() => undefined)
      for (const table of [
        "transactions",
        "extraction_runs",
        "files",
        "audit_logs",
        "currencies",
        "period_locks",
        "fiscal_years",
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
    await prisma
      .$executeRaw`DELETE FROM users WHERE id IN (${ADMIN_USER}::uuid, ${EDITOR_USER}::uuid, ${VIEWER_USER}::uuid, ${OTHER_USER}::uuid)`
      .catch(() => undefined)
  }

  /** Un asiento de dos líneas contra la cuenta bancaria. Devuelve la línea 57x. */
  async function postBankEntry(opts: {
    amountCents: number
    entryDate: string
    description?: string
  }): Promise<{ entryId: string; journalLineId: string }> {
    const debit = opts.amountCents > 0 ? opts.amountCents : 0
    const credit = opts.amountCents < 0 ? -opts.amountCents : 0
    const draft = await tenantTransaction(ORG, EDITOR_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, REF)
      return buildEntry(
        {
          organizationId: ORG,
          entryDate: opts.entryDate,
          description: opts.description ?? "Movimiento bancario E7",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: bankAccountCode, debitCents: debit, creditCents: credit },
            { lineNo: 2, accountCode: counterAccountCode, debitCents: credit, creditCents: debit },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG, draft.value, { userId: EDITOR_USER }, { refDate: REF })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))
    const line = await tenantDb(ORG).journalLine.findFirstOrThrow({
      where: { entryId: posted.value.id, accountCode: bankAccountCode },
    })
    return { entryId: posted.value.id, journalLineId: line.id }
  }

  const importN43 = async (content: string, fileName: string): Promise<ActionResult> => {
    const form = new FormData()
    form.set("bankAccountId", bankAccountId)
    form.set("format", "N43")
    form.set("file", new File([content], fileName, { type: "text/plain" }))
    const { importStatementAction } = await actions()
    return (await importStatementAction(form)) as ActionResult
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Importación
  // ───────────────────────────────────────────────────────────────────────────

  it("importa un N43, es idempotente por fileSha256 y el apunte de 0,00 € nace IGNORED con IMPORTE_CERO (m2)", async () => {
    const content = n43({
      account: "1234567890",
      from: "2026-01-02",
      to: "2026-01-31",
      openingCents: 0,
      movements: [
        { date: "2026-01-10", amountCents: -350, concept: "COMISION MANTENIMIENTO" },
        { date: "2026-01-15", amountCents: 120_000, concept: "TRANSFERENCIA CLIENTE", reference1: "REM0001" },
        { date: "2026-01-20", amountCents: 0, concept: "ANOTACION INFORMATIVA" },
      ],
    })
    const first = await importN43(content, "enero.n43")
    expect(first.error ?? null).toBeNull()
    expect(first).toMatchObject({ success: true })
    expect(first.data).toMatchObject({ alreadyImported: false, imported: 3, zeroAmount: 1 })

    const second = await importN43(content, "enero.n43")
    expect(second.data).toMatchObject({ alreadyImported: true, imported: 0 })

    const db = tenantDb(ORG)
    const zero = await db.bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(0) } })
    expect(zero.status).toBe("IGNORED")
    expect(zero.ignoreReason).toBe("IMPORTE_CERO")
    expect(zero.ignoreEvidenceId).toBeNull()

    const lineNos = (await db.bankStatementLine.findMany({ orderBy: { lineNo: "asc" } })).map((l) => l.lineNo)
    expect(lineNos).toEqual([1, 2, 3])
  }, 120_000)

  it("un extracto que SOLAPA importa sólo lo nuevo, lo declara y sigue cuadrando consigo mismo (I-E7-6a)", async () => {
    const content = n43({
      account: "1234567890",
      from: "2026-01-20",
      to: "2026-02-15",
      openingCents: 119_650,
      movements: [
        // Repetido: mismo día, importe y concepto que el de enero.
        { date: "2026-01-20", amountCents: 0, concept: "ANOTACION INFORMATIVA" },
        { date: "2026-02-05", amountCents: -25_000, concept: "PAGO PROVEEDOR" },
      ],
    })
    const result = await importN43(content, "febrero.n43")
    expect(result.error ?? null).toBeNull()
    expect(result).toMatchObject({ success: true })
    expect(result.data).toMatchObject({ imported: 1 })
    expect((result.data as { skipped: unknown[] }).skipped).toHaveLength(1)

    const statement = await tenantDb(ORG).bankStatement.findFirstOrThrow({ where: { fileName: "febrero.n43" } })
    const lines = await tenantDb(ORG).bankStatementLine.findMany({ where: { statementId: statement.id } })
    const suma = lines.reduce((a, l) => a + centsFromDb(l.amountCents), 0)
    // apertura ajustada + Σ importadas = cierre declarado, que es lo que compara I-E7-6a.
    expect(centsFromDb(statement.openingBalanceCents) + suma).toBe(centsFromDb(statement.closingBalanceCents))
    expect(statement.declaredLineCount).toBe(lines.length)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Conciliación
  // ───────────────────────────────────────────────────────────────────────────

  it("concilia 1:1, deja el ledgerHash INTACTO y desconcilia con motivo (criterio 14)", async () => {
    const { createMatchGroupAction, unmatchGroupAction } = await actions()
    const { journalLineId } = await postBankEntry({ amountCents: 120_000, entryDate: "2026-01-15" })
    const line = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(120_000) } })

    const before = await tenantTransaction(ORG, EDITOR_USER, async (tx) => computeLedgerHash(tx, {}))
    const matched = (await createMatchGroupAction({
      bankAccountId,
      statementLineIds: [line.id],
      journalLineIds: [journalLineId],
    })) as ActionResult
    expect(matched).toMatchObject({ success: true })
    expect((matched.data as { kind: string }).kind).toBe("SIMPLE")

    const afterMatch = await tenantTransaction(ORG, EDITOR_USER, async (tx) => computeLedgerHash(tx, {}))
    expect(afterMatch).toBe(before)

    const groupId = (matched.data as { groupId: string }).groupId
    const corto = (await unmatchGroupAction({ groupId, reason: "corto" })) as ActionResult
    expect(corto.success).toBe(false)

    const unmatched = (await unmatchGroupAction({
      groupId,
      reason: "punteo equivocado en el cierre de enero",
    })) as ActionResult
    expect(unmatched).toMatchObject({ success: true })
    const afterUnmatch = await tenantTransaction(ORG, EDITOR_USER, async (tx) => computeLedgerHash(tx, {}))
    expect(afterUnmatch).toBe(before)

    const reloaded = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { id: line.id } })
    expect(reloaded.status).toBe("UNMATCHED")
  }, 120_000)

  it("**punteo desigual imposible**: 100,00 € contra 1 000,00 € se rechaza en el servidor (I-E7-2)", async () => {
    const { createMatchGroupAction } = await actions()
    const { journalLineId } = await postBankEntry({ amountCents: 100_000, entryDate: "2026-01-15" })
    const line = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(-25_000) } })
    const result = (await createMatchGroupAction({
      bankAccountId,
      statementLineIds: [line.id],
      journalLineIds: [journalLineId],
    })) as ActionResult
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no cuadra|tolerancia 0/)
  }, 120_000)

  it("**grupo N-a-1**: tres recibos contra un abono cuadran por Σ (I-E7-11) y quedan MATCHED", async () => {
    const { createMatchGroupAction } = await actions()
    const content = n43({
      account: "1234567890",
      from: "2026-03-01",
      to: "2026-03-31",
      openingCents: 94_650,
      movements: [{ date: "2026-03-10", amountCents: 84_200, concept: "ABONO REMESA", reference1: "REM0099" }],
    })
    expect(await importN43(content, "marzo.n43")).toMatchObject({ success: true })
    const abono = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(84_200) } })

    const recibos = []
    for (const cents of [30_000, 30_000, 24_200]) {
      recibos.push((await postBankEntry({ amountCents: cents, entryDate: "2026-03-09" })).journalLineId)
    }

    const result = (await createMatchGroupAction({
      bankAccountId,
      statementLineIds: [abono.id],
      journalLineIds: recibos,
    })) as ActionResult
    expect(result).toMatchObject({ success: true })
    expect((result.data as { kind: string }).kind).toBe("UNO_A_N")

    const reloaded = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { id: abono.id } })
    expect(reloaded.status).toBe("MATCHED")

    // Y el grupo cuadra en la BASE: cambiar un miembro por otro de otro importe
    // no cabe, porque el trigger diferido comprueba Σ = Σ al COMMIT.
    const sobrante = await postBankEntry({ amountCents: 11_100, entryDate: "2026-03-09" })
    const desigual = (await createMatchGroupAction({
      bankAccountId,
      statementLineIds: [abono.id],
      journalLineIds: [sobrante.journalLineId],
    })) as ActionResult
    expect(desigual.success).toBe(false)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Ignorado
  // ───────────────────────────────────────────────────────────────────────────

  it("`YA_CONTABILIZADO_EN_OTRA_CUENTA` exige el apunte concreto; con él, se acepta y queda auditado (I-E7-13)", async () => {
    const { ignoreLineAction } = await actions()
    const content = n43({
      account: "1234567890",
      from: "2026-04-01",
      to: "2026-04-30",
      openingCents: 178_850,
      movements: [{ date: "2026-04-05", amountCents: -4_500, concept: "CARGO DE OTRA CUENTA" }],
    })
    expect(await importN43(content, "abril.n43")).toMatchObject({ success: true })
    const line = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(-4_500) } })

    const sinEvidencia = (await ignoreLineAction({ id: line.id, reason: "YA_CONTABILIZADO_EN_OTRA_CUENTA" })) as ActionResult
    expect(sinEvidencia.success).toBe(false)

    const { journalLineId } = await postBankEntry({ amountCents: -4_500, entryDate: "2026-04-05" })
    const conEvidencia = (await ignoreLineAction({
      id: line.id,
      reason: "YA_CONTABILIZADO_EN_OTRA_CUENTA",
      evidenceId: journalLineId,
    })) as ActionResult
    expect(conEvidencia).toMatchObject({ success: true })

    const reloaded = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { id: line.id } })
    expect(reloaded.status).toBe("IGNORED")
    expect(reloaded.ignoreEvidenceId).toBe(journalLineId)
    const log = await tenantDb(ORG).auditLog.findFirst({ where: { action: "IGNORE_LINE", entityId: line.id } })
    expect(log).not.toBeNull()
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // T23 — propuesta de asiento
  // ───────────────────────────────────────────────────────────────────────────

  it("**comisión sin asiento**: se propone 626 / 572 SIN cuota y al confirmar nacen asiento y conciliación juntos", async () => {
    const { proposeEntryFromLineAction, confirmEntryFromLineAction } = await actions()
    // La clave del mapa: la cuenta sale del MAPA, nunca del texto del movimiento.
    const map = await tenantTransaction(ORG, ADMIN_USER, async (tx) => getAccountMapByKey(tx))
    if (!map.get("COMISIONES_BANCARIAS")) {
      const cuenta = await tenantDb(ORG).ledgerAccount.findFirstOrThrow({
        where: { code: { startsWith: "626" }, isPostable: true },
        orderBy: { code: "asc" },
      })
      const done = await setAccountMapEntry(ORG, "COMISIONES_BANCARIAS", cuenta.code, { userId: ADMIN_USER }, "alta de la clave para la propuesta desde el extracto")
      if (!done.ok) throw new Error(JSON.stringify(done.errors))
    }

    const comision = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({
      where: { amountCents: BigInt(-350), status: "UNMATCHED" },
    })

    const preview = (await proposeEntryFromLineAction({
      statementLineId: comision.id,
      accountKey: "COMISIONES_BANCARIAS",
    })) as ActionResult
    expect(preview.error ?? null).toBeNull()
    expect(preview).toMatchObject({ success: true })
    const draft = (preview.data as { draft: { draft: { lines: { accountCode: string; debitCents: number; creditCents: number }[] } } })
      .draft
    expect((preview.data as { error: unknown }).error ?? null).toBeNull()
    expect(draft).not.toBeNull()
    // Dos líneas y ninguna de IVA soportado: el servicio financiero está exento.
    expect(draft.draft.lines).toHaveLength(2)
    expect(draft.draft.lines.some((l) => l.accountCode.startsWith("472"))).toBe(false)
    expect(draft.draft.lines.find((l) => l.accountCode === bankAccountCode)?.creditCents).toBe(350)

    const confirmed = (await confirmEntryFromLineAction({
      statementLineId: comision.id,
      accountKey: "COMISIONES_BANCARIAS",
    })) as ActionResult
    expect(confirmed).toMatchObject({ success: true })
    const { entryId, groupId } = confirmed.data as { entryId: string; groupId: string }

    const db = tenantDb(ORG)
    const entry = await db.journalEntry.findFirstOrThrow({ where: { id: entryId } })
    expect(entry.sourceType).toBe("BANK_RECONCILIATION")
    expect(entry.sourceId).toBe(comision.id)
    const group = await db.bankMatchGroup.findFirstOrThrow({ where: { id: groupId }, include: { members: true } })
    expect(group.members).toHaveLength(1)
    const reloaded = await db.bankStatementLine.findFirstOrThrow({ where: { id: comision.id } })
    expect(reloaded.status).toBe("MATCHED")
  }, 120_000)

  it("una propuesta contra una cuenta con IVA soportado asociado se BLOQUEA (art. 20.Uno.18º)", async () => {
    const { proposeEntryFromLineAction } = await actions()
    const content = n43({
      account: "1234567890",
      from: "2026-05-01",
      to: "2026-05-31",
      openingCents: 174_350,
      movements: [{ date: "2026-05-04", amountCents: -1_000, concept: "GESTION DE COBRO DE EFECTOS" }],
    })
    expect(await importN43(content, "mayo.n43")).toMatchObject({ success: true })
    const line = await tenantDb(ORG).bankStatementLine.findFirstOrThrow({ where: { amountCents: BigInt(-1_000) } })

    // Se ata un tipo de IVA soportado a la cuenta de la clave: es lo que declara
    // que ese gasto llega con factura (gestión de cobro, letra h).
    const map = await tenantTransaction(ORG, ADMIN_USER, async (tx) => getAccountMapByKey(tx))
    const cuenta = map.get("OTROS_GASTOS_FINANCIEROS")
      ?? (await tenantDb(ORG).ledgerAccount.findFirstOrThrow({ where: { code: { startsWith: "669" }, isPostable: true } })).code
    if (!map.get("OTROS_GASTOS_FINANCIEROS")) {
      const done = await setAccountMapEntry(ORG, "OTROS_GASTOS_FINANCIEROS", cuenta, { userId: ADMIN_USER }, "alta de la clave para la prueba del bloqueo por IVA")
      if (!done.ok) throw new Error(JSON.stringify(done.errors))
    }
    const ivaSoportado = await tenantDb(ORG).ledgerAccount.findFirstOrThrow({
      where: { code: { startsWith: "472" }, isPostable: true },
    })
    await tenantDb(ORG).taxRate.create({
      data: {
        organizationId: ORG,
        code: "IVA_21_GESTION_COBRO",
        name: "IVA soportado gestión de cobro",
        kind: "IVA",
        rateBps: 2100,
        appliesTo: "PURCHASE",
        accountCode: ivaSoportado.code,
        counterAccountCode: cuenta,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
      },
    })

    const blocked = (await proposeEntryFromLineAction({
      statementLineId: line.id,
      accountKey: "OTROS_GASTOS_FINANCIEROS",
    })) as ActionResult
    expect(blocked.success).toBe(false)
    expect(blocked.error).toMatch(/20\.Uno\.18|camino documental/)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Barrido sellado y su inmutabilidad
  // ───────────────────────────────────────────────────────────────────────────

  it("**barrido sellado**: persiste un InvariantRun con los cinco sellos, headline y los I-E7-*; y es INMUTABLE (42501)", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
    const { runInvariantsAction } = await actions()
    const result = (await runInvariantsAction({ scopeKind: "ORGANIZATION", refDate: REF })) as ActionResult
    expect(result).toMatchObject({ success: true })
    const runId = (result.data as { runId: string }).runId
    expect(runId).toBeTruthy()

    const db = tenantDb(ORG)
    const row = await db.invariantRun.findFirstOrThrow({ where: { id: runId } })
    for (const hash of [row.ledgerHash, row.planHash, row.accountMapHash, row.configHash]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(row.checksHash).toMatch(/^[0-9a-f]{64}$/)
    const headline = row.headline as Record<string, { cents: number }>
    expect(Object.keys(headline).sort()).toEqual(["ACTIVO", "PN_MAS_PASIVO", "RESULTADO", "TESORERIA"])
    const ids = (row.checks as unknown as { id: string }[]).map((c) => c.id)
    for (const id of ["I-E7-1", "I-E7-2", "I-E7-5", "I-E7-6a", "I-E7-6b", "I-E7-11", "I-E7-13", "I-E7-17"]) {
      expect(ids).toContain(id)
    }

    /**
     * **Append-only en la barrera 2.** La suite de integración corre como
     * PROPIETARIO, y el propietario no ve las políticas de privilegio: hay que
     * abrir una conexión con el rol de la aplicación (`app_runtime`,
     * NOBYPASSRLS) para comprobar lo que de verdad le pasa a un `UPDATE`
     * lanzado desde el proceso web. Es el mismo rol con el que la aplicación
     * está conectada en producción.
     */
    const { Client } = await import("pg")
    const { appRuntimeDatabaseUrl } = await import("@/tests/support/env")
    const runtime = new Client({ connectionString: appRuntimeDatabaseUrl() })
    await runtime.connect()
    try {
      await runtime.query(`SELECT set_config('app.organization_id', $1, false)`, [ORG])
      const error = await runtime
        .query(`UPDATE invariant_runs SET checks_hash = repeat('9', 64) WHERE id = $1::uuid`, [runId])
        .then(
          () => null,
          (e: unknown) => e as { code?: string }
        )
      expect(error?.code).toBe("42501")
    } finally {
      await runtime.end()
    }
  }, 300_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Roles y tenant
  // ───────────────────────────────────────────────────────────────────────────

  it("**roles**: VIEWER lee y no muta; EDITOR concilia pero no da de alta cuentas ni barre el almacén", async () => {
    const { bankPanelAction, createBankAccountAction, createMatchGroupAction, runStoreSweepAction, detectionTestAction } =
      await actions()

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: VIEWER_USER } })
    expect(await bankPanelAction({ bankAccountId })).toMatchObject({ success: true })
    expect(
      await createMatchGroupAction({ bankAccountId, statementLineIds: [bankAccountId], journalLineIds: [bankAccountId] })
    ).toMatchObject({ success: false, error: "Sin permiso" })

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
    expect(
      await createBankAccountAction({ code: "X", name: "X", accountCode: bankAccountCode })
    ).toMatchObject({ success: false, error: "Sin permiso" })
    expect(await runStoreSweepAction()).toMatchObject({ success: false, error: "Sin permiso" })
    expect(await detectionTestAction({})).toMatchObject({ success: false, error: "Sin permiso" })
  }, 120_000)

  it("**tenant**: una cuenta bancaria de otra organización sencillamente no existe", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: OTHER_USER } })
    const { bankPanelAction } = await actions()
    const result = (await bankPanelAction({ bankAccountId })) as ActionResult
    expect(result.success).toBe(false)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Prueba de detección y barrido del almacén
  // ───────────────────────────────────────────────────────────────────────────

  it("**prueba de detección**: FAIL demostrado sin tocar `journal_lines` (§7)", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER } })
    const { detectionTestAction } = await actions()
    const before = await tenantTransaction(ORG, ADMIN_USER, async (tx) => computeLedgerHash(tx, {}))
    const result = (await detectionTestAction({ refDate: REF })) as ActionResult
    expect(result).toMatchObject({ success: true })
    const data = result.data as { kind: string; detectedBy: string[] }
    expect(data.kind).toBe("PRUEBA")
    expect(data.detectedBy.length).toBeGreaterThan(0)
    expect(data.detectedBy).toContain("I1")

    const after = await tenantTransaction(ORG, ADMIN_USER, async (tx) => computeLedgerHash(tx, {}))
    expect(after).toBe(before)
    // Y no se ha escrito ningún barrido nuevo por la prueba.
    const runs = await tenantDb(ORG).invariantRun.count()
    expect(runs).toBe(1)
  }, 300_000)

  it("**hueco en la cadena**: I-E7-6b FAIL e I-E7-1 INFO — jamás PASS (criterio 10)", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
    // Un extracto de julio deja sin cubrir junio: la cadena [anclaje, corte]
    // tiene un hueco, y con un hueco no se puede AFIRMAR que la cuenta cuadra.
    const content = n43({
      account: "1234567890",
      from: "2026-07-01",
      to: "2026-07-31",
      openingCents: 999_999,
      movements: [{ date: "2026-07-15", amountCents: -7_700, concept: "CARGO DE JULIO" }],
    })
    expect(await importN43(content, "julio.n43")).toMatchObject({ success: true })

    const { readBankInvariantInput } = await import("@/models/bank")
    const { checkIE71, checkIE76b } = await import("@/lib/audit/invariants-e7")
    const input = await tenantTransaction(ORG, EDITOR_USER, async (tx) =>
      readBankInvariantInput(tx, { cutoff: REF, baseCurrency: "EUR" })
    )
    expect(input).not.toBeNull()
    const chain = checkIE76b(input!)
    expect(chain.status).toBe("FAIL")
    expect(chain.evidencia).toMatch(/hueco/)
    // Y con la cadena rota, el cuadre NO se pronuncia: INFO, nunca PASS.
    expect(checkIE71(input!).status).toBe("INFO")
  }, 300_000)

  it("**barrido del almacén** (T10): un fichero que falta del disco sale como MISSING y el barrido termina DONE", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER } })
    const db = tenantDb(ORG)
    await db.file.create({
      data: {
        organizationId: ORG,
        filename: "fantasma.pdf",
        path: "unsorted/fantasma.pdf",
        mimetype: "application/pdf",
        sha256: "d".repeat(64),
        sizeBytes: 10,
      },
    })
    const { enqueueStoreSweep } = await import("@/ai/store-sweep")
    const { promise } = await enqueueStoreSweep(ORG, { userId: ADMIN_USER })
    const sweep = await promise
    expect(sweep.status).toBe("DONE")
    expect(sweep.filesMissing).toBe(1)
    expect(sweep.findings.map((f) => f.kind)).toContain("MISSING")
  }, 300_000)
})
