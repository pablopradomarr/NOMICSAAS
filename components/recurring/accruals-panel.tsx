"use client"

import { setAccrualStatusAction } from "@/app/(app)/ledger/recurring/actions"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { AccrualView } from "@/components/recurring/types"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — Pestaña **Periodificaciones** de `/ledger/recurring` (§7).
 *
 * Cada `Accrual` vivo con su cuadro periodo a periodo, su pendiente y el
 * **WARN de 567/568** (O-25): repartir por días un interés cuyo principal
 * decrece desvía el devengo, y el aviso lo dice con su desviación estimada en
 * vez de esconderlo.
 *
 * El cuadro llega **ya derivado del servidor** (`lib/closing/accrual.ts` dentro
 * del Server Component): la pantalla no calcula ni una cuota, sólo la pinta con
 * su pendiente y sus avisos.
 */
export function AccrualsPanel({ accruals, canEdit }: { accruals: AccrualView[]; canEdit: boolean }) {
  const [openCode, setOpenCode] = useState<string | null>(null)

  if (accruals.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="accruals-empty">
        No hay ninguna periodificación viva. Las periodificaciones nacen del documento (480/485) o del cuadro de un
        préstamo (567/568).
      </p>
    )
  }

  return (
    <div className="space-y-4" data-testid="accruals-panel">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Periodificación</th>
              <th className="px-3 py-2 text-left font-medium">Cuentas</th>
              <th className="px-3 py-2 text-left font-medium">Intervalo</th>
              <th className="px-3 py-2 text-left font-medium">Base</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-right font-medium">Pendiente</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-right font-medium">Cuadro</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {accruals.map((accrual) => (
              <tr key={accrual.id} className="h-8" data-accrual-code={accrual.code}>
                <td className="px-3 py-1">
                  <span className="font-code text-xs">{accrual.code}</span> {accrual.name ?? ""}
                </td>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                  {accrual.accrualAccountCode} / {accrual.pnlAccountCode}
                </td>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                  {accrual.periodStart} – {accrual.periodEnd}
                </td>
                <td className="px-3 py-1 text-xs">{accrual.basis}</td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={accrual.totalCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={accrual.pendingCents} />
                </td>
                <td className="px-3 py-1 text-xs">{accrual.status}</td>
                <td className="px-3 py-1 text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`open-accrual-${accrual.code}`}
                      onClick={() => setOpenCode(openCode === accrual.code ? null : accrual.code)}
                    >
                      {openCode === accrual.code ? "Ocultar" : "Ver cuadro"}
                    </Button>
                    {canEdit && <AccrualStatusDialog accrual={accrual} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {accruals
        .filter((accrual) => accrual.code === openCode)
        .map((accrual) => (
          <AccrualSchedule key={accrual.id} accrual={accrual} />
        ))}
    </div>
  )
}

function AccrualSchedule({ accrual }: { accrual: AccrualView }) {
  const rows = accrual.rows
  return (
    <div className="space-y-3 rounded-md border p-4" data-testid={`accrual-schedule-${accrual.code}`}>
      <h3 className="text-sm font-medium">
        Cuadro de devengo de <span className="font-code">{accrual.code}</span>
      </h3>
      {accrual.warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" data-testid="accrual-warnings">
          {accrual.warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      )}
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Periodo</th>
              <th className="px-3 py-2 text-left font-medium">Desde</th>
              <th className="px-3 py-2 text-left font-medium">Hasta</th>
              <th className="px-3 py-2 text-right font-medium">Días</th>
              <th className="px-3 py-2 text-right font-medium">Cuota</th>
              <th className="px-3 py-2 text-right font-medium">Pendiente</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.period} className="h-8">
                <td className="px-3 py-1 font-code text-xs">{row.period}</td>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{row.from}</td>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{row.to}</td>
                <td className="px-3 py-1 text-right tabular-nums">{row.days}</td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.quotaCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.pendingCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        La última fila deja el pendiente en <strong>0,00 €</strong> exactos: el residuo del reparto se lleva ahí y no
        se distribuye entre periodos.
      </p>
    </div>
  )
}

function AccrualStatusDialog({ accrual }: { accrual: AccrualView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [status, setStatus] = useState<"VIVA" | "AGOTADA" | "CANCELADA">("CANCELADA")
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state = await setAccrualStatusAction({ id: accrual.id, status, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido cambiar el estado")
        return
      }
      toast.success(`La periodificación ${accrual.code} queda ${status.toLowerCase()}`)
      setOpen(false)
      setReason("")
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`open-accrual-status-${accrual.code}`}>
        Estado
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Estado de la periodificación {accrual.code}</DialogTitle>
            <DialogDescription>
              Cancelar una periodificación devenga el pendiente en el periodo de la cancelación (R-PE-4). El motivo
              queda escrito.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="accrual-status">Nuevo estado</Label>
              <select
                id="accrual-status"
                data-testid="accrual-status"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="VIVA">Viva</option>
                <option value="AGOTADA">Agotada</option>
                <option value="CANCELADA">Cancelada</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="accrual-reason">Motivo (mínimo 10 caracteres)</Label>
              <Textarea
                id="accrual-reason"
                data-testid="accrual-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10} data-testid="accrual-status-submit">
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
