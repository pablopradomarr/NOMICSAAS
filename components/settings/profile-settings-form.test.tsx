// E13 · T12 — Test de `ProfileSettingsForm` (docs/design/E13-autenticacion.md §8.2 T12): la
// sección "Cambiar contraseña" se oculta en self-hosted (no hay contraseña que cambiar).
import { Organization, User } from "@/prisma/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import ProfileSettingsForm from "./profile-settings-form"

const user = {
  id: "u1",
  email: "ana@example.com",
  name: "Ana",
  avatar: null,
} as unknown as User

const organization = {
  id: "o1",
  name: "Acme",
  businessName: null,
  businessAddress: null,
  businessBankDetails: null,
  businessLogo: null,
} as unknown as Organization

describe("ProfileSettingsForm — sección «Cambiar contraseña»", () => {
  it("se pinta cuando showPasswordSection es true", () => {
    const html = renderToStaticMarkup(
      <ProfileSettingsForm user={user} organization={organization} canEditBusiness={false} showPasswordSection />
    )
    expect(html).toContain("Cambiar contraseña")
  })

  it("se oculta cuando showPasswordSection es false (self-hosted, sin contraseña)", () => {
    const html = renderToStaticMarkup(
      <ProfileSettingsForm
        user={user}
        organization={organization}
        canEditBusiness={false}
        showPasswordSection={false}
      />
    )
    expect(html).not.toContain("Cambiar contraseña")
  })
})
