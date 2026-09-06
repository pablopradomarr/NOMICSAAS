import { expect, test, type Page } from "@playwright/test"
import { createHmac } from "node:crypto"
import { mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { adminUserId, APP_ENV, DATABASE_URL as DATABASE_URL_OWNER, signIn, withDb } from "./session"

/**
 * E5 · T15 — Extremo a extremo de la liquidación de centros de coste
 * (`docs/design/E5-liquidacion.md` §8.1).
 *
 * Un recorrido completo, en serie sobre la organización analítica:
 *
 *  1. **Reglas**: se dan de alta desde la UI las seis reglas del fixture
 *     `docs/design/fixtures/liquidacion-esperada.json`, en cuatro conjuntos
 *     (uno por centro de coste fuente), con sus cuotas, drivers y prioridades.
 *  2. **Simulación y sellado**: 2026-11 (mensual), 2026-Q2 (trimestral) y 2026
 *     (anual) — los tres únicos periodos con reparto en el fixture. La
 *     simulación se aprueba y el sellado lleva sus tres sellos.
 *  3. **PyG analítica imputada**: el EBITDA de P-01 vale **−306,43 €** y los
 *     centros de coste imputables quedan a cero.
 *  4. **Reversión**: el run mensual pasa a `REVERSED` con su motivo, deja de
 *     aportar y **no se genera ningún asiento**.
 *  5. **Caducidad**: una regla nueva mueve el `rulesHash` del periodo y el run
 *     anual sellado aparece como **caducado**, con el motivo.
 *  6. **VIEWER**: ve las tres pantallas y ninguno de los botones de mutación.
 *
 * Higiene: el estado de liquidación se vacía al empezar (los e2e acumulan
 * estado en la base de desarrollo, ver `docs/ESTADO.md`). El arnés lee y limpia
 * con el rol PROPIETARIO, como el resto de la suite.
 */

const SHOTS = process.env.E2E_SHOTS_DIR || "/tmp/e5-screens"
const VALID_FROM = "2026-01-01"

test.describe.configure({ mode: "serial" })

/**
 * Higiene (docs/ESTADO.md §Higiene del entorno e2e): las cifras esperadas de
 * esta suite son las del fixture `ejercicio-completo`, y los e2e que corren
 * antes (`analitica.spec.ts`) reclasifican líneas y dan de alta proyectos en la
 * misma organización. Sin recargar el fixture, la liquidación sería correcta y
 * el test fallaría por la razón equivocada. La recarga la hace el script de
 * operador, con el rol propietario y `DATABASE_URL_MAINTENANCE`.
 */
test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  const org = await analyticsOrganization()
  const userId = await adminUserId()
  // `--reset-org` es de E4 y no conoce las tablas de E5: sin vaciarlas antes, el
  // borrado de los ejercicios choca con `allocation_runs_fiscal_year_fkey`.
  await resetAllocations(org.id)
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
})

async function analyticsOrganization(): Promise<{ id: string; name: string }> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT o.id, o.name
         FROM organizations o
         JOIN journal_lines l ON l.organization_id = o.id AND l.project_id IS NOT NULL
        WHERE o.is_active
        GROUP BY o.id, o.name
        ORDER BY count(*) DESC
        LIMIT 1`
    )
    if (rows.length === 0) {
      throw new Error(
        "Ninguna organización tiene analítica cargada: ejecuta " +
          "`npx tsx scripts/load-fixture.ts --org <id> --fixture tests/fixtures/ejercicio-completo.json`"
      )
    }
    return rows[0]
  })
}

/** Deja la organización analítica activa plantando la cookie firmada. */
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

/**
 * Vacía la liquidación de la organización. Sin esto, una segunda pasada
 * chocaría con el código de regla ya existente y con el índice único parcial de
 * un run `SEALED` por periodo.
 */
async function resetAllocations(organizationId: string): Promise<void> {
  await withDb(async (client) => {
    await client.query(`DELETE FROM allocation_lines WHERE organization_id = $1`, [organizationId])
    await client.query(`DELETE FROM allocation_runs WHERE organization_id = $1`, [organizationId])
    await client.query(`DELETE FROM allocation_rule_targets WHERE organization_id = $1`, [organizationId])
    await client.query(`DELETE FROM allocation_rules WHERE organization_id = $1`, [organizationId])
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

type DraftTarget = { code: string; percent?: string; amount?: string }

/** Códigos → id de las dimensiones, para conducir los desplegables sin ambigüedad. */
async function dimensionIds(organizationId: string): Promise<Map<string, string>> {
  return await withDb(async (client) => {
    const out = new Map<string, string>()
    for (const table of ["cost_centers", "projects", "business_lines"]) {
      const { rows } = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM ${table} WHERE organization_id = $1`,
        [organizationId]
      )
      for (const row of rows) out.set(row.code, row.id)
    }
    return out
  })
}

