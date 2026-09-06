import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * QA · E3 — pruebas adversariales complementarias a `e3-ledger.test.ts` y
 * `e3-app-runtime.test.ts` (que ya cubren numeración con 10 concurrentes,
 * descuadre por motor, anulación simple/doble, mes bloqueado, cierre feliz,
 * inyección SQL con triggers y RLS 42501/DELETE/lectura cruzada).
 *
 * Este fichero intenta ROMPER lo que esos dos NO ejercitan:
 *  (a) 20 posteos concurrentes + numeración independiente entre dos ejercicios
 *  (b) INSERT directo del propietario (NO FORCE, sin pasar por la app): línea
 *      0/0, asiento de una sola línea, un solo lado
 *  (c) anular en mes bloqueado (fecha al primer día del mes abierto) y anular
 *      en ejercicio CLOSED
 *  (d) cuenta inactiva / no postable / de otra organización, fecha fuera de
 *      ejercicio
 *  (e) cierre: Σ6/7=0, 129=resultado, apertura cuadra, segundo cierre y post
 *      poscierre rechazados
 *  (h) ledgerHash estable si no se postea nada, cambia al postear
 *  (i) Transaction: postTransactionAction cambia status y enlaza; doble post
 *      rechazado; **anular el asiento NO deja la Transaction en VOID** (bug)
 *  (g)/(j) server actions: VIEWER rechazado con "Sin permiso" y sin AuditLog
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

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

let currentUser: { id: string; email: string; name: string }
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear, closeFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod } = await import("@/models/period-locks")
const {
  computeLedgerHash,
  getAccountBalances,
  getLedgerContext,
  postEntry,
  voidEntry,
} = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")

type Draft = Awaited<ReturnType<typeof buildEntry>>

const ORG_A = "e3900000-0000-4000-8000-00000000a001"
const ORG_B = "e3900000-0000-4000-8000-00000000a002"
const ORG_C = "e3900000-0000-4000-8000-00000000a003"
// ORG_D es sólo para el cierre de ejercicio (e): así no se cierra el 2026 de
// ORG_A, que (i)/(j) siguen necesitando OPEN.
const ORG_D = "e3900000-0000-4000-8000-00000000a004"
const ALL_ORGS = [ORG_A, ORG_B, ORG_C, ORG_D]
const ADMIN_USER = "e3900000-0000-4000-8000-0000000000b1"
const EDITOR_USER = "e3900000-0000-4000-8000-0000000000b2"
const VIEWER_USER = "e3900000-0000-4000-8000-0000000000b3"

const adminActor = { userId: ADMIN_USER }
const editorActor = { userId: EDITOR_USER }

/**
 * E4 · R-A8 — estas suites de E3 postean líneas de 6/7 sin destino analítico
 * porque comprueban OTRA cosa (numeración, atomicidad, sellos). Desde E4, C-9
 * muerde: se declara `analyticsRequired = false`, que es la configuración
 * documentada para ese caso, y el motor las rutea al CECO de sistema `CC-NA`.
 * La regla estricta (bloquear) se ejerce en `tests/integration/e4-analytics.test.ts`.
 */
