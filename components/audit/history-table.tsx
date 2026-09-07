"use client"

import { Button } from "@/components/ui/button"
import { SealBadge } from "@/components/ui/seal-badge"
import { fechaHoraUtc } from "@/lib/dates-ui"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { SCOPE_LABEL, TRIGGER_LABEL, type RunHistoryRow } from "./types"

/**
 * E7 · T12 — §Historial de barridos, con la selección de **dos** para comparar.
 *
 * La comparación no es cosmética: es lo que convierte «dos ejecuciones que se
 * contradicen» en un diff con causa (spec §0). Por eso el botón sólo se activa
 * con exactamente dos runs marcados y lleva a `/audit/runs/diff?a=&b=`.
 */
export function RunHistoryTable({ runs }: { runs: readonly RunHistoryRow[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<string[]>([])

  const toggle = (id: string): void => {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(-2)
    )
  }

  if (runs.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="history-empty">
        Todavía no hay ningún barrido sellado. Ejecute uno para tener la primera foto con la que comparar.
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="run-history">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={selected.length !== 2}
          onClick={() => router.push(`/audit/runs/diff?a=${selected[0]}&b=${selected[1]}`)}
          data-testid="compare-runs"
        >
          Comparar los dos seleccionados
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-2 text-left font-medium">Comparar</th>
              <th className="p-2 text-left font-medium">Fecha</th>
              <th className="p-2 text-left font-medium">Alcance</th>
              <th className="p-2 text-left font-medium">Disparador</th>
              <th className="p-2 text-left font-medium">Sello</th>
              <th className="p-2 text-right font-medium">PASS</th>
              <th className="p-2 text-right font-medium">FAIL</th>
              <th className="p-2 text-right font-medium">WARN</th>
              <th className="p-2 text-right font-medium">INFO</th>
              <th className="p-2 text-left font-medium">ledgerHash</th>
              <th className="p-2 text-left font-medium"> </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-t" data-testid={`run-row-${run.id}`}>
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar el barrido de ${fechaHoraUtc(run.createdAt)}`}
                    checked={selected.includes(run.id)}
                    onChange={() => toggle(run.id)}
                    data-testid={`select-run-${run.id}`}
                  />
                </td>
                <td className="p-2 whitespace-nowrap">{fechaHoraUtc(run.createdAt)}</td>
                <td className="p-2">{SCOPE_LABEL[run.scopeKind] ?? run.scopeKind}</td>
                <td className="p-2">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</td>
                <td className="p-2">
                  <SealBadge
                    seal={{
                      sello: run.seal === "VALIDADO_AUTOMATICAMENTE" ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
                      motivos: [],
                    }}
                  />
                </td>
                <td className="p-2 text-right tabular-nums">{run.counts.PASS}</td>
                <td className="p-2 text-right tabular-nums">{run.counts.FAIL}</td>
                <td className="p-2 text-right tabular-nums">{run.counts.WARN}</td>
                <td className="p-2 text-right tabular-nums">{run.counts.INFO}</td>
                <td className="font-code p-2 text-xs text-muted-foreground">{run.ledgerHashShort}</td>
                <td className="p-2">
                  <Link href={`/audit/runs/${run.id}`} className="underline underline-offset-2">
                    Ver la foto
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
