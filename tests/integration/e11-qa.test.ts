import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * E11 · QA adversarial — plataforma SaaS (docs/design/E11-plataforma-saas.md).
 *
 * Cubre huecos que `e11-integracion-d9.test.ts`, `e11-olab.test.ts`,
 * `e11a-esquema.test.ts` y `e11a-webhook-cron.test.ts` no ejercían:
 *  - la matriz de roles de `/settings/backups` (nadie probaba VIEWER, como
 *    E6-QA destapó para informes);
 *  - la fuga de tenant en las CUATRO tablas nuevas de la plataforma
 *    (`backup_jobs`, `usage_runs`, `stored_objects`, `subscriptions`);
 *  - `--reset-org` y las tablas de E11 (BUG-E11-2);
 *  - dos organizaciones con el MISMO nombre en el onboarding: el slug lleva el
 *    uuid, así que no hay colisión — pero nadie lo comprobaba.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG_A = "e11cafe0-0000-4000-8000-00000000000a"
const ORG_B = "e11cafe0-0000-4000-8000-00000000000b"
const ADMIN_USER = "e11cafe0-0000-4000-8000-0000000a0001"
const VIEWER_USER = "e11cafe0-0000-4000-8000-0000000f0002"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"

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

const { prisma, tenantDb } = await import("@/lib/db")
const { appRuntimeDatabaseUrl, maintenanceDatabaseUrl } = await import("@/tests/support/env")

async function cleanup() {
  for (const org of [ORG_A, ORG_B]) {
    await prisma.backupJob.deleteMany({ where: { organizationId: org } }).catch(() => undefined)
    await prisma.usageRun.deleteMany({ where: { organizationId: org } }).catch(() => undefined)
    await prisma.storedObject.deleteMany({ where: { organizationId: org } }).catch(() => undefined)
    await prisma.subscription.deleteMany({ where: { organizationId: org } }).catch(() => undefined)
    await prisma.membership.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
  }
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN_USER, VIEWER_USER] } } })
}

