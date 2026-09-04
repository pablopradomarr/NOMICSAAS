import { afterAll, beforeAll, describe, expect, it } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb } = await import("@/lib/db")
const { createCategory, getCategories, updateCategory, deleteCategory } = await import("@/models/categories")
const { createProject, getProjects, getProjectByCode } = await import("@/models/projects")
const { createField, getFields } = await import("@/models/fields")
const { createTransaction, getTransactions, getTransactionById, bulkDeleteTransactions } = await import(
  "@/models/transactions"
)
const { getSettings, updateSettings } = await import("@/models/settings")
const { createFile, getUnsortedFiles, getFileById } = await import("@/models/files")
const { importCategory, importProject } = await import("@/models/export_and_import")
const { modelToJSON, MODEL_BACKUP } = await import("@/models/backups")

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10"
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10"
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11"
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb11"

/**
 * T9 — los `models/` de negocio reciben el contexto de tenant y NINGUNA consulta
 * puede alcanzar filas de otra organización (invariante I10).
 */
describe.skipIf(!TEST_DATABASE_URL)("models de negocio acotados por organización (I10)", () => {
  const dbA = tenantDb(ORG_A)
  const dbB = tenantDb(ORG_B)

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: USER_A, email: "models-a@test.local", name: "A" },
        { id: USER_B, email: "models-b@test.local", name: "B" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "models-org-a", name: "Org A", updatedAt: new Date() },
        { id: ORG_B, slug: "models-org-b", name: "Org B", updatedAt: new Date() },
      ],
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: USER_A, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG_B, userId: USER_B, role: "ADMIN", updatedAt: new Date() },
      ],
    })

    // Mismos códigos en ambas organizaciones: I7 (unicidad por organización)
    for (const [db, label] of [
      [dbA, "A"],
      [dbB, "B"],
    ] as const) {
      await createCategory(db, { code: "compras", name: `Compras ${label}` })
      await createProject(db, { code: "cliente", name: `Cliente ${label}` })
      // Sin los campos definidos, splitTransactionDataExtraFields descarta los datos.
      for (const code of ["name", "total", "categoryCode"]) {
        await createField(db, { code, name: `${code} ${label}`, type: "string", isExtra: false })
      }
      await createField(db, { code: "obra", name: `Obra ${label}`, type: "string" })
      await updateSettings(db, "default_currency", label === "A" ? "EUR" : "USD")
    }

    await createTransaction(dbA, { name: "Factura de A", total: 10000, categoryCode: "compras" }, {
      createdById: USER_A,
    })
    await createTransaction(dbB, { name: "Factura de B", total: 20000, categoryCode: "compras" }, {
      createdById: USER_B,
    })

    await createFile(dbA, { organizationId: ORG_A, uploadedById: USER_A, filename: "a.pdf", path: "a.pdf", mimetype: "application/pdf" })
    await createFile(dbB, { organizationId: ORG_B, uploadedById: USER_B, filename: "b.pdf", path: "b.pdf", mimetype: "application/pdf" })
  })

  afterAll(cleanup)

  async function cleanup() {
    const orgs = { in: [ORG_A, ORG_B] }
    await prisma.transaction.deleteMany({ where: { organizationId: orgs } })
    await prisma.file.deleteMany({ where: { organizationId: orgs } })
    await prisma.category.deleteMany({ where: { organizationId: orgs } })
    await prisma.project.deleteMany({ where: { organizationId: orgs } })
    await prisma.field.deleteMany({ where: { organizationId: orgs } })
    await prisma.setting.deleteMany({ where: { organizationId: orgs } })
    await prisma.currency.deleteMany({ where: { organizationId: orgs } })
    await prisma.membership.deleteMany({ where: { organizationId: orgs } })
    await prisma.organization.deleteMany({ where: { id: orgs } })
    await prisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } })
  }

  it("categorías: cada organización sólo ve las suyas, con el mismo code (I7)", async () => {
    expect((await getCategories(dbA)).map((c) => c.name)).toEqual(["Compras A"])
    expect((await getCategories(dbB)).map((c) => c.name)).toEqual(["Compras B"])
  })

  it("proyectos y campos no se filtran entre organizaciones", async () => {
    expect((await getProjects(dbA)).map((p) => p.name)).toEqual(["Cliente A"])
    expect((await getFields(dbB)).map((f) => f.name)).toContain("Obra B")
    expect((await getFields(dbB)).every((f) => f.name.endsWith("B"))).toBe(true)
  })

  it("settings: el mismo code convive en las dos organizaciones con valores distintos", async () => {
    expect((await getSettings(dbA)).default_currency).toBe("EUR")
    expect((await getSettings(dbB)).default_currency).toBe("USD")
  })

  it("transacciones: listado y acceso por id acotados al tenant", async () => {
    const { transactions } = await getTransactions(dbA)
    expect(transactions.map((t) => t.name)).toEqual(["Factura de A"])

    const foreign = await prisma.transaction.findFirstOrThrow({ where: { organizationId: ORG_B } })
    expect(await getTransactionById(dbA, foreign.id)).toBeNull()
  })

  it("ficheros: getUnsortedFiles y getFileById no alcanzan los de la otra organización", async () => {
    expect((await getUnsortedFiles(dbA)).map((f) => f.filename)).toEqual(["a.pdf"])
    const foreign = await prisma.file.findFirstOrThrow({ where: { organizationId: ORG_B } })
    expect(await getFileById(dbA, foreign.id)).toBeNull()
  })

  it("G-08: importar un proyecto/categoría con el nombre de otra organización crea uno propio", async () => {
    const project = await importProject(dbA, "Cliente B")
    expect(project.organizationId).toBe(ORG_A)
    expect(await getProjectByCode(dbB, project.code)).toBeNull()

    const category = await importCategory(dbA, "Compras B")
    expect(category.organizationId).toBe(ORG_A)
  })

  it("export/backup: el volcado sólo contiene filas de la organización", async () => {
    const transactionsBackup = MODEL_BACKUP.find((m) => m.filename === "transactions.json")!
    const json = JSON.parse(await modelToJSON(dbA, transactionsBackup)) as { name: string }[]
    expect(json.map((row) => row.name)).toEqual(["Factura de A"])
  })

  it("mutaciones dirigidas por code no tocan la fila homónima de la otra organización", async () => {
    await updateCategory(dbA, "compras", { name: "Compras A (editada)" })
    const categoryB = await prisma.category.findFirstOrThrow({ where: { organizationId: ORG_B, code: "compras" } })
    expect(categoryB.name).toBe("Compras B")

    const deletedCount = await bulkDeleteTransactions(dbA, [
      (await prisma.transaction.findFirstOrThrow({ where: { organizationId: ORG_B } })).id,
    ])
    expect(deletedCount.count).toBe(0)
    expect(await prisma.transaction.count({ where: { organizationId: ORG_B } })).toBe(1)
  })

  it("borrar una categoría desengancha sólo las transacciones propias", async () => {
    await deleteCategory(dbA, "compras")
    const transactionB = await prisma.transaction.findFirstOrThrow({ where: { organizationId: ORG_B } })
    expect(transactionB.categoryCode).toBe("compras")
  })
})
