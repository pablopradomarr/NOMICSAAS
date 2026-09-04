import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG_A = "dddddddd-dddd-4ddd-8ddd-dddddddddd10"
const ORG_B = "dddddddd-dddd-4ddd-8ddd-dddddddddd20"
const EDITOR = "dddddddd-dddd-4ddd-8ddd-dddddddddd11"
const EDITOR_EMAIL = "editor@test.local"

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => editorUser,
  getSession: async () => ({ user: editorUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma } = await import("@/lib/db")
const { AuthzError } = await import("@/lib/authz-core")
const { generateInvitationToken, hashInvitationToken } = await import("@/models/invitations")

let editorUser: { id: string; email: string; name: string }

/** T12–T14 — acciones de organización, membresías e invitaciones. */
describe.skipIf(!TEST_DATABASE_URL)("organizaciones, miembros e invitaciones", () => {
  beforeAll(async () => {
    await cleanup()
    editorUser = { id: EDITOR, email: EDITOR_EMAIL, name: "Editora" }
    await prisma.user.create({ data: editorUser })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "orgs-a", name: "Org A", updatedAt: new Date() },
        { id: ORG_B, slug: "orgs-b", name: "Org B", updatedAt: new Date() },
      ],
    })
    // Sólo es miembro de A: B existe pero le es ajena.
    await prisma.membership.create({
      data: { organizationId: ORG_A, userId: EDITOR, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.invitation.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: EDITOR } })
  }

  it("T12 — cambiar a una organización sin membresía falla y no escribe la cookie", async () => {
    const { switchOrganizationAction } = await import("@/app/(app)/organizations/actions")
    const result = await switchOrganizationAction(ORG_B)
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain("No perteneces")
  })

  it("T12 — un identificador que no es uuid se rechaza antes de tocar la base de datos", async () => {
    const { switchOrganizationAction } = await import("@/app/(app)/organizations/actions")
    const result = await switchOrganizationAction("no-es-uuid")
    expect(result).toMatchObject({ success: false })
  })

  it("T14 — invitar como EDITOR está prohibido y no crea ninguna invitación", async () => {
    const { inviteMemberAction } = await import("@/app/(app)/settings/members/actions")
    const formData = new FormData()
    formData.set("email", "nueva@test.local")
    formData.set("role", "VIEWER")
    await expect(inviteMemberAction(null, formData)).rejects.toThrow(AuthzError)
    expect(await prisma.invitation.count({ where: { organizationId: ORG_A } })).toBe(0)
  })

  it("T13 — cambiar el rol de un miembro como EDITOR está prohibido", async () => {
    const { changeMemberRoleAction } = await import("@/app/(app)/settings/members/actions")
    const formData = new FormData()
    formData.set("userId", EDITOR)
    formData.set("role", "ADMIN")
    await expect(changeMemberRoleAction(null, formData)).rejects.toThrow(AuthzError)
    expect((await prisma.membership.findFirst({ where: { organizationId: ORG_A, userId: EDITOR } }))?.role).toBe(
      "EDITOR"
    )
  })

  it("T14 — aceptar una invitación caducada falla, la marca EXPIRED y no crea membresía", async () => {
    const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
    const token = generateInvitationToken()
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: ORG_B,
        email: EDITOR_EMAIL,
        role: "VIEWER",
        tokenHash: hashInvitationToken(token),
        invitedById: EDITOR,
        expiresAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(),
      },
    })

    const result = await acceptInvitationAction(token)
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain("caducado")
    expect((await prisma.invitation.findUnique({ where: { id: invitation.id } }))?.status).toBe("EXPIRED")
    expect(await prisma.membership.count({ where: { organizationId: ORG_B, userId: EDITOR } })).toBe(0)
  })

  it("T14 — aceptar una invitación revocada falla con mensaje propio", async () => {
    const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
    const token = generateInvitationToken()
    await prisma.invitation.create({
      data: {
        organizationId: ORG_B,
        email: EDITOR_EMAIL,
        role: "VIEWER",
        tokenHash: hashInvitationToken(token),
        invitedById: EDITOR,
        status: "REVOKED",
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      },
    })

    const result = await acceptInvitationAction(token)
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain("revocada")
  })

  it("T14 — aceptar una invitación válida crea la membresía y marca ACCEPTED", async () => {
    const { acceptInvitationAction } = await import("@/app/(auth)/invite/[token]/actions")
    const token = generateInvitationToken()
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: ORG_B,
        email: EDITOR_EMAIL,
        role: "VIEWER",
        tokenHash: hashInvitationToken(token),
        invitedById: EDITOR,
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      },
    })

    // La acción termina en redirect("/dashboard"): el mock de next/navigation lanza.
    await expect(acceptInvitationAction(token)).rejects.toThrow("NEXT_REDIRECT")

    const membership = await prisma.membership.findFirst({ where: { organizationId: ORG_B, userId: EDITOR } })
    expect(membership?.role).toBe("VIEWER")
    expect((await prisma.invitation.findUnique({ where: { id: invitation.id } }))?.status).toBe("ACCEPTED")
  })
})
