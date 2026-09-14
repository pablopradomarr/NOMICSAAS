"use client"

import {
  generateOccurrencesAction,
  type GenerateOccurrencesResult,
  type RecurringRuleSummary,
} from "@/app/(app)/ledger/recurring/actions"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — «Generar pendientes hasta [periodo]» con **vista previa del lote**
 * (**EDITOR**, §7).
 *
 * La vista previa y el botón recorren el **mismo código** en el servidor
 * (`dryRun`, §5.2): lo único que cambia es que la simulación no abre transacción
 * de escritura. Por eso el resultado se enseña con la misma tabla en los dos
 * casos —regla, periodo, estado, motivo e importe—, y tras postear cada fila
 * generada trae el enlace a su asiento.
 */
export function GeneratePanel({ rules, refDate }: { rules: RecurringRuleSummary[]; refDate: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [upToPeriod, setUpToPeriod] = useState(refDate.slice(0, 7))
  const [ruleId, setRuleId] = useState("")
  const [preview, setPreview] = useState<GenerateOccurrencesResult | null>(null)

  const run = (dryRun: boolean): void => {
    start(async () => {
      const state = await generateOccurrencesAction({
        upToPeriod: upToPeriod.trim(),
        recurringEntryId: ruleId === "" ? null : ruleId,
        dryRun,
      })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "No se ha podido generar el lote")
        return
      }
      setPreview(state.data)
      if (!dryRun) {
        toast.success(`${state.data.generated} ocurrencia(s) generadas hasta ${state.data.upToPeriod}`)
        router.refresh()
      }
    })
  }

  const totalPendientes = rules.reduce((acc, rule) => acc + rule.pendingPeriods.length, 0)

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="open-generate">
        Generar pendientes{totalPendientes > 0 ? ` (${totalPendientes})` : ""}
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
            <DialogTitle>Generar ocurrencias pendientes</DialogTitle>
            <DialogDescription>
              Se generan los periodos <strong>ya vencidos</strong> a fecha {refDate} y no generados todavía. La
              vista previa usa el mismo código que la generación real: lo único que cambia es que no escribe.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="generate-up-to">Hasta el periodo</Label>
              <Input
                id="generate-up-to"
                data-testid="generate-up-to"
                value={upToPeriod}
                onChange={(event) => setUpToPeriod(event.target.value)}
                placeholder="2026-06"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="generate-rule">Regla</Label>
              <select
                id="generate-rule"
                data-testid="generate-rule"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={ruleId}
                onChange={(event) => setRuleId(event.target.value)}
              >
                <option value="">Todas las reglas activas</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.code} · {rule.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {preview && (
            <div className="space-y-2">
              <p className="text-sm" data-testid="generate-summary">
                {preview.dryRun ? "Vista previa" : "Resultado"} hasta{" "}
                <span className="font-code">{preview.upToPeriod}</span>: {preview.generated} generada(s) ·{" "}
                {preview.omitted} omitida(s) · {preview.failed} fallida(s)
              </p>
              {preview.occurrences.length === 0 ? (
                <p className="rounded-md border p-3 text-sm text-muted-foreground">
                  No hay ningún periodo vencido pendiente de generar.
                </p>
              ) : (
                <div className="max-h-72 overflow-auto rounded-md border">
                  <table className="w-full text-sm" data-testid="generate-preview">
                    <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Regla</th>
                        <th className="px-3 py-2 text-left font-medium">Periodo</th>
                        <th className="px-3 py-2 text-left font-medium">Estado</th>
                        <th className="px-3 py-2 text-right font-medium">Importe</th>
                        <th className="px-3 py-2 text-left font-medium">Motivo / asiento</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {preview.occurrences.map((occurrence) => (
                        <tr key={`${occurrence.ruleCode}-${occurrence.period}`} className="h-8">
                          <td className="px-3 py-1 font-code text-xs">{occurrence.ruleCode}</td>
                          <td className="px-3 py-1 font-code text-xs">{occurrence.period}</td>
                          <td className="px-3 py-1 text-xs">{occurrence.status}</td>
                          <td className="px-3 py-1 text-right">
                            {occurrence.amountCents === null ? "—" : <Amount cents={occurrence.amountCents} />}
                          </td>
                          <td className="px-3 py-1 text-xs text-muted-foreground">
                            {occurrence.entryId ? (
                              <Link href={`/ledger/${occurrence.entryId}`} className="underline underline-offset-4">
                                asiento nº {occurrence.entryNumber}
                              </Link>
                            ) : (
                              (occurrence.reason ?? "—")
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => run(true)} disabled={pending} data-testid="generate-dry-run">
              {pending ? "Calculando…" : "Vista previa"}
            </Button>
            <Button
              type="button"
              onClick={() => run(false)}
              disabled={pending || preview === null || !preview.dryRun}
              data-testid="generate-confirm"
            >
              Generar y contabilizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
