/**
 * E13 · BUG-E13-1 — Regresión mínima: la fila `account` (provider_id='credential') se crea de
 * verdad sin pasar `id` explícito.
 *
 * `advanced.database.generateId: "uuid"` (lib/auth.ts) sólo genera el id en JS cuando el
 * adaptador NO soporta UUIDs nativos; el adaptador Prisma sobre Postgres sí los soporta
 * (`supportsUUIDs: true`, `@better-auth/prisma-adapter`), así que better-auth delega el id en el
 * default de la columna. `account.id` (TEXT) no tenía `@default(uuid())`, a diferencia de
 * `user`/`session`/`verification`, y `setUserPassword` (lib/auth-password.ts, único punto que
 * escribe la credencial) fallaba con `Argument \`id\` is missing`.
 *
 * Contra `DATABASE_URL_TEST` de verdad (sin mockear `@/lib/auth`), como
 * `tests/integration/e13-auth-actions.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const USER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee30"
const USER_EMAIL = "account-id-default@e13-test.local"

const { prisma } = await import("@/lib/db")
const { setUserPassword } = await import("@/lib/auth-password")

async function cleanup() {
  await prisma.account.deleteMany({ where: { userId: USER_ID } })
  await prisma.user.deleteMany({ where: { id: USER_ID } })
}

describe.skipIf(!TEST_DATABASE_URL)("E13 · BUG-E13-1 — account.id por defecto", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER_ID, email: USER_EMAIL, name: "Account Id Default" } })
  })

  afterAll(cleanup)

  it("setUserPassword crea la fila account (provider_id='credential') con id autogenerado", async () => {
    await setUserPassword(USER_ID, "contraseña-nueva-larga")

    const account = await prisma.account.findFirst({ where: { userId: USER_ID, providerId: "credential" } })
    expect(account).not.toBeNull()
    expect(account?.id).toBeTruthy()
    expect(account?.password).toBeTruthy()
  })
})
