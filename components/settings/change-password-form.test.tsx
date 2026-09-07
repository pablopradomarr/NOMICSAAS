// E13 · T12 — Test de `ChangePasswordForm` (docs/design/E13-autenticacion.md §6.1, §8.2 T12).
// Mismo patrón que `components/auth/password-fields.test.tsx`: estado inicial con `renderToStaticMarkup`.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ChangePasswordForm } from "./change-password-form"

describe("ChangePasswordForm — estado inicial", () => {
  it("pinta actual + nueva ×2 con autocomplete y sin mensaje de éxito ni error", () => {
    const html = renderToStaticMarkup(<ChangePasswordForm />)

    expect(html).toContain('autoComplete="current-password"')
    const newPasswordCount = (html.match(/autoComplete="new-password"/g) || []).length
    expect(newPasswordCount).toBe(2)
    expect(html).toContain("Cambiar contraseña")
    expect(html).not.toContain("Se han cerrado tus otras sesiones")
    expect(html).not.toContain("bg-red-50")
  })
})
