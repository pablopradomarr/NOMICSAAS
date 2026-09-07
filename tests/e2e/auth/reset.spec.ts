import { expect, test } from "@playwright/test"
import {
  latestResetToken,
  newIsolatedContext,
  readSeed,
  seedOldSession,
  sessionCount,
  uniqueEmail,
  withDb,
} from "./support"

/**
 * E13 · T14 — criterio 8 (olvido), criterio 9 / S2 / S3 (reset con token) (docs/design/E13-autenticacion.md §8.1).
 *
 * Usa la cuenta dedicada `reset.e2e@nomic.local` (nunca `admin.e2e@nomic.local`): este spec le
 * cambia la contraseña de verdad, y compartir la cuenta con `login.spec.ts` la dejaría en un
 * estado impredecible para el resto de la suite. `global-setup.ts` la reescribe en cada
 * ejecución (`RESET_USER_INITIAL_PASSWORD`), así que el spec es repetible.
 */

test.describe("criterio 8 / S1 — /forgot-password responde igual exista o no la cuenta", () => {
  test("misma respuesta para un email con cuenta y uno inventado", async ({ browser }) => {
    const seed = readSeed()

    const ctxKnown = await newIsolatedContext(browser, "forgot-known")
    const known = await ctxKnown.request.post("/api/auth/request-password-reset", {
      data: { email: seed.resetUser.email, redirectTo: "/reset-password" },
    })

    const ctxUnknown = await newIsolatedContext(browser, "forgot-unknown")
    const unknown = await ctxUnknown.request.post("/api/auth/request-password-reset", {
      data: { email: uniqueEmail("no-existe"), redirectTo: "/reset-password" },
    })

    expect(known.status()).toBe(unknown.status())
    expect(known.ok()).toBe(true)

    // Sólo la cuenta que existe deja un token en `verification`: es la única prueba
    // observable de la asimetría real sin depender de Resend (no hay proveedor en el arnés).
    const token = await latestResetToken(seed.resetUser.id)
    expect(token).toBeTruthy()

    await ctxKnown.close()
    await ctxUnknown.close()
  })

  test("la UI muestra el mismo texto de confirmación", async ({ browser }) => {
    const context = await newIsolatedContext(browser, "forgot-ui")
    const page = await context.newPage()
    await page.goto("/forgot-password")
    await page.getByLabel("Correo").fill(uniqueEmail("ui-desconocido"))
    await page.getByRole("button", { name: /enviar enlace/i }).click()
    await expect(page.getByText("Te hemos enviado un enlace si esa dirección tiene cuenta")).toBeVisible()
    await context.close()
  })
})

test.describe("criterio 9 / S2 / S3 — reset con token", () => {
  test("fijar la contraseña nueva revoca las sesiones anteriores, permite entrar con ella y el token no se reutiliza", async ({
    browser,
  }) => {
    const seed = readSeed()

    // Una sesión "anterior" a la que el reset debe dejar sin efecto (S2).
    const oldSessionToken = await seedOldSession(seed.resetUser.id)
    const sessionsBeforeReset = await sessionCount(seed.resetUser.id)
    expect(sessionsBeforeReset).toBeGreaterThanOrEqual(1)

    const requestCtx = await newIsolatedContext(browser, "reset-request")
    const requested = await requestCtx.request.post("/api/auth/request-password-reset", {
      data: { email: seed.resetUser.email, redirectTo: "/reset-password" },
    })
    expect(requested.ok()).toBe(true)
    await requestCtx.close()

    const token = await latestResetToken(seed.resetUser.id)
    const newPassword = "ResetE2E-Nueva-Passw0rd2"

    const uiContext = await newIsolatedContext(browser, "reset-ui")
    const page = await uiContext.newPage()
    await page.goto(`/reset-password/${token}`)
    await page.getByLabel("Contraseña nueva").fill(newPassword)
    await page.getByLabel("Repite la contraseña").fill(newPassword)
    await page.getByRole("button", { name: /guardar contraseña/i }).click()
    await expect(page.getByText("Contraseña actualizada. Ya puedes entrar con ella.")).toBeVisible({
      timeout: 30_000,
    })
    await uiContext.close()

    // S2 — la sesión "anterior" ya no existe en absoluto.
    const stillThere = await withDb(async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM sessions WHERE token = $1`, [oldSessionToken])
      return rows.length > 0
    })
    expect(stillThere).toBe(false)

    // Se puede entrar con la contraseña nueva.
    const loginCtx = await newIsolatedContext(browser, "reset-login")
    const loginPage = await loginCtx.newPage()
    await loginPage.goto("/enter")
    await loginPage.getByLabel("Correo").fill(seed.resetUser.email)
    await loginPage.getByLabel("Contraseña").fill(newPassword)
    await loginPage.getByRole("button", { name: /entrar/i }).click()
    await loginPage.waitForURL("**/dashboard", { timeout: 30_000 })
    await loginCtx.close()

    // S3 — el mismo token ya no sirve una segunda vez.
    const reuseCtx = await newIsolatedContext(browser, "reset-reuse")
    const reused = await reuseCtx.request.post("/api/auth/reset-password", {
      data: { newPassword: "OtraPassw0rd-Distinta1", token },
    })
    expect(reused.ok()).toBe(false)
    await reuseCtx.close()
  })
})
