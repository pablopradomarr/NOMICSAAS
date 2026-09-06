"use client"

import { confirmBatchAction, type BatchConfirmation } from "@/app/(app)/unsorted/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DOC_KIND_LABEL } from "@/components/unsorted/types"
import { formatCents } from "@/lib/money"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T17 — Confirmación por lote (`/unsorted/batch`, §6).
 *
 * El lote **no es «contabilizar todo»**. Es: esto entra, esto no, y esto es por
 * qué. Un documento sale del lote por cuatro razones y las cuatro se escriben:
 * extracción parcial, propuesta no reconciliada, alguna comprobación con
 * `blocksBatch` —la categoría que O-19 inventó para las retenciones no
 * practicadas y las deducibilidades pendientes— o una decisión individual
 * pendiente.
 *
 * El servidor abre **una transacción por documento** (§4.3): un fallo en el
 * tercero no arrastra a los dos primeros ni bloquea a los cuarenta siguientes.
 */

export type BatchCandidate = {
  runId: string
  fileId: string
  filename: string
  docKind: string | null
  documentNumber: string | null
  totalCents: number | null
  currency: string | null
  templateCode: string | null
  descuadreCents: number | null
  elegible: boolean
  motivo: string | null
}

export function BatchPanel({
  candidates,
  canEdit,
  baseCurrency,
}: {
  candidates: readonly BatchCandidate[]
  canEdit: boolean
  baseCurrency: string
}) {
  const router = useRouter()
  const eligible = candidates.filter((candidate) => candidate.elegible)
  const rejected = candidates.filter((candidate) => !candidate.elegible)

  const [selected, setSelected] = useState<readonly string[]>(() => eligible.map((candidate) => candidate.runId))
  const [result, setResult] = useState<BatchConfirmation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toggle = (runId: string) =>
    setSelected((current) => (current.includes(runId) ? current.filter((id) => id !== runId) : [...current, runId]))

  const confirm = () =>
    startTransition(async () => {
      setError(null)
      const state = await confirmBatchAction({ runIds: [...selected] })
      if (!state.success || !state.data) {
        setError(state.error ?? "No se ha podido confirmar el lote")
        return
      }
      setResult(state.data)
      router.refresh()
    })

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Elegibles ({eligible.length})</h2>
          {canEdit && (
            <Button
              type="button"
              size="sm"
              onClick={confirm}
              disabled={pending || selected.length === 0}
              data-testid="confirm-batch"
            >
              {pending ? "Contabilizando…" : `Contabilizar ${selected.length} documento(s)`}
            </Button>
          )}
        </div>

        {eligible.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground" data-testid="batch-empty">
            Ningún documento cumple hoy las condiciones del lote. Revíselos uno a uno: el motivo de cada exclusión está
            escrito debajo.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="batch-eligible">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  {canEdit && <th className="w-8 px-2 py-2" />}
                  <th className="px-3 py-2 text-left font-medium">Documento</th>
                  <th className="px-3 py-2 text-left font-medium">Tipo</th>
                  <th className="px-3 py-2 text-left font-medium">Plantilla</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Cuadre</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {eligible.map((candidate) => (
                  <tr key={candidate.runId} className="h-8" data-run-id={candidate.runId}>
                    {canEdit && (
                      <td className="px-2 py-1">
                        <Checkbox
                          checked={selected.includes(candidate.runId)}
                          onCheckedChange={() => toggle(candidate.runId)}
                          aria-label={`Incluir ${candidate.filename} en el lote`}
                        />
                      </td>
                    )}
                    <td className="max-w-[22rem] px-3 py-1">
                      <Link href={`/unsorted/${candidate.fileId}`} className="underline-offset-2 hover:underline">
                        <span className="block truncate" title={candidate.filename}>
                          {candidate.filename}
                        </span>
                      </Link>
                      <span className="font-code text-[11px] text-muted-foreground">
                        {candidate.documentNumber ?? "sin número"}
                      </span>
                    </td>
                    <td className="px-3 py-1 text-xs">
                      {candidate.docKind ? (DOC_KIND_LABEL[candidate.docKind] ?? candidate.docKind) : "—"}
                    </td>
                    <td className="px-3 py-1 font-code text-xs">{candidate.templateCode ?? "—"}</td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      {candidate.totalCents === null
                        ? "—"
                        : formatCents(candidate.totalCents, { currency: candidate.currency ?? baseCurrency })}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums">
                      {candidate.descuadreCents === null
                        ? "—"
                        : `${formatCents(candidate.descuadreCents, { currency: baseCurrency, zeroAsDash: false })} ${candidate.descuadreCents === 0 ? "✓" : "⚠"}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">No elegibles ({rejected.length})</h2>
        {rejected.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todos los documentos seleccionados entran en el lote.</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm" data-testid="batch-rejected">
            {rejected.map((candidate) => (
              <li key={candidate.runId} className="flex flex-wrap items-baseline gap-2 px-3 py-2" data-run-id={candidate.runId}>
                <Link href={`/unsorted/${candidate.fileId}`} className="font-medium underline-offset-2 hover:underline">
                  {candidate.filename}
                </Link>
                <span className="text-muted-foreground">{candidate.motivo}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {result && (
        <section className="space-y-2 rounded-md border p-3" data-testid="batch-result">
          <h2 className="text-sm font-semibold tracking-tight">Resultado del lote</h2>
          <p className="text-sm">
            {result.confirmados.length} documento(s) contabilizado(s), {result.noElegibles.length} sin contabilizar.
          </p>
          <ul className="space-y-1 text-sm">
            {result.confirmados.map((confirmed) => (
              <li key={confirmed.transactionId}>
                Asiento nº{" "}
                <Link href={`/ledger/${confirmed.entryId}`} className="font-code underline underline-offset-2">
                  {confirmed.entryNumber}
                </Link>
                {confirmed.yaEstaba && " (ya estaba contabilizado: no se ha duplicado)"}
              </li>
            ))}
            {result.noElegibles.map((rejectedRun) => (
              <li key={rejectedRun.runId} className="text-muted-foreground">
                <span className="font-code text-xs">{rejectedRun.runId.slice(0, 8)}</span> — {rejectedRun.motivo}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
