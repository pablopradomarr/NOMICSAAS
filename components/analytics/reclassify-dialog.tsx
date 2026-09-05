"use client"

import { reclassifyLinesAction } from "@/app/(app)/analytics/actions"
import { DimensionCombobox, EMPTY_DIMENSION, type DimensionValue } from "@/components/analytics/dimension-combobox"
import { ANALYTIC_TYPE_LABELS, type DimensionOption } from "@/components/analytics/types"
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
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E4 · T15 — Reclasificación analítica de una línea posteada (ADR-0010, §2.6).
 *
 * Cambia SOLO el destino analítico y el tipo efectivo. El asiento contable no
 * se toca: cuenta, importe, fecha, número y contrapartida son inmutables, el
 * `ledgerHash` del periodo NO cambia (E4-D2) y por tanto el balance, la PyG
 * contable, el cashflow y el diario ya sellados siguen vigentes. Lo que sí se
 * rehace es el `entryHash` del asiento, en la misma transacción, para que
 * I-E3-7 siga en PASS.
 *
 * La **ventana** la decide el servidor (`checkReclassify`): EDITOR con el mes
 * abierto, ADMIN con el mes bloqueado del ejercicio abierto, nadie con el
 * ejercicio cerrado. Aquí sólo se enseña lo que responda.
 */

export type ReclassifyLine = {
  id: string
  lineNo: number
  entryNumber: number
  entryDate: string
  accountCode: string
  accountName: string
  amountCents: number
  analyticType: string | null
  projectId: string | null
  costCenterId: string | null
  destinationLabel: string
}

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function ReclassifyDialog({
  lines,
  options,
  canReclassify,
  role,
  label = "Reclasificar analítica",
}: {
  /** Líneas 6/7 del asiento o del proyecto que se pueden reclasificar. */
  lines: readonly ReclassifyLine[]
  options: readonly DimensionOption[]
  canReclassify: boolean
  role: "ADMIN" | "EDITOR" | "VIEWER"
  label?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<string | null>(lines[0]?.id ?? null)
  const [target, setTarget] = useState<DimensionValue>(EMPTY_DIMENSION)
  const [analyticType, setAnalyticType] = useState<string>("")

  if (!canReclassify || lines.length === 0) return null
  const line = lines.find((l) => l.id === selected) ?? null

  const submit = () =>
    startTransition(async () => {
      setError(null)
      setDone(null)
      if (!line) return
      const state = await reclassifyLinesAction({
        reason: reason.trim(),
        targets: [
          {
            lineId: line.id,
            projectId: target.projectId,
            costCenterId: target.costCenterId,
            analyticType: analyticType === "" ? null : analyticType,
          },
        ],
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido reclasificar la línea")
        return
      }
      const hashes = state.data?.entryHashes ?? []
      setDone(
        hashes.length > 0
          ? `Reclasificada. entryHash del asiento: ${hashes[0].before.slice(0, 12)} → ${hashes[0].after.slice(0, 12)}`
          : "Reclasificada."
      )
      setReason("")
      router.refresh()
    })

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="reclassify-open">
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reclasificar analítica</DialogTitle>
            <DialogDescription>
              Cambia el proyecto, el centro de coste y el tipo analítico de una línea de grupo 6 o 7.{" "}
              <strong>El asiento contable no cambia</strong>: ni la cuenta, ni el importe, ni la fecha, ni el número.
              Los informes financieros ya sellados siguen vigentes; sólo caducan la PyG analítica y el presupuesto
              contra real del periodo.
            </DialogDescription>
          </DialogHeader>

          <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="reclassify-window">
            Ventana: con el <strong>mes abierto</strong> puede un EDITOR; con el <strong>mes bloqueado</strong> del
            ejercicio abierto, sólo un ADMIN y con motivo; con el <strong>ejercicio cerrado</strong>, nadie. Tu rol en
            esta organización es <span className="font-code">{role}</span>. La comprueba el servidor y, si se lo salta,
            el trigger de la base.
          </p>

          <div className="grid gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Línea a reclasificar *</span>
              <select
                aria-label="Línea a reclasificar"
                className={SELECT_CLASS}
                value={selected ?? ""}
                onChange={(event) => setSelected(event.target.value)}
                data-testid="reclassify-line"
              >
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    Asiento {l.entryNumber}/{l.lineNo} · {l.accountCode} {l.accountName} · {l.destinationLabel}
                  </option>
                ))}
              </select>
            </label>

            {line && (
              <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
                <dt className="text-muted-foreground">Antes</dt>
                <dd className="font-code">
                  {line.destinationLabel} · {line.analyticType ?? "sin tipo"}
                </dd>
                <dt className="text-muted-foreground">Importe</dt>
                <dd>
                  <AmountPlain cents={line.amountCents} zeroAsDash={false} />
                </dd>
              </dl>
            )}

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Destino nuevo *</span>
              <DimensionCombobox
                options={options}
                value={target}
                onChange={setTarget}
                label="Destino analítico nuevo"
                required
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Tipo analítico (opcional)</span>
              <select
                aria-label="Tipo analítico de destino"
                className={SELECT_CLASS}
                value={analyticType}
                onChange={(event) => setAnalyticType(event.target.value)}
              >
                <option value="">Que lo resuelva el motor (R-A2/R-A3/R-A4)</option>
                {Object.entries(ANALYTIC_TYPE_LABELS).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Motivo *</span>
              <Textarea
                aria-label="Motivo de la reclasificación"
                rows={3}
                maxLength={512}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="El gasto pertenece al proyecto P-02, no al P-01"
              />
              <span className="text-[11px] text-muted-foreground">
                Mínimo 10 caracteres. Queda en el `AuditLog` con el antes, el después y los dos `entryHash`.
              </span>
            </label>
          </div>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="reclassify-error">
              {error}
            </p>
          )}
          {done && (
            <p className="rounded-md border px-3 py-2 font-code text-xs" data-testid="reclassify-done">
              {done}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cerrar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={
                pending ||
                reason.trim().length < 10 ||
                !line ||
                (target.projectId === null && target.costCenterId === null)
              }
              data-testid="confirm-reclassify"
            >
              {pending ? "Reclasificando…" : "Reclasificar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
