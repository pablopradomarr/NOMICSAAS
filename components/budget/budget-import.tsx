"use client"

/**
 * E10 · T15 — **Import CSV** del presupuesto con previsualización (§7, R-B-6).
 *
 * El fichero se lee en el navegador **como texto** y se manda entero al
 * servidor: aquí no se parsea, no se valida y no se convierte nada. El parseo,
 * la lista blanca de columnas, el rechazo por fila con su motivo y el **rechazo
 * del fichero entero** cuando más del 90 % de las líneas de grupo 6 vienen en
 * positivo son de `importBudgetCsvAction`.
 *
 * El botón «Previsualizar» hace un `dry-run`: valida e informa **sin escribir
 * una sola fila**. Importar sin ver antes qué se rechaza es como confirmar un
 * lote a ciegas.
 */

import { importBudgetCsvFromFormAction } from "@/app/(app)/analytics/budget/ui-actions"
import type { BudgetImportPayload } from "@/app/(app)/analytics/budget/actions"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function BudgetImportPanel({ budgetId, canEdit }: { budgetId: string; canEdit: boolean }) {
  const router = useRouter()
  const [csv, setCsv] = useState("")
  const [delimiter, setDelimiter] = useState<"," | ";">(";")
  const [report, setReport] = useState<BudgetImportPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!canEdit) return null

  const run = (dryRun: boolean) =>
    start(async () => {
      setError(null)
      const state = await importBudgetCsvFromFormAction({ budgetId, csv, delimiter, dryRun })
      if (!state.success) {
        setReport(null)
        setError(state.error ?? "No se ha podido importar el fichero")
        return
      }
      setReport(state.data ?? null)
      if (!dryRun) router.refresh()
    })

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="budget-import">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Importar presupuesto desde CSV</h2>
        <p className="text-xs text-muted-foreground">
          Columnas admitidas: <span className="font-code">mes · cuenta · tipo_analitico · proyecto · centro_coste ·
          importe_centimos · excepcion_signo · nota</span>. El importe va en <strong>céntimos enteros</strong> y en
          aporte (ingreso +, gasto −). Lo que no esté en esa lista se ignora; una fila incompleta se rechaza con su
          número de línea y su motivo, y si más del 90 % de las líneas de grupo 6 vienen en positivo{" "}
          <strong>se rechaza el fichero entero</strong>: importar la mitad al revés es peor que no importar.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-xs"
          aria-label="Fichero CSV de presupuesto"
          data-testid="budget-csv-file"
          onChange={async (event) => {
            const file = event.target.files?.[0]
            if (!file) return
            setCsv(await file.text())
            setReport(null)
          }}
        />
        <label className="flex items-center gap-2 text-xs">
          Separador
          <select
            aria-label="Separador del CSV"
            className={SELECT_CLASS}
            value={delimiter}
            onChange={(event) => setDelimiter(event.target.value === "," ? "," : ";")}
            data-testid="budget-csv-delimiter"
          >
            <option value=";">punto y coma</option>
            <option value=",">coma</option>
          </select>
        </label>
      </div>

      <Textarea
        value={csv}
        rows={5}
        className="font-code text-xs"
        aria-label="Contenido del CSV"
        placeholder={"mes;cuenta;tipo_analitico;proyecto;importe_centimos\n2026-03-01;6400;COSTE_DIRECTO_MC2;P-01;-120000"}
        onChange={(event) => {
          setCsv(event.target.value)
          setReport(null)
        }}
        data-testid="budget-csv-text"
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || csv.trim() === ""}
          onClick={() => run(true)}
          data-testid="budget-csv-preview"
        >
          {pending ? "Validando…" : "Previsualizar (no escribe nada)"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || csv.trim() === "" || report === null || report.fileRejected}
          onClick={() => run(false)}
          data-testid="budget-csv-import"
        >
          Importar
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="budget-csv-error">
          {error}
        </p>
      )}

      {report && (
        <div
          className={`rounded-md border p-3 text-xs ${report.fileRejected ? "border-[#F5A623] bg-[#F5A623]/10" : ""}`}
          data-testid="budget-csv-report"
          data-file-rejected={report.fileRejected ? "1" : "0"}
        >
          <p>
            {report.dryRun ? "Previsualización" : "Importación"}: <strong>{report.parsed}</strong> filas leídas ·{" "}
            <strong data-testid="csv-inserted">{report.inserted}</strong> insertadas ·{" "}
            <strong data-testid="csv-rejected">{report.rejected}</strong> rechazadas
            {report.fileRejected && " · FICHERO RECHAZADO ENTERO"}
          </p>
          {report.reasons.length > 0 && (
            <ul className="mt-2 space-y-1">
              {report.reasons.map((reason, index) => (
                <li key={`${reason.line}-${index}`}>
                  {reason.line > 0 ? `Línea ${reason.line}: ` : ""}
                  {reason.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