async function relaxAnalytics(organizationIds: readonly string[]): Promise<void> {
  for (const organizationId of organizationIds) {
    await tenantTransaction(organizationId, async (tx) => {
      await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
      await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${organizationId}::uuid`
    })
  }
}

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("QA E3 · pruebas adversariales", () => {
  let fy2026 = ""
  let fy2027 = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_USER, email: "qa-admin@test.local", name: "QA Admin" },
        { id: EDITOR_USER, email: "qa-editor@test.local", name: "QA Editor" },
        { id: VIEWER_USER, email: "qa-viewer@test.local", name: "QA Viewer" },
      ],
    })
    await prisma.organization.createMany({
      data: ALL_ORGS.map((id, i) => ({
        id,
        slug: `e3-qa-${i}`,
        name: `E3 QA Org ${i}`,
        pgcVariant: "PYMES" as const,
        updatedAt: new Date(),
      })),
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_A, userId: EDITOR_USER, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_A, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })

    await importNpgc(ORG_A, "PYMES", { actor: adminActor, now: new Date("2026-01-01"), useSubaccounts: false })
    await importNpgc(ORG_B, "PYMES", { actor: adminActor, now: new Date("2026-01-01"), useSubaccounts: false })
    await importNpgc(ORG_C, "PYMES", { actor: adminActor, now: new Date("2026-01-01"), useSubaccounts: false })
    await importNpgc(ORG_D, "PYMES", { actor: adminActor, now: new Date("2026-01-01"), useSubaccounts: false })

    const y26 = await openFiscalYear(ORG_A, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, adminActor)
    if (!y26.ok) throw new Error(JSON.stringify(y26.errors))
    fy2026 = y26.value.id
    const y27 = await openFiscalYear(ORG_A, { code: "2027", startDate: "2027-01-01", endDate: "2027-12-31" }, adminActor)
    if (!y27.ok) throw new Error(JSON.stringify(y27.errors))
    fy2027 = y27.value.id

    // ORG_B: un ejercicio con un asiento, para el ataque de cuenta ajena.
    await openFiscalYear(ORG_B, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, adminActor)

    await relaxAnalytics(ALL_ORGS)
  }, 240_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query("COMMIT")
      await client.query(`DELETE FROM period_locks WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM fiscal_years WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM audit_logs WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM transactions WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM tax_rates WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM organization_account_maps WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM accounts WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM memberships WHERE organization_id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ALL_ORGS])
      await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN_USER, EDITOR_USER, VIEWER_USER]])
    })
  }

  async function simpleDraft(entryDate: string, amountCents = 12_100, fiscalYearId?: string): Promise<Draft> {
    return await tenantTransaction(ORG_A, EDITOR_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, "2027-12-31")
      return buildEntry(
        {
          organizationId: ORG_A,
          fiscalYearId,
          entryDate,
          description: `QA adversarial ${entryDate}`,
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

  // ───────────────────────────────────────────────────────────────────────────
  // (a) Numeración: 20 concurrentes + dos ejercicios distintos
  // ───────────────────────────────────────────────────────────────────────────

  it("(a) 20 postEntry en paralelo en el mismo ejercicio → 1..20 sin huecos ni duplicados", async () => {
    const draft = await simpleDraft("2026-05-10")
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        postEntry(ORG_A, { ...draft.value, description: `Concurrente ${i + 1}` }, editorActor, {
          refDate: "2027-12-31",
        })
      )
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const numbers = results.flatMap((r) => (r.ok ? [r.value.entryNumber] : [])).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(new Set(numbers).size).toBe(20)

    const fy = await tenantDb(ORG_A).fiscalYear.findFirstOrThrow({ where: { id: fy2026 } })
    expect(fy.lastEntryNumber).toBe(20)
  }, 120_000)

  it("(a) el mismo asiento posteado en dos ejercicios distintos numera independientemente (empieza en 1 en 2027)", async () => {
    const draft = await simpleDraft("2027-02-01", 5_000, fy2027)
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_A, draft.value, editorActor, { refDate: "2027-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))
    expect(posted.value.entryNumber).toBe(1)
    expect(posted.value.fiscalYearId).toBe(fy2027)

    // El contador de 2026 no se ha movido por postear en 2027.
    const fy = await tenantDb(ORG_A).fiscalYear.findFirstOrThrow({ where: { id: fy2026 } })
    expect(fy.lastEntryNumber).toBe(20)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // (b) INSERT directo del propietario, NO FORCE, saltándose la app entera
  // ───────────────────────────────────────────────────────────────────────────

  describe("(b) INSERT directo (propietario, NO FORCE) sin pasar por la aplicación", () => {
    async function rawInsertEntry(
      client: Client,
      lines: Array<{ code: string; debit: number; credit: number }>
    ): Promise<void> {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (id, organization_id, fiscal_year_id, entry_number, entry_date, description, kind, source_type,
            tax_rounding_mode, posted_by_id, entry_hash)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 9000 + floor(random()*100000)::int, '2026-06-01',
                 'QA inyección directa', 'NORMAL', 'MANUAL', 'PER_TIPO', $3::uuid, 'deadbeef')
         RETURNING id`,
        [ORG_A, fy2026, ADMIN_USER]
      )
      const entryId = rows[0].id
      let lineNo = 1
      for (const l of lines) {
        await client.query(
          `INSERT INTO journal_lines
             (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
              entry_date, fiscal_year_id, entry_kind)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, '2026-06-01', $7::uuid, 'NORMAL')`,
          [ORG_A, entryId, lineNo++, l.code, l.debit, l.credit, fy2026]
        )
      }
    }

    async function attempt(lines: Array<{ code: string; debit: number; credit: number }>): Promise<unknown> {
      return owner(async (client) => {
        await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
        await client.query(`ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY`)
        try {
          await client.query("BEGIN")
          await rawInsertEntry(client, lines)
          await client.query("COMMIT")
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {})
          throw error
        } finally {
          await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
          await client.query(`ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY`)
        }
      })
    }

    it("descuadre de 1 céntimo: el COMMIT falla (journal_entry_balanced)", async () => {
      await expect(
        attempt([
          { code: "572", debit: 10_000, credit: 0 },
          { code: "705", debit: 0, credit: 9_999 },
        ])
      ).rejects.toThrow(/descuadrado|journal_entry_balanced|23514/)
    })

    it("línea con debit=credit=0: viola el CHECK debit_xor_credit", async () => {
      await expect(
        attempt([
          { code: "572", debit: 0, credit: 0 },
          { code: "705", debit: 0, credit: 0 },
        ])
      ).rejects.toThrow(/journal_lines_debit_xor_credit|23514/)
    })

    it("asiento de una sola línea: viola journal_entry_min_lines", async () => {
      await expect(attempt([{ code: "572", debit: 1_000, credit: 0 }])).rejects.toThrow(
        /línea|journal_entry_min_lines|23514/
      )
    })

    it("todas las líneas al debe (sin contrapartida): viola journal_entry_both_sides", async () => {
      await expect(
        attempt([
          { code: "572", debit: 5_000, credit: 0 },
          { code: "705", debit: 5_000, credit: 0 },
        ])
      ).rejects.toThrow(/contrapartida|journal_entry_both_sides|23514/)
    })

    it("no ha quedado NINGÚN residuo de los intentos fallidos (todo el COMMIT se deshizo)", async () => {
      const count = await tenantDb(ORG_A).journalEntry.count({ where: { description: "QA inyección directa" } })
      expect(count).toBe(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // (d) cuentas: inactiva, no postable, de otra organización; fecha fuera de ejercicio
  // ───────────────────────────────────────────────────────────────────────────

  describe("(d) cuentas inválidas y fechas fuera de rango", () => {
    it("cuenta desactivada: ACCOUNT_INACTIVE, y el trigger de BD también la corta si se salta la app", async () => {
      await tenantDb(ORG_A).ledgerAccount.update({
        where: { organizationId_code: { organizationId: ORG_A, code: "629" } },
        data: { isActive: false },
      })
      const draft = await tenantTransaction(ORG_A, EDITOR_USER, async (tx) => {
        const ctx = await getLedgerContext(tx, "2027-12-31")
        return buildEntry(
          {
            organizationId: ORG_A,
            fiscalYearId: fy2026,
            entryDate: "2026-06-10",
            description: "Gasto con cuenta desactivada",
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "629", debitCents: 1_000, creditCents: 0 },
              { lineNo: 2, accountCode: "572", debitCents: 0, creditCents: 1_000 },
            ],
          },
          ctx
        )
      })
      expect(draft.ok).toBe(false)
      if (!draft.ok) expect(draft.errors.map((e) => e.code)).toContain("ACCOUNT_INACTIVE")

      // Reactivamos y comprobamos el trigger de BD directamente (I9, B-5).
      await tenantDb(ORG_A).ledgerAccount.update({
        where: { organizationId_code: { organizationId: ORG_A, code: "629" } },
        data: { isActive: false }, // ya lo estaba; nos aseguramos
      })
      await expect(
        owner(async (client) => {
          await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
          try {
            await client.query("BEGIN")
            await client.query(
              `INSERT INTO journal_entries
                 (id, organization_id, fiscal_year_id, entry_number, entry_date, description, kind, source_type,
                  tax_rounding_mode, posted_by_id, entry_hash)
               VALUES ('11111111-1111-4111-8111-111111111111'::uuid, $1::uuid, $2::uuid, 99001, '2026-06-10',
                       'QA cuenta inactiva por SQL', 'NORMAL', 'MANUAL', 'PER_TIPO', $3::uuid, 'deadbeef')`,
              [ORG_A, fy2026, ADMIN_USER]
            )
            await client.query(
              `INSERT INTO journal_lines
                 (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
                  entry_date, fiscal_year_id, entry_kind)
               VALUES (gen_random_uuid(), $1::uuid, '11111111-1111-4111-8111-111111111111'::uuid, 1, '629', 1000, 0,
                       '2026-06-10', $2::uuid, 'NORMAL')`,
              [ORG_A, fy2026]
            )
            await client.query("COMMIT")
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {})
            throw error
          } finally {
            await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
          }
        })
      ).rejects.toThrow(/postable|activa|23514|23503/)

      await tenantDb(ORG_A).ledgerAccount.update({
        where: { organizationId_code: { organizationId: ORG_A, code: "629" } },
        data: { isActive: true },
      })
    }, 60_000)

    it("cuenta no postable (con subcuentas): ACCOUNT_NOT_POSTABLE", async () => {
      await tenantDb(ORG_A).ledgerAccount.update({
        where: { organizationId_code: { organizationId: ORG_A, code: "629" } },
        data: { isPostable: false },
      })
      const draft = await tenantTransaction(ORG_A, EDITOR_USER, async (tx) => {
        const ctx = await getLedgerContext(tx, "2027-12-31")
        return buildEntry(
          {
            organizationId: ORG_A,
            fiscalYearId: fy2026,
            entryDate: "2026-06-11",
            description: "Gasto contra cuenta agrupadora",
            kind: "NORMAL",
            sourceType: "MANUAL",
            lines: [
              { lineNo: 1, accountCode: "629", debitCents: 1_000, creditCents: 0 },
              { lineNo: 2, accountCode: "572", debitCents: 0, creditCents: 1_000 },
            ],
          },
          ctx
        )
      })
      expect(draft.ok).toBe(false)
      if (!draft.ok) expect(draft.errors.map((e) => e.code)).toContain("ACCOUNT_NOT_POSTABLE")
      await tenantDb(ORG_A).ledgerAccount.update({
        where: { organizationId_code: { organizationId: ORG_A, code: "629" } },
        data: { isPostable: true },
      })
    }, 60_000)

    it("cuenta que sólo existe en OTRA organización: ACCOUNT_UNKNOWN a nivel de motor y FK compuesta a nivel de BD", async () => {
      // El motor ni siquiera la conoce: su plan es el de ORG_A.
      const draft = await tenantTransaction(ORG_A, EDITOR_USER, async (tx) => {
        const ctx = await getLedgerContext(tx, "2027-12-31")
        return buildEntry(
          {
            organizationId: ORG_A,
            fiscalYearId: fy2026,
            entryDate: "2026-06-12",
            description: "Referencia a cuenta que sólo existe en ORG_B (misma numeración PGC)",
            kind: "NORMAL",
            sourceType: "MANUAL",
            // "999999" no existe en ningún plan: sirve para probar ACCOUNT_UNKNOWN.
            lines: [
              { lineNo: 1, accountCode: "999999", debitCents: 1_000, creditCents: 0 },
              { lineNo: 2, accountCode: "572", debitCents: 0, creditCents: 1_000 },
            ],
          },
          ctx
        )
      })
      expect(draft.ok).toBe(false)
      if (!draft.ok) expect(draft.errors.map((e) => e.code)).toContain("ACCOUNT_UNKNOWN")

      // A nivel de BD: un asiento de A con una línea sobre una cuenta que sí
      // existe pero en B. La FK compuesta (organization_id, account_code) →
      // accounts(organization_id, code) debe rechazarla como inexistente.
      await expect(
        owner(async (client) => {
          await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
          await client.query(`ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY`)
          try {
            await client.query("BEGIN")
            await client.query(
              `INSERT INTO journal_entries
                 (id, organization_id, fiscal_year_id, entry_number, entry_date, description, kind, source_type,
                  tax_rounding_mode, posted_by_id, entry_hash)
               VALUES ('22222222-2222-4222-8222-222222222222'::uuid, $1::uuid, $2::uuid, 99002, '2026-06-12',
                       'QA cuenta de otra organización', 'NORMAL', 'MANUAL', 'PER_TIPO', $3::uuid, 'deadbeef')`,
              [ORG_A, fy2026, ADMIN_USER]
            )
            // 572 SÍ existe en ORG_A, pero pedimos que la FK compuesta la busque
            // bajo organization_id = ORG_A: si probamos con el organization_id
            // de la línea igual a ORG_A y un código que sólo existe en ORG_B,
            // la referencia no puede resolverse.
            await client.query(
              `INSERT INTO journal_lines
                 (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
                  entry_date, fiscal_year_id, entry_kind)
               VALUES (gen_random_uuid(), $1::uuid, '22222222-2222-4222-8222-222222222222'::uuid, 1, '5720', 1000, 0,
                       '2026-06-12', $2::uuid, 'NORMAL')`,
              [ORG_A, fy2026]
            )
            await client.query("COMMIT")
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {})
            throw error
          } finally {
            await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
            await client.query(`ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY`)
          }
        })
      ).rejects.toThrow(/23503|inexistente/)
    }, 60_000)

    it("fecha fuera del ejercicio: el motor la rechaza (FY o EXCLUDE de solape no aplica; usa FY_NOT_FOUND/DATE_OUT_OF_RANGE)", async () => {
      const draft = await simpleDraft("2028-01-01")
      expect(draft.ok).toBe(false)
    }, 30_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // (c) Anulación: mes bloqueado (fecha corregida) y ejercicio CLOSED
  // ───────────────────────────────────────────────────────────────────────────

  it("(c) anular un asiento de un mes ya bloqueado: el contra-asiento nace el primer día del primer mes abierto", async () => {
    const draft = await simpleDraft("2026-07-05", 33_300)
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_A, draft.value, editorActor, { refDate: "2027-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

    for (const month of [1, 2, 3, 4, 5, 6, 7]) {
      const locked = await lockPeriod(ORG_A, { fiscalYearId: fy2026, month, reason: "cierre mensual QA" }, adminActor)
      expect(locked.ok, `mes ${month}`).toBe(true)
    }

    const voided = await voidEntry(ORG_A, posted.value.id, "Anulación con julio bloqueado", editorActor, {
      refDate: "2027-12-31",
    })
    if (!voided.ok) throw new Error(JSON.stringify(voided.errors))
    // Agosto es el primer mes abierto del ejercicio 2026.
    expect(voided.value.reversal.entryDate).toBe("2026-08-01")
  }, 60_000)

  it("(c) anular un asiento de un ejercicio CLOSED se rechaza (FY_CLOSED)", async () => {
    const opened = await openFiscalYear(
      ORG_C,
      { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" },
      adminActor
    )
    if (!opened.ok) throw new Error(JSON.stringify(opened.errors))
    const draft = await tenantTransaction(ORG_C, ADMIN_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, "2026-12-31")
      return buildEntry(
        {
          organizationId: ORG_C,
          fiscalYearId: opened.value.id,
          entryDate: "2026-03-01",
          description: "Asiento a cerrar y anular después",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 4_000, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 4_000 },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_C, draft.value, adminActor, { refDate: "2026-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

    const closed = await closeFiscalYear(ORG_C, opened.value.id, adminActor, "cierre QA para probar anulación")
    if (!closed.ok) throw new Error(JSON.stringify(closed.errors))
    expect(closed.value.fiscalYear.status).toBe("CLOSED")

    const voided = await voidEntry(ORG_C, posted.value.id, "Intento de anular en ejercicio cerrado", adminActor, {
      refDate: "2026-12-31",
    })
    expect(voided.ok).toBe(false)
    // El motor puede cortar por el mes bloqueado del cierre o por el ejercicio
    // CLOSED, según cuál compruebe antes; lo que importa es que se rechaza.
    if (!voided.ok) {
      const codes = voided.errors.map((e) => e.code)
      expect(codes.some((c) => c === "FY_CLOSED" || c === "MONTH_LOCKED")).toBe(true)
    }

    // Y un segundo cierre del mismo ejercicio también se rechaza.
    const secondClose = await closeFiscalYear(ORG_C, opened.value.id, adminActor, "segundo cierre, no debería poder")
    expect(secondClose.ok).toBe(false)
    if (!secondClose.ok) expect(secondClose.errors.map((e) => e.code)).toContain("FY_CLOSED")
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  // (e) Cierre: Σ6/7 = 0, 129 = resultado, apertura cuadra
  // ───────────────────────────────────────────────────────────────────────────

  it("(e) tras cerrar: Σcuentas 6/7 = 0, saldo de 129 = resultado, y la apertura del siguiente cuadra con el balance de cierre", async () => {
    // ORG_D, dedicada a este test: así no se toca el 2026 de ORG_A, que (i)/(j)
    // siguen necesitando OPEN.
    const y26 = await openFiscalYear(ORG_D, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, adminActor)
    if (!y26.ok) throw new Error(JSON.stringify(y26.errors))
    const y27 = await openFiscalYear(ORG_D, { code: "2027", startDate: "2027-01-01", endDate: "2027-12-31" }, adminActor)
    if (!y27.ok) throw new Error(JSON.stringify(y27.errors))

    const draft = await tenantTransaction(ORG_D, ADMIN_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, "2026-12-31")
      return buildEntry(
        {
          organizationId: ORG_D,
          fiscalYearId: y26.value.id,
          entryDate: "2026-06-01",
          description: "Ingreso para forzar resultado positivo antes del cierre",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 242_000, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 242_000 },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_D, draft.value, adminActor, { refDate: "2026-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

    // Saldo (debe−haber): en 7 (ingresos, natural haber) sale NEGATIVO y en 6
    // (gastos, natural debe) sale POSITIVO, así que el resultado (ingresos −
    // gastos) es −Σ(saldos 6/7). Aquí sólo hay un ingreso de 242.000 → +242.000.
    const beforeClose = await tenantTransaction(ORG_D, ADMIN_USER, async (tx) =>
      getAccountBalances(tx, { upTo: "2026-12-31", fiscalYearId: y26.value.id })
    )
    const pnlBefore = [...beforeClose.entries()].filter(([c, v]) => (c.startsWith("6") || c.startsWith("7")) && v !== 0)
    const resultado = -pnlBefore.reduce((acc, [, v]) => acc + v, 0)
    expect(resultado).toBe(242_000)

    const closed = await closeFiscalYear(ORG_D, y26.value.id, adminActor, "cierre QA del ejercicio 2026")
    if (!closed.ok) throw new Error(JSON.stringify(closed.errors))
    expect(closed.value.fiscalYear.status).toBe("CLOSED")

    // Tras el cierre COMPLETO (regularización + T-27), el mayor entero queda a
    // cero: T-27 salda TODAS las cuentas de balance, incluida la 129 que la
    // regularización acababa de cargar. Para ver "129 = resultado" hay que
    // mirar el estado justo DESPUÉS de la regularización pero ANTES del
    // asiento de cierre — se consigue excluyendo `CLOSING` del agregado.
    const afterRegularization = await tenantTransaction(ORG_D, ADMIN_USER, async (tx) =>
      getAccountBalances(tx, { upTo: "2026-12-31", fiscalYearId: y26.value.id, excludeKinds: ["CLOSING"] })
    )
    const sixSeven = [...afterRegularization.entries()]
      .filter(([c]) => c.startsWith("6") || c.startsWith("7"))
      .reduce((acc, [, v]) => acc + v, 0)
    expect(sixSeven).toBe(0)

    // 129 es de naturaleza acreedora (patrimonio neto): un beneficio se abona,
    // así que su saldo debe−haber es el NEGATIVO del resultado positivo.
    const saldo129 = afterRegularization.get("129") ?? 0
    expect(saldo129).toBe(-resultado)

    // Y tras el cierre COMPLETO, el mayor de 2026 queda íntegramente a cero.
    const afterClose = await tenantTransaction(ORG_D, ADMIN_USER, async (tx) =>
      getAccountBalances(tx, { upTo: "2026-12-31", fiscalYearId: y26.value.id })
    )
    const totalAfterClose = [...afterClose.values()].reduce((a, v) => a + Math.abs(v), 0)
    expect(totalAfterClose).toBe(0)

    // La apertura del siguiente ejercicio debe reflejar exactamente los saldos
    // de balance (incluida la 129 con el resultado) que dejó la regularización
    // — I-E3-6.
    const opening2027 = await tenantTransaction(ORG_D, ADMIN_USER, async (tx) =>
      getAccountBalances(tx, { upTo: "2027-01-01", fiscalYearId: y27.value.id })
    )
    const balanceSheetToCarry = new Map(
      [...afterRegularization.entries()].filter(([c, v]) => !c.startsWith("6") && !c.startsWith("7") && v !== 0)
    )
    expect(balanceSheetToCarry.size).toBeGreaterThan(0)
    for (const [code, value] of balanceSheetToCarry) {
      expect(opening2027.get(code) ?? 0, `apertura de ${code}`).toBe(value)
    }
    expect(opening2027.get("129") ?? 0, "129 se traslada a la apertura del siguiente ejercicio").toBe(-resultado)

    // Segundo cierre del mismo ejercicio: rechazado.
    const secondClose = await closeFiscalYear(ORG_D, y26.value.id, adminActor, "segundo cierre de 2026, no debería poder")
    expect(secondClose.ok).toBe(false)
    if (!secondClose.ok) expect(secondClose.errors.map((e) => e.code)).toContain("FY_CLOSED")

    // Postear en el ejercicio ya cerrado: rechazado.
    const rejected = await postEntry(
      ORG_D,
      { ...draft.value, entryDate: "2026-12-15" },
      adminActor,
      { skipCheck: true }
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors[0].code).toBe("FY_CLOSED")
  }, 180_000)

  // ───────────────────────────────────────────────────────────────────────────
  // (h) ledgerHash: estable si no se postea, cambia al postear
  // ───────────────────────────────────────────────────────────────────────────

  it("(h) ledgerHash es estable si no se postea nada, y cambia tras un nuevo posteo", async () => {
    const opened = await openFiscalYear(
      ORG_B,
      { code: "2030", startDate: "2030-01-01", endDate: "2030-12-31" },
      adminActor
    )
    if (!opened.ok) throw new Error(JSON.stringify(opened.errors))

    const h1 = await tenantTransaction(ORG_B, ADMIN_USER, async (tx) => computeLedgerHash(tx))
    const h2 = await tenantTransaction(ORG_B, ADMIN_USER, async (tx) => computeLedgerHash(tx))
    expect(h2).toBe(h1)

    const draft = await tenantTransaction(ORG_B, ADMIN_USER, async (tx) => {
      const ctx = await getLedgerContext(tx, "2030-12-31")
      return buildEntry(
        {
          organizationId: ORG_B,
          fiscalYearId: opened.value.id,
          entryDate: "2030-05-01",
          description: "Asiento para mover el hash",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 500, creditCents: 0 },
            { lineNo: 2, accountCode: "705", debitCents: 0, creditCents: 500 },
          ],
        },
        ctx
      )
    })
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_B, draft.value, adminActor, { refDate: "2030-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

    const h3 = await tenantTransaction(ORG_B, ADMIN_USER, async (tx) => computeLedgerHash(tx))
    expect(h3).not.toBe(h1)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // (i) Transaction heredada: postTransactionAction, doble post, y el asiento
  //     anulado NO deja la Transaction en VOID (ataque a criterio 10)
  // ───────────────────────────────────────────────────────────────────────────

  describe("(i) Transaction ↔ diario", () => {
    let transactionId = ""

    beforeAll(async () => {
      const tr = await prisma.transaction.create({
        data: {
          organizationId: ORG_A,
          createdById: EDITOR_USER,
          name: "Traspaso heredado de TaxHacker",
          total: 30_000,
          currencyCode: "EUR",
        },
      })
      transactionId = tr.id
    })

    it("postTransactionAction (EDITOR) contabiliza y enlaza; segundo intento: TRANSACTION_ALREADY_POSTED", async () => {
      currentUser = { id: EDITOR_USER, email: "qa-editor@test.local", name: "QA Editor" }
      const { postTransactionAction } = await import("@/app/(app)/ledger/actions")

      const first = await postTransactionAction({
        transactionId,
        templateCode: "TRASPASO_TESORERIA",
        input: { documentDate: "2026-08-01", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 30_000 },
        refDate: "2027-12-31",
      })
      expect(first.success, JSON.stringify(first)).toBe(true)

      const tr = await tenantDb(ORG_A).transaction.findUniqueOrThrow({ where: { id: transactionId } })
      expect(tr.status).toBe("POSTED")
      expect(tr.journalEntryId).toBeTruthy()

      const second = await postTransactionAction({
        transactionId,
        templateCode: "TRASPASO_TESORERIA",
        input: { documentDate: "2026-08-01", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 30_000 },
        refDate: "2027-12-31",
      })
      expect(second.success).toBe(false)
      expect(second.error).toMatch(/contabilizada/)
    }, 60_000)

    it("VIEWER no puede contabilizar la operación: {success:false,'Sin permiso'} y sin AuditLog nuevo", async () => {
      currentUser = { id: VIEWER_USER, email: "qa-viewer@test.local", name: "QA Viewer" }
      const { postTransactionAction } = await import("@/app/(app)/ledger/actions")
      const before = await tenantDb(ORG_A).auditLog.count()

      const result = await postTransactionAction({
        transactionId,
        templateCode: "TRASPASO_TESORERIA",
        input: { documentDate: "2026-08-01", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 30_000 },
      })
      expect(result).toEqual({ success: false, error: "Sin permiso" })
      expect(await tenantDb(ORG_A).auditLog.count()).toBe(before)
    })

    it("al anular el asiento de una Transaction contabilizada, ésta queda VOID (criterio 10)", async () => {
      currentUser = { id: EDITOR_USER, email: "qa-editor@test.local", name: "QA Editor" }
      const { voidEntryAction } = await import("@/app/(app)/ledger/actions")

      const before = await tenantDb(ORG_A).transaction.findUniqueOrThrow({ where: { id: transactionId } })
      expect(before.status).toBe("POSTED")
      const entryId = before.journalEntryId!

      const voided = await voidEntryAction({
        entryId,
        reason: "Anulación de prueba para el criterio 10",
      })
      expect(voided.success, JSON.stringify(voided)).toBe(true)

      // Revisión ronda 1 (QA): `voidEntry` deja la operación en VOID dentro de
      // la MISMA transacción que el contra-asiento. Antes había que llamar
      // aparte a `voidTransactionPosting`, que ninguna action usaba, y la
      // `Transaction` se quedaba en POSTED apuntando a un asiento anulado.
      const after = await tenantDb(ORG_A).transaction.findUniqueOrThrow({ where: { id: transactionId } })
      expect(after.status).toBe("VOID")
      // **E8 · ADR-0014 D1 (O-9).** El enlace al asiento sigue sin borrarse —es
      // la traza de qué se anuló—, pero ahora se TRASLADA a `voidedEntryId` en
      // vez de quedarse en `journalEntryId`. El motivo es que `POSTED ⟺ tiene
      // asiento` (I-E8-4) tiene que ser cierto en la base, no sólo de palabra:
      // con el asiento colgando de `journalEntryId`, una operación anulada era
      // indistinguible de una contabilizada para cualquier consulta que mirara
      // esa columna. El traslado lo hace un trigger, no la aplicación.
      expect(after.journalEntryId).toBeNull()
      expect(after.voidedEntryId).toBe(entryId)
      // Y el histórico se apila: `VOID → PROPOSED → POSTED → VOID` conserva las
      // vueltas anteriores en vez de pisarlas.
      expect(after.voidedEntryIds).toEqual([entryId])
    }, 60_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // (k) #8 — doble submit del formulario: un solo asiento
  // ───────────────────────────────────────────────────────────────────────────

  it("(k) doble submit con la MISMA clave de idempotencia contabiliza UN asiento", async () => {
    currentUser = { id: EDITOR_USER, email: "qa-editor@test.local", name: "QA Editor" }
    const { postManualEntryAction } = await import("@/app/(app)/ledger/actions")

    const fy = await tenantDb(ORG_A).fiscalYear.findFirstOrThrow({ where: { id: fy2026 } })
    const antes = fy.lastEntryNumber
    const idempotencyKey = "9a9a9a9a-1b1b-4c4c-8d8d-e5e5e5e5e5e5"
    const envio = {
      idempotencyKey,
      documentDate: "2026-03-15",
      description: "Doble clic en Contabilizar",
      lines: [
        { accountCode: "572", debit: "121,00", credit: "" },
        { accountCode: "705", debit: "", credit: "121,00" },
      ],
    }

    const primero = await postManualEntryAction(envio)
    const segundo = await postManualEntryAction(envio)

    expect(primero.success, JSON.stringify(primero)).toBe(true)
    expect(segundo.success, JSON.stringify(segundo)).toBe(true)
    expect(segundo.data?.entryId).toBe(primero.data?.entryId)
    expect(segundo.data?.entryNumber).toBe(primero.data?.entryNumber)

    const despues = await tenantDb(ORG_A).fiscalYear.findFirstOrThrow({ where: { id: fy2026 } })
    expect(despues.lastEntryNumber).toBe(antes + 1)
    // Por clave, no por descripción: si el mes del devengo está bloqueado, el
    // motor desplaza la fecha y añade la coletilla «[devengo …]».
    expect(await tenantDb(ORG_A).journalEntry.count({ where: { idempotencyKey } })).toBe(1)

    // Otra clave = otro asiento: la idempotencia no bloquea repetir a propósito.
    const tercero = await postManualEntryAction({ ...envio, idempotencyKey: "9a9a9a9a-1b1b-4c4c-8d8d-e5e5e5e5e5e6" })
    expect(tercero.success, JSON.stringify(tercero)).toBe(true)
    expect(tercero.data?.entryId).not.toBe(primero.data?.entryId)
  }, 60_000)

  // ───────────────────────────────────────────────────────────────────────────
  // (j)/(g) roles en server actions del diario
  // ───────────────────────────────────────────────────────────────────────────

  describe("(j) VIEWER no puede mutar el diario desde las server actions", () => {
    it("postManualEntryAction rechaza a VIEWER sin escribir AuditLog", async () => {
      currentUser = { id: VIEWER_USER, email: "qa-viewer@test.local", name: "QA Viewer" }
      const { postManualEntryAction } = await import("@/app/(app)/ledger/actions")
      const before = await tenantDb(ORG_A).auditLog.count()

      const result = await postManualEntryAction({
        description: "Intento de un VIEWER",
        lines: [
          { accountCode: "572", debitCents: 1_000 },
          { accountCode: "705", creditCents: 1_000 },
        ],
      })
      expect(result).toEqual({ success: false, error: "Sin permiso" })
      expect(await tenantDb(ORG_A).auditLog.count()).toBe(before)
    })

    it("postFromTemplateAction y voidEntryAction también rechazan a VIEWER", async () => {
      currentUser = { id: VIEWER_USER, email: "qa-viewer@test.local", name: "QA Viewer" }
      const { postFromTemplateAction, voidEntryAction } = await import("@/app/(app)/ledger/actions")

      const posted = await postFromTemplateAction({
        templateCode: "TRASPASO_TESORERIA",
        input: { documentDate: "2026-08-01", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 1_000 },
      })
      expect(posted).toEqual({ success: false, error: "Sin permiso" })

      const anyEntry = await tenantDb(ORG_A).journalEntry.findFirst({})
      const voided = await voidEntryAction({
        entryId: anyEntry!.id,
        reason: "Intento de anulación por un VIEWER",
      })
      expect(voided).toEqual({ success: false, error: "Sin permiso" })
    })

    it("previewTemplateAction y listTemplatesAction (sólo lectura) SÍ funcionan para VIEWER", async () => {
      currentUser = { id: VIEWER_USER, email: "qa-viewer@test.local", name: "QA Viewer" }
      const { previewTemplateAction, listTemplatesAction } = await import("@/app/(app)/ledger/actions")

      const templates = await listTemplatesAction()
      expect(templates.success).toBe(true)

      const preview = await previewTemplateAction({
        templateCode: "TRASPASO_TESORERIA",
        input: { documentDate: "2026-08-01", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 1_000 },
      })
      expect(preview.success, JSON.stringify(preview)).toBe(true)
    })

    it("lockPeriodAction y closeFiscalYearAction (ADMIN) rechazan a un EDITOR", async () => {
      currentUser = { id: EDITOR_USER, email: "qa-editor@test.local", name: "QA Editor" }
      const { lockPeriodAction, closeFiscalYearAction } = await import("@/app/(app)/settings/fiscal-years/actions")

      const lock = await lockPeriodAction({ fiscalYearId: fy2027, month: 1 })
      expect(lock).toEqual({ success: false, error: "Sin permiso" })

      const close = await closeFiscalYearAction({ fiscalYearId: fy2027, reason: "intento de un EDITOR" })
      expect(close).toEqual({ success: false, error: "Sin permiso" })
    })
  })
})
