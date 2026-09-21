/**
 * E12 · ronda 2 de corrección — **el inventario de `/admin`, ejercido contra la
 * base** (hallazgo **C** de `docs/design/E12-revision-ronda1.md`).
 *
 * La ronda 1 compró una cosa valiosa con el DEBE #6: la negativa de
 * `app.operator_organizations` dejó de vivir sólo en `requirePlatformAdmin()` y
 * pasó a vivir **en la base** (migración `20261002090000`: `REVOKE` a
 * `app_runtime`, `GRANT` a `app_operator` y `app_maintenance`). Y la dejó sin
 * ejercer: `listOrganizationsForOperator` era la ÚNICA llamada a esa función y
 * no la tocaba ni un test —ni unitario, ni de integración, ni de RLS, ni de
 * aceptación—. El único camino que la probaba era el e2e de `/admin`, que es
 * justo el que no se pudo correr. Si mañana se pierde el `SET LOCAL ROLE`, o el
 * `GRANT` cambia, `/admin` se queda sin inventario y ninguna suite lo dice.
 *
 * Aquí se ejerce lo que el DEBE #6 compró, y en los dos sentidos:
 *
 *  1. **como `app_operator`** (que es a lo que entra `listOrganizationsForOperator`
 *     con su `SET LOCAL ROLE`) la llamada devuelve el inventario;
 *  2. **como `app_runtime`**, el rol con el que se sirve la aplicación entera,
 *     la llamada desnuda es `42501 permission denied`;
 *  3. y el `SET LOCAL` **muere con la transacción**: fuera de ella el proceso
 *     vuelve a ser el rol de siempre.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const { prisma } = await import("@/lib/db")
const { listOrganizationsForOperator } = await import("@/models/platform")
const { appRuntimeDatabaseUrl, ownerDatabaseUrl } = await import("@/tests/support/env")

const ORG = "e12c0000-0000-4000-8000-000000000001"
const SLUG = "e12-ronda2-inventario"
const NOW = new Date("2026-10-01T10:00:00.000Z")

/** La firma exacta que la migración nombra: si cambia, el `GRANT` no es el mismo. */
const FIRMA = "app.operator_organizations(timestamp(3))"

describe.skipIf(!TEST_DATABASE_URL)("E12 · ronda 2 — `listOrganizationsForOperator` contra la base (C)", () => {
  beforeAll(async () => {
    await prisma.organization.upsert({
      where: { id: ORG },
      update: { name: "E12 Ronda Dos S.L.", slug: SLUG },
      create: { id: ORG, slug: SLUG, name: "E12 Ronda Dos S.L.", pgcVariant: "PYMES", updatedAt: new Date() },
    })
  })

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: ORG } })
    await prisma.$disconnect()
  })

  it("los privilegios son los que la migración promete: `app_runtime` NO, `app_operator` SÍ", async () => {
    const [fila] = await prisma.$queryRaw<{ runtime: boolean; operator: boolean; maintenance: boolean }[]>`
      SELECT has_function_privilege('app_runtime',     ${FIRMA}, 'EXECUTE') AS runtime,
             has_function_privilege('app_operator',    ${FIRMA}, 'EXECUTE') AS operator,
             has_function_privilege('app_maintenance', ${FIRMA}, 'EXECUTE') AS maintenance`
    expect(fila.runtime, "`app_runtime` puede enumerar la plataforma entera: la migración 20261002090000 se perdió").toBe(
      false
    )
    expect(fila.operator, "`app_operator` no puede ejecutarla: /admin se queda sin inventario").toBe(true)
    expect(fila.maintenance, "los scripts de operador no pueden ejecutarla").toBe(true)
  })

  it("`listOrganizationsForOperator` devuelve el inventario, con la organización sembrada dentro", async () => {
    const filas = await listOrganizationsForOperator(NOW)
    expect(Array.isArray(filas)).toBe(true)
    const mia = filas.find((fila) => fila.id === ORG)
    expect(mia, `la organización ${SLUG} no aparece en el inventario de /admin`).toBeDefined()
    expect(mia!.slug).toBe(SLUG)
    // Son AGREGADOS (cuánto), nunca filas de negocio (qué): ADR-0020 §5.5.
    expect(typeof mia!.journalEntries).toBe("number")
    expect(typeof mia!.members).toBe("number")
    expect(typeof mia!.liveExceptions).toBe("number")
  })

  describe("desde el rol con el que se sirve la aplicación", () => {
    let cliente: Client

    beforeAll(async () => {
      cliente = new Client({ connectionString: appRuntimeDatabaseUrl(ownerDatabaseUrl()) })
      await cliente.connect()
    })

    afterAll(async () => {
      await cliente.end()
    })

    it("la llamada DESNUDA como `app_runtime` es 42501, no una lista vacía", async () => {
      // La distinción importa: con RLS, una consulta fuera de tenant devuelve
      // VACÍO y no se nota. Aquí tiene que doler.
      await expect(
        cliente.query(`SELECT * FROM app.operator_organizations($1::timestamp(3))`, [NOW])
      ).rejects.toMatchObject({ code: "42501" })
    })

    it("con `SET LOCAL ROLE app_operator` dentro de la transacción, la misma llamada devuelve filas", async () => {
      await cliente.query("BEGIN")
      try {
        await cliente.query("SET LOCAL ROLE app_operator")
        const res = await cliente.query(`SELECT * FROM app.operator_organizations($1::timestamp(3))`, [NOW])
        expect(res.rows.length).toBeGreaterThan(0)
        expect(res.rows.some((fila: { id: string }) => fila.id === ORG)).toBe(true)
      } finally {
        await cliente.query("COMMIT")
      }
    })

    it("el `SET LOCAL` muere con la transacción: fuera de ella vuelve a ser 42501", async () => {
      await expect(
        cliente.query(`SELECT * FROM app.operator_organizations($1::timestamp(3))`, [NOW])
      ).rejects.toMatchObject({ code: "42501" })
    })
  })
})
