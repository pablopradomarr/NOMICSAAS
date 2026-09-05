import { expect, test, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { signIn, withDb } from "./session"

/**
 * E3 · T15 — Extremo a extremo del libro diario (criterio de aceptación 18).
 *
 * El recorrido completo de la épica desde el navegador: abrir un ejercicio,
 * contabilizar un asiento manual cuadrado, comprobar que uno descuadrado NO se
 * puede contabilizar (botón deshabilitado y diferencia a la vista), anular con
 * motivo y ver el contra-asiento, y terminar en sumas y saldos con el sello y
 * la fila de cuadre a 0,00 €.
 *
 * El arnés lee la base con el rol PROPIETARIO (`DIRECT_URL`), como en
 * `plan-cuentas.spec.ts`: desde la RLS estricta (ADR-0009) la aplicación
 * conecta como `app_runtime` y una consulta de comprobación sin
 * `app.current_org` devolvería 0 filas.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e3-screens"
const YEAR = new Date().getUTCFullYear()
const FY_CODE = String(YEAR)

test.describe.configure({ mode: "serial" })

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
})

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, baseURL ?? "http://localhost:7331")
})

/** Fecha contable del smoke: hoy, que siempre cae dentro del ejercicio en curso. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Deja abierto el ejercicio del año en curso, creándolo por la UI si falta. */
async function ensureFiscalYear(page: Page): Promise<void> {
  await page.goto("/settings/fiscal-years", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Ejercicios" })).toBeVisible()

  const existing = page.locator(`[data-fiscal-year-code="${FY_CODE}"]`)
  if ((await existing.count()) > 0) return

  await expect(async () => {
    await page.getByLabel("Etiqueta del ejercicio").fill(FY_CODE)
    await expect(page.getByLabel("Etiqueta del ejercicio")).toHaveValue(FY_CODE, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByLabel("Inicio del ejercicio").fill(`${FY_CODE}-01-01`)
  await page.getByLabel("Fin del ejercicio").fill(`${FY_CODE}-12-31`)
  await page.getByRole("button", { name: "Crear ejercicio" }).click()
  await expect(existing).toBeVisible({ timeout: 20_000 })
}

/** Rellena una línea del asiento manual. */
async function fillLine(page: Page, index: number, account: string, debit: string, credit: string): Promise<void> {
  const combo = page.getByLabel(`Cuenta de la línea ${index}`)
  await expect(async () => {
    await combo.fill(account)
    await expect(combo).toHaveValue(new RegExp(`^${account}`), { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  // El desplegable tapa la fila siguiente: se cierra antes de seguir.
  await combo.press("Escape")
  if (debit) await page.getByLabel(`Debe de la línea ${index}`).fill(debit)
  if (credit) await page.getByLabel(`Haber de la línea ${index}`).fill(credit)
}

/** E4 · T15 — destino analítico de una línea 6/7 (proyecto o centro de coste). */
async function fillDimension(page: Page, index: number, code: string): Promise<void> {
  const combo = page.getByLabel(`Destino analítico de la línea ${index}`)
  await expect(combo).toBeVisible()
  await combo.fill(code)
  await page.getByRole("option", { name: new RegExp(code) }).first().click()
  await expect(combo).toHaveValue(new RegExp(`^${code}`))
}

test("un asiento manual cuadrado se contabiliza, se anula con contra-asiento y sumas y saldos cuadra", async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    // DEUDA (docs/ESTADO.md): pg@8 emite un DeprecationWarning ("client is already executing a query")
    // cuando @prisma/adapter-pg resuelve un include multi-relación dentro de la transacción de tenantDb.
    // No es un error de la app; se excluye hasta actualizar el adapter (issue upstream).
    if (message.type() === "error" && !/DeprecationWarning|already executing a query/.test(message.text()))
      consoleErrors.push(message.text())
  })

  // ── 1. Ejercicio abierto ───────────────────────────────────────────────────
  await ensureFiscalYear(page)
  await page.screenshot({ path: `${SHOTS}/01-ejercicios.png`, fullPage: true })

  // ── 2. Asiento DESCUADRADO: el botón no se habilita ────────────────────────
  await page.goto("/ledger/new", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Nuevo asiento" })).toBeVisible()

  const concepto = `Venta e2e ${Date.now()}`
  await expect(async () => {
    await page.getByLabel("Concepto del asiento").fill(concepto)
    await expect(page.getByLabel("Concepto del asiento")).toHaveValue(concepto, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByLabel("Fecha del documento").fill(today())

  await fillLine(page, 1, "4300", "1.210,00", "")
  await fillLine(page, 2, "705", "", "1.000,00")

  // E4 · C-9 — desde la analítica, una línea de grupo 6/7 necesita destino:
  // `validateAnalytics` rechaza el asiento sin él (`ANALYTIC_DEST_MISSING`).
  await fillDimension(page, 2, "CC-GA")

  const diferencia = page.getByTestId("preview-difference")
  await expect(diferencia).toContainText("210,00")
  await expect(diferencia).toContainText("descuadrado")
  await expect(page.getByTestId("post-entry")).toBeDisabled()
  await expect(page.getByTestId("post-disabled-reason")).toContainText("descuadrado")
  await page.screenshot({ path: `${SHOTS}/02-descuadrado.png`, fullPage: true })

  // ── 3. Se cuadra con el IVA repercutido y se contabiliza ───────────────────
  await page.getByRole("button", { name: "Añadir línea" }).click()
  await fillLine(page, 3, "477", "", "210,00")

  await expect(diferencia).toContainText("0,00")
  await expect(diferencia).toContainText("cuadrado")
  await expect(page.getByTestId("post-entry")).toBeEnabled()
  await page.screenshot({ path: `${SHOTS}/03-cuadrado.png`, fullPage: true })

  await page.getByTestId("post-entry").click()

  // El posteo redirige al detalle del asiento con su número correlativo.
  await page.waitForURL(/\/ledger\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  await expect(page.getByRole("heading", { name: /Asiento nº/ })).toBeVisible()
  const heading = await page.getByRole("heading", { name: /Asiento nº/ }).innerText()
  const entryNumber = Number(heading.replace(/\D+/g, ""))
  expect(entryNumber, "el asiento debe llevar número correlativo").toBeGreaterThan(0)
  await expect(page.getByTestId("entry-lines")).toContainText("1.210,00")
  await page.screenshot({ path: `${SHOTS}/04-asiento-detalle.png`, fullPage: true })

  // ── 4. Aparece en el diario con su número ──────────────────────────────────
  await page.goto("/ledger", { waitUntil: "networkidle" })
  const fila = page.locator(`tr[data-entry-number="${entryNumber}"]`)
  await expect(fila).toBeVisible()
  await expect(fila).toContainText(concepto)
  await expect(fila).toContainText("1.210,00")
  await page.screenshot({ path: `${SHOTS}/05-diario.png`, fullPage: true })

  // El cuadre lo garantiza la base, no la pantalla: se comprueba contra ella.
  const enBase = await withDb(async (client) => {
    const { rows } = await client.query<{ debe: string; haber: string }>(
      `SELECT SUM(l.debit_cents)::text AS debe, SUM(l.credit_cents)::text AS haber
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.description = $1`,
      [concepto]
    )
    return rows[0]
  })
  expect(enBase.debe).toBe("121000")
  expect(enBase.haber).toBe("121000")

  // ── 5. Anulación con motivo → contra-asiento ───────────────────────────────
  await fila.getByRole("link", { name: String(entryNumber) }).click()
  await page.waitForURL(/\/ledger\/[0-9a-f-]{36}$/)
  await page.getByTestId("void-entry").click()
  await page.getByLabel("Motivo de la anulación").fill("Factura duplicada del cliente en el e2e")
  await page.getByTestId("confirm-void").click()

  // El contra-asiento nace con su propio número y enseña a quién anula.
  await expect(page.locator('[data-badge="contra-asiento"]')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-badge="contra-asiento"]')).toContainText(`Anula el nº ${entryNumber}`)
  await page.screenshot({ path: `${SHOTS}/06-contra-asiento.png`, fullPage: true })

  // El anulado sigue en el diario, marcado, junto a su contra-asiento (I-E3-3).
  await page.goto("/ledger", { waitUntil: "networkidle" })
  await expect(fila.locator('[data-badge="anulado"]')).toBeVisible()
  await expect(page.locator('[data-badge="contra-asiento"]').first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/07-diario-anulado.png`, fullPage: true })

  // ── 6. Sumas y saldos: sello y fila de cuadre a 0,00 € ─────────────────────
  await page.goto("/ledger/sumas-saldos", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Balance de sumas y saldos" })).toBeVisible()
  await expect(page.locator("[data-seal]")).toBeVisible()

  const cuadre = page.getByTestId("report-balance-check")
  await expect(cuadre).toBeVisible()
  await expect(cuadre.locator("[data-balance-difference]")).toHaveAttribute("data-balance-difference", "0")
  await expect(cuadre).toContainText("0,00")
  await expect(cuadre).toContainText("✓")

  // El botón "Ver validación" lista los invariantes de la épica.
  await page.getByRole("button", { name: /Ver validación/ }).click()
  await expect(page.getByTestId("check-list")).toBeVisible()
  await expect(page.locator('[data-check-id="I1"]')).toBeVisible()
  await expect(page.locator('[data-check-id="I7"]')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/08-sumas-saldos-validacion.png`, fullPage: true })
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("check-list")).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/09-sumas-saldos.png`, fullPage: true })

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([])
})

test("el mayor de una cuenta enseña saldo inicial, movimientos y saldo final", async ({ page }) => {
  await page.goto("/ledger/mayor?account=4300", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Libro mayor" })).toBeVisible()
  await expect(page.locator("[data-seal]")).toBeVisible()
  await expect(page.getByTestId("opening-balance").first()).toBeVisible()
  await expect(page.getByTestId("closing-balance").first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/10-mayor.png`, fullPage: true })
})

test("el formulario de una plantilla se genera de su schema y previsualiza el asiento con su IVA", async ({ page }) => {
  await ensureFiscalYear(page)

  await page.goto("/ledger/new", { waitUntil: "networkidle" })
  await page.locator('[data-template-code="FACTURA_EMITIDA_SERVICIOS"]').click()
  await page.waitForURL(/\/ledger\/new\/FACTURA_EMITIDA_SERVICIOS$/)
  await expect(page.getByTestId("template-form")).toBeVisible()

  // Los campos NO están escritos a mano en la pantalla: salen del schema zod de
  // la plantilla (`lib/ledger/templates/schemas.ts`).
  const numero = `E2E-${Date.now()}`
  await expect(async () => {
    await page.getByLabel("Número de documento").fill(numero)
    await expect(page.getByLabel("Número de documento")).toHaveValue(numero, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByLabel("Fecha del documento").fill(today())
  await page.getByLabel("Base imponible").first().fill("1.000,00")
  await page.getByLabel("Tipo impositivo").first().selectOption({ value: "IVA_21" })
  await page.getByLabel("Total del documento").fill("1.210,00")

  // E4 · C-9 — la línea de ingreso de la plantilla necesita destino analítico:
  // el combobox de dimensión sale del mismo schema zod que el resto de campos.
  const ceco = page.getByLabel("Centro de coste").first()
  await ceco.fill("CC-GA")
  await page.getByRole("option", { name: /CC-GA/ }).first().click()
  await expect(ceco).toHaveValue(/^CC-GA/)

  await page.getByTestId("preview-entry").click()

  // El desglose del impuesto lo calcula el servidor, no el navegador.
  const preview = page.getByTestId("entry-preview")
  await expect(preview).toBeVisible({ timeout: 30_000 })
  await expect(preview).toContainText("1.210,00")
  await expect(preview).toContainText("210,00")
  await expect(preview).toContainText("1.000,00")
  await page.screenshot({ path: `${SHOTS}/11-plantilla-vista-previa.png`, fullPage: true })
})
