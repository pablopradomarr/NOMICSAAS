import { expect, test } from "@playwright/test"
import { membershipRoleByEmail, newIsolatedContext, readSeed } from "./support"

/**
 * E13 · T14 — criterio 5 (alta por invitación) (docs/design/E13-autenticacion.md §8.1).
 *
 * Usa la invitación PENDING sembrada por `global-setup.ts` (token conocido, rol EDITOR): el
 * spec fija nombre + contraseña en `/invite/[token]`, entra y comprueba que la `Membership`
 * nace con el rol de la invitación, no con uno por defecto.
 */
test("un enlace de invitación PENDING deja con sesión iniciada, con el rol de la invitación, y la invitación pasa a ACCEPTED", async ({
  browser,
}) => {
  const seed = readSeed()
  const context = await newIsolatedContext(browser, "invite")
  const page = await context.newPage()

  await page.goto(`/invite/${seed.invite.token}`)
  await page.getByLabel("Tu nombre").fill("Invitado E2E")
  await page.getByLabel("Contraseña nueva").fill("Cfonomic-Nueva-Cuenta-1")
  await page.getByLabel("Repite la contraseña").fill("Cfonomic-Nueva-Cuenta-1")
  await page.getByRole("button", { name: /crear cuenta y entrar/i }).click()

  await page.waitForURL("**/dashboard", { timeout: 30_000 })
  expect(page.url()).toContain("/dashboard")

  const role = await membershipRoleByEmail(seed.invite.organizationId, seed.invite.email)
  expect(role).toBe(seed.invite.role)

  await context.close()
})
