"use client"

import { proposePayrollReclassAction, reclassifyLinesAction } from "@/app/(app)/analytics/actions"
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
import { Textarea } from "@/components/ui/textarea"
import type { ProposePayrollReclassResult } from "@/lib/time/payroll-reclass"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E10 · §3.7 camino (b) · **DEBE 6 de la revisión de la ronda 1** — «Proponer
 * reclasificación de nómina por horas».
 *
 * `proposePayrollReclass` era un motor de 250 líneas **sin ningún consumidor**:
 * el camino (b) no se podía recorrer desde el producto. Esta es su salida
 * mínima, y deliberadamente mínima:
 *
 *  1. **Proponer** (cualquier rol de lectura): qué líneas 64x del periodo son
 *     atribuibles **al 100 %** a un proyecto según las horas aprobadas. La
 *     concentración exigida es 10 000 bps **fija** (O-E10-22): con 8 000, una
 *     línea de 300 000 c de la que el proyecto consumió el 80 % se reasignaría
 *     ENTERA y el MC2 del proyecto se llevaría 60 000 c que no son suyos.
 *  2. **Confirmar** (sólo `ADMIN`, con motivo): delega en `reclassifyLines`
 *     (ADR-0010) sin tocarlo. No se crea ningún asiento: sólo cambian las
 *     cuatro columnas analíticas de la línea, y R-A3 la convierte en
 *     `COSTE_DIRECTO_MC2`.
 *
 * **El matiz, en pantalla y no en un comentario**: el coste baja de MC3 a MC2,
 * así que la reclasificación **mueve MC2 y MC3 de periodos ya informados**. Lo
 * acota la ventana temporal de ADR-0010, que resuelve el servidor: mes abierto
 * ⇒ `EDITOR`; mes bloqueado del ejercicio abierto ⇒ sólo `ADMIN`, con motivo;
 * ejercicio `CLOSED` ⇒ nunca, sin excepción de rol.
 */
export function PayrollReclassDialog({
  from,
  to,
  isAdmin,
  projectCode,
}: {
  from: string
  to: string
  isAdmin: boolean
  projectCode?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ProposePayrollReclassResult | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const proposals = (result?.proposals ?? []).filter((p) => !projectCode || p.toProjectCode === projectCode)
  const notAttributable = result?.notAttributable ?? []

  const propose = (): void => {
    setError(null)
    setDone(null)
    startTransition(async () => {
      const state = await proposePayrollReclassAction({ from, to })
      if (!state.success) {
        setError(state.error ?? "No se ha podido componer la propuesta")
        return
      }
      setResult(state.data ?? { proposals: [], notAttributable: [] })
    })
  }

  const apply = (): void => {
    setError(null)
    startTransition(async () => {
      const state = await reclassifyLinesAction({
        reason,
        targets: proposals.map((p) => ({
          lineId: p.lineId,
          projectId: p.toProjectId,
          costCenterId: null,
          // R-A3 lo deriva; se manda explícito para que el diff del `AuditLog`
          // diga qué se pidió, no sólo qué quedó.
          analyticType: "COSTE_DIRECTO_MC2",
        })),
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido aplicar la reclasificación")
        return
      }
      setDone(`${proposals.length} línea(s) reclasificadas`)
      setResult(null)
      setReason("")
      router.refresh()
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setResult(null)
          setError(null)
          setDone(null)
          setReason("")
        }
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Proponer reclasificación de nómina por horas
      </Button>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reclasificación de nómina por horas</DialogTitle>
          <DialogDescription>
            Líneas de nómina (640, 642, 645, 649) de {from} a {to} atribuibles <strong>al 100 %</strong> a un
            proyecto según las horas aprobadas y productivas del periodo. Una línea repartida entre varios
            proyectos no se reclasifica: ése es el reparto por driver <code>HORAS</code>, no este camino.
          </DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Aplicarla <strong>no crea ningún asiento</strong>: cambia el destino analítico de la línea y R-A3 la
          convierte en coste directo, así que el importe baja de MC3 a MC2 —<strong>y mueve MC2 y MC3 de
          periodos ya informados</strong>—. Ejercicio cerrado: nunca. Mes bloqueado: sólo ADMIN, con motivo.
        </p>

        {result === null ? (
          <Button onClick={propose} disabled={pending} size="sm">
            {pending ? "Calculando…" : "Calcular propuesta"}
          </Button>
        ) : (
          <div className="space-y-3">
            {proposals.length === 0 ? (
              <p className="text-sm">
                Ninguna línea de nómina del periodo es atribuible al 100 % a un proyecto.
                {notAttributable.length > 0 ? ` ${notAttributable.length} línea(s) revisadas y descartadas.` : ""}
              </p>
            ) : (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2 text-left">Asiento</th>
                      <th className="p-2 text-left">Cuenta</th>
                      <th className="p-2 text-left">De</th>
                      <th className="p-2 text-left">A</th>
                      <th className="p-2 text-right">Minutos</th>
                      <th className="p-2 text-right">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposals.map((p) => (
                      <tr key={p.lineId} className="border-t">
                        <td className="p-2">
                          {p.entryNumber}.{p.lineNo}
                        </td>
                        <td className="p-2">{p.accountCode}</td>
                        <td className="p-2">{p.fromCostCenterCode ?? "—"}</td>
                        <td className="p-2">{p.toProjectCode}</td>
                        <td className="p-2 text-right">
                          {p.minutes} / {p.totalMinutes}
                        </td>
                        <td className="p-2 text-right">
                          <AmountPlain cents={p.amountCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {proposals.length > 0 && isAdmin ? (
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Motivo de la reclasificación (mínimo 10 caracteres)"
                rows={2}
              />
            ) : null}
            {proposals.length > 0 && !isAdmin ? (
              <p className="text-xs text-muted-foreground">
                Aplicarla es un acto de un ADMIN: la propuesta se puede leer y exportar, no confirmar.
              </p>
            ) : null}
          </div>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {done ? <p className="text-sm text-emerald-600">{done}</p> : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cerrar
          </Button>
          <Button
            size="sm"
            onClick={apply}
            disabled={pending || !isAdmin || proposals.length === 0 || reason.trim().length < 10}
          >
            Confirmar y reclasificar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
