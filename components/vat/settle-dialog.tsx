"use client"

import { settleVatAction, type SettleVatResult } from "@/app/(app)/reports/vat/actions"
import { EntryDraftPreview } from "@/components/assets/entry-draft-preview"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { CheckStatusChip } from "@/components/ui/check-status"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T18 — «Liquidar periodo» (**ADMIN**, T-23).
 *
 * Tres cosas que esta pantalla no se salta:
 *
 * · **Se declara desde el libro**, no desde los saldos; si el libro y los saldos
 *   difieren, la acción lo dice y no postea (R-IVA-9).
 * · La vista previa firma el diario con su `ledgerHash` y el botón lo devuelve:
 *   si el diario cambió entre medias, la acción **rechaza**. Liquidar sobre
 *   cifras que ya no son las que se enseñaron es sellar un número equivocado.
 * · Los **bloqueos** (prorrata definitiva sin cerrar, guardia de bienes de
 *   inversión) se enseñan como pasos con su evidencia y **impiden** postear.
 */
export function SettleVatDialog({ period }: { period: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [preview, setPreview] = useState<SettleVatResult | null>(null)

  const run = (dryRun: boolean): void => {
    start(async () => {
      const state = await settleVatAction({
        period,
        dryRun,
        expectedLedgerHash: dryRun ? null : (preview?.ledgerHash ?? null),
      })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "No se ha podido liquidar el periodo")
        return
      }
      setPreview(state.data)
      if (!dryRun && !state.data.dryRun) {
        toast.success(`Periodo ${period} liquidado`)
        router.refresh()
      } else if (!dryRun && state.data.blockers.length > 0) {
        toast.error("La liquidación está bloqueada: revise los pasos en rojo")
      }
    })
  }

  const bloqueada = (preview?.blockers.length ?? 0) > 0

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="open-settle">
        Liquidar {period}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setPreview(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Liquidar el periodo {period}</DialogTitle>
            <DialogDescription>
              El servidor recalcula desde el libro registro y compara la firma del diario con la de esta vista previa.
              Si el diario ha cambiado entre medias, la liquidación se rechaza y no se postea nada.
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <Figure label="IVA repercutido" cents={preview.outputCents} testId="settle-output" />
                <Figure label="IVA soportado deducible" cents={preview.inputCents} testId="settle-input" />
                <Figure label="Resultado (casilla 71)" cents={preview.resultCents} testId="settle-result" />
              </div>
              <p className="font-code text-xs text-muted-foreground">ledgerHash {preview.ledgerHash.slice(0, 16)}…</p>

              {preview.blockers.length > 0 && (
                <ul className="space-y-2 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" data-testid="settle-blockers">
                  {preview.blockers.map((blocker) => (
                    <li key={blocker.step} className="flex items-start gap-2">
                      <CheckStatusChip status="FAIL" />
                      <span>
                        <strong>{blocker.step}</strong> — {blocker.evidencia}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {preview.draft && (
                <EntryDraftPreview
                  draft={preview.draft}
                  title={preview.dryRun ? "Asiento propuesto (vista previa)" : "Asiento contabilizado"}
                  testId="settle-draft"
                />
              )}

              {!preview.dryRun && preview.entryId && (
                <p className="text-sm">
                  Liquidación contabilizada como asiento nº <span className="font-code">{preview.entryNumber}</span>.{" "}
                  <Link href={`/ledger/${preview.entryId}`} className="underline underline-offset-4" data-testid="settle-entry-link">
                    Ver el asiento
                  </Link>
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => run(true)} disabled={pending} data-testid="settle-dry-run">
              {pending ? "Calculando…" : "Vista previa"}
            </Button>
            <Button
              type="button"
              onClick={() => run(false)}
              disabled={pending || preview === null || !preview.dryRun || bloqueada}
              data-testid="settle-confirm"
            >
              Liquidar y contabilizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Figure({ label, cents, testId }: { label: string; cents: number; testId: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-xl" data-testid={testId}>
        <Amount cents={cents} />
      </p>
    </div>
  )
}
