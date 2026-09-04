import { afterAll, beforeAll, describe, expect, it } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe estar fijada antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
} else if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://postgres@localhost:5432/erp"
}

const { and, flattenUniqueWhere, scopeUniqueWhere, withOrg, TenantError, tenantDb, tenantTransaction, prisma } =
  await import("@/lib/db")

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"

describe("and()", () => {
  it("compone con AND en vez de spread superficial", () => {
    expect(and({ code: "x" }, { organizationId: ORG_A })).toEqual({
      AND: [{ code: "x" }, { organizationId: ORG_A }],
    })
  })

  it("no deja que el llamante sobrescriba el filtro de tenant", () => {
    const composed = and({ organizationId: ORG_B }, { organizationId: ORG_A })
    expect(composed).toEqual({ AND: [{ organizationId: ORG_B }, { organizationId: ORG_A }] })
  })

  it("devuelve sólo el scope cuando no hay where", () => {
    expect(and(undefined, { organizationId: ORG_A })).toEqual({ organizationId: ORG_A })
    expect(and({}, { organizationId: ORG_A })).toEqual({ organizationId: ORG_A })
  })
})

describe("flattenUniqueWhere()", () => {
  it("aplana el selector único compuesto", () => {
    expect(flattenUniqueWhere({ organizationId_code: { organizationId: ORG_B, code: "x" } })).toEqual({
      organizationId: ORG_B,
      code: "x",
    })
  })

  it("no confunde un campo heredado con guion bajo con un selector compuesto", () => {
    expect(flattenUniqueWhere({ llm_prompt: { contains: "iva" } })).toEqual({ llm_prompt: { contains: "iva" } })
  })

  it("deja intacto un where por id", () => {
    expect(flattenUniqueWhere({ id: "1" })).toEqual({ id: "1" })
  })
})

describe("withOrg()", () => {
  it("inyecta organizationId", () => {
    expect(withOrg({ code: "x" }, ORG_A)).toEqual({ code: "x", organizationId: ORG_A })
  })

  it("lanza si los datos traen una organización ajena", () => {
    expect(() => withOrg({ organizationId: ORG_B }, ORG_A)).toThrow(TenantError)
  })

  it("acepta que venga la misma organización", () => {
    expect(withOrg({ organizationId: ORG_A }, ORG_A)).toEqual({ organizationId: ORG_A })
  })
})

describe("tenantDb()", () => {
  it("rechaza un organizationId que no sea uuid", () => {
    expect(() => tenantDb("no-es-uuid")).toThrow(TenantError)
  })
})

