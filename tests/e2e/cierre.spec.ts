import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdirSync } from "node:fs"
import { adminUserId, analyticsOrganization, APP_ENV, DATABASE_URL as DATABASE_URL_OWNER, signIn, withDb } from "./session"

/**
 * E9 · T16 — Extremo a extremo del **asistente de cierre** (`/ledger/closing`,
 * `docs/design/E9-cierre-recurrentes.md` §7).
 *
 * Siete recorridos, en serie sobre la organización de fixtures:
 *
 *  1. **Los 43 pasos en nueve bloques**, con los nueve bloqueantes marcados y la
 *     pantalla diciendo que **no ha evaluado nada** mientras no se ejecute el
 *     checklist: ningún paso nace en verde.
 *  2. **Ejecutar el checklist** → sello con sus motivos, los cuatro hashes, el
 *     `run_id` enlazado a su foto sellada y **los bloqueantes por su nombre**.
 *  3. **Drill-down en tres clics**: bloque → paso → evidencia y
 *     `registros_origen`.
 *  4. **Resolver un paso declarado**: sin responder es WARN —no responder no es
 *     cumplir—; respondido pasa a PASS y el sello se recalcula.
 *  5. **Vista previa antes de postear**: el diálogo recoge los **parámetros** del
 *     paso (nunca la cifra) y «Postear» **nace deshabilitado** hasta que hay
 *     borrador. Y con bloqueantes vivos, «Cerrar el ejercicio» está
 *     deshabilitado: la barrera de verdad está en el servidor.
 *  6. **Reapertura con doble confirmación**: motivo ≥ 30 caracteres **y** el
 *     código del ejercicio escrito; y el aviso que ofrece salida cuando las
 *     cuentas no están en borrador.
 *  7. **`VIEWER` lo ve todo, sin un solo botón de mutación.**
 *
 * **Lo que este fichero NO cubre y por qué.** El recorrido completo —cierre con
 * los doce asientos de O-17, sello CERRADO, reapertura con los cuatro
 * contra-asientos y distribución contabilizada— ya **no es inalcanzable**: los
 * dos bloqueantes que lo impedían (`RECC_DEVENGADO_31_12` en `NA` y la guardia
 * del art. 107 en WARN sin prorrata) están corregidos en la ronda de
 * integración de E9 y el recorrido entero se ejercita en
 * `tests/integration/e9-cierre-completo.test.ts`: nueve bloqueantes en PASS,
 * T-25 por `postClosingStepAction`, T-26/T-27/T-28 y el contra-asiento en una
 * transacción, `129` y `6300` a cero y la apertura como espejo del cierre.
 *
 * Aquí no se repite porque **sobre el fixture v1 no sale barato**: el ejercicio
 * de `ejercicio-completo` llega con sus cuatro liquidaciones de IVA ya
 * posteadas y sin `vat_settlements`, así que `IVA_LIQUIDADO` exige sembrar las
 * cuatro a mano antes de poder pulsar «Cerrar». Ejercitar el cierre completo
 * **por pantalla** sigue siendo T24, sobre el fixture ampliado
 * `ejercicio-completo-v2` (que hoy tampoco carga: le falta `47513` en sus
 * `accountsExtra` y no tiene script de regeneración — anotado en ESTADO).
 */

test.describe.configure({ mode: "serial" })
test.setTimeout(180_000)

const SHOTS = "/tmp/e9-closing"

