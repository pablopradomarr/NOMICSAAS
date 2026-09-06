import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * E8 · T13 — las server actions del camino documental contra Postgres de
 * verdad, con la matriz de roles puesta y la RLS activa.
 *
 * Lo que se ejerce aquí y no se puede ejercer en un test puro:
 *
 * · **la puerta**: un `reconcile` en FAIL y una extracción parcial de un modelo
 *   no producen asiento —ni medio asiento, ni una `Transaction` colgada—;
 * · **el lote**: mezclando elegibles y no elegibles, sólo pasan los primeros y
 *   los demás vuelven **con su motivo** (§6, `/unsorted/batch`);
 * · **anular y rehacer** (ADR-0014 D1): contra-asiento, `VOID → PROPOSED` y la
 *   trazabilidad intacta en `voided_entry_ids`, sin volver a subir el fichero;
 * · **idempotencia**: confirmar dos veces deja UN asiento, y la misma acción
 *   ejecutada dos veces devuelve el mismo;
 * · **roles y tenant**: un `VIEWER` previsualiza y no confirma; un run de otra
 *   organización sencillamente no existe.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e8130000-0000-4000-8000-00000000001a"
const ORG_B = "e8130000-0000-4000-8000-00000000002a"
const EDITOR_USER = "e8130000-0000-4000-8000-0000000e0001"
const VIEWER_USER = "e8130000-0000-4000-8000-0000000f0002"
const OTHER_USER = "e8130000-0000-4000-8000-0000000b0003"

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
const { createExtractionRun } = await import("@/models/extraction")
const { proposalHash } = await import("@/lib/extraction/hash")
const { createHash } = await import("crypto")
type Proposal = import("@/lib/extraction/types").ExtractionProposal

/** Un sha por documento: dos ficheros con los mismos bytes SON un duplicado. */
const shaOf = (seed: string): string => createHash("sha256").update(seed).digest("hex")

/** Factura recibida simple: 1 000,00 € al 21 %, servicio contra 410. */
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  version: 1,
  docKind: "FACTURA_RECIBIDA",
  documentNumber: "FRA-2026-0001",
  counterparty: { name: "Proveedor S.L.", taxId: "B12345674" },
  documentDate: "2026-03-10",
  receptionDate: "2026-03-12",
  currency: "EUR",
  lines: [
    {
      kind: "OPERACION",
      baseCents: 100_000,
      taxRateCode: "IVA_21",
      accountCode: "629",
      accountCodeOrigin: "usuario",
      description: "Servicios de consultoría",
      deductibility: "FULL",
    },
  ],
  taxes: [{ taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000, operationKey: "GENERAL" }],
  totalCents: 121_000,
  description: "Factura de consultoría",
  ...over,
})

