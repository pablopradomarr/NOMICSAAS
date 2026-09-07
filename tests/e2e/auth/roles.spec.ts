import { expect, test } from "@playwright/test"
import { newIsolatedContext, plantSession, readSeed } from "./support"

/**
 * E13 · T14 — matriz de roles §4.3 y criterio 11 (docs/design/E13-autenticacion.md §8.1), y
 * criterio 12 (cambiar mi contraseña).
 *
 * Las sesiones se plantan directamente en la base (`plantSession`), no por `/enter`: estos
 * tests comprueban autorización y el formulario de perfil, no el login en sí (que ya cubre
 * `login.spec.ts`), y así no gastan presupuesto del rate limit compartido por IP.
 *
 * El caso "VIEWER llama a `sendMemberPasswordResetAction` directamente y recibe el error de
 * rol" se cubre en `tests/integration/e13-auth-actions.test.ts`: una server action de Next no
 * se puede invocar como una API REST corriente desde fuera del árbol de React sin reproducir el
 * protocolo interno de Server Actions, así que la forma fiable de probar "la action, no el
 * botón" es llamarla en proceso, como hace ese test — no una petición HTTP fabricada a mano.
 */

test("un VIEWER recibe 404 en /settings/members y no ve el botón de restablecimiento en ningún otro sitio", async ({
  browser,
  baseURL,
}) => {
  const seed = readSeed()
  const context = await newIsolatedContext(browser, "roles-viewer")
  await plantSession(context, baseURL!, seed.viewer.id, seed.organizationId)
  const page = await context.newPage()

  // `notFound()` de Next.js renderiza el boundary 404 dentro del layout de la app (con
  // sidebar); en `next dev`/Turbopack la respuesta de navegación no siempre trae el código
  // HTTP 404 (aunque el contenido sí lo es), así que el criterio real es el contenido: el
  // encabezado "404" y ninguna funcionalidad de gestión de miembros.
  await page.goto("/settings/members")
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible()
  await expect(page.getByRole("button", { name: /enviar enlace de restablecimiento/i })).toHaveCount(0)

  await context.close()
})

test("un ADMIN sí entra en /settings/members y ve el botón de restablecimiento por fila", async ({
  browser,
  baseURL,
}) => {
  const seed = readSeed()
  const context = await newIsolatedContext(browser, "roles-admin")
  await plantSession(context, baseURL!, seed.admin.id, seed.organizationId)
  const page = await context.newPage()

  const response = await page.goto("/settings/members")
  expect(response?.status()).toBe(200)
  await expect(page.getByRole("button", { name: /enviar enlace de restablecimiento/i }).first()).toBeVisible()

  await context.close()
})

test.describe("criterio 12 — cambiar mi contraseña exige la actual", () => {
  // Entra por `/enter` de verdad (no `plantSession`): la sesión que crea `signIn.email` lleva
  // la cookie de caché (`session_data`) que planta better-auth al iniciar sesión, y es la que
  // exige `revokeOtherSessions` para reconocer, tras el cambio, que la sesión que hizo el
  // cambio sigue siendo válida. Con una sesión sembrada sólo con el token en la base (sin esa
  // caché) `changeMyPasswordAction` deja la página en un estado no autenticado — comprobado con
  // un login real: no reproduce — así que es una limitación del arnés `plantSession`, no un
  // bug de producto, y aquí se evita en vez de darlo por bueno.
  async function loginProfileUser(page: import("@playwright/test").Page, seed: ReturnType<typeof readSeed>) {
    await page.goto("/enter")
    await page.getByLabel("Correo").fill(seed.profileUser.email)
    await page.getByLabel("Contraseña").fill(seed.profileUser.password)
    await page.getByRole("button", { name: /entrar/i }).click()
    await page.waitForURL("**/dashboard", { timeout: 30_000 })
  }

  test("la contraseña actual incorrecta no cambia nada", async ({ browser }) => {
    const seed = readSeed()
    const context = await newIsolatedContext(browser, "roles-profile-wrong")
    const page = await context.newPage()
    await loginProfileUser(page, seed)

    await page.goto("/settings/profile")
    await page.getByLabel("Contraseña actual").fill("no-es-la-actual-123")
    await page.getByLabel("Contraseña nueva", { exact: true }).fill("Cfonomic-Distinta-Clave-1")
    await page.getByLabel("Repite la contraseña nueva").fill("Cfonomic-Distinta-Clave-1")
    await page.getByRole("button", { name: /cambiar contraseña/i }).click()

    await expect(page.getByText("La contraseña actual no es correcta")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Contraseña cambiada")).toHaveCount(0)

    await context.close()
  })

  test("con la contraseña actual correcta, se cambia y se avisa de que se cerraron las demás sesiones", async ({
    browser,
  }) => {
    const seed = readSeed()
    const context = await newIsolatedContext(browser, "roles-profile-ok")
    const page = await context.newPage()
    await loginProfileUser(page, seed)

    await page.goto("/settings/profile")
    await page.getByLabel("Contraseña actual").fill(seed.profileUser.password)
    await page.getByLabel("Contraseña nueva", { exact: true }).fill("Cfonomic-Clave-Nueva-2")
    await page.getByLabel("Repite la contraseña nueva").fill("Cfonomic-Clave-Nueva-2")
    await page.getByRole("button", { name: /cambiar contraseña/i }).click()

    await expect(page.getByText("Contraseña cambiada. Se han cerrado tus otras sesiones.")).toBeVisible({
      timeout: 15_000,
    })
    // La sesión que hizo el cambio sigue siendo válida: la página no ha caído a /enter.
    expect(page.url()).toContain("/settings/profile")

    await context.close()
  })
})
