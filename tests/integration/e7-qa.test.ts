/**
 * E7 · QA — adversarial contra Postgres de verdad, complementando
 * `e7-conciliacion.test.ts`, `e7-esquema.test.ts`, `e7-retencion.test.ts`,
 * `tests/integration-rls/e7-tenant.test.ts` y `lib/audit/*.test.ts` (ver la
 * tabla de cobertura del informe de QA). Aquí sólo lo que esos ficheros NO
 * ejercen:
 *
 *  · **BUG-E7-1** (corregido en la ronda 1) — `resetOrganizationLedger`
 *    (scripts/load-fixture.ts, `--reset-org`) no limpiaba las tablas que E7
 *    añadió antes de borrar `journal_lines`/`fiscal_years`: una
 *    `BankReconciliation` o un `InvariantRun` vivos hacían que el reset entero
 *    fallara con una FK. Rompía de verdad un `npm run test:e2e` completo:
 *    `auditoria.spec.ts` deja conciliaciones e `InvariantRun` en la
 *    organización compartida de fixtures y `liquidacion.spec.ts` (que corre
 *    después, alfabéticamente) llama a `--reset-org`. Los tres casos de abajo
 *    comprueban el borrado en el orden de las FK y su idempotencia.
 *  · Barrido concurrente: un segundo `startSweep` mientras el primero está
 *    `RUNNING` se rechaza (lock consultivo, §9).
 *  · Cancelar un barrido lo deja en `CANCELLED`, no en `RUNNING` colgado.
 *  · `migrate-cashflow-report-type.ts` es idempotente: una segunda pasada
 *    sobre una organización ya migrada no encuentra runs que migrar y no
 *    falla.
 */

