import { requireOrg } from "@/lib/authz"
import { getCategories } from "@/models/categories"
import { getCurrencies } from "@/models/currencies"
import { getProjects } from "@/models/projects"
import { getSettings } from "@/models/settings"
import { NewTransactionDialogClient } from "./new-dialog"

export async function NewTransactionDialog({ children }: { children: React.ReactNode }) {
  const { db } = await requireOrg("VIEWER")
  const categories = await getCategories(db)
  const currencies = await getCurrencies(db)
  const settings = await getSettings(db)
  const projects = await getProjects(db)

  return (
    <NewTransactionDialogClient
      categories={categories}
      currencies={currencies}
      settings={settings}
      projects={projects}
    >
      {children}
    </NewTransactionDialogClient>
  )
}
