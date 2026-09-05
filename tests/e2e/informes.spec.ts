import { expect, test, type Page } from "@playwright/test"
import { createHmac } from "node:crypto"
import { mkdirSync } from "node:fs"
import { adminUserId, APP_ENV, signIn, withDb } from "./session"

/**
 * E6 · T21 — Extremo a extremo de los informes financieros
 * (`docs/design/E6-informes.md` §8.1).
 *
 * Seis recorridos, en serie sobre la organización que tiene el fixture:
 *
 *  1. **Balance**: cuadra a `0,00 €` (I2, tolerancia 0), enseña el sello y trae
 *     la nota de no compensación.
 *  2. **PyG**: `A.4 − resultado del periodo = 0,00 €` (I3) con los cuatro
 *     subtotales oficiales visibles.
 *  3. **Cashflow**: `I6 = 0` en la vista directa y las otras dos vistas se
 *     pintan (indirecto y EFE oficial A–E).
 *  4. **Antigüedad**: los siete tramos, `SIN VENCIMIENTO` visible.
 *  5. **Export XLSX**: se descarga con su `content-type` y un tamaño real.
 *  6. **Forzar revisión**: el siguiente run del periodo cambia de sello y lo
 *     dice con el motivo `REVISION_FORZADA`; al levantarlo, vuelve.
 *  7. **Panel**: los seis KPI y las dos series.
 *
 * El arnés lee la base con el rol PROPIETARIO (`DIRECT_URL`), como el resto de
 * la suite: desde la RLS estricta (ADR-0009) la aplicación conecta como
 * `app_runtime` y una consulta de comprobación sin `app.current_org`
 * devolvería 0 filas.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e6-screens"

test.describe.configure({ mode: "serial" })

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
})

/** Organización con libro diario cargado: la que más líneas tiene. */
async function ledgerOrganization(): Promise<{ id: string; name: string }> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT o.id, o.name
         FROM organizations o
         JOIN journal_lines l ON l.organization_id = o.id
        WHERE o.is_active
        GROUP BY o.id, o.name
        ORDER BY count(*) DESC
        LIMIT 1`
    )
    if (rows.length === 0) {
      throw new Error(
        "Ninguna organización tiene libro diario: ejecuta " +
          "`npx tsx scripts/load-fixture.ts --org <id> --fixture tests/fixtures/ejercicio-completo.json`"
      )
    }
    return rows[0]
  })
}

async function useLedgerOrg(page: Page, baseURL: string, organizationId: string): Promise<void> {
  const secret = APP_ENV.BETTER_AUTH_SECRET
  if (!secret) throw new Error("Falta BETTER_AUTH_SECRET en el entorno de la aplicación")
  const userId = await adminUserId()
  const signature = createHmac("sha256", secret).update(`${organizationId}:${userId}`).digest("base64url")
  await page.context().addCookies([
    {
      name: "taxhacker.active_org",
      value: `${organizationId}.${signature}`,
      domain: new URL(baseURL).hostname,
      path: "/",
      sameSite: "Lax",
    },
  ])
}

test.beforeEach(async ({ page, baseURL }) => {
  const url = baseURL ?? "http://localhost:7331"
  await signIn(page, url)
  const org = await ledgerOrganization()
  await useLedgerOrg(page, url, org.id)
})

test("el balance cuadra a 0,00 €, enseña el sello y la nota de no compensación", async ({ page }) => {
  await page.goto("/reports/balance", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Balance de situación" })).toBeVisible()

  // Sello de validación: siempre presente, valga lo que valga.
  await expect(page.locator("[data-seal]")).toBeVisible()

  await expect(page.getByTestId("balance-activo")).toBeVisible()
  await expect(page.getByTestId("balance-pn")).toBeVisible()
  await expect(page.getByTestId("balance-pasivo")).toBeVisible()

  // I2 con tolerancia 0.
  const check = page.getByTestId("report-balance-check")
  await expect(check).toContainText("Activo − (Pasivo + Patrimonio neto)")
  await expect(check.locator("[data-balance-difference]")).toHaveAttribute("data-balance-difference", "0")
  await expect(check.locator("[data-balance-difference]")).toContainText("0,00")

  // Nota al pie obligatoria: 473 en el activo y 4752 en el pasivo, sin netear.
  await expect(page.getByTestId("balance-nota")).toContainText("Sin compensación de saldos")

  // Cabecera con run_id y ledgerHash.
  await expect(page.getByTestId("report-hashes")).toContainText("ledgerHash")

  await page.screenshot({ path: `${SHOTS}/01-balance.png`, fullPage: true })

  // Drill-down por celda: la primera cifra del activo abre su procedencia.
  await page.getByTestId("balance-activo").locator("tbody button[aria-label^='Detalle']").first().click()
  await expect(page.getByTestId("cell-detail")).toBeVisible()
  await expect(page.getByTestId("cell-accounts")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/02-balance-drilldown.png`, fullPage: true })
  await page.getByRole("button", { name: "Cerrar" }).click()

  // Foto POST_CIERRE: otro `paramsHash`, otro informe.
  await page.selectOption("select[name='foto']", "POST_CIERRE")
  await page.getByRole("button", { name: /Ver informe|Calculando/ }).click()
  await expect(page.getByTestId("report-balance-check").locator("[data-balance-difference]")).toHaveAttribute(
    "data-balance-difference",
    "0"
  )
  await page.screenshot({ path: `${SHOTS}/03-balance-post-cierre.png`, fullPage: true })
})

