import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E3 · T14 — Integración del libro diario contra Postgres de verdad.
 *
 * Cubre los criterios de aceptación de `docs/design/E3-libro-diario.md` §8.1:
 * 1 y 2 (posteo y descuadre imposible), 3 (numeración sin huecos bajo
 * concurrencia), 4 (mes bloqueado y ejercicio cerrado), 5 (anulación y
 * anulación de la anulación), 11 (saldos del fixture, por hoja y por prefijo),
 * 14 (**test de error inyectado por SQL**) y la parte de I10 que se puede
 * comprobar con la barrera 1.
 *
 * La suite conecta con el rol PROPIETARIO: aquí se ejerce la lógica y los
 * triggers. La RLS efectiva se ejerce en `tests/integration-rls/`.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear, closeFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod, unlockPeriod } = await import("@/models/period-locks")
const {
  computeLedgerHash,
  getAccountBalances,
  getEntries,
  postEntry,
  runLedgerInvariants,
  voidEntry,
} = await import("@/models/ledger")
const { getLedgerContext } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { readFixture } = await import("@/tests/support/fixtures")

type Draft = Awaited<ReturnType<typeof buildEntry>>

const ORG_MIN = "e3000000-0000-4000-8000-00000000000a"
const ORG_MIN_2 = "e3000000-0000-4000-8000-00000000000b"
const ORG_FULL = "e3000000-0000-4000-8000-00000000000c"
const ORG_OPS = "e3000000-0000-4000-8000-00000000000d"
const ORG_OTHER = "e3000000-0000-4000-8000-00000000000e"
const USER = "e3000000-0000-4000-8000-0000000000a1"
const ALL_ORGS = [ORG_MIN, ORG_MIN_2, ORG_FULL, ORG_OPS, ORG_OTHER]

