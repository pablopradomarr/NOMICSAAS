import { ImportCSVTable } from "@/components/import/csv"
import { getFields } from "@/models/fields"
import { tenantPage } from "@/lib/page-tenant"

export default tenantPage(async ({ db }) => {
  const fields = await getFields(db)
  return (
    <div className="flex flex-col gap-4 p-4">
      <ImportCSVTable fields={fields} />
    </div>
  )
})
