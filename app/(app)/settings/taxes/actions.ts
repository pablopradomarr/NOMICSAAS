"use server"

import {
  closeTaxRateFormSchema,
  createTaxRateFormSchema,
  taxPolicyFormSchema,
  updateTaxRateFormSchema,
} from "@/forms/tax-rates"
import type { AccountError } from "@/lib/accounts/types"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { closeTaxRate, createTaxRate, updateTaxPolicy, updateTaxRate } from "@/models/tax-rates"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const TAXES_PATH = "/settings/taxes"

const formatErrors = (errors: readonly AccountError[]) => errors.map((error) => error.message).join(" · ")

/** Alta de tipo impositivo. Sólo ADMIN; la vigencia no puede solapar (I-E2-3). */
export async function createTaxRateAction(
  _prevState: ActionState<{ id: string }> | null,
  formData: FormData
): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createTaxRateFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const { reason, ...input } = validated.data
    const result = await createTaxRate(org.id, input, { userId: user.id }, reason)
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }

    revalidatePath(TAXES_PATH)
    return { success: true, data: { id: result.value.id } }
  })()
}

/** Edición de un tipo. `code` y `kind` no se tocan: eso sería otro tributo. */
export async function updateTaxRateAction(
  _prevState: ActionState<{ id: string }> | null,
  formData: FormData
): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = updateTaxRateFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const { id, reason, ...patch } = validated.data
    const result = await updateTaxRate(org.id, id, patch, { userId: user.id }, reason)
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }

    revalidatePath(TAXES_PATH)
    return { success: true, data: { id } }
  })()
}

/** Cierre de vigencia (C-7): un tipo no se borra, se cierra. Motivo obligatorio. */
export async function closeTaxRateAction(
  _prevState: ActionState<{ id: string }> | null,
  formData: FormData
): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = closeTaxRateFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const result = await closeTaxRate(
      org.id,
      validated.data.id,
      validated.data.validTo,
      { userId: user.id },
      validated.data.reason
    )
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }

    revalidatePath(TAXES_PATH)
    return { success: true, data: { id: validated.data.id } }
  })()
}

/** Política fiscal de la organización (D2-8). Motivo obligatorio (§7). */
export async function updateTaxPolicyAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.ADMIN, async ({ org, user }): Promise<ActionState<null>> => {
    const validated = taxPolicyFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const { reason, ...patch } = validated.data
    await updateTaxPolicy(org.id, patch, { userId: user.id }, reason)
    revalidatePath(TAXES_PATH)
    return { success: true }
  })()
}
