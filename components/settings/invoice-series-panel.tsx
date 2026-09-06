"use client"

import { createInvoiceSeriesAction, setInvoiceSeriesActiveAction } from "@/app/(app)/settings/invoicing/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T17 — Series de facturación (§6, O-18, I-E8-20).
 *
 * Lo que esta pantalla afirma en voz alta, porque es lo que más caro sale
 * ignorar: **una factura emitida no se borra ni se renumera**. Se rectifica con
 * un abono de la serie rectificativa, que es una serie distinta por ley.
 */

export type InvoiceSeriesView = {
  id: string
  code: string
  kind: string
  prefix: string
  year: number | null
  nextNumber: number
  nextDocumentNumber: string
  isActive: boolean
}

export type NumberingGapView = {
  seriesCode: string
  fiscalYear: number
  missing: number[]
  duplicated: number[]
  outOfOrder: string[]
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  ORDINARIA: "Ordinaria",
  RECTIFICATIVA: "Rectificativa",
  SIMPLIFICADA: "Simplificada",
}

export function InvoiceSeriesPanel({
  series,
  gaps,
  isAdmin,
}: {
  series: readonly InvoiceSeriesView[]
  gaps: readonly NumberingGapView[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [code, setCode] = useState("")
  const [prefix, setPrefix] = useState("")
  const [kind, setKind] = useState("ORDINARIA")
  const [year, setYear] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const create = () =>
    startTransition(async () => {
      setError(null)
      const parsedYear = year.trim() === "" ? null : Number.parseInt(year.trim(), 10)
      const state = await createInvoiceSeriesAction({ code, kind, prefix, year: parsedYear })
      if (!state.success) {
        setError(state.error ?? "No se ha podido crear la serie")
        return
      }
      setCode("")
      setPrefix("")
      setYear("")
      router.refresh()
    })

  const toggle = (seriesId: string, isActive: boolean) =>
    startTransition(async () => {
      setError(null)
      const state = await setInvoiceSeriesActiveAction({ seriesId, isActive })
      if (!state.success) setError(state.error ?? "No se ha podido cambiar el estado de la serie")
      router.refresh()
    })

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Series</h3>
        {series.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground" data-testid="series-empty">
            No hay ninguna serie configurada: no se puede emitir una factura sin serie de la que tomar el número.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="invoice-series">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Código</th>
                  <th className="px-3 py-2 text-left font-medium">Tipo</th>
                  <th className="px-3 py-2 text-left font-medium">Prefijo</th>
                  <th className="px-3 py-2 text-left font-medium">Ejercicio</th>
                  <th className="px-3 py-2 text-left font-medium">Siguiente número</th>
                  <th className="px-3 py-2 text-left font-medium">Estado</th>
                  {isAdmin && <th className="px-3 py-2 text-right font-medium">Acciones</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {series.map((serie) => (
                  <tr key={serie.id} className="h-8" data-series-code={serie.code}>
                    <td className="px-3 py-1 font-code text-xs">{serie.code}</td>
                    <td className="px-3 py-1">{KIND_LABEL[serie.kind] ?? serie.kind}</td>
                    <td className="px-3 py-1 font-code text-xs">{serie.prefix}</td>
                    <td className="px-3 py-1">{serie.year ?? "todos"}</td>
                    <td className="px-3 py-1 font-code text-xs" data-testid={`next-number-${serie.code}`}>
                      {serie.nextDocumentNumber}
                    </td>
                    <td className="px-3 py-1">
                      <span
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[11px] leading-none",
                          serie.isActive ? "border-transparent bg-[#0A0A0A] text-white" : "border-dashed text-muted-foreground"
                        )}
                      >
                        {serie.isActive ? "activa" : "inactiva"}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-3 py-1 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => toggle(serie.id, !serie.isActive)}
                        >
                          {serie.isActive ? "Desactivar" : "Activar"}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Una factura emitida <strong>no se borra ni se renumera</strong>: se rectifica con un abono de la serie
          rectificativa (art. 15 RD 1619/2012). Por eso una serie se desactiva, nunca se elimina, y su contador sólo
          avanza. Las facturas se emiten desde{" "}
          <Link href="/apps/invoices" className="underline underline-offset-2">
            la aplicación de facturas
          </Link>
          , que recalcula bases y cuotas en el servidor y contabiliza el asiento.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Control de numeración (I-E8-20)</h3>
        {gaps.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-gaps">
            Sin huecos, sin duplicados y sin fechas fuera de orden en ninguna serie.
          </p>
        ) : (
          <ul className="divide-y rounded-md border border-[#F5A623] text-sm" data-testid="numbering-gaps">
            {gaps.map((gap) => (
              <li key={`${gap.seriesCode}-${gap.fiscalYear}`} className="space-y-1 px-3 py-2">
                <p className="font-medium">
                  Serie <span className="font-code">{gap.seriesCode}</span>, ejercicio {gap.fiscalYear}
                </p>
                {gap.missing.length > 0 && <p>Faltan los números: {gap.missing.join(", ")}</p>}
                {gap.duplicated.length > 0 && <p>Números repetidos: {gap.duplicated.join(", ")}</p>}
                {gap.outOfOrder.length > 0 && <p>Fechas fuera de orden: {gap.outOfOrder.join(" · ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold">Nueva serie</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Código</span>
              <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="FR" data-testid="series-code" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Tipo</span>
              <select
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                data-testid="series-kind"
              >
                {Object.entries(KIND_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Prefijo</span>
              <Input
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="FR-2026-"
                data-testid="series-prefix"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Ejercicio (opcional)</span>
              <Input
                value={year}
                onChange={(event) => setYear(event.target.value)}
                placeholder="2026"
                inputMode="numeric"
                data-testid="series-year"
              />
            </label>
          </div>
          <Button
            type="button"
            onClick={create}
            disabled={pending || code.trim() === "" || prefix.trim() === ""}
            data-testid="create-series"
          >
            {pending ? "Creando…" : "Crear serie"}
          </Button>
          <p className="text-xs text-muted-foreground">
            La serie empieza siempre en el número 1 y su tipo no se cambia después: para otro tipo, otra serie.
          </p>
        </section>
      )}

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
