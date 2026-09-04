import config from "@/lib/config"
import { tenantDb } from "@/lib/db"
import { createOrganizationDefaults, isDatabaseEmpty } from "@/models/defaults"
import { ensurePersonalOrganization } from "@/models/organizations"
import { getSelfHostedUser } from "@/models/users"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

export async function GET() {
  if (!config.selfHosted.isEnabled) {
    redirect(config.auth.loginUrl)
  }

  const user = await getSelfHostedUser()
  if (!user) {
    redirect(config.selfHosted.welcomeUrl)
  }

  const organization = await ensurePersonalOrganization(user, new Date())
  const db = tenantDb(organization.id)
  if (await isDatabaseEmpty(db)) {
    await createOrganizationDefaults(db)
  }

  revalidatePath("/dashboard")
  redirect("/dashboard")
}
