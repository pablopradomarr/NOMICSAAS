// E13 · T7 — Test de `PasswordFields` (docs/design/E13-autenticacion.md §8.2, T7).
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PasswordFields } from "./password-fields"

describe("PasswordFields — estado inicial", () => {
  it("pinta los dos campos de contraseña con autocomplete=new-password y sin error asociado", () => {
    const html = renderToStaticMarkup(
      <PasswordFields password="" confirm="" onPasswordChange={() => {}} onConfirmChange={() => {}} />
    )

    const newPasswordCount = (html.match(/autoComplete="new-password"/g) || []).length
    expect(newPasswordCount).toBe(2)
    expect(html).not.toContain("aria-describedby")
    expect(html).not.toContain('aria-invalid="true"')
  })
})

describe("PasswordFields — con error", () => {
  it("enlaza ambos campos al mismo error vía aria-describedby cuando se pasa errorId", () => {
    const html = renderToStaticMarkup(
      <PasswordFields
        password="corta"
        confirm="otra"
        onPasswordChange={() => {}}
        onConfirmChange={() => {}}
        errorId="password-error"
      />
    )

    const describedByCount = (html.match(/aria-describedby="password-error"/g) || []).length
    expect(describedByCount).toBe(2)
    const invalidCount = (html.match(/aria-invalid="true"/g) || []).length
    expect(invalidCount).toBe(2)
  })
})
