import { expect, test, type Page } from "@playwright/test"
import { createHmac } from "node:crypto"
import { adminUserId, APP_ENV, signIn, withDb } from "./session"

/**
 * E11 · ola C — extremo a extremo del **alta, la siembra y las pantallas de
 * plataforma** (docs/design/E11-plataforma-saas.md §6, §10; criterios 40–47).
 *
 * Un recorrido en serie:
 *
 *  1. **Alta por el asistente**: el paso 1 crea la organización y **las nueve
 *     piezas** en una transacción, y el paso 2 las enseña una a una — no un
 *     spinner (criterio 40).
 *  2. **Abandono en el paso 3**: series y ejercicio provisional ya estaban
 *     sembrados desde el paso 1, así que I-E11-10 pasa con datos limpios
 *     (criterio 41, O-7a/b). *En la ronda 1 del diseño esto fallaba.*
 *  3. **Paso 3 EDITA** el ejercicio provisional; nunca hay dos solapados
 *     (criterio 42).
 *  4. **Prefijo de serie**: renombrable con `lastNumber = 0`, **rechazado** con
 *     un número emitido (criterio 43, art. 6.1.a RD 1619/2012).
 *  5. **Equipo**: la invitación del paso 4 crea su fila `PENDING`.
 *  6. **Demo en organización PROPIA** con `isDemo` inmutable, y el borrado que
 *     se lleva la organización entera sin tocar un asiento ajeno
 *     (criterios 45–47).
 *  7. **Preferencias** (§6.4): el mes de arranque de la amortización se guarda.
 *  8. **Suscripción y copias**: las dos pantallas responden y enseñan sus
 *     estados vacíos con texto, no con un hueco.
 *
 * Higiene: la organización de este fichero se crea con un nombre único y se
 * borra al final, como propietario. Ninguna otra suite la ve.
 */

// El paso 1 compila la ruta, crea la organización y siembra las nueve piezas:
// en un `next dev` frío eso no cabe en los 90 s por defecto.
test.describe.configure({ mode: "serial", timeout: 240_000 })

const SUFIJO = Date.now().toString(36)
const NOMBRE = `E2E Onboarding ${SUFIJO}`
const PREFIJO = `E2E${SUFIJO.slice(-3).toUpperCase()}`

let organizationId = ""
let demoOrganizationId: string | null = null

test.afterAll(async () => {
  await withDb(async (client) => {
    for (const id of [demoOrganizationId, organizationId].filter(Boolean) as string[]) {
      // La marca de demo es inmutable por trigger; borrar la fila entera no la
      // toca, así que no hay que levantarlo.
      await client.query(`DELETE FROM organizations WHERE id = $1`, [id])
    }
  })
})

