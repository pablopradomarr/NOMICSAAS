// NOTA: usa el cliente sin tenant a propósito (resuelve QUÉ organización).
// Excepción legítima a la futura regla no-restricted-imports (T10).
import { prisma, withTenantGucs } from "@/lib/db"
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

export const getOrganizationById = cache(async (organizationId: string): Promise<Organization | null> => {
  return await prisma.organization.findUnique({ where: { id: organizationId } })
})

export const getOrganizationBySlug = cache(async (slug: string): Promise<Organization | null> => {
  return await prisma.organization.findUnique({ where: { slug } })
})

/**
 * E1-fix (#16): `stripe_customer_id` es UNIQUE desde 20260904140100, así que la
 * búsqueda es determinista (antes `findFirst` podía devolver una organización
 * arbitraria y el webhook actualizaba el plan de la equivocada).
 */
export async function getOrganizationByStripeCustomerId(customerId: string): Promise<Organization | null> {
  return await prisma.organization.findUnique({ where: { stripeCustomerId: customerId } })
}

/** Igual que la anterior pero lanza si no existe: el webhook necesita certeza. */
export async function getOrganizationByStripeCustomerIdOrThrow(customerId: string): Promise<Organization> {
  return await prisma.organization.findUniqueOrThrow({ where: { stripeCustomerId: customerId } })
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
  now: Date
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

    return organization
  })
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
  const existing = await prisma.organization.findUnique({ where: { id: user.id } })
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
