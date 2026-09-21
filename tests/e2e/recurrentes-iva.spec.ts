import { expect, test, type Page } from "@playwright/test"
import { createHmac } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { adminUserId, analyticsOrganization, APP_ENV, DATABASE_URL as DATABASE_URL_OWNER, signIn, withDb } from "./session"

/**
 * E9 · T17/T18 — Extremo a extremo de recurrentes, inmovilizado, IVA, deuda y
 * bloqueo de periodos (`docs/design/E9-cierre-recurrentes.md` §7 y §12).
 *
 * Un recorrido en serie sobre la organización de fixtures:
 *
 *  1. **Regla → calendario → vista previa del lote**: alta de una regla mensual
 *     de importe fijo, sus celdas pendientes en el calendario y el `dryRun` del
 *     lote, que recorre el mismo código sin escribir, y la **generación real**
 *     con su drill-down hasta el asiento contabilizado.
 *  2. **Activo → cuadro**: alta con la sugerencia del art. 12.1 LIS, cuadro mes
 *     a mes derivado (no almacenado) y `scheduleHash` a la vista.
 *  3. **Venta con `543`**: la contrapartida que la pantalla ofrece es el crédito
 *     por enajenación, **nunca** `430` (O-24), y el aviso del art. 110 LIVA se
 *     enseña **antes** de contabilizar, y la contabilización se ejecuta.
 *  4. **Deuda**: cuadro de vencimientos por T-37 con su parte corriente y no
 *     corriente separadas.
 *  5. **Liquidar IVA → casillas → documento**: liquidación del periodo con su
 *     vista previa y su firma del diario, casillas del 303 con fórmula y origen,
 *     y el camino casilla → libro → asiento en tres clics.
 *  6. **Prorrata**: la definitiva se deriva; con documentos sin clave de
 *     operación **no hay porcentaje** y el cierre queda deshabilitado (criterio
 *     14).
 *  7. **Bloqueo de periodo**: bloquear un mes y el rechazo **B-8** al
 *     desbloquear uno cuyo periodo de IVA está liquidado.
 *  8. **VIEWER**: ve las cinco pantallas y ninguno de los botones de mutación.
 *
 * ## El régimen del arnés
 *
 * **TRIMESTRAL**, que es el caso general de una PYME. Hasta la ronda de
 * integración de E9 había que forzar el MENSUAL: `app.iva_period()` escribía el
 * trimestre como `AAAA-Tn` y `lib/closing/vat.vatPeriodOf()` lo leía como
 * `AAAA-Qn`, así que con liquidación trimestral el libro registro salía vacío
 * porque las dos claves no casaban. La migración
 * `20260921090000_e9_periodo_iva_canonico` unifica la forma canónica en
 * `AAAA-Qn` —la del diseño §4.1 y la de ADR-0014 D8— y el rodeo sobra.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e9-screens"
/** Trimestre sobre el que se ejercita todo el IVA (forma canónica `AAAA-Qn`). */
const IVA_PERIOD = "2026-Q3"

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  const org = await analyticsOrganization()
  const userId = await adminUserId()
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/load-fixture.ts",
      "--org",
      org.id,
      "--user",
      userId,
      "--fixture",
      "tests/fixtures/ejercicio-completo.json",
      "--reset-org",
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        DATABASE_URL: DATABASE_URL_OWNER,
        DATABASE_URL_MAINTENANCE:
          APP_ENV.DATABASE_URL_MAINTENANCE ?? "postgresql://app_maintenance:app_maintenance@localhost:5432/erp",
      },
    }
  )
  await useQuarterlyVatRegime(org.id)
  await abrirTrimestreParaLiquidar(org.id, IVA_PERIOD)
})

test.beforeEach(async ({ page, baseURL }) => {
  const url = baseURL ?? "http://localhost:7331"
  await signIn(page, url)
  const org = await analyticsOrganization()
  await useOrgCookie(page, url, org.id)
  await setRole(org.id, "ADMIN")
})

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Regla recurrente → generación → asiento
// ─────────────────────────────────────────────────────────────────────────────

