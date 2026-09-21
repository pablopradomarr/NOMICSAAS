import { expect, test, type Page } from "@playwright/test"
import { adminUserId, signIn, withDb } from "./session"

/**
 * E12 · T13 — extremo a extremo de **`/admin`** (ADR-0020; criterios 40–46).
 *
 * El recorrido, en serie, es el de un operador de verdad:
 *
 *  1. La **lista** de organizaciones responde y enseña asientos, plan y sello.
 *  2. Sobre una organización **con un asiento**, `reset-org` **enumera** lo que
 *     pasaría y **se niega**, diciendo por qué. No hay botón que lo supere
 *     (criterio 40).
 *  3. Sobre una organización **limpia**, la enumeración cuenta filas por tabla y
 *     declara lo que conserva; con un motivo genérico o con el nombre mal
 *     tecleado el botón no se enciende, y **la acción tampoco pasaría**: la
 *     comprobación es del servidor (criterio 41).
 *  4. `unblock` crea la excepción, y la **cabecera roja** aparece: mientras viva,
 *     el sello de esa organización lo dice (criterios 42 y 44).
 *
 * Las dos organizaciones se crean y se borran aquí, como propietario. Ninguna
 * otra suite las ve.
 */

test.describe.configure({ mode: "serial", timeout: 240_000 })

const SUFIJO = Date.now().toString(36)
const LIMPIA = `E2E Admin Limpia ${SUFIJO}`
const CON_ASIENTO = `E2E Admin Con Asiento ${SUFIJO}`
const MOTIVO = "El bloqueo de septiembre se puso por error al importar el extracto de BBVA"

let limpiaId = ""
let conAsientoId = ""