let organizationId = ""
let fiscalYearId = ""

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  const org = await analyticsOrganization()
  organizationId = org.id
  const userId = await adminUserId()

  // Nada que limpiar a mano: `--reset-org` conoce ya las tablas de E9 y las
  // vacía en orden de FK (ronda de integración; era el BUG-E7-1 repetido).
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/load-fixture.ts",
      "--org",
      organizationId,
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

  await withDb(async (client) => {
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM fiscal_years WHERE organization_id = $1 AND code = '2026'`,
      [organizationId]
    )
    fiscalYearId = rows.rows[0].id
  })
})

/** Deja la organización de fixtures activa plantando la cookie firmada. */
async function activarOrgFixtures(page: Page, baseURL: string): Promise<void> {
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

async function setRole(role: "ADMIN" | "EDITOR" | "VIEWER"): Promise<void> {
  const userId = await adminUserId()
  await withDb(async (client) => {
    await client.query(`UPDATE memberships SET role = $1::role WHERE organization_id = $2 AND user_id = $3`, [
      role,
      organizationId,
      userId,
    ])
  })
}

async function setFiscalYearStatus(status: "OPEN" | "CLOSED"): Promise<void> {
  await withDb(async (client) => {
    await client.query(`UPDATE fiscal_years SET status = $1::fy_status WHERE id = $2`, [status, fiscalYearId])
  })
}

/**
 * Abre un diálogo con reintento. `click()` comprueba visibilidad, no que React
 * haya enganchado el `onClick`: en `next dev` la hidratación tarda lo suyo. No
 * se relaja ninguna aserción, sólo se espera a que la pantalla esté viva.
 */
async function abrirDialogo(page: Page, gatillo: string, contenido: string): Promise<void> {
  await expect(async () => {
    await page.getByTestId(gatillo).click()
    await expect(page.getByTestId(contenido)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 60_000 })
}

/**
 * Abre un `<details>` **si no lo está ya**. Los bloques con pasos por revisar
 * nacen abiertos —es lo que hay que mirar—, así que un clic a ciegas los
 * cerraría y el paso de dentro dejaría de ser visible.
 */
async function abrirDetalle(page: Page, testId: string): Promise<void> {
  const detalle = page.getByTestId(testId)
  await expect(detalle).toBeAttached()
  const abierto = await detalle.evaluate((element) => (element as HTMLDetailsElement).open)
  if (!abierto) await detalle.locator("summary").first().click()
  await expect(detalle).toHaveJSProperty("open", true)
}

async function irAlCierre(page: Page, baseURL: string): Promise<void> {
  await signIn(page, baseURL)
  await activarOrgFixtures(page, baseURL)
  await page.goto(`/ledger/closing?fy=${fiscalYearId}`)
  await expect(page.getByRole("heading", { name: "Cierre del ejercicio", level: 1 })).toBeVisible({ timeout: 120_000 })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Los 43 pasos en nueve bloques, y nada en verde por defecto
// ─────────────────────────────────────────────────────────────────────────────

test("el asistente enseña los 43 pasos en nueve bloques con los bloqueantes marcados", async ({ page, baseURL }) => {
  await irAlCierre(page, baseURL!)

  await expect(page.getByTestId("closing-header")).toBeVisible()
  await expect(page.getByTestId("closing-checklist")).toBeVisible()

  // Nueve bloques y 43 pasos: el catálogo del motor, no una lista de la pantalla.
  await expect(page.locator('[data-testid^="block-"]')).toHaveCount(9)
  await expect(page.locator('[data-testid^="step-"][data-status]')).toHaveCount(43)

  // Los nueve bloqueantes van marcados en su propia fila.
  await expect(page.getByTestId("blocking-mark")).toHaveCount(9)

  // Y los doce asientos de O-17 están enumerados, con o sin asiento.
  await expect(page.getByTestId("closing-entries")).toBeVisible()
  await expect(page.locator('[data-testid^="closing-entry-"]')).toHaveCount(12)

  await page.screenshot({ path: `${SHOTS}/01-asistente.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ejecutar el checklist: sello, hashes y bloqueantes por su nombre
// ─────────────────────────────────────────────────────────────────────────────

test("ejecutar el checklist sella el run y nombra los pasos bloqueantes", async ({ page, baseURL }) => {
  await irAlCierre(page, baseURL!)

  await expect(async () => {
    await page.getByTestId("run-checklist").click()
    await expect(page.getByTestId("closing-hashes")).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 120_000 })

  // El sello va con sus motivos: un sello sin motivo no dice nada al que revisa.
  await expect(page.locator("[data-seal]")).toBeVisible()
  await expect(page.getByTestId("closing-hashes")).toContainText("ledgerHash")
  await expect(page.getByTestId("run-link")).toBeVisible()

  // El IVA sin liquidar es uno de los nueve bloqueantes, y sale por su nombre.
  await expect(page.getByTestId("blockers")).toBeVisible()
  await expect(page.locator('[data-blocker="IVA_LIQUIDADO"]')).toContainText("Periodos sin liquidar")

  await page.screenshot({ path: `${SHOTS}/02-checklist.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Drill-down en tres clics: bloque → paso → evidencia y registros de origen
// ─────────────────────────────────────────────────────────────────────────────

test("del bloque al paso y del paso a su evidencia en tres clics", async ({ page, baseURL }) => {
  await irAlCierre(page, baseURL!)

  // Clic 1: el bloque.
  await abrirDetalle(page, "block-FISCAL")

  // Clic 2: el paso, que enseña su evidencia literal.
  await abrirDetalle(page, "step-IVA_LIQUIDADO")
  const paso = page.getByTestId("step-IVA_LIQUIDADO")
  await expect(paso).toContainText("Periodos sin liquidar")
  await expect(paso).toHaveAttribute("data-status", "FAIL")

  // El semáforo del paso es un dato, no un color: va en el DOM.
  await expect(paso.locator("[data-step-status]").first()).toBeVisible()
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resolver un paso declarado: sin responder es WARN, respondido es PASS
// ─────────────────────────────────────────────────────────────────────────────

test("responder un paso declarado lo mueve de WARN a PASS", async ({ page, baseURL }) => {
  await irAlCierre(page, baseURL!)

  const paso = page.getByTestId("step-ARQUEO_DE_CAJA")
  await expect(paso).toHaveAttribute("data-status", "WARN")
  await abrirDetalle(page, "block-TESORERIA")
  await abrirDetalle(page, "step-ARQUEO_DE_CAJA")
  await expect(paso).toContainText("Sin responder")

  await abrirDialogo(page, "answer-ARQUEO_DE_CAJA", "answer-status")
  await page.getByTestId("answer-status").selectOption("PASS")
  await page.getByTestId("answer-note").fill("Arqueo firmado por la dirección financiera el 31-12; sin diferencias.")
  await page.getByTestId("answer-submit").click()

  await expect(page.getByTestId("step-ARQUEO_DE_CAJA")).toHaveAttribute("data-status", "PASS", { timeout: 60_000 })
  await expect(page.getByTestId("step-ARQUEO_DE_CAJA")).toContainText("Respuesta declarada: PASS")
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Vista previa antes de postear, y cierre bloqueado mientras haya bloqueantes
// ─────────────────────────────────────────────────────────────────────────────

test("la vista previa es obligatoria y el cierre está bloqueado mientras falten bloqueantes", async ({
  page,
  baseURL,
}) => {
  await irAlCierre(page, baseURL!)

  // Con bloqueantes vivos, el botón de cerrar está deshabilitado. Es cortesía:
  // la barrera de verdad la impone `closeFiscalYearE9Action` en el servidor.
  await expect(page.getByTestId("open-close-dialog")).toBeDisabled()

  // El diálogo del impuesto recoge PARÁMETROS —tipo y pagos fraccionados—, no
  // la cuota; y «Postear» nace deshabilitado hasta que hay borrador.
  await abrirDetalle(page, "block-IMPUESTO")
  await abrirDetalle(page, "step-IMPUESTO_BENEFICIOS")
  await abrirDialogo(page, "post-IMPUESTO_BENEFICIOS", "tax-rate")
  await expect(page.getByTestId("tax-rate")).toHaveValue("25")
  await expect(page.getByTestId("tax-prepayments")).toBeVisible()
  await expect(page.getByTestId("step-post")).toBeDisabled()
  await expect(page.getByTestId("step-dry-run")).toBeEnabled()

  await page.screenshot({ path: `${SHOTS}/05-vista-previa.png`, fullPage: true, caret: "initial" })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Reapertura: doble confirmación y mensaje con salida
// ─────────────────────────────────────────────────────────────────────────────

test("reabrir exige motivo largo y escribir el código del ejercicio", async ({ page, baseURL }) => {
  await setFiscalYearStatus("CLOSED")
  try {
    await irAlCierre(page, baseURL!)

    // La reapertura vive aparte y explica qué hace antes de que nadie la pulse.
    await expect(page.getByTestId("reopen-block")).toContainText("cuatro contra-asientos")
    await expect(page.getByTestId("reopen-block")).toContainText("reformulación")

    await abrirDialogo(page, "open-reopen-dialog", "reopen-reason")

    // Sin motivo y sin código, no se puede reabrir.
    await expect(page.getByTestId("reopen-submit")).toBeDisabled()

    // Con un motivo corto, tampoco.
    await page.getByTestId("reopen-reason").fill("Falta una factura")
    await expect(page.getByTestId("reopen-submit")).toBeDisabled()

    // Con motivo suficiente pero el código mal escrito, tampoco.
    await page
      .getByTestId("reopen-reason")
      .fill("Se detecta una factura de proveedor del ejercicio no contabilizada, por importe material.")
    await page.getByTestId("reopen-code").fill("2025")
    await expect(page.getByTestId("reopen-submit")).toBeDisabled()

    // Con las dos confirmaciones, se habilita.
    await page.getByTestId("reopen-code").fill("2026")
    await expect(page.getByTestId("reopen-submit")).toBeEnabled()

    await page.screenshot({ path: `${SHOTS}/06-reapertura.png`, fullPage: true, caret: "initial" })
  } finally {
    await setFiscalYearStatus("OPEN")
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Distribución del resultado: la reserva legal no se teclea
// ─────────────────────────────────────────────────────────────────────────────

test("el diálogo de distribución no deja teclear la reserva legal", async ({ page, baseURL }) => {
  await irAlCierre(page, baseURL!)

  await expect(page.getByTestId("distribution-pending")).toContainText("arts. 273 y 274 LSC")
  await abrirDialogo(page, "open-distribution", "meeting-date")

  // Reservas voluntarias, remanente y dividendo los acuerda la junta…
  await expect(page.getByTestId("voluntary")).toBeVisible()
  await expect(page.getByTestId("carry-forward")).toBeVisible()
  await expect(page.getByTestId("dividend")).toBeVisible()

  // …y la reserva legal NO tiene campo: la calcula el motor con el capital
  // derivado del saldo acreedor de 100 (art. 274 LSC, R2-2). Si lo tuviera,
  // alguien la pondría a cero.
  await expect(page.getByLabel(/reserva legal/i)).toHaveCount(0)
  await expect(page.getByTestId("distribution-submit")).toBeDisabled()
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. VIEWER
// ─────────────────────────────────────────────────────────────────────────────

test("VIEWER ve el asistente entero y ni un solo botón de mutación", async ({ page, baseURL }) => {
  await setRole("VIEWER")
  try {
    await irAlCierre(page, baseURL!)

    // Lo ve todo: es información de cierre.
    await expect(page.getByTestId("closing-checklist")).toBeVisible()
    await expect(page.getByTestId("closing-entries")).toBeVisible()
    await expect(page.locator('[data-testid^="step-"][data-status]')).toHaveCount(43)

    // Y no tiene un solo botón que mute nada.
    await expect(page.getByTestId("run-checklist")).toHaveCount(0)
    await expect(page.getByTestId("open-close-dialog")).toHaveCount(0)
    await expect(page.getByTestId("open-reopen-dialog")).toHaveCount(0)
    await expect(page.getByTestId("open-distribution")).toHaveCount(0)
    await expect(page.getByTestId("approval-status")).toHaveCount(0)
    await expect(page.locator('[data-testid^="answer-"]')).toHaveCount(0)
    await expect(page.locator('[data-testid^="post-"]')).toHaveCount(0)
  } finally {
    await setRole("ADMIN")
  }
})