import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { appMaintenanceDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL
// `resetOrganizationLedger` lee `DATABASE_URL_MAINTENANCE` directamente de
// `process.env`: sin esto apuntaría a la BD de desarrollo (`.env`) y no a
// `erp_test`, y el test "pasaría" sin haber tocado nada.
process.env.DATABASE_URL_MAINTENANCE = appMaintenanceDatabaseUrl(ownerDatabaseUrl())

const { prisma } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { startSweep, requestCancel } = await import("@/models/store-sweep")

const ORG = "e7990000-0000-4000-8000-00000000001a"
const USER = "e7990000-0000-4000-8000-0000000a0001"

const SHA = (c: string) => c.repeat(64)

async function cleanup(): Promise<void> {
  for (const table of [
    "bank_reconciliations",
    "bank_match_groups",
    "bank_pending_kinds",
    "bank_statement_lines",
    "bank_statements",
    "bank_accounts",
    "invariant_runs",
    "store_sweeps",
    "journal_lines",
    "journal_entries",
    "fiscal_years",
    "memberships",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, ORG).catch(() => undefined)
  }
  await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG).catch(() => undefined)
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E7 · QA — reset de organización con tablas de E7 vivas (BUG-E7-1)", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e7-qa@test.local", name: "QA" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e7-qa-reset", name: "E7 QA reset", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
    await importNpgc(ORG, "PYMES")
  })

  afterAll(cleanup)

  /** Un asiento mínimo cuadrado 5720/626, con una `BankReconciliation` que lo referencia. */
  async function seedAsientoConciliado(): Promise<{ fiscalYearId: string; journalLineId: string }> {
    const fy = await prisma.fiscalYear.create({
      data: {
        organizationId: ORG,
        code: "2026",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-12-31"),
        status: "OPEN",
        updatedAt: new Date(),
      },
    })
    // El cuadre de I1 lo comprueba un constraint trigger DIFERIDO al COMMIT: la
    // cabecera y las dos líneas van en LA MISMA transacción o el `create` de la
    // cabecera sola revienta con «asiento sin líneas». Se fija el id a mano
    // para no depender de leer de vuelta dentro del mismo `$transaction`.
    const entryId = randomUUID()
    const [, line] = await prisma.$transaction([
      prisma.journalEntry.create({
        data: {
          id: entryId,
          organizationId: ORG,
          fiscalYearId: fy.id,
          entryNumber: 1,
          entryDate: new Date("2026-03-10"),
          description: "pago",
          postedById: USER,
          entryHash: "0".repeat(64),
          hashVersion: 3,
        },
      }),
      prisma.journalLine.create({
        data: {
          organizationId: ORG,
          entryId,
          lineNo: 1,
          accountCode: "5720",
          debitCents: 0,
          creditCents: 1000n as unknown as bigint,
          entryDate: new Date("2026-03-10"),
          fiscalYearId: fy.id,
          entryKind: "NORMAL",
        },
      }),
      prisma.journalLine.create({
        data: {
          organizationId: ORG,
          entryId,
          lineNo: 2,
          accountCode: "626",
          debitCents: 1000n as unknown as bigint,
          creditCents: 0,
          entryDate: new Date("2026-03-10"),
          fiscalYearId: fy.id,
          entryKind: "NORMAL",
        },
      }),
    ])
    const account = await prisma.bankAccount.create({
      data: { organizationId: ORG, code: "BK-QA", name: "Banco", accountCode: "5720", updatedAt: new Date() },
    })
    const statement = await prisma.bankStatement.create({
      data: {
        organizationId: ORG,
        bankAccountId: account.id,
        format: "CSV",
        fileSha256: SHA("9"),
        fileName: "extracto.csv",
        currency: "EUR",
        periodStart: new Date("2026-03-01"),
        periodEnd: new Date("2026-03-31"),
        openingBalanceCents: 0n as unknown as bigint,
        closingBalanceCents: -1000n as unknown as bigint,
      },
    })
    const stLine = await prisma.bankStatementLine.create({
      data: {
        organizationId: ORG,
        statementId: statement.id,
        bankAccountId: account.id,
        lineNo: 1,
        operationDate: new Date("2026-03-10"),
        valueDate: new Date("2026-03-10"),
        amountCents: -1000n as unknown as bigint,
        currency: "EUR",
        description: "cargo",
        sha256: SHA("8"),
      },
    })
    // El grupo y su pertenencia, en la MISMA transacción: desde la ronda 1 un
    // `CONSTRAINT TRIGGER` diferido exige que todo grupo VIVO tenga al menos un
    // miembro (revisor PUEDE 5) — un grupo vacío cuadraría por vacuidad.
    const groupId = randomUUID()
    await prisma.$transaction([
      prisma.bankMatchGroup.create({
        data: { id: groupId, organizationId: ORG, bankAccountId: account.id, kind: "SIMPLE", createdById: USER },
      }),
      prisma.bankReconciliation.create({
        data: {
          organizationId: ORG,
          groupId,
          statementLineId: stLine.id,
          journalLineId: line.id,
          method: "MANUAL",
          dateGapDays: 0,
          matchedById: USER,
        },
      }),
    ])
    return { fiscalYearId: fy.id, journalLineId: line.id }
  }

  it("BUG-E7-1a · `--reset-org` vacía la conciliación bancaria antes que el diario, sin FK que reviente", async () => {
    const seeded = await seedAsientoConciliado()
    const { resetOrganizationLedger } = await import("@/scripts/load-fixture")
    // Reproduce exactamente el fallo observado en un `test:e2e` completo:
    // `auditoria.spec.ts` concilia sobre la organización compartida y
    // `liquidacion.spec.ts` (que corre después) llama a `--reset-org`. Antes de
    // la corrección reventaba con `bank_reconciliations_journal_line_fkey`.
    await expect(resetOrganizationLedger(ORG)).resolves.toBeUndefined()

    // Y no queda NADA de E7 vivo: el orden de borrado es el de las FK.
    for (const table of [
      "bank_reconciliations",
      "bank_match_groups",
      "bank_pending_kinds",
      "bank_statement_lines",
      "bank_statements",
      "bank_accounts",
      "journal_lines",
      "journal_entries",
      "fiscal_years",
    ]) {
      const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1::uuid`,
        ORG
      )
      expect(Number(row.n), `${table} debería quedar vacía tras --reset-org`).toBe(0)
    }
    expect(seeded.journalLineId).toBeTruthy()
  })

  it("BUG-E7-1b · un `InvariantRun` con `fiscal_year_id` vivo tampoco impide borrar el ejercicio", async () => {
    // La organización quedó vacía por el test anterior: se vuelve a sembrar,
    // ahora con un barrido sellado colgando del ejercicio, que es lo que antes
    // reventaba con `invariant_runs_fiscal_year_fkey`.
    const seeded = await seedAsientoConciliado()
    await prisma.invariantRun.create({
      data: {
        organizationId: ORG,
        scopeKind: "FISCAL_YEAR",
        fiscalYearId: seeded.fiscalYearId,
        trigger: "MANUAL",
        refDate: new Date("2026-12-31"),
        ledgerHash: SHA("1"),
        planHash: SHA("2"),
        accountMapHash: SHA("3"),
        configHash: SHA("4"),
        gitSha: "sha",
        checksHash: SHA("5"),
        checks: [],
        counts: {},
        coverage: {},
        headline: {},
        seal: "VALIDADO_AUTOMATICAMENTE",
        durationMs: 0,
        runById: USER,
      },
    })
    // Y un barrido del almacén, que no ata a nada pero es estado de la
    // organización: un reset que lo dejara vivo haría que I-E7-8 mintiera.
    await prisma.storeSweep.create({
      data: { organizationId: ORG, status: "DONE", runById: USER, finishedAt: new Date() },
    })

    const { resetOrganizationLedger } = await import("@/scripts/load-fixture")
    await expect(resetOrganizationLedger(ORG)).resolves.toBeUndefined()
    for (const table of ["invariant_runs", "store_sweeps", "fiscal_years"]) {
      const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM ${table} WHERE organization_id = $1::uuid`,
        ORG
      )
      expect(Number(row.n), `${table} debería quedar vacía tras --reset-org`).toBe(0)
    }
  })

  it("BUG-E7-1c · dos `--reset-org` seguidos son idempotentes: el segundo no falla", async () => {
    const { resetOrganizationLedger } = await import("@/scripts/load-fixture")
    await expect(resetOrganizationLedger(ORG)).resolves.toBeUndefined()
    await expect(resetOrganizationLedger(ORG)).resolves.toBeUndefined()
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E7 · QA — barrido del almacén: lock y cancelación", () => {
  const SORG = "e7990000-0000-4000-8000-00000000002a"
  const SUSER = "e7990000-0000-4000-8000-0000000a0002"

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM store_sweeps WHERE organization_id = $1::uuid`, SORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM memberships WHERE organization_id = $1::uuid`, SORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, SORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, SUSER).catch(() => undefined)
    await prisma.user.create({ data: { id: SUSER, email: "e7-qa-sweep@test.local", name: "QA" } })
    await prisma.organization.create({
      data: { id: SORG, slug: "e7-qa-sweep", name: "E7 QA sweep", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: SORG, userId: SUSER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
  })

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM store_sweeps WHERE organization_id = $1::uuid`, SORG)
    await prisma.$executeRawUnsafe(`DELETE FROM memberships WHERE organization_id = $1::uuid`, SORG)
    await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, SORG)
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, SUSER)
  })

  it("un segundo barrido mientras el primero está RUNNING se rechaza (lock consultivo)", async () => {
    const first = await startSweep(SORG, { userId: SUSER }, 10)
    expect(first.status).toBe("RUNNING")
    await expect(startSweep(SORG, { userId: SUSER }, 10)).rejects.toThrow(/Ya hay un barrido/)
  })

  it("cancelar el barrido lo deja en CANCELLED, no en RUNNING colgado", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM store_sweeps WHERE organization_id = $1::uuid AND status = 'RUNNING'`,
      SORG
    )
    expect(row).toBeDefined()
    const result = await requestCancel(SORG, row.id, { userId: SUSER })
    expect(result.status).toBe("CANCELLED")
    const after = await prisma.storeSweep.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.status).toBe("CANCELLED")
    expect(after.finishedAt).not.toBeNull()
    // Cancelar dos veces el mismo barrido ya terminado no vuelve a "colarse":
    // se rechaza con un motivo, no con un `CANCELLED` silencioso repetido.
    await expect(requestCancel(SORG, row.id, { userId: SUSER })).rejects.toThrow(/ya había terminado/)
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E7 · QA — migrate-cashflow-report-type es idempotente", () => {
  it("una segunda pasada sobre una organización ya migrada no encuentra runs y no falla", async () => {
    const { migrateCashflowReportType } = await import("@/scripts/migrate-cashflow-report-type")
    // Sobre una organización sin ningún `ReportRun` legado (el caso "ya
    // migrada"), dos pasadas seguidas deben dar el mismo resultado: cero
    // runs, cero colisiones, sin excepción.
    const first = await migrateCashflowReportType({ org: ORG, apply: true })
    const second = await migrateCashflowReportType({ org: ORG, apply: true })
    expect(first.runs).toBe(0)
    expect(second.runs).toBe(0)
    expect(second.colisiones).toBe(0)
  })
})
