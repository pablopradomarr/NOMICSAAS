"use client"

import { postLoanAction, type PostLoanResult } from "@/app/(app)/settings/debt/actions"
import { EntryDraftPreview } from "@/components/assets/entry-draft-preview"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T18 — Alta del préstamo por **T-37** (**ADMIN**, O-6).
 *
 * El asiento nace ya **desglosado**: una línea de `170`/`520` **por
 * vencimiento**, de modo que la reclasificación del cierre tenga de dónde leer
 * el corte de los doce meses sin adivinar nada.
 *
 * La vista previa usa el **mismo código** que el alta real (`dryRun`), así que
 * lo que se enseña es literalmente el asiento que se va a postear.
 */
export function PostLoanDialog({ debtScheduleId, code }: { debtScheduleId: string; code: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [entryDate, setEntryDate] = useState("")
  const [cashAccountCode, setCashAccountCode] = useState("572")
  const [result, setResult] = useState<PostLoanResult | null>(null)

  const run = (dryRun: boolean): void => {
    start(async () => {
      const state = await postLoanAction({ debtScheduleId, entryDate, cashAccountCode, dryRun })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "No se ha podido contabilizar el alta del préstamo")
        return
      }
      setResult(state.data)
      if (!dryRun) {
        toast.success(`Alta del préstamo ${code} contabilizada`)
        router.refresh()
      }
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`open-post-loan-${code}`}>
        Contabilizar alta
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setResult(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Alta del préstamo {code} (T-37)</DialogTitle>
            <DialogDescription>
              Se postea una línea de deuda por cada vencimiento del cuadro, con su fecha. Es lo que permite presentar
              la parte corriente y la no corriente sin compensar saldos (art. 35.6 CCom).
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="loan-date">Fecha del asiento</Label>
              <Input
                id="loan-date"
                type="date"
                value={entryDate}
                onChange={(event) => setEntryDate(event.target.value)}
                data-testid="loan-date"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="loan-cash">Cuenta de tesorería</Label>
              <Input
                id="loan-cash"
                value={cashAccountCode}
                onChange={(event) => setCashAccountCode(event.target.value)}
                data-testid="loan-cash"
              />
            </div>
          </div>

          {result && (
            <div className="space-y-2">
              {!result.dryRun && result.entryId && (
                <p className="text-sm">
                  Contabilizado como asiento nº <span className="font-code">{result.entryNumber}</span>.{" "}
                  <Link href={`/ledger/${result.entryId}`} className="underline underline-offset-4" data-testid="loan-entry-link">
                    Ver el asiento
                  </Link>
                </p>
              )}
              <EntryDraftPreview
                draft={result.draft}
                title={result.dryRun ? "Asiento propuesto (vista previa)" : "Asiento contabilizado"}
                testId="loan-draft"
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => run(true)} disabled={pending || entryDate === ""} data-testid="loan-dry-run">
              Vista previa
            </Button>
            <Button
              type="button"
              onClick={() => run(false)}
              disabled={pending || result === null || !result.dryRun}
              data-testid="loan-confirm"
            >
              Contabilizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
