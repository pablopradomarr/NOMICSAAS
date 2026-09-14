import type { Model303View } from "@/lib/closing/vat"
import { Amount } from "@/components/ledger/amount"
import Link from "next/link"

const ORIGIN_LABEL: Record<string, string> = {
  EMITIDAS: "libro de emitidas",
  RECIBIDAS: "libro de recibidas",
  DERIVADA: "derivada de otras casillas",
  DECLARADA: "dato declarado",
  NO_OFERTADA: "no ofrecida",
}

/**
 * E9 · T18 — **Casillas del modelo 303** con fórmula y origen (§7, O-13).
 *
 * Cada casilla dice tres cosas: **cuánto**, **de dónde sale** (libro de
 * emitidas, de recibidas, derivada de otras casillas o declarada) y **con qué
 * fórmula**, más su referencia normativa. Y las que este ERP no ofrece salen
 * **vacías con su motivo** en vez de con un cero: un cero es una declaración, y
 * declarar cero lo que no se ha calculado no es honesto frente a la AEAT.
 *
 * El enlace de cada casilla lleva al libro registro del periodo, y desde cada
 * anotación se llega al asiento y al documento: la casilla queda a tres clics de
 * su justificante.
 */
export function Model303Table({ view, period }: { view: Model303View; period: string }) {
  return (
    <div className="space-y-4">
      <p className="font-code text-xs text-muted-foreground" data-testid="model303-version">
        mapa del modelo 303 versión {view.mapVersion} · periodo {view.period}
      </p>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="model303">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Casilla</th>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              <th className="px-3 py-2 text-right font-medium">Importe</th>
              <th className="px-3 py-2 text-left font-medium">Origen</th>
              <th className="px-3 py-2 text-left font-medium">Fórmula</th>
              <th className="px-3 py-2 text-left font-medium">Norma</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {view.cells.map((cell) => (
              <tr key={cell.box} className="h-8" data-box={cell.box}>
                <td className="px-3 py-1 font-code text-xs">
                  <Link
                    href={`/reports/vat?tab=libro&period=${period}`}
                    className="underline underline-offset-4"
                    data-testid={`box-link-${cell.box}`}
                  >
                    {cell.box}
                  </Link>
                </td>
                <td className="px-3 py-1 text-xs">{cell.label}</td>
                <td className="px-3 py-1 text-right" data-testid={`box-value-${cell.box}`}>
                  {cell.kind === "PORCENTAJE" ? (
                    <span className="tabular-nums">{cell.value} %</span>
                  ) : (
                    <Amount cents={cell.value} />
                  )}
                </td>
                <td className="px-3 py-1 text-xs text-muted-foreground">{ORIGIN_LABEL[cell.origin] ?? cell.origin}</td>
                <td className="px-3 py-1 text-xs text-muted-foreground">{cell.provenance || cell.formula}</td>
                <td className="px-3 py-1 text-xs text-muted-foreground">{cell.legal}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 font-medium">
              <td className="px-3 py-2 font-code text-xs">71</td>
              <td className="px-3 py-2 text-xs">Resultado de la autoliquidación</td>
              <td className="px-3 py-2 text-right" data-testid="model303-result">
                <Amount cents={view.resultCents} />
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground" colSpan={3}>
                Es el importe del asiento de liquidación (T-23).
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {view.notOffered.length > 0 && (
        <div className="space-y-2 rounded-md border border-dashed p-4" data-testid="model303-not-offered">
          <p className="text-sm font-medium">Casillas que este ERP no ofrece</p>
          <p className="text-xs text-muted-foreground">
            Salen <strong>vacías con su motivo</strong>, nunca con un cero: declarar cero lo que no se ha calculado es
            declarar mal en silencio.
          </p>
          <ul className="space-y-1 text-xs">
            {view.notOffered.map((box) => (
              <li key={box.box}>
                <span className="font-code">{box.box}</span> · {box.label} — {box.notOfferedReason ?? box.formula}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
