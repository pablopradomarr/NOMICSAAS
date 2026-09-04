"use server"

import { tenantDb } from "@/lib/db"
import { createOrganizationDefaults, isDatabaseEmpty } from "@/models/defaults"
import { updateSettings } from "@/models/settings"
import { ensurePersonalOrganization } from "@/models/organizations"
import { getOrCreateSelfHostedUser } from "@/models/users"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

export async function selfHostedGetStartedAction(formData: FormData) {
  const user = await getOrCreateSelfHostedUser()
  // Self-hosted: la organización local es la personal del usuario único.
  const organization = await ensurePersonalOrganization(user, new Date())
  const db = tenantDb(organization.id)

  if (await isDatabaseEmpty(db)) {
    await createOrganizationDefaults(db)
  }

  const apiKeys = [
    "openai_api_key",
    "google_api_key",
    "mistral_api_key",
    "openai_compatible_api_key",
    "openai_compatible_base_url",
  ]

  for (const key of apiKeys) {
    const value = formData.get(key)
    if (value) {
      await updateSettings(db, key, value as string)
    }
  }


  const defaultCurrency = formData.get("default_currency")
  if (defaultCurrency) {
    await updateSettings(db, "default_currency", defaultCurrency as string)
  }

  revalidatePath("/dashboard")
  redirect("/dashboard")
}
