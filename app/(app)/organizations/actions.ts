"use server"

import { createOrganizationFormSchema, switchOrganizationSchema } from "@/forms/organizations"
import { ActionState } from "@/lib/actions"
import { getCurrentUser } from "@/lib/auth"
import { setActiveOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import { createOrganizationDefaults } from "@/models/defaults"
import { createOrganizationWithOwner } from "@/models/organizations"
import { Organization } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

/**
 * Cambia la organización activa. La membresía se comprueba SIEMPRE en servidor
 * (`setActiveOrg` lanza si no existe); la cookie es un hint, nunca una credencial.
 */
export async function switchOrganizationAction(organizationId: string): Promise<ActionState<null>> {
  const user = await getCurrentUser()

  const validated = switchOrganizationSchema.safeParse({ organizationId })
  if (!validated.success) {
    return { success: false, error: "Identificador de organización inválido" }
  }

  try {
    await setActiveOrg(validated.data.organizationId, user.id)
  } catch {
    return { success: false, error: "No perteneces a esa organización" }
  }

  revalidatePath("/", "layout")
  redirect("/dashboard")
}

/**
 * Alta de organización: crea la organización, la membresía ADMIN de quien la crea
 * y la semilla de datos por defecto; después la deja activa.
 * No exige rol: cualquier usuario autenticado puede crear la suya.
 */
export async function createOrganizationAction(
  _prevState: ActionState<Organization> | null,
  formData: FormData
): Promise<ActionState<Organization>> {
  const user = await getCurrentUser()

  const validated = createOrganizationFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  let organization: Organization
  try {
    organization = await createOrganizationWithOwner(
      {
        name: validated.data.name,
        taxId: validated.data.taxId,
        baseCurrency: validated.data.baseCurrency,
        timezone: validated.data.timezone,
        pgcVariant: validated.data.pgcVariant,
      },
      user.id,
      new Date()
    )
    await createOrganizationDefaults(tenantDb(organization.id))
    await setActiveOrg(organization.id, user.id)
  } catch {
    return { success: false, error: "No se ha podido crear la organización" }
  }

  revalidatePath("/", "layout")
  redirect("/dashboard")
}
