// E13 · T6 — Test de `LoginForm` (docs/design/E13-autenticacion.md §6, §8.1 criterios 1-3).
//
// El proyecto no tiene @testing-library/jsdom (entorno "node" en vitest.config.ts), así que,
// igual que `components/auth/brand/brand.test.tsx`, el estado inicial se comprueba con
// `renderToStaticMarkup` y el estado de error se comprueba sobre la función pura
// `resolveLoginError` que decide exactamente el texto que el formulario pondría en `AuthError`.
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { GENERIC_LOGIN_ERROR, LoginForm, resolveLoginError } from "./login-form"

/** `LoginForm` llama a `useRouter()` (redirección tras login); fuera de Next hace falta este stub. */
const stubRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
} as unknown as Parameters<typeof AppRouterContext.Provider>[0]["value"]

function renderWithRouter(node: React.ReactElement): string {
  return renderToStaticMarkup(<AppRouterContext.Provider value={stubRouter}>{node}</AppRouterContext.Provider>)
}

describe("LoginForm — estado inicial", () => {
  it("pinta email y contraseña con autocomplete, el enlace de olvido y sin error visible", () => {
    const html = renderWithRouter(<LoginForm />)

    expect(html).toContain('type="email"')
    expect(html).toContain('autoComplete="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="current-password"')
    expect(html).toContain("/forgot-password")
    expect(html).toContain("¿Has olvidado tu contraseña?")
    expect(html).toContain("ENTRAR")
    expect(html).not.toContain('role="alert"')
  })

  it("precarga el email cuando se pasa defaultEmail", () => {
    const html = renderWithRouter(<LoginForm defaultEmail="ana@example.com" />)
    expect(html).toContain("ana@example.com")
  })
})

describe("resolveLoginError — estado de error (criterio 2, S1)", () => {
  it("sin error del servidor, usa el genérico", () => {
    expect(resolveLoginError(null)).toBe(GENERIC_LOGIN_ERROR)
    expect(resolveLoginError(undefined)).toBe(GENERIC_LOGIN_ERROR)
  })

  it("contraseña incorrecta, email inexistente o usuario sin contraseña: el MISMO genérico", () => {
    expect(resolveLoginError({ status: 401, message: "Invalid password" })).toBe(GENERIC_LOGIN_ERROR)
    expect(resolveLoginError({ status: 401, message: "User not found" })).toBe(GENERIC_LOGIN_ERROR)
    expect(resolveLoginError({ status: 422 })).toBe(GENERIC_LOGIN_ERROR)
  })

  it("límite de intentos (429): sí se distingue con el mensaje del servidor", () => {
    expect(resolveLoginError({ status: 429, message: "Demasiados intentos. Vuelve a probar en unos minutos" })).toBe(
      "Demasiados intentos. Vuelve a probar en unos minutos"
    )
  })

  it("429 sin mensaje del servidor: cae en el genérico, nunca queda vacío", () => {
    expect(resolveLoginError({ status: 429 })).toBe(GENERIC_LOGIN_ERROR)
  })
})
