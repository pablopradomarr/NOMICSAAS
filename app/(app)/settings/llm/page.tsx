import LLMSettingsForm from "@/components/settings/llm-settings-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import config from "@/lib/config"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import { getFields } from "@/models/fields"
import { getSettings } from "@/models/settings"

export default tenantPage(async ({ db }) => {
  // La configuración LLM sólo la edita ADMIN (claves de proveedor).
  const settings = await getSettings(db)
  const fields = await getFields(db)

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="LLM settings"
        description="Configure AI providers, system prompt, and field ordering for document analysis."
      />
      <div className="w-full max-w-2xl">
        <LLMSettingsForm settings={settings} fields={fields} isSelfHosted={config.selfHosted.isEnabled} />
      </div>
    </div>
  )
}, { minRole: Role.ADMIN })