type DraftRule = {
  code: string
  name: string
  driver: string
  targetKind: string
  period: string
  priority: string
  sharePercent: string
  fallback: string
  onlyActive: boolean
  targets?: DraftTarget[]
}

/** Rellena el diálogo de alta con el conjunto de reglas de un centro de coste. */
async function createRuleSet(page: Page, sourceCode: string, rules: DraftRule[]): Promise<void> {
  const ids = await dimensionIds((await analyticsOrganization()).id)
  const idOf = (code: string): string => {
    const id = ids.get(code)
    if (!id) throw new Error(`El fixture no tiene la dimensión ${code}`)
    return id
  }
  await page.getByTestId("new-allocation-rule").click()
  await page.getByTestId("rule-source").selectOption(idOf(sourceCode))
  await page.getByTestId("rule-valid-from").fill(VALID_FROM)

  for (let i = 1; i < rules.length; i++) await page.getByTestId("add-rule").click()

  for (const [index, rule] of rules.entries()) {
    const n = index + 1
    const card = page.getByTestId("rule-draft").nth(index)
    await page.getByLabel(`Código de la regla ${n}`).fill(rule.code)
    await page.getByLabel(`Nombre de la regla ${n}`).fill(rule.name)
    await page.getByLabel(`Driver de la regla ${n}`).selectOption(rule.driver)
    await page.getByLabel(`Destinatarios de la regla ${n}`).selectOption(rule.targetKind)
    await page.getByLabel(`Periodicidad de la regla ${n}`).selectOption(rule.period)
    await page.getByLabel(`Prioridad de la regla ${n}`).fill(rule.priority)
    await page.getByLabel(`Cuota del saldo de la regla ${n}`).fill(rule.sharePercent)
    await page.getByLabel(`Base cero de la regla ${n}`).selectOption(rule.fallback)

    if (rule.targetKind === "PROJECTS") {
      const onlyActive = card.getByRole("checkbox")
      if ((await onlyActive.isChecked()) !== rule.onlyActive) await onlyActive.click()
    }

    for (const [targetIndex, target] of (rule.targets ?? []).entries()) {
      await card.getByTestId("add-target").click()
      await card.getByLabel("Destino", { exact: true }).nth(targetIndex).selectOption(idOf(target.code))
      if (target.percent !== undefined) {
        await card.getByLabel("Porcentaje", { exact: true }).nth(targetIndex).fill(target.percent)
      }
      if (target.amount !== undefined) {
        await card.getByLabel("Importe en euros", { exact: true }).nth(targetIndex).fill(target.amount)
      }
    }
  }

  await page.getByTestId("save-allocation-rules").click()
  await expect(page.getByTestId("save-allocation-rules")).toBeHidden({ timeout: 30_000 })
}

/** Simula un periodo y lo sella. Devuelve el número de líneas de la simulación. */
async function simulateAndSeal(
  page: Page,
  period: { kind: "MONTH" | "QUARTER" | "YEAR"; index?: number; label: string }
): Promise<void> {
  await page.getByTestId("period-kind").selectOption(period.kind)
  if (period.kind !== "YEAR") await page.getByTestId("period-index").selectOption(String(period.index ?? 0))
  await page.getByTestId("simulate").click()
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("preview-period")).toHaveText(period.label)
  // I5: lo repartido iguala lo declarado, tolerancia 0.
  await expect(page.getByTestId("preview-balance-check").locator("[data-balance-difference]")).toHaveAttribute(
    "data-balance-difference",
    "0"
  )
  await page.getByTestId("seal-run").click()
  await expect(page.getByTestId("seal-done")).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async ({ page, baseURL }) => {
  const url = baseURL ?? "http://localhost:7331"
  await signIn(page, url)
  const org = await analyticsOrganization()
  await useAnalyticsOrg(page, url, org.id)
})

