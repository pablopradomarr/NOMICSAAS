"use client"

import type { VatBookView } from "@/app/(app)/reports/vat/actions"
import { Amount } from "@/components/ledger/amount"
import Link from "next/link"
import { useState } from "react"

/**
 * E9 · T18 — **Libro registro** del periodo (§7, ADR-0016 D8).
 *
 * Con RECC a la vista aparecen las dos columnas de los arts. 61 *decies* y
 * *undecies* RIVA: lo que la factura anota **íntegro** en su expedición y lo
 * **efectivamente devengado o deducido en el periodo** (al cobro o al pago).
 * Fuera de RECC coinciden, y ahí está toda la diferencia entre I-E8-15c y
 * I-E8-15c′ — enseñarlas juntas es lo que hace el puente comprobable.
 *
 * Cada fila enlaza con su asiento: es el primer tramo del drill-down
 * «casilla → libro → asiento → documento».
 */
export function VatBookTable({ view }: { view: VatBookView }) {
  const [side, setSide] = useState<"AMBAS" | "EMITIDAS" | "RECIBIDAS">("AMBAS")
  const recc = view.regime === "RECC" || view.book.some((row) => row.recc)
  const rows = view.book.filter((row) => side === "AMBAS" || row.tipo === side)

  if (view.book.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="vat-book-empty">
        El libro registro del periodo {view.period} no tiene ninguna anotación. El libro se deriva de los asientos
        contabilizados: si esperaba ver facturas aquí, revise que estén contabilizadas y con su periodo de IVA.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label htmlFor="vat-book-side" className="text-sm text-muted-foreground">
          Libro
        </label>
        <select
          id="vat-book-side"
          data-testid="vat-book-side"
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={side}
          onChange={(event) => setSide(event.target.value as typeof side)}
        >
          <option value="AMBAS">Emitidas y recibidas</option>
          <option value="EMITIDAS">Emitidas</option>
          <option value="RECIBIDAS">Recibidas</option>
        </select>
        <span className="text-xs text-muted-foreground">
          {rows.length} anotación(es) · régimen {view.regime}
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="vat-book">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Libro</th>
              <th className="px-3 py-2 text-left font-medium">Fecha</th>
              <th className="px-3 py-2 text-left font-medium">Tipo doc.</th>
              <th className="px-3 py-2 text-left font-medium">Clave</th>
              <th className="px-3 py-2 text-right font-medium">Tipo</th>
              <th className="px-3 py-2 text-right font-medium">Base</th>
              <th className="px-3 py-2 text-right font-medium">Cuota</th>
              <th className="px-3 py-2 text-right font-medium">Deducible</th>
              {recc && <th className="px-3 py-2 text-right font-medium">Devengado en el periodo</th>}
              {recc && <th className="px-3 py-2 text-right font-medium">Deducido en el periodo</th>}
              <th className="px-3 py-2 text-left font-medium">Asiento</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.id} className="h-8" data-doc-kind={row.docKind}>
                <td className="px-3 py-1 text-xs">{row.tipo === "EMITIDAS" ? "emitidas" : "recibidas"}</td>
                <td className="px-3 py-1 font-code text-xs">{row.documentDate}</td>
                <td className="px-3 py-1 text-xs">
                  {row.docKind}
                  {row.recc && <span className="ml-1 rounded bg-muted px-1 text-[10px]">RECC</span>}
                  {row.investmentGood && <span className="ml-1 rounded bg-muted px-1 text-[10px]">inversión</span>}
                  {row.importDeferred && <span className="ml-1 rounded bg-muted px-1 text-[10px]">diferido</span>}
                </td>
                <td className="px-3 py-1 text-xs">
                  {row.operationKey ?? <span className="text-[#1A202C]">sin clasificar ⚠</span>}
                </td>
                <td className="px-3 py-1 text-right text-xs tabular-nums">
                  {row.rateBps === null ? "—" : `${row.rateBps / 100} %`}
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.baseCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.cuotaTotalCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.cuotaDeducibleCents} />
                </td>
                {recc && (
                  <td className="px-3 py-1 text-right">
                    <Amount cents={row.cuotaDevengadaEnPeriodoCents} />
                  </td>
                )}
                {recc && (
                  <td className="px-3 py-1 text-right">
                    <Amount cents={row.cuotaDeducibleEnPeriodoCents} />
                  </td>
                )}
                <td className="px-3 py-1 text-xs">
                  {row.entryId ? (
                    <Link
                      href={`/ledger/${row.entryId}`}
                      className="underline underline-offset-4"
                      data-testid={`book-entry-${row.id}`}
                    >
                      ver asiento
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">sin asiento</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recc && (
        <p className="text-xs text-muted-foreground">
          Bajo criterio de caja, la columna «cuota» es lo que la factura anota íntegro en su expedición (arts. 61
          <em> decies</em> y <em>undecies</em> RIVA) y las dos últimas son lo efectivamente devengado y deducido en
          este periodo, al cobro y al pago. Lo que se declara en las casillas 01-09 y 28-41 es lo segundo.
        </p>
      )}
    </div>
  )
}
