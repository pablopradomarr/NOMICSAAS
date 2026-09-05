import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * E6 · QA adversarial — matriz de roles de `app/(app)/reports/actions.ts`.
 *
 * La cabecera del fichero de acciones DOCUMENTA una matriz (VIEWER lee y
 * exporta; sólo ADMIN fuerza/limpia revisión y toca los umbrales) pero,
 * antes de este fichero, NINGÚN test la ejercitaba: ni `e6-reports.test.ts`
 * (rol propietario, sin `requireOrg`) ni `informes.spec.ts` (e2e, sólo ADMIN).
 * Un `requireOrg("ADMIN")` mal escrito como `requireOrg("VIEWER")` habría
 * pasado desapercibido. Sigue el patrón de mocking de `authz-actions.test.ts`.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e6a00000-0000-4000-8000-0000000000fa"
const ADMIN_USER = "e6a00000-0000-4000-8000-0000000a0001"
const EDITOR_USER = "e6a00000-0000-4000-8000-0000000e0002"
const VIEWER_USER = "e6a00000-0000-4000-8000-0000000f0003"

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

const { prisma } = await import("@/lib/db")

describe.skipIf(!TEST_DATABASE_URL)("E6 · matriz de roles de las server actions de informes", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN_USER, email: "e6-roqa-admin@test.local", name: "Admin" },
        { id: EDITOR_USER, email: "e6-roqa-editor@test.local", name: "Editor" },
        { id: VIEWER_USER, email: "e6-roqa-viewer@test.local", name: "Viewer" },
      ],
    })
    await prisma.organization.create({
      data: { id: ORG, slug: "e6-roqa-org", name: "E6 Roles QA", updatedAt: new Date() },
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG, userId: ADMIN_USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: EDITOR_USER, role: "EDITOR", acceptedAt: new Date(), updatedAt: new Date() },
        { organizationId: ORG, userId: VIEWER_USER, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
      ],
    })
  })

  afterAll(cleanup)

  async function cleanup() {
    await prisma.manualReviewFlag.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
    await prisma.reportRun.deleteMany({ where: { organizationId: ORG } }).catch(() => undefined)
    await prisma.membership.deleteMany({ where: { organizationId: ORG } })
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN_USER, EDITOR_USER, VIEWER_USER] } } })
  }

  const FORCE_INPUT = {
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    scope: null,
    reason: "intento adversarial de forzar revisión",
  }

  it.each([
    ["VIEWER", VIEWER_USER],
    ["EDITOR", EDITOR_USER],
  ])("forceReviewAction: un %s recibe «Sin permiso» y NO escribe ningún flag", async (_role, userId) => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const { forceReviewAction } = await import("@/app/(app)/reports/actions")
    const result = await forceReviewAction(FORCE_INPUT)
    expect(result).toMatchObject({ success: false, error: "Sin permiso" })
    expect(await prisma.manualReviewFlag.count({ where: { organizationId: ORG } })).toBe(0)
  })

  it.each([
    ["VIEWER", VIEWER_USER],
    ["EDITOR", EDITOR_USER],
  ])("setReviewThresholdsAction: un %s recibe «Sin permiso» y NO cambia los umbrales", async (_role, userId) => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const { setReviewThresholdsAction } = await import("@/app/(app)/reports/actions")
    const { DEFAULT_REVIEW_THRESHOLDS } = await import("@/lib/ledger/report-run")
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: ORG }, select: { reviewThresholds: true } })
    const result = await setReviewThresholdsAction({
      ...DEFAULT_REVIEW_THRESHOLDS,
      kpis: { ...DEFAULT_REVIEW_THRESHOLDS.kpis, ingresos: { pctBps: 1, minAbsCents: 1, minPointsBps: null } },
    })
    expect(result).toMatchObject({ success: false, error: "Sin permiso" })
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: ORG }, select: { reviewThresholds: true } })
    expect(after.reviewThresholds).toEqual(before.reviewThresholds)
  })

  it("clearReviewAction: un ADMIN puede levantar, un EDITOR recibe «Sin permiso» sobre el MISMO flag", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER } })
    const { forceReviewAction, clearReviewAction } = await import("@/app/(app)/reports/actions")
    const forced = await forceReviewAction(FORCE_INPUT)
    expect(forced.success).toBe(true)
    const flagId = (forced.data as { id: string }).id

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: EDITOR_USER } })
    const rejected = await clearReviewAction({ id: flagId, reason: "intento de un editor" })
    expect(rejected).toMatchObject({ success: false, error: "Sin permiso" })
    expect(
      (await prisma.manualReviewFlag.findUniqueOrThrow({ where: { id: flagId } })).clearedAt
    ).toBeNull()

    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: ADMIN_USER } })
    const cleared = await clearReviewAction({ id: flagId, reason: "levantada por el admin tras revisar" })
    expect(cleared.success).toBe(true)
    expect(
      (await prisma.manualReviewFlag.findUniqueOrThrow({ where: { id: flagId } })).clearedAt
    ).not.toBeNull()
  })

  it("un VIEWER SÍ puede leer (balanceAction) y exportar (exportReportAction): la matriz no es simétrica", async () => {
    currentUser = await prisma.user.findUniqueOrThrow({ where: { id: VIEWER_USER } })
    const { balanceAction, exportReportAction } = await import("@/app/(app)/reports/actions")
    const balance = await balanceAction({
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      snapshot: "PRE_REGULARIZACION",
    })
    // Diario vacío: el run se emite igualmente (I2 = 0 - 0 - 0), no es un rechazo de rol.
    expect(balance.success).toBe(true)
    const runId = (balance.data as { id: string }).id

    const exported = await exportReportAction({ runId, format: "xlsx" })
    expect(exported.success).toBe(true)
    expect((exported.data as { filename: string }).filename).toMatch(/\.xlsx$/)
  })
})
