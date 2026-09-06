"use client"

import { reverseAllocationRunAction } from "@/app/(app)/analytics/allocations/actions"
import {
  PERIOD_LABELS,
  RUN_STATUS_LABELS,
  periodLabelOf,
  type AllocationRunView,
} from "@/components/analytics/allocation-types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { MIN_ALLOCATION_REASON } from "@/forms/allocations"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E5 · T12 — Listado de liquidaciones selladas (`E5-liquidacion.md` §6).
 *
 * Cuatro estados, y sólo uno de ellos se almacena:
 *
 * - `SEALED` — vigente, aporta a la PyG analítica.
 * - `SUPERSEDED` — sustituida por una liquidación posterior del mismo periodo.
 *   Deja de aportar y **sigue consultable**: nada se borra.
 * - `REVERSED` — apagada con motivo. **No genera ningún asiento**: el
 *   `ledgerHash` del periodo queda idéntico.
 * - **Caducada** — DERIVADO, nunca almacenado: los tres sellos del run ya no
 *   coinciden con los del periodo hoy (un asiento tardío, una reclasificación,
 *   una regla nueva). Se recalcula en cada lectura, así que no puede quedarse
 *   obsoleto.
 */
export function AllocationRunsTable({
  runs,
  canReverse,
  currency,
}: {
  runs: readonly AllocationRunView[]
  canReverse: boolean
  currency: string
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="allocation-runs-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Periodo</th>
              <th className="px-3 py-2 text-left font-medium">Periodicidad</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-right font-medium">Líneas</th>
              <th className="px-3 py-2 text-right font-medium">Total repartido</th>
              <th className="px-3 py-2 text-left font-medium">Sellos</th>
              <th className="px-3 py-2 text-left font-medium">Liquidada el</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-sm text-muted-foreground" colSpan={8} data-testid="allocation-runs-empty">
                  Aún no se ha liquidado ningún periodo. Simula arriba y pulsa «Liquidar» para sellar el primero.
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.id} className="h-8 align-top" data-run-period={run.periodLabel} data-run-status={run.status}>
                <td className="px-3 py-1 font-code text-xs">
                  <Link href={`/analytics/allocations/runs/${run.id}`} className="underline underline-offset-2">
                    {run.periodLabel}
                  </Link>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {formatLocalDate(run.periodStart)} – {formatLocalDate(run.periodEnd)}
                  </span>
                </td>
                <td className="px-3 py-1 text-xs">{PERIOD_LABELS[run.periodKind] ?? run.periodKind}</td>
                <td className="px-3 py-1 text-xs">
                  <RunStatusBadge run={run} />
                </td>
                <td className="px-3 py-1 text-right tabular-nums">{run.lineCount}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={run.totalAllocatedCents} />
                </td>
                <td className="px-3 py-1 font-code text-[11px] text-muted-foreground">
                  <span title={run.ledgerHash}>L {shortHash(run.ledgerHash, 10)}</span>{" "}
                  <span title={run.analyticsHash}>A {shortHash(run.analyticsHash, 10)}</span>{" "}
                  <span title={run.rulesHash}>R {shortHash(run.rulesHash, 10)}</span>
                </td>
                <td className="px-3 py-1 text-xs text-muted-foreground">{run.runAt.slice(0, 16).replace("T", " ")}</td>
                <td className="px-3 py-1 text-right whitespace-nowrap">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/analytics/allocations/runs/${run.id}`}>Ver detalle</Link>
                  </Button>
                  {canReverse && run.status === "SEALED" && <ReverseRunDialog run={run} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Moneda base {currency}. Una liquidación revertida <strong>no genera ningún asiento</strong>: la imputación es
        capa analítica paralela al libro diario. El estado «caducada» se deriva comparando los tres sellos del run con
        los del periodo ahora mismo; no se almacena.
      </p>
    </div>
  )
}

export function RunStatusBadge({ run }: { run: AllocationRunView }) {
  if (run.status === "SEALED" && run.isStale) {
    return (
      <span
        className="inline-flex flex-col gap-0.5"
        data-run-state="STALE"
        title={run.staleReasons.join(" · ")}
      >
        <span className="inline-flex w-fit items-center rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-1.5 py-0.5 text-[11px]">
          ⚠ Caducada
        </span>
        <span className="text-[11px] text-muted-foreground" data-testid="stale-reasons">
          {run.staleReasons.join(" · ")}
        </span>
      </span>
    )
  }
  const label = RUN_STATUS_LABELS[run.status] ?? run.status
  return (
    <span className="inline-flex flex-col gap-0.5" data-run-state={run.status}>
      <span className="inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[11px]">{label}</span>
      {run.reversalReason && (
        <span className="text-[11px] text-muted-foreground" data-testid="reversal-reason">
          {run.reversalReason}
        </span>
      )}
    </span>
  )
}

export function ReverseRunDialog({ run, block = false }: { run: AllocationRunView; block?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await reverseAllocationRunAction({ runId: run.id, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido revertir la liquidación")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={block ? "" : "ml-2"}
        onClick={() => setOpen(true)}
        data-testid={`reverse-${periodLabelOf(run.periodKind, run.periodStart)}`}
      >
        Revertir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Revertir la liquidación {run.periodLabel}</DialogTitle>
            <DialogDescription>
              La liquidación deja de aportar a la PyG analítica y sigue consultable. <strong>No se genera ningún
              asiento</strong>: el libro diario y su <span className="font-code">ledgerHash</span> quedan idénticos. El
              saldo que estos centros de coste habían repartido vuelve a figurar como pendiente de liquidar.
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              Motivo de la reversión (mínimo {MIN_ALLOCATION_REASON} caracteres)
            </span>
            <Textarea
              rows={3}
              aria-label="Motivo de la reversión"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-testid="reversal-reason-input"
            />
          </label>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="reverse-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || reason.trim().length < MIN_ALLOCATION_REASON}
              data-testid="confirm-reverse"
            >
              {pending ? "Revirtiendo…" : "Revertir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
