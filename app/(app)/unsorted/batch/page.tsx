import { previewProposalAction } from "@/app/(app)/unsorted/actions"
import { BatchPanel, type BatchCandidate } from "@/components/unsorted/batch-panel"
import { Button } from "@/components/ui/button"
import { tenantTransaction } from "@/lib/db"
import { tenantPage } from "@/lib/page-tenant"
import { listInboxWithLatestRun } from "@/models/extraction"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Confirmación por lote" }

/** Tope de documentos que la pantalla previsualiza de una vez (§9). */
const MAX_CANDIDATES = 50

/**
 * E8 · T17 — `/unsorted/batch` (§6).
 *
 * Los candidatos son los que llegan por `?runIds=` desde la bandeja o, si no
 * viene ninguno, los últimos runs pendientes. De cada uno se pide la
 * **previsualización real** —la misma que juzgará la confirmación— para poder
 * enseñar la plantilla elegida y el cuadre antes de contabilizar nada, y para
 * que el motivo de exclusión sea el de verdad y no una aproximación de pantalla.
 *
 * Eso cuesta una previsualización por documento, y por eso la pantalla está
 * acotada a {@link MAX_CANDIDATES}: el lote es una revisión, no una carga
 * masiva.
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, org, role, searchParams }) => {
    const params = await searchParams
    const requested = typeof params.runIds === "string" ? params.runIds.split(",").filter(Boolean) : []
    const canEdit = role === Role.EDITOR || role === Role.ADMIN

    let runIds = requested.slice(0, MAX_CANDIDATES)
    // SQL crudo: sólo ve `app.current_org` sobre el cliente de la transacción
    // de tenant (límite #2 de `lib/db.ts`). Dentro de `tenantPage` la
    // transacción ya está abierta y `tenantTransaction` la reutiliza.
    const inbox = await tenantTransaction(
      db.$organizationId,
      async (tx) => await listInboxWithLatestRun(tx, { limit: MAX_CANDIDATES })
    )
    if (runIds.length === 0) {
      runIds = inbox.rows.map((row) => row.runId).filter((id): id is string => Boolean(id))
    }

    const fileByRun = new Map(
      inbox.rows
        .filter((row) => row.runId)
        .map((row) => [row.runId as string, { fileId: row.fileId, filename: row.filename }])
    )

    const candidates: BatchCandidate[] = []
    for (const runId of runIds) {
      const state = await previewProposalAction({ runId })
      const known = fileByRun.get(runId)
      if (!state.success || !state.data) {
        candidates.push({
          runId,
          fileId: known?.fileId ?? "",
          filename: known?.filename ?? "documento",
          docKind: null,
          documentNumber: null,
          totalCents: null,
          currency: null,
          templateCode: null,
          descuadreCents: null,
          elegible: false,
          motivo: state.error ?? "no se ha podido previsualizar la propuesta",
        })
        continue
      }

      const preview = state.data
      candidates.push({
        runId,
        fileId: preview.fileId,
        filename: known?.filename ?? preview.proposal.documentNumber ?? "documento",
        docKind: preview.proposal.docKind,
        documentNumber: preview.proposal.documentNumber,
        totalCents: preview.proposal.totalCents,
        currency: preview.proposal.currency,
        templateCode: preview.asiento?.templateCode ?? null,
        descuadreCents: preview.asiento?.descuadreCents ?? null,
        elegible: ineligibilityOf(preview) === null,
        motivo: ineligibilityOf(preview),
      })
    }

    return (
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="space-y-1">
            <Button asChild variant="ghost" size="sm" className="-ml-3">
              <Link href="/unsorted">← Bandeja de documentos</Link>
            </Button>
            <h1 className="text-2xl font-semibold tracking-tight">Confirmación por lote</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Al lote sólo entra lo que está conforme, completo y sin comprobaciones que bloqueen. Cada documento se
              contabiliza en su propia transacción: un fallo no arrastra a los demás. Lo que no entra se lista aparte,
              con su motivo.
            </p>
          </div>
        </header>

        {candidates.length === 0 ? (
          <div className="rounded-md border border-dashed px-6 py-16 text-center">
            <p className="text-sm font-medium">No hay documentos analizados pendientes de contabilizar.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Analice documentos desde la bandeja y vuelva aquí para contabilizarlos en bloque.
            </p>
          </div>
        ) : (
          <BatchPanel candidates={candidates} canEdit={canEdit} baseCurrency={org.baseCurrency} />
        )}
      </div>
    )
  }
)

/**
 * El **mismo** criterio que `batchIneligibility` aplica en el servidor al
 * confirmar. Se escribe aquí sobre la previsualización para que la pantalla
 * anticipe la decisión y nunca ofrezca lo que la acción va a rechazar.
 */
function ineligibilityOf(preview: {
  partial: boolean
  runKind: string
  status: string
  elegibleParaLote: boolean
  checks: readonly { id: string; message: string; blocksBatch: boolean; status: string }[]
  asiento: unknown
}): string | null {
  if (preview.runKind === "IMPORTED") return "importado sin origen: no respalda ningún asiento"
  if (preview.partial) return "extracción parcial: hay que revisar y teclear las cifras"
  if (preview.status === "FAIL") {
    const failed = preview.checks.filter((check) => check.status === "FAIL").map((check) => check.id)
    return `la propuesta no está reconciliada (${failed.join(", ")})`
  }
  const blocking = preview.checks.filter((check) => check.blocksBatch)
  if (blocking.length > 0) {
    return `hay comprobaciones que bloquean el lote: ${blocking.map((check) => `${check.id} (${check.message})`).join(" · ")}`
  }
  if (!preview.elegibleParaLote) return "el documento exige una decisión individual"
  if (preview.asiento === null) return "no hay borrador de asiento que contabilizar"
  return null
}
