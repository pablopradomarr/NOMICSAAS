"use client"

import {
  approveTimeEntriesAction,
  correctTimeEntryAction,
  createTimeEntriesAction,
  importTimeCsvAction,
  type TimeImportPayload,
  type TimeListPayload,
} from "@/app/(app)/time/actions"
import { hhmm } from "@/components/time/time-calendar"
import { formatLocalDate } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { MIN_TIME_REASON } from "@/forms/time"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E10 · T17 — Partes de horas: alta, lista, **aprobación por lote** y
 * **corrección por contra-apunte** (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Reglas que la pantalla respeta y que el servidor vuelve a exigir:
 *
 *  · **Minutos enteros** y ≤ 1 440 por fila; el techo del **día completo** lo
 *    avisa el servidor sumando todos los partes (O-E10-21).
 *  · **Un parte va a UN proyecto o a UN centro de coste**, nunca a los dos ni a
 *    ninguno.
 *  · **Lo aprobado no se edita ni se borra** (I-E10-4): se corrige con un
 *    contra-apunte con motivo de al menos {MIN_TIME_REASON} caracteres, y el
 *    original sigue ahí.
 *  · **Nadie aprueba sus propios partes** salvo un ADMIN (R-H-4). Lo decide el
 *    servidor: aquí sólo se enseña el resultado del lote.
 *  · Un **VIEWER** no ve ningún botón de mutación (y las acciones lo exigen).
 */

export type DimensionOption = { id: string; code: string; name: string }

export function TimePanel({
  payload,
  employees,
  projects,
  costCenters,
  canEdit,
  defaultDate,
}: {
  payload: TimeListPayload
  employees: readonly DimensionOption[]
  projects: readonly DimensionOption[]
  costCenters: readonly DimensionOption[]
  canEdit: boolean
  defaultDate: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [correcting, setCorrecting] = useState<TimeListPayload["entries"][number] | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [preview, setPreview] = useState<TimeImportPayload | null>(null)
  const [csv, setCsv] = useState("")

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const approvable = payload.entries.filter((e) => e.status !== "APROBADO")

  const approve = (): void => {
    const ids = [...selected]
    if (ids.length === 0) {
      toast.error("No hay ningún parte seleccionado")
      return
    }
    start(async () => {
      const state = await approveTimeEntriesAction({ ids })
      if (!state.success) {
        toast.error(state.error ?? "No se han podido aprobar los partes")
        return
      }
      const data = state.data ?? { approved: 0, skipped: 0 }
      toast.success(
        data.skipped > 0
          ? `${data.approved} parte(s) aprobados · ${data.skipped} omitidos (nadie aprueba sus propios partes salvo un ADMIN)`
          : `${data.approved} parte(s) aprobados`
      )
      setSelected(new Set())
      router.refresh()
    })
  }

  const create = (form: FormData): void => {
    const minutes = Number(form.get("minutes"))
    const target = String(form.get("target") ?? "")
    const [kind, id] = target.split(":")
    if (!Number.isInteger(minutes) || minutes === 0) {
      toast.error("Los partes se registran en minutos enteros distintos de 0")
      return
    }
    if (!id) {
      toast.error("Un parte de horas va a UN proyecto o a UN centro de coste")
      return
    }
    start(async () => {
      const state = await createTimeEntriesAction({
        rows: [
          {
            employeeId: String(form.get("employeeId") ?? ""),
            date: String(form.get("date") ?? ""),
            ...(kind === "PROJ" ? { projectId: id } : { costCenterId: id }),
            minutes,
            productive: form.get("productive") === "on",
            note: String(form.get("note") ?? "").trim() || null,
          },
        ],
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido registrar el parte")
        return
      }
      for (const warning of state.data?.warnings ?? []) toast.warning(warning.message)
      toast.success("Parte registrado en borrador")
      setShowForm(false)
      router.refresh()
    })
  }

  const correct = (form: FormData): void => {
    if (!correcting) return
    const typed = Number(form.get("minutes"))
    const reason = String(form.get("reason") ?? "").trim()
    if (!Number.isInteger(typed) || typed === 0) {
      toast.error("Los minutos del contra-apunte son enteros y distintos de 0")
      return
    }
    // El contra-apunte lleva minutos **negativos**: es lo que se retira. El
    // signo es convención de presentación, no aritmética contable — la cifra
    // que cuenta (el neto del día) la compone el servidor.
    const minutes = -Math.abs(typed)
    if (Math.abs(minutes) > Math.abs(correcting.minutes)) {
      toast.error("Un contra-apunte no puede retirar más minutos de los que tenía el parte original")
      return
    }
    if (reason.length < MIN_TIME_REASON) {
      toast.error(`El motivo es obligatorio y debe tener al menos ${MIN_TIME_REASON} caracteres`)
      return
    }
    start(async () => {
      const state = await correctTimeEntryAction({ entryId: correcting.id, minutes, reason })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido corregir el parte")
        return
      }
      toast.success("Contra-apunte registrado: el parte original sigue ahí y el neto del día baja esos minutos")
      setCorrecting(null)
      router.refresh()
    })
  }

  const runImport = (dryRun: boolean): void => {
    if (csv.trim() === "") {
      toast.error("Pega el contenido del CSV antes de previsualizar")
      return
    }
    start(async () => {
      const state = await importTimeCsvAction({ csv, delimiter: ";", dryRun })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido leer el fichero")
        return
      }
      setPreview(state.data ?? null)
      if (!dryRun) {
        toast.success(`${state.data?.inserted ?? 0} parte(s) importados`)
        router.refresh()
      }
    })
  }

  return (
    <div className="space-y-4">
      <section
        className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border p-3 text-sm"
        data-testid="time-band"
      >
        <span>
          Aprobadas <strong className="tabular-nums" data-testid="approved-minutes">{hhmm(payload.approvedMinutes)}</strong>
        </span>
        <span>
          Pendientes{" "}
          <strong className="tabular-nums" data-testid="unapproved-minutes">{hhmm(payload.unapprovedMinutes)}</strong>
        </span>
        <span className="text-muted-foreground" data-testid="unapproved-share">
          {payload.unapprovedShareBps === null
            ? "sin base sobre la que medir"
            : `${Math.floor(payload.unapprovedShareBps / 100)},${String(payload.unapprovedShareBps % 100).padStart(2, "0")} % de la base`}
        </span>
        {payload.unapprovedMinutes !== 0 && (
          <span className="text-muted-foreground">
            · <strong>ninguna regla de actividad usará las pendientes</strong>: no reparten dinero y no aparecen en
            ningún margen.
          </span>
        )}
        {payload.redacted && (
          <span className="text-muted-foreground" data-testid="time-redacted">
            · nombres ocultos: las horas y el coste de una persona son datos suyos (§10).
          </span>
        )}
      </section>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setShowForm((v) => !v)} data-testid="open-time-form">
            Nuevo parte
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setShowImport((v) => !v)} data-testid="open-time-import">
            Importar CSV
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={approve}
            disabled={pending || selected.size === 0}
            data-testid="approve-selected"
          >
            {pending ? "Aprobando…" : `Aprobar seleccionados (${selected.size})`}
          </Button>
          {approvable.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set(approvable.map((e) => e.id)))}
              data-testid="select-all-pending"
            >
              Seleccionar los {approvable.length} pendientes
            </Button>
          )}
        </div>
      )}

      {canEdit && showForm && (
        <form action={create} className="grid gap-3 rounded-md border p-4 md:grid-cols-6" data-testid="time-form">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="time-employee">Empleado</Label>
            <select
              id="time-employee"
              name="employeeId"
              required
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="time-employee"
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} · {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="time-date">Fecha</Label>
            <Input id="time-date" name="date" type="date" required defaultValue={defaultDate} data-testid="time-date" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="time-target">Destino (proyecto o centro de coste)</Label>
            <select
              id="time-target"
              name="target"
              required
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="time-target"
            >
              <option value="">Elige uno</option>
              <optgroup label="Proyectos">
                {projects.map((p) => (
                  <option key={p.id} value={`PROJ:${p.id}`}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Centros de coste">
                {costCenters.map((c) => (
                  <option key={c.id} value={`CECO:${c.id}`}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="time-minutes">Minutos</Label>
            <Input
              id="time-minutes"
              name="minutes"
              type="number"
              step={1}
              min={1}
              max={1440}
              required
              data-testid="time-minutes"
            />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <input id="time-productive" name="productive" type="checkbox" defaultChecked data-testid="time-productive" />
            <Label htmlFor="time-productive" className="text-sm">
              Productiva
            </Label>
          </div>
          <div className="space-y-1 md:col-span-5">
            <Label htmlFor="time-note">Nota</Label>
            <Input id="time-note" name="note" maxLength={500} data-testid="time-note" />
          </div>
          <p className="text-xs text-muted-foreground md:col-span-6">
            Los partes se registran en <strong>minutos enteros</strong> (nunca en horas decimales) y no pasan de 1 440
            por línea. Una hora no productiva se marca aquí: la tarifa ya la absorbe, así que ese coste no se reparte
            otra vez.
          </p>
          <div className="flex gap-2 md:col-span-6">
            <Button type="submit" size="sm" disabled={pending} data-testid="time-submit">
              {pending ? "Registrando…" : "Registrar parte"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      {canEdit && showImport && (
        <div className="space-y-3 rounded-md border p-4" data-testid="time-import">
          <Label htmlFor="time-csv">CSV de partes</Label>
          <Textarea
            id="time-csv"
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            rows={6}
            className="font-code text-xs"
            placeholder="empleado;fecha;proyecto;centro_coste;minutos;productivo;nota"
            data-testid="time-csv"
          />
          <p className="text-xs text-muted-foreground">
            Cabecera con lista blanca: <span className="font-code">empleado; fecha; proyecto; centro_coste; minutos;
            productivo; nota</span>. El import es <strong>idempotente</strong>: reimportar el mismo fichero inserta 0
            filas y dice por qué.
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => runImport(true)} disabled={pending} data-testid="time-import-dry">
              Previsualizar
            </Button>
            <Button type="button" size="sm" onClick={() => runImport(false)} disabled={pending || preview === null} data-testid="time-import-apply">
              Importar
            </Button>
          </div>
          {preview && (
            <div className="space-y-1 rounded-md border border-dashed p-3 text-xs" data-testid="time-import-report">
              <p>
                {preview.dryRun ? "Vista previa" : "Importado"} · {preview.parsed} fila(s) legibles ·{" "}
                {preview.inserted} insertadas · {preview.skipped} omitidas · sha256 del fichero{" "}
                <span className="font-code">{preview.fileSha256.slice(0, 16)}</span>
              </p>
              {preview.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-muted-foreground">
                  {preview.reasons.map((r) => (
                    <li key={`${r.line}-${r.reason}`}>
                      Línea {r.line}: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="time-entries">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {canEdit && <th className="w-8 px-2 py-2" />}
              <th className="px-3 py-2 text-left font-medium">Fecha</th>
              <th className="px-3 py-2 text-left font-medium">Empleado</th>
              <th className="px-3 py-2 text-left font-medium">Destino</th>
              <th className="px-3 py-2 text-right font-medium">Horas</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-left font-medium">Origen</th>
              {canEdit && <th className="px-3 py-2 text-left font-medium">Corrección</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {payload.entries.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-muted-foreground" colSpan={canEdit ? 8 : 6}>
                  No hay partes en el periodo seleccionado.
                </td>
              </tr>
            )}
            {payload.entries.map((entry) => {
              const approved = entry.status === "APROBADO"
              return (
                <tr
                  key={entry.id}
                  className="h-8"
                  data-testid="time-entry"
                  data-status={entry.status}
                  data-productive={entry.productive ? "si" : "no"}
                >
                  {canEdit && (
                    <td className="px-2 py-1">
                      {!approved && (
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar el parte de ${entry.employeeCode} del ${entry.date}`}
                          checked={selected.has(entry.id)}
                          onChange={() => toggle(entry.id)}
                          data-testid="time-select"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-3 py-1 tabular-nums text-muted-foreground">{formatLocalDate(entry.date)}</td>
                  <td className="px-3 py-1">
                    <span className="font-code text-xs">{entry.employeeCode}</span>{" "}
                    <span className="text-muted-foreground">{entry.employeeName}</span>
                  </td>
                  <td className="px-3 py-1 font-code text-xs">
                    {entry.projectCode ?? entry.costCenterCode ?? "—"}
                    {!entry.productive && (
                      <span className="ml-2 font-sans text-[11px] text-muted-foreground" data-testid="non-productive">
                        no productiva
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums" data-minutes={entry.minutes}>
                    {hhmm(entry.minutes)}
                  </td>
                  <td className="px-3 py-1 text-xs">
                    {approved ? "Aprobado" : "Borrador"}
                    {entry.correctsEntryId && (
                      <span className="ml-2 text-muted-foreground" data-testid="counter-entry">
                        contra-apunte
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">{entry.source}</td>
                  {canEdit && (
                    <td className="px-3 py-1">
                      {approved && !entry.correctsEntryId ? (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => setCorrecting(entry)}
                          data-testid="open-correct"
                        >
                          Corregir
                        </Button>
                      ) : entry.correctionReason ? (
                        <span className="text-xs text-muted-foreground">{entry.correctionReason}</span>
                      ) : null}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Mostrando {payload.entries.length} de {payload.total} parte(s). Un parte aprobado{" "}
        <strong>no se edita ni se borra</strong>: se corrige con un contra-apunte con motivo, y los dos siguen aquí
        (I-E10-4).
      </p>

      <Dialog open={correcting !== null} onOpenChange={(value) => !value && setCorrecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Corregir por contra-apunte</DialogTitle>
            <DialogDescription>
              El parte original de {correcting?.employeeCode} del {correcting?.date} ({hhmm(correcting?.minutes ?? 0)})
              se queda como está. Lo que se registra es un contra-apunte con su motivo, y el neto del día baja
              exactamente esos minutos.
            </DialogDescription>
          </DialogHeader>
          <form action={correct} className="space-y-3" data-testid="correct-form">
            <div className="space-y-1">
              <Label htmlFor="correct-minutes">Minutos a retirar</Label>
              <Input
                id="correct-minutes"
                name="minutes"
                type="number"
                step={1}
                min={1}
                max={Math.abs(correcting?.minutes ?? 0)}
                required
                defaultValue={Math.abs(correcting?.minutes ?? 0)}
                data-testid="correct-minutes"
              />
              <p className="text-xs text-muted-foreground">
                Se registran en <strong>negativo</strong> —es lo que se retira— y nunca más de los{" "}
                {hhmm(Math.abs(correcting?.minutes ?? 0))} del original. El neto del día lo recompone el servidor.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="correct-reason">Motivo</Label>
              <Textarea id="correct-reason" name="reason" required minLength={MIN_TIME_REASON} rows={3} data-testid="correct-reason" />
              <p className="text-xs text-muted-foreground">Al menos {MIN_TIME_REASON} caracteres. Queda en el registro de auditoría.</p>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending} data-testid="correct-submit">
                {pending ? "Registrando…" : "Registrar contra-apunte"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCorrecting(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
