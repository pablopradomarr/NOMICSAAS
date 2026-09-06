import { expect, test, type Page } from "@playwright/test"
import { createHmac } from "node:crypto"
import { mkdirSync } from "node:fs"
import { adminUserId, analyticsOrganization, APP_ENV, signIn, withDb } from "./session"

/**
 * E4 · T16 — Extremo a extremo de la analítica (`docs/design/E4-analitica.md` §8.1).
 *
 * Tres recorridos, en serie sobre la misma organización:
 *
 *  1. **PyG analítica**: la matriz se pinta con su sello y la fila de cuadre
 *     `Σ columnas (RESULTADO) − PyG contable` a **0,00 €** (I4, tolerancia 0).
 *  2. **Alta de proyecto** desde `/analytics/projects` y su aparición como
 *     columna del informe.
 *  3. **Reclasificación analítica** de una línea 6/7 desde la ficha del
 *     proyecto: queda en `AuditLog` con `RECLASSIFY_ANALYTICS`, el `entryHash`
 *     del asiento **cambia** y el `ledgerHash` del periodo **no** (E4-D2).
 *
 * El arnés lee la base con el rol PROPIETARIO (`DIRECT_URL`), como el resto de
 * la suite: desde la RLS estricta (ADR-0009) la aplicación conecta como
 * `app_runtime` y una consulta de comprobación sin `app.current_org` devolvería
 * 0 filas.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e4-screens"
const STAMP = Date.now().toString().slice(-6)
const PROJECT_CODE = `E2E-${STAMP}`

test.describe.configure({ mode: "serial" })

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true })
})

/**
 * Organización con analítica cargada: la que más líneas de diario tiene
 * imputadas a un proyecto. Es la que siembra
 * `npx tsx scripts/load-fixture.ts --fixture tests/fixtures/ejercicio-completo.json`.
 */

/**
 * Deja activa la organización con analítica plantando la cookie de organización
 * activa, con la misma firma que `signActiveOrgCookie` (`lib/authz-core.ts`).
 * La cookie es un HINT: `requireOrg` sigue comprobando la Membership, así que
 * esto no se salta ninguna barrera, sólo evita conducir el desplegable.
 */
async function useAnalyticsOrg(page: Page, baseURL: string, organizationId: string): Promise<void> {
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
  const org = await analyticsOrganization()
  await useAnalyticsOrg(page, url, org.id)
})

/** `run_id … ledgerHash … analyticsHash …` de la cabecera del informe. */
async function reportHashes(page: Page): Promise<string> {
  const text = await page.getByTestId("report-hashes").innerText()
  return text.replace(/run_id\s+\S+/, "").trim()
}

