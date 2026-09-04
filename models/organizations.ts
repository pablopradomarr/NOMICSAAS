// NOTA: usa el cliente sin tenant a propósito (resuelve QUÉ organización).
// Excepción legítima a la futura regla no-restricted-imports (T10).
import { prisma } from "@/lib/db"
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

/** Slug estable a partir del nombre + sufijo corto para garantizar unicidad. */
export function buildOrganizationSlug(source: string, uniqueSuffixSource: string): string {
  const base = source
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const suffix = uniqueSuffixSource.replace(/-/g, "").slice(0, 6)
  return `${base || "org"}-${suffix}`
}

export const getOrganizationById = cache(async (organizationId: string): Promise<Organization | null> => {
  return await prisma.organization.findUnique({ where: { id: organizationId } })
})

export const getOrganizationBySlug = cache(async (slug: string): Promise<Organization | null> => {
  return await prisma.organization.findUnique({ where: { slug } })
})

export async function getOrganizationByStripeCustomerId(customerId: string): Promise<Organization | null> {
  return await prisma.organization.findFirst({ where: { stripeCustomerId: customerId } })
}

/** Crea la organización y la membresía ADMIN de su propietario en una transacción. */
export async function createOrganizationWithOwner(
  input: CreateOrganizationInput,
  ownerUserId: string,
  now: Date
): Promise<Organization> {
  return await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name,
        slug: input.slug ?? buildOrganizationSlug(input.name, crypto.randomUUID()),
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
  const organization = await prisma.organization.create({
    data: {
      id: user.id,
      slug: buildOrganizationSlug(user.email.split("@")[0], user.id),
      name: label,
      isPersonal: true,
    },
  })

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    update: {},
    create: { organizationId: organization.id, userId: user.id, role: Role.ADMIN, acceptedAt: now },
  })

  return organization
}

export async function updateOrganization(
  organizationId: string,
  data: Prisma.OrganizationUpdateInput
): Promise<Organization> {
  return await prisma.organization.update({ where: { id: organizationId }, data })
}

/** Nada se borra: desactivación lógica. */
export async function deactivateOrganization(organizationId: string): Promise<Organization> {
  return await prisma.organization.update({ where: { id: organizationId }, data: { isActive: false } })
}
