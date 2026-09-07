import { expect, test } from "@playwright/test"
import { newIsolatedContext, readSeed, sessionCount, uniqueEmail } from "./support"

/**
 * E13 · T14 — criterios 1, 2 y 3 (docs/design/E13-autenticacion.md §8.1) sobre `SELF_HOSTED_MODE=false`.
 *
 * Cada test usa un contexto de navegador AISLADO con una `x-forwarded-for` propia
 * (`newIsolatedContext`): el rate limit de `lib/auth-rate-limit.ts` es por IP y por
 * email, en memoria del proceso — sin aislar la IP, los 10 intentos/10 min del
 * bucket de IP se agotarían con la suma de TODOS los tests del fichero, no sólo
 * con los del test que de verdad quiere probar el límite.
 */

test.describe("criterio 1 — login correcto", () => {
  test("email + contraseña correctos crean sesión y aterrizan en /dashboard", async ({ browser }) => {
    const seed = readSeed()
    const before = await sessionCount(seed.admin.id)

    const context = await newIsolatedContext(browser, "login-ok")
    const page = await context.newPage()
    await page.goto("/enter")
    await page.getByLabel("Correo").fill(seed.admin.email)
    await page.getByLabel("Contraseña").fill(seed.admin.password)
    await page.getByRole("button", { name: /entrar/i }).click()

    await page.waitForURL("**/dashboard", { timeout: 30_000 })
    expect(page.url()).toContain("/dashboard")

    const after = await sessionCount(seed.admin.id)
    expect(after).toBeGreaterThan(before)

    const cookies = await context.cookies()
    expect(cookies.some((c) => c.name === "taxhacker.session_token")).toBe(true)

    await context.close()
  })
})

test.describe("criterio 2 / S1 — login incorrecto: mismo mensaje y mismo código", () => {
  test("contraseña incorrecta y email inexistente responden EXACTAMENTE igual", async ({ browser }) => {
    const seed = readSeed()

    const ctxWrongPassword = await newIsolatedContext(browser, "login-ko-password")
    const wrongPassword = await ctxWrongPassword.request.post("/api/auth/sign-in/email", {
      data: { email: seed.admin.email, password: "una-contraseña-que-no-es-1" },
    })

    const ctxUnknownEmail = await newIsolatedContext(browser, "login-ko-unknown")
    const unknownEmail = await ctxUnknownEmail.request.post("/api/auth/sign-in/email", {
      data: { email: uniqueEmail("no-existe"), password: "cualquier-contraseña-12" },
    })

    expect(wrongPassword.status()).toBe(unknownEmail.status())
    expect(wrongPassword.status()).toBe(401)

    const bodyWrongPassword = await wrongPassword.json()
    const bodyUnknownEmail = await unknownEmail.json()
    expect(bodyWrongPassword.message).toBe(bodyUnknownEmail.message)
    expect(bodyWrongPassword.code).toBe(bodyUnknownEmail.code)

    await ctxWrongPassword.close()
    await ctxUnknownEmail.close()
  })

  test("un usuario invitado que NUNCA fijó contraseña recibe el mismo mensaje (§2.3)", async ({ browser }) => {
    // No requiere sembrar nada: el email simplemente no tiene fila `account` con
    // provider `credential`, que es justo el caso de un usuario preexistente sin
    // migrar (§2.3): "ningún usuario sin contraseña puede entrar".
    const ctx = await newIsolatedContext(browser, "login-ko-nopassword")
    const response = await ctx.request.post("/api/auth/sign-in/email", {
      data: { email: uniqueEmail("sin-password"), password: "cualquier-contraseña-12" },
    })
    expect(response.status()).toBe(401)
    await ctx.close()
  })

  test("la UI muestra el mensaje genérico único ante credenciales incorrectas", async ({ browser }) => {
    const seed = readSeed()
    const context = await newIsolatedContext(browser, "login-ko-ui")
    const page = await context.newPage()
    await page.goto("/enter")
    await page.getByLabel("Correo").fill(seed.admin.email)
    await page.getByLabel("Contraseña").fill("contraseña-incorrecta-123")
    await page.getByRole("button", { name: /entrar/i }).click()

    await expect(page.getByText("Correo o contraseña incorrectos")).toBeVisible()
    expect(page.url()).not.toContain("/dashboard")
    await context.close()
  })
})

test.describe("criterio 3 — rate limit por email", () => {
  test("el sexto intento fallido en 15 minutos responde 429 sin mirar la contraseña", async ({ browser }) => {
    const email = uniqueEmail("rate-limit")
    const context = await newIsolatedContext(browser, "login-rate-limit")

    let last: { status: number; body: { message?: string } } | null = null
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const response = await context.request.post("/api/auth/sign-in/email", {
        data: { email, password: `contraseña-mala-${attempt}` },
      })
      last = { status: response.status(), body: await response.json() }
    }

    expect(last?.status).toBe(429)
    expect(last?.body.message).toContain("Demasiados intentos")

    await context.close()
  })
})
