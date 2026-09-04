import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"

process.env.DATABASE_URL ??= "postgresql://postgres@localhost:5432/erp"

const {
  INVITATION_TTL_DAYS,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiresAt,
  isInvitationExpired,
  normalizeInvitationEmail,
} = await import("@/models/invitations")

describe("invitaciones", () => {
  it("caducan a los 7 días de la fecha recibida por parámetro (D-4)", () => {
    const now = new Date("2026-02-26T10:00:00.000Z")
    expect(INVITATION_TTL_DAYS).toBe(7)
    expect(invitationExpiresAt(now).toISOString()).toBe("2026-03-05T10:00:00.000Z")
  })

  it("cruza correctamente el 29 de febrero de un año bisiesto", () => {
    const now = new Date("2028-02-25T23:30:00.000Z")
    expect(invitationExpiresAt(now).toISOString()).toBe("2028-03-03T23:30:00.000Z")
  })

  it("isInvitationExpired es exclusivo en el instante exacto de caducidad", () => {
    const now = new Date("2026-03-01T00:00:00.000Z")
    const expiresAt = invitationExpiresAt(now)
    expect(isInvitationExpired({ expiresAt }, now)).toBe(false)
    expect(isInvitationExpired({ expiresAt }, expiresAt)).toBe(true)
    expect(isInvitationExpired({ expiresAt }, new Date(expiresAt.getTime() + 1))).toBe(true)
  })

  it("el hash es sha256 hex del token y el token nunca se repite", () => {
    const token = generateInvitationToken()
    expect(hashInvitationToken(token)).toBe(createHash("sha256").update(token).digest("hex"))
    expect(hashInvitationToken(token)).toHaveLength(64)
    expect(generateInvitationToken()).not.toBe(token)
  })

  it("normaliza el email a minúsculas y sin espacios", () => {
    expect(normalizeInvitationEmail("  Persona@Ejemplo.COM ")).toBe("persona@ejemplo.com")
  })
})