describe.skipIf(!TEST_DATABASE_URL)("E11 · QA adversarial", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_USER, email: "e11qa-admin@test.local", name: "Admin" },
        { id: VIEWER_USER, email: "e11qa-viewer@test.local", name: "Viewer" },
      ],
    })
    for (const org of [ORG_A, ORG_B]) {
      await prisma.organization.create({
        data: { id: org, slug: `e11qa-${org.slice(-1)}`, name: "Misma Razón Social SL", updatedAt: new Date() },
      })
      await prisma.subscription.create({
        data: { organizationId: org, planCode: "ILIMITADO", planId: PLAN_ILIMITADO, status: "ACTIVE" },
      })
    }
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_A, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_B, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })
    // Una fila de cada tabla nueva de la plataforma, EN LA ORGANIZACIÓN B, para
    // que la fuga de tenant tenga algo real que fugarse.
    await prisma.backupJob.create({
      data: {
        organizationId: ORG_B,
        status: "DONE",
        trigger: "MANUAL",
        formatVersion: "2.0",
        schemaVersion: "1",
        gitSha: "0".repeat(40),
        objectKey: "erp/e11cafe0-0000-4000-8000-00000000000b/backup.zip",
        sizeBytes: BigInt(1024),
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        signature: "c".repeat(64),
        signingKeyId: "k1",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    })
    await prisma.usageRun.create({
      data: {
        organizationId: ORG_B,
        periodMonth: new Date("2026-09-01T00:00:00Z"),
        sourceHash: "x".repeat(64),
        gitSha: "0".repeat(40),
        members: 1,
        entries: 0,
        ocrDocs: 0,
        exports: 0,
        backups: 0,
        storageBytes: BigInt(0),
        durationMs: 1,
      },
    })
    await prisma.storedObject.create({
      data: {
        organizationId: ORG_B,
        kind: "BACKUP",
        backend: "LOCAL",
        objectKey: "erp/e11cafe0-0000-4000-8000-00000000000b/qa.zip",
        sha256: "d".repeat(64),
        sizeBytes: BigInt(10),
        mimeType: "application/zip",
      },
    })
  }, 60_000)

  afterAll(cleanup)

  // ── VIEWER y /settings/backups ──────────────────────────────────────────
  it("requestBackupAction: un VIEWER es rechazado (403 vía AuthzError) y NO se crea ningún BackupJob", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: VIEWER_USER } })
    const before = await prisma.backupJob.count({ where: { organizationId: ORG_A } })
    const { requestBackupAction } = await import("@/app/(app)/settings/backups/actions")
    await expect(requestBackupAction("MANUAL")).rejects.toMatchObject({ name: "AuthzError", code: "FORBIDDEN" })
    expect(await prisma.backupJob.count({ where: { organizationId: ORG_A } })).toBe(before)
  })

  // ── Fuga de tenant en las cuatro tablas nuevas de la plataforma ─────────
  it("tenant leak · backup_jobs / usage_runs / stored_objects / subscriptions: A no ve NADA de B", async () => {
    const dbA = tenantDb(ORG_A)
    expect(await dbA.backupJob.count()).toBe(0)
    expect(await dbA.usageRun.count()).toBe(0)
    expect(await dbA.storedObject.count()).toBe(0)
    // `subscriptions` es 1:1 por organización: A ve la SUYA, nunca la de B.
    const subs = await dbA.subscription.findMany({})
    expect(subs.map((s) => s.organizationId)).toEqual([ORG_A])

    // Sin GUC de tenant en absoluto: app_runtime no ve ni las de A ni las de B.
    const { Client } = await import("pg")
    const bare = new Client({ connectionString: appRuntimeDatabaseUrl() })
    await bare.connect()
    try {
      for (const table of ["backup_jobs", "usage_runs", "stored_objects", "subscriptions"]) {
        const { rows } = await bare.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
        expect(Number(rows[0].n), `${table} visible sin GUC de tenant`).toBe(0)
      }
    } finally {
      await bare.end()
    }
  })

  // ── BUG-E11-2 · CORREGIDO ────────────────────────────────────────────────
  it(
    "BUG-E11-2 · `--reset-org` vacía las tablas de E11 (orden de FK): " +
      "restore_jobs, backup_jobs, stored_objects, usage_runs y onboarding_runs",
    async () => {
      const { E11_RESET_TABLES } = await import("@/scripts/load-fixture")
      expect([...E11_RESET_TABLES]).toEqual([
        "restore_jobs",
        "backup_jobs",
        "stored_objects",
        "usage_runs",
        "onboarding_runs",
      ])
      // Y el vaciado REAL: las filas de la organización B, creadas en el
      // `beforeAll`, desaparecen. Antes sobrevivían y contaminaban el fichero
      // e2e siguiente — el mismo fallo de BUG-E7-1 / BUG-E9-5 / BUG-E10-1.
      expect(await prisma.backupJob.count({ where: { organizationId: ORG_B } })).toBeGreaterThan(0)
      const { resetOrganizationLedger } = await import("@/scripts/load-fixture")
      process.env.DATABASE_URL_MAINTENANCE =
        process.env.DATABASE_URL_MAINTENANCE || maintenanceDatabaseUrl()
      await resetOrganizationLedger(ORG_B)
      expect(await prisma.backupJob.count({ where: { organizationId: ORG_B } })).toBe(0)
      expect(await prisma.usageRun.count({ where: { organizationId: ORG_B } })).toBe(0)
      expect(await prisma.storedObject.count({ where: { organizationId: ORG_B } })).toBe(0)
      // Y lo que NO se vacía, sigue: la suscripción es de la organización, no
      // de la prueba (I-E11-5 exige que exista).
      expect(await prisma.subscription.count({ where: { organizationId: ORG_B } })).toBe(1)
    },
    60_000
  )

  it(
    "BUG-E11-2 · la lista de tablas a vaciar se DERIVA de TENANT_MODELS: " +
      "una tabla de tenant nueva o se vacía o se declara preservada, con motivo",
    async () => {
      const fs = await import("node:fs")
      const { BACKUP_TENANT_MODELS, prismaSchemaMeta } = await import("@/lib/db")
      const { E11_RESET_TABLES, RESET_ORG_PRESERVED } = await import("@/scripts/load-fixture")

      const meta = prismaSchemaMeta()
      const tablasDeTenant = [...BACKUP_TENANT_MODELS]
        .map((model) => meta.find((entry) => entry.model === model)?.table)
        .filter((table): table is string => typeof table === "string")

      // Lo que el script vacía DE VERDAD, leído de su propio código: los
      // `DELETE FROM <tabla>` literales más las listas exportadas.
      const source = fs.readFileSync(new URL("../../scripts/load-fixture.ts", import.meta.url), "utf8")
      const borradas = new Set<string>([
        ...[...source.matchAll(/DELETE FROM (\w+) WHERE organization_id/g)].map((m) => m[1]),
        ...[...source.matchAll(/^\s+"(\w+)",$/gm)].map((m) => m[1]),
        ...E11_RESET_TABLES,
      ])
      const preservadas = new Set(RESET_ORG_PRESERVED.map((row) => row.table))

      // Toda preservada tiene MOTIVO escrito: una lista sin razones se convierte
      // en un cajón donde acaba lo que nadie quiso mirar.
      for (const row of RESET_ORG_PRESERVED) expect(row.reason.length, row.table).toBeGreaterThan(20)

      const olvidadas = tablasDeTenant.filter((table) => !borradas.has(table) && !preservadas.has(table))
      expect(
        olvidadas,
        `tablas de tenant que --reset-org no vacía ni declara preservadas: ${olvidadas.join(", ")}`
      ).toEqual([])
    }
  )

  // ── Onboarding: mismo nombre, sin colisión ──────────────────────────────
  it("onboarding · dos organizaciones con el MISMO nombre no colisionan: el slug lleva el uuid", async () => {
    const [a, b] = await prisma.organization.findMany({
      where: { id: { in: [ORG_A, ORG_B] } },
      select: { id: true, name: true, slug: true },
    })
    expect(a.name).toBe(b.name)
    expect(a.slug).not.toBe(b.slug)
    expect(a.id).not.toBe(b.id)
    // `buildOrganizationSlug` (models/organizations.ts) compone el slug con el
    // uuid ya generado, así que dos organizaciones con el MISMO nombre real
    // (no forzado a mano, como aquí) tampoco colisionarían en producción.
    const { buildOrganizationSlug } = await import("@/models/organizations")
    expect(buildOrganizationSlug(a.name, a.id)).not.toBe(buildOrganizationSlug(b.name, b.id))
  })
})
