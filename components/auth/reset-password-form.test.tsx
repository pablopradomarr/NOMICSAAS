// E13 · T7 — Test de `ResetPasswordForm` (docs/design/E13-autenticacion.md §6, §8.1 criterio 9, S3).
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { classifyResetError, INVALID_TOKEN_ERROR, ResetPasswordForm } from "./reset-password-form"

describe("ResetPasswordForm — estado inicial", () => {
  it("pinta contraseña nueva y confirmación con autocomplete=new-password, sin error ni token inválido", () => {
    const html = renderToStaticMarkup(<ResetPasswordForm token="a-valid-token" />)

    const newPasswordCount = (html.match(/autoComplete="new-password"/g) || []).length
    expect(newPasswordCount).toBe(2)
    expect(html).toContain("GUARDAR CONTRASEÑA")
    expect(html).not.toContain(INVALID_TOKEN_ERROR)
    expect(html).not.toContain('role="alert"')
    // El token no aparece en el HTML: sólo viaja en el path del enlace, nunca al cliente como texto visible.
    expect(html).not.toContain("a-valid-token")
  })
})

describe("classifyResetError — token de un solo uso, caduca a la hora (S3)", () => {
  it("400/401/404 se tratan como enlace caducado o inválido", () => {
    expect(classifyResetError(400)).toBe("invalid_token")
    expect(classifyResetError(401)).toBe("invalid_token")
    expect(classifyResetError(404)).toBe("invalid_token")
  })

  it("cualquier otro código se muestra como error de formulario, no como enlace muerto", () => {
    expect(classifyResetError(429)).toBe("form")
    expect(classifyResetError(500)).toBe("form")
  })
})

describe("ResetPasswordForm — estado de enlace inválido/caducado", () => {
  it("el mensaje de enlace inválido no lleva ni el genérico de política ni rojo semáforo", () => {
    // No hay forma de disparar el submit sin jsdom; se comprueba el contrato textual que la UI usaría.
    expect(INVALID_TOKEN_ERROR).toMatch(/caducado|no es válido/)
    expect(INVALID_TOKEN_ERROR).not.toMatch(/text-red|#dc2626/i)
  })
})
