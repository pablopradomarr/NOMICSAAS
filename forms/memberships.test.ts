import { changeMemberRoleFormSchema, removeMemberFormSchema, roleSchema } from "@/forms/memberships"
import { describe, expect, it } from "vitest"

const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccc11"

describe("forms/memberships", () => {
  it("acepta los tres roles del enum y rechaza cualquier otro", () => {
    for (const role of ["ADMIN", "EDITOR", "VIEWER"]) {
      expect(roleSchema.safeParse(role).success).toBe(true)
    }
    expect(roleSchema.safeParse("OWNER").success).toBe(false)
    expect(roleSchema.safeParse("admin").success).toBe(false)
  })

  it("el cambio de rol exige uuid de usuario y rol válido", () => {
    expect(changeMemberRoleFormSchema.safeParse({ userId: USER, role: "EDITOR" }).success).toBe(true)
    expect(changeMemberRoleFormSchema.safeParse({ userId: "x", role: "EDITOR" }).success).toBe(false)
    expect(changeMemberRoleFormSchema.safeParse({ userId: USER, role: "SUPERADMIN" }).success).toBe(false)
  })

  it("quitar a un miembro exige motivo", () => {
    expect(removeMemberFormSchema.safeParse({ userId: USER, reason: "" }).success).toBe(false)
    expect(removeMemberFormSchema.safeParse({ userId: USER, reason: "  " }).success).toBe(false)
    const parsed = removeMemberFormSchema.parse({ userId: USER, reason: "  Baja en la empresa  " })
    expect(parsed.reason).toBe("Baja en la empresa")
  })
})
