"use server"

import { updateOrganizationFormSchema } from "@/forms/organizations"
import { ActionState } from "@/lib/actions"
import { validateVariantChange } from "@/lib/accounts/validate"
import { requireOrg } from "@/lib/authz"
import { recordAuditLog } from "@/models/audit-log"
import { updateOrganization } from "@/models/organizations"
import { Organization } from "@/prisma/client"
import { revalidatePath } from "next/cache"

/** Configuración de la organización: sólo ADMIN (matriz de roles §7.3). */
export async function updateOrganizationAction(
  _prevState: ActionState<Organization> | null,
  formData: FormData
): Promise<ActionState<Organization>> {
  const { org, user } = await requireOrg("ADMIN")

  const validated = updateOrganizationFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  // R-14: la variante del PGC no se puede cambiar con asientos posteados. En E2
  // no hay diario, así que `postedEntries` es 0; la comprobación queda cableada
  // contra la misma interfaz para el día que E3 cree `journal_entries`.
  const variantCheck = validateVariantChange(org.pgcVariant, validated.data.pgcVariant, 0)
  if (!variantCheck.ok) {
    return { success: false, error: variantCheck.errors.map((issue) => issue.message).join(" · ") }
  }

  const organization = await updateOrganization(org.id, {
    name: validated.data.name,
    taxId: validated.data.taxId,
    baseCurrency: validated.data.baseCurrency,
    timezone: validated.data.timezone,
    pgcVariant: validated.data.pgcVariant,
  })

  // E2 · T11 — cierre del TODO(E2) que dejó E1: la configuración de la
  // organización también deja rastro.
  await recordAuditLog(org.id, {
    entity: "Organization",
    entityId: org.id,
    action: "update",
    before: {
      name: org.name,
      taxId: org.taxId,
      baseCurrency: org.baseCurrency,
      timezone: org.timezone,
      pgcVariant: org.pgcVariant,
    },
    after: {
      name: organization.name,
      taxId: organization.taxId,
      baseCurrency: organization.baseCurrency,
      timezone: organization.timezone,
      pgcVariant: organization.pgcVariant,
    },
    userId: user.id,
  })

  revalidatePath("/settings/organization")
  revalidatePath("/", "layout")
  return { success: true, data: organization }
}
