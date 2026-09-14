"use client"

import { lockPeriodAction, unlockPeriodAction, type FiscalYearGrid, type PeriodCell } from "@/app/(app)/settings/periods/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fechaHoraUtc } from "@/lib/dates-ui"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

/**
 * E9 · T18 — Rejilla **ejercicio × mes** de `/settings/periods` (§7, §5.3).
 *
 * Cada celda dice tres cosas distintas y no una: si el **mes** está bloqueado,
 * en qué **periodo de IVA** cae y si ese periodo está **liquidado**. Son
 * barreras separadas a propósito: el `iva_period` no coincide con la fecha del
 * asiento —una factura de junio recibida en octubre entra en el periodo de
 * octubre— y `PeriodLock` no lo ve.
 *
 * Desbloquear es **ADMIN con motivo** y arrastra los meses posteriores (B-3);
 * si el periodo de IVA está liquidado, la acción rechaza y dice cuál es la
 * salida (revertir la liquidación), no un «no se puede» (B-8).
 */
export function PeriodsGrid({ years, isAdmin }: { years: FiscalYearGrid[]; isAdmin: boolean }) {
  if (years.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="periods-empty">
        Todavía no hay ningún ejercicio abierto. Los ejercicios se crean en «Ejercicios».
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {years.map((year) => (
        <FiscalYearRow key={year.fiscalYearId} year={year} isAdmin={isAdmin} />
      ))}
      <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground" data-testid="periods-legend">
        <li>
          <span className="mr-1 inline-block h-3 w-3 rounded bg-[#0A0A0A] align-middle" /> mes bloqueado
        </li>
        <li>
          <span className="mr-1 inline-block h-3 w-3 rounded border border-[#F5A623] bg-[#F5A623]/20 align-middle" />{" "}
          periodo de IVA liquidado
        </li>
        <li>
          <span className="mr-1 inline-block h-3 w-3 rounded bg-muted align-middle" /> abierto
        </li>
      </ul>
    </div>
  )
}

function FiscalYearRow({ year, isAdmin }: { year: FiscalYearGrid; isAdmin: boolean }) {
  const [target, setTarget] = useState<{ cell: PeriodCell; action: "lock" | "unlock" } | null>(null)

  return (
    <section className="space-y-2 rounded-md border p-4" data-testid={`fiscal-year-${year.code}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          Ejercicio <span className="font-code">{year.code}</span>{" "}
          <span className="text-muted-foreground">
            ({year.startDate} – {year.endDate})
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Estado contable <strong>{year.status}</strong> · cuentas <strong>{year.accountsApprovalStatus}</strong> ·
          situación fiscal <strong>{year.taxFilingStatus}</strong>
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Mes</th>
              <th className="px-2 py-2 text-left font-medium">Bloqueo</th>
              <th className="px-2 py-2 text-left font-medium">Periodo de IVA</th>
              <th className="px-2 py-2 text-left font-medium">IVA liquidado</th>
              <th className="px-2 py-2 text-left font-medium">Bloqueado el</th>
              <th className="px-2 py-2 text-left font-medium">Motivo</th>
              {isAdmin && <th className="px-2 py-2 text-right font-medium">Acción</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {year.months.map((cell) => (
              <tr key={cell.month} className="h-8" data-month={cell.month} data-locked={cell.locked ? "1" : "0"}>
                <td className="px-2 py-1">{MES[cell.month - 1]}</td>
                <td className="px-2 py-1">
                  <span
                    data-testid={`lock-state-${year.code}-${cell.month}`}
                    className={cn(
                      "inline-flex items-center rounded px-1.5 py-0.5 text-[11px]",
                      cell.locked ? "bg-[#0A0A0A] text-white" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {cell.locked ? "bloqueado" : "abierto"}
                  </span>
                </td>
                <td className="px-2 py-1 font-code text-xs">
                  {cell.ivaPeriod} <span className="text-muted-foreground">({cell.ivaPeriodKind.toLowerCase()})</span>
                </td>
                <td className="px-2 py-1">
                  <span
                    className={cn(
                      "inline-flex items-center rounded px-1.5 py-0.5 text-[11px]",
                      cell.ivaSettled
                        ? "border border-[#F5A623] bg-[#F5A623]/20 text-[#1A202C]"
                        : "text-muted-foreground"
                    )}
                  >
                    {cell.ivaSettled ? "liquidado" : "no liquidado"}
                  </span>
                </td>
                <td className="px-2 py-1 font-code text-xs text-muted-foreground">
                  {cell.lockedAt ? fechaHoraUtc(cell.lockedAt) : "—"}
                </td>
                <td className="px-2 py-1 text-xs text-muted-foreground">{cell.reason ?? "—"}</td>
                {isAdmin && (
                  <td className="px-2 py-1 text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`toggle-lock-${year.code}-${cell.month}`}
                      onClick={() => setTarget({ cell, action: cell.locked ? "unlock" : "lock" })}
                    >
                      {cell.locked ? "Desbloquear" : "Bloquear"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {target && (
        <LockDialog
          fiscalYearId={year.fiscalYearId}
          cell={target.cell}
          action={target.action}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  )
}

function LockDialog({
  fiscalYearId,
  cell,
  action,
  onClose,
}: {
  fiscalYearId: string
  cell: PeriodCell
  action: "lock" | "unlock"
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [reason, setReason] = useState("")

  const submit = (): void => {
    start(async () => {
      const state =
        action === "lock"
          ? await lockPeriodAction({ fiscalYearId, month: cell.month, reason: reason.trim() || null })
          : await unlockPeriodAction({ fiscalYearId, month: cell.month, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido cambiar el bloqueo")
        return
      }
      toast.success(action === "lock" ? `Mes ${cell.month} bloqueado` : `Mes ${cell.month} desbloqueado`)
      onClose()
      router.refresh()
    })
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === "lock" ? "Bloquear" : "Desbloquear"} el mes {MES[cell.month - 1]}
          </DialogTitle>
          <DialogDescription>
            {action === "lock" ? (
              <>
                Bloquear impide fechar asientos nuevos en el mes. Lo que llegue tarde se contabiliza en el primer mes
                abierto, con su coletilla.
              </>
            ) : (
              <>
                Desbloquear <strong>arrastra los meses posteriores</strong> (B-3) y por eso el motivo es obligatorio.
                {cell.ivaSettled && (
                  <>
                    {" "}
                    El periodo de IVA <span className="font-code">{cell.ivaPeriod}</span> está{" "}
                    <strong>liquidado</strong>: hay que revertir antes la liquidación con su motivo (B-8).
                  </>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="lock-reason">
            Motivo {action === "unlock" ? "(mínimo 10 caracteres)" : "(opcional)"}
          </Label>
          <Textarea
            id="lock-reason"
            data-testid="lock-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={pending || (action === "unlock" && reason.trim().length < 10)}
            data-testid="lock-submit"
          >
            {pending ? "Guardando…" : action === "lock" ? "Bloquear" : "Desbloquear"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
