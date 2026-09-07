import { afterAll, beforeAll, describe, expect, it } from "vitest"

// E7 · ADR-0015 D1: el diario es `bigint` en la base; leído en crudo hay que
// cruzar el borde, igual que hace `models/ledger.ts`.
import { centsFromDb } from "@/lib/money"

/**
 * E8 · T18/T19 — facturas emitidas contra Postgres de verdad.
 *
 * Lo que se ejerce aquí y no se puede ejercer en un test puro:
 *
 * · **numeración concurrente** con `FOR UPDATE`: N emisores simultáneos, N
 *   números distintos y consecutivos (art. 6.1.a RD 1619/2012);
 * · **I-E8-20**: la sucesión emitida es 1..N sin huecos y con fecha no
 *   decreciente, y un hueco inyectado por SQL se detecta;
 * · **recálculo en servidor** (G-21): las cifras del asiento salen de cantidad ×
 *   precio, no de lo que mande el cliente;
 * · `POSTED ⟺ journalEntryId` (I-E8-4) y **serie rectificativa** para el abono;
 * · **dedupe** por `sha256` y por `(taxId, nº documento, ejercicio)` (G-11).
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { emitInvoice, checkInvoiceNumberingGaps, nextInvoiceNumberTx, listInvoiceSeries } = await import(
  "@/models/invoices"
)
const { findDuplicateDocuments, defaultCurrencyCode } = await import("@/models/transactions")
const { findFilesBySha256 } = await import("@/models/files")

const ORG = "e8180000-0000-4000-8000-00000000001a"
const USER = "e8180000-0000-4000-8000-00000000001b"
const actor = { userId: USER }
const REF = "2026-12-31"

describe.skipIf(!TEST_DATABASE_URL)("E8 · T18 · facturas emitidas", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e8-t18@test.local", name: "E8 T18" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e8-t18-org", name: "E8 T18", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
    await importNpgc(ORG, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    const fy = await openFiscalYear(ORG, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    if (!fy.ok) throw new Error("no se pudo abrir el ejercicio")
    await tenantTransaction(ORG, USER, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
      await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${ORG}::uuid`
      // Series de la organización: la migración siembra la RECTIFICATIVA; la
      // ordinaria es configuración de la organización (Ajustes → Facturación).
      await tx.$executeRaw`
        INSERT INTO invoice_series (id, organization_id, code, kind, prefix, next_number, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${ORG}::uuid, 'FRA', 'ORDINARIA', 'F-2026-', 1, true, now(), now())
        ON CONFLICT DO NOTHING`
      await tx.$executeRaw`
        INSERT INTO invoice_series (id, organization_id, code, kind, prefix, next_number, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${ORG}::uuid, 'RECT', 'RECTIFICATIVA', 'R-2026-', 1, true, now(), now())
        ON CONFLICT DO NOTHING`
    })
  }, 240_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    // El CHECK D1 (`POSTED ⟺ journal_entry_id`) muerde también al limpiar: al
    // borrar el asiento, la FK pone el puntero a NULL y la operación se queda
    // en POSTED sin asiento. Se anulan primero —transición permitida, y el
    // trigger traslada el asiento a `voided_entry_id`— y luego se borra.
    await prisma.$executeRaw`UPDATE transactions SET status = 'VOID'
                              WHERE organization_id = ${ORG}::uuid AND status = 'POSTED'`
    await prisma.$transaction([
      prisma.$executeRaw`DELETE FROM journal_lines WHERE organization_id = ${ORG}::uuid`,
      prisma.$executeRaw`DELETE FROM journal_entries WHERE organization_id = ${ORG}::uuid`,
    ])
    await prisma.$executeRaw`DELETE FROM files WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM transactions WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM invoice_series WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM counterparties WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM audit_logs WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM period_locks WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM fiscal_years WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM tax_rates WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM organization_account_maps WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM cost_centers WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM projects WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM business_lines WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM accounts WHERE organization_id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM organizations WHERE id = ${ORG}::uuid`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${USER}::uuid`
  }

  const factura = (over: Record<string, unknown> = {}) => ({
    seriesKind: "ORDINARIA" as const,
    documentDate: "2026-03-15",
    customerName: "Cliente S.L.",
    lines: [{ description: "Consultoría", quantityMilli: 2_500, unitPriceCents: 4_500, taxRateCode: "IVA_21" }],
    ...over,
  })

  it("recálculo en servidor (G-21): 2,5 × 45,00 € = 112,50 € de base y 23,63 € de cuota", async () => {
    const emitted = await emitInvoice(ORG, factura(), actor, { refDate: REF })
    if (!emitted.ok) throw new Error(JSON.stringify(emitted.errors))

    // 2,5 h × 45,00 € = 112,50 € (half-even, ADR-0006) · 21 % = 23,625 → 23,63
    // (la CUOTA redondea half-up, criterio AEAT: `lib/taxes/bps.ts`).
    expect(emitted.value.baseTotalCents).toBe(11_250)
    expect(emitted.value.taxTotalCents).toBe(2_363)
    expect(emitted.value.totalCents).toBe(13_613)
    expect(emitted.value.documentNumber).toBe("F-2026-00001")

    // El asiento cuadra y las cifras son las del servidor.
    const lines = await tenantDb(ORG).journalLine.findMany({
      where: { entry: { sourceId: "F-2026-00001" } },
      orderBy: { lineNo: "asc" },
    })
    // E7 · ADR-0015 D1: en crudo, `bigint`.
    const debit = lines.reduce((a, l) => a + centsFromDb(l.debitCents), 0)
    const credit = lines.reduce((a, l) => a + centsFromDb(l.creditCents), 0)
    expect(debit).toBe(credit)
    expect(debit).toBe(13_613)

    // I-E8-4: POSTED ⟺ journalEntryId.
    const transaction = await tenantDb(ORG).transaction.findFirstOrThrow({
      where: { id: emitted.value.transactionId },
    })
    expect(transaction.status).toBe("POSTED")
    expect(transaction.journalEntryId).toBe(emitted.value.entry.id)
    expect(transaction.total).toBe(13_613)
    expect(transaction.currencyCode).toBe(await defaultCurrencyCode(tenantDb(ORG)))
  }, 120_000)

  it("numeración concurrente: 8 emisiones en paralelo dan 8 números distintos y consecutivos", async () => {
    const before = (await listInvoiceSeries(tenantDb(ORG))).find((s) => s.code === "FRA")!.nextNumber

    const results = await Promise.all(
      // MISMA fecha: lo que se mide es el número, no el orden temporal.
      Array.from({ length: 8 }, () => emitInvoice(ORG, factura({ documentDate: "2026-06-01" }), actor, { refDate: REF }))
    )
    const numbers = results.map((r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.errors))
      return Number(r.value.documentNumber.slice("F-2026-".length))
    })

    expect(new Set(numbers).size).toBe(8)
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_, i) => before + i)
    )
  }, 240_000)

  it("I-E8-20: la serie no tiene huecos… hasta que se inyecta uno por SQL", async () => {
    expect(await checkInvoiceNumberingGaps(tenantDb(ORG))).toEqual([])

    // Error inyectado: el contador avanza sin que exista el asiento detrás. Es
    // exactamente lo que pasa cuando alguien «reserva» un número y luego borra
    // la factura por fuera de la aplicación —lo que la aplicación no permite—.
    const serie = (await listInvoiceSeries(tenantDb(ORG))).find((s) => s.code === "FRA")!
    const perdido = serie.nextNumber
    await prisma.$executeRaw`UPDATE invoice_series SET next_number = next_number + 1 WHERE id = ${serie.id}::uuid`

    const gaps = await checkInvoiceNumberingGaps(tenantDb(ORG))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].seriesCode).toBe("FRA")
    expect(gaps[0].missing).toEqual([perdido])
  }, 120_000)

  it("un tipo impositivo inexistente no se convierte en 0 %: la emisión falla y NO consume número", async () => {
    const before = (await listInvoiceSeries(tenantDb(ORG))).find((s) => s.code === "FRA")!.nextNumber

    const failed = await emitInvoice(
      ORG,
      factura({ lines: [{ description: "X", quantityMilli: 1_000, unitPriceCents: 1_000, taxRateCode: "IVA_99" }] }),
      actor,
      { refDate: REF }
    )
    expect(failed.ok).toBe(false)

    const after = (await listInvoiceSeries(tenantDb(ORG))).find((s) => s.code === "FRA")!.nextNumber
    expect(after, "un fallo no puede dejar hueco en la numeración").toBe(before)
  }, 120_000)

  it("el abono toma número de la serie RECTIFICATIVA y contabiliza la DIFERENCIA (sustitución)", async () => {
    const original = await emitInvoice(
      ORG,
      factura({
        documentDate: "2026-09-01",
        lines: [{ description: "Proyecto", quantityMilli: 1_000, unitPriceCents: 100_000, taxRateCode: "IVA_21" }],
      }),
      actor,
      { refDate: REF }
    )
    if (!original.ok) throw new Error(JSON.stringify(original.errors))
    expect(original.value.totalCents).toBe(121_000)

    const abono = await emitInvoice(
      ORG,
      {
        seriesKind: "RECTIFICATIVA",
        documentDate: "2026-09-30",
        customerName: "Cliente S.L.",
        lines: [{ description: "Proyecto", quantityMilli: 1_000, unitPriceCents: 80_000, taxRateCode: "IVA_21" }],
        rectifies: { entryId: original.value.entry.id, reason: "ERROR", mode: "SUSTITUCION" },
      },
      actor,
      { refDate: REF }
    )
    if (!abono.ok) throw new Error(JSON.stringify(abono.errors))

    expect(abono.value.documentNumber).toBe("R-2026-00001")
    // Se abona la DIFERENCIA (20 000 + 4 200), no la cifra nueva (80 000).
    expect(abono.value.baseTotalCents).toBe(20_000)
    expect(abono.value.taxTotalCents).toBe(4_200)
    expect(abono.value.totalCents).toBe(24_200)
  }, 120_000)

  it("una rectificativa AL ALZA se rechaza y remite a la factura complementaria", async () => {
    const original = await emitInvoice(
      ORG,
      factura({
        documentDate: "2026-10-01",
        lines: [{ description: "Obra", quantityMilli: 1_000, unitPriceCents: 50_000, taxRateCode: "IVA_21" }],
      }),
      actor,
      { refDate: REF }
    )
    if (!original.ok) throw new Error(JSON.stringify(original.errors))

    const subida = await emitInvoice(
      ORG,
      {
        seriesKind: "RECTIFICATIVA",
        documentDate: "2026-10-02",
        lines: [{ description: "Obra", quantityMilli: 1_000, unitPriceCents: 70_000, taxRateCode: "IVA_21" }],
        rectifies: { entryId: original.value.entry.id, reason: "ERROR", mode: "SUSTITUCION" },
      },
      actor,
      { refDate: REF }
    )
    expect(subida.ok).toBe(false)
    if (!subida.ok) expect(subida.errors.map((e) => e.message).join(" ")).toMatch(/complementaria/)
  }, 120_000)

  it("`nextInvoiceNumberTx` falla con claridad cuando el tipo de serie no está configurado", async () => {
    await expect(
      tenantTransaction(ORG, USER, async (tx) => nextInvoiceNumberTx(tx, { kind: "SIMPLIFICADA" }))
    ).rejects.toThrow()
  }, 60_000)
})

describe.skipIf(!TEST_DATABASE_URL)("E8 · T19 · dedupe del camino de entrada", () => {
  const ORG19 = "e8190000-0000-4000-8000-00000000001a"
  const USER19 = "e8190000-0000-4000-8000-00000000001b"

  beforeAll(async () => {
    await cleanup19()
    await prisma.user.create({ data: { id: USER19, email: "e8-t19@test.local", name: "E8 T19" } })
    await prisma.organization.create({
      data: { id: ORG19, slug: "e8-t19-org", name: "E8 T19", baseCurrency: "EUR", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG19, userId: USER19, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
  }, 120_000)

  afterAll(cleanup19)

  async function cleanup19() {
    await prisma.$executeRaw`DELETE FROM files WHERE organization_id = ${ORG19}::uuid`
    await prisma.$executeRaw`DELETE FROM counterparties WHERE organization_id = ${ORG19}::uuid`
    await prisma.$executeRaw`DELETE FROM transactions WHERE organization_id = ${ORG19}::uuid`
    await prisma.$executeRaw`DELETE FROM memberships WHERE organization_id = ${ORG19}::uuid`
    await prisma.$executeRaw`DELETE FROM organizations WHERE id = ${ORG19}::uuid`
    await prisma.$executeRaw`DELETE FROM users WHERE id = ${USER19}::uuid`
  }

  it("G-19: la moneda por defecto es la de la organización, no «USD»", async () => {
    expect(await defaultCurrencyCode(tenantDb(ORG19))).toBe("EUR")
  })

  it("G-11: dos ficheros con los mismos bytes se encuentran por sha256, y el tenant aísla", async () => {
    const sha = "a".repeat(64)
    await tenantTransaction(ORG19, USER19, async (tx) => {
      for (const n of [1, 2]) {
        await tx.file.create({
          data: {
            organizationId: ORG19,
            uploadedById: USER19,
            filename: `f${n}.pdf`,
            path: `unsorted/f${n}.pdf`,
            mimetype: "application/pdf",
            sha256: sha,
          },
        })
      }
    })

    const found = await findFilesBySha256(tenantDb(ORG19), sha)
    expect(found).toHaveLength(2)
    // Otra organización no ve nada: la RLS es la segunda barrera.
    expect(await findFilesBySha256(tenantDb(ORG), sha)).toHaveLength(0)
  }, 60_000)

  it("G-11 / I-E8-13: sin contraparte ni número no hay clave de documento, y por tanto no hay falso positivo", async () => {
    expect(await findDuplicateDocuments(tenantDb(ORG19), { taxId: null, documentNumber: "1", year: 2026 })).toEqual([])
    expect(await findDuplicateDocuments(tenantDb(ORG19), { taxId: "B12345674", documentNumber: null, year: 2026 })).toEqual(
      []
    )
    // Con contraparte pero sin asientos, tampoco.
    await tenantTransaction(ORG19, USER19, async (tx) => {
      await tx.counterparty.create({
        data: { organizationId: ORG19, code: "PROV1", name: "Proveedor S.L.", taxId: "B12345674" },
      })
    })
    expect(
      await findDuplicateDocuments(tenantDb(ORG19), { taxId: "B12345674", documentNumber: "FRA-1", year: 2026 })
    ).toEqual([])
  }, 60_000)
})
