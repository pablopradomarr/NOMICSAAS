import { describe, expect, it } from "vitest"
import {
  ACTIVE_ORG_COOKIE,
  AuthzError,
  ROLE_RANK,
  parseActiveOrgCookie,
  roleSatisfies,
  signActiveOrgCookie,
} from "@/lib/authz-core"
import { Role } from "@/prisma/client"

const ALL_ROLES: Role[] = [Role.VIEWER, Role.EDITOR, Role.ADMIN]
const SECRET = "dev-secret-local-only-not-for-prod"
const ORG_A = "11111111-1111-4111-8111-111111111111"
const USER_1 = "22222222-2222-4222-8222-222222222222"

describe("roleSatisfies", () => {
  it("es reflexivo para los tres roles", () => {
    for (const role of ALL_ROLES) {
      expect(roleSatisfies(role, role)).toBe(true)
    }
  })

  it("respeta la jerarquía VIEWER < EDITOR < ADMIN", () => {
    expect(roleSatisfies(Role.ADMIN, Role.VIEWER)).toBe(true)
    expect(roleSatisfies(Role.ADMIN, Role.EDITOR)).toBe(true)
    expect(roleSatisfies(Role.EDITOR, Role.VIEWER)).toBe(true)
    expect(roleSatisfies(Role.EDITOR, Role.ADMIN)).toBe(false)
    expect(roleSatisfies(Role.VIEWER, Role.EDITOR)).toBe(false)
    expect(roleSatisfies(Role.VIEWER, Role.ADMIN)).toBe(false)
  })

  it("cubre las 9 combinaciones sin excepciones", () => {
    const results = ALL_ROLES.flatMap((role) => ALL_ROLES.map((min) => roleSatisfies(role, min)))
    expect(results).toHaveLength(9)
    expect(results.filter(Boolean)).toHaveLength(6)
  })

  it("ROLE_RANK cubre exhaustivamente el enum Role", () => {
    expect(Object.keys(ROLE_RANK).sort()).toEqual(Object.values(Role).sort())
    expect(new Set(Object.values(ROLE_RANK)).size).toBe(Object.values(Role).length)
  })
})

describe("AuthzError", () => {
  it("expone un código tipado", () => {
    const error = new AuthzError("FORBIDDEN")
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe("AuthzError")
    expect(error.code).toBe("FORBIDDEN")
  })
})

describe("cookie active_org", () => {
  it("firma y verifica el par (organización, usuario)", () => {
    const cookie = signActiveOrgCookie(ORG_A, USER_1, SECRET)
    expect(parseActiveOrgCookie(cookie, USER_1, SECRET)).toBe(ORG_A)
  })

  it("rechaza la cookie de otro usuario, otro secreto o manipulada", () => {
    const cookie = signActiveOrgCookie(ORG_A, USER_1, SECRET)
    const otherUser = "33333333-3333-4333-8333-333333333333"
    expect(parseActiveOrgCookie(cookie, otherUser, SECRET)).toBeNull()
    expect(parseActiveOrgCookie(cookie, USER_1, "otro-secreto")).toBeNull()
    expect(parseActiveOrgCookie(`${ORG_A}.firma-falsa`, USER_1, SECRET)).toBeNull()
    expect(parseActiveOrgCookie(ORG_A, USER_1, SECRET)).toBeNull()
    expect(parseActiveOrgCookie(undefined, USER_1, SECRET)).toBeNull()
  })

  it("usa el prefijo de cookie de better-auth", () => {
    expect(ACTIVE_ORG_COOKIE).toBe("taxhacker.active_org")
  })
})
