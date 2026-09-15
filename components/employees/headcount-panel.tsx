"use client"

import { deriveHeadcountAction, upsertHeadcountSnapshotAction } from "@/app/(app)/settings/employees/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { HeadcountRowItem } from "@/models/employees"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E10 · T17 — Plantilla por centro de coste y mes (**FTE·mes**, Q-7).
 *
 * La pantalla distingue lo que el driver necesita distinguir y la base de datos
 * ya distingue: **«0 declarado» no es «sin rellenar»**. Un snapshot con
 * `fteMilli = 0` es un dato —ahí no hay nadie— y no mueve el sello; un hueco es
 * un hueco, dispara `PLANTILLA_AUSENTE` (EV-16) y el receptor pesa 0 con aviso.
 *
 * «Derivar de empleados» escribe una **propuesta** (`DERIVADO_EMPLEADOS`), no un
 * cálculo del driver: el driver lee sólo los snapshots, de modo que un reparto ya
 * cerrado no cambia porque alguien edite una ficha de personal años después.
 */

export type HeadcountCostCenter = { id: string; code: string; name: string }

const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]
const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

const lastDayOf = (year: string, month: string): string => {
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
  return `${year}-${month}-${String(days).padStart(2, "0")}`
}

export function HeadcountPanel({
  year,
  rows,
  costCenters,
  canEdit,
}: {
  year: string
  rows: readonly HeadcountRowItem[]
  costCenters: readonly HeadcountCostCenter[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [editing, setEditing] = useState<{ costCenter: HeadcountCostCenter; periodEnd: string; row: HeadcountRowItem | null } | null>(null)
  const [deriveMonth, setDeriveMonth] = useState("12")

  const byKey = new Map(rows.map((r) => [`${r.costCenterId}|${r.periodEnd}`, r]))

  const save = (form: FormData): void => {
    if (!editing) return
    const fteMilli = Number(form.get("fteMilli"))
    const headcount = Number(form.get("headcount"))
    if (!Number.isInteger(fteMilli) || fteMilli < 0) {
      toast.error("El FTE se registra en milésimas enteras y no puede ser negativo")
      return
    }
    start(async () => {
      const state = await upsertHeadcountSnapshotAction({
        costCenterId: editing.costCenter.id,
        periodEnd: editing.periodEnd,
        fteMilli,
        headcount: Number.isInteger(headcount) ? headcount : 0,
        note: String(form.get("note") ?? "").trim() || null,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido registrar la plantilla")
        return
      }
      toast.success("Plantilla registrada a fin de mes")
      setEditing(null)
      router.refresh()
    })
  }

  const derive = (): void => {
    start(async () => {
      const state = await deriveHeadcountAction({ periodEnd: lastDayOf(year, deriveMonth) })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido derivar la plantilla")
        return
      }
      toast.success(`${state.data?.written ?? 0} snapshot(s) escritos desde las fichas de personal`)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="derive-month">Derivar de empleados · mes</Label>
            <select
              id="derive-month"
              value={deriveMonth}
              onChange={(e) => setDeriveMonth(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              data-testid="headcount-derive-month"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={m}>
                  {MONTH_LABELS[i]} {year}
                </option>
              ))}
            </select>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={derive} disabled={pending} data-testid="headcount-derive">
            {pending ? "Derivando…" : "Derivar de empleados"}
          </Button>
        </div>
      )}

      {costCenters.length === 0 ? (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="headcount-empty">
          No hay centros de coste. La plantilla se registra por centro de coste y mes: créalos primero en Analítica.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs" data-testid="headcount-table" data-year={year}>
            <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="sticky left-0 bg-muted/40 px-2 py-1 text-left font-medium">Centro de coste</th>
                {MONTH_LABELS.map((label) => (
                  <th key={label} className="px-2 py-1 text-right font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {costCenters.map((costCenter) => (
                <tr key={costCenter.id} className="h-8" data-ceco={costCenter.code}>
                  <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap">
                    <span className="font-code">{costCenter.code}</span>{" "}
                    <span className="text-muted-foreground">{costCenter.name}</span>
                  </td>
                  {MONTHS.map((month) => {
                    const periodEnd = lastDayOf(year, month)
                    const row = byKey.get(`${costCenter.id}|${periodEnd}`) ?? null
                    const filled = row !== null
                    return (
                      <td
                        key={month}
                        className="px-2 py-1 text-right tabular-nums"
                        data-month={`${year}-${month}`}
                        data-filled={filled ? "si" : "no"}
                        data-fte-milli={row?.fteMilli ?? ""}
                      >
                        {canEdit ? (
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            onClick={() => setEditing({ costCenter, periodEnd, row })}
                            data-testid="headcount-cell"
                          >
                            {filled ? (row.fteMilli / 1000).toLocaleString("es-ES", { minimumFractionDigits: 3 }) : "·"}
                          </button>
                        ) : filled ? (
                          (row.fteMilli / 1000).toLocaleString("es-ES", { minimumFractionDigits: 3 })
                        ) : (
                          <span className="text-muted-foreground">·</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="headcount-legend">
        <strong>«0,000 declarado» no es lo mismo que «sin rellenar»</strong>: <span className="font-code">0,000</span> es
        un dato —ahí no hay nadie— y el reparto lo respeta; el punto (<span className="font-code">·</span>) es un hueco,
        el receptor pesa 0 y el informe sale con el motivo{" "}
        <span className="font-code">PLANTILLA_AUSENTE</span> (EV-16). El snapshot es a{" "}
        <strong>fin de mes</strong> y se mide en <strong>FTE·mes</strong>.
      </p>

      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Plantilla de {editing?.costCenter.code} a {editing?.periodEnd}
            </DialogTitle>
            <DialogDescription>
              El snapshot es a fin de mes y en FTE·mes (Q-7). Declarar 0 es declarar que ahí no hay nadie; dejarlo sin
              rellenar es otra cosa y el informe lo dirá.
            </DialogDescription>
          </DialogHeader>
          <form action={save} className="space-y-3" data-testid="headcount-form">
            <div className="space-y-1">
              <Label htmlFor="headcount-fte">FTE (milésimas)</Label>
              <Input
                id="headcount-fte"
                name="fteMilli"
                type="number"
                step={1}
                min={0}
                required
                defaultValue={editing?.row?.fteMilli ?? 0}
                data-testid="headcount-fte"
              />
              <p className="text-xs text-muted-foreground">1 000 = una persona a jornada completa durante el mes.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="headcount-people">Personas</Label>
              <Input
                id="headcount-people"
                name="headcount"
                type="number"
                step={1}
                min={0}
                defaultValue={editing?.row?.headcount ?? 0}
                data-testid="headcount-people"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="headcount-note">Nota</Label>
              <Input id="headcount-note" name="note" maxLength={500} defaultValue={editing?.row?.note ?? ""} data-testid="headcount-note" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending} data-testid="headcount-submit">
                {pending ? "Guardando…" : "Guardar"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
