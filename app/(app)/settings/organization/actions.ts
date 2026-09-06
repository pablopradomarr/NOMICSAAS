"use server"

import { categoryFiscalFormSchema } from "@/forms/counterparties"
import { updateOrganizationFormSchema } from "@/forms/organizations"
import { ActionState } from "@/lib/actions"
import { validateVariantChange } from "@/lib/accounts/validate"
import { requireOrg, withOrg } from "@/lib/authz"
import { recordAuditLog, writeAuditLog } from "@/models/audit-log"
import { updateOrganization } from "@/models/organizations"
import { Organization, Role } from "@/prisma/client"
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

// ─────────────────────────────────────────────────────────────────────────────
// E8 · T17 — Deducibilidad por defecto de una categoría de gasto (O-17)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tres valores, y el tercero es el que importa: `REQUIERE_DECISION`. Los gastos
 * del art. 96 LIVA y del art. 95.Tres.2ª —hostelería, restauración, atenciones a
 * clientes, espectáculos, combustible de turismos— no son deducibles «según el
 * caso», y el producto **no lo adivina**: deja el campo como no verificado,
 * bloquea el lote (RC-15) y obliga a que una persona decida documento a
 * documento.
 *
 * La cuenta por defecto es de origen `catalogo`, nunca del modelo (O-10), y no
 * puede apuntar al subgrupo 64: las nóminas entran por T-10 y no por una
 * plantilla de compra. Lo repite el CHECK de la base, porque una regla que sólo
 * vive en un formulario no protege a la fila que llega por otro camino.
 */
export async function updateCategoryFiscalAction(input: unknown): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ code: string }>> => {
    const parsed = categoryFiscalFormSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" }

    const before = await db.category.findFirst({
      where: { code: parsed.data.code },
      select: { code: true, defaultAccountCode: true, defaultDeductibility: true },
    })
    if (!before) return { success: false, error: `La categoría ${parsed.data.code} no existe en esta organización` }

    try {
      await db.category.update({
        where: { organizationId_code: { organizationId: db.$organizationId, code: parsed.data.code } },
        data: {
          defaultAccountCode: parsed.data.defaultAccountCode,
          defaultDeductibility: parsed.data.defaultDeductibility,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: message.includes("default_account")
          ? "Una categoría no puede apuntar al subgrupo 64: las nóminas se contabilizan con T-10"
          : message,
      }
    }

    await writeAuditLog(db, {
      entity: "Organization",
      entityId: parsed.data.code,
      action: "update",
      before,
      after: {
        code: parsed.data.code,
        defaultAccountCode: parsed.data.defaultAccountCode,
        defaultDeductibility: parsed.data.defaultDeductibility,
      },
      userId: user.id,
    })

    revalidatePath("/settings/organization")
    return { success: true, data: { code: parsed.data.code } }
  })()
}
