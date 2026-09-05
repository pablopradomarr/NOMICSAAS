// NOTA: resuelve QUÉ organización, así que no puede pasar por `tenantDb(orgId)`.
// Desde E3-T2 toda lectura y escritura va dentro de `withTenantGucs`, con
// `app.current_org` / `app.current_user` fijados, de modo que la política de
// `organizations` filtra de verdad (ADR-0009: ya no hay cláusula de escape).
// El cliente sin tenant sólo se usa para invocar la función `SECURITY DEFINER`
// del webhook de Stripe. Excepción legítima a la regla `no-restricted-imports`.
import { prisma, SEED_TRANSACTION_OPTIONS, TenantTransactionOptions, withTenantGucs } from "@/lib/db"
import { randomUUID } from "node:crypto"
import { Organization, PgcVariant, Prisma, Role } from "@/prisma/client"
import { cache } from "react"

export type CreateOrganizationInput = {
  name: string
  slug?: string
  taxId?: string | null
  baseCurrency?: string
  timezone?: string
  pgcVariant?: PgcVariant
  isPersonal?: boolean
}

/**
 * Slug estable a partir del nombre + sufijo único.
 *
 * E1-fix (#13): el sufijo es el uuid COMPLETO sin guiones, no sus 6 primeros
 * hex. Con 6 hex (24 bits) dos usuarios con el mismo prefijo de email colisionan
 * con probabilidad no despreciable y el INSERT choca con `organizations_slug_key`.
 */
export function buildOrganizationSlug(source: string, uniqueSuffixSource: string): string {
  const base = source
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const suffix = uniqueSuffixSource.replace(/-/g, "")
  return `${base || "org"}-${suffix}`
}

/**
 * E3-T2: con `app.current_org` fijado al id que se busca. La política de
 * `organizations` autoriza `id = app.current_org()`, así que funciona también
 * cuando quien lee todavía NO es miembro (pantalla de invitación).
 */
export const getOrganizationById = cache(async (organizationId: string): Promise<Organization | null> => {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.organization.findUnique({ where: { id: organizationId } })
  )
})

/**
 * E3-T2: el slug no identifica la organización ante RLS, así que hace falta el
 * usuario: la política autoriza las organizaciones de las que es miembro.
 */
export const getOrganizationBySlug = cache(
  async (slug: string, userId: string): Promise<Organization | null> => {
    return await withTenantGucs(null, userId, async (tx) => tx.organization.findFirst({ where: { slug } }))
  }
)

/**
 * E1-fix (#16): `stripe_customer_id` es UNIQUE desde 20260904140100, así que la
 * búsqueda es determinista (antes `findFirst` podía devolver una organización
 * arbitraria y el webhook actualizaba el plan de la equivocada).
 *
 * E3-T2: el webhook de Stripe no tiene sesión — ni usuario ni organización
 * activa que fijar — así que ninguna política puede autorizar esta lectura. Se
 * resuelve el ID por la puerta estrecha `app.organization_id_by_stripe_customer`
 * (`SECURITY DEFINER`, ADR-0009 §5) y el resto de la fila se lee ya con el GUC
 * puesto.
 */
export async function getOrganizationByStripeCustomerId(customerId: string): Promise<Organization | null> {
  const rows = await prisma.$queryRaw<{ id: string | null }[]>`
    SELECT app.organization_id_by_stripe_customer(${customerId}) AS id
  `
  const id = rows[0]?.id
  if (!id) return null
  return await getOrganizationById(id)
}

/** Igual que la anterior pero lanza si no existe: el webhook necesita certeza. */
export async function getOrganizationByStripeCustomerIdOrThrow(customerId: string): Promise<Organization> {
  const organization = await getOrganizationByStripeCustomerId(customerId)
  if (!organization) {
    throw new Error(`No hay ninguna organización con stripe_customer_id ${customerId}`)
  }
  return organization
}

/**
 * Crea la organización y la membresía ADMIN de su propietario en una transacción
 * con `app.current_user` fijado (E1-fix #2): la política RLS de `organizations`
 * autoriza el INSERT porque hay usuario identificado, y la de `memberships`
 * porque la fila es de ese mismo usuario. Ambas filas nacen o no nace ninguna.
 */
