"use client"

import { detectionTestAction, runInvariantsAction } from "@/app/(app)/audit/actions"
import { CheckStatusChip } from "@/components/ui/check-status"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E7 · T12 — «Ejecutar barrido» (EDITOR) y «Prueba de detección» (ADMIN).
 *
 * El barrido persiste un `InvariantRun` sellado; la prueba **no escribe nada**:
 * inyecta un céntimo en una copia en memoria de la entrada del motor y corre el
 * mismo motor puro sobre ella (§7). Por eso la prueba enseña el **antes**, el
 * **después** y, sobre todo, `detectedBy`: los checks que pasan de PASS a FAIL,
 * que es la demostración de que la capa de fiabilidad detecta una alteración de
 * un céntimo.
 *
 * Los botones se ocultan a quien no tiene el rol **y** la acción lo vuelve a
 * exigir: ocultar no es proteger.
 */

type FiscalYearOption = { id: string; code: string }

export function RunSweepButton({
  fiscalYears,
  defaultFiscalYearId,
}: {
  fiscalYears: readonly FiscalYearOption[]
  defaultFiscalYearId: string | null
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [fiscalYearId, setFiscalYearId] = useState(defaultFiscalYearId ?? "")

  const run = (): void => {
    start(async () => {
      const state = await runInvariantsAction(
        fiscalYearId
          ? { scopeKind: "FISCAL_YEAR", fiscalYearId, persist: true }
          : { scopeKind: "ORGANIZATION", persist: true }
      )
      if (!state.success || !state.data) {
        toast.error(state.success ? "El barrido no ha devuelto resultado" : state.error)
        return
      }
      const fallos = state.data.checks.filter((check) => check.status === "FAIL").length
      toast.success(
        fallos === 0
          ? `Barrido terminado: ${state.data.checks.length} comprobaciones, ninguna en FAIL`
          : `Barrido terminado: ${fallos} comprobación(es) en FAIL`
      )
      router.refresh()
    })
  }

  return (
    <div className="flex items-end gap-2">
      {fiscalYears.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="sweep-fiscal-year" className="text-xs">
            Alcance
          </Label>
          <select
            id="sweep-fiscal-year"
            value={fiscalYearId}
            onChange={(event) => setFiscalYearId(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            data-testid="sweep-scope"
          >
            <option value="">Toda la organización</option>
            {fiscalYears.map((year) => (
              <option key={year.id} value={year.id}>
                Ejercicio {year.code}
              </option>
            ))}
          </select>
        </div>
      )}
      <Button type="button" onClick={run} disabled={pending} data-testid="run-sweep">
        {pending ? "Barriendo…" : "Ejecutar barrido"}
      </Button>
    </div>
  )
}

type DetectionResult = {
  entryId: string
  lineNo: number
  alteredCents: number
  before: readonly { id: string; status: string; evidencia: string }[]
  after: readonly { id: string; status: string; evidencia: string }[]
  detectedBy: string[]
}

export function DetectionTestDialog({ fiscalYearId }: { fiscalYearId: string | null }) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [result, setResult] = useState<DetectionResult | null>(null)

  const run = (): void => {
    start(async () => {
      const state = await detectionTestAction(fiscalYearId ? { fiscalYearId } : {})
      if (!state.success || !state.data) {
        toast.error(state.success ? "La prueba no ha devuelto resultado" : state.error)
        return
      }
      setResult(state.data as unknown as DetectionResult)
    })
  }

  const beforeById = new Map((result?.before ?? []).map((check) => [check.id, check]))
  const cambiados = (result?.after ?? []).filter((check) => beforeById.get(check.id)?.status !== check.status)

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} data-testid="open-detection-test">
        Prueba de detección
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Prueba de detección</DialogTitle>
            <DialogDescription>
              Altera <strong>un céntimo</strong> en una copia <strong>en memoria</strong> de la entrada del motor —la
              línea se elige de forma determinista, la primera por (fecha, número de asiento, línea)— y corre el mismo
              motor puro sobre ella. <strong>No se escribe nada</strong> en el libro diario y no se emite ningún
              barrido: el resultado va marcado como PRUEBA.
            </DialogDescription>
          </DialogHeader>

          {result === null ? (
            <p className="text-sm text-muted-foreground">
              Pulse «Ejecutar la prueba» para ver qué comprobaciones delatarían la alteración.
            </p>
          ) : (
            <div className="space-y-3" data-testid="detection-result">
              <p className="text-sm">
                Se alteró {result.alteredCents} céntimo en la línea {result.lineNo} del asiento{" "}
                <span className="font-code">{result.entryId.slice(0, 8)}</span>.
              </p>
              <p className="text-sm">
                Detectada por{" "}
                <strong data-testid="detection-detected-by">
                  {result.detectedBy.length > 0 ? result.detectedBy.join(", ") : "ninguna comprobación"}
                </strong>
                .
              </p>
              <div className="max-h-[45vh] overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="p-2 text-left font-medium">Comprobación</th>
                      <th className="p-2 text-left font-medium">Antes</th>
                      <th className="p-2 text-left font-medium">Después</th>
                      <th className="p-2 text-left font-medium">Evidencia tras la alteración</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cambiados.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-3 text-center text-muted-foreground">
                          Ninguna comprobación cambió de estado.
                        </td>
                      </tr>
                    ) : (
                      cambiados.map((check) => (
                        <tr key={check.id} className="border-t align-top" data-testid={`detection-row-${check.id}`}>
                          <td className="font-code p-2">{check.id}</td>
                          <td className="p-2">
                            <CheckStatusChip
                              status={(beforeById.get(check.id)?.status ?? "INFO") as "PASS" | "FAIL" | "WARN" | "INFO"}
                            />
                          </td>
                          <td className="p-2">
                            <CheckStatusChip status={check.status as "PASS" | "FAIL" | "WARN" | "INFO"} />
                          </td>
                          <td className="p-2 text-muted-foreground">{check.evidencia}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            <Button type="button" onClick={run} disabled={pending} data-testid="run-detection-test">
              {pending ? "Ejecutando…" : "Ejecutar la prueba"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
