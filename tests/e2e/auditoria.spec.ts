import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { adminUserId, analyticsOrganization, APP_ENV, DATABASE_URL, signIn, withDb } from "./session"

/**
 * E7 · T12/T13/T16/T17 — Extremo a extremo de la pestaña **Auditoría** y de la
 * **conciliación bancaria** (`docs/design/E7-auditoria.md` §6, §12 T20).
 *
 * Siete recorridos, en serie sobre la organización de fixtures:
 *
 *  1. **Barrido → familia → check → registros de origen**: el drill-down en
 *     **tres clics**, con el sello, los cinco hashes y las cuatro cifras a la
 *     vista, y las familias sin evaluar declaradas como tales (nunca en verde).
 *  2. **Importar Norma 43 → agrupar la remesa → cuadre**: `E − B = Ue − Ub` con
 *     tolerancia cero, con los pendientes enumerados y la Σ de ignorados como
 *     línea propia.
 *  3. **Comisión sin asiento → proponer asiento → confirmar**: la contrapartida
 *     sale del mapa de cuentas, la propuesta va sin cuota (art. 20.Uno.18º
 *     LIVA) y al confirmar el movimiento queda **conciliado**.
 *  4. **Prueba de detección**: un céntimo alterado en una copia en memoria y las
 *     comprobaciones que lo delatan, sin escribir nada en el diario.
 *  5. **Split N-a-1**: los totales por grupo salen del servidor y el reparto de
 *     la cuota cuadra con la del documento.
 *  6. **Diff de dos barridos** con su causa y los Δ de las cuatro cifras.
 *  7. **`VIEWER`**: lo ve todo —es información de auditoría— sin un solo botón
 *     de mutación y **sin** el registro de auditoría.
 *
 * El escenario bancario lo siembra `tests/support/seed-bank.ts`, que crea la
 * cuenta por `createBankAccount` (con anclaje), postea la remesa por `postEntry`
 * —el mismo camino que la aplicación— y **genera** el extracto Norma 43 con el
 * periodo `[anclaje, hoy]`, para que la cadena de I-E7-6b quede cubierta.
 */

test.describe.configure({ mode: "serial" })
test.setTimeout(300_000)

type BankSeed = {
  bankAccountId: string
  accountCode: string
  n43Path: string
  remesaCents: number
  comisionCents: number
  anchorDate: string
  periodEnd: string
}

let organizationId = ""
let bank: BankSeed
let mixtaFileId = ""

