import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdirSync } from "node:fs"
import {
  adminUserId,
  analyticsOrganization,
  APP_ENV,
  DATABASE_URL as DATABASE_URL_OWNER,
  signIn,
  withDb,
} from "./session"
import type { SeedE10Result } from "../support/seed-e10"

/**
 * E10 · T16/T17 — Extremo a extremo de **horas y presupuesto vs real**
 * (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Un recorrido en serie sobre la organización analítica:
 *
 *  1. **Empleado y tarifa** (`/settings/employees`): alta por pantalla, tarifa
 *     con su `basis` explícita y su historial de vigencias.
 *  2. **Parte de horas** (`/time`): alta con minutos enteros, banda de
 *     pendientes con su %, aprobación **por lote** y **contra-apunte** con
 *     motivo. El parte original no se toca (I-E10-4).
 *  3. **Presupuesto vs real** (`/analytics/budget-vs-actual`): las cinco
 *     columnas, la procedencia del presupuesto mes a mes, el sello con sus
 *     motivos, el toggle de imputaciones y el **drill-down** celda → tres
 *     consultas → enlace al asiento.
 *  4. **Export** CSV / XLSX / PDF del `ReportRun` emitido.
 *  5. **Rentabilidad con horas** en la ficha del proyecto: margen por hora,
 *     coste-hora **con su base** y desviación de absorción.
 *  6. **VIEWER**: ve las cinco pantallas y **ningún** botón de mutación.
 *
 * La versión de presupuesto la siembra `tests/support/seed-e10.ts` por el mismo
 * camino que la aplicación (`createBudgetVersionTx` → `sealBudgetTx`): el editor
 * de presupuesto es la pantalla de T15, de otra tarea de la misma ola.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e10-screens"
/**
 * Código IRREPETIBLE por ejecución. Los partes aprobados **no se borran** —lo
 * impide el trigger de I-E10-4, y está bien que lo impida—, así que el arnés no
 * limpia: estrena empleado en cada pasada y afirma sólo sobre lo suyo.
 */
const EMPLOYEE_CODE = `E2E-H-${Date.now().toString(36).slice(-6).toUpperCase()}`
const EMPLOYEE_NAME = "Empleado de partes E2E"
/** 8 h del día, en minutos enteros: los partes nunca se registran en decimales. */
const MINUTES = 480
const CORRECTION_MINUTES = 60
const RATE = "32,50"

test.describe.configure({ mode: "serial" })

let seed: SeedE10Result
let organizationId: string
/** Un día laborable dentro del ejercicio presupuestado. */
let entryDate: string
let entryMonth: string

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  const org = await analyticsOrganization()
  organizationId = org.id
  const userId = await adminUserId()

  // El arnés siembra con el rol PROPIETARIO, como el resto de la suite: con la
  // RLS estricta, `app_runtime` sin GUC no ve nada y el fallo se leería como
  // «no hay ejercicio abierto» en vez de «falta el rol».
  const stdout = execFileSync(
    "npx",
    ["tsx", "tests/support/seed-e10.ts", "--org", organizationId, "--user", userId],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: DATABASE_URL_OWNER, PRISMA_LOG: "" } }
  )
  const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)
  if (!line) throw new Error(`El arnés de presupuesto no ha devuelto su resultado: ${stdout}`)
  seed = JSON.parse(line) as SeedE10Result
  // **B-9**: un mes bloqueado no admite partes nuevos ni aprobaciones — sus
  // horas ya alimentaron una liquidación rendida. El arnés elige el primer mes
  // ABIERTO del ejercicio en vez de dar por hecho enero.
  entryMonth = `${seed.periodStart.slice(0, 4)}-${String(await firstOpenMonth(seed.fiscalYearId)).padStart(2, "0")}`
  entryDate = `${entryMonth}-15`
})

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, baseURL ?? "http://localhost:7331")
  await useAnalyticsOrg(page, baseURL ?? "http://localhost:7331", organizationId)
})

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Empleado y tarifa
// ─────────────────────────────────────────────────────────────────────────────