const actor = { userId: USER }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E3 · libro diario en base de datos", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e3-ledger@test.local", name: "E3" } })
    await prisma.organization.createMany({
      data: ALL_ORGS.map((id, index) => ({
        id,
        slug: `e3-org-${index}`,
        name: `E3 Org ${index}`,
        pgcVariant: "PYMES" as const,
        updatedAt: new Date(),
      })),
    })
    await prisma.membership.create({
      data: { organizationId: ORG_MIN, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      // Líneas y asientos, en LA MISMA transacción: el constraint trigger
      // diferido sólo se calla si el asiento tampoco existe al COMMIT.
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query("COMMIT")
      await client.query(`DELETE FROM period_locks WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM fiscal_years WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM audit_logs WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM tax_rates WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM organization_account_maps WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM accounts WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER])
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // T13 · carga de fixtures y verificación de `expected`
  // ───────────────────────────────────────────────────────────────────────────

  it(
    "criterio 15 · ejercicio-minimo entra por postEntry y cuadra con `expected`; dos cargas dan el MISMO ledgerHash",
    async () => {
      const first = await loadFixtureIntoOrg({ organizationId: ORG_MIN, fixture: "ejercicio-minimo", userId: USER })
      expect(first.mismatches).toEqual([])
      expect(first.entryCount).toBe(5)

      const second = await loadFixtureIntoOrg({ organizationId: ORG_MIN_2, fixture: "ejercicio-minimo", userId: USER })
      expect(second.mismatches).toEqual([])
      // Byte-idéntico: la forma canónica v1 no depende de ids ni de timestamps.
      expect(second.ledgerHash).toBe(first.ledgerHash)

      // N-1/I7: numeración 1..5 sin huecos.
      const { entries } = await tenantTransaction(ORG_MIN, USER, async (tx) => getEntries(tx, {}, { take: 100 }))
      expect(entries.map((e) => e.entryNumber)).toEqual([1, 2, 3, 4, 5])
      const fy = await tenantDb(ORG_MIN).fiscalYear.findFirstOrThrow({ where: { code: "2026" } })
      expect(fy.lastEntryNumber).toBe(5)

      // Trazabilidad: un AuditLog `post` por asiento.
      const logs = await tenantDb(ORG_MIN).auditLog.count({ where: { entity: "JournalEntry", action: "post" } })
      expect(logs).toBe(5)
    },
    240_000
  )

  it(
    "criterio 11 · ejercicio-completo: 84 asientos, saldos por hoja y por prefijo de 3 dígitos",
    async () => {
      const report = await loadFixtureIntoOrg({ organizationId: ORG_FULL, fixture: "ejercicio-completo", userId: USER })
      expect(report.mismatches).toEqual([])
      expect(report.entryCount).toBe(84)
      expect(report.totalDebitCents).toBe(67_193_629)
      expect(report.totalCreditCents).toBe(67_193_629)

      const file = readFixture("ejercicio-completo")
      const byPrefix = (file.expected as { balancesByPrefix3Cents?: Record<string, number> }).balancesByPrefix3Cents
      expect(byPrefix, "el fixture declara balancesByPrefix3Cents").toBeTruthy()

      const balances = await tenantTransaction(ORG_FULL, USER, async (tx) =>
        getAccountBalances(tx, {
          upTo: "2026-12-31",
          fiscalYearId: report.fiscalYearIds["2026"],
          excludeKinds: ["CLOSING"],
        })
      )
      const aggregated = new Map<string, number>()
      for (const [code, cents] of balances) {
        const prefix = code.slice(0, 3)
        aggregated.set(prefix, (aggregated.get(prefix) ?? 0) + cents)
      }
      for (const [prefix, expected] of Object.entries(byPrefix ?? {})) {
        expect(aggregated.get(prefix) ?? 0, `prefijo ${prefix}`).toBe(expected)
      }
    },
    300_000
  )

  // ───────────────────────────────────────────────────────────────────────────
  // Numeración bajo concurrencia (criterio 3)
  // ───────────────────────────────────────────────────────────────────────────

  describe("operativa sobre un ejercicio limpio", () => {
    let fiscalYearId = ""

    beforeAll(async () => {
      await importNpgc(ORG_OPS, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
      const fy = await openFiscalYear(ORG_OPS, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
      if (!fy.ok) throw new Error("no se pudo crear el ejercicio")
      fiscalYearId = fy.value.id
    }, 180_000)

    /** Asiento de dos líneas cuadrado, con la fecha que se le pida. */
    async function simpleDraft(entryDate: string, amountCents = 12_100): Promise<Draft> {
      return await tenantTransaction(ORG_OPS, USER, async (tx) => {
        const ctx = await getLedgerContext(tx, "2026-12-31")
        return buildEntry(
          {
            organizationId: ORG_OPS,
            entryDate,
            description: `Asiento de prueba ${entryDate}`,
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "572", debitCents: amountCents, creditCents: 0 },
              { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: amountCents },
            ],
          },
          ctx
        )
      })
    }

    it("criterio 3 · 10 posteos en paralelo → 1..10 sin huecos ni duplicados", async () => {
      const draft = await simpleDraft("2026-02-10")
      if (!draft.ok) throw new Error(JSON.stringify(draft.errors))

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          postEntry(ORG_OPS, { ...draft.value, description: `Concurrente ${i + 1}` }, actor, { refDate: "2026-12-31" })
        )
      )
      expect(results.every((r) => r.ok)).toBe(true)

      const numbers = results.flatMap((r) => (r.ok ? [r.value.entryNumber] : [])).sort((a, b) => a - b)
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      const fy = await tenantDb(ORG_OPS).fiscalYear.findFirstOrThrow({ where: { id: fiscalYearId } })
      expect(fy.lastEntryNumber).toBe(10)
    }, 120_000)

    it("criterio 2 · asiento descuadrado: lo rechaza el motor y, saltándoselo, el trigger diferido", async () => {
      const draft = await simpleDraft("2026-02-11")
      if (!draft.ok) throw new Error("draft")
      const unbalanced = {
        ...draft.value,
        lines: [draft.value.lines[0], { ...draft.value.lines[1], creditCents: 9_999 }],
      }

      const byEngine = await postEntry(ORG_OPS, unbalanced, actor, { refDate: "2026-12-31" })
      expect(byEngine.ok).toBe(false)
      if (!byEngine.ok) expect(byEngine.errors.map((e) => e.code)).toContain("UNBALANCED")

      // B-5 / criterio 2: saltándose la validación de la app, la BD lo corta al
      // COMMIT con el constraint trigger diferido.
      const byDb = await postEntry(ORG_OPS, unbalanced, actor, { skipCheck: true })
      expect(byDb.ok).toBe(false)
      if (!byDb.ok) expect(byDb.errors[0].code).toBe("UNBALANCED")

      // Y no ha consumido número.
      const fy = await tenantDb(ORG_OPS).fiscalYear.findFirstOrThrow({ where: { id: fiscalYearId } })
      expect(fy.lastEntryNumber).toBe(10)
    }, 60_000)

    it("criterio 5 · anulación: contra-asiento espejo, y la anulación de la anulación se rechaza", async () => {
      const draft = await simpleDraft("2026-03-10", 50_000)
      if (!draft.ok) throw new Error("draft")
      const posted = await postEntry(ORG_OPS, draft.value, actor, { refDate: "2026-12-31" })
      if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

      const voided = await voidEntry(ORG_OPS, posted.value.id, "Factura duplicada del proveedor", actor, {
        refDate: "2026-12-31",
      })
      if (!voided.ok) throw new Error(JSON.stringify(voided.errors))

      expect(voided.value.reversal.kind).toBe("REVERSAL")
      expect(voided.value.reversal.entryDate).toBe("2026-03-10")
      expect(voided.value.reversal.reversesEntryId).toBe(posted.value.id)
      expect(voided.value.reversal.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])).toEqual([
        ["572", 0, 50_000],
        ["705", 50_000, 0],
      ])
      expect(voided.value.voided.voidedAt).toBeTruthy()

      // I-E3-2: dos veces, no.
      const again = await voidEntry(ORG_OPS, posted.value.id, "Otra vez, no debería poder", actor, {
        refDate: "2026-12-31",
      })
      expect(again.ok).toBe(false)
      if (!again.ok) expect(again.errors.map((e) => e.code)).toContain("ALREADY_REVERSED")

      // I-E3-4: un contra-asiento no se anula con otro contra-asiento.
      const ofReversal = await voidEntry(ORG_OPS, voided.value.reversal.id, "Anular el contra-asiento", actor, {
        refDate: "2026-12-31",
      })
      expect(ofReversal.ok).toBe(false)
      if (!ofReversal.ok) expect(ofReversal.errors.map((e) => e.code)).toContain("REVERSAL_OF_REVERSAL")
    }, 60_000)

    it("criterio 4 · mes bloqueado: B-2 secuencial, rechazo del posteo y B-3 al desbloquear", async () => {
      // B-2: no se bloquea el 5 con el 4 abierto.
      const outOfOrder = await lockPeriod(ORG_OPS, { fiscalYearId, month: 5 }, actor)
      expect(outOfOrder.ok).toBe(false)
      if (!outOfOrder.ok) expect(outOfOrder.errors[0].code).toBe("LOCK_SEQUENCE")

      for (const month of [1, 2, 3, 4]) {
        const locked = await lockPeriod(ORG_OPS, { fiscalYearId, month, reason: "cierre mensual" }, actor)
        expect(locked.ok, `mes ${month}`).toBe(true)
      }

      // El motor rechaza la fecha bloqueada…
      const draft = await simpleDraft("2026-04-15")
      expect(draft.ok).toBe(false)
      if (!draft.ok) expect(draft.errors.map((e) => e.code)).toContain("MONTH_LOCKED")

      // …y el trigger `journal_entries_period_open` también, sin pasar por él (B-5).
      const forced = await postEntry(
        ORG_OPS,
        {
          organizationId: ORG_OPS,
          fiscalYearId,
          entryDate: "2026-04-15",
          documentDate: "2026-04-15",
          accrualDate: null,
          description: "Forzado en mes bloqueado",
          kind: "NORMAL",
          sourceType: "MANUAL",
          taxRoundingMode: "PER_TIPO",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 1_000, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 1_000 },
          ],
        },
        actor,
        { skipCheck: true }
      )
      expect(forced.ok).toBe(false)
      if (!forced.ok) expect(forced.errors[0].code).toBe("MONTH_LOCKED")

      // B-3: desbloquear el 2 arrastra 3 y 4.
      const unlocked = await unlockPeriod(ORG_OPS, { fiscalYearId, month: 2, reason: "reapertura de marzo" }, actor)
      if (!unlocked.ok) throw new Error(JSON.stringify(unlocked.errors))
      expect(unlocked.value.unlocked).toEqual([2, 3, 4])
      expect(await tenantDb(ORG_OPS).periodLock.count({ where: { fiscalYearId } })).toBe(1)

      const logs = await tenantDb(ORG_OPS).auditLog.findMany({ where: { entity: "PeriodLock" } })
      expect(logs.some((l) => l.action === "lock")).toBe(true)
      expect(logs.some((l) => l.action === "unlock")).toBe(true)
    }, 120_000)

    it("criterio 4 · ejercicio CLOSED: no admite asientos, y no hay reapertura", async () => {
      const closed = await openFiscalYear(
        ORG_OPS,
        { code: "2025", startDate: "2025-01-01", endDate: "2025-12-31" },
        actor
      )
      if (!closed.ok) throw new Error(JSON.stringify(closed.errors))
      const result = await closeFiscalYear(ORG_OPS, closed.value.id, actor, "cierre del ejercicio de prueba")
      if (!result.ok) throw new Error(JSON.stringify(result.errors))
      expect(result.value.fiscalYear.status).toBe("CLOSED")
      expect(result.value.lockedMonths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

      const rejected = await postEntry(
        ORG_OPS,
        {
          organizationId: ORG_OPS,
          fiscalYearId: closed.value.id,
          entryDate: "2025-06-01",
          description: "En ejercicio cerrado",
          kind: "NORMAL",
          sourceType: "MANUAL",
          taxRoundingMode: "PER_TIPO",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 1_000, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 1_000 },
          ],
        },
        actor,
        { skipCheck: true }
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) expect(rejected.errors[0].code).toBe("FY_CLOSED")

      // Desbloquear un mes de un ejercicio cerrado tampoco: no hay reapertura.
      const reopen = await unlockPeriod(
        ORG_OPS,
        { fiscalYearId: closed.value.id, month: 12, reason: "quiero reabrir el ejercicio" },
        actor
      )
      expect(reopen.ok).toBe(false)
      if (!reopen.ok) expect(reopen.errors[0].code).toBe("FY_CLOSED")
    }, 120_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Criterio 14 · error inyectado por SQL (SPEC-FIABILIDAD C4)
  // ───────────────────────────────────────────────────────────────────────────

  it(
    "criterio 14 · una línea alterada por SQL: la corta el trigger y, con los triggers caídos, la delatan I1 e I-E3-7",
    async () => {
      const before = await runLedgerInvariants(ORG_MIN, { refDate: "2026-12-31" })
      expect(before.validacion.checks.filter((c) => c.status === "FAIL")).toEqual([])
      expect(before.sello.sello).toBe("VALIDADO AUTOMÁTICAMENTE")
      const hashBefore = await tenantTransaction(ORG_MIN, USER, async (tx) => computeLedgerHash(tx))

      const lineId = await owner(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.organization_id = $1::uuid AND e.entry_number = 2 AND l.debit_cents > 0 LIMIT 1`,
          [ORG_MIN]
        )
        return rows[0].id
      })

      // (a) Con los triggers puestos, la BD lo rechaza aunque el UPDATE venga
      //     del propietario por SQL directo.
      await expect(
        owner(async (client) => {
          // El `FORCE` se levanta FUERA de la transacción del UPDATE: no se
          // puede hacer `ALTER TABLE` con eventos de trigger diferidos vivos.
          await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
          try {
            await client.query("BEGIN")
            await client.query(`UPDATE journal_lines SET debit_cents = debit_cents + 100 WHERE id = $1::uuid`, [lineId])
            await client.query("COMMIT")
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {})
            throw error
          } finally {
            await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
          }
        })
      ).rejects.toThrow(/descuadrado|23514/)

      // (b) Con los triggers caídos, la corrupción entra… y la detecta la Capa 1.
      try {
        await owner(async (client) => {
          await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
          await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER ALL`)
          await client.query(`UPDATE journal_lines SET debit_cents = debit_cents + 100 WHERE id = $1::uuid`, [lineId])
          await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER ALL`)
          await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
        })

        const after = await runLedgerInvariants(ORG_MIN, { refDate: "2026-12-31" })
        const failed = after.validacion.checks.filter((c) => c.status === "FAIL").map((c) => c.id)
        expect(failed).toContain("I1")
        expect(failed).toContain("I-E3-7")
        expect(after.sello.sello).toBe("REQUIERE REVISIÓN")
        expect(after.sello.motivos.join(" ")).toMatch(/I1/)

        const hashAfter = await tenantTransaction(ORG_MIN, USER, async (tx) => computeLedgerHash(tx))
        expect(hashAfter).not.toBe(hashBefore)
      } finally {
        // Se deshace la inyección para no contaminar al resto de la suite.
        await owner(async (client) => {
          await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
          await client.query(`ALTER TABLE journal_lines DISABLE TRIGGER ALL`)
          await client.query(`UPDATE journal_lines SET debit_cents = debit_cents - 100 WHERE id = $1::uuid`, [lineId])
          await client.query(`ALTER TABLE journal_lines ENABLE TRIGGER ALL`)
          await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
        })
      }

      const restored = await runLedgerInvariants(ORG_MIN, { refDate: "2026-12-31" })
      expect(restored.validacion.checks.filter((c) => c.status === "FAIL")).toEqual([])
    },
    180_000
  )

  // ───────────────────────────────────────────────────────────────────────────
  // I10 · fuga entre organizaciones en las cuatro tablas nuevas
  // ───────────────────────────────────────────────────────────────────────────

  it("I10 · ninguna de las cuatro tablas del diario deja ver datos de otra organización", async () => {
    const other = tenantDb(ORG_OTHER)
    expect(await other.fiscalYear.count()).toBe(0)
    expect(await other.periodLock.count()).toBe(0)
    expect(await other.journalEntry.count()).toBe(0)
    expect(await other.journalLine.count()).toBe(0)

    // Un id conocido de otra organización tampoco se lee por findUnique.
    const foreign = await tenantDb(ORG_MIN).journalEntry.findFirstOrThrow({})
    expect(await other.journalEntry.findUnique({ where: { id: foreign.id } })).toBeNull()
    expect(await tenantDb(ORG_MIN).journalEntry.count()).toBe(5)

    // El plan de ORG_MIN no es visible desde ORG_OTHER.
    expect(await other.ledgerAccount.count()).toBe(0)
  }, 60_000)
})
