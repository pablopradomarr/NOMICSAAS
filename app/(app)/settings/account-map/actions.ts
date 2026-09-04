"use server"

import { createSoftwareAccountsFormSchema, setAccountMapEntryFormSchema } from "@/forms/account-map"
import type { AccountError } from "@/lib/accounts/types"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { createSoftwareAccounts, setAccountMapEntry } from "@/models/account-map"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const MAP_PATH = "/settings/account-map"

const formatErrors = (errors: readonly AccountError[]) => errors.map((error) => error.message).join(" · ")

/**
 * Remapeo de una clave de sistema. Sólo ADMIN, motivo obligatorio (§7): cambia
 * a qué cuenta contabilizará el motor todas las facturas posteriores.
 */
export async function setAccountMapEntryAction(
  _prevState: ActionState<{ key: string; accountCode: string }> | null,
  formData: FormData
): Promise<ActionState<{ key: string; accountCode: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = setAccountMapEntryFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const result = await setAccountMapEntry(
      org.id,
      validated.data.key,
      validated.data.accountCode,
      { userId: user.id },
      validated.data.reason
    )
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }

    revalidatePath(MAP_PATH)
    revalidatePath("/settings/accounts")
    return { success: true, data: { key: validated.data.key, accountCode: validated.data.accountCode } }
  })()
}

/** §2.5 — cuentas de desglose 4720/4730/4760/4770, bajo demanda del ADMIN. */
export async function createSoftwareAccountsAction(
  _prevState: ActionState<{ created: string[] }> | null,
  formData: FormData
): Promise<ActionState<{ created: string[] }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createSoftwareAccountsFormSchema.safeParse({
      codes: formData.getAll("codes").map(String),
      reason: formData.get("reason") ?? "",
    })
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    const result = await createSoftwareAccounts(org.id, validated.data.codes, { userId: user.id }, validated.data.reason)
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }

    revalidatePath(MAP_PATH)
    revalidatePath("/settings/accounts")
    return { success: true, data: { created: result.value.created } }
  })()
}