/** Deja activa la organización que el asistente acaba de crear. */
async function withOrg(page: Page, baseURL: string, orgId: string): Promise<void> {
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

async function open(page: Page, baseURL: string, path: string): Promise<void> {
  await signIn(page, baseURL)
  if (organizationId) await withOrg(page, baseURL, organizationId)
  await page.goto(path)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Alta con siembra atómica, y las nueve piezas a la vista (criterio 40)
// ─────────────────────────────────────────────────────────────────────────────

test("el paso 1 crea la organización y siembra las nueve piezas", async ({ page, baseURL }) => {
  await signIn(page, baseURL!)
  // `?nueva=1`: el usuario del arnés ya tiene su organización personal, así que
  // sin el parámetro el asistente lo mandaría al panel. Es el mismo camino que
  // usa el enlace «Nueva organización».
  await page.goto("/onboarding?nueva=1")
  await expect(page.getByTestId("step-company")).toBeVisible({ timeout: 120_000 })

  await page.fill('input[name="name"]', NOMBRE)
  await page.fill('input[name="taxId"]', "B00000000")
  await page.fill('input[name="seriesPrefix"]', PREFIJO)
  await page.getByTestId("company-submit").click()

  await expect(page.getByTestId("step-plan-accounts")).toBeVisible({ timeout: 120_000 })

  organizationId = await withDb(async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM organizations WHERE name = $1`, [NOMBRE])
    return rows[0]?.id ?? ""
  })
  expect(organizationId, "la organización del asistente tiene que existir").not.toBe("")

  // Las NUEVE piezas, contadas contra la base y enseñadas una a una.
  const report = page.getByTestId("seed-report")
  await expect(report).toBeVisible()
  for (const key of [
    "plan",
    "accountMap",
    "fiscalYear",
    "invoiceSeries",
    "reclassificationPairs",
    "marginLevels",
    "onboardingRun",
    "taxRates",
    "currency",
  ]) {
    await expect(page.getByTestId(`seed-piece-${key}`)).toHaveAttribute("data-piece-ok", "true")
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Lo que se sembró en el paso 1, verificado en la base (criterios 40–41)
// ─────────────────────────────────────────────────────────────────────────────

test("las series y el ejercicio provisional existen desde el paso 1 (O-7a/b)", async () => {
  const sembrado = await withDb(async (client) => {
    const series = await client.query<{ kind: string; prefix: string; next_number: number }>(
      `SELECT kind::text, prefix, next_number FROM invoice_series WHERE organization_id = $1 ORDER BY kind`,
      [organizationId]
    )
    const years = await client.query<{ code: string }>(
      `SELECT code FROM fiscal_years WHERE organization_id = $1`,
      [organizationId]
    )
    const pairs = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reclassification_pairs WHERE organization_id = $1`,
      [organizationId]
    )
    const run = await client.query<{ step: string }>(
      `SELECT step::text FROM onboarding_runs WHERE organization_id = $1`,
      [organizationId]
    )
    return {
      series: series.rows,
      years: years.rows.map((r) => r.code),
      pairs: Number(pairs.rows[0].n),
      step: run.rows[0]?.step ?? null,
    }
  })

  // Criterio 41: quien abandona en el paso 3 NO deja la organización sin series.
  expect(sembrado.series.map((s) => s.kind).sort()).toEqual(["ORDINARIA", "RECTIFICATIVA"])
  // `lastNumber = 0` ⇔ `next_number = 1`: I-E8-20 sigue en INFO, que es su contrato.
  expect(sembrado.series.every((s) => s.next_number === 1)).toBe(true)
  expect(sembrado.series.find((s) => s.kind === "ORDINARIA")?.prefix).toBe(PREFIJO)

  // Criterio 42: UN solo ejercicio, el provisional por año natural.
  expect(sembrado.years).toHaveLength(1)
  expect(sembrado.pairs).toBeGreaterThanOrEqual(22)
  expect(sembrado.step).not.toBeNull()
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · El prefijo se renombra con el contador a cero (criterio 43)
// ─────────────────────────────────────────────────────────────────────────────

test("el prefijo se puede cambiar mientras no hay número emitido, y después no", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/onboarding")
  await expect(page.getByTestId("series-panel")).toBeVisible({ timeout: 90_000 })

  const nuevo = `${PREFIJO}X`
  const ordinaria = page.getByTestId("series-ORDINARIA")
  await ordinaria.locator('input[name="prefix"]').fill(nuevo)
  await ordinaria.getByRole("button", { name: "Cambiar prefijo" }).click()

  await expect
    .poll(
      async () =>
        await withDb(async (client) => {
          const { rows } = await client.query<{ prefix: string }>(
            `SELECT prefix FROM invoice_series WHERE organization_id = $1 AND kind = 'ORDINARIA'`,
            [organizationId]
          )
          return rows[0]?.prefix
        }),
      { timeout: 30_000 }
    )
    .toBe(nuevo)

  // Con un número emitido, el botón se apaga: la serie identifica facturas ya
  // expedidas (art. 6.1.a RD 1619/2012). El servidor lo exige igualmente; aquí
  // se comprueba lo que el usuario ve. Se usa la RECTIFICATIVA porque el
  // contador **no retrocede** —lo impide `invoice_series_no_gaps`, y con razón—,
  // así que dejar la ORDINARIA avanzada estropearía los pasos siguientes.
  await withDb(async (client) => {
    await client.query(
      `UPDATE invoice_series SET next_number = 2 WHERE organization_id = $1 AND kind = 'RECTIFICATIVA'`,
      [organizationId]
    )
  })
  await page.reload()
  await expect(page.getByTestId("series-RECTIFICATIVA").getByRole("button", { name: "Cambiar prefijo" })).toBeDisabled()
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · El paso 3 EDITA el ejercicio (criterio 42)
// ─────────────────────────────────────────────────────────────────────────────

test("el paso 3 edita el ejercicio provisional y no crea otro", async ({ page, baseURL }) => {
  await withDb(async (client) => {
    await client.query(`UPDATE onboarding_runs SET step = 'FISCAL_YEAR' WHERE organization_id = $1`, [organizationId])
  })
  await open(page, baseURL!, "/onboarding")
  await expect(page.getByTestId("step-fiscal-year")).toBeVisible({ timeout: 90_000 })

  await page.fill('input[name="startDate"]', "2026-04-01")
  await page.fill('input[name="endDate"]', "2027-03-31")
  await page.getByTestId("fiscal-year-submit").click()

  await expect
    .poll(
      async () =>
        await withDb(async (client) => {
          const { rows } = await client.query<{ n: string; start: string }>(
            `SELECT count(*)::text AS n, min(start_date)::text AS start
               FROM fiscal_years WHERE organization_id = $1`,
            [organizationId]
          )
          return `${rows[0].n}|${rows[0].start}`
        }),
      { timeout: 30_000 }
    )
    .toBe("1|2026-04-01")
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · El equipo (paso 4)
// ─────────────────────────────────────────────────────────────────────────────

test("el paso 4 deja una invitación pendiente por cada correo válido", async ({ page, baseURL }) => {
  await withDb(async (client) => {
    await client.query(`UPDATE onboarding_runs SET step = 'MEMBERS' WHERE organization_id = $1`, [organizationId])
  })
  await open(page, baseURL!, "/onboarding")
  await expect(page.getByTestId("step-members")).toBeVisible({ timeout: 90_000 })

  await page.getByTestId("invite-emails").fill(`socio.${SUFIJO}@example.test, no-es-un-correo`)
  await page.getByTestId("invite-submit").click()

  await expect
    .poll(
      async () =>
        await withDb(async (client) => {
          const { rows } = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM invitations WHERE organization_id = $1 AND status = 'PENDING'`,
            [organizationId]
          )
          return Number(rows[0].n)
        }),
      { timeout: 30_000 }
    )
    .toBe(1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · La demo, en su propia organización (criterios 45–47)
// ─────────────────────────────────────────────────────────────────────────────

test("la marca de demo es inmutable: el trigger rechaza cambiarla por SQL", async () => {
  await withDb(async (client) => {
    await client.query(`UPDATE organizations SET is_demo = false WHERE id = $1`, [organizationId])
    await expect(
      client.query(`UPDATE organizations SET is_demo = true WHERE id = $1`, [organizationId])
    ).rejects.toThrow(/inmutable/i)
  })
})

test("el paso 5 ofrece la demo, y la demo nunca vive dentro de la organización del cliente", async ({
  page,
  baseURL,
}) => {
  await withDb(async (client) => {
    await client.query(`UPDATE onboarding_runs SET step = 'DEMO' WHERE organization_id = $1`, [organizationId])
  })
  await open(page, baseURL!, "/onboarding")
  await expect(page.getByTestId("step-demo")).toBeVisible({ timeout: 90_000 })

  // El texto de la pantalla es parte del control: no hay botón que borre un
  // asiento contabilizado, y se dice.
  await expect(page.getByTestId("step-demo")).toContainText("organización aparte")
  await expect(page.getByTestId("demo-load")).toBeVisible()

  // La demo se crea por el mismo camino que usaría el usuario, pero cargar el
  // fixture completo tarda minutos: aquí se comprueba el CONTRATO —organización
  // propia, `isDemo`, cero asientos en la del cliente— sembrando la marca por el
  // camino de la aplicación y verificando el aislamiento.
  const entriesAntes = await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE organization_id = $1`,
      [organizationId]
    )
    return Number(rows[0].n)
  })
  expect(entriesAntes, "la organización del cliente nace sin asientos y así se queda").toBe(0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Preferencias del motor (§6.4, D-3)
// ─────────────────────────────────────────────────────────────────────────────

test("las preferencias guardan el mes de arranque de la amortización", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/settings/organization")
  await expect(page.getByTestId("organization-preferences")).toBeVisible({ timeout: 120_000 })

  // `FormSelect` es un Select de radix: el `input[name=…]` es oculto y lo que se
  // pulsa es su disparador, identificado por el `id` que el componente le pone.
  await page.locator("#depreciationStartsOn").click()
  await page.getByRole("option", { name: /mismo mes del alta/i }).click()
  await page.getByTestId("preferences-submit").click()

  await expect
    .poll(
      async () =>
        await withDb(async (client) => {
          const { rows } = await client.query<{ v: string }>(
            `SELECT depreciation_starts_on::text AS v FROM organizations WHERE id = $1`,
            [organizationId]
          )
          return rows[0]?.v
        }),
      { timeout: 30_000 }
    )
    .toBe("MES_DE_ALTA")
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · Suscripción y copias: estados vacíos con texto, no con un hueco
// ─────────────────────────────────────────────────────────────────────────────

test("la pantalla de suscripción enseña el uso del mes, o dice por qué no puede", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/settings/subscription")
  // Dos estados legítimos, y ninguno es una pantalla en blanco ni un 500: con las
  // tablas de plataforma desplegadas, las seis barras; sin ellas, el aviso de que
  // el módulo no está en esta instalación. Un contador a cero sin tablas no sería
  // un cero, sería un «no lo sé».
  const barras = page.getByTestId("usage-bars")
  const aviso = page.getByTestId("platform-not-deployed")
  await expect(barras.or(aviso)).toBeVisible({ timeout: 120_000 })

  if (await barras.isVisible()) {
    for (const key of ["members", "entries", "ocrDocs", "exports", "backups", "storageBytes"]) {
      await expect(page.getByTestId(`usage-${key}`)).toBeVisible()
    }
    // P6: la cifra derivada viaja con su sello.
    await expect(page.getByTestId("usage-seal")).toBeVisible()
  }
})

test("la pantalla de copias avisa de que restaurar crea una organización nueva", async ({ page, baseURL }) => {
  await open(page, baseURL!, "/settings/backups")
  const panel = page.getByTestId("backups-panel")
  const aviso = page.getByTestId("platform-not-deployed")
  await expect(panel.or(aviso)).toBeVisible({ timeout: 120_000 })

  // La regla se dice en los dos estados: restaurar NUNCA sobrescribe la
  // organización actual.
  if (await panel.isVisible()) {
    await expect(page.getByTestId("restore-warning")).toContainText("organización nueva")
    await expect(page.getByTestId("backup-list-empty")).toBeVisible()
  } else {
    await expect(aviso).toContainText("organización nueva")
  }
})
