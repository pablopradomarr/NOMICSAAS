import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e2ac0000-0000-4000-8000-000000000001"
const ADMIN = "e2ac0000-0000-4000-8000-0000000000a1"
const EDITOR = "e2ac0000-0000-4000-8000-0000000000e1"
const VIEWER = "e2ac0000-0000-4000-8000-0000000000v1".replace("v", "b")

type TestUser = { id: string; email: string; name: string }

/**
 * Usuario "de sesión" de cada caso. `getCurrentUser` está mockeado y devuelve
 * SIEMPRE esta variable, así que cambiarla equivale a iniciar sesión con otro
 * miembro: es la única forma de probar la matriz de roles de las actions.
 */
let currentUser: TestUser

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
const {
  createAccountAction,
  deleteAccountAction,
  importPlanCsvAction,
  renameAccountAction,
  setAccountActiveAction,
} = await import("@/app/(app)/settings/accounts/actions")
const { setAccountMapEntryAction } = await import("@/app/(app)/settings/account-map/actions")
const { listAuditLog } = await import("@/models/audit-log")

const db = tenantDb(ORG)

/** Plan mínimo suficiente para las reglas: no hace falta sembrar las 794 del PGC. */
const PLAN = [
  { code: "5", name: "Cuentas financieras", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "57", name: "Tesorería", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: false },
  { code: "572", name: "Bancos e instituciones de crédito c/c vista, euros", nature: "DEUDORA", statement: "BALANCE_ACTIVO", postable: true },
  { code: "7", name: "Ventas e ingresos", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "70", name: "Ventas de mercaderías y prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: false },
  { code: "705", name: "Prestaciones de servicios", nature: "ACREEDORA", statement: "PYG", postable: true },
] as const

async function seedPlan() {
  for (const row of PLAN) {
    await prisma.ledgerAccount.create({
      data: {
        organizationId: ORG,
        code: row.code,
        name: row.name,
        level: row.code.length,
        parentCode: row.code.length > 1 ? row.code.slice(0, row.code.length - 1) : null,
        nature: row.nature,
        statement: row.statement,
        epigraph: null,
        epigraphPymes: null,
        isPostable: row.postable,
        isActive: true,
        isSystem: false,
        origin: "SEED",
      },
    })
  }
  // 572 es cuenta de sistema porque el mapa apunta a ella (R-06).
  await prisma.organizationAccountMap.create({
    data: { organizationId: ORG, key: "BANCO_DEFAULT", accountCode: "572" },
  })
  await prisma.ledgerAccount.updateMany({
    where: { organizationId: ORG, code: "572" },
    data: { isSystem: true },
  })
}

describe.skipIf(!TEST_DATABASE_URL)("E2 · T12 — server actions del plan de cuentas", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN, email: "e2-admin@test.local", name: "Admin" },
        { id: EDITOR, email: "e2-editor@test.local", name: "Editor" },
        { id: VIEWER, email: "e2-viewer@test.local", name: "Viewer" },
      ],
    })
    await prisma.organization.create({
      data: { id: ORG, slug: "e2-actions", name: "E2 Actions SL", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: ADMIN, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG, userId: EDITOR, role: "EDITOR", updatedAt: new Date() },
        { organizationId: ORG, userId: VIEWER, role: "VIEWER", updatedAt: new Date() },
      ],
    })
    await seedPlan()
    currentUser = { id: ADMIN, email: "e2-admin@test.local", name: "Admin" }
  }, 60_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await prisma.auditLog.deleteMany({ where: { organizationId: ORG } })
    await prisma.taxRate.deleteMany({ where: { organizationId: ORG } })
    await prisma.organizationAccountMap.deleteMany({ where: { organizationId: ORG } })
    await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = $1::uuid`, ORG)
    await prisma.membership.deleteMany({ where: { organizationId: ORG } })
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN, EDITOR, VIEWER] } } })
  }

  const asUser = (id: string, email: string, name: string) => {
    currentUser = { id, email, name }
  }
  const asAdmin = () => asUser(ADMIN, "e2-admin@test.local", "Admin")

  const form = (fields: Record<string, string>) => {
    const formData = new FormData()
    for (const [key, value] of Object.entries(fields)) formData.set(key, value)
    return formData
  }

  it("VIEWER no puede renombrar ni desactivar: «Sin permiso» y ningún AuditLog", async () => {
    asUser(VIEWER, "e2-viewer@test.local", "Viewer")
    const rename = await renameAccountAction(null, form({ code: "705", name: "Intento del viewer" }))
    expect(rename).toEqual({ success: false, error: "Sin permiso" })

    const off = await setAccountActiveAction(null, form({ code: "705", isActive: "false", reason: "no debería" }))
    expect(off.success).toBe(false)

    const account = await db.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(account?.name).toBe("Prestaciones de servicios")
    expect(account?.isActive).toBe(true)
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, userId: VIEWER } })).toBe(0)
  })

  it("EDITOR tampoco: el plan de cuentas es ADMIN en este proyecto (descarte T-1)", async () => {
    asUser(EDITOR, "e2-editor@test.local", "Editor")
    const created = await createAccountAction(null, form({ code: "7050001", name: "Cliente X" }))
    expect(created).toEqual({ success: false, error: "Sin permiso" })

    const remap = await setAccountMapEntryAction(
      null,
      form({ key: "BANCO_DEFAULT", accountCode: "705", reason: "no debería poder" })
    )
    expect(remap).toEqual({ success: false, error: "Sin permiso" })
    expect(await db.ledgerAccount.count({ where: { code: "7050001" } })).toBe(0)
  })

  it("ADMIN renombra y el cambio queda en AuditLog (R-19)", async () => {
    asAdmin()
    const state = await renameAccountAction(null, form({ code: "705", name: "Honorarios de consultoría" }))
    expect(state.success).toBe(true)

    const account = await db.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(account?.name).toBe("Honorarios de consultoría")

    const logs = await listAuditLog(db, { entity: "LedgerAccount", entityId: account!.id })
    expect(logs[0]?.action).toBe("update")
    expect(logs[0]?.userId).toBe(ADMIN)
    expect(logs[0]?.after).toMatchObject({ name: "Honorarios de consultoría" })
  })

  it("ADMIN sin motivo no puede desactivar: el motivo es obligatorio (§7)", async () => {
    asAdmin()
    const state = await setAccountActiveAction(null, form({ code: "705", isActive: "false", reason: "" }))
    expect(state.success).toBe(false)
    expect(state.error).toMatch(/motivo/i)
    const account = await db.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(account?.isActive).toBe(true)
  })

  it("desactivar una cuenta de sistema se rechaza aunque haya motivo (R-06)", async () => {
    asAdmin()
    const state = await setAccountActiveAction(
      null,
      form({ code: "572", isActive: "false", reason: "cerramos esa cuenta bancaria" })
    )
    expect(state.success).toBe(false)
    expect(state.error).toMatch(/sistema/i)
    const account = await db.ledgerAccount.findFirst({ where: { code: "572" } })
    expect(account?.isActive).toBe(true)
  })

  it("un alta con un código sin padre en el plan se rechaza (R-03)", async () => {
    asAdmin()
    const state = await createAccountAction(null, form({ code: "8123", name: "Cuenta huérfana" }))
    expect(state.success).toBe(false)
    expect(state.error).toMatch(/prefijo|padre/i)
    expect(await db.ledgerAccount.count({ where: { code: "8123" } })).toBe(0)
  })

  it("un alta con código inválido no llega siquiera al modelo (R-01)", async () => {
    asAdmin()
    const state = await createAccountAction(null, form({ code: "0705", name: "Cero a la izquierda" }))
    expect(state.success).toBe(false)
    expect(await db.ledgerAccount.count({ where: { code: "0705" } })).toBe(0)
  })

  it("alta de subcuenta válida: hereda del padre y lo degrada (I-E2-2)", async () => {
    asAdmin()
    const state = await createAccountAction(null, form({ code: "7050001", name: "Consultoría – Cliente X" }))
    expect(state.success).toBe(true)

    const hija = await db.ledgerAccount.findFirst({ where: { code: "7050001" } })
    expect(hija).toMatchObject({ parentCode: "705", level: 7, statement: "PYG", isPostable: true })
    const padre = await db.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(padre?.isPostable).toBe(false)
  })

  it("borrar la cuenta creada exige motivo y deja el contenido completo en el registro", async () => {
    asAdmin()
    const sinMotivo = await deleteAccountAction(null, form({ code: "7050001", reason: "" }))
    expect(sinMotivo.success).toBe(false)

    const state = await deleteAccountAction(null, form({ code: "7050001", reason: "creada por error" }))
    expect(state.success).toBe(true)
    expect(await db.ledgerAccount.count({ where: { code: "7050001" } })).toBe(0)

    const logs = await listAuditLog(db, { entity: "LedgerAccount", action: "delete" })
    expect(logs[0]?.reason).toBe("creada por error")
    expect(logs[0]?.before).toMatchObject({ code: "7050001" })
    // El padre vuelve a ser hoja postable.
    const padre = await db.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(padre?.isPostable).toBe(true)
  })

  it("import CSV: `dryRun` no escribe nada y la confirmación aplica el diff", async () => {
    asAdmin()
    const csv = ["Cuenta;Descripcion", "5720;Banco c/c principal", "5721;Banco c/c divisas"].join("\n")
    const fields = {
      csv,
      fileName: "plan-propio.csv",
      delimiter: ";",
      mappingCode: "Cuenta",
      mappingName: "Descripcion",
      dryRun: "true",
      reason: "migración del programa anterior",
    }

    const preview = await importPlanCsvAction(null, form(fields))
    expect(preview.success).toBe(true)
    expect(preview.data).toMatchObject({ created: 2, updated: 0, dryRun: true })
    expect(await db.ledgerAccount.count({ where: { code: { in: ["5720", "5721"] } } })).toBe(0)

    const applied = await importPlanCsvAction(null, form({ ...fields, dryRun: "false" }))
    expect(applied.success).toBe(true)
    expect(applied.data?.created).toBe(2)

    const creada = await db.ledgerAccount.findFirst({ where: { code: "5720" } })
    expect(creada).toMatchObject({ parentCode: "572", origin: "CSV_IMPORT", isPostable: true })
    // Al ganar hijas, la 572 deja de admitir apuntes (R-04).
    expect((await db.ledgerAccount.findFirst({ where: { code: "572" } }))?.isPostable).toBe(false)

    const logs = await listAuditLog(db, { entity: "Organization", action: "import" })
    expect(logs[0]?.after).toMatchObject({ fileName: "plan-propio.csv", created: 2 })
  })

  it("una fila mala rechaza el fichero entero, con su número de fila (R4)", async () => {
    asAdmin()
    const csv = ["Cuenta;Descripcion", "6000;Compras", "0700;Código con cero a la izquierda"].join("\n")
    const state = await importPlanCsvAction(
      null,
      form({
        csv,
        delimiter: ";",
        mappingCode: "Cuenta",
        mappingName: "Descripcion",
        dryRun: "false",
      })
    )
    expect(state.success).toBe(false)
    expect(state.error).toMatch(/fila 2/)
    expect(await db.ledgerAccount.count({ where: { code: "6000" } })).toBe(0)
  })

  it("remapear una clave de sistema exige motivo y mueve la marca `isSystem`", async () => {
    asAdmin()
    const sinMotivo = await setAccountMapEntryAction(null, form({ key: "BANCO_DEFAULT", accountCode: "5720", reason: "" }))
    expect(sinMotivo.success).toBe(false)

    const state = await setAccountMapEntryAction(
      null,
      form({ key: "BANCO_DEFAULT", accountCode: "5720", reason: "la cuenta operativa es la 5720" })
    )
    expect(state.success).toBe(true)
    expect((await db.ledgerAccount.findFirst({ where: { code: "5720" } }))?.isSystem).toBe(true)
    expect((await db.ledgerAccount.findFirst({ where: { code: "572" } }))?.isSystem).toBe(false)

    const logs = await listAuditLog(db, { entity: "OrganizationAccountMap", action: "remap" })
    expect(logs[0]?.before).toMatchObject({ accountCode: "572" })
    expect(logs[0]?.after).toMatchObject({ accountCode: "5720" })
  })

  it("el mapa no acepta una cuenta que no admite apuntes (I-plan-1)", async () => {
    asAdmin()
    const state = await setAccountMapEntryAction(
      null,
      form({ key: "BANCO_DEFAULT", accountCode: "572", reason: "volver a la cuenta agregadora" })
    )
    expect(state.success).toBe(false)
    expect(state.error).toMatch(/subcuentas|apuntes/i)
  })
})
