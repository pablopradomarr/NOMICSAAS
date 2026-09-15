import { expect, test, type Page } from "@playwright/test"
import { createHmac, randomUUID } from "node:crypto"
import { adminUserId, analyticsOrganization, APP_ENV, signIn, withDb } from "./session"

/**
 * E10 · T15/T18 — Extremo a extremo del **presupuesto** y de los **drivers de
 * actividad** (`docs/design/E10-presupuesto-horas.md` §7 y §12).
 *
 * Un recorrido en serie sobre la organización analítica:
 *
 *  1. **Versión BASE**: se crea desde la UI, se teclean celdas en la hoja, se
 *     comprueba que **los totales los compone el servidor** y que el aviso de
 *     signo sale en el acto (O-E10-6).
 *  2. **Import CSV**: previsualización con su informe de rechazos, y el
 *     **rechazo del fichero entero** con la convención de signo invertida
 *     (criterio 28, R-B-6).
 *  3. **Sellado con doble confirmación**: el diálogo enseña el `budgetHash` que
 *     va a firmar antes de pedirla.
 *  4. **REVISADO parcial** (`partialFrom`) y **diff** entre las dos versiones,
 *     celda a celda (criterio 6-bis).
 *  5. **Driver `HORAS`**: la regla se guarda con su base declarada y su enlace,
 *     y la simulación emite su aviso de actividad con el aviso de método. El
 *     reparto efectivo, el **% de horas sin aprobar** (criterio 13) y la
 *     caducidad por el cuarto sello (criterio 12-bis) esperan a que el modelo
 *     pase la base de actividad a `allocate()`: quedan en un `fixme`
 *     documentado al pie, con el defecto nombrado.
 *  6. **Auditoría**: la familia `PRESUPUESTO` existe en `/audit`.
 *  7. **VIEWER**: ve las pantallas y ninguno de los botones de mutación.
 *
 * Higiene: el estado de E10 de la organización se vacía al empezar; el arnés
 * lee y escribe con el rol PROPIETARIO, como el resto de la suite.
 */

test.describe.configure({ mode: "serial" })

const FY_CODE_FALLBACK = "2026"

type Ids = { organizationId: string; userId: string; fiscalYearId: string; fiscalYearCode: string }

let ids: Ids

test.beforeAll(async () => {
  const org = await analyticsOrganization()
  const userId = await adminUserId()
  const fiscalYear = await withDb(async (client) => {
    const { rows } = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM fiscal_years WHERE organization_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [org.id]
    )
    return rows[0] ?? null
  })
  if (!fiscalYear) throw new Error("La organización analítica no tiene ningún ejercicio")
  ids = { organizationId: org.id, userId, fiscalYearId: fiscalYear.id, fiscalYearCode: fiscalYear.code ?? FY_CODE_FALLBACK }
  await resetBudgetAndTime(ids.organizationId)
  await setRole(ids.organizationId, "ADMIN")
})

test.afterAll(async () => {
  await setRole(ids.organizationId, "ADMIN")
})

/** Vacía presupuesto, horas y liquidaciones: la suite no acumula estado. */
async function resetBudgetAndTime(organizationId: string): Promise<void> {
  await withDb(async (client) => {
    // Las líneas de una versión SELLADA son inmutables también para el
    // propietario (`budget_lines_no_write_when_sealed`, I-E10-6), y la cabecera
    // no se puede «desellar» a mano (el CHECK `budgets_sealed_marks` y el
    // trigger de inmutabilidad se cierran el paso mutuamente, que es justo lo
    // que se pretendía). La única salida legítima es **borrar la versión**: la
    // cascada arrastra las líneas y el trigger las deja pasar porque, para
    // entonces, la versión ya no existe. El arnés limpia sin tocar la garantía.
    await client.query(`DELETE FROM budgets WHERE organization_id = $1`, [organizationId])
    // Un parte APROBADO no se borra: se contra-apunta (I-E10-4). La garantía es
    // de producción y no se toca; el arnés la levanta **sólo para limpiar su
    // propia siembra**, como propietario, y la vuelve a poner en la misma
    // transacción. Ningún camino de la aplicación pasa por aquí.
    await client.query(`ALTER TABLE time_entries DISABLE TRIGGER "time_entries_no_delete_when_approved"`)
    for (const table of [
      "budget_hours_lines",
      "budget_lines",
      "time_entries",
      "employee_rates",
      "headcount_snapshots",
      "employees",
      "allocation_lines",
      "allocation_runs",
      "allocation_rule_targets",
      "allocation_rules",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId])
    }
    await client.query(`ALTER TABLE time_entries ENABLE TRIGGER "time_entries_no_delete_when_approved"`)
    await client.query(`UPDATE organizations SET time_tracking_enabled = true WHERE id = $1`, [organizationId])
  })
}

