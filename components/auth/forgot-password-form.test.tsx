// E13 · T7 — Test de `ForgotPasswordForm` (docs/design/E13-autenticacion.md §6, §8.1 criterio 8).
// Mismo patrón que `login-form.test.tsx`: estado inicial con `renderToStaticMarkup`, estado de
// error/confirmación sobre la función pura `resolveForgotPasswordOutcome`.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CONFIRMATION_MESSAGE, ForgotPasswordForm, resolveForgotPasswordOutcome } from "./forgot-password-form"

describe("ForgotPasswordForm — estado inicial", () => {
  it("pinta el email con autocomplete y el botón de enviar, sin confirmación ni error", () => {
    const html = renderToStaticMarkup(<ForgotPasswordForm />)

    expect(html).toContain('type="email"')
    expect(html).toContain('autoComplete="email"')
    expect(html).toContain("ENVIAR ENLACE")
    expect(html).not.toContain(CONFIRMATION_MESSAGE)
    expect(html).not.toContain('role="alert"')
  })
})

describe("resolveForgotPasswordOutcome — S1: la respuesta nunca revela si el email existe", () => {
  it("sin error: confirma con el texto fijo", () => {
    expect(resolveForgotPasswordOutcome(null)).toEqual({ rateLimited: false, message: CONFIRMATION_MESSAGE })
  })

  it("con cualquier error que NO sea 429: confirma igual, no se distingue", () => {
    expect(resolveForgotPasswordOutcome({ status: 404, message: "User not found" })).toEqual({
      rateLimited: false,
      message: CONFIRMATION_MESSAGE,
    })
    expect(resolveForgotPasswordOutcome({ status: 500 })).toEqual({
      rateLimited: false,
      message: CONFIRMATION_MESSAGE,
    })
  })

  it("con 429: sí se distingue, con el mensaje del servidor", () => {
    expect(
      resolveForgotPasswordOutcome({ status: 429, message: "Demasiados intentos. Vuelve a probar en unos minutos" })
    ).toEqual({ rateLimited: true, message: "Demasiados intentos. Vuelve a probar en unos minutos" })
  })

  it("429 sin mensaje: usa un genérico de límite, no queda vacío", () => {
    const result = resolveForgotPasswordOutcome({ status: 429 })
    expect(result.rateLimited).toBe(true)
    expect(result.message.length).toBeGreaterThan(0)
  })
})
