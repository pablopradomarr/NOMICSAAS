import { expect, test } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { signIn, withDb } from "./session"

/**
 * E2 · T13 (resto de E0) — smoke del plan de cuentas (criterio de aceptación 12).
 *
 * Cubre además el riesgo R2: si la coexistencia de `LedgerAccount` con el
 * `Account` de better-auth hubiera roto la autenticación, el fallo aparecería
 * aquí, al entrar en una pantalla con sesión.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e2-screens"

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
})

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, baseURL ?? "http://localhost:7331")
})

test("el plan de cuentas se abre, se busca y se renombra dejando rastro en la auditoría", async ({ page }) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto("/settings/accounts", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Plan de cuentas" })).toBeVisible()
  await expect(page.getByText(/cuentas en el plan/)).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/01-plan-cuentas.png`, fullPage: true })

  // Búsqueda por código: la lista se reduce a la rama de la 572.
  // `toPass` reintenta: hasta que React hidrata, el `input` controlado descarta
  // lo que se escriba. Es la espera correcta, no un `waitForTimeout`.
  const buscar = page.getByLabel("Buscar cuenta por código o nombre")
  const banco = page.locator('tr[data-account-code="572"]')
  await expect(async () => {
    await buscar.fill("572")
    await expect(banco).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await expect(page.locator('tr[data-account-code="430"]')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/02-busqueda-572.png`, fullPage: true })

  // Renombrado en línea de una subcuenta: doble clic → Enter.
  const objetivo = page.locator('tr[data-account-code="5720"]')
  await expect(objetivo).toBeVisible()
  const nombre = `Banco c/c principal (e2e ${Date.now()})`
  const editor = page.getByLabel("Nombre de la cuenta 5720")
  await expect(async () => {
    await page.locator('[data-account-name="5720"]').dblclick()
    await expect(editor).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await editor.fill(nombre)
  await editor.press("Enter")
  await expect(objetivo.getByText(nombre)).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/03-renombrado.png`, fullPage: true })

  // El renombrado quedó en AuditLog (§7): se comprueba contra la base.
  const registrado = await withDb(async (client) => {
    const { rows } = await client.query<{ after: { name?: string } }>(
      `SELECT after FROM audit_logs
        WHERE entity = 'LedgerAccount' AND action = 'update'
        ORDER BY ts DESC LIMIT 5`
    )
    return rows.some((row) => row.after?.name === nombre)
  })
  expect(registrado, "el renombrado debe aparecer en audit_logs").toBe(true)

  // Y también se ve en la pantalla de auditoría.
  await page.goto("/settings/audit", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Auditoría de cambios" })).toBeVisible()
  await expect(page.getByText(nombre).first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/04-auditoria.png`, fullPage: true })

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
})

test("mapa de cuentas e impuestos se pintan con los datos sembrados", async ({ page }) => {
  await page.goto("/settings/account-map", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Mapa de cuentas de sistema" })).toBeVisible()
  await expect(page.locator('tr[data-account-key="BANCO_DEFAULT"]')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/05-mapa-cuentas.png`, fullPage: true })

  await page.goto("/settings/taxes", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Impuestos" })).toBeVisible()
  await expect(page.locator('tr[data-tax-code="IVA_21"]').first()).toBeVisible()
  // El caso que rompía el modelo anterior: 1,75 % del recargo de labores del tabaco.
  await expect(page.locator('tr[data-tax-code="REQ_1_75"]').first()).toContainText("1,75 %")
  await page.screenshot({ path: `${SHOTS}/06-impuestos.png`, fullPage: true })
})
