"use client"

import { previewSplitAction, splitProposalAction } from "@/app/(app)/unsorted/actions"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E7 · T17 — Diálogo de **split N-a-1** (deuda de E8, `E7-auditoria.md` §6).
 *
 * Una factura, N operaciones. Reglas que esta pantalla hace visibles:
 *
 * · **Es una partición.** Cada línea del documento cae en un grupo y en uno
 *   solo. Un split que deja líneas fuera contabilizaría menos de lo que la
 *   factura dice y nadie lo notaría hasta la conciliación: por eso el servidor
 *   devuelve `SPLIT_NOT_A_PARTITION` y aquí se explica antes de confirmar.
 * · **Los totales por grupo los calcula el servidor**, con la cuota repartida
 *   por mayor resto sobre la base de cada grupo. `Σ cuotas = cuota del
 *   documento`, tolerancia 0. El navegador no reparte una cuota ni para
 *   enseñarla.
 * · **Un documento con retención, anticipo aplicado o rectificación NO se
 *   divide**: la base de la retención (art. 99 LIRPF) y el documento rectificado
 *   son del documento entero. El diálogo no se abre y lo dice.
 * · El fichero no se toca: su `sha256` es el mismo para las N operaciones, así
 *   que la cadena de trazabilidad sigue llegando a los mismos bytes.
 */

export type SplitLineView = {
  index: number
  description: string
  baseCents: number
  discountCents: number
  taxRateCode: string | null
}

type PreviewGroup = {
  index: number
  description: string | null
  lineCount: number
  baseCents: number
  quotaCents: number
  totalCents: number
}