test("se dan de alta las seis reglas de liquidación del fixture", async ({ page }) => {
  const org = await analyticsOrganization()
  await resetAllocations(org.id)
  await setRole(org.id, "ADMIN")

  await page.goto("/analytics/allocations", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Reglas de liquidación" })).toBeVisible()
  await expect(page.getByTestId("allocation-rules-empty")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/01-reglas-vacio.png`, fullPage: true })

  // Operaciones indirectas: mensual por coste directo (con base cero → YTD) y
  // anual para absorber lo que le llega en cascada de G&A.
  await createRuleSet(page, "CC-OPS", [
    {
      code: "AL-OPS-M",
      name: "Operaciones indirectas a proyectos por coste directo (mensual)",
      driver: "DIRECT_COST_SHARE",
      targetKind: "PROJECTS",
      period: "MONTH",
      priority: "10",
      sharePercent: "100",
      fallback: "YTD",
      onlyActive: true,
    },
    {
      code: "AL-OPS-Y",
      name: "Operaciones indirectas a proyectos por coste directo (anual)",
      driver: "DIRECT_COST_SHARE",
      targetKind: "PROJECTS",
      period: "YEAR",
      priority: "30",
      sharePercent: "100",
      fallback: "SKIP_WARN",
      onlyActive: false,
    },
  ])

  await createRuleSet(page, "CC-DEV", [
    {
      code: "AL-DEV-Q",
      name: "Desarrollo de producto a lineas de negocio 60/40 (trimestral)",
      driver: "FIXED_PERCENT",
      targetKind: "BUSINESS_LINES",
      period: "QUARTER",
      priority: "10",
      sharePercent: "100",
      fallback: "SKIP_WARN",
      onlyActive: false,
      targets: [
        { code: "BL-CONS", percent: "60" },
        { code: "BL-DEV", percent: "40" },
      ],
    },
  ])

  await createRuleSet(page, "CC-MKT", [
    {
      code: "AL-MKT-Q",
      name: "Marketing y ventas a proyectos por ingresos (trimestral)",
      driver: "REVENUE_SHARE",
      targetKind: "PROJECTS",
      period: "QUARTER",
      priority: "20",
      sharePercent: "100",
      fallback: "SKIP_WARN",
      onlyActive: true,
    },
  ])

  // G&A reparte fraccionado: 30 % en cascada a CC-OPS y 70 % a proyectos.
  await createRuleSet(page, "CC-GA", [
    {
      code: "AL-GA-OPS-Y",
      name: "G&A: 30 % a Operaciones indirectas (cascada, anual)",
      driver: "FIXED_PERCENT",
      targetKind: "COST_CENTERS",
      period: "YEAR",
      priority: "10",
      sharePercent: "30",
      fallback: "SKIP_WARN",
      onlyActive: false,
      targets: [{ code: "CC-OPS", percent: "100" }],
    },
    {
      code: "AL-GA-PRY-Y",
      name: "G&A: 70 % a proyectos a partes iguales (anual)",
      driver: "EQUAL",
      targetKind: "PROJECTS",
      period: "YEAR",
      priority: "20",
      sharePercent: "70",
      fallback: "SKIP_WARN",
      onlyActive: false,
    },
  ])

  for (const code of ["AL-OPS-M", "AL-OPS-Y", "AL-DEV-Q", "AL-MKT-Q", "AL-GA-OPS-Y", "AL-GA-PRY-Y"]) {
    await expect(page.locator(`[data-rule-code="${code}"]`)).toBeVisible()
  }
  // Cobertura completa: ningún centro de coste declara menos del 100 %.
  await expect(page.getByTestId("share-warning")).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/02-reglas.png`, fullPage: true })

  const stored = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM allocation_rules WHERE organization_id = $1 AND is_active`,
      [org.id]
    )
    return Number(rows[0].n)
  })
  expect(stored).toBe(6)
})

test("se simulan y sellan los tres periodos con reparto", async ({ page }) => {
  await page.goto("/analytics/allocations/runs", { waitUntil: "networkidle" })
  await expect(page.getByRole("heading", { name: "Liquidaciones de centros de coste" })).toBeVisible()
  await expect(page.getByTestId("preview-idle")).toBeVisible()

  // Noviembre: la base del driver del periodo es cero y la regla amplía al
  // acumulado del ejercicio (`W-E5-ZERO-BASE` + fallback YTD).
  await page.getByTestId("period-kind").selectOption("MONTH")
  await page.getByTestId("period-index").selectOption("10")
  await page.getByTestId("simulate").click()
  await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-warning-code="W-E5-ZERO-BASE"]')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/03-simulacion-mensual.png`, fullPage: true })
  await page.getByTestId("seal-run").click()
  await expect(page.getByTestId("seal-done")).toBeVisible({ timeout: 30_000 })

  // Segundo trimestre: base negativa en P-03, que queda excluido con peso 0.
  await simulateAndSeal(page, { kind: "QUARTER", index: 1, label: "2026-Q2" })
  await simulateAndSeal(page, { kind: "YEAR", label: "2026" })

  await page.reload({ waitUntil: "networkidle" })
  for (const label of ["2026-11", "2026-Q2", "2026"]) {
    await expect(page.locator(`[data-run-period="${label}"]`)).toBeVisible()
  }
  await page.screenshot({ path: `${SHOTS}/04-runs.png`, fullPage: true })

  const totals = await withDb(async (client) => {
    const { rows } = await client.query<{ lines: string; total: string }>(
      `SELECT count(*)::text AS lines, COALESCE(sum(l.amount_cents),0)::text AS total
         FROM allocation_lines l
         JOIN allocation_runs r ON r.id = l.run_id
        WHERE r.status = 'SEALED'`
    )
    return rows[0]
  })
  // Fixture `liquidacion-esperada.json`: 14 líneas, 1.075.524 céntimos.
  expect(Number(totals.lines)).toBe(14)
  expect(Number(totals.total)).toBe(1_075_524)
})

