import { afterAll, beforeAll, describe, expect, it } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb } = await import("@/lib/db")

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa20"
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb20"
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb21"

/**
 * QA adversarial — extiende tenant-models.test.ts a las operaciones de
 * agregación (count/aggregate/groupBy) y a upsert sobre las 8 tablas de
 * negocio citadas en §8.3 CA de E1. Intenta ROMPER I10 desde tenantDb(A).
 */
describe.skipIf(!TEST_DATABASE_URL)("QA adversarial — fuga de tenant en count/aggregate/groupBy/upsert", () => {
  const dbA = tenantDb(ORG_A)

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: USER_A, email: "qa-leak-a@test.local", name: "A" },
        { id: USER_B, email: "qa-leak-b@test.local", name: "B" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "qa-leak-org-a", name: "QA Leak A", updatedAt: new Date() },
        { id: ORG_B, slug: "qa-leak-org-b", name: "QA Leak B", updatedAt: new Date() },
      ],
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: USER_A, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG_B, userId: USER_B, role: "ADMIN", updatedAt: new Date() },
      ],
    })
    await prisma.category.create({
      data: { organizationId: ORG_B, code: "leak-cat", name: "B only" },
    })
    // E4 (D-E4-1): `Project.businessLineId` es NOT NULL desde E4.
    const leakBusinessLine = await prisma.businessLine.create({
      data: { organizationId: ORG_B, code: "GENERAL", name: "General", isSystem: true, updatedAt: new Date() },
    })
    await prisma.project.create({
      data: { organizationId: ORG_B, code: "leak-proj", name: "B only", businessLineId: leakBusinessLine.id, updatedAt: new Date() },
    })
    await prisma.field.create({
      data: { organizationId: ORG_B, code: "leak-field", name: "B only", type: "text" },
    })
    await prisma.setting.create({
      data: { organizationId: ORG_B, code: "leak-setting", name: "Leak setting", value: "secret-b" },
    })
    await prisma.transaction.create({
      data: {
        organizationId: ORG_B,
        name: "B only tx",
        type: "expense",
        total: 100,
        currencyCode: "EUR",
        issuedAt: new Date(),
      },
    })
    await prisma.file.create({
      data: {
        organizationId: ORG_B,
        filename: "b-only.pdf",
        path: "b-only.pdf",
        mimetype: "application/pdf",
      },
    })
    await prisma.appData.create({
      data: { organizationId: ORG_B, app: "leak-app", userId: USER_B, data: { secret: true } },
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.transaction.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.file.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.appData.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.field.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.category.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.project.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.setting.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
  }

  it("count() acotado por tenant devuelve 0 para las filas de B en las 7 tablas de negocio", async () => {
    expect(await dbA.category.count()).toBe(0)
    expect(await dbA.project.count()).toBe(0)
    expect(await dbA.field.count()).toBe(0)
    expect(await dbA.setting.count()).toBe(0)
    expect(await dbA.transaction.count()).toBe(0)
    expect(await dbA.file.count()).toBe(0)
    expect(await dbA.appData.count()).toBe(0)
  })

  it("aggregate() de transaction no incluye el importe de B", async () => {
    const agg = await dbA.transaction.aggregate({ _sum: { total: true }, _count: true })
    expect(agg._count).toBe(0)
    expect(agg._sum.total).toBeNull()
  })

  it("groupBy() de transaction no expone filas de B", async () => {
    const rows = await dbA.transaction.groupBy({ by: ["currencyCode"], _count: true })
    expect(rows).toEqual([])
  })

  it("upsert() con where ajeno a B lanza (más estricto que la insatisfacibilidad descrita en §3.3) y no toca la fila de B", async () => {
    await expect(
      dbA.setting.upsert({
        where: { organizationId_code: { organizationId: ORG_B, code: "leak-setting" } },
        update: { value: "hijacked" },
        create: { code: "leak-setting", name: "x", value: "created-by-a" },
      })
    ).rejects.toThrow()
    const bRow = await prisma.setting.findUnique({
      where: { organizationId_code: { organizationId: ORG_B, code: "leak-setting" } },
    })
    expect(bRow?.value).toBe("secret-b")
  })

  it("updateMany/deleteMany sobre B afectan 0 filas desde A", async () => {
    const upd = await dbA.transaction.updateMany({ data: { name: "hijacked" } })
    expect(upd.count).toBe(0)
    const del = await dbA.category.deleteMany({})
    expect(del.count).toBe(0)
    const bCategory = await prisma.category.findFirst({ where: { organizationId: ORG_B, code: "leak-cat" } })
    expect(bCategory).not.toBeNull()
  })

  it("create() con organizationId ajeno explícito lanza TenantError", async () => {
    await expect(
      dbA.transaction.create({
        data: {
          organizationId: ORG_B,
          name: "intento",
          type: "expense",
          total: 1,
          currencyCode: "EUR",
          issuedAt: new Date(),
        } as never,
      })
    ).rejects.toThrow()
  })
})