describe("scopeUniqueWhere()", () => {
  it("fuerza la organización dentro del selector compuesto y añade el filtro extra", () => {
    expect(scopeUniqueWhere({ organizationId_code: { organizationId: ORG_A, code: "x" } }, ORG_A)).toEqual({
      organizationId_code: { organizationId: ORG_A, code: "x" },
      organizationId: ORG_A,
    })
  })

  it("conserva el selector único por id y lo acota", () => {
    expect(scopeUniqueWhere({ id: "1" }, ORG_A)).toEqual({ id: "1", organizationId: ORG_A })
  })

  it("lanza si el selector compuesto apunta a otra organización", () => {
    expect(() => scopeUniqueWhere({ organizationId_code: { organizationId: ORG_B, code: "x" } }, ORG_A)).toThrow(
      TenantError
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integración: requiere DATABASE_URL_TEST (npm run test:integration)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!TEST_DATABASE_URL)("tenantDb contra BD real (aislamiento I10)", () => {
  const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
  const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"

  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: userA, email: "org-a@test.local", name: "Org A" },
        { id: userB, email: "org-b@test.local", name: "Org B" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "org-a-test", name: "Org A", updatedAt: new Date() },
        { id: ORG_B, slug: "org-b-test", name: "Org B", updatedAt: new Date() },
      ],
    })
    await prisma.category.createMany({
      data: [
        { organizationId: ORG_A, code: "compartido", name: "Categoría de A" },
        { organizationId: ORG_B, code: "compartido", name: "Categoría de B" },
        { organizationId: ORG_B, code: "solo-b", name: "Sólo B" },
      ],
    })
    await prisma.setting.createMany({
      data: [
        { organizationId: ORG_A, code: "app_title", name: "Título", value: "A", updatedAt: new Date() },
        { organizationId: ORG_B, code: "app_title", name: "Título", value: "B", updatedAt: new Date() },
      ],
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.category.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.setting.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } })
  }

  it("el mismo `code` puede existir en dos organizaciones (I7)", async () => {
    const rows = await prisma.category.findMany({ where: { code: "compartido" } })
    expect(rows).toHaveLength(2)
  })

  it("findMany sólo devuelve filas de la organización activa", async () => {
    const categories = await tenantDb(ORG_A).category.findMany()
    expect(categories.map((c) => c.name)).toEqual(["Categoría de A"])
  })

  it("findUnique por id de otra organización devuelve null y findUniqueOrThrow lanza", async () => {
    const foreign = await prisma.category.findFirstOrThrow({ where: { organizationId: ORG_B, code: "solo-b" } })
    expect(await tenantDb(ORG_A).category.findUnique({ where: { id: foreign.id } })).toBeNull()
    await expect(tenantDb(ORG_A).category.findUniqueOrThrow({ where: { id: foreign.id } })).rejects.toThrow()
  })

  it("un selector único compuesto de otra organización no toca su fila", async () => {
    await expect(
      tenantDb(ORG_A).setting.update({
        where: { organizationId_code: { organizationId: ORG_B, code: "app_title" } },
        data: { value: "SECUESTRADO" },
      })
    ).rejects.toThrow()
    const settingB = await prisma.setting.findFirstOrThrow({ where: { organizationId: ORG_B } })
    expect(settingB.value).toBe("B")
  })

  it("updateMany y deleteMany no alcanzan a la otra organización", async () => {
    const updated = await tenantDb(ORG_A).category.updateMany({ where: { code: "solo-b" }, data: { name: "X" } })
    expect(updated.count).toBe(0)
    const deleted = await tenantDb(ORG_A).category.deleteMany({ where: { code: "solo-b" } })
    expect(deleted.count).toBe(0)
    expect(await prisma.category.count({ where: { organizationId: ORG_B } })).toBe(2)
  })

  it("create con organizationId ajeno lanza TenantError", async () => {
    await expect(
      tenantDb(ORG_A).category.create({
        data: { organizationId: ORG_B, code: "intruso", name: "Intruso" },
      })
    ).rejects.toThrow(TenantError)
  })

  it("tenantTransaction fija app.current_org y sigue filtrando", async () => {
    const [{ current_org: currentOrg }, categories] = await tenantTransaction(ORG_A, async (tx) => {
      const guc = await tx.$queryRawUnsafe<{ current_org: string | null }[]>("SELECT app.current_org() AS current_org")
      return [guc[0], await tx.category.findMany()] as const
    })
    expect(currentOrg).toBe(ORG_A)
    expect(categories).toHaveLength(1)
  })

  // ── Hallazgo #19: límites documentados de la extensión ────────────────────
  it("LÍMITE #19: $queryRaw NO pasa por la extensión (el WHERE es del llamante)", async () => {
    const sinFiltro = await tenantDb(ORG_A).$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM categories WHERE code = 'compartido'`
    )
    // Ve las dos filas: SQL crudo no lo acota nadie. Está documentado en el
    // JSDoc de tenantDb() y por eso `models/` no usa SQL crudo de negocio.
    expect(Number(sinFiltro[0].count)).toBe(2)

    const conFiltro = await tenantDb(ORG_A).$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM categories WHERE code = 'compartido' AND organization_id = $1::uuid`,
      ORG_A
    )
    expect(Number(conFiltro[0].count)).toBe(1)
  })

  it("LÍMITE #19: el include anidado no lleva filtro propio, lo garantiza la FK compuesta", async () => {
    // La lectura raíz sí está acotada…
    const categorias = await tenantDb(ORG_A).category.findMany({ include: { transactions: true } })
    expect(categorias).toHaveLength(1)
    expect(categorias[0].organizationId).toBe(ORG_A)
    // …y las transacciones colgadas no pueden ser de otra organización porque la
    // FK es (category_code, organization_id) → categories(code, organization_id).
    expect(categorias[0].transactions.every((t) => t.organizationId === ORG_A)).toBe(true)
  })

  it("tenantTransaction acepta userId y fija también app.current_user (#1/#2)", async () => {
    const [org, user] = await tenantTransaction(ORG_A, userA, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ o: string | null; u: string | null }[]>(
        "SELECT app.current_org() AS o, app.current_user() AS u"
      )
      return [rows[0].o, rows[0].u] as const
    })
    expect(org).toBe(ORG_A)
    expect(user).toBe(userA)
  })

  it("RLS bloquea la otra organización para el rol app_runtime (barrera 2)", async () => {
    const { Client } = await import("pg")
    const url = new URL(TEST_DATABASE_URL as string)
    const client = new Client({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      user: "app_runtime",
    })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query(`SET LOCAL app.current_org = '${ORG_A}'`)
      const visible = await client.query<{ organization_id: string }>("SELECT organization_id FROM categories")
      expect(visible.rows.every((row) => row.organization_id === ORG_A)).toBe(true)
      expect(visible.rows).toHaveLength(1)

      await expect(
        client.query(
          `INSERT INTO categories (id, organization_id, code, name) VALUES (gen_random_uuid(), '${ORG_B}', 'rls', 'RLS')`
        )
      ).rejects.toThrow(/row-level security/i)
      await client.query("ROLLBACK")
    } finally {
      await client.end()
    }
  })
})
