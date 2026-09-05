import { accountNames, entryExtras, toEntryView } from "@/app/(app)/ledger/shared"
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
 * E3 · T11 — Detalle de asiento en sólo lectura (ADR-0003).
 *
 * Nada es editable: un asiento contabilizado no se toca, se anula con
 * contra-asiento. El botón "Anular" sólo aparece con rol EDITOR y sobre un
 * asiento vigente que no sea ya un contra-asiento (I-E3-4); la protección real
 * está en `voidEntryAction` y en el trigger `journal_entries_reversal_target`.
 */
export default async function EntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params
  const { db, org, role } = await requireOrg(Role.VIEWER)

  const entry = await getEntry(db, entryId)
  if (!entry) notFound()

  const names = await accountNames(db)
  const extras = await entryExtras(db, [entry.id])
  const view = toEntryView(entry, names, extras.get(entry.id))
  const canVoid = role === Role.EDITOR || role === Role.ADMIN

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/ledger">← Libro diario</Link>
        </Button>
        <VoidDialog entry={view} canVoid={canVoid} />
      </div>
      <EntryDetail entry={view} baseCurrency={org.baseCurrency} />
    </div>
  )
}