async function setRole(organizationId: string, role: "ADMIN" | "EDITOR" | "VIEWER"): Promise<void> {
  const userId = await adminUserId()
  await withDb(async (client) => {
    await client.query(`UPDATE memberships SET role = $1::role WHERE organization_id = $2 AND user_id = $3`, [
      role,
      organizationId,
      userId,
    ])
  })
}

/** Deja la organización analítica activa plantando la cookie firmada. */
async function withAnalyticsOrg(page: Page, baseURL: string, organizationId: string): Promise<void> {
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

async function open(page: Page, baseURL: string, path: string): Promise<void> {
  await signIn(page, baseURL)
  await withAnalyticsOrg(page, baseURL, ids.organizationId)
  await page.goto(path)
}

async function dimensionIds(organizationId: string): Promise<Map<string, string>> {
  return await withDb(async (client) => {
    const out = new Map<string, string>()
    for (const table of ["cost_centers", "projects"]) {
      const { rows } = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM ${table} WHERE organization_id = $1`,
        [organizationId]
      )
      for (const row of rows) out.set(row.code, row.id)
    }
    return out
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Versión BASE, celdas y totales de servidor
// ─────────────────────────────────────────────────────────────────────────────

test("crea la versión BASE y teclea celdas con totales compuestos en el servidor", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")

  await expect(page.getByRole("heading", { name: "Presupuesto", exact: true })).toBeVisible()
  await expect(page.getByTestId("budget-versions-empty")).toBeVisible()

  await page.getByTestId("new-budget-version").click()
  await page.getByTestId("version-fiscal-year").selectOption(ids.fiscalYearId)
  await page.getByTestId("version-scenario").selectOption("BASE")
  await page.getByTestId("version-name").fill("Presupuesto base")
  await page.getByTestId("version-submit").click()

  await expect(page.getByTestId("budget-versions")).toBeVisible()
  await expect(page.getByTestId("budget-selected")).toContainText(`${ids.fiscalYearCode}-BASE`)

  // Una fila de ingreso y otra de coste, con su signo exigido a la vista.
  const ids_ = await dimensionIds(ids.organizationId)
  const project = ids_.get("P-01")
  if (!project) throw new Error("El fixture no tiene el proyecto P-01")

  await page.getByTestId("new-row-dimension").selectOption(project)
  await page.getByTestId("new-row-account").fill("7000")
  await page.getByTestId("new-row-type").selectOption("INGRESO_DIRECTO")
  await page.getByTestId("add-budget-row").click()

  const months = await page.locator("thead th").allTextContents()
  expect(months.length).toBeGreaterThan(12)

  const firstMonth = `${ids.fiscalYearCode}-01`
  const row = page.locator("tr[data-row-key]").first()
  await row.locator(`input[data-cell$="${firstMonth}"]`).fill("1200,00")
  await expect(page.getByTestId("budget-dirty")).toBeVisible()

  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-done")).toBeVisible()

  // El total lo compone el servidor: 1.200,00 € en céntimos enteros.
  await expect(page.getByTestId("budget-total").locator("span[data-cents]")).toHaveAttribute("data-cents", "120000")
})

/**
 * **Celda vaciada = línea retirada, nunca `0,00 €`.** Un cero declarado es una
 * decisión de presupuesto («este proyecto no factura en febrero») y una celda
 * en blanco es la ausencia de decisión; guardar la primera por la segunda hacía
 * que la columna de presupuesto del informe afirmara algo que nadie decidió.
 */
test("vaciar una celda retira su línea y no la guarda como 0,00 €", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")

  const secondMonth = `${ids.fiscalYearCode}-02`
  const row = page.locator("tr[data-row-key]").first()
  const cell = row.locator(`input[data-cell$="${secondMonth}"]`)

  await cell.fill("300,00")
  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-done")).toBeVisible()
  await expect(page.getByTestId("budget-total").locator("span[data-cents]")).toHaveAttribute("data-cents", "150000")

  // Se vacía: la línea se retira y el total vuelve a ser el de enero solo.
  await page.locator("tr[data-row-key]").first().locator(`input[data-cell$="${secondMonth}"]`).fill("")
  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-done")).toContainText("retiradas")
  await expect(page.getByTestId("budget-total").locator("span[data-cents]")).toHaveAttribute("data-cents", "120000")
  // Y la celda queda EN BLANCO, no en `0,00`.
  await expect(page.locator("tr[data-row-key]").first().locator(`input[data-cell$="${secondMonth}"]`)).toHaveValue("")
})

test("avisa del signo en el acto y el servidor rechaza un gasto en positivo", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")
  const ids_ = await dimensionIds(ids.organizationId)
  const project = ids_.get("P-01")!

  await page.getByTestId("new-row-dimension").selectOption(project)
  await page.getByTestId("new-row-account").fill("6400")
  await page.getByTestId("new-row-type").selectOption("COSTE_DIRECTO_MC2")
  await page.getByTestId("add-budget-row").click()

  const row = page.locator("tr[data-row-key]").last()
  await expect(row.locator("td[data-expected-sign]")).toHaveAttribute("data-expected-sign", "NEGATIVO")

  const cell = row.locator(`input[data-cell$="${ids.fiscalYearCode}-02"]`)
  await cell.fill("1200,00")
  await expect(cell).toHaveAttribute("data-sign-warning", "1")

  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-error")).toContainText("negativo")

  // Con el signo correcto entra.
  await cell.fill("-1200,00")
  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-done")).toBeVisible()
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Import CSV
// ─────────────────────────────────────────────────────────────────────────────

test("el import CSV previsualiza, informa de rechazos y rechaza el fichero invertido", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")

  const fy = ids.fiscalYearCode
  const bueno = [
    "mes;cuenta;tipo_analitico;proyecto;importe_centimos",
    `${fy}-03-01;6400;COSTE_DIRECTO_MC2;P-01;-50000`,
    `${fy}-13-01;6400;COSTE_DIRECTO_MC2;P-01;-50000`,
  ].join("\n")

  await page.getByTestId("budget-csv-text").fill(bueno)
  await page.getByTestId("budget-csv-preview").click()
  await expect(page.getByTestId("budget-csv-report")).toBeVisible()
  await expect(page.getByTestId("csv-rejected")).toHaveText("1")
  await expect(page.getByTestId("budget-csv-report")).toContainText("AAAA-MM-01")

  await page.getByTestId("budget-csv-import").click()
  await expect(page.getByTestId("csv-inserted")).toHaveText("1")

  // Convención de signo invertida: el fichero ENTERO se rechaza.
  const invertido = [
    "mes;cuenta;tipo_analitico;proyecto;importe_centimos",
    `${fy}-04-01;6400;COSTE_DIRECTO_MC2;P-01;50000`,
    `${fy}-05-01;6400;COSTE_DIRECTO_MC2;P-01;60000`,
  ].join("\n")
  await page.getByTestId("budget-csv-text").fill(invertido)
  await page.getByTestId("budget-csv-preview").click()
  await expect(page.getByTestId("budget-csv-report")).toHaveAttribute("data-file-rejected", "1")
  await expect(page.getByTestId("budget-csv-report")).toContainText("convención de signo")
  await expect(page.getByTestId("budget-csv-import")).toBeDisabled()
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 y 4. Sellado con doble confirmación, revisión parcial y diff
// ─────────────────────────────────────────────────────────────────────────────

test("sella la BASE con doble confirmación y enseña el hash antes de firmar", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")

  await page.getByTestId(`seal-${ids.fiscalYearCode}-BASE`).click()
  await expect(page.getByTestId("seal-preview")).toBeVisible()
  const hash = await page.getByTestId("seal-hash").textContent()
  expect(hash?.trim().length).toBeGreaterThan(32)

  // Sin la doble confirmación, el botón no sella.
  await expect(page.getByTestId("seal-submit")).toBeDisabled()
  await page.getByTestId("seal-code").fill(`${ids.fiscalYearCode}-BASE`)
  await page.getByTestId("seal-ack").check()
  await page.getByTestId("seal-submit").click()

  const sealed = page.locator(`tr[data-budget-version="${ids.fiscalYearCode}-BASE"]`)
  await expect(sealed).toHaveAttribute("data-budget-status", "VIGENTE")
  await expect(page.getByTestId("budget-sealed-note")).toBeVisible()
})

test("una REVISADO parcial declara su partialFrom y el diff enseña qué cambió", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/analytics/budget")

  await page.getByTestId("new-budget-version").click()
  await page.getByTestId("version-fiscal-year").selectOption(ids.fiscalYearId)
  await page.getByTestId("version-scenario").selectOption("REVISADO")
  await page.getByTestId("version-name").fill("Reproyección de julio")
  await page.getByTestId("version-valid-from").fill(`${ids.fiscalYearCode}-07-01`)
  await page.getByTestId("version-partial-from").fill(`${ids.fiscalYearCode}-07-01`)
  const copyFrom = page.getByTestId("version-copy-from")
  await copyFrom.selectOption({ label: `${ids.fiscalYearCode}-BASE (3 celdas)` }).catch(async () => {
    await copyFrom.selectOption({ index: 1 })
  })
  await page.getByTestId("version-submit").click()

  const revision = page.locator(`tr[data-budget-version="${ids.fiscalYearCode}-REV1"]`)
  await expect(revision).toBeVisible()
  await expect(revision.locator("td[data-partial-from]")).toHaveAttribute(
    "data-partial-from",
    `${ids.fiscalYearCode}-07-01`
  )

  // Se cambia una celda de la revisión para que el diff tenga algo que enseñar.
  const row = page.locator("tr[data-row-key]").first()
  await row.locator(`input[data-cell$="${ids.fiscalYearCode}-01"]`).fill("1500,00")
  await page.getByTestId("save-budget-cells").click()
  await expect(page.getByTestId("budget-sheet-done")).toBeVisible()

  await page.getByTestId("go-to-diff").click()
  await expect(page.getByTestId("diff-idle")).toBeVisible()
  await page.getByTestId("diff-from").selectOption({ label: `${ids.fiscalYearCode}-BASE` })
  await page.waitForURL(/from=[0-9a-f-]{36}/)
  await page.getByTestId("diff-to").selectOption({ label: `${ids.fiscalYearCode}-REV1` })
  await page.waitForURL(/to=[0-9a-f-]{36}/)
  await expect(page.getByTestId("budget-diff")).toBeVisible()
  await expect(page.getByTestId("diff-total").locator("span[data-cents]")).toHaveAttribute("data-cents", "30000")
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Driver HORAS: aviso de horas sin aprobar y caducidad por el cuarto sello
// ─────────────────────────────────────────────────────────────────────────────

/** Siembra dos empleados con partes: uno aprobado y otro sin aprobar. */
async function seedTime(organizationId: string): Promise<void> {
  const approverId = await adminUserId()
  const dims = await dimensionIds(organizationId)
  const p1 = dims.get("P-01")
  const p2 = dims.get("P-02")
  if (!p1 || !p2) throw new Error("El fixture no tiene P-01 y P-02")
  const employeeId = randomUUID()
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO employees (id, organization_id, code, name, fte_milli, is_active, updated_at)
       VALUES ($1, $2, 'E-01', 'Empleado de prueba', 1000, true, now())`,
      [employeeId, organizationId]
    )
    const insert = async (projectId: string, date: string, minutes: number, status: string) => {
      // `business_line_id` es una columna DENORMALIZADA del proyecto (R-A9) y
      // un trigger comprueba que coincida: se lee, no se inventa.
      const { rows } = await client.query<{ business_line_id: string }>(
        `SELECT business_line_id FROM projects WHERE id = $1 AND organization_id = $2`,
        [projectId, organizationId]
      )
      await client.query(
        `INSERT INTO time_entries (id, organization_id, employee_id, date, project_id, business_line_id, minutes, productive, status, approved_at, approved_by_id)
         VALUES ($1, $2, $3, $4::date, $5, $9, $6, true, $7::time_entry_status, $8, $10)`,
        [
          randomUUID(),
          organizationId,
          employeeId,
          date,
          projectId,
          minutes,
          status,
          status === "APROBADO" ? new Date() : null,
          rows[0]?.business_line_id ?? null,
          // El CHECK exige que `approved_at` y `approved_by_id` vayan juntos.
          status === "APROBADO" ? approverId : null,
        ]
      )
    }
    // El techo diario por empleado es 1 440 minutos (I-E10-10), así que los
    // partes van en días distintos: 8 h a P-01, 4 h a P-02 y 5 h más a P-02
    // **sin aprobar**, que son las que el aviso tiene que declarar.
    await insert(p1, "2026-11-10", 480, "APROBADO")
    await insert(p2, "2026-11-11", 240, "APROBADO")
    await insert(p2, "2026-11-12", 300, "BORRADOR")
  })
}

test("una regla HORAS declara su base, la simulación emite su aviso de actividad", async ({
  page,
  baseURL,
}) => {
  await seedTime(ids.organizationId)
  const dims = await dimensionIds(ids.organizationId)
  const source = dims.get("CC-OPS") ?? dims.get("CC-GA")
  if (!source) throw new Error("El fixture no tiene un centro de coste imputable conocido")

  await open(page, baseURL!, "/analytics/allocations")

  await page.getByTestId("new-allocation-rule").click()
  await page.getByTestId("rule-source").selectOption(source)
  await page.getByTestId("rule-valid-from").fill("2026-01-01")
  await page.getByLabel("Código de la regla 1").fill("R-HORAS-E2E")
  await page.getByLabel("Nombre de la regla 1").fill("Reparto por horas imputadas")
  await page.getByLabel("Driver de la regla 1").selectOption("HOURS")
  await expect(page.getByTestId("driver-base-link")).toContainText("partes de horas aprobados")
  await page.getByLabel("Periodicidad de la regla 1").selectOption("MONTH")
  await page.getByTestId("rule-source-share").fill("100")
  await page.getByTestId("save-allocation-rules").click()
  await expect(page.locator('tr[data-rule-code="R-HORAS-E2E"], table')).toBeVisible()

  // Simulación de noviembre: el driver de actividad emite su aviso `W-E10-*`
  // con el aviso de método al pie. Una regla de actividad NUNCA queda muda.
  await page.getByTestId("go-to-runs").click()
  await page.getByTestId("period-kind").selectOption("MONTH")
  await page.getByTestId("period-index").selectOption({ label: "Noviembre" })
  await page.getByTestId("simulate").click()
  await expect(page.getByTestId("preview-warnings")).toBeVisible()
  await expect(page.locator('li[data-warning-code^="W-E10-"]').first()).toBeVisible()
  await expect(page.getByTestId("preview-warnings")).toContainText(
    "las horas no aprobadas no reparten dinero"
  )
})

/** Aprueba el parte que quedó en borrador: el mundo cambia tras el sello. */
async function approveLateEntry(organizationId: string): Promise<void> {
  const approverId = await adminUserId()
  await withDb(async (client) => {
    await client.query(
      `UPDATE time_entries SET status = 'APROBADO', approved_at = now(), approved_by_id = $2
        WHERE organization_id = $1 AND status = 'BORRADOR'`,
      [organizationId, approverId]
    )
  })
}

/**
 * **Criterio 13 + criterio 12-bis, de punta a punta.** Con 720 minutos
 * aprobados y 300 sin aprobar en noviembre, la simulación emite
 * `W-E10-UNAPPROVED-HOURS` con sus minutos y su **% sobre la base aprobada**
 * (O-E10-2), reparte de verdad —y por eso se puede sellar— y el run toma su
 * CUARTA huella sobre la ventana de los partes que consume.
 *
 * Estuvo en `fixme` durante la ola C: `previewAllocationRun` y
 * `sealAllocationRunTx` llamaban a `allocate()` sin `timeEntries` ni
 * `headcount`, de modo que los dos drivers de actividad caían siempre en su
 * `zeroBaseFallback`. La ronda de integración les pasa `ctx.activity`.
 */
test("reparte por horas, declara los minutos sin aprobar y caduca al aprobar un parte tardío", async ({
  page,
  baseURL,
}) => {
  await open(page, baseURL!, "/analytics/allocations/runs")
  await page.getByTestId("period-kind").selectOption("MONTH")
  await page.getByTestId("period-index").selectOption({ label: "Noviembre" })
  await page.getByTestId("simulate").click()
  await expect(page.locator('li[data-warning-code="W-E10-UNAPPROVED-HOURS"]')).toContainText("sin aprobar")
  await expect(page.getByTestId("unapproved-hours")).toContainText("5:00")

  // Con base aprobada hay líneas, y por tanto se puede sellar: el run toma su
  // CUARTA huella sobre la ventana de los partes que consume.
  await page.getByTestId("seal-run").click()
  await expect(page.getByTestId("seal-done")).toBeVisible()
  await expect(page.getByTestId("time-window").first()).toContainText("2026-11-01")

  // **O-E10-1 / criterio 12-bis** — aprobar un parte de la ventana DESPUÉS de
  // sellar cambia el `timeHash` del periodo: el run aparece caducado con su
  // motivo. La caducidad es derivada, nunca almacenada.
  await approveLateEntry(ids.organizationId)
  await page.reload()
  await expect(page.locator('[data-run-state="STALE"]').first()).toBeVisible()
  await expect(page.getByTestId("stale-reasons").first()).toContainText("partes de horas")
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 y 7. Auditoría y VIEWER
// ─────────────────────────────────────────────────────────────────────────────

test("la pestaña de auditoría tiene la familia PRESUPUESTO", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/audit")
  await expect(page.getByText("Presupuesto y horas").first()).toBeVisible()
})

test("un VIEWER ve el presupuesto y ninguno de los botones de mutación", async ({ page, baseURL }) => {
  await setRole(ids.organizationId, "VIEWER")
  try {
    await open(page, baseURL!, "/analytics/budget")
    await expect(page.getByTestId("budget-versions")).toBeVisible()
    await expect(page.getByTestId("new-budget-version")).toHaveCount(0)
    await expect(page.getByTestId("save-budget-cells")).toHaveCount(0)
    await expect(page.getByTestId("budget-import")).toHaveCount(0)
    await expect(page.getByTestId("propose-depreciation")).toHaveCount(0)
    await expect(page.locator('[data-testid^="seal-"]')).toHaveCount(0)

    await page.goto("/analytics/allocations")
    await expect(page.getByTestId("new-allocation-rule")).toHaveCount(0)
  } finally {
    await setRole(ids.organizationId, "ADMIN")
  }
})