test("alta de empleado y tarifa con su base explícita", async ({ page }) => {
  await page.goto("/settings/employees", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Empleados y tarifas" })).toBeVisible()

  await page.getByTestId("open-employee-form").click()
  await page.getByTestId("employee-code").fill(EMPLOYEE_CODE)
  await page.getByTestId("employee-name").fill(EMPLOYEE_NAME)
  await page.getByTestId("employee-submit").click()

  const row = page.locator(`[data-testid="employee-row"][data-code="${EMPLOYEE_CODE}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  // Sin tarifa, la cifra es NO EVALUABLE: nunca 0.
  await expect(row.getByTestId("rate-missing")).toBeVisible()

  await row.getByTestId("open-rate").click()
  await page.getByTestId("rate-amount").fill(RATE)
  await page.getByTestId("rate-basis").selectOption("COSTE_EMPRESA_CON_SS")
  await page.getByTestId("rate-from").fill(seed.periodStart)
  await page.getByTestId("rate-submit").click()

  await expect(row.getByTestId("employee-rate")).toContainText("32,50", { timeout: 20_000 })
  // La base VIAJA con la cifra (Q-1): dos bases difieren ≈ 31,9 %.
  await expect(row).toContainText("coste empresa con SS")

  await row.getByTestId("open-rate-history").click()
  await expect(page.getByTestId("rate-history")).toContainText("abierta")
  await page.keyboard.press("Escape")
  await page.screenshot({ path: `${SHOTS}/01-empleados.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Parte de horas: alta, aprobación por lote y contra-apunte
// ─────────────────────────────────────────────────────────────────────────────

test("parte de horas: alta en minutos enteros, aprobación por lote y contra-apunte", async ({ page }) => {
  await page.goto(`/time?mes=${entryMonth}&vista=lista`, { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Partes de horas" })).toBeVisible()

  const employeeId = await idOf("employees", EMPLOYEE_CODE)
  const projectId = await idOf("projects", seed.projectCode)

  await page.getByTestId("open-time-form").click()
  await page.getByTestId("time-employee").selectOption(employeeId)
  await page.getByTestId("time-date").fill(entryDate)
  await page.getByTestId("time-target").selectOption(`PROJ:${projectId}`)
  await page.getByTestId("time-minutes").fill(String(MINUTES))
  await page.getByTestId("time-submit").click()

  const entry = page.getByTestId("time-entry").filter({ hasText: EMPLOYEE_CODE }).first()
  await expect(entry).toBeVisible({ timeout: 20_000 })
  await expect(entry).toHaveAttribute("data-status", "BORRADOR")
  await expect(entry.locator("td", { hasText: "8:00" }).first()).toBeVisible()

  // La banda dice cuánto pesa lo pendiente: es lo que explica que una regla
  // `HOURS` reparta menos de lo que parece.
  // La banda es del MES entero (puede haber partes de otras pasadas del arnés):
  // lo que se comprueba es que informa en `hh:mm` y con su peso sobre la base.
  await expect(page.getByTestId("unapproved-minutes")).toContainText(":")
  await expect(page.getByTestId("unapproved-share")).toContainText("%")
  await page.screenshot({ path: `${SHOTS}/02-parte-pendiente.png`, fullPage: true, caret: "initial" })

  await page.getByTestId("select-all-pending").click()
  await page.getByTestId("approve-selected").click()
  await expect(entry).toHaveAttribute("data-status", "APROBADO", { timeout: 20_000 })
  await expect(page.getByTestId("approved-minutes")).toContainText(":")

  // Corrección: contra-apunte con motivo. El original sigue ahí (I-E10-4).
  await entry.getByTestId("open-correct").click()
  await page.getByTestId("correct-minutes").fill(String(CORRECTION_MINUTES))
  await page.getByTestId("correct-reason").fill("Una hora imputada al proyecto equivocado en el parte original")
  await page.getByTestId("correct-submit").click()

  await expect(page.getByTestId("counter-entry").first()).toBeVisible({ timeout: 20_000 })
  // El original NO desaparece: el parte y su contra-apunte conviven (I-E10-4).
  await expect(page.getByTestId("time-entry").filter({ hasText: EMPLOYEE_CODE })).toHaveCount(2)
  await page.screenshot({ path: `${SHOTS}/03-contra-apunte.png`, fullPage: true, caret: "initial" })

  // El calendario pinta el neto del día en `hh:mm`: 8:00 − 1:00 = 7:00.
  await page.goto(`/time?mes=${entryMonth}&vista=calendario`, { waitUntil: "networkidle" })
  const cell = page
    .locator(`[data-testid="time-calendar"] tr[data-employee="${EMPLOYEE_CODE}"] td[data-date="${entryDate}"]`)
    .first()
  await expect(cell).toHaveAttribute("data-minutes", String(MINUTES - CORRECTION_MINUTES))
  await expect(cell).toHaveAttribute("data-over-ceiling", "no")
  await page.screenshot({ path: `${SHOTS}/04-calendario.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 y 4 · Presupuesto vs real: desviaciones, drill-down y export
// ─────────────────────────────────────────────────────────────────────────────

test("presupuesto vs real: cinco columnas, procedencia, drill-down y export", async ({ page }) => {
  await page.goto(reportUrl(), { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Presupuesto vs real" })).toBeVisible()

  // Cabecera: sello, sellos abreviados y procedencia del presupuesto mes a mes.
  await expect(page.getByTestId("budget-vs-actual-hashes")).toContainText("budgetHash")
  await expect(page.getByTestId("budget-composition")).toContainText(seed.label)
  await expect(page.locator("[data-seal]")).toBeVisible()

  // La matriz, con la fila de INGRESOS del proyecto presupuestado.
  const matrix = page.getByTestId("variance-matrix")
  await expect(matrix).toBeVisible()
  const revenueRow = page.locator(
    `[data-testid="variance-row"][data-level="INGRESOS"][data-column="PROJ:${seed.projectCode}"]`
  )
  await expect(revenueRow).toBeVisible()
  await expect(revenueRow).toHaveAttribute("data-not-comparable", "no")
  // El presupuesto sembrado son 120 000,00 € de ingreso del proyecto.
  await expect(revenueRow.getByTestId("cell-budget").locator("[data-cents]")).toHaveAttribute(
    "data-cents",
    String(seed.revenueCents)
  )
  // La desviación es real − presupuesto, EXACTA, y la compone el servidor.
  const actual = Number(
    (await revenueRow.getByTestId("cell-actual").locator("[data-cents]").getAttribute("data-cents")) ?? "0"
  )
  await expect(revenueRow.getByTestId("cell-variance").locator("[data-cents]")).toHaveAttribute(
    "data-cents",
    String(actual - seed.revenueCents)
  )
  await page.screenshot({ path: `${SHOTS}/05-presupuesto-real.png`, fullPage: true, caret: "initial" })

  // Los cinco avisos de método, impresos en pantalla y no en un manual.
  await expect(page.getByTestId("method-notes")).toContainText("El presupuesto es una decisión, no un cálculo")
  await expect(page.getByTestId("method-notes")).toContainText("mismo estado de imputación")

  // Drill-down: celda → las tres consultas de la procedencia → el asiento.
  await revenueRow.getByTestId("variance-cell").click()
  await expect(page.getByTestId("drill-detail")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("drill-budget")).toBeVisible()
  const entryLink = page.getByTestId("drill-entry-link").first()
  await expect(entryLink).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/06-drill-down.png`, fullPage: true, caret: "initial" })
  await entryLink.click()
  // Tercer clic: el libro diario con el asiento que aporta a la celda.
  await expect(page.getByRole("heading", { name: "Libro diario" })).toBeVisible({ timeout: 30_000 })

  // Export: los tres formatos del `ReportRun` ya emitido.
  await page.goto(reportUrl(), { waitUntil: "networkidle" })
  for (const format of ["csv", "xlsx", "pdf"] as const) {
    const href = await page.getByTestId(`export-${format}`).getAttribute("href")
    expect(href).toContain(`format=${format}`)
    const response = await page.request.get(href as string)
    expect(response.status(), `export ${format}`).toBe(200)
    expect(response.headers()["content-disposition"]).toContain("presupuesto-real")
  }
})

test("el toggle de imputaciones mantiene la comparabilidad o se bloquea con su motivo", async ({ page }) => {
  await page.goto(reportUrl(), { waitUntil: "networkidle" })
  await page.getByTestId("toggle-allocations").click()
  await expect(page.getByTestId("toggle-allocations")).toHaveAttribute("data-allocations", "si", { timeout: 30_000 })

  // O-E10-4 / I-E10-18: o las dos matrices están en el mismo estado, o las
  // celdas por dimensión de MC3 en adelante NO se publican y se dice por qué.
  const blocked = page.getByTestId("toggle-blocked")
  if ((await blocked.count()) > 0) {
    await expect(blocked).toContainText("Comparación con imputaciones bloqueada")
    await expect(page.locator('[data-testid="variance-row"][data-not-comparable="si"]').first()).toBeVisible()
    await expect(page.getByTestId("cell-not-comparable").first()).toContainText("No publicada")
  } else {
    await expect(page.getByTestId("variance-matrix")).toBeVisible()
  }
  await page.screenshot({ path: `${SHOTS}/07-toggle.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Rentabilidad con horas
// ─────────────────────────────────────────────────────────────────────────────

test("la ficha del proyecto publica la rentabilidad con horas y su base", async ({ page }) => {
  const projectId = await idOf("projects", seed.projectCode)
  await page.goto(`/analytics/projects/${projectId}`, { waitUntil: "networkidle" })

  const block = page.getByTestId("project-profitability")
  await expect(block).toBeVisible({ timeout: 30_000 })
  // Las horas son las del proyecto en TODO el ejercicio: lo que se comprueba es
  // que el bloque publica minutos reales en `hh:mm` y que incluyen los del parte
  // recién aprobado, ya neteado por su contra-apunte.
  const actualMinutes = Number(
    (await block.getByTestId("actual-minutes").locator("[data-minutes]").getAttribute("data-minutes")) ?? "0"
  )
  expect(actualMinutes).toBeGreaterThanOrEqual(MINUTES - CORRECTION_MINUTES)
  // 100 h al mes × 12 meses de presupuesto = 1 200:00.
  await expect(block.getByTestId("budget-minutes")).toContainText(":")
  // No evaluable NO es cero: o hay cifra, o hay motivo.
  const hourly = block.getByTestId("hourly-cost")
  await expect(hourly).toBeVisible()
  expect((await hourly.textContent()) ?? "").toMatch(/No evaluable|base:/)
  await page.screenshot({ path: `${SHOTS}/08-rentabilidad.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · VIEWER
// ─────────────────────────────────────────────────────────────────────────────

test("un VIEWER ve las pantallas y ninguno de los botones de mutación", async ({ page }) => {
  await setRole(organizationId, "VIEWER")
  try {
    await page.goto(`/time?mes=${entryMonth}&vista=lista`, { waitUntil: "networkidle" })
    await expect(page.getByTestId("time-entries")).toBeVisible()
    await expect(page.getByTestId("open-time-form")).toHaveCount(0)
    await expect(page.getByTestId("approve-selected")).toHaveCount(0)
    await expect(page.getByTestId("open-correct")).toHaveCount(0)
    await expect(page.getByTestId("open-time-import")).toHaveCount(0)

    await page.goto("/settings/employees", { waitUntil: "networkidle" })
    await expect(page.getByTestId("employees-table")).toBeVisible()
    await expect(page.getByTestId("open-employee-form")).toHaveCount(0)
    await expect(page.getByTestId("open-rate")).toHaveCount(0)
    // La tarifa individual no viaja a quien no es ADMIN: «oculta» ≠ «no hay».
    await expect(page.getByTestId("rate-hidden").first()).toBeVisible()
    await expect(page.getByTestId("rate-privacy-note")).toBeVisible()

    await page.goto("/settings/headcount", { waitUntil: "networkidle" })
    await expect(page.getByTestId("headcount-table")).toBeVisible()
    await expect(page.getByTestId("headcount-derive")).toHaveCount(0)
    await expect(page.getByTestId("headcount-cell")).toHaveCount(0)

    await page.goto(reportUrl(), { waitUntil: "networkidle" })
    await expect(page.getByTestId("variance-matrix")).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: `${SHOTS}/09-viewer.png`, fullPage: true, caret: "initial" })
  } finally {
    await setRole(organizationId, "ADMIN")
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Arnés
// ─────────────────────────────────────────────────────────────────────────────

const reportUrl = (): string =>
  `/analytics/budget-vs-actual?fiscalYearId=${seed.fiscalYearId}&from=${seed.periodStart}&to=${seed.periodEnd}`

/** Deja la organización analítica activa plantando la cookie firmada. */
async function useAnalyticsOrg(page: Page, baseURL: string, orgId: string): Promise<void> {
  const secret = APP_ENV.BETTER_AUTH_SECRET
  if (!secret) throw new Error("Falta BETTER_AUTH_SECRET en el entorno de la aplicación")
  const userId = await adminUserId()
  const signature = createHmac("sha256", secret).update(`${orgId}:${userId}`).digest("base64url")
  await page.context().addCookies([
    {
      name: "taxhacker.active_org",
      value: `${orgId}.${signature}`,
      domain: new URL(baseURL).hostname,
      path: "/",
      sameSite: "Lax",
    },
  ])
}

async function setRole(orgId: string, role: "ADMIN" | "EDITOR" | "VIEWER"): Promise<void> {
  const userId = await adminUserId()
  await withDb(async (client) => {
    await client.query(`UPDATE memberships SET role = $1::role WHERE organization_id = $2 AND user_id = $3`, [
      role,
      orgId,
      userId,
    ])
  })
}

/** El primer mes del ejercicio sin `PeriodLock`: B-9 bloquea los cerrados. */
async function firstOpenMonth(fiscalYearId: string): Promise<number> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ month: number }>(
      `SELECT month FROM period_locks WHERE fiscal_year_id = $1`,
      [fiscalYearId]
    )
    const locked = new Set(rows.map((r) => r.month))
    for (let month = 1; month <= 12; month += 1) if (!locked.has(month)) return month
    throw new Error("Todos los meses del ejercicio están bloqueados: no hay dónde registrar un parte")
  })
}

async function idOf(table: "employees" | "projects" | "cost_centers", code: string): Promise<string> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE organization_id = $1 AND code = $2`,
      [organizationId, code]
    )
    if (rows.length === 0) throw new Error(`No existe ${code} en ${table}`)
    return rows[0].id
  })
}