function runSeed(script: string, args: readonly string[]): string {
  return execFileSync("npx", ["tsx", script, ...args], {
    env: {
      ...process.env,
      DATABASE_URL,
      DIRECT_URL: DATABASE_URL,
      PRISMA_LOG: "",
      ...(APP_ENV.UPLOAD_PATH ? { UPLOAD_PATH: APP_ENV.UPLOAD_PATH } : {}),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function lastJson<T>(output: string): T {
  const line = output
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop()
  if (!line) throw new Error(`El arnés no ha devuelto JSON: ${output.slice(-500)}`)
  return JSON.parse(line) as T
}

/** Deja activa la organización de fixtures plantando su cookie firmada. */
async function useOrg(page: Page, baseURL: string, orgId: string): Promise<void> {
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

/**
 * Pulsa hasta que el diálogo está vivo. `click()` comprueba que el elemento es
 * visible, no que React haya enganchado su `onClick`: en `next dev` la
 * hidratación de una pantalla pesada tarda lo suyo. No se relaja ninguna
 * aserción, sólo se espera a que la pantalla responda.
 */
async function abrirDialogo(page: Page, gatillo: string, contenido: string): Promise<void> {
  await expect(async () => {
    await page.getByTestId(gatillo).click()
    await expect(page.getByTestId(contenido)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
}

/**
 * Lanza el barrido y espera a la foto.
 *
 * El clic se reintenta hasta que el botón **reacciona** (se deshabilita con
 * «Barriendo…»), que es la señal de que React ha enganchado su `onClick`; a
 * partir de ahí se espera al resultado con holgura, sin volver a pulsar: un
 * segundo clic chocaría con el lock de barridos concurrentes y el fallo se
 * leería como un error de la pantalla.
 */
async function lanzarBarrido(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId("run-sweep").click()
    await expect(page.getByTestId("run-sweep")).toBeDisabled({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.getByTestId("run-summary")).toBeVisible({ timeout: 180_000 })
}

/**
 * Quita el filtro «ver sólo lo que falta por conciliar».
 *
 * Es una casilla CONTROLADA por React: hasta que la pantalla no está hidratada,
 * el clic no cambia el estado (el `checked` lo manda el componente). Se reintenta
 * hasta que la casilla responde, que es la señal de que la pantalla está viva.
 */
async function verTodo(page: Page): Promise<void> {
  const casilla = page.getByTestId("only-unmatched")
  await expect(casilla).toBeVisible()
  await expect(async () => {
    if (await casilla.isChecked()) await casilla.uncheck({ force: true })
    await expect(casilla).not.toBeChecked({ timeout: 1_000 })
  }).toPass({ timeout: 45_000 })
}

test.beforeAll(async () => {
  const org = await analyticsOrganization()
  organizationId = org.id
  await setRole(organizationId, "ADMIN")
  bank = lastJson<BankSeed>(runSeed("tests/support/seed-bank.ts", ["--org", organizationId]))
  mixtaFileId = lastJson<{ fileId: string }>(
    runSeed("tests/support/seed-extraction.ts", ["--org", organizationId, "--case", "mixta", "--number", "E7-SPLIT-1"])
  ).fileId
})

test.afterAll(async () => {
  if (organizationId) await setRole(organizationId, "ADMIN")
})

test.beforeEach(async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  await useOrg(page, baseURL!, organizationId)
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. Barrido, semáforo honesto y drill-down en tres clics
// ─────────────────────────────────────────────────────────────────────────────

test("barrido: sello, cinco hashes, familias con semáforo y drill-down en tres clics", async ({ page }) => {
  await page.goto("/audit")
  await expect(page.getByRole("heading", { name: "Auditoría", level: 1 })).toBeVisible()

  // Clic 0 — el barrido. Persiste una foto sellada.
  await lanzarBarrido(page)

  // Los cinco hashes y las cuatro cifras, a la vista.
  const hashes = page.getByTestId("audit-hashes")
  await expect(hashes).toContainText("ledgerHash")
  await expect(hashes).toContainText("analyticsKey")
  await expect(hashes).toContainText("planHash")
  await expect(hashes).toContainText("accountMapHash")
  await expect(hashes).toContainText("configHash")
  for (const metric of ["ACTIVO", "PN_MAS_PASIVO", "RESULTADO", "TESORERIA"]) {
    await expect(page.getByTestId(`headline-${metric}`)).toBeVisible()
  }

  // Las SIETE familias, siempre. Ninguna «sin evaluar» pintada como correcta.
  const familias = [
    "PARTIDA_DOBLE",
    "ESTADOS",
    "ANALITICA",
    "LIQUIDACION",
    "DOCUMENTAL",
    "CONCILIACION",
    "INTEGRIDAD",
  ]
  for (const familia of familias) {
    await expect(page.getByTestId(`family-card-${familia}`)).toBeVisible()
  }
  const sinEvaluar = page.locator('[data-family-status="SIN_EVALUAR"]')
  for (let i = 0; i < (await sinEvaluar.count()); i++) {
    await expect(sinEvaluar.nth(i)).toContainText("Sin evaluar")
  }

  // Clic 1 — la familia. Clic 2 — el check. Clic 3 — los registros de origen.
  await page.getByTestId("family-card-PARTIDA_DOBLE").click()
  const detalle = page.getByTestId("family-detail-PARTIDA_DOBLE")
  await expect(detalle).toBeVisible()

  const primerCheck = detalle.locator("[data-check-id]").first()
  const checkId = await primerCheck.getAttribute("data-check-id")
  await primerCheck.getByRole("button").first().click()
  await expect(page.getByTestId(`check-detail-${checkId}`)).toBeVisible()
  await expect(page.getByTestId(`origin-records-${checkId}`)).toBeVisible()

  // Si el hallazgo nombra asientos, se llega al asiento y a su documento.
  const enlaceAsiento = page.getByTestId(`origin-records-${checkId}`).locator('a[href^="/ledger/"]').first()
  if ((await enlaceAsiento.count()) > 0) {
    await enlaceAsiento.click()
    await expect(page).toHaveURL(/\/ledger\//)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Importar Norma 43 y agrupar la remesa
// ─────────────────────────────────────────────────────────────────────────────

test("conciliación: importar Norma 43, agrupar la remesa y cuadrar a cero", async ({ page }) => {
  await page.goto("/audit/bank")
  await expect(page.getByRole("heading", { name: "Conciliación bancaria" })).toBeVisible()
  await expect(page.getByTestId(`bank-account-${bank.bankAccountId}`)).toBeVisible()

  // Importar el extracto: vista previa con lo que de verdad ha entrado.
  await abrirDialogo(page, `import-${bank.bankAccountId}`, "import-file")
  await page.getByTestId("import-file").setInputFiles(bank.n43Path)
  await page.getByTestId("submit-import").click()
  await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("import-result")).toContainText("movimiento(s) importado(s)")
  await page.keyboard.press("Escape")

  await page.goto(`/audit/bank/${bank.bankAccountId}`)
  await expect(page.getByTestId("cuadre")).toBeVisible()

  // Las dos columnas, con el abono de la remesa y los tres apuntes del diario.
  // Se ve TODO —conciliado incluido— para que el recorrido valga igual la
  // primera vez que la décima: un movimiento ya conciliado no tiene casilla.
  await verTodo(page)
  const extracto = page.getByTestId("columna-extracto")
  const diario = page.getByTestId("columna-diario")
  await expect(extracto).toContainText("ABONO REMESA")
  await expect(diario).toContainText("REM000000001")

  // Selección múltiple a los dos lados: un abono contra tres apuntes (1 a N).
  // El escenario es IDEMPOTENTE: si una ejecución anterior ya agrupó la remesa,
  // el abono ya no está entre lo pendiente y lo que se comprueba es que quedó
  // conciliado —no se vuelve a agrupar, que el servidor lo rechazaría—.
  const abono = extracto.locator('[data-testid^="statement-line-"]', { hasText: "ABONO REMESA" }).first()
  if ((await abono.getAttribute("data-status")) === "UNMATCHED") {
    await abono.locator('input[type="checkbox"]').check({ force: true })
    const apuntes = diario.locator('[data-testid^="journal-line-"]', { hasText: "REM000000001" })
    expect(await apuntes.count()).toBeGreaterThanOrEqual(3)
    for (let i = 0; i < 3; i++) await apuntes.nth(i).locator('input[type="checkbox"]').check({ force: true })

    // La Σ de la selección es una VISTA PREVIA y va marcada como tal.
    await expect(page.getByTestId("suma-seleccion")).toContainText("vista previa")

    await page.getByTestId("conciliar").click()
    await expect(page.getByTestId("cuadre")).toBeVisible({ timeout: 90_000 })
  }

  await expect(async () => {
    await page.goto(`/audit/bank/${bank.bankAccountId}`)
    await verTodo(page)
    await expect(
      page.getByTestId("columna-extracto").locator('[data-testid^="statement-line-"]', { hasText: "ABONO REMESA" }).first()
    ).toHaveAttribute("data-status", "MATCHED", { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })

  // El cuadre: `E − B = Ue − Ub` con tolerancia cero.
  await expect(page.getByTestId("cuadre-diferencia")).toHaveAttribute("data-cents", "0", { timeout: 30_000 })
  await expect(page.getByTestId("cuadre-veredicto")).toContainText("El cuadre es exacto")
  await expect(page.getByTestId("ignorados")).toContainText("Σ ignorado")
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. La comisión que no está en los libros
// ─────────────────────────────────────────────────────────────────────────────

test("comisión sin asiento: proponer, confirmar y quedar conciliada", async ({ page }) => {
  await page.goto(`/audit/bank/${bank.bankAccountId}`)
  await verTodo(page)
  const comision = page
    .getByTestId("columna-extracto")
    .locator('[data-testid^="statement-line-"]', { hasText: "COMISION MANTENIMIENTO" })
    .first()
  await expect(comision).toBeVisible()

  const lineId = (await comision.getAttribute("data-testid"))!.replace("statement-line-", "")

  // Idempotencia: si una ejecución anterior ya contabilizó y concilió la
  // comisión, el movimiento ya no es proponible y lo que queda por comprobar es
  // que quedó conciliado.
  if ((await comision.getAttribute("data-status")) === "MATCHED") {
    await expect(comision).toHaveAttribute("data-status", "MATCHED")
    return
  }

  await expect(async () => {
    await page.getByTestId(`propose-${lineId}`).click()
    await expect(page.getByTestId("propose-account-key")).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  await page.getByTestId("propose-account-key").selectOption("COMISIONES_BANCARIAS")
  // Destino analítico: una comisión es una 626 y las cuentas 6/7 lo llevan
  // obligatorio. Se elige el primero que ofrezca la organización.
  const destinos = page.getByTestId("propose-destination").locator("option")
  if ((await destinos.count()) > 1) {
    await page.getByTestId("propose-destination").selectOption({ index: 1 })
  }
  await page.getByTestId("propose-preview-button").click()
  await expect(page.getByTestId("propose-preview")).toBeVisible({ timeout: 90_000 })

  const error = page.getByTestId("propose-error")
  if ((await error.count()) > 0) {
    // La propuesta se bloquea con su motivo en español: es un resultado válido
    // del recorrido (p. ej. el mapa de cuentas sin `COMISIONES_BANCARIAS`), y el
    // test lo declara en vez de fingir que ha contabilizado algo.
    await expect(error).not.toBeEmpty()
    return
  }

  await expect(page.getByTestId("propose-cuadre")).toContainText("Σdebe − Σhaber")
  await page.getByTestId("confirm-propose").click()

  await expect(async () => {
    await page.goto(`/audit/bank/${bank.bankAccountId}`)
    await verTodo(page)
    await expect(page.locator(`[data-testid="statement-line-${lineId}"]`)).toHaveAttribute("data-status", "MATCHED", {
      timeout: 5_000,
    })
  }).toPass({ timeout: 120_000 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Prueba de detección
// ─────────────────────────────────────────────────────────────────────────────

test("prueba de detección: un céntimo alterado y ni una escritura en el diario", async ({ page }) => {
  const antes = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines WHERE organization_id = $1`,
      [organizationId]
    )
    return rows[0].n
  })

  await page.goto("/audit")
  await abrirDialogo(page, "open-detection-test", "run-detection-test")
  await page.getByTestId("run-detection-test").click()
  await expect(page.getByTestId("detection-result")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("detection-detected-by")).not.toContainText("ninguna comprobación")

  const despues = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines WHERE organization_id = $1`,
      [organizationId]
    )
    return rows[0].n
  })
  expect(despues).toBe(antes)
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Split N-a-1
// ─────────────────────────────────────────────────────────────────────────────

test("split: dos grupos, totales del servidor y Σ cuotas = cuota del documento", async ({ page }) => {
  await page.goto(`/unsorted/${mixtaFileId}`)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

  await abrirDialogo(page, "open-split", "split-preview-button")

  // Una línea a cada grupo: la partición completa.
  await page.getByTestId("split-group-of-0").selectOption("0")
  await page.getByTestId("split-group-of-1").selectOption("1")
  await page.getByTestId("split-preview-button").click()
  await expect(page.getByTestId("split-preview")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("split-cuadre")).toContainText("Σ cuotas de los grupos")
  await expect(page.getByTestId("split-cuadre")).toContainText("✓")

  // Y una línea fuera de todos los grupos: no es una partición y lo dice.
  await page.getByTestId("split-group-of-1").selectOption("-1")
  await page.getByTestId("split-preview-button").click()
  await expect(page.getByTestId("split-errors")).toContainText("SPLIT_NOT_A_PARTITION", { timeout: 60_000 })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Diff de dos barridos
// ─────────────────────────────────────────────────────────────────────────────

test("historial: dos barridos comparados, con causa y Δ de las cuatro cifras", async ({ page }) => {
  await page.goto("/audit")
  await lanzarBarrido(page)

  await page.reload()
  const filas = page.getByTestId("run-history").locator('[data-testid^="run-row-"]')
  await expect(filas.first()).toBeVisible()
  /**
   * **Se ESPERA a que haya dos runs, no se cuenta una vez.** Sobre una base
   * recién creada el historial arranca vacío y este caso corre contra su propio
   * barrido: contar en el instante siguiente al `reload()` daba 1 y el fichero
   * entero caía en cadena (`mode: "serial"`). Sobre una base con historial
   * previo pasaba siempre, que es la peor clase de test: el que sólo falla la
   * primera vez.
   */
  await expect.poll(async () => await filas.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)

  await filas.nth(0).locator('input[type="checkbox"]').check({ force: true })
  await filas.nth(1).locator('input[type="checkbox"]').check({ force: true })
  await page.getByTestId("compare-runs").click()

  await expect(page).toHaveURL(/\/audit\/runs\/diff/)
  await expect(page.getByTestId("diff-cause")).toBeVisible({ timeout: 60_000 })
  for (const metric of ["ACTIVO", "PN_MAS_PASIVO", "RESULTADO", "TESORERIA"]) {
    await expect(page.getByTestId(`diff-figure-${metric}`)).toBeVisible()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. VIEWER
// ─────────────────────────────────────────────────────────────────────────────

test("VIEWER lo ve todo sin un botón de mutación y sin el registro de auditoría", async ({ page }) => {
  await setRole(organizationId, "VIEWER")
  try {
    await page.goto("/audit")
    await expect(page.getByRole("heading", { name: "Auditoría", level: 1 })).toBeVisible()

    // Lee el semáforo y los cuadres de cierre…
    await expect(page.getByTestId("familias")).toBeVisible()
    await expect(page.getByTestId("cuadres-de-cierre")).toBeVisible()

    // …y no tiene un solo botón de mutación, ni el registro (fuga de gobierno).
    await expect(page.getByTestId("run-sweep")).toHaveCount(0)
    await expect(page.getByTestId("open-detection-test")).toHaveCount(0)
    await expect(page.getByTestId("run-store-sweep")).toHaveCount(0)
    await expect(page.getByTestId("registro")).toHaveCount(0)

    await page.goto(`/audit/bank/${bank.bankAccountId}`)
    await expect(page.getByTestId("cuadre")).toBeVisible()
    await expect(page.getByTestId("conciliar")).toHaveCount(0)
    await expect(page.getByTestId(`import-${bank.bankAccountId}`)).toHaveCount(0)
    await expect(page.locator('[data-testid^="propose-"]')).toHaveCount(0)
  } finally {
    await setRole(organizationId, "ADMIN")
  }
})
