import ProfileSettingsForm from "@/components/settings/profile-settings-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { getCurrentUser } from "@/lib/auth"
import config from "@/lib/config"
import { tenantPage } from "@/lib/page-tenant"

export default tenantPage(async ({ org, role }) => {
  const user = await getCurrentUser()

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Profile & Plan"
        description="Manage your account, subscription, and business details used on invoices."
      />
      <div className="w-full max-w-2xl">
        <ProfileSettingsForm
          user={user}
          organization={org}
          canEditBusiness={role === "ADMIN"}
          // E13 · T12 (§8.2 T12): self-hosted no tiene sesión de better-auth ni contraseña que cambiar.
          showPasswordSection={!config.selfHosted.isEnabled}
        />
      </div>
    </div>
  )
})