test("la PyG analítica imputada deja el EBITDA de P-01 en −306,43 €", async ({ page }) => {
  await page.goto("/analytics/pyg?from=2026-01-01&to=2026-12-31", { waitUntil: "networkidle" })
  await expect(page.getByTestId("toggle-allocations")).toHaveAttribute("data-allocations", "no")
  await page.getByTestId("toggle-allocations").click()
  await page.waitForURL(/imputaciones=si/, { timeout: 30_000 })
  await expect(page.getByTestId("margin-matrix")).toBeVisible()

  // El cuarto sello, el de las imputaciones.
  await expect(page.getByTestId("report-hashes")).toContainText("allocationRunSetHash")

  // EBITDA de P-01 con estructura absorbida.
  const cell = page.locator('[data-cell="EBITDA|PROJ:P-01"] [data-cents]')
  await expect(cell).toHaveAttribute("data-cents", "-30643")
  await expect(cell).toContainText("306,43")

  // Los centros de coste imputables quedan a cero y la matriz sigue cuadrando.
  await expect(page.locator('[data-cell="EBITDA|CECO:OPERACIONES_INDIRECTAS"]')).toContainText("—")
  await expect(page.locator('[data-cell="EBITDA|CECO:G_A"]')).toContainText("—")
  await expect(
    page.getByTestId("matrix-balance-check").locator("[data-balance-difference]")
  ).toHaveAttribute("data-balance-difference", "0")

  // Columna `BL:` real: lo imputado a la línea de negocio y no bajado a proyecto.
  await expect(page.locator('[data-column-key="BLREAL:BL-CONS"]')).toBeVisible()
  await expect(page.getByTestId("pending-settlement")).toBeVisible()
  await expect(page.getByTestId("pending-runs-link")).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/05-pyg-imputada.png`, fullPage: true })

  // Drill-down: la celda imputada enseña las líneas de reparto que la aportan.
  await page.locator('[data-cell="MC3|PROJ:P-01"] button').click()
  await expect(page.getByTestId("cell-allocation-lines")).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/06-drilldown-imputacion.png`, fullPage: true })
  await page.getByRole("button", { name: "Cerrar" }).click()

  // Sin imputaciones, el mismo proyecto no absorbe estructura.
  await page.getByTestId("toggle-allocations").click()
  await page.waitForURL((url) => !url.searchParams.has("imputaciones"), { timeout: 30_000 })
  await expect(page.locator('[data-cell="EBITDA|PROJ:P-01"] [data-cents]')).not.toHaveAttribute("data-cents", "-30643")
})

