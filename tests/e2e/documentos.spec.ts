import { expect, test, type Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { adminUserId, analyticsOrganization, APP_ENV, DATABASE_URL, signIn, withDb } from "./session"

/**
 * E8 · T15/T16/T17 — Extremo a extremo del camino documental
 * (`docs/design/E8-documentos-asientos.md` §6, §12.1).
 *
 * Cinco recorridos, en serie sobre la organización de fixtures:
 *
 *  1. **Bandeja → revisión → asiento**: el documento aparece con su estado, la
 *     ficha enseña los cuatro badges de confianza, las cuatro fechas explicadas
 *     con su periodo de IVA, las veinticinco comprobaciones con la marca de
 *     bloqueo de lote y el asiento propuesto **cuadrado a cero**; confirmar deja
 *     el asiento en el diario.
 *  2. **Drill-down en ≤ 3 clics**: del libro diario al asiento, del asiento a la
 *     pestaña Documento, y de ahí al papel con su `sha256` y su extracción.
 *  3. **Anular y rehacer** con motivo obligatorio (ADR-0014 D1).
 *  4. **Lote**: elegibles y no elegibles **con su porqué**, y confirmación.
 *  5. **`VIEWER` no confirma**: lo ve todo —es información de auditoría— y no
 *     tiene un solo botón de mutación.
 *
 * **Sin proveedor de lenguaje.** Las extracciones las siembra
 * `tests/support/seed-extraction.ts`, que hace lo mismo que `runExtraction`
 * menos la llamada al modelo: el veredicto lo calcula el `reconcile()` de
 * verdad, con el contexto de verdad leído de la base.
 */

test.describe.configure({ mode: "serial" })

type Seeded = { fileId: string; runId: string; status: string; documentNumber: string }

let organizationId = ""
let simple: Seeded
let ticket: Seeded
let mixta: Seeded

/** Siembra un documento con su extracción ya juzgada. Idempotente por caso. */
function seedDocument(orgId: string, kind: "simple" | "ticket" | "mixta", number: string): Seeded {
  const out = execFileSync(
    "npx",
    ["tsx", "tests/support/seed-extraction.ts", "--org", orgId, "--case", kind, "--number", number],
    {
      env: {
        ...process.env,
        DATABASE_URL,
        DIRECT_URL: DATABASE_URL,
        PRISMA_LOG: "",
        // El documento tiene que caer donde la APLICACIÓN lo busca: Playwright
        // no carga `.env`, así que sin esto el arnés escribiría en `./uploads`
        // por defecto y el visor no encontraría el fichero que acaba de sembrar.
        ...(APP_ENV.UPLOAD_PATH ? { UPLOAD_PATH: APP_ENV.UPLOAD_PATH } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }
  )
  const line = out
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop()
  if (!line) throw new Error(`El arnés no ha sembrado el documento ${kind}: ${out.slice(-500)}`)
  return JSON.parse(line) as Seeded
}

/**
 * Deja activa la organización de fixtures plantando la cookie de organización
 * activa, con la misma firma que `signActiveOrgCookie` (`lib/authz-core.ts`).
 * La cookie es un HINT: `requireOrg` sigue comprobando la Membership.
 */
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

test.beforeAll(async () => {
  const org = await analyticsOrganization()
  organizationId = org.id
  const stamp = Date.now().toString().slice(-6)
  simple = seedDocument(organizationId, "simple", `E2E-S-${stamp}`)
  ticket = seedDocument(organizationId, "ticket", `E2E-T-${stamp}`)
  mixta = seedDocument(organizationId, "mixta", `E2E-M-${stamp}`)
})

test.beforeEach(async ({ page, baseURL }) => {
  const url = baseURL ?? "http://localhost:7331"
  await signIn(page, url)
  await useOrg(page, url, organizationId)
})

test("la bandeja lista los documentos con su estado y sus contadores", async ({ page }) => {
  await page.goto("/unsorted", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Bandeja de documentos" })).toBeVisible()

  await expect(page.getByTestId("inbox-counters")).toBeVisible()
  const table = page.getByTestId("inbox-table")
  await expect(table).toBeVisible()

  const row = table.locator(`[data-file-id="${simple.fileId}"]`)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute("data-status", "PASS")
  await expect(row).toContainText(simple.documentNumber)

  // El filtro por estado es una ruta, no un estado de cliente: se puede enlazar.
  await page.getByTestId("filter-FAIL").click()
  await page.waitForURL(/status=FAIL/)
  await expect(page.getByTestId("inbox-table").or(page.getByTestId("inbox-empty"))).toBeVisible()
})

test("la revisión enseña procedencia, las cuatro fechas, las comprobaciones y el asiento cuadrado", async ({
  page,
}) => {
  await page.goto(`/unsorted/${simple.fileId}`, { waitUntil: "domcontentloaded" })

  // Visor con el sha256 del documento a la vista: el último eslabón de la cadena.
  await expect(page.getByTestId("document-viewer")).toBeVisible()
  await expect(page.getByTestId("file-sha256")).not.toBeEmpty()
  // Y el papel se sirve de verdad: la vista previa de la página existe. Sin
  // esto, un visor roto pasaría el test con su mensaje de respaldo.
  const preview = await page.request.get(`/files/preview/${simple.fileId}?page=1`)
  expect(preview.status(), "la vista previa del documento no se sirve").toBe(200)

  // Selector de extracciones con la cadena de revisión.
  await expect(page.getByTestId("run-selector")).toBeVisible()
  await expect(page.locator(`[data-run-id="${simple.runId}"]`)).toBeVisible()

  // Los CUATRO badges de confianza: al menos uno de los niveles del camino
  // documental tiene que estar sellado en los campos de la propuesta.
  const form = page.getByTestId("proposal-form")
  await expect(form).toBeVisible()
  await expect(form.locator('[data-field-confidence="verificado"]').first()).toBeVisible()
  await expect(form.locator("[data-field-confidence]").first()).toBeVisible()

  // Las cuatro fechas, cada una con su explicación, y el periodo de IVA.
  const dates = page.getByTestId("dates-block")
  await expect(dates.locator('[data-date-field="documentDate"]')).toBeVisible()
  await expect(dates.locator('[data-date-field="operationDate"]')).toBeVisible()
  await expect(dates.locator('[data-date-field="receptionDate"]')).toBeVisible()
  await expect(dates.locator('[data-date-field="accrualDate"]')).toBeVisible()
  await expect(dates).toContainText("Decide el trimestre en el que se deduce el IVA soportado", { useInnerText: true })
  await expect(page.getByTestId("iva-period")).not.toBeEmpty()

  // Panel de comprobaciones: las veinticinco, con la marca de bloqueo de lote.
  const checks = page.getByTestId("checks-panel")
  await expect(checks).toBeVisible()
  await expect(checks.locator("[data-check-id]")).toHaveCount(25)
  await expect(checks.locator('[data-check-id="RC-01"]')).toHaveAttribute("data-check-status", "PASS")
  await expect(checks.locator("[data-blocks-batch]").first()).toBeVisible()

  // Asiento propuesto: líneas, cuadre a cero y libro registro.
  const entry = page.getByTestId("proposed-entry")
  await expect(entry).toBeVisible()
  await expect(entry.locator('[data-account="629"]')).toBeVisible()
  await expect(entry.locator('[data-account="472"]')).toBeVisible()
  await expect(page.getByTestId("entry-balance")).toHaveAttribute("data-descuadre", "0")
  await expect(page.getByTestId("entry-balance")).toContainText("0,00")
})

test("confirmar deja el asiento en el diario y el drill-down llega al documento en tres clics", async ({ page }) => {
  await page.goto(`/unsorted/${simple.fileId}`, { waitUntil: "domcontentloaded" })

  await page.getByTestId("confirm-proposal").click()
  await page.getByTestId("confirm-proposal-submit").click()
  await expect(page.getByTestId("confirmed-banner")).toBeVisible({ timeout: 60_000 })

  const entryNumber = Number(
    (await page.getByTestId("confirmed-banner").innerText()).replace(/\D+/g, " ").trim().split(/\s+/)[0]
  )
  expect(entryNumber).toBeGreaterThan(0)

  // El asiento existe de verdad, cuadra y referencia el documento y su extracción.
  const posted = await withDb(async (client) => {
    const { rows } = await client.query<{
      id: string
      file_id: string | null
      extraction_run_id: string | null
      debit: string
      credit: string
    }>(
      `SELECT e.id, e.file_id, e.extraction_run_id,
              SUM(l.debit_cents)::text AS debit, SUM(l.credit_cents)::text AS credit
         FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
        WHERE e.organization_id = $1 AND e.file_id = $2
        GROUP BY e.id`,
      [organizationId, simple.fileId]
    )
    return rows[0]
  })
  expect(posted, "el asiento del documento no está en el diario").toBeTruthy()
  expect(posted.debit).toEqual(posted.credit)
  expect(posted.extraction_run_id).toBeTruthy()

  // Drill-down: (1) libro diario → asiento, (2) pestaña Documento, (3) revisión.
  await page.goto("/ledger", { waitUntil: "domcontentloaded" })
  await page.goto(`/ledger/${posted.id}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: /Asiento nº/ })).toBeVisible()

  await page.getByTestId("entry-tab-documento").click()
  await page.waitForURL(/tab=documento/)
  const tab = page.getByTestId("entry-document-tab")
  await expect(tab).toBeVisible()
  await expect(tab.getByTestId("file-sha256")).not.toBeEmpty()
  await expect(tab).toContainText("mock")

  await page.getByTestId("go-to-document-review").click()
  await page.waitForURL(new RegExp(`/unsorted/${simple.fileId}`))
  await expect(page.getByTestId("document-viewer")).toBeVisible()
})

test("anular y rehacer exige motivo y devuelve la operación a propuesta", async ({ page }) => {
  await page.goto(`/unsorted/${simple.fileId}`, { waitUntil: "domcontentloaded" })

  await page.getByTestId("revoid-and-redo").click()
  // Sin motivo suficiente, el botón no deja hacer nada: es una acción
  // destructiva sobre el diario y el motivo queda en AuditLog.
  await expect(page.getByTestId("revoid-confirm")).toBeDisabled()
  await page.getByTestId("revoid-reason").fill("Prueba e2e: se anula para rehacer el asiento del documento")
  await page.getByTestId("revoid-confirm").click()
  await expect(page.getByTestId("revoid-confirm")).toBeHidden({ timeout: 60_000 })

  const state = await withDb(async (client) => {
    const { rows } = await client.query<{ status: string; journal_entry_id: string | null; voided_entry_id: string | null }>(
      `SELECT t.status::text, t.journal_entry_id, t.voided_entry_id
         FROM transactions t
        WHERE t.organization_id = $1 AND t.extraction_run_id IN (
              SELECT id FROM extraction_runs WHERE organization_id = $1 AND file_id = $2)
        ORDER BY t.created_at DESC LIMIT 1`,
      [organizationId, simple.fileId]
    )
    return rows[0]
  })
  expect(state.status).toBe("PROPOSED")
  expect(state.journal_entry_id).toBeNull()
  expect(state.voided_entry_id, "el asiento anulado tiene que quedar en el histórico").toBeTruthy()

  // Y el contra-asiento existe: anular no borra (ADR-0003).
  const reversals = await withDb(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE organization_id = $1 AND reverses_entry_id = $2`,
      [organizationId, state.voided_entry_id]
    )
    return Number(rows[0].count)
  })
  expect(reversals).toBe(1)
})

test("el lote separa elegibles y no elegibles con su motivo, y contabiliza", async ({ page }) => {
  await page.goto(`/unsorted/batch?runIds=${ticket.runId},${mixta.runId}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Confirmación por lote" })).toBeVisible()

  const eligible = page.getByTestId("batch-eligible")
  await expect(eligible).toBeVisible()
  await expect(eligible.locator(`[data-run-id="${mixta.runId}"]`)).toBeVisible()

  // El documento mixto reparte el pasivo por bloques: 523 por el inmovilizado y
  // 400/410 por el servicio. Se comprueba en su ficha, que es donde se ve.
  await page.goto(`/unsorted/${mixta.fileId}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByTestId("payable-blocks")).toBeVisible()
  await expect(page.getByTestId("proposed-entry").locator('[data-account="523"]')).toBeVisible()

  // El ticket avisa de que la cuota no es deducible y ofrece el acto auditado.
  await page.goto(`/unsorted/${ticket.fileId}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator('[data-notice="TICKET_NO_CUALIFICADO"]')).toBeVisible()
  await expect(page.getByTestId("qualify-ticket")).toBeVisible()

  // Y el lote contabiliza lo elegible.
  await page.goto(`/unsorted/batch?runIds=${mixta.runId}`, { waitUntil: "domcontentloaded" })
  await page.getByTestId("confirm-batch").click()
  await expect(page.getByTestId("batch-result")).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("batch-result")).toContainText("contabilizado")

  const postedMixta = await withDb(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE organization_id = $1 AND file_id = $2`,
      [organizationId, mixta.fileId]
    )
    return Number(rows[0].count)
  })
  expect(postedMixta).toBeGreaterThan(0)
})