export function SplitDialog({
  runId,
  lines,
  splittable,
  notSplittableReason,
}: {
  runId: string
  lines: readonly SplitLineView[]
  splittable: boolean
  notSplittableReason: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  /** `groupOf[i]` = grupo (0..N−1) al que va la línea `i` del documento. */
  const [groupOf, setGroupOf] = useState<number[]>(() => lines.map(() => 0))
  const [names, setNames] = useState<string[]>(["Parte 1", "Parte 2"])
  const [preview, setPreview] = useState<{
    ok: boolean
    errors: { code: string; message: string }[]
    groups: PreviewGroup[]
    documentQuotaCents: number
  } | null>(null)

  const groupCount = names.length

  const groupsPayload = (): { lineIndexes: number[]; description?: string }[] =>
    names.map((name, group) => ({
      lineIndexes: lines.map((line) => line.index).filter((index) => groupOf[index] === group),
      ...(name.trim() ? { description: name.trim() } : {}),
    }))

  /** Líneas que no están en ningún grupo: el split dejaría de ser una partición. */
  const fuera = lines.filter((line) => (groupOf[line.index] ?? 0) < 0).map((line) => line.index)

  const calcular = (): void => {
    // Un grupo vacío no es expresable —cada grupo lleva al menos una línea—, así
    // que una línea fuera de todos los grupos no llega siquiera al servidor. Se
    // declara aquí con **el mismo código y el mismo criterio** que usa
    // `splitProposal()`, que es quien lo vuelve a comprobar en cuanto la
    // partición es expresable: no es una segunda regla, es la misma dicha antes.
    if (fuera.length > 0) {
      setPreview({
        ok: false,
        errors: [
          {
            code: "SPLIT_NOT_A_PARTITION",
            message: `El split deja ${fuera.length} línea(s) sin grupo (${fuera.join(", ")}): el documento entero tiene que quedar contabilizado`,
          },
        ],
        groups: [],
        documentQuotaCents: 0,
      })
      return
    }
    start(async () => {
      const state = await previewSplitAction({ runId, groups: groupsPayload() })
      if (!state.success || !state.data) {
        toast.error(state.success ? "La vista previa no ha devuelto resultado" : state.error)
        return
      }
      setPreview(state.data as typeof preview)
    })
  }

  const confirmar = (): void => {
    start(async () => {
      const state = await splitProposalAction({ runId, groups: groupsPayload() })
      if (!state.success || !state.data) {
        toast.error(state.success ? "El reparto no ha devuelto resultado" : state.error)
        return
      }
      toast.success(`${state.data.transactionIds.length} operaciones contabilizadas desde el mismo documento`)
      setOpen(false)
      router.push(`/ledger`)
      router.refresh()
    })
  }

  if (!splittable) {
    return (
      <Button type="button" variant="outline" size="sm" disabled title={notSplittableReason ?? ""} data-testid="split-disabled">
        Dividir en varias operaciones
      </Button>
    )
  }

  const sumaCuotas = preview ? preview.groups.reduce((total, group) => total + group.quotaCents, 0) : 0

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="open-split">
        Dividir en varias operaciones
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Dividir el documento en varias operaciones</DialogTitle>
            <DialogDescription>
              El fichero no se duplica: las N operaciones comparten el mismo documento y el mismo <span className="font-code">sha256</span>.
              Cada línea tiene que caer en un grupo y en uno solo; los totales y el reparto de la cuota los calcula el
              servidor.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              {names.map((name, group) => (
                <div key={group} className="space-y-1">
                  <label className="block text-xs text-muted-foreground" htmlFor={`split-name-${group}`}>
                    Grupo {group + 1}
                  </label>
                  <Input
                    id={`split-name-${group}`}
                    value={name}
                    onChange={(event) =>
                      setNames((current) => current.map((value, index) => (index === group ? event.target.value : value)))
                    }
                    className="w-40"
                    data-testid={`split-name-${group}`}
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setNames((current) => [...current, `Parte ${current.length + 1}`])}
                data-testid="split-add-group"
              >
                Añadir grupo
              </Button>
            </div>

            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left font-medium">Línea del documento</th>
                    <th className="p-2 text-right font-medium">Base</th>
                    <th className="p-2 text-left font-medium">Tipo</th>
                    <th className="p-2 text-left font-medium">Grupo</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.index} className="border-t" data-testid={`split-line-${line.index}`}>
                      <td className="p-2">{line.description || `Línea ${line.index + 1}`}</td>
                      <td className="p-2 text-right">
                        <Amount cents={line.baseCents - line.discountCents} zeroAsDash={false} />
                      </td>
                      <td className="font-code p-2 text-xs">{line.taxRateCode ?? "—"}</td>
                      <td className="p-2">
                        <select
                          value={groupOf[line.index] ?? 0}
                          onChange={(event) =>
                            setGroupOf((current) =>
                              current.map((value, index) => (index === line.index ? Number(event.target.value) : value))
                            )
                          }
                          className="h-8 rounded-md border bg-background px-2 text-sm"
                          aria-label={`Grupo de la línea ${line.index + 1}`}
                          data-testid={`split-group-of-${line.index}`}
                        >
                          {names.map((name, group) => (
                            <option key={group} value={group}>
                              {name || `Grupo ${group + 1}`}
                            </option>
                          ))}
                          <option value={-1}>— fuera de todos los grupos —</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview && (
              <div className="rounded-md border p-3 text-sm" data-testid="split-preview">
                {preview.ok ? (
                  <>
                    <table className="w-full text-sm">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left font-medium">Grupo</th>
                          <th className="text-right font-medium">Líneas</th>
                          <th className="text-right font-medium">Base</th>
                          <th className="text-right font-medium">Cuota</th>
                          <th className="text-right font-medium">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.groups.map((group) => (
                          <tr key={group.index} className="border-t" data-testid={`split-group-${group.index}`}>
                            <td className="py-1">{group.description ?? `Grupo ${group.index + 1}`}</td>
                            <td className="py-1 text-right tabular-nums">{group.lineCount}</td>
                            <td className="py-1 text-right">
                              <Amount cents={group.baseCents} zeroAsDash={false} />
                            </td>
                            <td className="py-1 text-right">
                              <Amount cents={group.quotaCents} zeroAsDash={false} />
                            </td>
                            <td className="py-1 text-right">
                              <Amount cents={group.totalCents} zeroAsDash={false} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-xs" data-testid="split-cuadre">
                      Σ cuotas de los grupos <Amount cents={sumaCuotas} zeroAsDash={false} /> = cuota del documento{" "}
                      <Amount cents={preview.documentQuotaCents} zeroAsDash={false} />{" "}
                      {sumaCuotas === preview.documentQuotaCents ? "✓" : "⚠"}
                    </p>
                  </>
                ) : (
                  <ul className="space-y-1" role="alert" data-testid="split-errors">
                    {preview.errors.map((error) => (
                      <li key={error.code}>
                        <span className="font-code text-xs">{error.code}</span> · {error.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" variant="outline" onClick={calcular} disabled={pending || groupCount < 2} data-testid="split-preview-button">
              {pending ? "…" : "Calcular los totales"}
            </Button>
            <Button
              type="button"
              onClick={confirmar}
              disabled={pending || preview === null || !preview.ok}
              data-testid="confirm-split"
            >
              Contabilizar {preview?.groups.length ?? groupCount} operaciones
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
