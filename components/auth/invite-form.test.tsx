// E13 · T9 — Test de `InviteForm` / `AcceptInvitationButton` (docs/design/E13-autenticacion.md
// §6, §8.1 criterios 5-7). Mismo patrón que el resto de formularios de auth: estado inicial con
// `renderToStaticMarkup`; el estado de error de validación se cubre con `setInvitedPasswordFormSchema`
// (ya testeado en `forms/auth.test.ts`), que es exactamente lo que valida este formulario antes de
// llamar al servidor.
import { setInvitedPasswordFormSchema } from "@/forms/auth"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AcceptInvitationButton, InviteForm } from "./invite-form"

describe("InviteForm — estado inicial", () => {
  it("pinta el correo bloqueado, nombre, contraseña ×2 y el chip del rol; sin error visible", () => {
    const html = renderToStaticMarkup(<InviteForm token="tok123" email="nueva@example.com" roleLabel="Editor" />)

    expect(html).toContain("nueva@example.com")
    expect(html).toContain("readOnly")
    expect(html).toContain("EDITOR")
    expect(html).toContain('autoComplete="name"')
    const newPasswordCount = (html.match(/autoComplete="new-password"/g) || []).length
    expect(newPasswordCount).toBe(2)
    expect(html).toContain("CREAR CUENTA Y ENTRAR")
    expect(html).not.toContain('role="alert"')
    // El token no se expone como texto visible, sólo se usa al enviar el formulario.
    expect(html).not.toContain("tok123")
  })
})

describe("AcceptInvitationButton — estado inicial", () => {
  it("pinta el botón de aceptar sin error", () => {
    const html = renderToStaticMarkup(<AcceptInvitationButton token="tok123" />)
    expect(html).toContain("ACEPTAR INVITACIÓN")
    expect(html).not.toContain('role="alert"')
  })
})

describe("setInvitedPasswordFormSchema — lo que InviteForm valida antes de llamar al servidor", () => {
  it("rechaza sin nombre", () => {
    expect(setInvitedPasswordFormSchema.safeParse({ name: "", password: "a".repeat(12), confirm: "a".repeat(12) }).success).toBe(
      false
    )
  })

  it("rechaza cuando las contraseñas no coinciden (mismo mensaje que el resto de formularios)", () => {
    const result = setInvitedPasswordFormSchema.safeParse({
      name: "Ana",
      password: "a".repeat(12),
      confirm: "b".repeat(12),
    })
    expect(result.success).toBe(false)
  })

  it("acepta nombre + contraseña válida y coincidente", () => {
    const password = "a".repeat(12)
    expect(setInvitedPasswordFormSchema.safeParse({ name: "Ana", password, confirm: password }).success).toBe(true)
  })
})
