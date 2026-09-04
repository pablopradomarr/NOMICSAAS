import { ImportCSVTable } from "@/components/import/csv"
import { requireOrg } from "@/lib/authz"
import { getFields } from "@/models/fields"

export default async function CSVImportPage() {
  const { db } = await requireOrg("VIEWER")
  const fields = await getFields(db)
  return (
    <div className="flex flex-col gap-4 p-4">
      <ImportCSVTable fields={fields} />
    </div>
  )
}