test("una regla mensual se da de alta, se ve en el calendario y su lote se previsualiza", async ({ page }) => {
  await page.goto("/ledger/recurring")
  await expect(page.getByRole("heading", { name: "Asientos recurrentes" })).toBeVisible({ timeout: 90_000 })

  await abrir(page, page.getByTestId("open-rule-form"), page.getByTestId("rule-form"))
  await page.getByTestId("rule-code").fill("REC-E2E")
  await page.getByTestId("rule-name").fill("Traspaso recurrente e2e")
  await page.getByTestId("rule-kind").selectOption("IMPORTE_FIJO")
  await page.getByTestId("rule-freq").selectOption("MENSUAL")
  await page.getByTestId("rule-amount").fill("1.000,00")
  await page.getByTestId("rule-start").fill("2026-01")
  await page.getByTestId("rule-end").fill("2026-02")
  await page.getByTestId("rule-template").selectOption("TRASPASO_TESORERIA")
  await page
    .getByTestId("rule-template-input")
    .fill('{"documentDate":"2026-01-31","fromAccountCode":"572","toAccountCode":"570"}')
  await page.getByTestId("rule-submit").click()

  const fila = page.locator('[data-rule-code="REC-E2E"]')
  await expect(fila).toBeVisible({ timeout: 30_000 })
  // Los dos periodos de vigencia están vencidos y sin generar.
  await expect(fila.locator('[data-cell-status="PENDIENTE"]')).toHaveCount(2)

  // Vista previa del lote: mismo código que la generación real, sin escribir.
  await abrir(page, page.getByTestId("open-generate"), page.getByTestId("generate-up-to"))
  await page.getByTestId("generate-up-to").fill("2026-02")
  await page.getByTestId("generate-rule").selectOption({ label: "REC-E2E · Traspaso recurrente e2e" })
  await page.getByTestId("generate-dry-run").click()
  await expect(page.getByTestId("generate-preview")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("generate-summary")).toContainText("2 generada(s)")
  // La simulación NO ha escrito: sigue sin haber ocurrencias.
  expect(await occurrenceCount()).toBe(0)

  await page.keyboard.press("Escape")

  // Y una regla **TRIMESTRAL**, que antes ni se podía dar de alta: el CHECK
  // `recurring_entries_start_period_format` esperaba `AAAA-Tn` y el motor
  // escribía `AAAA-Qn`. Con la forma canónica unificada, entra.
  await abrir(page, page.getByTestId("open-rule-form"), page.getByTestId("rule-form"))
  await page.getByTestId("rule-code").fill("REC-E2E-T")
  await page.getByTestId("rule-name").fill("Traspaso recurrente trimestral e2e")
  await page.getByTestId("rule-kind").selectOption("IMPORTE_FIJO")
  await page.getByTestId("rule-freq").selectOption("TRIMESTRAL")
  await page.getByTestId("rule-amount").fill("500,00")
  await page.getByTestId("rule-start").fill("2026-Q1")
  await page.getByTestId("rule-end").fill("2026-Q2")
  await page.getByTestId("rule-template").selectOption("TRASPASO_TESORERIA")
  await page
    .getByTestId("rule-template-input")
    .fill('{"documentDate":"2026-03-31","fromAccountCode":"572","toAccountCode":"570"}')
  await page.getByTestId("rule-submit").click()
  await expect(page.locator('[data-rule-code="REC-E2E-T"]')).toBeVisible({ timeout: 30_000 })

  await page.screenshot({ path: `${SHOTS}/recurrentes.png`, fullPage: true, caret: "initial" })
})

