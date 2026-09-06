"use server"

import {
  createCounterpartyFormSchema,
  organizationFiscalFormSchema,
  updateCounterpartyFormSchema,
} from "@/forms/counterparties"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { createCounterparty, updateCounterparty } from "@/models/counterparties"
import { updateOrganization } from "@/models/organizations"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const PATH = "/settings/counterparties"

/**
 * E8 · T23 — Alta de tercero. **ADMIN**: lo que se da de alta aquí no es una
 * ficha de contacto, es la calificación fiscal con la que se construirán los
 * asientos de ese proveedor o cliente (retención, recargo, país). Cambiarla es
 * cambiar cifras futuras.
 */
export async function createCounterpartyAction(
  _prevState: ActionState<{ id: string }> | null,
  formData: FormData
): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createCounterpartyFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }
    try {
      const created = await createCounterparty(org.id, validated.data, { userId: user.id })
      revalidatePath(PATH)
      return { success: true, data: { id: created.id } }
    } catch (error) {
      return { success: false, error: uniqueOrMessage(error, validated.data.code) }
    }
  })()
}

export async function updateCounterpartyAction(
  _prevState: ActionState<{ id: string }> | null,
  formData: FormData
): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = updateCounterpartyFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }
    const { id, reason, ...patch } = validated.data
    try {
      await updateCounterparty(org.id, id, patch, { userId: user.id }, reason)
      revalidatePath(PATH)
      return { success: true, data: { id } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "No se pudo guardar" }
    }
  })()
}

/**
 * Régimen de IVA y ROI de la organización (D11). Con `ivaRegime ≠ GENERAL` la
 * contabilización automática queda **bloqueada** por RC-24 y la pantalla lo
 * explica: el soporte de RECC/REDEME es de E9.
 */
export async function updateOrganizationFiscalAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.ADMIN, async ({ org }): Promise<ActionState<null>> => {
    const validated = organizationFiscalFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }
    await updateOrganization(org.id, validated.data)
    revalidatePath(PATH)
    return { success: true, data: null }
  })()
}

function uniqueOrMessage(error: unknown, code: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("counterparties_org_code_key") || message.includes("Unique constraint")) {
    return `Ya existe un tercero con el código ${code} en esta organización`
  }
  return message
}
