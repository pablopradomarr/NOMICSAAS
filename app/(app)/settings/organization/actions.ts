"use server"

import { updateOrganizationFormSchema } from "@/forms/organizations"
import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { updateOrganization } from "@/models/organizations"
import { Organization } from "@/prisma/client"
import { revalidatePath } from "next/cache"

/** Configuración de la organización: sólo ADMIN (matriz de roles §7.3). */
export async function updateOrganizationAction(
  _prevState: ActionState<Organization> | null,
  formData: FormData
): Promise<ActionState<Organization>> {
  const { org } = await requireOrg("ADMIN")

  const validated = updateOrganizationFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  // TODO(E2): auditLog("organization.update", { before: org, after: validated.data })
  const organization = await updateOrganization(org.id, {
    name: validated.data.name,
    taxId: validated.data.taxId,
    baseCurrency: validated.data.baseCurrency,
    timezone: validated.data.timezone,
    pgcVariant: validated.data.pgcVariant,
  })

  revalidatePath("/settings/organization")
  revalidatePath("/", "layout")
  return { success: true, data: organization }
}
