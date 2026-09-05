import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E3 · T14 — El libro diario ejecutado como `app_runtime` (LOGIN, NOBYPASSRLS,
 * no propietario), que es con el rol que conecta la aplicación (ADR-0009).
 *
 * Aquí no hay red: si una política de las cuatro tablas nuevas está mal escrita,
 * `postEntry` no ve el ejercicio y el test se cae. Cubre los criterios 16 y 17
 * del diseño para E3 y los privilegios de columna de §2.4-7:
 *
 *  - `postEntry` / `voidEntry` / `closeFiscalYear` funcionan bajo RLS estricta.
 *  - `app_runtime` **no puede** `UPDATE journal_lines.debit_cents` (42501), ni
 *    `UPDATE` ninguna otra columna del asiento salvo las tres de anulación.
 *  - Sin `app.current_org`, las cuatro tablas devuelven 0 filas.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const ORG_A = "e3c00000-0000-4000-8000-00000000000a"
const ORG_B = "e3c00000-0000-4000-8000-00000000000b"
const USER_A = "e3c00000-0000-4000-8000-0000000000a1"
const ORGS = [ORG_A, ORG_B]

const actor = { userId: USER_A }
/** #4: sin git-sha el sello es REQUIERE REVISIÓN por definición. */
const GIT_SHA = "c0e828f0000000000000000000000000000000ab"

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Conexión CRUDA como app_runtime, para ejercer las políticas sin `tenantDb`. */
async function asRuntime<T>(organizationId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.current_org', $1, true)", [organizationId ?? ""])
    await client.query("SELECT set_config('app.current_user', $1, true)", [USER_A])
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    await client.end()
  }
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { closeFiscalYear, openFiscalYear } = await import("@/models/fiscal-years")
const { lockPeriod } = await import("@/models/period-locks")
const { getEntries, getLedgerContext, postEntry, runLedgerInvariants, voidEntry } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { seedAnalyticsDefaults } = await import("@/models/analytics")

