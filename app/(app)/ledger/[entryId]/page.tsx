import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { dimensionOptions } from "@/app/(app)/analytics/shared"
import { accountNames, dimensionNames, entryExtras, toEntryView } from "@/app/(app)/ledger/shared"
import { ReclassifyDialog, type ReclassifyLine } from "@/components/analytics/reclassify-dialog"
import { EntryDetail } from "@/components/ledger/entry-detail"
import { VoidDialog } from "@/components/ledger/void-dialog"
import { Button } from "@/components/ui/button"
import { requireOrg } from "@/lib/authz"
import { getEntry } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Asiento" }

/**
 * E3 · T11 / E4 · T15 — Detalle de asiento en sólo lectura (ADR-0003).
 *
 * El asiento contable no es editable: se anula con contra-asiento. Lo único que
 * SÍ se puede cambiar, y con ceremonia, es el **destino analítico** de sus
 * líneas de grupo 6/7 (ADR-0010): motivo obligatorio, `AuditLog`, `entryHash`
 * recalculado y `ledgerHash` intacto. El botón sólo aparece con rol EDITOR o
 * superior; la ventana la decide el servidor.
 */
export default async function EntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params
  const { db, org, role } = await requireOrg(Role.VIEWER)

  const entry = await getEntry(db, entryId)
  if (!entry) notFound()

  const names = await accountNames(db)
  const dimensions = await dimensionNames(db)
  const extras = await entryExtras(db, [entry.id])
  const view = toEntryView(entry, names, extras.get(entry.id), dimensions)
  const canVoid = role === Role.EDITOR || role === Role.ADMIN

  const listing = await listAnalyticsAction({})
  const options = dimensionOptions(listing.data?.projects ?? [], listing.data?.costCenters ?? [])

  const reclassifyLines: ReclassifyLine[] = view.lines
    .filter((line) => line.isPnlLine && line.id)
    .map((line) => ({
      id: line.id as string,
      lineNo: line.lineNo,
      entryNumber: view.entryNumber,
      entryDate: view.entryDate,
      accountCode: line.accountCode,
      accountName: line.accountName,
      amountCents: line.creditCents - line.debitCents,
      analyticType: line.analyticType ?? null,
      projectId: line.projectId ?? null,
      costCenterId: line.costCenterId ?? null,
      destinationLabel: line.destinationCode ?? "sin destino",
    }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/ledger">← Libro diario</Link>
        </Button>
        <div className="flex gap-2">
          <ReclassifyDialog lines={reclassifyLines} options={options} canReclassify={canVoid} role={role} />
          <VoidDialog entry={view} canVoid={canVoid} />
        </div>
      </div>
      <EntryDetail entry={view} baseCurrency={org.baseCurrency} />
    </div>
  )
}
