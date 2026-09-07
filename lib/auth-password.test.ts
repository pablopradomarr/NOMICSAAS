// E13 · T3 — Tests de `lib/auth-password.ts` (docs/design/E13-autenticacion.md §3, §5 S2/S4).
//
// `auth.$context` se importa de forma diferida dentro de cada función (para romper el ciclo
// con `lib/auth.ts`), así que aquí se mockea `@/lib/auth` con un `$context` falso en lugar de
// arrancar better-auth de verdad.
import { beforeEach, describe, expect, it, vi } from "vitest"

const hash = vi.fn(async (plain: string) => `hashed:${plain}`)
const findAccountByProviderId = vi.fn(async (_accountId: string, _providerId: string) => null as { password?: string } | null)
const updatePassword = vi.fn(async (_userId: string, _password: string) => {})
const linkAccount = vi.fn(async (_account: Record<string, unknown>) => ({}))

vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: { hash },
      internalAdapter: { findAccountByProviderId, updatePassword, linkAccount },
    }),
  },
}))

// E7 · T14 (ADR-0015 D5): `sessions` se borra por `authPrisma` (rol `app_auth`), no por el
// cliente de runtime; el mock sigue al cliente que usa el fichero.
const sessionDeleteMany = vi.fn(async (_args: unknown) => ({ count: 3 }))
vi.mock("@/lib/auth-db", () => ({
  authPrisma: { session: { deleteMany: sessionDeleteMany } },
}))

const { hashPassword, hasPassword, revokeAllSessions, setUserPassword } = await import("./auth-password")

beforeEach(() => {
  hash.mockClear()
  findAccountByProviderId.mockClear()
  updatePassword.mockClear()
  linkAccount.mockClear()
  sessionDeleteMany.mockClear()
  findAccountByProviderId.mockResolvedValue(null)
})

describe("hashPassword()", () => {
  it("delega en el hasher de auth.$context, nunca en una implementación propia (R6)", async () => {
    const result = await hashPassword("mi-contraseña-larga")
    expect(hash).toHaveBeenCalledWith("mi-contraseña-larga")
    expect(result).toBe("hashed:mi-contraseña-larga")
  })
})

describe("setUserPassword()", () => {
  it("crea la cuenta credential cuando el usuario no tiene una (linkAccount)", async () => {
    findAccountByProviderId.mockResolvedValueOnce(null)
    await setUserPassword("user-1", "contraseña-nueva-larga")

    expect(linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        accountId: "user-1",
        providerId: "credential",
        password: "hashed:contraseña-nueva-larga",
      })
    )
    expect(updatePassword).not.toHaveBeenCalled()
  })

  it("actualiza la cuenta credential existente (updatePassword) en vez de duplicarla", async () => {
    findAccountByProviderId.mockResolvedValueOnce({ password: "hashed:vieja" })
    await setUserPassword("user-1", "contraseña-nueva-larga")

    expect(updatePassword).toHaveBeenCalledWith("user-1", "hashed:contraseña-nueva-larga")
    expect(linkAccount).not.toHaveBeenCalled()
  })

  it("es el único punto que escribe un hash: siempre pasa por auth.$context.password.hash", async () => {
    await setUserPassword("user-1", "otra-contraseña-larga")
    expect(hash).toHaveBeenCalledWith("otra-contraseña-larga")
  })
})

describe("hasPassword()", () => {
  it("es false cuando no hay cuenta credential", async () => {
    findAccountByProviderId.mockResolvedValueOnce(null)
    expect(await hasPassword("user-1")).toBe(false)
  })

  it("es false cuando la cuenta credential existe pero sin password (p. ej. quedó a medio crear)", async () => {
    findAccountByProviderId.mockResolvedValueOnce({ password: undefined })
    expect(await hasPassword("user-1")).toBe(false)
  })

  it("es true cuando hay contraseña fijada", async () => {
    findAccountByProviderId.mockResolvedValueOnce({ password: "hashed:algo" })
    expect(await hasPassword("user-1")).toBe(true)
  })
})

describe("revokeAllSessions() — S2", () => {
  it("borra todas las filas de sessions del usuario y devuelve cuántas", async () => {
    const count = await revokeAllSessions("user-1")
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } })
    expect(count).toBe(3)
  })
})