/**
 * **Desbloqueado en la ronda de integración de E9.** `recordOccurrenceTx` (T12)
 * insertaba la ocurrencia ANTES que el asiento, con `status = 'GENERADA'` y
 * `entry_id` nulo, contra el CHECK `recurring_occurrences_entry_iff_generada`
 * de T4 —y contra la política append-only de la tabla, que además hacía
 * imposible el `UPDATE` posterior—. Ninguna generación real se contabilizaba.
 * Ahora el asiento va primero y la ocurrencia nace ya enlazada: la restricción
 * de la base sigue garantizando `entry ⇔ GENERADA` en todo momento.
 */
test("la generación real contabiliza el asiento y la celda enlaza con él", async ({ page }) => {
  await page.goto("/ledger/recurring")
  await abrir(page, page.getByTestId("open-generate"), page.getByTestId("generate-up-to"))
  await page.getByTestId("generate-up-to").fill("2026-02")
  await page.getByTestId("generate-rule").selectOption({ label: "REC-E2E · Traspaso recurrente e2e" })
  await page.getByTestId("generate-dry-run").click()
  await expect(page.getByTestId("generate-preview")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("generate-confirm").click()
  await expect.poll(async () => await occurrenceCount(), { timeout: 30_000 }).toBe(2)
  await page.keyboard.press("Escape")

  await page.reload()
  const generadas = page.locator('[data-rule-code="REC-E2E"] [data-cell-status="GENERADA"]')
  await expect(generadas).toHaveCount(2, { timeout: 30_000 })

  // Drill-down: celda → asiento contabilizado.
  await page.getByTestId("cell-REC-E2E-2026-01").click()
  await expect(page.getByTestId("cell-detail")).toBeVisible()
  await page.getByTestId("cell-entry-link").click()
  await expect(page).toHaveURL(/\/ledger\/[0-9a-f-]{36}$/, { timeout: 30_000 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 y 3 · Activo, cuadro y venta con 543
// ─────────────────────────────────────────────────────────────────────────────

test("un activo enseña su cuadro sellado y su venta ofrece 543, nunca 430", async ({ page }) => {
  await page.goto("/settings/assets")
  await expect(page.getByRole("heading", { name: "Inmovilizado" })).toBeVisible({ timeout: 90_000 })

  await abrir(page, page.getByTestId("open-asset-form"), page.getByTestId("asset-form"))
  await page.getByTestId("asset-code").fill("ACT-E2E")
  await page.getByTestId("asset-name").fill("Maquinaria e2e")
  await page.getByTestId("asset-account").fill("213")
  await page.getByTestId("asset-accumulated").fill("2813")
  await page.getByTestId("asset-expense").fill("681")
  await page.getByTestId("asset-acquisition").fill("2026-01-15")
  await page.getByTestId("asset-in-service").fill("2026-02-01")
  await page.getByTestId("asset-cost").fill("12.000,00")
  await page.getByTestId("asset-residual").fill("0,00")
  // La sugerencia del art. 12.1 LIS rellena la vida útil; la que se contabiliza
  // sigue siendo la económica y la pantalla lo dice.
  await page.getByTestId("asset-lis").selectOption("Maquinaria")
  await expect(page.getByTestId("asset-life")).toHaveValue("100")
  await expect(page.getByTestId("asset-lis-note")).toContainText("amortización fiscal no se contabiliza")
  await page.getByTestId("asset-life").fill("24")
  await page.getByTestId("asset-capital-good").check()

  /**
   * **BUG-E12-3 (QA).** La organización de los e2e **exige destino analítico**
   * en los grupos 6 y 7 (C-9), y este formulario lo dice en su propio aviso:
   * sin él la acción se niega con «La cuenta 681 exige exactamente un destino
   * analítico» y el alta no llega a ocurrir. El test no lo elegía, así que
   * fallaba en el `expect` de la fila —que no explica nada— en vez de en la
   * causa. Se elige el PRIMER proyecto de la lista: cuál sea da igual, que haya
   * uno no.
   */
  const destino = page.getByTestId("asset-analytic-target")
  const primerProyecto = await destino.locator('option[value^="PROJ:"]').first().getAttribute("value")
  expect(primerProyecto, "la organización no tiene proyectos: el activo no puede heredar destino").toBeTruthy()
  await destino.selectOption(primerProyecto!)

  await page.getByTestId("asset-submit").click()

  const fila = page.locator('[data-asset-code="ACT-E2E"]')
  await expect(fila).toBeVisible({ timeout: 30_000 })

  await page.getByTestId("open-asset-ACT-E2E").click()
  const cuadro = page.getByTestId("asset-schedule")
  await expect(cuadro).toBeVisible()
  // 24 meses de vida útil desde febrero de 2026: 24 filas y un cuadro sellado.
  await expect(cuadro.locator("tbody tr")).toHaveCount(24)
  await expect(page.getByTestId("asset-schedule-hash")).toContainText("scheduleHash")
  await expect(cuadro.locator('[data-period="2026-02"]')).toContainText("sin contabilizar")

  // Venta: el aviso del art. 110 aparece ANTES de contabilizar y la
  // contrapartida que la pantalla ofrece es 543, nunca 430 (O-24).
  await abrir(page, page.getByTestId("open-dispose-asset"), page.getByTestId("dispose-form"))
  await expect(page.getByTestId("art110-notice")).toContainText("Art. 110 LIVA")
  await page.getByTestId("dispose-kind").selectOption("VENTA")
  await page.getByTestId("dispose-date").fill("2026-08-31")
  await page.getByTestId("dispose-price").fill("9.000,00")
  await expect(page.getByTestId("dispose-receivable")).toHaveValue("543")
  await expect(page.getByText("543 a corto o 253 a largo; nunca 430")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/venta-inmovilizado.png`, fullPage: true, caret: "initial" })
})

/**
 * **Desbloqueado en la ronda de integración de E9.** Con destino analítico
 * obligatorio, `VENTA_INMOVILIZADO` (T-34) y `BAJA_INMOVILIZADO` (T-33) fallaban
 * con «La cuenta 771 exige exactamente un destino analítico» porque
 * `sellAssetAction` y `disposeAssetAction` no reenviaban a la plantilla el
 * proyecto ni el centro de coste que el activo ya declara. Ahora el resultado de
 * la enajenación hereda el destino del activo, y la acción admite además uno
 * explícito cuando se imputa a otro sitio.
 */
test("la venta se contabiliza con 543 y el aviso del art. 110 acompaña al asiento", async ({ page }) => {
  /**
   * La organización de fixtures exige destino analítico y el resultado de la
   * enajenación (771/671) lo hereda **del activo**.
   *
   * **BUG-E12-3 (QA), segunda mitad.** El arnés se lo declaraba por SQL porque
   * «el formulario todavía no lo ofrece» — y sí lo ofrece
   * (`asset-analytic-target`). Desde que el test del alta elige un PROYECTO, el
   * `UPDATE` de CECO dejaba el activo con **las dos dimensiones**, que es
   * exactamente lo que `assertAssetDimension` prohíbe («un proyecto O un centro
   * de coste, nunca los dos»): la venta se negaba y el panel de resultado no
   * llegaba a existir. El destino lo pone ahora el ALTA, por la pantalla, y el
   * arnés sólo actúa si el activo llegara aquí sin ninguno.
   */
  await asegurarDestinoAnalitico("ACT-E2E")

  await page.goto("/settings/assets")
  await page.getByTestId("open-asset-ACT-E2E").click()
  await abrir(page, page.getByTestId("open-dispose-asset"), page.getByTestId("dispose-form"))
  await page.getByTestId("dispose-kind").selectOption("VENTA")
  await page.getByTestId("dispose-date").fill("2026-08-31")
  await page.getByTestId("dispose-price").fill("9.000,00")
  await page.getByTestId("dispose-reason").fill("Venta a un tercero por renovación del parque de maquinaria")
  await page.getByTestId("dispose-submit").click()

  // El panel se lee de UNA vez: al contabilizar, la acción llama a
  // `router.refresh()` y el activo pasa a VENDIDO, con lo que el diálogo deja de
  // existir. Encadenar aserciones contra nodos que se están desmontando es la
  // clase de test que falla por el reloj y no por el producto.
  const resultado = page.getByTestId("disposal-result")
  await expect(resultado).toBeVisible({ timeout: 30_000 })
  const texto = await resultado.innerText()
  expect(texto).toContain("Venta contabilizada")
  expect(texto).toContain("Ver el asiento")
  expect(texto).toContain("543")
  expect(texto).not.toContain("430")
  expect(texto).toContain("110")
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Cuadro de vencimientos de la deuda
// ─────────────────────────────────────────────────────────────────────────────

test("un préstamo declara su cuadro y separa la parte corriente de la no corriente", async ({ page }) => {
  await page.goto("/settings/debt")
  await expect(page.getByRole("heading", { name: "Deuda y cuadros de vencimientos" })).toBeVisible({ timeout: 90_000 })

  await abrir(page, page.getByTestId("open-debt-form"), page.getByTestId("debt-form"))
  await page.getByTestId("debt-code").fill("PRE-E2E")
  await page.getByTestId("debt-name").fill("Préstamo e2e")
  await page.getByTestId("debt-long").fill("170")
  await page.getByTestId("debt-short").fill("520")
  await page.getByTestId("debt-principal").fill("20.000,00")
  await page.getByTestId("debt-start").fill("2026-01-02")
  await page
    .getByTestId("debt-installments")
    .fill("2026-12-31;5.000,00;100,00\n2027-06-30;5.000,00;80,00\n2028-06-30;10.000,00;60,00")
  await page.getByTestId("debt-submit").click()

  const fila = page.locator('[data-schedule-code="PRE-E2E"]')
  await expect(fila).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("open-schedule-PRE-E2E").click()
  await expect(page.getByTestId("schedule-PRE-E2E").locator("tbody tr")).toHaveCount(3)

  // El cuadro alimenta el corte de los doce meses: lo que vence más allá NO
  // aparece como corriente (art. 35.6 CCom, sin compensar).
  const vencimientos = page.locator('[data-debt-code="PRE-E2E"]')
  await expect(vencimientos).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/deuda.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Liquidar IVA → casillas → documento
// ─────────────────────────────────────────────────────────────────────────────

test("el periodo se liquida y sus casillas llevan al asiento en tres clics", async ({ page }) => {
  await page.goto(`/reports/vat?tab=libro&period=${IVA_PERIOD}&year=2026`)
  await expect(page.getByRole("heading", { name: "IVA", exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("vat-regime")).toContainText("trimestral")

  const libro = page.getByTestId("vat-book")
  await expect(libro).toBeVisible({ timeout: 30_000 })
  const anotaciones = await libro.locator("tbody tr").count()
  expect(anotaciones).toBeGreaterThan(0)

  // Liquidación: vista previa (firma el diario) y contabilización.
  await abrir(page, page.getByTestId("open-settle"), page.getByTestId("settle-dry-run"))
  await page.getByTestId("settle-dry-run").click()
  await expect(page.getByTestId("settle-draft")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("settle-blockers")).toBeHidden()
  await page.getByTestId("settle-confirm").click()
  await expect(page.getByTestId("settle-entry-link")).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("Escape")

  // Historial con su sello.
  await page.goto(`/reports/vat?tab=liquidaciones&period=${IVA_PERIOD}&year=2026`)
  await expect(page.locator(`[data-settlement-period="${IVA_PERIOD}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("settlements")).toContainText("ledger")

  // Casilla → libro → asiento: tres clics hasta el justificante.
  await page.goto(`/reports/vat?tab=casillas&period=${IVA_PERIOD}&year=2026`)
  const casillas = page.getByTestId("model303")
  await expect(casillas).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("model303-version")).toContainText("versión")
  // Toda casilla enseña su origen y su fórmula, y las no ofrecidas su motivo.
  await expect(casillas.locator("tbody tr").first()).toContainText("libro de")
  await expect(page.getByTestId("model303-not-offered")).toBeVisible()

  await casillas.locator("[data-box] a").first().click()
  await expect(page.getByTestId("vat-book")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("vat-book").locator("tbody tr a").first().click()
  await expect(page).toHaveURL(/\/ledger\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/iva-casillas.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Prorrata definitiva
// ─────────────────────────────────────────────────────────────────────────────

test("la prorrata se deriva del libro y sin clasificar los documentos no hay porcentaje", async ({ page }) => {
  await page.goto("/reports/vat?tab=prorrata&year=2026")
  const panel = page.getByTestId("prorrata-panel")
  await expect(panel).toBeVisible({ timeout: 90_000 })

  // La guardia de bienes de inversión (art. 107) se enseña siempre, con su
  // evidencia: es bloqueante y no puede quedar implícita.
  await expect(page.getByTestId("capital-goods-evidence")).not.toBeEmpty()

  const sinClasificar = page.getByTestId("prorrata-unclassified")
  if (await sinClasificar.isVisible()) {
    // Criterio 14: con un solo documento sin clave no hay porcentaje y el
    // cierre queda deshabilitado. El motor NO deduce ninguna clave.
    await expect(sinClasificar).toContainText("no hay porcentaje")
    await expect(page.getByTestId("prorrata-definitiva")).toHaveText("—")
    await expect(page.getByTestId("prorrata-close")).toBeDisabled()
  } else {
    await expect(page.getByTestId("prorrata-definitiva")).toContainText("%")
    await expect(page.getByTestId("prorrata-close")).toBeEnabled()
  }
  await page.screenshot({ path: `${SHOTS}/prorrata.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Bloqueo de periodos y B-8
// ─────────────────────────────────────────────────────────────────────────────

test("un mes se bloquea con motivo y no se desbloquea si su IVA está liquidado", async ({ page }) => {
  await page.goto("/settings/periods")
  await expect(page.getByRole("heading", { name: "Bloqueo de periodos" })).toBeVisible({ timeout: 90_000 })

  const rejilla = page.locator('[data-testid^="fiscal-year-"]').first()
  const code = (await rejilla.getAttribute("data-testid"))!.replace("fiscal-year-", "")

  // Julio está liquidado: la rejilla lo dice en su propia columna, distinta de
  // la del bloqueo. Son dos barreras y no una.
  await expect(rejilla.locator('[data-month="7"]')).toContainText("liquidado")

  // B-2: el bloqueo es secuencial. Ir a por noviembre sin haber bloqueado lo
  // anterior se rechaza, y el mensaje dice qué falta.
  await abrir(page, page.getByTestId(`toggle-lock-${code}-11`), page.getByTestId("lock-reason"))
  await page.getByTestId("lock-reason").fill("Cierre mensual de noviembre revisado por el responsable financiero")
  await page.getByTestId("lock-submit").click()
  await expect(page.getByText(/El bloqueo es secuencial \(B-2\)/)).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press("Escape")

  // De enero a julio, en orden, cada uno con su motivo.
  for (const mes of [1, 2, 3, 4, 5, 6, 7]) {
    await abrir(page, page.getByTestId(`toggle-lock-${code}-${mes}`), page.getByTestId("lock-reason"))
    await page.getByTestId("lock-reason").fill(`Cierre mensual del mes ${mes} revisado por el responsable financiero`)
    await page.getByTestId("lock-submit").click()
    await expect(page.getByTestId(`lock-state-${code}-${mes}`)).toHaveText("bloqueado", { timeout: 30_000 })
  }

  // B-8: julio cae en un periodo de IVA liquidado, así que no se desbloquea; el
  // mensaje ofrece la salida (revertir la liquidación) en vez de un «no se puede».
  await abrir(page, page.getByTestId(`toggle-lock-${code}-7`), page.getByTestId("lock-reason"))
  await page.getByTestId("lock-reason").fill("Se necesita contabilizar una factura tardía del periodo")
  await page.getByTestId("lock-submit").click()
  await expect(page.getByText(/está liquidado \(B-8\)/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`lock-state-${code}-7`)).toHaveText("bloqueado")
  await page.keyboard.press("Escape")
  await page.screenshot({ path: `${SHOTS}/periodos.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · VIEWER: lo ve todo y no puede tocar nada
// ─────────────────────────────────────────────────────────────────────────────

test("un VIEWER ve las cinco pantallas y ninguno de los botones de mutación", async ({ page }) => {
  const org = await analyticsOrganization()
  await setRole(org.id, "VIEWER")
  try {
    await page.goto("/ledger/recurring")
    await expect(page.getByRole("heading", { name: "Asientos recurrentes" })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByTestId("recurring-calendar")).toBeVisible()
    await expect(page.getByTestId("open-rule-form")).toHaveCount(0)
    await expect(page.getByTestId("open-generate")).toHaveCount(0)

    await page.goto("/settings/assets")
    await expect(page.getByTestId("assets-table")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("open-asset-form")).toHaveCount(0)
    await page.getByTestId("open-asset-ACT-E2E").click()
    await expect(page.getByTestId("asset-schedule")).toBeVisible()
    await expect(page.getByTestId("open-revise-asset")).toHaveCount(0)
    await expect(page.getByTestId("open-dispose-asset")).toHaveCount(0)

    await page.goto("/settings/debt")
    await expect(page.getByTestId("debt-schedules")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("open-debt-form")).toHaveCount(0)

    await page.goto("/settings/periods")
    await expect(page.locator('[data-testid^="fiscal-year-"]').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('[data-testid^="toggle-lock-"]')).toHaveCount(0)

    await page.goto(`/reports/vat?tab=libro&period=${IVA_PERIOD}&year=2026`)
    await expect(page.getByTestId("vat-book")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("open-settle")).toHaveCount(0)
    await expect(page.getByTestId("open-regime-form")).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/viewer.png`, fullPage: true, caret: "initial" })
  } finally {
    await setRole(org.id, "ADMIN")
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Arnés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `page.click()` comprueba visibilidad y estabilidad, no que React haya
 * enganchado el `onClick`. Se reintenta hasta que el contenido aparece: el
 * mismo patrón que `libro-diario.spec.ts` y `documentos.spec.ts`, sin relajar
 * ninguna aserción.
 */
async function abrir(page: Page, trigger: ReturnType<Page["getByTestId"]>, contenido: ReturnType<Page["getByTestId"]>) {
  await expect(trigger).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () => {
        if (await contenido.isVisible().catch(() => false)) return true
        await trigger.click({ timeout: 5_000 }).catch(() => undefined)
        return await contenido.isVisible().catch(() => false)
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function occurrenceCount(): Promise<number> {
  const org = await analyticsOrganization()
  return await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM recurring_occurrences o
         JOIN recurring_entries r ON r.id = o.recurring_entry_id
        WHERE r.organization_id = $1 AND r.code = 'REC-E2E'`,
      [org.id]
    )
    return Number(rows[0].n)
  })
}

/**
 * Declara el régimen **TRIMESTRAL** desde 2020. Ya no hay que realinear nada:
 * la base y el motor escriben la MISMA clave canónica `AAAA-Qn` desde la
 * migración `20260921090000_e9_periodo_iva_canonico`, así que el libro registro
 * del trimestre sale con sus anotaciones y la liquidación funciona de extremo a
 * extremo. El rodeo del régimen mensual —y el `UPDATE` de `iva_period` con el
 * baile `NO FORCE` / `FORCE`— desaparecen con él.
 */
async function useQuarterlyVatRegime(organizationId: string): Promise<void> {
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO vat_regime_periods
         (organization_id, regime, period_kind, import_deferral, valid_from, valid_to, reason)
       VALUES ($1, 'GENERAL', 'TRIMESTRAL', false, DATE '2020-01-01', NULL, 'Arnés e2e de E9')`,
      [organizationId]
    )
  })
}

/**
 * Declara al activo su centro de coste, que es de donde T-33 y T-34 sacan el
 * destino del resultado de la enajenación (ronda de integración de E9).
 */
async function asegurarDestinoAnalitico(assetCode: string): Promise<void> {
  const org = await analyticsOrganization()
  await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fixed_assets
        WHERE organization_id = $1 AND code = $2
          AND (project_id IS NOT NULL OR cost_center_id IS NOT NULL)`,
      [org.id, assetCode]
    )
    // Ya tiene destino —lo eligió el alta, por la pantalla—: no se toca. Poner
    // el segundo dejaría el activo con proyecto Y CECO, que la validación
    // rechaza con razón.
    if (Number(rows[0]?.n ?? 0) > 0) return
    await client.query(`ALTER TABLE fixed_assets NO FORCE ROW LEVEL SECURITY`)
    try {
      await client.query(
        `UPDATE fixed_assets
            SET cost_center_id = (SELECT id FROM cost_centers
                                   WHERE organization_id = $1 AND is_active
                                   ORDER BY sort_order, code LIMIT 1)
          WHERE organization_id = $1 AND code = $2`,
        [org.id, assetCode]
      )
    } finally {
      await client.query(`ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY`)
    }
  })
}

/**
 * Deja **un** trimestre sin liquidar para que el recorrido de la liquidación
 * tenga algo que liquidar.
 *
 * `ejercicio-completo` trae ya los cuatro asientos T-23 de 2026 —el ejercicio
 * está liquidado de principio a fin—, así que con el régimen TRIMESTRAL ningún
 * trimestre queda abierto: `472` y `477` están barridos y `vatSettlement`
 * rechaza con **R-IVA-9** («el libro y el diario no dicen lo mismo»), que es
 * exactamente lo que tiene que hacer. Antes esto no se veía porque el arnés
 * forzaba el régimen mensual y reescribía `iva_period`, con lo que la
 * liquidación del 3T caía en `2026-09` y el mes elegido (`2026-07`) quedaba
 * limpio por accidente.
 *
 * Aquí se retira ese asiento como una operación de OPERADOR —igual que
 * `--reset-org`—, con el baile `NO FORCE` / `FORCE` y sólo en la organización de
 * pruebas: las líneas y el asiento en la MISMA transacción, porque el cuadre es
 * un constraint diferido.
 */
async function abrirTrimestreParaLiquidar(organizationId: string, period: string): Promise<void> {
  await withDb(async (client) => {
    await client.query(`ALTER TABLE journal_lines NO FORCE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY`)
    try {
      await client.query("BEGIN")
      await client.query(
        `DELETE FROM journal_lines
          WHERE organization_id = $1
            AND entry_id IN (SELECT id FROM journal_entries
                              WHERE organization_id = $1 AND iva_period = $2
                                AND template_code = 'REGULARIZACION_IVA')`,
        [organizationId, period]
      )
      await client.query(
        `DELETE FROM journal_entries
          WHERE organization_id = $1 AND iva_period = $2 AND template_code = 'REGULARIZACION_IVA'`,
        [organizationId, period]
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      await client.query(`ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY`)
    }
  })
}

/** Deja la organización de fixtures activa plantando la cookie firmada. */
async function useOrgCookie(page: Page, baseURL: string, organizationId: string): Promise<void> {
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
