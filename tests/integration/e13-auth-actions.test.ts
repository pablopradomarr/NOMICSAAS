/**
 * E13 · T14 — Roles y fuga entre organizaciones sobre `sendMemberPasswordResetAction`
 * (docs/design/E13-autenticacion.md §8.1 criterio 11 y tarea 4 del QA).
 *
 * Mismo patrón que `tests/integration/organizations-actions.test.ts`: se mockean
 * `next/headers`, `next/cache`, `next/navigation` y `@/lib/auth` para invocar la
 * server action directamente contra `DATABASE_URL_TEST`, sin pasar por Next ni por
 * el navegador.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee10"
const ORG_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee20"
const ADMIN_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee11"
const VIEWER_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee12"
const MEMBER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee21"

const ADMIN_A_EMAIL = "admin-a@e13-test.local"
const VIEWER_A_EMAIL = "viewer-a@e13-test.local"
const MEMBER_B_EMAIL = "member-b@e13-test.local"

let currentActor: { id: string; email: string; name: string }

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore, headers: async () => new Headers() }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("NEXT_REDIRECT")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
// `sendMemberPasswordResetAction` llama a `auth.api.requestPasswordReset`: sólo se
// alcanza en el camino feliz (ADMIN + miembro de su propia organización), que estos
// dos tests deliberadamente NO ejercitan (ambos fallan antes, por rol o por tenant).
// Se stubea para que un test mal escrito en el futuro falle claramente en vez de
// disparar un envío de correo real contra better-auth.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>()
  return {
    ...actual,
    getCurrentUser: async () => currentActor,
    getSession: async () => ({ user: currentActor }),
    isSubscriptionExpired: () => false,
    isAiBalanceExhausted: () => false,
    auth: {
      api: {
        requestPasswordReset: async () => {
          throw new Error("No debería alcanzarse: ni rol ni tenant lo permiten en estos tests")
        },
      },
    },
  }
})

const { prisma } = await import("@/lib/db")

describe.skipIf(!TEST_DATABASE_URL)("E13 · sendMemberPasswordResetAction — roles y fuga entre tenants", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_A, email: ADMIN_A_EMAIL, name: "Admin A" },
        { id: VIEWER_A, email: VIEWER_A_EMAIL, name: "Viewer A" },
        { id: MEMBER_B, email: MEMBER_B_EMAIL, name: "Miembro B" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "e13-org-a", name: "Org A", updatedAt: new Date() },
        { id: ORG_B, slug: "e13-org-b", name: "Org B", updatedAt: new Date() },
      ],
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: ADMIN_A, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG_A, userId: VIEWER_A, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
        // MEMBER_B sólo pertenece a la organización B: nunca a la A.
        { organizationId: ORG_B, userId: MEMBER_B, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN_A, VIEWER_A, MEMBER_B] } } })
  }

  it("criterio 11 — un VIEWER no puede llamar a la action: recibe el mismo mensaje que la UI le niega", async () => {
    const { sendMemberPasswordResetAction } = await import("@/app/(app)/settings/members/actions")
    currentActor = { id: VIEWER_A, email: VIEWER_A_EMAIL, name: "Viewer A" }

    const formData = new FormData()
    formData.set("userId", ADMIN_A)

    const result = await sendMemberPasswordResetAction(null, formData)
    expect(result).toEqual({ success: false, error: "Sin permiso" })
  })

  it("tarea 4 QA — un ADMIN de la org A no puede resetear a quien sólo es miembro de la org B", async () => {
    const { sendMemberPasswordResetAction } = await import("@/app/(app)/settings/members/actions")
    currentActor = { id: ADMIN_A, email: ADMIN_A_EMAIL, name: "Admin A" }

    const formData = new FormData()
    formData.set("userId", MEMBER_B)

    const result = await sendMemberPasswordResetAction(null, formData)
    expect(result).toEqual({ success: false, error: "Esa persona no es miembro de la organización" })
  })

  it("control — el mismo ADMIN sí puede apuntar a un userId inexistente sin fugar información distinta", async () => {
    const { sendMemberPasswordResetAction } = await import("@/app/(app)/settings/members/actions")
    currentActor = { id: ADMIN_A, email: ADMIN_A_EMAIL, name: "Admin A" }

    const formData = new FormData()
    formData.set("userId", "00000000-0000-4000-8000-000000000099")

    const result = await sendMemberPasswordResetAction(null, formData)
    // Mismo mensaje que el caso de fuga: no distingue "no existe" de "existe pero es de otro tenant".
    expect(result).toEqual({ success: false, error: "Esa persona no es miembro de la organización" })
  })
})