export async function createOrganizationWithOwner(
  input: CreateOrganizationInput,
  ownerUserId: string,
  now: Date,
  /**
   * E3-T10 (§4.4.2): siembra ATÓMICA. El callback se ejecuta DENTRO de la misma
   * transacción que crea la organización y su membresía, de modo que un fallo al
   * sembrar el plan de cuentas no deja una organización sin plan. Recibe el id ya
   * creado; dentro puede usar `tenantDb(id)` / `tenantTransaction(id, …)` con
   * normalidad: ambos detectan la transacción abierta y entran en ella en lugar
   * de tomar otra conexión del pool.
   */
  opts: { seed?: (organizationId: string) => Promise<void>; transaction?: TenantTransactionOptions } = {}
): Promise<Organization> {
  // Ronda 2 (#1): el uuid se genera AQUÍ, no en la base. Prisma ejecuta
  // `INSERT … RETURNING`, y el RETURNING se evalúa contra la política de SELECT
  // de `organizations`; conociendo el id de antemano podemos fijar
  // `app.current_org` ANTES del INSERT y que la fila recién creada sea visible
  // para su propio RETURNING (la membresía aún no existe).
  const organizationId = randomUUID()
  return await withTenantGucs(organizationId, ownerUserId, async (tx) => {
    const organization = await tx.organization.create({
      data: {
        id: organizationId,
        name: input.name,
        slug: input.slug ?? buildOrganizationSlug(input.name, organizationId),
        taxId: input.taxId ?? null,
        baseCurrency: input.baseCurrency ?? "EUR",
        timezone: input.timezone ?? "Europe/Madrid",
        pgcVariant: input.pgcVariant ?? PgcVariant.PYMES,
        isPersonal: input.isPersonal ?? false,
      },
    })

    await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: ownerUserId,
        role: Role.ADMIN,
        acceptedAt: now,
      },
    })

    // Siembra dentro de la MISMA unidad: o nace todo (organización + membresía
    // + plan de cuentas + mapa + tipos impositivos) o no nace nada. Antes eran
    // dos transacciones y un fallo en la segunda dejaba una organización
    // inservible que nadie borraba.
    if (opts.seed) await opts.seed(organization.id)

    return organization
  }, opts.transaction ?? (opts.seed ? SEED_TRANSACTION_OPTIONS : undefined))
}

/**
 * Organización personal de un usuario. Idempotente y con id = users.id, la misma
 * convención que usa la migración de backfill: así el código heredado que aún
 * deriva organizationId del userId sigue apuntando a la organización correcta
 * hasta el refactor de T9/T10.
 */
export async function ensurePersonalOrganization(
  user: { id: string; email: string; name: string | null; businessName?: string | null },
  now: Date
): Promise<Organization> {
  // Sin `cache()` a propósito: esta función es idempotente y se llama dos veces
  // seguidas (alta + verificación); memoizar el `null` de la primera llamada
  // haría que la segunda intentara crearla otra vez.
  const existing = await withTenantGucs(user.id, user.id, async (tx) =>
    tx.organization.findUnique({ where: { id: user.id } })
  )
  if (existing) return existing

  const label = user.businessName || user.name || user.email.split("@")[0]
  // El id de la organización personal es el del usuario (convención del
  // backfill), así que se conoce antes del INSERT y se fija como app.current_org.
  return await withTenantGucs(user.id, user.id, async (tx) => {
    const organization = await tx.organization.create({
      data: {
        id: user.id,
        slug: buildOrganizationSlug(user.email.split("@")[0], user.id),
        name: label,
        isPersonal: true,
      },
    })

    await tx.membership.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      update: {},
      create: { organizationId: organization.id, userId: user.id, role: Role.ADMIN, acceptedAt: now },
    })

    return organization
  })
}

/** Con `app.current_org` fijado, para que RLS admita el UPDATE (WITH CHECK). */
export async function updateOrganization(
  organizationId: string,
  data: Prisma.OrganizationUpdateInput
): Promise<Organization> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.organization.update({ where: { id: organizationId }, data })
  )
}

/** Nada se borra: desactivación lógica. */
export async function deactivateOrganization(organizationId: string): Promise<Organization> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.organization.update({ where: { id: organizationId }, data: { isActive: false } })
  )
}
