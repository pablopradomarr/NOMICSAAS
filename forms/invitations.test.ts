import { inviteMemberFormSchema, invitationIdSchema, invitationTokenSchema } from "@/forms/invitations"
import { generateInvitationToken } from "@/models/invitations"
import { describe, expect, it } from "vitest"

describe("forms/invitations", () => {
  it("normaliza el email a minúsculas y sin espacios", () => {
    const parsed = inviteMemberFormSchema.parse({ email: "  Ana.Ruiz@Ejemplo.ES ", role: "EDITOR" })
    expect(parsed.email).toBe("ana.ruiz@ejemplo.es")
    expect(parsed.role).toBe("EDITOR")
  })

  it("rechaza emails inválidos y roles desconocidos", () => {
    expect(inviteMemberFormSchema.safeParse({ email: "ana@", role: "EDITOR" }).success).toBe(false)
    expect(inviteMemberFormSchema.safeParse({ email: "ana@ejemplo.es", role: "GERENTE" }).success).toBe(false)
  })

  it("valida el identificador de invitación como uuid", () => {
    expect(invitationIdSchema.safeParse({ invitationId: "cccccccc-cccc-4ccc-8ccc-cccccccccc10" }).success).toBe(true)
    expect(invitationIdSchema.safeParse({ invitationId: "1" }).success).toBe(false)
  })

  it("acepta el formato real del token y rechaza longitudes o alfabetos distintos", () => {
    expect(invitationTokenSchema.safeParse(generateInvitationToken()).success).toBe(true)
    expect(invitationTokenSchema.safeParse("corto").success).toBe(false)
    expect(invitationTokenSchema.safeParse("a".repeat(43) + "!").success).toBe(false)
    expect(invitationTokenSchema.safeParse("a/b+".padEnd(43, "c")).success).toBe(false)
  })
})
