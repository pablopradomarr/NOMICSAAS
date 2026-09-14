"use client"

import {
  closeProrrataYearAction,
  setProvisionalProrrataAction,
  type ProrrataView,
} from "@/app/(app)/reports/vat/actions"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { CheckStatusChip } from "@/components/ui/check-status"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBps } from "@/lib/money"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T18 — Pestaña **Prorrata** (§7, ADR-0016 D4, O-9…O-12).
 *
 * Cuatro cosas a la vista, y ninguna se teclea:
 *
 * · La **provisional** del año (art. 105.Dos), que sí se declara.
 * · La **definitiva**, derivada del libro de emitidas por clave de operación:
 *   numerador, denominador y las exclusiones del art. 104.Tres con su motivo.
 * · Los **documentos sin clasificar**. Con uno solo no hay porcentaje: el motor
 *   **no deduce** ninguna clave, así que la prorrata sale `INFO` con su lista y
 *   no se cierra. Es la diferencia entre no saber y adivinar.
 * · La **guardia de bienes de inversión** (art. 107), **bloqueante**: si la
 *   regularización de los bienes de inversión no está resuelta, la casilla 43
 *   no puede salir vacía con el cierre en verde.
 */
export function ProrrataPanel({ view, isAdmin }: { view: ProrrataView; isAdmin: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [provisional, setProvisional] = useState(
    view.provisionalBps === null ? "" : String(view.provisionalBps / 100)
  )
  const [preview, setPreview] = useState<number | null>(null)

  const saveProvisional = (): void => {
    const pct = Number(provisional.replace(",", "."))
    if (!Number.isFinite(pct)) {
      toast.error("El porcentaje no se entiende")
      return
    }
    start(async () => {
      const state = await setProvisionalProrrataAction({ year: view.year, provisionalBps: Math.round(pct * 100) })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido guardar la prorrata provisional")
        return
      }
      toast.success(`Prorrata provisional de ${view.year} guardada`)
      router.refresh()
    })
  }

  const close = (dryRun: boolean): void => {
    start(async () => {
      const state = await closeProrrataYearAction({ year: view.year, dryRun })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "No se ha podido cerrar la prorrata")
        return
      }
      setPreview(state.data.adjustmentCents)
      if (!dryRun) {
        toast.success(`Prorrata definitiva de ${view.year} cerrada y regularizada`)
        router.refresh()
      }
    })
  }

  const bloqueada = view.terms.status === "INFO" || view.terms.definitiveBps === null

  return (
    <div className="space-y-6" data-testid="prorrata-panel">
      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-md border p-4">
          <p className="text-xs uppercase text-muted-foreground">Provisional {view.year}</p>
          <p className="text-2xl tabular-nums" data-testid="prorrata-provisional">
            {view.provisionalBps === null ? "—" : `${formatBps(view.provisionalBps)} %`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Art. 105.Dos: la definitiva de N−1, o la declarada al inicio de la actividad.
          </p>
          {isAdmin && view.closedAt === null && (
            <div className="mt-3 flex items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="prorrata-provisional-input" className="text-xs">
                  %
                </Label>
                <Input
                  id="prorrata-provisional-input"
                  data-testid="prorrata-provisional-input"
                  className="h-8 w-24"
                  value={provisional}
                  onChange={(event) => setProvisional(event.target.value)}
                />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={saveProvisional} disabled={pending} data-testid="prorrata-provisional-save">
                Guardar
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-md border p-4">
          <p className="text-xs uppercase text-muted-foreground">Definitiva {view.year}</p>
          <p className="text-2xl tabular-nums" data-testid="prorrata-definitiva">
            {view.terms.definitiveBps === null ? "—" : `${formatBps(view.terms.definitiveBps)} %`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Numerador <Amount cents={view.terms.numeratorCents} /> ÷ denominador{" "}
            <Amount cents={view.terms.denominatorCents} />, redondeada por exceso (art. 104.Dos.2ª).
          </p>
        </div>

        <div className="rounded-md border p-4">
          <p className="text-xs uppercase text-muted-foreground">Regularización</p>
          <p className="text-2xl tabular-nums" data-testid="prorrata-adjustment">
            {view.adjustmentCents === null && preview === null ? (
              "—"
            ) : (
              <Amount cents={view.adjustmentCents ?? preview ?? 0} />
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Se calcula sobre la cuota prorrateable del año (<Amount cents={view.prorrateableQuotaCents} />), nunca
            sobre lo ya deducido. Se postea contra 472 con 634 o 639, en el último periodo del año y antes de su
            liquidación (art. 105.Uno).
          </p>
          {view.closedAt !== null && (
            <p className="mt-1 text-xs text-muted-foreground">Cerrada. Rectificarla es un contra-asiento.</p>
          )}
        </div>
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <div className="flex items-center gap-2">
          <CheckStatusChip status={view.capitalGoods.status === "FAIL" ? "FAIL" : view.capitalGoods.status === "PASS" ? "PASS" : "INFO"} />
          <p className="text-sm font-medium">Guardia de bienes de inversión (art. 107 LIVA)</p>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="capital-goods-evidence">
          {view.capitalGoods.evidencia}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Documentos sin clave de operación</h3>
        {view.terms.unclassified.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground" data-testid="prorrata-unclassified-empty">
            Ningún documento del año queda sin clasificar: la prorrata definitiva se puede derivar.
          </p>
        ) : (
          <div className="space-y-2 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-4" data-testid="prorrata-unclassified">
            <p className="text-sm">
              ⚠ {view.terms.unclassified.length} documento(s) sin clave. Mientras haya uno,{" "}
              <strong>no hay porcentaje</strong>: clasifíquelos y vuelva a intentarlo. El motor no deduce ninguna
              clave.
            </p>
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Fecha</th>
                  <th className="px-2 py-1 text-right font-medium">Base</th>
                  <th className="px-2 py-1 text-left font-medium">Documento</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5A623]/40">
                {view.terms.unclassified.map((doc) => (
                  <tr key={doc.id} className="h-7">
                    <td className="px-2 py-1 font-code text-xs">{doc.documentDate}</td>
                    <td className="px-2 py-1 text-right">
                      <Amount cents={doc.baseCents} />
                    </td>
                    <td className="px-2 py-1 text-xs">
                      <Link href={`/unsorted/${doc.id}`} className="underline underline-offset-4">
                        clasificar
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {view.terms.excluded.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Exclusiones del art. 104.Tres</h3>
          <table className="w-full rounded-md border text-sm" data-testid="prorrata-excluded">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Clave</th>
                <th className="px-3 py-2 text-right font-medium">Base excluida</th>
                <th className="px-3 py-2 text-left font-medium">Motivo</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {view.terms.excluded.map((exclusion) => (
                <tr key={exclusion.id} className="h-8">
                  <td className="px-3 py-1 text-xs">{exclusion.operationKey}</td>
                  <td className="px-3 py-1 text-right">
                    <Amount cents={exclusion.baseCents} />
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">{exclusion.motivo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="text-xs text-muted-foreground" data-testid="prorrata-evidence">
        {view.terms.evidencia}
      </p>

      {isAdmin && view.closedAt === null && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => close(true)} disabled={pending || bloqueada} data-testid="prorrata-dry-run">
            Vista previa del ajuste
          </Button>
          <Button type="button" onClick={() => close(false)} disabled={pending || bloqueada} data-testid="prorrata-close">
            Cerrar la prorrata definitiva
          </Button>
        </div>
      )}
    </div>
  )
}