test("la PyG cuadra A.4 con el resultado del periodo y enseña los subtotales", async ({ page }) => {
  await page.goto("/reports/pyg", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Pérdidas y ganancias" })).toBeVisible()
  await expect(page.locator("[data-seal]")).toBeVisible()

  const table = page.getByTestId("pyg-table")
  await expect(table).toBeVisible()
  // Los cuatro subtotales oficiales.
  await expect(table.locator('[data-subtotal="1"]')).toHaveCount(4)
  await expect(table).toContainText("A.1) RESULTADO DE EXPLOTACIÓN")
  await expect(table).toContainText("A.4) RESULTADO DEL EJERCICIO")

  // I3: A.4 = resultado del periodo, tolerancia 0.
  const check = page.getByTestId("report-balance-check")
  await expect(check.locator("[data-balance-difference]")).toHaveAttribute("data-balance-difference", "0")
  await expect(check.locator("[data-balance-difference]")).toContainText("0,00")

  await page.screenshot({ path: `${SHOTS}/04-pyg.png`, fullPage: true })
})

test("el cashflow concilia I6 a cero y pinta las tres vistas", async ({ page }) => {
  await page.goto("/reports/cashflow", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Cashflow" })).toBeVisible()

  // Cabecera obligatoria: el EFE no forma parte de las cuentas anuales abreviadas.
  await expect(page.getByTestId("cashflow-nota")).toContainText("Informe de gestión")

  const directo = page.getByTestId("cashflow-directo")
  await expect(directo).toBeVisible()
  await expect(page.getByTestId("cashflow-opening")).toBeVisible()
  await expect(page.getByTestId("cashflow-closing")).toBeVisible()

  const i6 = page.getByTestId("cashflow-i6")
  await expect(i6.locator("[data-balance-difference]")).toHaveAttribute("data-balance-difference", "0")
  await expect(i6.locator("[data-balance-difference]")).toContainText("0,00")
  await page.screenshot({ path: `${SHOTS}/05-cashflow-directo.png`, fullPage: true })

  await page.getByTestId("cashflow-tab-indirecto").click()
  await expect(page.getByTestId("cashflow-indirecto")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/06-cashflow-indirecto.png`, fullPage: true })

  await page.getByTestId("cashflow-tab-efe").click()
  await expect(page.getByTestId("cashflow-efe")).toBeVisible()
  await expect(page.getByTestId("cashflow-efe")).toContainText("A) Flujos de efectivo de las actividades de explotación")
  await page.screenshot({ path: `${SHOTS}/07-cashflow-efe.png`, fullPage: true })
})

test("la antigüedad de saldos enseña los tramos con SIN VENCIMIENTO visible", async ({ page }) => {
  await page.goto("/reports/aging", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Antigüedad de saldos" })).toBeVisible()

  const clientes = page.getByTestId("aging-clientes")
  await expect(clientes).toBeVisible()
  // Los siete tramos, con `SIN VENCIMIENTO` el primero y visible.
  await expect(clientes.locator("tr[data-bucket]")).toHaveCount(7)
  await expect(clientes.locator('[data-bucket="SIN_VENCIMIENTO"]')).toBeVisible()
  await expect(clientes.locator('[data-bucket="D_MAS_90"]')).toBeVisible()
  await expect(page.getByTestId("aging-proveedores")).toBeVisible()

  await page.screenshot({ path: `${SHOTS}/08-aging.png`, fullPage: true })
})

test("el histórico lista los runs y el XLSX se descarga con su tipo y tamaño", async ({ page }) => {
  await page.goto("/reports/runs", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Histórico de informes" })).toBeVisible()

  const runs = page.getByTestId("runs-table")
  await expect(runs).toBeVisible()
  await expect(runs.locator("tr[data-run-id]").first()).toBeVisible()

  const href = await runs.locator("tr[data-run-id]").first().locator("[data-testid='export-xlsx']").getAttribute("href")
  expect(href).toBeTruthy()

  const response = await page.request.get(href as string)
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toContain("spreadsheetml")
  const body = await response.body()
  expect(body.byteLength).toBeGreaterThan(1_000)
  // Un XLSX es un ZIP: los dos primeros bytes son `PK`.
  expect(body.subarray(0, 2).toString("latin1")).toBe("PK")

  await page.screenshot({ path: `${SHOTS}/09-runs.png`, fullPage: true })
})

test("forzar la revisión cambia el sello del siguiente informe y levantarla lo devuelve", async ({ page }) => {
  // Sello de partida del balance y periodo con el que se emite.
  await page.goto("/reports/balance", { waitUntil: "networkidle" })
  const cutoff = await page.locator("input[name='corte']").inputValue()
  const year = cutoff.slice(0, 4)
  const before = await page.locator("[data-seal]").getAttribute("data-seal")

  await page.goto("/reports/runs", { waitUntil: "networkidle" })
  await page.getByTestId("force-review").click()
  await page.getByLabel("Periodo desde").fill(`${year}-01-01`)
  await page.getByLabel("Periodo hasta").fill(cutoff)
  await page.selectOption("select[aria-label='Alcance']", "BALANCE")
  await page.getByLabel("Motivo", { exact: true }).fill("Pendiente de conciliar el extracto bancario de diciembre")
  await page.getByRole("button", { name: "Forzar revisión" }).last().click()
  await expect(page.getByTestId("review-flags")).toContainText("Pendiente de conciliar")
  await page.screenshot({ path: `${SHOTS}/10-forzar-revision.png`, fullPage: true })

  // El SIGUIENTE run del balance sale bajo revisión, con el motivo etiquetado.
  await page.goto("/reports/balance", { waitUntil: "networkidle" })
  await expect(page.locator("[data-seal]")).toHaveAttribute("data-seal", "REVISION")
  await expect(page.getByTestId("seal-reasons")).toContainText("REVISION_FORZADA")
  await page.screenshot({ path: `${SHOTS}/11-balance-en-revision.png`, fullPage: true })

  // Levantarlo (no lo borra: lo marca) devuelve el sello de partida.
  await page.goto("/reports/runs", { waitUntil: "networkidle" })
  await page.getByTestId("clear-review").first().click()
  await page.getByLabel("Motivo del levantamiento").fill("Extracto conciliado y diferencias corregidas")
  await page.getByRole("button", { name: "Levantar" }).last().click()
  await expect(page.getByTestId("review-flags")).toContainText("levantado el")

  await page.goto("/reports/balance", { waitUntil: "networkidle" })
  await expect(page.locator("[data-seal]")).toHaveAttribute("data-seal", before ?? "VALIDADO")
})

test("el panel enseña los KPI derivados del diario y las series mensuales", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Panel" })).toBeVisible()
  await expect(page.locator("[data-seal]")).toBeVisible()

  const kpis = page.getByTestId("dashboard-kpis")
  for (const key of ["ingresos", "ebitda", "resultado", "tesoreria", "pendiente-cobro", "pendiente-pago"]) {
    await expect(kpis.locator(`[data-kpi="${key}"]`)).toBeVisible()
  }
  // Toda cifra del panel lleva su badge de confianza.
  await expect(kpis.locator('[data-confidence="calculado"]').first()).toBeVisible()
  // Y ninguna pinta NaN (G-05).
  await expect(page.locator("body")).not.toContainText("NaN")

  await expect(page.getByTestId("chart-ingresos-gastos")).toBeVisible()
  await expect(page.getByTestId("chart-tesoreria")).toBeVisible()
  await expect(page.getByTestId("series-table")).toBeAttached()

  await page.screenshot({ path: `${SHOTS}/12-dashboard.png`, fullPage: true })
})