describe.skipIf(!TEST_DATABASE_URL)("E8 · T13 · server actions del camino documental", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: EDITOR_USER, email: "e8-t13-editor@test.local", name: "Editor" },
        { id: VIEWER_USER, email: "e8-t13-viewer@test.local", name: "Viewer" },
        { id: OTHER_USER, email: "e8-t13-otro@test.local", name: "Otro" },
      ],
    })
    for (const [id, slug] of [
      [ORG, "e8-t13-org"],
      [ORG_B, "e8-t13-org-b"],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: slug, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await importNpgc(id, "PYMES", { actor: { userId: EDITOR_USER }, now: new Date("2026-01-01"), useSubaccounts: false })
      const fy = await openFiscalYear(id, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, { userId: EDITOR_USER })
      if (!fy.ok) throw new Error(`no se pudo abrir el ejercicio de ${slug}`)
      await tenantTransaction(id, EDITOR_USER, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
        await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${id}::uuid`
        // Catálogo de monedas: sin él RC-04 rechaza hasta el euro, y una
        // organización real lo recibe en el alta (`createOrganizationDefaults`).
        await tx.currency.createMany({
          data: DEFAULT_CURRENCIES.map((c) => ({ ...c, organizationId: id })),
        })
        await tx.counterparty.create({
          data: { organizationId: id, code: "PROV1", name: "Proveedor S.L.", taxId: "B12345674", countryCode: "ES" },
        })
      })
    }
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: EDITOR_USER, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_B, userId: OTHER_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })
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
      await prisma.$executeRaw`UPDATE transactions SET status = 'VOID'
                                WHERE organization_id = ${org}::uuid AND status = 'POSTED'`
      // Líneas y asientos en la MISMA transacción: los constraint triggers
      // son diferidos y un asiento sin líneas sólo es legal a medio camino.
      await prisma.$transaction([
        prisma.$executeRaw`DELETE FROM journal_lines WHERE organization_id = ${org}::uuid`,
        prisma.$executeRaw`DELETE FROM journal_entries WHERE organization_id = ${org}::uuid`,
      ])
      await prisma.$executeRaw`DELETE FROM transactions WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM extraction_runs WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM files WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM audit_logs WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM counterparties WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM currencies WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM categories WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM fields WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM settings WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM period_locks WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM fiscal_years WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM tax_rates WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM organization_account_maps WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM cost_centers WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM projects WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM business_lines WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM accounts WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM invoice_series WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM memberships WHERE organization_id = ${org}::uuid`
      await prisma.$executeRaw`DELETE FROM organizations WHERE id = ${org}::uuid`
    }
    await prisma.$executeRaw`DELETE FROM users WHERE id IN (${EDITOR_USER}::uuid, ${VIEWER_USER}::uuid, ${OTHER_USER}::uuid)`
  }

  /** Un fichero con su sha y un run `LLM` con la propuesta ya sellada. */
  async function seedRun(
    org: string,
    p: Proposal,
    opts: { pagesSent?: number; pagesTotal?: number; sha?: string; suffix?: string } = {}
  ): Promise<{ fileId: string; runId: string }> {
    const db = tenantDb(org)
    const sha = opts.sha ?? shaOf(`${org}|${p.documentNumber}|${opts.suffix ?? ""}`)
    const file = await db.file.create({
      data: {
        organizationId: org,
        filename: `factura-${opts.suffix ?? Math.random().toString(36).slice(2, 8)}.pdf`,
        path: `unsorted/${Math.random().toString(36).slice(2)}.pdf`,
        mimetype: "application/pdf",
        sha256: sha,
        sizeBytes: 1024,
      },
    })
    const run = await createExtractionRun(db, {
      fileId: file.id,
      fileSha256: sha,
      kind: "LLM",
      provider: "openai",
      model: "gpt-4o-mini",
      promptCode: "extraction",
      promptSource: "GIT",
      promptSha: "b".repeat(64),
      schemaVersion: "v1",
      schemaSha: "c".repeat(64),
      pagesSent: opts.pagesSent ?? 1,
      pagesTotal: opts.pagesTotal ?? 1,
      rawOutput: { docKind: p.docKind },
      proposal: p,
      durationMs: 10,
      createdById: EDITOR_USER,
    })
    return { fileId: file.id, runId: run.id }
  }

  const actions = async () => await import("@/app/(app)/unsorted/actions")

  // ───────────────────────────────────────────────────────────────────────────

  it("EDITOR confirma un documento correcto: POSTED ⟺ journalEntryId, asiento cuadrado y AuditLog", async () => {
    const p = proposal()
    const { runId, fileId } = await seedRun(ORG, p)
    const { confirmProposalAction } = await actions()

    const result = await confirmProposalAction({ runId, proposal: p })
    expect(result).toMatchObject({ success: true })
    const data = result.data as { transactionId: string; entryId: string; yaEstaba: boolean }
    expect(data.yaEstaba).toBe(false)

    const db = tenantDb(ORG)
    const transaction = await db.transaction.findFirstOrThrow({ where: { id: data.transactionId } })
    expect(transaction.status).toBe("POSTED")
    expect(transaction.journalEntryId).toBe(data.entryId)
    expect(transaction.extractionRunId).toBe(runId)

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { id: data.entryId },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    })
    expect(entry.fileId).toBe(fileId)
    expect(entry.extractionRunId).toBe(runId)
    const debit = entry.lines.reduce((a, l) => a + l.debitCents, 0)
    const credit = entry.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debit).toBe(credit)
    expect(debit).toBe(121_000)
    // La cuota del documento va a 472 tal cual (ADR-0014 D3), sin línea de 669.
    expect(entry.lines.find((l) => l.accountCode === "472")?.debitCents).toBe(21_000)
    expect(entry.lines.map((l) => l.accountCode)).not.toContain("669")

    const log = await db.auditLog.findFirst({ where: { action: "CONFIRM_PROPOSAL", entityId: runId } })
    expect(log).not.toBeNull()
  }, 120_000)

  it("idempotencia: confirmar dos veces deja UN asiento y devuelve el mismo", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0002" })
    const { runId } = await seedRun(ORG, p)
    const { confirmProposalAction } = await actions()

    const first = await confirmProposalAction({ runId, proposal: p })
    const second = await confirmProposalAction({ runId, proposal: p })
    expect(first.success && second.success).toBe(true)
    const a = first.data as { entryId: string; transactionId: string }
    const b = second.data as { entryId: string; transactionId: string; yaEstaba: boolean }
    expect(b.entryId).toBe(a.entryId)
    expect(b.transactionId).toBe(a.transactionId)
    expect(b.yaEstaba).toBe(true)

    const db = tenantDb(ORG)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0002" } })).toBe(1)
    expect(await db.transaction.count({ where: { extractionRunId: runId } })).toBe(1)
  }, 120_000)

  it("doble ejecución simultánea de la misma acción: sigue habiendo un solo asiento", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0003" })
    const { runId } = await seedRun(ORG, p)
    const { confirmProposalAction } = await actions()

    const [one, two] = await Promise.all([
      confirmProposalAction({ runId, proposal: p }),
      confirmProposalAction({ runId, proposal: p }),
    ])
    expect(one.success || two.success).toBe(true)
    const db = tenantDb(ORG)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0003" } })).toBe(1)
  }, 120_000)

  it("un reconcile en FAIL no produce asiento: el total que no cuadra se nombra y no hay operación", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0004", totalCents: 119_900 })
    const { runId } = await seedRun(ORG, p)
    const { confirmProposalAction } = await actions()

    const result = await confirmProposalAction({ runId, proposal: p })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/RC-03/)

    const db = tenantDb(ORG)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0004" } })).toBe(0)
    expect(await db.transaction.count({ where: { extractionRunId: runId } })).toBe(0)
  }, 120_000)

  it("un run PARCIAL de un modelo no respalda un asiento (O-20.3)", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0005" })
    const { runId } = await seedRun(ORG, p, { pagesSent: 4, pagesTotal: 9 })
    const db = tenantDb(ORG)
    // El trigger de T3 escribe `partial`: no se confía en quien inserta.
    expect((await db.extractionRun.findFirstOrThrow({ where: { id: runId } })).partial).toBe(true)

    const { confirmProposalAction } = await actions()
    const result = await confirmProposalAction({ runId, proposal: p })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/RC-09|parcial/i)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0005" } })).toBe(0)
  }, 120_000)

  it("el lote confirma sólo los elegibles y devuelve los demás CON su motivo", async () => {
    const bueno = proposal({ documentNumber: "FRA-2026-0010" })
    const malo = proposal({ documentNumber: "FRA-2026-0011", totalCents: 100 })
    const parcial = proposal({ documentNumber: "FRA-2026-0012" })
    const a = await seedRun(ORG, bueno)
    const b = await seedRun(ORG, malo)
    const c = await seedRun(ORG, parcial, { pagesSent: 1, pagesTotal: 5 })

    const { confirmBatchAction } = await actions()
    const result = await confirmBatchAction({ runIds: [a.runId, b.runId, c.runId] })
    expect(result.success).toBe(true)
    const data = result.data as { confirmados: { extractionRunId: string }[]; noElegibles: { runId: string; motivo: string }[] }
    expect(data.confirmados).toHaveLength(1)
    expect(data.noElegibles.map((n) => n.runId).sort()).toEqual([b.runId, c.runId].sort())
    for (const item of data.noElegibles) expect(item.motivo.length).toBeGreaterThan(10)
    expect(data.noElegibles.find((n) => n.runId === c.runId)?.motivo).toMatch(/parcial/i)

    const db = tenantDb(ORG)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0011" } })).toBe(0)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0012" } })).toBe(0)
  }, 180_000)

  it("anular y rehacer: contra-asiento, VOID → PROPOSED y la trazabilidad intacta", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0020" })
    const { runId, fileId } = await seedRun(ORG, p)
    const { confirmProposalAction, revoidAndRedoAction } = await actions()

    const confirmed = await confirmProposalAction({ runId, proposal: p })
    const first = confirmed.data as { transactionId: string; entryId: string }

    const redo = await revoidAndRedoAction({
      transactionId: first.transactionId,
      reason: "la factura llevaba la cuenta equivocada y se rehace",
    })
    expect(redo.success).toBe(true)
    const redone = redo.data as { voidedEntryId: string | null; reversalEntryId: string | null }
    expect(redone.voidedEntryId).toBe(first.entryId)
    expect(redone.reversalEntryId).not.toBeNull()

    const db = tenantDb(ORG)
    const reopened = await db.transaction.findFirstOrThrow({ where: { id: first.transactionId } })
    expect(reopened.status).toBe("PROPOSED")
    expect(reopened.journalEntryId).toBeNull()
    expect(reopened.voidedEntryIds).toContain(first.entryId)
    // Nada se borra: el asiento original y su espejo siguen ahí.
    const original = await db.journalEntry.findFirstOrThrow({ where: { id: first.entryId } })
    expect(original.voidedAt).not.toBeNull()
    expect(await db.journalEntry.count({ where: { reversesEntryId: first.entryId } })).toBe(1)
    expect(await db.auditLog.count({ where: { action: "REVOID_AND_REDO", entityId: first.transactionId } })).toBe(1)

    // Y se rehace SIN volver a subir el fichero: mismo `File`, mismo `sha256`.
    const again = await confirmProposalAction({
      runId,
      proposal: { ...p, lines: [{ ...p.lines[0], accountCode: "623" }] },
      transactionId: first.transactionId,
    })
    expect(again.success).toBe(true)
    const second = again.data as { entryId: string; extractionRunId: string }
    expect(second.entryId).not.toBe(first.entryId)
    const rerun = await db.extractionRun.findFirstOrThrow({ where: { id: second.extractionRunId } })
    expect(rerun.kind).toBe("MANUAL")
    expect(rerun.parentRunId).toBe(runId)
    expect(rerun.fileId).toBe(fileId)
    const reposted = await db.transaction.findFirstOrThrow({ where: { id: first.transactionId } })
    expect(reposted.status).toBe("POSTED")
    expect(reposted.journalEntryId).toBe(second.entryId)
  }, 180_000)

  it("split N-a-1: un fichero, N operaciones y N asientos distintos", async () => {
    const p = proposal({
      documentNumber: "FRA-2026-0030",
      lines: [
        { kind: "OPERACION", baseCents: 60_000, taxRateCode: "IVA_21", accountCode: "629", accountCodeOrigin: "usuario" },
        { kind: "OPERACION", baseCents: 40_000, taxRateCode: "IVA_21", accountCode: "623", accountCodeOrigin: "usuario" },
      ],
    })
    const { runId, fileId } = await seedRun(ORG, p)
    const { splitProposalAction } = await actions()

    const result = await splitProposalAction({ runId, groups: [{ lineIndexes: [0] }, { lineIndexes: [1] }] })
    expect(result).toMatchObject({ success: true })
    const data = result.data as { transactionIds: string[]; runIds: string[] }
    expect(data.transactionIds).toHaveLength(2)

    const db = tenantDb(ORG)
    const transactions = await db.transaction.findMany({ where: { id: { in: data.transactionIds } } })
    expect(transactions.every((t) => t.status === "POSTED")).toBe(true)
    expect(new Set(transactions.map((t) => t.journalEntryId)).size).toBe(2)
    expect(transactions[1].splitParentTransactionId ?? transactions[0].splitParentTransactionId).toBe(
      data.transactionIds[0]
    )
    // Un solo fichero para las dos: el binario no se clona (G-03, O-9.iii).
    const entries = await db.journalEntry.findMany({ where: { id: { in: transactions.map((t) => t.journalEntryId ?? "") } } })
    expect(entries.every((e) => e.fileId === fileId)).toBe(true)
    // Σ de los dos asientos = el documento entero, sin perder un céntimo.
    const lines = await db.journalLine.findMany({ where: { entryId: { in: entries.map((e) => e.id) } } })
    expect(lines.reduce((a, l) => a + l.debitCents, 0)).toBe(121_000)
  }, 180_000)

  it("forzar un campo y marcar un ticket cualificado crean run de revisión con AuditLog", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0040" })
    const { runId } = await seedRun(ORG, p)
    const { forceOverrideAction } = await actions()

    const forced = await forceOverrideAction({
      runId,
      field: "documentNumber",
      value: "FRA-2026-0040-BIS",
      reason: "el proveedor reemitió la factura con otro número",
    })
    expect(forced).toMatchObject({ success: true })
    const db = tenantDb(ORG)
    const revision = await db.extractionRun.findFirstOrThrow({
      where: { id: (forced.data as { runId: string }).runId },
    })
    expect(revision.kind).toBe("MANUAL")
    expect(revision.parentRunId).toBe(runId)
    expect((revision.proposal as unknown as Proposal).documentNumber).toBe("FRA-2026-0040-BIS")
    const origins = revision.fieldOrigins as Record<string, { confidence: string }>
    expect(origins.documentNumber.confidence).toBe("no_verificado")
    expect(await db.auditLog.count({ where: { action: "FORCE_FIELD", entityId: revision.id } })).toBe(1)

    // El run del modelo sigue intacto: la evidencia no se reescribe (D5).
    const original = await db.extractionRun.findFirstOrThrow({ where: { id: runId } })
    expect((original.proposal as unknown as Proposal).documentNumber).toBe("FRA-2026-0040")
    expect(original.proposalSha).toBe(proposalHash(p))
  }, 120_000)

  it("un ticket se marca como cualificado con motivo y el run de revisión lo sella", async () => {
    const ticket = proposal({
      documentNumber: "T-0001",
      docKind: "TICKET",
      lines: [
        {
          kind: "OPERACION",
          baseCents: 1_122,
          taxRateCode: "IVA_10",
          accountCode: "629",
          accountCodeOrigin: "catalogo",
          deductibility: "NONE",
        },
      ],
      taxes: [{ taxRateCode: "IVA_10", baseCents: 1_122, quotaCents: 112 }],
      totalCents: 1_234,
      paymentKey: "BANCO_DEFAULT",
      simplifiedQualified: false,
    })
    const { runId } = await seedRun(ORG, ticket)
    const { markSimplifiedQualifiedAction } = await actions()

    const marked = await markSimplifiedQualifiedAction({
      runId,
      reason: "el ticket lleva NIF y cuota desglosada: art. 7.2 RD 1619/2012",
    })
    expect(marked).toMatchObject({ success: true })
    const db = tenantDb(ORG)
    const revision = await db.extractionRun.findFirstOrThrow({ where: { id: (marked.data as { runId: string }).runId } })
    const revised = revision.proposal as unknown as Proposal
    expect(revised.simplifiedQualified).toBe(true)
    expect(revised.lines[0].deductibility).toBe("FULL")
    const sealed = revision.reconcile as { warnings?: string[] }
    expect(sealed.warnings).toContain("TICKET_CUALIFICADO")
    expect(await db.auditLog.count({ where: { action: "MARK_SIMPLIFIED_QUALIFIED", entityId: revision.id } })).toBe(1)
  }, 120_000)

  it("un duplicado por sha256 exige motivo, y el motivo queda en AuditLog (I-E8-13)", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0060" })
    const mismosBytes = shaOf("mismos-bytes-dos-veces")
    const primero = await seedRun(ORG, p, { sha: mismosBytes, suffix: "a" })
    const { confirmProposalAction } = await actions()
    expect(await confirmProposalAction({ runId: primero.runId, proposal: p })).toMatchObject({ success: true })

    // Los mismos bytes, subidos otra vez: es el vector clásico del doble pago.
    const segundaProposal = proposal({ documentNumber: "FRA-2026-0061" })
    const segundo = await seedRun(ORG, segundaProposal, { sha: mismosBytes, suffix: "b" })
    const sinMotivo = await confirmProposalAction({ runId: segundo.runId, proposal: segundaProposal })
    expect(sinMotivo.success).toBe(false)
    expect(sinMotivo.error).toMatch(/motivo/i)

    const conMotivo = await confirmProposalAction({
      runId: segundo.runId,
      proposal: segundaProposal,
      forceReason: "el proveedor mandó el mismo PDF con dos números distintos y ambos son reales",
    })
    expect(conMotivo).toMatchObject({ success: true })
    const db = tenantDb(ORG)
    const forced = await db.auditLog.findFirst({
      where: { action: "FORCE_DUPLICATE", entityId: (conMotivo.data as { transactionId: string }).transactionId },
    })
    expect(forced?.reason).toMatch(/mismo PDF/)
  }, 180_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Roles y tenant
  // ───────────────────────────────────────────────────────────────────────────

  it("un VIEWER previsualiza —es auditoría— pero no confirma, ni divide, ni fuerza", async () => {
    const p = proposal({ documentNumber: "FRA-2026-0050" })
    const { runId } = await seedRun(ORG, p)
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: VIEWER_USER } })
    const { previewProposalAction, confirmProposalAction, splitProposalAction, forceOverrideAction, analyzeFileAction } =
      await actions()

    const preview = await previewProposalAction({ runId })
    expect(preview.success).toBe(true)
    const view = preview.data as { asiento: { descuadreCents: number; lines: unknown[] } | null; checks: unknown[] }
    expect(view.checks).toHaveLength(25)
    expect(view.asiento?.descuadreCents).toBe(0)

    expect(await confirmProposalAction({ runId, proposal: p })).toMatchObject({ success: false, error: "Sin permiso" })
    expect(await splitProposalAction({ runId, groups: [{ lineIndexes: [0] }, { lineIndexes: [0] }] })).toMatchObject({
      success: false,
      error: "Sin permiso",
    })
    expect(
      await forceOverrideAction({ runId, field: "documentNumber", value: "X", reason: "intento de un viewer" })
    ).toMatchObject({ success: false, error: "Sin permiso" })
    expect(await analyzeFileAction({ fileId: "00000000-0000-4000-8000-000000000001" })).toMatchObject({
      success: false,
      error: "Sin permiso",
    })

    const db = tenantDb(ORG)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-2026-0050" } })).toBe(0)
  }, 120_000)

  it("tenant: el run de otra organización sencillamente no existe, y no se contabiliza nada", async () => {
    const p = proposal({ documentNumber: "FRA-B-0001" })
    const ajeno = await seedRun(ORG_B, p)

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
    const { confirmProposalAction, previewProposalAction } = await actions()

    const confirmed = await confirmProposalAction({ runId: ajeno.runId, proposal: p })
    expect(confirmed.success).toBe(false)
    expect(confirmed.error).toMatch(/no existe en esta organización/)
    expect(await previewProposalAction({ runId: ajeno.runId })).toMatchObject({ success: false })

    expect(await tenantDb(ORG_B).journalEntry.count({ where: { sourceId: "FRA-B-0001" } })).toBe(0)
    expect(await tenantDb(ORG).extractionRun.count({ where: { id: ajeno.runId } })).toBe(0)
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // Ronda 1 de corrección — revisor #2, revisor #3 y auditor H-4
  // ───────────────────────────────────────────────────────────────────────────

  it("revisor #2 · `simplifiedQualified` en el cuerpo de confirmProposalAction se RECHAZA, y la marca del run sí se honra", async () => {
    const ticket = proposal({
      documentNumber: "T-RONDA1-01",
      docKind: "TICKET",
      lines: [
        { kind: "OPERACION", baseCents: 1_122, taxRateCode: "IVA_10", accountCode: "629", accountCodeOrigin: "catalogo", deductibility: "NONE" },
      ],
      taxes: [{ taxRateCode: "IVA_10", baseCents: 1_122, quotaCents: 112 }],
      totalCents: 1_234,
      paymentKey: "BANCO_DEFAULT",
    })
    const { runId } = await seedRun(ORG, ticket)
    const { confirmProposalAction, markSimplifiedQualifiedAction } = await actions()

    // (a) Por el cuerpo de la petición: zod lo rechaza como clave desconocida.
    const colado = await confirmProposalAction({
      runId,
      proposal: { ...ticket, simplifiedQualified: true },
    })
    expect(colado.success).toBe(false)
    expect(colado.error).toMatch(/simplifiedQualified/)
    expect(await tenantDb(ORG).journalEntry.count({ where: { sourceId: "T-RONDA1-01" } })).toBe(0)

    // (b) Por la puerta buena: `markSimplifiedQualifiedAction`, con motivo y AuditLog.
    const marked = await markSimplifiedQualifiedAction({
      runId,
      reason: "el ticket lleva NIF y cuota desglosada: art. 7.2 RD 1619/2012",
    })
    expect(marked).toMatchObject({ success: true })
    const revisionId = (marked.data as { runId: string }).runId
    const db = tenantDb(ORG)
    const revision = await db.extractionRun.findFirstOrThrow({ where: { id: revisionId } })
    const revised = revision.proposal as unknown as Proposal

    // Y al confirmar el run de revisión, la marca la pone el SERVIDOR desde el
    // run: la propuesta que viaja no la lleva y el IVA se deduce igualmente.
    const { simplifiedQualified: _marca, ...sinMarca } = revised
    const confirmed = await confirmProposalAction({
      runId: revisionId,
      proposal: sinMarca as unknown as Proposal,
      forceReason: "revisado el ticket cualificado antes de contabilizar",
    })
    expect(confirmed).toMatchObject({ success: true })
    const entryId = (confirmed.data as { entryId: string }).entryId
    const lines = await db.journalLine.findMany({ where: { entryId }, select: { accountCode: true, debitCents: true } })
    const iva = lines.find((l) => l.accountCode === "472")
    expect(iva?.debitCents).toBe(112)
  }, 180_000)

  it("revisor #3 · con campos `no_verificado`, el SERVIDOR exige motivo aunque el navegador no lo mande", async () => {
    const p = proposal({ documentNumber: "FRA-RONDA1-03" })
    const { runId } = await seedRun(ORG, p)
    const { confirmProposalAction, forceOverrideAction } = await actions()

    // Forzar un campo lo deja en `no_verificado`: es el estado que el diálogo
    // de la pantalla acompaña de un motivo y que el servidor no exigía.
    const forced = await forceOverrideAction({
      runId,
      field: "documentNumber",
      value: "FRA-RONDA1-03-BIS",
      reason: "el número del PDF está cortado por el sello de registro",
    })
    expect(forced).toMatchObject({ success: true })
    const revisionId = (forced.data as { runId: string }).runId
    const db = tenantDb(ORG)
    const revision = await db.extractionRun.findFirstOrThrow({ where: { id: revisionId } })
    const revised = revision.proposal as unknown as Proposal

    const sinMotivo = await confirmProposalAction({ runId: revisionId, proposal: revised })
    expect(sinMotivo.success).toBe(false)
    expect(sinMotivo.error).toMatch(/sin verificar/)
    expect(sinMotivo.error).toMatch(/documentNumber/)
    expect(await db.journalEntry.count({ where: { sourceId: "FRA-RONDA1-03-BIS" } })).toBe(0)

    // Un «ok» tampoco vale: el mínimo es el mismo que en el resto de forzados.
    expect(await confirmProposalAction({ runId: revisionId, proposal: revised, forceReason: "ok" })).toMatchObject({
      success: false,
    })

    const conMotivo = await confirmProposalAction({
      runId: revisionId,
      proposal: revised,
      forceReason: "se asume el número tecleado a la vista del original en papel",
    })
    expect(conMotivo).toMatchObject({ success: true })
    const log = await db.auditLog.findFirstOrThrow({
      where: { action: "CONFIRM_PROPOSAL", entityId: revisionId },
    })
    expect(log.reason).toMatch(/número tecleado/)
    expect((log.after as { camposNoVerificados?: string[] }).camposNoVerificados).toContain("documentNumber")
  }, 180_000)

  it("QA BUG-E8-2 · un documento cuyos bytes no están en el almacén se sirve como estado explícito, no como 404 mudo", async () => {
    const p = proposal({ documentNumber: "FRA-RONDA1-BUG2" })
    const { fileId } = await seedRun(ORG, p)
    // `seedRun` crea la FICHA pero no escribe bytes: es exactamente el estado
    // que el QA reprodujo (la fila sobrevive y el fichero no).
    const { GET } = await import("@/app/(app)/files/preview/[fileId]/route")
    const { DOCUMENT_STATUS_HEADER, DOCUMENT_UNAVAILABLE } = await import("@/lib/previews/unavailable")

    const response = await GET(new Request(`http://localhost/files/preview/${fileId}?page=1`), {
      params: Promise.resolve({ fileId }),
    })
    // 410 Gone, no 404: el recurso existió y ya no está, que no es lo mismo que
    // «no es tuyo». La UI distingue los dos casos por esta cabecera.
    expect(response.status).toBe(410)
    expect(response.headers.get(DOCUMENT_STATUS_HEADER)).toBe(DOCUMENT_UNAVAILABLE)
    const body = (await response.json()) as { status: string; fileId: string; path: string | null; message: string }
    expect(body.status).toBe(DOCUMENT_UNAVAILABLE)
    expect(body.fileId).toBe(fileId)
    expect(body.message).toMatch(/no está en el almacén/)
    expect(body.message).toMatch(/I-E8-2/)

    // Y un fichero que no existe en la organización sigue siendo un 404.
    const ajeno = "00000000-0000-4000-8000-0000000000ff"
    const noExiste = await GET(new Request(`http://localhost/files/preview/${ajeno}`), {
      params: Promise.resolve({ fileId: ajeno }),
    })
    expect(noExiste.status).toBe(404)
  }, 120_000)

  it("auditor H-4 · sin tasa publicada, la acción devuelve RC-14 «sin tasa» en su ActionState y no guarda nada", async () => {
    // La fuente no responde: `getOrFetchRate` LANZA (nunca inventa una tasa) y
    // hasta esta ronda la excepción atravesaba la server action sin tipar.
    const original = process.env.FRANKFURTER_BASE_URL
    vi.resetModules()
    process.env.FRANKFURTER_BASE_URL = "http://127.0.0.1:1/no-hay-fuente"
    try {
      const enDolares = proposal({
        documentNumber: "USD-RONDA1-04",
        currency: "USD",
        documentDate: "2026-04-07",
        receptionDate: "2026-04-07",
      })
      const { runId } = await seedRun(ORG, enDolares)
      const { confirmProposalAction, previewProposalAction } = await actions()

      const preview = await previewProposalAction({ runId, proposal: enDolares })
      expect(preview.success).toBe(false)
      expect(preview.error).toMatch(/^RC-14 · sin tasa persistida para USD→EUR del 2026-04-07/)

      const confirmed = await confirmProposalAction({ runId, proposal: enDolares })
      expect(confirmed.success).toBe(false)
      expect(confirmed.error).toMatch(/RC-14/)
      expect(confirmed.error).toMatch(/no se ha guardado nada/)
      expect(await tenantDb(ORG).journalEntry.count({ where: { sourceId: "USD-RONDA1-04" } })).toBe(0)
      expect(await tenantDb(ORG).transaction.count({ where: { name: "USD-RONDA1-04" } })).toBe(0)
    } finally {
      if (original === undefined) delete process.env.FRANKFURTER_BASE_URL
      else process.env.FRANKFURTER_BASE_URL = original
      vi.resetModules()
    }
  }, 180_000)
})
