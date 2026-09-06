/**
 * Arnés de los e2e — **siembra** el entorno mínimo en la base de desarrollo en
 * vez de darlo por hecho (revisión E5 ronda 1).
 *
 * Los e2e asumían dos cosas que la base `erp` podía no tener:
 *
 *  1. el usuario global de `SELF_HOSTED_MODE` (`taxhacker@localhost`) con su
 *     organización personal y su membresía ADMIN — sin él la aplicación manda al
 *     asistente «TaxHacker: Self-Hosted Edition» y la suite falla en el primer
 *     `expect` con un mensaje que no dice nada del problema real;
 *  2. una **segunda** organización para las suites que cargan fixtures. Son dos
 *     a propósito, porque sus planes de cuentas son incompatibles: la personal
 *     nace con **subcuentas** (`5720`, `47510`…, que `plan-cuentas.spec` edita) y
 *     los fixtures se postean contra las cuentas de tres dígitos (`572`), que en
 *     un plan con subcuentas no admiten apuntes. Con una sola, la carga del
 *     fixture moría con «La cuenta 572 tiene subcuentas y no admite apuntes» y,
 *     peor, el `--reset-org` de una suite borraba el diario de otra.
 *
 * Un arnés no puede depender del estado previo: lo crea. Se ejecuta por
 * `npx tsx` desde `tests/e2e/session.ts` porque necesita el código de la
 * aplicación y el cargador ESM de Playwright no puede importarlo directamente.
 *
 *   npx tsx tests/support/ensure-self-hosted.ts
 *
 * Imprime en `stdout`, en una sola línea, el JSON
 * `{ userId, organizationId, analyticsOrganizationId }`. Es IDEMPOTENTE.
 */

import { prisma, tenantDb, tenantTransaction } from "@/lib/db"
import { importNpgc } from "@/models/accounts"
import { seedAnalyticsDefaults } from "@/models/analytics"
import { createOrganizationDefaults, isDatabaseEmpty } from "@/models/defaults"
import { createOrganizationWithOwner, ensurePersonalOrganization } from "@/models/organizations"
import { getOrCreateSelfHostedUser } from "@/models/users"
import { loadFixtureIntoOrg } from "@/scripts/load-fixture"

/** Slug estable: el arnés la reconoce entre ejecuciones y no crea otra. */
const ANALYTICS_SLUG = "e2e-analitica"

async function main(): Promise<void> {
  const user = await getOrCreateSelfHostedUser()
  const organization = await ensurePersonalOrganization(user, new Date())
  const db = tenantDb(organization.id)
  if (await isDatabaseEmpty(db)) {
    await createOrganizationDefaults(db)
  }

  // La organización de los fixtures: plan SIN subcuentas —el que declaran
  // `tests/fixtures/*.json`— y dimensiones analíticas por defecto. El diario lo
  // carga cada suite con `scripts/load-fixture.ts --reset-org`.
  const existing = await prisma.organization.findFirst({ where: { slug: ANALYTICS_SLUG } })
  const analytics =
    existing ??
    (await createOrganizationWithOwner(
      { name: "Analítica e2e", slug: ANALYTICS_SLUG, pgcVariant: "PYMES" },
      user.id,
      new Date(),
      {
        seed: async (organizationId) => {
          await importNpgc(organizationId, "PYMES", {
            useSubaccounts: false,
            actor: { userId: user.id },
            now: new Date("2026-01-01"),
          })
          await tenantTransaction(organizationId, user.id, async (tx) =>
            seedAnalyticsDefaults(tx, { validFrom: "2026-01-01", userId: user.id })
          )
        },
      }
    ))

  // La organización personal debe ser la que la aplicación elige por defecto
  // cuando no hay cookie de organización activa (`getOrgContext` cae a la
  // membresía MÁS RECIENTE): `plan-cuentas.spec` y `libro-diario.spec` corren
  // sobre ella sin plantar cookie, mientras que las suites analíticas sí la
  // plantan. La membresía de la organización de fixtures se ancla en el pasado.
  await prisma.membership.updateMany({
    where: { organizationId: analytics.id, userId: user.id },
    data: { acceptedAt: new Date("2020-01-01T00:00:00.000Z") },
  })

  // Y el diario del fixture: `analitica.spec` e `informes.spec` lo dan por
  // cargado (sólo `liquidacion.spec` lo recarga en su `beforeAll`). Si la
  // organización está vacía, el arnés lo carga una vez.
  const entries = await tenantTransaction(analytics.id, user.id, async (tx) => tx.journalEntry.count())
  if (entries === 0) {
    await loadFixtureIntoOrg({
      fixture: "ejercicio-completo",
      organizationId: analytics.id,
      userId: user.id,
    })
  }

  process.stdout.write(
    `${JSON.stringify({
      userId: user.id,
      organizationId: organization.id,
      analyticsOrganizationId: analytics.id,
    })}\n`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
