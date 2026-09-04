import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa30"
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb30"
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa31"
const OTHER_ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa32"
const INVITEE = "cccccccc-cccc-4ccc-8ccc-cccccccccc31"

let currentUser: { id: string; email: string; name: string }
const cookieBag: Record<string, string> = {}
const cookieStore = {
  get: (name: string) => (cookieBag[name] ? { value: cookieBag[name] } : undefined),
  set: (name: string, value: string) => {
    cookieBag[name] = value
  },
  delete: (name: string) => {
    delete cookieBag[name]
  },
}
// `headers()` lo usa el rate limit de invitaciones (E1-fix #14).
vi.mock("next/headers", () => ({ cookies: async () => cookieStore, headers: async () => new Headers() }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`)
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

const { prisma } = await import("@/lib/db")

/**
 * QA adversarial E1 — último ADMIN, invitaciones indebidas (CA-6, CA-7, CA-8) y
 * manipulación de la cookie `active_org` (CA-2). No modifica los tests existentes.
 */
describe.skipIf(!TEST_DATABASE_URL)("QA adversarial — último ADMIN, invitaciones, cookie de organización", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_A, email: "qa-admin-a@test.local", name: "Admin A" },
        { id: OTHER_ADMIN_A, email: "qa-admin-a2@test.local", name: "Admin A2" },
        { id: INVITEE, email: "qa-invitee@test.local", name: "Invitee" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "qa-authz-org-a", name: "QA Authz A", updatedAt: new Date() },
        { id: ORG_B, slug: "qa-authz-org-b", name: "QA Authz B", updatedAt: new Date() },
      ],
    })
  })

  afterAll(cleanup)
  afterEach(() => {
    for (const k of Object.keys(cookieBag)) delete cookieBag[k]
  })

  async function cleanup() {
    await prisma.invitation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN_A, OTHER_ADMIN_A, INVITEE] } } })
  }

  describe("último ADMIN (CA-6)", () => {
    beforeAll(async () => {
      await prisma.membership.create({
        data: { organizationId: ORG_A, userId: ADMIN_A, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      })
      currentUser = { id: ADMIN_A, email: "qa-admin-a@test.local", name: "Admin A" }
    })

    it("changeMemberRoleAction: el único ADMIN no puede degradarse a EDITOR", async () => {
      const { changeMemberRoleAction } = await import("@/app/(app)/settings/members/actions")
      const fd = new FormData()
      fd.set("userId", ADMIN_A)
      fd.set("role", "EDITOR")
      const result = await changeMemberRoleAction(null, fd)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: ADMIN_A } },
      })
      expect(membership?.role).toBe("ADMIN")
    })

    it("removeMemberAction: el único ADMIN no puede quitarse", async () => {
      const { removeMemberAction } = await import("@/app/(app)/settings/members/actions")
      const fd = new FormData()
      fd.set("userId", ADMIN_A)
      fd.set("reason", "me voy")
      const result = await removeMemberAction(null, fd)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: ADMIN_A } },
      })
      expect(membership).not.toBeNull()
    })

    it("con un segundo ADMIN, el primero SÍ puede degradarse (control positivo)", async () => {
      await prisma.membership.create({
        data: {
          organizationId: ORG_A,
          userId: OTHER_ADMIN_A,
          role: "ADMIN",
          acceptedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      const { changeMemberRoleAction } = await import("@/app/(app)/settings/members/actions")
      const fd = new FormData()
      fd.set("userId", ADMIN_A)
      fd.set("role", "EDITOR")
      const result = await changeMemberRoleAction(null, fd)
      expect(result.success).toBe(true)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: ADMIN_A } },
      })
      expect(membership?.role).toBe("EDITOR")
      // deshacer para no afectar a otros tests del bloque
      await prisma.membership.update({
        where: { organizationId_userId: { organizationId: ORG_A, userId: ADMIN_A } },
        data: { role: "ADMIN" },
      })
      await prisma.membership.delete({
        where: { organizationId_userId: { organizationId: ORG_A, userId: OTHER_ADMIN_A } },
      })
    })
  })

  describe("invitaciones indebidas (CA-7, CA-8)", () => {
    afterEach(async () => {
      await prisma.invitation.deleteMany({ where: { organizationId: ORG_A } })
    })

    it("token caducado: no crea membresía", async () => {
      currentUser = { id: INVITEE, email: "qa-invitee@test.local", name: "Invitee" }
      const { createInvitation } = await import("@/models/invitations")
      const { tenantDb } = await import("@/lib/db")
      const db = tenantDb(ORG_A)
      const { invitation, token } = await createInvitation(db, {
        email: "qa-invitee@test.local",
        role: "EDITOR" as never,
        invitedById: ADMIN_A,
        now: new Date(),
      })
      await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(0) } })

      const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
      const result = await acceptInvitationAction(token)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: INVITEE } },
      })
      expect(membership).toBeNull()
    })

    it("token revocado: no crea membresía", async () => {
      const { createInvitation, revokeInvitation } = await import("@/models/invitations")
      const { tenantDb } = await import("@/lib/db")
      const db = tenantDb(ORG_A)
      const { invitation, token } = await createInvitation(db, {
        email: "qa-invitee@test.local",
        role: "EDITOR" as never,
        invitedById: ADMIN_A,
        now: new Date(),
      })
      await revokeInvitation(db, invitation.id, new Date())

      const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
      const result = await acceptInvitationAction(token)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: INVITEE } },
      })
      expect(membership).toBeNull()
    })

    it("token ya usado: la segunda aceptación es idempotente, no lanza y no duplica membresía", async () => {
      const { createInvitation } = await import("@/models/invitations")
      const { tenantDb } = await import("@/lib/db")
      const db = tenantDb(ORG_A)
      const { token } = await createInvitation(db, {
        email: "qa-invitee@test.local",
        role: "EDITOR" as never,
        invitedById: ADMIN_A,
        now: new Date(),
      })
      const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
      await expect(acceptInvitationAction(token)).rejects.toThrow(/redirect:/)
      const result2 = await acceptInvitationAction(token)
      expect(result2.success).toBe(false)
      const count = await prisma.membership.count({
        where: { organizationId: ORG_A, userId: INVITEE },
      })
      expect(count).toBe(1)
      await prisma.membership.deleteMany({ where: { organizationId: ORG_A, userId: INVITEE } })
    })

    it("email de sesión distinto al invitado: rechaza y no crea membresía", async () => {
      const { createInvitation } = await import("@/models/invitations")
      const { tenantDb } = await import("@/lib/db")
      const db = tenantDb(ORG_A)
      const { token } = await createInvitation(db, {
        email: "qa-invitee@test.local",
        role: "EDITOR" as never,
        invitedById: ADMIN_A,
        now: new Date(),
      })
      currentUser = { id: OTHER_ADMIN_A, email: "otro@test.local", name: "Otro" }
      const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
      const result = await acceptInvitationAction(token)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: OTHER_ADMIN_A } },
      })
      expect(membership).toBeNull()
      currentUser = { id: INVITEE, email: "qa-invitee@test.local", name: "Invitee" }
    })

    it("token manipulado (un carácter alterado): no resuelve invitación", async () => {
      const { createInvitation } = await import("@/models/invitations")
      const { tenantDb } = await import("@/lib/db")
      const db = tenantDb(ORG_A)
      const { token } = await createInvitation(db, {
        email: "qa-invitee@test.local",
        role: "EDITOR" as never,
        invitedById: ADMIN_A,
        now: new Date(),
      })
      const tampered = token.slice(0, -1) + (token.at(-1) === "a" ? "b" : "a")
      const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
      const result = await acceptInvitationAction(tampered)
      expect(result.success).toBe(false)
      const membership = await prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: ORG_A, userId: INVITEE } },
      })
      expect(membership).toBeNull()
    })
  })

  describe("cookie active_org manipulada (CA-2)", () => {
    it("cookie firmada para B, sin membresía en B, cae a la organización real del usuario", async () => {
      currentUser = { id: ADMIN_A, email: "qa-admin-a@test.local", name: "Admin A" }
      const { ACTIVE_ORG_COOKIE, signActiveOrgCookie } = await import("@/lib/authz-core")
      const config = (await import("@/lib/config")).default
      cookieBag[ACTIVE_ORG_COOKIE] = signActiveOrgCookie(ORG_B, ADMIN_A, config.auth.secret)
      const { requireOrg } = await import("@/lib/authz")
      const context = await requireOrg("VIEWER")
      expect(context.org.id).toBe(ORG_A)
    })

    it("cookie con firma incorrecta (secreto distinto) se descarta igual", async () => {
      const { ACTIVE_ORG_COOKIE, signActiveOrgCookie } = await import("@/lib/authz-core")
      cookieBag[ACTIVE_ORG_COOKIE] = signActiveOrgCookie(ORG_A, ADMIN_A, "clave-falsa")
      const { requireOrg } = await import("@/lib/authz")
      const context = await requireOrg("VIEWER")
      expect(context.org.id).toBe(ORG_A)
    })
  })
})
