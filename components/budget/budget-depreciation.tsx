"use client"

/**
 * E10 · T15 / Q-4 — «**Precargar amortización**».
 *
 * Trae la dotación presupuestada de los activos **ya en alta**, mes a mes, con
 * su dimensión analítica y sus términos (base, método, vida útil restante), y
 * **no escribe nada** hasta que alguien la acepta: es propuesta, igual que la
 * tarifa derivada de la nómina. Un activo sin destino analítico no se coloca a
 * ojo: se omite diciéndolo.
 */

import {
  applyDepreciationProposalAction,
  proposeDepreciationAction,
} from "@/app/(app)/analytics/budget/ui-actions"
import { AmountPlain } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DepreciationBudgetProposal } from "@/models/budget"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

export function DepreciationProposalDialog({
  budgetId,
  fiscalYearId,
  canEdit,
}: {
  budgetId: string
  fiscalYearId: string
  canEdit: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [proposal, setProposal] = useState<DepreciationBudgetProposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!canEdit) return null

  const load = () =>
    start(async () => {
      setError(null)
      setDone(null)
      const state = await proposeDepreciationAction(fiscalYearId)
      if (!state.success) {
        setError(state.error ?? "No se ha podido componer la propuesta")
        return
      }
      setProposal(state.data ?? null)
    })

  const apply = () =>
    start(async () => {
      setError(null)
      const state = await applyDepreciationProposalAction({ budgetId, fiscalYearId })
      if (!state.success) {
        setError(state.error ?? "No se ha podido escribir la propuesta")
        return
      }
      setDone(`Escritas ${state.data?.written ?? 0} celdas de amortización presupuestada.`)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true)
          load()
        }}
        data-testid="propose-depreciation"
      >
        Precargar amortización
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Amortización presupuestada de los activos en alta</DialogTitle>
            <DialogDescription>
              Propuesta de las líneas <span className="font-code">68x</span> del ejercicio, con la dotación lineal de
              cada activo y sus términos. <strong>No se escribe nada</strong> hasta que la aceptas; y cuando la aceptas
              pasa por la misma validación de signo y el mismo registro que el tecleo manual.
            </DialogDescription>
          </DialogHeader>

          {!proposal && !error && <p className="text-sm text-muted-foreground">Componiendo la propuesta…</p>}

          {proposal && (
            <div className="space-y-3">
              <p className="text-sm">
                <strong>{proposal.lines.length}</strong> líneas propuestas por un total de{" "}
                <span className="font-code">
                  <AmountPlain cents={proposal.totalCents} />
                </span>
                .
              </p>
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full border-collapse text-xs" data-testid="depreciation-lines">
                  <thead className="bg-muted/40">
                    <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:text-left">
                      <th>Mes</th>
                      <th>Activo</th>
                      <th>Cuenta</th>
                      <th>Destino</th>
                      <th className="text-right">Importe</th>
                      <th>Términos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.lines.map((line, index) => (
                      <tr key={`${line.assetId}-${line.month}-${index}`} className="border-t [&>td]:px-2 [&>td]:py-1">
                        <td className="font-code">{line.month.slice(0, 7)}</td>
                        <td className="font-code">{line.assetCode}</td>
                        <td className="font-code">{line.accountCode}</td>
                        <td>{line.projectId ? "proyecto" : line.costCenterId ? "centro de coste" : "sin destino"}</td>
                        <td className="text-right font-code">
                          <AmountPlain cents={line.amountCents} />
                        </td>
                        <td className="text-muted-foreground">
                          base <AmountPlain cents={line.terms.baseCents} /> · {line.terms.method} ·{" "}
                          {line.terms.remainingMonths} meses · alta {line.terms.inServiceDate}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {proposal.skipped.length > 0 && (
                <ul className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs" data-testid="depreciation-skipped">
                  {proposal.skipped.map((item, index) => (
                    <li key={index}>
                      <span className="font-code">{item.assetCode}</span>: {item.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}
          {done && (
            <p className="rounded-md border px-3 py-2 text-sm" role="status" data-testid="depreciation-done">
              {done}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cerrar
            </Button>
            <Button
              onClick={apply}
              disabled={pending || proposal === null || proposal.lines.length === 0}
              data-testid="apply-depreciation"
            >
              {pending ? "Escribiendo…" : "Aceptar y escribir en el borrador"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
