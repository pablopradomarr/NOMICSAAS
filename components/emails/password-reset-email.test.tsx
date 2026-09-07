// E13 · T4 — Test de render del correo de restablecimiento (docs/design/E13-autenticacion.md §4.1).
// Sin @testing-library en el proyecto: se renderiza a marcado estático con `react-dom/server`,
// mismo patrón que `components/auth/brand/brand.test.tsx`.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PasswordResetEmail } from "./password-reset-email"

describe("PasswordResetEmail", () => {
  it("incluye el enlace de restablecimiento y la marca NOMIC", () => {
    const html = renderToStaticMarkup(
      <PasswordResetEmail resetUrl="https://app.example.com/reset-password/abc123token" />
    )

    expect(html).toContain("https://app.example.com/reset-password/abc123token")
    expect(html).toContain("NOMIC")
    expect(html).toContain("1 hora")
  })

  it("nunca incluye el token en un parámetro de query (va en el path)", () => {
    const html = renderToStaticMarkup(<PasswordResetEmail resetUrl="https://app.example.com/reset-password/xyz" />)

    expect(html).not.toContain("?token=")
  })
})