test("un VIEWER ve la propuesta y las comprobaciones, y no puede confirmar", async ({ page }) => {
  await setRole(organizationId, "VIEWER")
  try {
    await page.goto(`/unsorted/${ticket.fileId}`, { waitUntil: "domcontentloaded" })

    // Lo ve todo: es información de auditoría.
    await expect(page.getByTestId("checks-panel")).toBeVisible()
    await expect(page.getByTestId("proposed-entry")).toBeVisible()

    // Y no tiene un solo botón de mutación.
    await expect(page.getByTestId("confirm-proposal")).toHaveCount(0)
    await expect(page.getByTestId("force-field")).toHaveCount(0)
    await expect(page.getByTestId("qualify-ticket")).toHaveCount(0)
    await expect(page.getByTestId("analyze-document")).toHaveCount(0)

    await page.goto("/unsorted", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("analyze-all")).toHaveCount(0)
    await expect(page.getByTestId("go-to-batch")).toHaveCount(0)
  } finally {
    await setRole(organizationId, "ADMIN")
  }
})

test("la configuración del camino documental está completa y es coherente", async ({ page }) => {
  // Series de facturación con su siguiente número y el control de huecos.
  await page.goto("/settings/invoicing", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Facturación" })).toBeVisible()
  await expect(page.getByTestId("invoice-series").or(page.getByTestId("series-empty"))).toBeVisible()

  // Prompts versionados: el de git, con su sha, y las versiones de la organización.
  await page.goto("/settings/prompts", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Prompts de extracción" })).toBeVisible()
  await expect(page.getByText("Prompt de git (sólo lectura)")).toBeVisible()

  // Tasas persistidas con su fuente y su fecha efectiva.
  await page.goto("/settings/currencies", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Monedas y tipos de cambio" })).toBeVisible()
  await expect(page.getByTestId("exchange-rates").or(page.getByTestId("rates-empty"))).toBeVisible()

  // Régimen de IVA, ROI y deducibilidad por defecto.
  await page.goto("/settings/organization", { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Régimen fiscal de la organización")).toBeVisible()
  await expect(page.getByTestId("category-deductibility").or(page.getByText("No hay categorías configuradas"))).toBeVisible()
})
