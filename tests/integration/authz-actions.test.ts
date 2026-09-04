import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccc10"
const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccc11"

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
  getCurrentUser: async () => viewerUser,
  getSession: async () => ({ user: viewerUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma } = await import("@/lib/db")
const { AuthzError } = await import("@/lib/authz-core")

let viewerUser: { id: string; email: string; name: string }

/**
 * T10 (CA-5) — un VIEWER no puede mutar: las server actions arrancan con
 * `requireOrg(minRole)` y la autorización es SIEMPRE de servidor.
 */
describe.skipIf(!TEST_DATABASE_URL)("autorización por rol en server actions", () => {
  beforeAll(async () => {
    await cleanup()
    viewerUser = { id: VIEWER, email: "viewer@test.local", name: "Viewer" }
    await prisma.user.create({ data: viewerUser })
    await prisma.organization.create({
      data: { id: ORG, slug: "authz-org", name: "Authz Org", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: VIEWER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.category.deleteMany({ where: { organizationId: ORG } })
    await prisma.project.deleteMany({ where: { organizationId: ORG } })
    await prisma.setting.deleteMany({ where: { organizationId: ORG } })
    await prisma.membership.deleteMany({ where: { organizationId: ORG } })
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.user.deleteMany({ where: { id: VIEWER } })
  }

  it("requireOrg('VIEWER') resuelve la organización del usuario", async () => {
    const { requireOrg } = await import("@/lib/authz")
    const context = await requireOrg("VIEWER")
    expect(context.org.id).toBe(ORG)
    expect(context.role).toBe("VIEWER")
  })

  it("addCategoryAction (ADMIN) rechaza a un VIEWER y no escribe nada", async () => {
    const { addCategoryAction } = await import("@/app/(app)/settings/actions")
    await expect(addCategoryAction({ code: "x", name: "Intento" })).rejects.toThrow(AuthzError)
    expect(await prisma.category.count({ where: { organizationId: ORG } })).toBe(0)
  })

  it("saveSettingsAction (ADMIN) rechaza a un VIEWER y no escribe nada", async () => {
    const { saveSettingsAction } = await import("@/app/(app)/settings/actions")
    const formData = new FormData()
    formData.set("default_currency", "USD")
    await expect(saveSettingsAction(null, formData)).rejects.toThrow(AuthzError)
    expect(await prisma.setting.count({ where: { organizationId: ORG } })).toBe(0)
  })

  it("addProjectAction (EDITOR) rechaza a un VIEWER y no escribe nada", async () => {
    const { addProjectAction } = await import("@/app/(app)/settings/actions")
    await expect(addProjectAction({ code: "y", name: "Proyecto" })).rejects.toThrow(AuthzError)
    expect(await prisma.project.count({ where: { organizationId: ORG } })).toBe(0)
  })
})
