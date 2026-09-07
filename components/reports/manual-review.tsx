"use client"

import { clearReviewAction, forceReviewAction } from "@/app/(app)/reports/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E6 · T17 — Revisión manual de un periodo (**ADMIN**).
 *
 * «Forzar revisión» escribe un `ManualReviewFlag`: a partir de ahí, todo
 * informe que solape el periodo sale sellado `REQUIERE REVISIÓN` con motivo
 * `REVISION_FORZADA`. «Levantar» no borra el aviso —lo marca como levantado con
 * autor y motivo—, y el siguiente run vuelve a `VALIDADO AUTOMÁTICAMENTE`.
 *
 * El motivo es obligatorio (mínimo diez caracteres) en las dos direcciones: un
 * sello sin motivo no le dice nada a quien tiene que revisar. La UI oculta los
 * botones a quien no es ADMIN y la acción lo vuelve a exigir — ocultar no es
 * proteger.
 */

const REPORT_SCOPES = [
  { value: "", label: "Todos los informes del periodo" },
  { value: "BALANCE", label: "Sólo el balance" },
  { value: "PYG", label: "Sólo la cuenta de pérdidas y ganancias" },
  // E7 · ADR-0015 D4: el método del cashflow es un parámetro, no un tipo, así
  // que la revisión se fuerza sobre EL cashflow (los dos métodos son la misma
  // lectura del mismo diario y no tiene sentido revisar sólo uno).
  { value: "CASHFLOW", label: "Sólo el cashflow" },
  { value: "DASHBOARD", label: "Sólo el panel" },
] as const

export function ForceReviewDialog({
  defaultPeriodStart,
  defaultPeriodEnd,
}: {
  defaultPeriodStart: string
  defaultPeriodEnd: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [periodStart, setPeriodStart] = useState(defaultPeriodStart)
  const [periodEnd, setPeriodEnd] = useState(defaultPeriodEnd)
  const [scope, setScope] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await forceReviewAction({
        periodStart,
        periodEnd,
        scope: scope === "" ? null : scope,
        reason,
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido forzar la revisión")
        return
      }
      setOpen(false)
      setReason("")
      router.refresh()
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="force-review">
          Forzar revisión
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Forzar la revisión de un periodo</DialogTitle>
          <DialogDescription>
            Los informes que solapen este periodo se sellarán <strong>REQUIERE REVISIÓN</strong> con el motivo que
            escribas, hasta que un administrador lo levante.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Desde</span>
              <Input
                aria-label="Periodo desde"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Hasta</span>
              <Input
                aria-label="Periodo hasta"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Alcance</span>
            <select
              aria-label="Alcance"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {REPORT_SCOPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Motivo (mínimo 10 caracteres)</span>
            <Input
              aria-label="Motivo"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Pendiente de conciliar el extracto bancario de diciembre"
            />
          </label>
          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10}>
            {pending ? "Guardando…" : "Forzar revisión"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ClearReviewDialog({ flagId, periodLabel }: { flagId: string; periodLabel: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await clearReviewAction({ id: flagId, reason })
      if (!state.success) {
        setError(state.error ?? "No se ha podido levantar el aviso")
        return
      }
      setOpen(false)
      setReason("")
      router.refresh()
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="clear-review">
          Levantar
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Levantar la revisión de {periodLabel}</DialogTitle>
          <DialogDescription>
            El aviso no se borra: queda registrado como levantado, con tu nombre y tu motivo. El siguiente informe del
            periodo se emitirá de nuevo con el sello que le corresponda por sus propios checks.
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Motivo (mínimo 10 caracteres)</span>
          <Input
            aria-label="Motivo del levantamiento"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Extracto conciliado y diferencias corregidas"
          />
        </label>
        {error && (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10}>
            {pending ? "Guardando…" : "Levantar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
