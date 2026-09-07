// E13 · T5 — Test de render del kit de marca CFOnomic.
//
// El proyecto no tiene @testing-library instalado (comprobado en package.json), así que este es el
// "test de snapshot mínimo" que pide el diseño: cada componente se renderiza a marcado estático con
// `react-dom/server` y se comprueban las propiedades de marca y accesibilidad que no deben regresar
// (tokens de color, tipografías, `role="alert"`, label asociado, etc).
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AuthShell, AuthWordmark } from "./auth-shell"
import { AuthHeadline } from "./auth-headline"
import { LineInput } from "./line-input"
import { PrimaryButton, GhostButton } from "./primary-button"
import { ChipLabel } from "./chip-label"
import { AuthError, AuthSuccess } from "./auth-message"
import { BRAND } from "./constants"

describe("AuthShell", () => {
  it("centra el contenido en un ancho máximo y sin card/sombra", () => {
    const html = renderToStaticMarkup(
      <AuthShell>
        <p>contenido</p>
      </AuthShell>
    )
    expect(html).toContain("max-w-[420px]")
    expect(html).not.toContain("shadow")
    expect(html).toContain("contenido")
  })
})

describe("AuthWordmark", () => {
  it("muestra NOMIC como producto y 'de CFOnomic' debajo, sin lima sobre texto", () => {
    const html = renderToStaticMarkup(<AuthWordmark />)
    expect(html).toContain(BRAND.product)
    expect(html).toContain(">CFO<")
    expect(html).toContain(">nomic<")
    // El lima nunca lleva texto encima dentro de (auth) (§6.3): el wordmark no usa --nomic-lime.
    expect(html).not.toContain("nomic-lime")
  })
})

describe("AuthHeadline", () => {
  it("lleva una palabra en itálica y el punto final en lima", () => {
    const html = renderToStaticMarkup(<AuthHeadline accent="contabilidad">Entra en tu</AuthHeadline>)
    expect(html).toContain("<em")
    expect(html).toContain("italic")
    expect(html).toContain("contabilidad")
    expect(html).toContain("nomic-lime")
    expect(html).toContain(">.<") // el punto va en su propio span
  })
})

describe("LineInput", () => {
  it("asocia el label por htmlFor/id y no dibuja borde salvo la línea inferior", () => {
    const html = renderToStaticMarkup(<LineInput label="Correo" name="email" type="email" />)
    expect(html).toContain('for="email"')
    expect(html).toContain('id="email"')
    expect(html).toContain("border-0")
    expect(html).toContain("border-b")
    expect(html).toContain("CORREO".toUpperCase() === "CORREO" ? "Correo" : "Correo") // label visible en el markup
  })

  it("enlaza el error vía aria-describedby cuando se pasa errorId", () => {
    const html = renderToStaticMarkup(<LineInput label="Correo" name="email" errorId="email-error" />)
    expect(html).toContain('aria-describedby="email-error"')
    expect(html).toContain('aria-invalid="true"')
  })
})

describe("PrimaryButton / GhostButton", () => {
  it("el primario es negro con texto blanco y flecha", () => {
    const html = renderToStaticMarkup(<PrimaryButton type="submit">ENTRAR</PrimaryButton>)
    expect(html).toContain("nomic-black")
    expect(html).toContain("nomic-white")
    expect(html).toContain("ENTRAR")
    expect(html).toContain("→")
    expect(html).toContain("uppercase")
  })

  it("el ghost lleva borde en vez de fondo", () => {
    const html = renderToStaticMarkup(<GhostButton type="button">CANCELAR</GhostButton>)
    expect(html).toContain("border-[var(--nomic-black)]")
    expect(html).toContain("bg-transparent")
  })

  it("puede ocultar la flecha (estado enviando)", () => {
    const html = renderToStaticMarkup(
      <PrimaryButton type="submit" hideArrow disabled>
        ENTRANDO…
      </PrimaryButton>
    )
    expect(html).not.toContain("→")
    expect(html).toContain("disabled")
  })
})

describe("ChipLabel", () => {
  it("usa JetBrains Mono y borde fino", () => {
    const html = renderToStaticMarkup(<ChipLabel>INVITACIÓN · EDITOR</ChipLabel>)
    expect(html).toContain("jetbrains-mono")
    expect(html).toContain("uppercase")
    expect(html).toContain("INVITACIÓN")
  })
})

describe("AuthError / AuthSuccess", () => {
  it("el error lleva role=alert y prefijo de aviso, nunca rojo", () => {
    const html = renderToStaticMarkup(<AuthError id="form-error">Correo o contraseña incorrectos</AuthError>)
    expect(html).toContain('role="alert"')
    expect(html).toContain("⚠")
    expect(html).toContain('id="form-error"')
    expect(html).not.toMatch(/text-red|bg-red|#f5a623|#dc2626/i)
  })

  it("el éxito usa role=status sin prefijo de aviso", () => {
    const html = renderToStaticMarkup(<AuthSuccess>Te hemos enviado un enlace si esa dirección tiene cuenta</AuthSuccess>)
    expect(html).toContain('role="status"')
    expect(html).not.toContain("⚠")
  })
})
