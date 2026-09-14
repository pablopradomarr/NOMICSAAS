import { ClosingChecklist } from "@/components/closing/checklist"
import { ClosingEntries } from "@/components/closing/summary"
import { short } from "@/components/closing/types"
import { SealBlock } from "@/components/ui/seal-badge"
import { Button } from "@/components/ui/button"
import { fechaHoraUtc } from "@/lib/dates-ui"
import { tenantPage } from "@/lib/page-tenant"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { readClosingRunDetail } from "../shared"

export const metadata: Metadata = { title: "Comprobación del cierre" }

/**
 * E9 · T16 — La **foto sellada** de una comprobación del cierre (§7, §8).
 *
 * Es la vista de auditoría del `ClosingRun`: el sello con sus motivos, los
 * cuatro hashes sobre los que se emitió, los 43 pasos tal como quedaron y los
 * doce asientos. **Sólo lectura**: un run sellado no se reescribe nunca, ni
 * siquiera para «corregirlo»; lo que se hace es ejecutar otro.
 */
export default tenantPage<{ params: Promise<{ runId: string }> }>(async ({ db, params }) => {
  const { runId } = await params
  const detail = await readClosingRunDetail(db, runId)
  if (!detail) notFound()

  const { run, fiscalYear, blocks, entries } = detail

  return (
    <div className="space-y-8">
      <section className="space-y-3 border-b pb-4" data-testid="closing-run-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Comprobación del cierre</h1>
            <p className="text-sm text-muted-foreground">
              Ejercicio {fiscalYear.code} · fecha de referencia {run.refDate} · {run.durationMs} ms ·{" "}
              {fechaHoraUtc(run.createdAt)}
              {run.closedAt ? ` · cerrado ${fechaHoraUtc(run.closedAt)}` : ""}
              {run.reopenedAt ? ` · reabierto ${fechaHoraUtc(run.reopenedAt)}` : ""}
            </p>
            <p className="font-code text-xs text-muted-foreground">
              <span title={run.hashes.ledgerHash}>ledgerHash {short(run.hashes.ledgerHash, 16)}</span> ·{" "}
              <span title={run.hashes.planHash}>planHash {short(run.hashes.planHash, 12)}</span> ·{" "}
              <span title={run.hashes.accountMapHash}>accountMapHash {short(run.hashes.accountMapHash, 12)}</span> ·{" "}
              <span title={run.hashes.configHash}>configHash {short(run.hashes.configHash, 12)}</span> ·{" "}
              <span title={run.hashes.gitSha}>motor {short(run.hashes.gitSha, 8)}</span>
            </p>
            <p className="font-code text-xs text-muted-foreground">run_id {run.id}</p>
            {run.reopenReason && (
              <p className="text-sm">
                Motivo de la reapertura: <span className="text-muted-foreground">{run.reopenReason}</span>
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <SealBlock seal={run.seal} />
            <Button asChild variant="outline" size="sm">
              <Link href={`/ledger/closing?fy=${fiscalYear.id}`}>Volver al asistente</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Sin botones: una foto sellada no se toca. */}
      <ClosingChecklist blocks={blocks} fiscalYearId={fiscalYear.id} isAdmin={false} canPost={false} />

      <ClosingEntries entries={entries} />
    </div>
  )
})
