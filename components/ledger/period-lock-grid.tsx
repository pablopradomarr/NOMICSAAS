"use client"

import {
  closeFiscalYearAction,
  lockPeriodAction,
  unlockPeriodAction,
} from "@/app/(app)/settings/fiscal-years/actions"
import { formatLocalDate } from "@/components/ledger/amount"
import type { FiscalYearView } from "@/components/ledger/types"
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
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T12 — Ejercicio contable: rejilla de 12 meses y cierre (diseño §6).
 *
 * Reglas del experto contable, que la pantalla ENSEÑA y el servidor IMPONE:
 * - **B-2**: los meses se bloquean en orden; sólo se ofrece el siguiente abierto.
 * - **B-3**: desbloquear el mes *n* arrastra los posteriores *n+1…12*.
 * - **B-4**: cerrar el ejercicio exige los 12 meses bloqueados.
 * - Decisión 4 de §9.2: **no hay reapertura**. Cerrar es definitivo.
 */

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
]

export function PeriodLockGrid({ fiscalYear, canManage }: { fiscalYear: FiscalYearView; canManage: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ kind: "lock" | "unlock" | "close"; month?: number } | null>(null)
  const [reason, setReason] = useState("")

  const locked = new Set(fiscalYear.lockedMonths)
  const closed = fiscalYear.status === "CLOSED"
  // B-2: el único mes bloqueable es el primero que sigue abierto.
  const nextLockable = closed ? null : (MONTHS.findIndex((_, index) => !locked.has(index + 1)) + 1 || null)
  const allLocked = fiscalYear.lockedMonths.length === 12

  const run = () =>
    startTransition(async () => {
      setError(null)
      if (!dialog) return
      const state =
        dialog.kind === "close"
          ? await closeFiscalYearAction({ fiscalYearId: fiscalYear.id, reason: reason.trim() })
          : dialog.kind === "lock"
            ? await lockPeriodAction({ fiscalYearId: fiscalYear.id, month: dialog.month ?? 0, reason: reason.trim() })
            : await unlockPeriodAction({ fiscalYearId: fiscalYear.id, month: dialog.month ?? 0, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido completar la operación")
        return
      }
      setDialog(null)
      setReason("")
      router.refresh()
    })

  return (
    <section className="space-y-3 rounded-md border p-4" data-testid="fiscal-year" data-fiscal-year-code={fiscalYear.code}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            Ejercicio <span className="font-code">{fiscalYear.code}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            {formatLocalDate(fiscalYear.startDate)} – {formatLocalDate(fiscalYear.endDate)} ·{" "}
            {fiscalYear.entryCount ?? fiscalYear.lastEntryNumber} asiento(s) · último nº{" "}
            <span className="font-code">{fiscalYear.lastEntryNumber}</span>
          </p>
        </div>
        <span
          data-fy-status={fiscalYear.status}
          className={cn(
            "rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
            closed ? "border border-[#F5A623] bg-[#F5A623]/15" : "bg-[#0A0A0A] text-white"
          )}
        >
          {closed ? "Cerrado" : "Abierto"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
        {MONTHS.map((name, index) => {
          const month = index + 1
          const isLocked = locked.has(month)
          const canLock = canManage && !closed && nextLockable === month
          const canUnlock = canManage && !closed && isLocked
          return (
            <div
              key={month}
              data-month={month}
              data-locked={isLocked ? "1" : "0"}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md border p-2 text-center text-xs",
                isLocked ? "bg-muted/60 text-muted-foreground" : "bg-background"
              )}
            >
              <span className="font-medium">{name.slice(0, 3)}</span>
              <span aria-hidden>{isLocked ? "🔒" : "—"}</span>
              {canLock && (
                <button
                  type="button"
                  className="text-[11px] underline underline-offset-2"
                  onClick={() => setDialog({ kind: "lock", month })}
                  aria-label={`Bloquear ${name} de ${fiscalYear.code}`}
                >
                  Bloquear
                </button>
              )}
              {canUnlock && (
                <button
                  type="button"
                  className="text-[11px] underline underline-offset-2"
                  onClick={() => setDialog({ kind: "unlock", month })}
                  aria-label={`Desbloquear ${name} de ${fiscalYear.code}`}
                >
                  Desbloquear
                </button>
              )}
            </div>
          )
        })}
      </div>

      {canManage && !closed && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!allLocked}
            onClick={() => setDialog({ kind: "close" })}
            data-testid="close-fiscal-year"
          >
            Cerrar ejercicio
          </Button>
          {!allLocked && (
            <span className="text-xs text-muted-foreground">
              Cerrar el ejercicio exige los 12 meses bloqueados (B-4). Van {fiscalYear.lockedMonths.length}.
            </span>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "close"
                ? `Cerrar el ejercicio ${fiscalYear.code}`
                : dialog?.kind === "lock"
                  ? `Bloquear ${MONTHS[(dialog.month ?? 1) - 1]} de ${fiscalYear.code}`
                  : `Desbloquear ${MONTHS[(dialog?.month ?? 1) - 1]} de ${fiscalYear.code}`}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "close" ? (
                <>
                  <strong>No hay reapertura.</strong> Reabrir un ejercicio cerrado equivale a reformular cuentas ya
                  rendidas, así que no es una operación de usuario: un documento con devengo en ejercicio cerrado se
                  registra con un asiento de ajuste en el ejercicio abierto. La regularización y el cierre contables
                  (T-26/T-27) llegan en E9.
                </>
              ) : dialog?.kind === "unlock" ? (
                <>
                  Desbloquear el mes {dialog.month} <strong>desbloquea también los posteriores</strong> hasta diciembre
                  (B-3). Queda registrado en la auditoría.
                </>
              ) : (
                <>
                  Bloqueado el mes, ningún asiento nuevo podrá fecharse en él: los documentos con devengo anterior se
                  desplazarán al primer mes abierto, con el devengo anotado en el concepto.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Motivo *</span>
            <Textarea
              aria-label="Motivo"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={512}
            />
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialog(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="button" onClick={run} disabled={pending || reason.trim().length < 3}>
              {pending ? "Aplicando…" : "Confirmar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