describe.skipIf(!OWNER_URL)("E3 · diario, ejercicios y bloqueos como app_runtime", () => {
  let fiscalYearId = ""
  let firstEntryId = ""

  beforeAll(async () => {
    await cleanup()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES ($1, 'e3-rls@test.local', 'E3 RLS', now())`,
        [USER_A]
      )
      await client.query(
        `INSERT INTO "organizations" (id, slug, name, pgc_variant, updated_at) VALUES
           ($1,'e3-rls-a','E3 RLS A','PYMES', now()),
           ($2,'e3-rls-b','E3 RLS B','PYMES', now())`,
        ORGS
      )
      await client.query(
        `INSERT INTO "memberships" (id, organization_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'ADMIN', now())`,
        [ORG_A, USER_A]
      )
    })
    await importNpgc(ORG_A, "PYMES", { actor, now: new Date("2026-01-01"), useSubaccounts: false })
    await importNpgc(ORG_B, "PYMES", { actor: { userId: null }, now: new Date("2026-01-01"), useSubaccounts: false })

    // E4 · R-A8: esta suite comprueba RLS y privilegios de columna, no C-9. Se
    // siembra la analítica y se relaja `analyticsRequired`, de modo que las
    // líneas 6/7 sin destino se ruteen al CECO de sistema `CC-NA` en vez de
    // bloquear el asiento. La siembra corre YA como `app_runtime`: es, de paso,
    // la prueba de que las tres tablas nuevas pasan sus políticas.
    for (const organizationId of ORGS) {
      await tenantTransaction(organizationId, async (tx) => {
        await seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: null })
        await tx.$executeRaw`UPDATE organizations SET analytics_required = false WHERE id = ${organizationId}::uuid`
      })
    }
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      await client.query(`DELETE FROM journal_lines WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM journal_entries WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query("COMMIT")
      await client.query(`DELETE FROM period_locks WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM fiscal_years WHERE organization_id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ORGS])
      await client.query(`DELETE FROM users WHERE id = $1`, [USER_A])
    })
  }

  async function draftFor(organizationId: string, entryDate: string, amountCents = 30_000) {
    return await tenantTransaction(organizationId, USER_A, async (tx) => {
      const ctx = await getLedgerContext(tx, "2026-12-31")
      return buildEntry(
        {
          organizationId,
          entryDate,
          description: `Venta de prueba ${entryDate}`,
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

  it("criterio 17 · openFiscalYear + postEntry funcionan bajo RLS estricta", async () => {
    const fy = await openFiscalYear(ORG_A, { code: "2026", startDate: "2026-01-01", endDate: "2026-12-31" }, actor)
    if (!fy.ok) throw new Error(JSON.stringify(fy.errors))
    fiscalYearId = fy.value.id

    const draft = await draftFor(ORG_A, "2026-02-10")
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_A, draft.value, actor, { refDate: "2026-12-31" })
    if (!posted.ok) throw new Error(JSON.stringify(posted.errors))

    expect(posted.value.entryNumber).toBe(1)
    expect(posted.value.entryHash).toHaveLength(64)
    firstEntryId = posted.value.id

    // El AuditLog se escribió en la misma transacción, y bajo la misma política.
    expect(await tenantDb(ORG_A).auditLog.count({ where: { entity: "JournalEntry", action: "post" } })).toBe(1)
  }, 60_000)

  it("criterio 17 · voidEntry: el contra-asiento y las tres columnas de anulación pasan la política", async () => {
    const voided = await voidEntry(ORG_A, firstEntryId, "Duplicado del proveedor, se anula", actor, {
      refDate: "2026-12-31",
    })
    if (!voided.ok) throw new Error(JSON.stringify(voided.errors))

    expect(voided.value.reversal.kind).toBe("REVERSAL")
    expect(voided.value.reversal.entryNumber).toBe(2)
    expect(voided.value.voided.voidedAt).toBeTruthy()
  }, 60_000)

  it("§2.4-7 · app_runtime no puede tocar los importes: UPDATE de debit_cents da 42501", async () => {
    const lineId = await owner(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM journal_lines WHERE organization_id = $1::uuid LIMIT 1`,
        [ORG_A]
      )
      return rows[0].id
    })

    // Falta el privilegio de columna: es un 42501, no un «0 filas afectadas».
    await expect(
      asRuntime(ORG_A, (client) =>
        client.query(`UPDATE journal_lines SET debit_cents = debit_cents + 1 WHERE id = $1::uuid`, [lineId])
      )
    ).rejects.toMatchObject({ code: "42501" })

    // Tampoco la descripción del asiento: sólo voided_at/voided_by_id/void_reason.
    await expect(
      asRuntime(ORG_A, (client) =>
        client.query(`UPDATE journal_entries SET description = 'editado' WHERE organization_id = $1::uuid`, [ORG_A])
      )
    ).rejects.toMatchObject({ code: "42501" })

    // Y nada se borra del diario (política RESTRICTIVE + falta de privilegio).
    await expect(
      asRuntime(ORG_A, (client) => client.query(`DELETE FROM journal_lines WHERE id = $1::uuid`, [lineId]))
    ).rejects.toMatchObject({ code: "42501" })
  }, 60_000)

  it("criterio 16 · sin app.current_org, las cuatro tablas del diario devuelven 0 filas", async () => {
    const counts = await asRuntime(null, async (client) => {
      const out: Record<string, number> = {}
      for (const table of ["fiscal_years", "period_locks", "journal_entries", "journal_lines"]) {
        const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
        out[table] = Number(rows[0].n)
      }
      return out
    })
    expect(counts).toEqual({ fiscal_years: 0, period_locks: 0, journal_entries: 0, journal_lines: 0 })

    // Con la organización B fijada tampoco se ven los asientos de A.
    const fromB = await asRuntime(ORG_B, async (client) => {
      const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries`)
      return Number(rows[0].n)
    })
    expect(fromB).toBe(0)

    // Y la barrera 1 dice lo mismo desde el código de la aplicación.
    const { total } = await tenantTransaction(ORG_B, USER_A, async (tx) => getEntries(tx, {}, { take: 10 }))
    expect(total).toBe(0)
    expect(await tenantDb(ORG_B).fiscalYear.count()).toBe(0)
  }, 60_000)

  it("criterio 17 · closeFiscalYear como app_runtime: T-26/T-27, doce meses bloqueados e invariantes en PASS", async () => {
    // Un mes ya bloqueado a mano: el cierre completa el resto sin romper B-2.
    const locked = await lockPeriod(ORG_A, { fiscalYearId, month: 1, reason: "cierre de enero" }, actor)
    expect(locked.ok).toBe(true)

    // Un asiento con resultado, para que T-26 tenga algo que regularizar.
    const draft = await draftFor(ORG_A, "2026-03-15", 45_000)
    if (!draft.ok) throw new Error(JSON.stringify(draft.errors))
    const posted = await postEntry(ORG_A, draft.value, actor, { refDate: "2026-12-31" })
    expect(posted.ok).toBe(true)

    const closed = await closeFiscalYear(ORG_A, fiscalYearId, actor, "cierre del ejercicio 2026 de prueba")
    if (!closed.ok) throw new Error(JSON.stringify(closed.errors))

    expect(closed.value.fiscalYear.status).toBe("CLOSED")
    expect(closed.value.regularizacion?.kind).toBe("REGULARIZATION")
    expect(closed.value.cierre?.kind).toBe("CLOSING")
    expect(closed.value.lockedMonths).toHaveLength(12)
    expect(closed.value.ledgerHash).toHaveLength(64)

    // N-7: la regularización va inmediatamente antes del cierre.
    expect(closed.value.cierre!.entryNumber).toBe(closed.value.regularizacion!.entryNumber + 1)

    // Después del cierre, el ejercicio no admite nada más.
    const rejected = await postEntry(ORG_A, draft.value, actor, { skipCheck: true })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.errors[0].code).toBe("FY_CLOSED")

    const run = await runLedgerInvariants(ORG_A, { refDate: "2026-12-31", gitSha: GIT_SHA, noCache: true })
    expect(run.validacion.checks.filter((c) => c.status === "FAIL")).toEqual([])
    // E4: esta organización postea con `analyticsRequired = false`, así que sus
    // líneas 6/7 acaban en `CC-NA` e I-E4-1 emite un WARN permanente (R7 / §7:
    // saldo en «Sin asignar» ⇒ el sello pide revisión). Lo que el criterio 17
    // exige —ningún invariante en FAIL— sigue comprobado arriba.
    expect(run.sello.sello).toBe("REQUIERE REVISIÓN")
    expect(run.sello.motivos.join(" ")).toMatch(/aviso/)
    expect(run.validacion.checks.find((c) => c.id === "I-E4-1")?.status).toBe("WARN")
  }, 120_000)
})