test("la PyG analítica se pinta con sello y la fila de cuadre a 0,00 €", async ({ page }) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto("/analytics/pyg", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Pérdidas y ganancias analítica" })).toBeVisible()

  // Sello de validación: siempre presente, valga lo que valga.
  await expect(page.locator("[data-seal]")).toBeVisible()

  // Matriz con las tres familias de columna y el total.
  const matrix = page.getByTestId("margin-matrix")
  await expect(matrix).toBeVisible()
  await expect(matrix.locator('[data-column-kind="project"]').first()).toBeVisible()
  await expect(matrix.locator('[data-column-kind="businessLine"]').first()).toBeVisible()
  await expect(matrix.locator('[data-column-kind="total"]')).toBeVisible()
  await expect(matrix.locator('[data-row-id="RESULTADO"]')).toBeVisible()
  await expect(matrix.locator('[data-row-id="%MC1"]')).toBeVisible()

  // Cuadre I4: tolerancia 0.
  const check = page.getByTestId("matrix-balance-check")
  await expect(check).toContainText("Σ columnas (RESULTADO) − PyG contable")
  await expect(check.locator("[data-balance-difference]")).toHaveAttribute("data-balance-difference", "0")
  await expect(check.locator("[data-balance-difference]")).toContainText("0,00")

  // Los tres sellos de E4-D2 en la cabecera.
  const hashes = page.getByTestId("report-hashes")
  await expect(hashes).toContainText("ledgerHash")
  await expect(hashes).toContainText("analyticsHash")
  await expect(hashes).toContainText("marginConfigHash")

  await page.screenshot({ path: `${SHOTS}/01-pyg-analitica.png`, fullPage: true })

  // Drill-down por celda: provenance + líneas del diario.
  await matrix.locator('[data-row-id="MC1"] button').first().click()
  await expect(page.getByTestId("cell-lines")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/02-drill-down.png`, fullPage: true })
  await page.getByRole("button", { name: "Cerrar" }).click()

  // "Ver validación" con I4 y los I-E4-*.
  await page.getByRole("button", { name: /Ver validación/ }).click()
  await expect(page.getByTestId("check-list")).toBeVisible()
  await expect(page.locator('[data-check-id="I4"]')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/03-validacion.png`, fullPage: true })
  await page.keyboard.press("Escape")

  // Vista transpuesta: proyectos en filas.
  await page.getByTestId("toggle-transpose").click()
  await page.waitForURL(/vista=transpuesta/, { timeout: 30_000 })
  await expect(page.getByTestId("margin-matrix")).toBeVisible()
  await expect(page.getByTestId("margin-matrix").locator("thead th").first()).toHaveText("Proyecto / centro")
  await expect(page.getByTestId("margin-matrix").locator('[data-row-id^="PROJ:"]').first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/04-pyg-transpuesta.png`, fullPage: true })

  expect(consoleErrors, `errores de consola: ${consoleErrors.join(" | ")}`).toEqual([])
})

test("se crea un proyecto y aparece en la lista y en la matriz", async ({ page }) => {
  await page.goto("/analytics/projects", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Proyectos" })).toBeVisible()

  await page.getByTestId("new-project").click()
  await expect(async () => {
    await page.getByLabel("Código del proyecto").fill(PROJECT_CODE)
    await expect(page.getByLabel("Código del proyecto")).toHaveValue(PROJECT_CODE, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await page.getByLabel("Nombre del proyecto").fill(`Proyecto de humo ${STAMP}`)
  await page.getByLabel("Presupuesto de ingresos").fill("120000,00")
  await page.getByTestId("save-project").click()

  const row = page.locator(`[data-project-code="${PROJECT_CODE}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText("120.000,00")
  await page.screenshot({ path: `${SHOTS}/05-proyectos.png`, fullPage: true })

  // Aparece como columna de la matriz.
  await page.goto("/analytics/pyg", { waitUntil: "networkidle" })
  await expect(page.locator(`[data-column-key="PROJ:${PROJECT_CODE}"]`)).toBeVisible()

  // Y la base lo tiene con su línea de negocio, que es NOT NULL.
  const stored = await withDb(async (client) => {
    const { rows } = await client.query<{ code: string; business_line_id: string; status: string }>(
      `SELECT code, business_line_id, status::text FROM projects WHERE code = $1`,
      [PROJECT_CODE]
    )
    return rows[0]
  })
  expect(stored?.business_line_id).toBeTruthy()
  expect(stored?.status).toBe("ACTIVE")
})

test("reclasificar una línea deja AuditLog, cambia el entryHash y no toca el ledgerHash", async ({ page }) => {
  const organizationId = (await analyticsOrganization()).id

  // ── Estado de partida: hashes del informe y del asiento ────────────────────
  await page.goto("/analytics/pyg", { waitUntil: "networkidle" })
  const hashesBefore = await reportHashes(page)
  const ledgerBefore = /ledgerHash (\S+)/.exec(hashesBefore)?.[1]
  const analyticsBefore = /analyticsHash (\S+)/.exec(hashesBefore)?.[1]
  expect(ledgerBefore).toBeTruthy()

  // Proyecto del fixture con líneas: la ficha ofrece la reclasificación.
  const project = await withDb(async (client) => {
    const { rows } = await client.query<{ id: string; code: string }>(
      `SELECT p.id, p.code
         FROM projects p
         JOIN journal_lines l ON l.project_id = p.id
        WHERE p.organization_id = $1
        GROUP BY p.id, p.code
        ORDER BY count(*) DESC
        LIMIT 1`,
      [organizationId]
    )
    if (rows.length === 0) throw new Error("El fixture analítico no está cargado: ningún proyecto tiene líneas")
    return rows[0]
  })

  const auditBefore = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE organization_id = $1 AND action = 'RECLASSIFY_ANALYTICS'`,
      [organizationId]
    )
    return Number(rows[0].n)
  })

  await page.goto(`/analytics/projects/${project.id}`, { waitUntil: "networkidle" })
  await expect(page.getByTestId("project-mini-pnl")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/06-ficha-proyecto.png`, fullPage: true })

  await page.getByTestId("reclassify-open").click()
  await expect(page.getByTestId("reclassify-window")).toBeVisible()

  // La línea elegida es la primera del desplegable; se anota su asiento para
  // comprobar después que su `entryHash` se ha rehecho.
  const lineSelect = page.getByTestId("reclassify-line")
  const optionLabel = (await lineSelect.locator("option").first().innerText()).trim()
  const entryNumber = Number(/Asiento (\d+)\//.exec(optionLabel)?.[1])
  expect(Number.isFinite(entryNumber)).toBe(true)

  const entryHashBefore = await withDb(async (client) => {
    const { rows } = await client.query<{ entry_hash: string }>(
      `SELECT e.entry_hash FROM journal_entries e
         JOIN fiscal_years f ON f.id = e.fiscal_year_id
        WHERE e.organization_id = $1 AND e.entry_number = $2
        ORDER BY f.start_date ASC LIMIT 1`,
      [organizationId, entryNumber]
    )
    return rows[0]?.entry_hash
  })
  expect(entryHashBefore).toBeTruthy()

  await page.getByLabel("Destino analítico nuevo").click()
  await page.getByLabel("Destino analítico nuevo").fill("CC-GA")
  await page.getByRole("option", { name: /CC-GA/ }).first().click()
  await page.getByLabel("Motivo de la reclasificación").fill("El gasto es estructura general, no del proyecto")
  await page.screenshot({ path: `${SHOTS}/07-reclasificar.png`, fullPage: true })
  await page.getByTestId("confirm-reclassify").click()
  await expect(page.getByTestId("reclassify-done")).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/08-reclasificada.png`, fullPage: true })

  // ── AuditLog + entryHash rehecho ───────────────────────────────────────────
  const after = await withDb(async (client) => {
    const audit = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE organization_id = $1 AND action = 'RECLASSIFY_ANALYTICS'`,
      [organizationId]
    )
    const entry = await client.query<{ entry_hash: string }>(
      `SELECT e.entry_hash FROM journal_entries e
         JOIN fiscal_years f ON f.id = e.fiscal_year_id
        WHERE e.organization_id = $1 AND e.entry_number = $2
        ORDER BY f.start_date ASC LIMIT 1`,
      [organizationId, entryNumber]
    )
    return { audit: Number(audit.rows[0].n), entryHash: entry.rows[0]?.entry_hash }
  })

  expect(after.audit).toBeGreaterThan(auditBefore)
  expect(after.entryHash).not.toBe(entryHashBefore)

  // ── E4-D2: el sello financiero no se mueve, el analítico sí ────────────────
  await page.goto("/analytics/pyg", { waitUntil: "networkidle" })
  const hashesAfter = await reportHashes(page)
  expect(/ledgerHash (\S+)/.exec(hashesAfter)?.[1]).toBe(ledgerBefore)
  expect(/analyticsHash (\S+)/.exec(hashesAfter)?.[1]).not.toBe(analyticsBefore)

  // Y la matriz sigue cuadrando: la reclasificación mueve importe de columna,
  // nunca del total.
  await expect(
    page.getByTestId("matrix-balance-check").locator("[data-balance-difference]")
  ).toHaveAttribute("data-balance-difference", "0")
  await page.screenshot({ path: `${SHOTS}/09-pyg-tras-reclasificar.png`, fullPage: true })
})