test("revertir una liquidación la deja en REVERSED con su motivo y sin tocar el diario", async ({ page }) => {
  const org = await analyticsOrganization()
  const ledgerBefore = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1`,
      [org.id]
    )
    return rows[0].n
  })

  await page.goto("/analytics/allocations/runs", { waitUntil: "networkidle" })
  const row = page.locator('[data-run-period="2026-11"]')
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: "Revertir" }).click()

  // Menos de diez caracteres: el botón no se habilita.
  await page.getByTestId("reversal-reason-input").fill("corto")
  await expect(page.getByTestId("confirm-reverse")).toBeDisabled()
  await page.getByTestId("reversal-reason-input").fill("Se recalcula el reparto tras corregir la base de noviembre")
  await page.getByTestId("confirm-reverse").click()

  await expect(page.locator('[data-run-period="2026-11"] [data-run-state="REVERSED"]')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/07-run-revertido.png`, fullPage: true })

  // No se genera ningún asiento: la imputación es capa analítica paralela.
  const ledgerAfter = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1`,
      [org.id]
    )
    return rows[0].n
  })
  expect(ledgerAfter).toBe(ledgerBefore)

  const stored = await withDb(async (client) => {
    const { rows } = await client.query<{ status: string; reason: string | null }>(
      `SELECT status::text, reversal_reason AS reason FROM allocation_runs
        WHERE organization_id = $1 AND period_kind = 'MONTH' AND period_start = '2026-11-01'`,
      [org.id]
    )
    return rows[0]
  })
  expect(stored.status).toBe("REVERSED")
  expect((stored.reason ?? "").length).toBeGreaterThanOrEqual(10)

  // Detalle del run: líneas con su provenance y el estado revertido.
  await page.locator('[data-run-period="2026-11"] a').first().click()
  await expect(page.getByTestId("allocation-lines-table")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("run-hashes")).toContainText("rulesHash")
  await page.screenshot({ path: `${SHOTS}/08-detalle-run.png`, fullPage: true })
})

test("una regla nueva deja caducadas las liquidaciones selladas de su periodo", async ({ page }) => {
  await page.goto("/analytics/allocations", { waitUntil: "networkidle" })
  await createRuleSet(page, "CC-OTR", [
    {
      code: "AL-OTR-Y",
      name: "Otros a proyectos a partes iguales (anual)",
      driver: "EQUAL",
      targetKind: "PROJECTS",
      period: "YEAR",
      priority: "40",
      sharePercent: "100",
      fallback: "SKIP_WARN",
      onlyActive: false,
    },
  ])

  await page.goto("/analytics/allocations/runs", { waitUntil: "networkidle" })
  const annual = page.locator('[data-run-period="2026"]')
  await expect(annual.locator('[data-run-state="STALE"]')).toBeVisible()
  await expect(annual.getByTestId("stale-reasons")).not.toBeEmpty()
  await page.screenshot({ path: `${SHOTS}/09-run-caducado.png`, fullPage: true })
})

test("un VIEWER ve las pantallas y ninguno de los botones de mutación", async ({ page }) => {
  const org = await analyticsOrganization()
  await setRole(org.id, "VIEWER")
  try {
    await page.goto("/analytics/allocations", { waitUntil: "networkidle" })
    await expect(page.getByTestId("allocation-rules-table")).toBeVisible()
    await expect(page.getByTestId("new-allocation-rule")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Versionar" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Cerrar", exact: true })).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/10-viewer-reglas.png`, fullPage: true })

    await page.goto("/analytics/allocations/runs", { waitUntil: "networkidle" })
    await expect(page.getByTestId("allocation-runs-table")).toBeVisible()
    await expect(page.getByRole("button", { name: "Revertir" })).toHaveCount(0)

    // El VIEWER sí puede simular: es un dry-run que no escribe nada.
    await page.getByTestId("period-kind").selectOption("YEAR")
    await page.getByTestId("simulate").click()
    await expect(page.getByTestId("preview-table")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("seal-run")).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/11-viewer-simulacion.png`, fullPage: true })
  } finally {
    await setRole(org.id, "ADMIN")
  }
})
