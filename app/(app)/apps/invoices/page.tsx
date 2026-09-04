import { requireOrg } from "@/lib/authz"
import { getAppData } from "@/models/apps"
import { getCurrencies } from "@/models/currencies"
import { getSettings } from "@/models/settings"
import { InvoiceGenerator } from "./components/invoice-generator"
import { InvoiceTemplate } from "./default-templates"
import { manifest } from "./manifest"

export type InvoiceAppData = {
  templates: InvoiceTemplate[]
}

export default async function InvoicesApp() {
  const { db, org, user } = await requireOrg("VIEWER")
  const settings = await getSettings(db)
  const currencies = await getCurrencies(db)
  const appData = (await getAppData(db, user.id, "invoices")) as InvoiceAppData | null

  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-2 mb-8">
        <h2 className="flex flex-row gap-3 md:gap-5">
          <span className="text-3xl font-bold tracking-tight">
            {manifest.icon} {manifest.name}
          </span>
        </h2>
      </header>
      <InvoiceGenerator organization={org} settings={settings} currencies={currencies} appData={appData} />
    </div>
  )
}
