import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { dimensionOptions } from "@/app/(app)/analytics/shared"
import { accountNames, dimensionNames, entryExtras, toEntryView } from "@/app/(app)/ledger/shared"
import { ReclassifyDialog, type ReclassifyLine } from "@/components/analytics/reclassify-dialog"
import { EntryDetail } from "@/components/ledger/entry-detail"
import { EntryDocumentTab } from "@/components/unsorted/entry-document-tab"
import type { DocumentFileView, RunOptionView } from "@/components/unsorted/types"
import { getFileById } from "@/models/files"
import { listRunsForFile } from "@/models/extraction"
import { VoidDialog } from "@/components/ledger/void-dialog"
import { Button } from "@/components/ui/button"
import { getEntry } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { tenantPage } from "@/lib/page-tenant"

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
export default tenantPage<{
  params: Promise<{ entryId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>(async ({ db, org, role, params, searchParams }) => {
  const { entryId } = await params
  const query = await searchParams
  // E8 · T16 — pestaña **Documento**: el tercer clic del drill-down. Va por
  // parámetro de URL para que el enlace se pueda compartir y para que la
  // pestaña se renderice en el servidor, con el documento y su cadena ya
  // resueltos (§6, §7).
  const tab = query.tab === "documento" ? "documento" : "asiento"

  const entry = await getEntry(db, entryId)
  if (!entry) notFound()

  const names = await accountNames(db)
  const dimensions = await dimensionNames(db)
  const extras = await entryExtras(db, [entry.id])
  const view = toEntryView(entry, names, extras.get(entry.id), dimensions)
  const canVoid = role === Role.EDITOR || role === Role.ADMIN

  // El documento origen y su cadena de extracciones, para la pestaña Documento.
  const file = view.fileId ? await getFileById(db, view.fileId) : null
  const documentRuns = file ? await listRunsForFile(db, file.id) : []
  const ordinalById = new Map([...documentRuns].reverse().map((run, index) => [run.id, index + 1]))
  const fileView: DocumentFileView | null = file
    ? {
        id: file.id,
        filename: file.filename,
        mimetype: file.mimetype,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        uploadedAt: file.createdAt.toISOString(),
        isReviewed: file.isReviewed,
      }
    : null
  const runViews: RunOptionView[] = documentRuns.map((run) => ({
    id: run.id,
    kind: run.kind,
    provider: run.provider,
    model: run.model,
    createdAt: run.createdAt.toISOString(),
    promptShaShort: run.promptSha.slice(0, 8),
    schemaVersion: run.schemaVersion,
    pagesSent: run.pagesSent,
    pagesTotal: run.pagesTotal,
    partial: run.partial,
    reconcileStatus: run.reconcileStatus,
    parentRunId: run.parentRunId,
    ordinal: ordinalById.get(run.id) ?? 1,
  }))

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
      <nav className="flex gap-2 border-b" aria-label="Secciones del asiento">
        {[
          { key: "asiento", label: "Asiento" },
          { key: "documento", label: "Documento" },
        ].map((item) => (
          <Link
            key={item.key}
            href={item.key === "asiento" ? `/ledger/${entryId}` : `/ledger/${entryId}?tab=documento`}
            data-testid={`entry-tab-${item.key}`}
            aria-current={tab === item.key ? "page" : undefined}
            className={
              tab === item.key
                ? "-mb-px border-b-2 border-[#0A0A0A] px-3 py-2 text-sm font-medium"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {tab === "asiento" ? (
        <EntryDetail entry={view} baseCurrency={org.baseCurrency} />
      ) : (
        <EntryDocumentTab file={fileView} runs={runViews} supportingRunId={view.extractionRunId ?? null} />
      )}
    </div>
  )
})
