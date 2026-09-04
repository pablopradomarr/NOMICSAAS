import LLMSettingsForm from "@/components/settings/llm-settings-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { getFields } from "@/models/fields"
import { getSettings } from "@/models/settings"

export default async function LlmSettingsPage() {
  // La configuración LLM sólo la edita ADMIN (claves de proveedor).
  const { db } = await requireOrg("ADMIN")
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
}
