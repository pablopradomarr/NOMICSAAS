// E13 · T13 — Tests de la lógica pura de `scripts/create-admin.ts` (parseo de argv e
// idempotencia decidida por flags), sin BD ni TTY (docs/design/E13-autenticacion.md §8.1
// criterio 13).
import { describe, expect, it } from "vitest"
import { parseCreateAdminArgs, shouldWritePassword } from "./create-admin"

describe("parseCreateAdminArgs()", () => {
  it("exige --email y --name", () => {
    expect(() => parseCreateAdminArgs([])).toThrow(/--email/)
    expect(() => parseCreateAdminArgs(["--email", "admin@empresa.com"])).toThrow(/--name/)
  })

  it("rechaza un --email con formato inválido", () => {
    expect(() => parseCreateAdminArgs(["--email", "no-es-un-email", "--name", "Ana"])).toThrow(/inválido/)
  })

  it("rechaza --name vacío o sólo espacios", () => {
    expect(() => parseCreateAdminArgs(["--email", "admin@empresa.com", "--name", "   "])).toThrow(/--name/)
  })

  it("nunca acepta --password: es precisamente lo que el diseño prohíbe (criterio 13)", () => {
    expect(() =>
      parseCreateAdminArgs(["--email", "admin@empresa.com", "--name", "Ana", "--password", "secreta123456"])
    ).toThrow(/nunca se pasa por argumento/)
  })

  it("acepta el mínimo: email + name, sin --org ni --reset-password", () => {
    const args = parseCreateAdminArgs(["--email", "Admin@Empresa.com", "--name", "Ana Admin"])
    expect(args).toEqual({ email: "admin@empresa.com", name: "Ana Admin", org: null, resetPassword: false })
  })

  it("recoge --org y --reset-password", () => {
    const args = parseCreateAdminArgs([
      "--email",
      "admin@empresa.com",
      "--name",
      "Ana Admin",
      "--org",
      "CFOnomic SL",
      "--reset-password",
    ])
    expect(args.org).toBe("CFOnomic SL")
    expect(args.resetPassword).toBe(true)
  })

  it("normaliza --org vacío o en blanco a null", () => {
    const args = parseCreateAdminArgs(["--email", "admin@empresa.com", "--name", "Ana", "--org", "   "])
    expect(args.org).toBeNull()
  })
})

describe("shouldWritePassword() — idempotencia (criterio 13)", () => {
  it("un usuario nuevo siempre necesita contraseña", () => {
    expect(shouldWritePassword({ userExists: false, resetPassword: false })).toBe(true)
    expect(shouldWritePassword({ userExists: false, resetPassword: true })).toBe(true)
  })

  it("un usuario existente SIN --reset-password no toca la contraseña", () => {
    expect(shouldWritePassword({ userExists: true, resetPassword: false })).toBe(false)
  })

  it("un usuario existente CON --reset-password sí la reescribe", () => {
    expect(shouldWritePassword({ userExists: true, resetPassword: true })).toBe(true)
  })
})