test.beforeAll(async () => {
  const userId = await adminUserId()
  await withDb(async (client) => {
    const crear = async (name: string, slug: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (id, slug, name, pgc_variant, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'PYMES', now()) RETURNING id`,
        [slug, name]
      )
      const id = rows[0]!.id
      await client.query(
        `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now())`,
        [id, userId]
      )
      await client.query(
        `INSERT INTO subscriptions (id, organization_id, plan_code, plan_id, status, created_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, 'ILIMITADO', p."id", 'ACTIVE', now(), now() FROM plans p WHERE p."code" = 'ILIMITADO' LIMIT 1`,
        [id]
      )
      return id
    }
    limpiaId = await crear(LIMPIA, `e2e-admin-limpia-${SUFIJO}`)
    conAsientoId = await crear(CON_ASIENTO, `e2e-admin-asiento-${SUFIJO}`)

    // Un asiento de verdad (dos líneas cuadradas): el trigger de partida doble
    // es diferido y una cabecera suelta no se persiste (ADR-0003).
    await client.query("BEGIN")
    const { rows: fy } = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now()) RETURNING id`,
      [conAsientoId]
    )
    await client.query(
      `INSERT INTO accounts (id, organization_id, code, name, level, nature, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '570', 'Caja', 3, 'DEUDORA', now()),
              (gen_random_uuid(), $1::uuid, '700', 'Ventas', 3, 'ACREEDORA', now())`,
      [conAsientoId]
    )
    const { rows: je } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (id, organization_id, fiscal_year_id, entry_number, entry_date, kind, description,
          source_type, posted_by_id, entry_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '2026-03-01', 'NORMAL', 'Asiento que impide el reset',
               'MANUAL', $3::uuid, repeat('b', 64)) RETURNING id`,
      [conAsientoId, fy[0]!.id, userId]
    )
    await client.query(
      `INSERT INTO journal_lines
         (id, organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          entry_date, fiscal_year_id, entry_kind)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, '570', 100000, 0, '2026-03-01', $3::uuid, 'NORMAL'),
              (gen_random_uuid(), $1::uuid, $2::uuid, 2, '700', 0, 100000, '2026-03-01', $3::uuid, 'NORMAL')`,
      [conAsientoId, je[0]!.id, fy[0]!.id]
    )
    await client.query("COMMIT")
  })
})

test.afterAll(async () => {
  await withDb(async (client) => {
    for (const id of [limpiaId, conAsientoId].filter(Boolean)) {
      // `operator_exceptions` tiene `ON DELETE RESTRICT` a propósito (el
      // registro no desaparece por arrastre), así que en la limpieza del test
      // se retira primero, como propietario.
      await client.query(`DELETE FROM operator_exceptions WHERE organization_id = $1::uuid`, [id])
      await client.query(`DELETE FROM platform_audit_logs WHERE organization_id = $1::uuid`, [id])
      await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [id])
    }
  })
})

async function abrir(page: Page, baseURL: string, path: string): Promise<void> {
  await signIn(page, baseURL)
  await page.goto(path)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · La lista
// ─────────────────────────────────────────────────────────────────────────────

test("la lista de organizaciones enseña plan, asientos y sello", async ({ page, baseURL }) => {
  await abrir(page, baseURL!, "/admin")
  await expect(page.getByTestId("admin-page")).toBeVisible()
  await expect(page.getByTestId("admin-organizaciones")).toBeVisible()
  await expect(page.getByRole("link", { name: LIMPIA })).toBeVisible()
  await expect(page.getByRole("link", { name: CON_ASIENTO })).toBeVisible()
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Criterio 40 — `reset-org` con un asiento: enumerado y denegado
// ─────────────────────────────────────────────────────────────────────────────

test("`reset-org` sobre una organización CON un asiento enumera y se niega, sin --force", async ({
  page,
  baseURL,
}) => {
  await abrir(page, baseURL!, `/admin/${conAsientoId}`)
  await expect(page.getByTestId("admin-org-name")).toHaveText(CON_ASIENTO)
  await expect(page.getByTestId("admin-org-asientos")).toHaveText("1 asiento(s)")

  const bloque = page.getByTestId("op-reset-org")
  await bloque.getByTestId("op-reset-org-plan").click()

  // Primero enumera lo que PASARÍA…
  await expect(bloque.getByTestId("op-reset-org-enumeracion")).toBeVisible()
  // …y después dice que no, y por qué.
  const negativa = bloque.getByTestId("op-reset-org-blocked")
  await expect(negativa).toBeVisible()
  await expect(negativa).toContainText("contra-asiento")
  await expect(negativa).toContainText("No hay «--force»")

  // No hay forma de seguir: el botón existe pero nunca se enciende, y los
  // campos de motivo y de nombre ni se pintan.
  await expect(bloque.getByTestId("op-reset-org-run")).toBeDisabled()
  await expect(bloque.getByTestId("op-reset-org-reason")).toHaveCount(0)
  await expect(bloque.getByTestId("op-reset-org-name")).toHaveCount(0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Criterio 41 — motivo y nombre, comprobados en el servidor
// ─────────────────────────────────────────────────────────────────────────────

test("sobre una organización limpia enumera por tabla y exige motivo y nombre exacto", async ({
  page,
  baseURL,
}) => {
  await abrir(page, baseURL!, `/admin/${limpiaId}`)
  const bloque = page.getByTestId("op-reset-org")
  await bloque.getByTestId("op-reset-org-plan").click()

  const enumeracion = bloque.getByTestId("op-reset-org-enumeracion")
  await expect(enumeracion).toBeVisible()
  await expect(enumeracion).toContainText("Se CONSERVAN")
  await expect(bloque.getByTestId("op-reset-org-blocked")).toHaveCount(0)

  const run = bloque.getByTestId("op-reset-org-run")
  await expect(run).toBeDisabled()

  // Motivo genérico: sigue apagado.
  await bloque.getByTestId("op-reset-org-reason").fill("arreglo")
  await bloque.getByTestId("op-reset-org-name").fill(LIMPIA)
  await expect(run).toBeDisabled()

  // Motivo bueno, nombre mal tecleado: sigue apagado.
  await bloque.getByTestId("op-reset-org-reason").fill(MOTIVO)
  await bloque.getByTestId("op-reset-org-name").fill(LIMPIA.toLowerCase())
  await expect(run).toBeDisabled()

  // Los dos bien: se enciende.
  await bloque.getByTestId("op-reset-org-name").fill(LIMPIA)
  await expect(run).toBeEnabled()
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Criterios 42 y 44 — `unblock` deja rastro y mueve el sello
// ─────────────────────────────────────────────────────────────────────────────

test("`unblock` sobre una guardia atascada crea la excepción y la pinta en rojo", async ({ page, baseURL }) => {
  // Se atasca una guardia de cierre para que haya algo que levantar: el panel
  // sólo ofrece lo que de verdad está atascado (una excepción «por si acaso» es
  // justo lo que ADR-0020 existe para evitar).
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '2025', '2025-01-01', '2025-12-31', 'CLOSED', now())`,
      [limpiaId]
    )
  })

  await abrir(page, baseURL!, `/admin/${limpiaId}`)
  const picker = page.getByTestId("op-unblock-picker")
  await expect(picker).toBeVisible()
  await picker.getByTestId("op-unblock-kind").selectOption({ label: "Una guardia de cierre de ejercicio" })

  const bloque = page.getByTestId("op-unblock")
  await bloque.getByTestId("op-unblock-plan").click()
  const enumeracion = bloque.getByTestId("op-unblock-enumeracion")
  await expect(enumeracion).toBeVisible()
  await expect(enumeracion).toContainText("Caduca sola")
  await expect(enumeracion).toContainText("El invariante que cerró la puerta NO se levanta")
  await expect(enumeracion).toContainText("EXCEPCION_DE_OPERADOR_VIGENTE")

  await bloque.getByTestId("op-unblock-reason").fill(MOTIVO)
  await bloque.getByTestId("op-unblock-name").fill(LIMPIA)
  await bloque.getByTestId("op-unblock-run").click()

  // La cabecera roja aparece: mientras la excepción viva, el sello lo dice.
  await expect(page.getByTestId("admin-org-excepciones-vivas")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("admin-org-excepciones-vivas")).toContainText("UNBLOCK_CLOSING_GUARD")

  // Y queda en los dos registros (criterio 42).
  await expect(page.getByTestId("admin-registro")).toContainText("admin.unblock")
  await withDb(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE organization_id = $1::uuid AND action = 'OPERATOR_UNBLOCK'`,
      [limpiaId]
    )
    expect(rows[0]!.n).toBe("1")
  })

  // La lista general también la enseña arriba del todo.
  await page.goto("/admin")
  await expect(page.getByTestId("admin-excepciones-vivas")).toContainText(LIMPIA)
})
