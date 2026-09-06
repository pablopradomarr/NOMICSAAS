import { previewProposalAction } from "@/app/(app)/unsorted/actions"
import { AnalyzeDocumentButton } from "@/components/unsorted/analyze-document-button"
import { DocumentViewer } from "@/components/unsorted/document-viewer"
import { fileExists, fullPathForFile } from "@/lib/files"
import { ProposalForm } from "@/components/unsorted/proposal-form"
import { RevoidRedoDialog } from "@/components/unsorted/revoid-redo-dialog"
import { RunSelector } from "@/components/unsorted/run-selector"
import type {
  AccountNameMap,
  DocumentFileView,
  ProposalFormOptions,
  RunOptionView,
} from "@/components/unsorted/types"
import { Button } from "@/components/ui/button"
import { accountNames, postableAccounts, taxRateOptions } from "@/app/(app)/ledger/shared"
import { tenantPage } from "@/lib/page-tenant"
import { getFileById } from "@/models/files"
import { listRunsForFile } from "@/models/extraction"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Revisión del documento" }

/**
 * E8 · T15/T16 — Revisión de un documento (`/unsorted/[fileId]`, §6).
 *
 * A la izquierda **el papel**; a la derecha la propuesta, su procedencia campo a
 * campo, las veinticinco comprobaciones y el borrador del asiento. La pantalla
 * entera existe para que una persona pueda contestar tres preguntas sin salir de
 * ella: de dónde sale cada cifra, qué impide contabilizarla y qué asiento va a
 * quedar.
 *
 * La previsualización la sirve `previewProposalAction`, que es de rol **VIEWER**
 * a propósito: ver el veredicto y el borrador es información de auditoría. Los
 * botones de mutación sólo aparecen con `EDITOR`, y las acciones lo vuelven a
 * exigir.
 *
 * Lecturas en SERIE: `tenantPage` abre UNA transacción para todo el render y no
 * hay nada asíncrono que escape del cuerpo.
 */
export default tenantPage<{
  params: Promise<{ fileId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>(async ({ db, org, role, params, searchParams }) => {
  const { fileId } = await params
  const query = await searchParams
  const requestedRunId = typeof query.run === "string" ? query.run : null
  const canEdit = role === Role.EDITOR || role === Role.ADMIN

  const file = await getFileById(db, fileId)
  if (!file) notFound()

  // Los runs del fichero, del más reciente al más antiguo. El ordinal de la
  // cadena de revisión se calcula sobre el orden inverso: #1 es la extracción
  // original y los siguientes son sus revisiones (ADR-0014 D5).
  const runs = await listRunsForFile(db, fileId)
  const ordinalById = new Map([...runs].reverse().map((run, index) => [run.id, index + 1]))

  const selectedRun = runs.find((run) => run.id === requestedRunId) ?? runs[0] ?? null

  /**
   * **BUG-E8-2** — ¿están los bytes donde la ficha dice? Una sola llamada al
   * sistema (`access`), aquí y no en el cliente: el servidor ya tiene el
   * fichero delante. Coincide con lo que dirá I-E8-2 en la Auditoría y con el
   * `410` de `/files/preview/[fileId]`.
   */
  const documentoDisponible = await fileExists(fullPathForFile(org, file))

  const fileView: DocumentFileView = {
    id: file.id,
    filename: file.filename,
    mimetype: file.mimetype,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.createdAt.toISOString(),
    isReviewed: file.isReviewed,
  }

  const runViews: RunOptionView[] = runs.map((run) => ({
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

  // La operación que este documento ya haya generado, para el enlace al asiento
  // y para «anular y rehacer» (ADR-0014 D1). Se busca por los runs del fichero,
  // que es la cadena que el asiento referencia.
  const transaction =
    runs.length > 0
      ? await db.transaction.findFirst({
          where: { extractionRunId: { in: runs.map((run) => run.id) } },
          select: { id: true, status: true, journalEntryId: true, voidedEntryId: true },
          orderBy: { createdAt: "desc" },
        })
      : null
  const postedEntry = transaction?.journalEntryId
    ? await db.journalEntry.findFirst({
        where: { id: transaction.journalEntryId },
        select: { id: true, entryNumber: true },
      })
    : null

  const preview = selectedRun ? await previewProposalAction({ runId: selectedRun.id }) : null

  const names = await accountNames(db)
  const accounts = await postableAccounts(db)
  const rates = await taxRateOptions(db)
  const categories = await db.category.findMany({ select: { code: true, name: true }, orderBy: { code: "asc" } })
  const currencies = await db.currency.findMany({ select: { code: true }, orderBy: { code: "asc" } })

  const accountNameMap: AccountNameMap = Object.fromEntries(names)
  const options: ProposalFormOptions = {
    taxRateCodes: rates.map((rate) => ({ code: rate.code, label: rate.label })),
    accountCodes: accounts,
    categories: categories.map((category) => ({ code: category.code, name: category.name })),
    baseCurrency: org.baseCurrency,
    currencies: currencies.map((currency) => currency.code),
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/unsorted">← Bandeja de documentos</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{file.filename}</h1>
          <p className="text-xs text-muted-foreground">
            Moneda base de la organización: <span className="font-code">{org.baseCurrency}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {postedEntry && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/ledger/${postedEntry.id}`} data-testid="go-to-entry">
                Ver el asiento nº {postedEntry.entryNumber}
              </Link>
            </Button>
          )}
          {transaction && canEdit && (
            <RevoidRedoDialog
              transactionId={transaction.id}
              status={transaction.status}
              entryNumber={postedEntry?.entryNumber ?? null}
            />
          )}
          {canEdit && <AnalyzeDocumentButton fileId={file.id} hasRuns={runs.length > 0} />}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <DocumentViewer
            file={fileView}
            pagesSent={selectedRun?.pagesSent ?? 0}
            pagesTotal={selectedRun?.pagesTotal ?? 1}
            unavailable={!documentoDisponible}
          />
        </aside>

        <div className="min-w-0 space-y-6">
          {runs.length === 0 ? (
            <div className="rounded-md border border-dashed px-6 py-12 text-center" data-testid="no-runs">
              <p className="text-sm font-medium">Este documento todavía no se ha analizado.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Al analizarlo se registra una extracción inmutable con el proveedor, el modelo, el prompt y las páginas
                que vio. Hasta entonces no hay propuesta que revisar ni asiento que proponer.
              </p>
            </div>
          ) : (
            <>
              <RunSelector runs={runViews} selectedRunId={selectedRun?.id ?? ""} fileId={file.id} />

              {preview && preview.success && preview.data ? (
                <ProposalForm
                  initialPreview={preview.data}
                  options={options}
                  accountNames={accountNameMap}
                  canEdit={canEdit}
                  fileId={file.id}
                />
              ) : (
                <div
                  className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
                  role="alert"
                  data-testid="preview-error"
                >
                  <p className="font-medium">No se ha podido previsualizar la propuesta.</p>
                  <p className="text-muted-foreground">
                    {preview?.error ?? "La extracción no tiene propuesta: vuelva a analizar el documento."}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
