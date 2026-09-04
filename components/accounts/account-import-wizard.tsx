"use client"

import { importPlanCsvAction } from "@/app/(app)/settings/accounts/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

const NONE = "__none__"

type Diff = { created: number; updated: number; skipped: number; preview: { code: string; name: string; action: string }[] }

/** Separadores admitidos. Un plan exportado de otro programa suele venir con `;`. */
const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Coma (,)" },
  { value: ";", label: "Punto y coma (;)" },
  { value: "\t", label: "Tabulador" },
]

function splitHeader(text: string, delimiter: string): string[] {
  const firstLine = text.split(/\r?\n/)[0] ?? ""
  return firstLine
    .split(delimiter)
    .map((column) => column.trim().replace(/^"|"$/g, ""))
    .filter((column) => column !== "")
}

/**
 * Import de plan propio en tres pasos: subir → mapear columnas → previsualizar
 * el diff → confirmar.
 *
 * El navegador NO calcula el diff ni interpreta el plan: sólo lee el fichero y
 * lee la cabecera para ofrecer los selects. `dryRun` va al servidor y vuelve con
 * el `PlanDiff`; nada se escribe hasta la confirmación.
 */
export function AccountImportWizard() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [csv, setCsv] = useState("")
  const [fileName, setFileName] = useState("")
  const [delimiter, setDelimiter] = useState(",")
  const [columns, setColumns] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Diff | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const text = await file.text()
    setCsv(text)
    setFileName(file.name)
    const detected = [";", "\t", ","].find((candidate) => splitHeader(text, candidate).length > 1) ?? ","
    setDelimiter(detected)
    setColumns(splitHeader(text, detected))
    setStep(2)
  }

  const buildFormData = (dryRun: boolean) => {
    const formData = new FormData()
    formData.set("csv", csv)
    formData.set("fileName", fileName)
    formData.set("delimiter", delimiter)
    formData.set("mappingCode", mapping.code ?? "")
    formData.set("mappingName", mapping.name ?? "")
    for (const field of ["statement", "epigraph", "analyticType", "nature"] as const) {
      const value = mapping[field]
      if (value && value !== NONE) formData.set(`mapping${field[0].toUpperCase()}${field.slice(1)}`, value)
    }
    formData.set("dryRun", dryRun ? "true" : "false")
    formData.set("reason", reason)
    return formData
  }

  const preview = () => {
    setError(null)
    startTransition(async () => {
      const state = await importPlanCsvAction(null, buildFormData(true))
      if (!state.success || !state.data) {
        setError(state.error ?? "El fichero no se ha podido interpretar")
        return
      }
      setDiff(state.data)
      setStep(3)
    })
  }

  const confirm = () => {
    setError(null)
    startTransition(async () => {
      const state = await importPlanCsvAction(null, buildFormData(false))
      if (!state.success || !state.data) {
        setError(state.error ?? "La importación se ha rechazado")
        return
      }
      setDone(state.data)
      router.refresh()
    })
  }

  if (done) {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <p className="text-sm">
          Importación aplicada: {done.created} cuenta(s) creada(s), {done.updated} actualizada(s), {done.skipped} sin
          cambios.
        </p>
        <Button type="button" variant="outline" onClick={() => router.push("/settings/accounts")}>
          Ver el plan de cuentas
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <ol className="flex gap-4 text-sm">
        {["1 · Subir fichero", "2 · Mapear columnas", "3 · Previsualizar y confirmar"].map((label, index) => (
          <li key={label} className={index + 1 === step ? "font-semibold" : "text-muted-foreground"}>
            {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-3">
          <label className="flex max-w-md flex-col gap-1">
            <span className="text-sm font-medium">Fichero CSV del plan</span>
            <Input type="file" accept=".csv,text/csv" onChange={(event) => onFile(event.target.files?.[0])} />
          </label>
          <p className="text-sm text-muted-foreground">
            Se admite cualquier cabecera: en el paso siguiente se indica qué columna es cada cosa. Todas las filas
            deben ser válidas: si una sola falla, no se importa ninguna.
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {fileName} · {columns.length} columnas detectadas.
          </p>

          <label className="flex max-w-xs flex-col gap-1">
            <span className="text-sm font-medium">Separador</span>
            <Select
              value={delimiter}
              onValueChange={(value) => {
                setDelimiter(value)
                setColumns(splitHeader(csv, value))
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIMITERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                { field: "code", label: "Código de cuenta *", optional: false },
                { field: "name", label: "Nombre de la cuenta *", optional: false },
                { field: "nature", label: "Naturaleza", optional: true },
                { field: "statement", label: "Estado financiero", optional: true },
                { field: "epigraph", label: "Epígrafe", optional: true },
                { field: "analyticType", label: "Tipo analítico", optional: true },
              ] as const
            ).map(({ field, label, optional }) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-sm font-medium">{label}</span>
                <Select
                  value={mapping[field] ?? NONE}
                  onValueChange={(value) => setMapping((previous) => ({ ...previous, [field]: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin asignar" />
                  </SelectTrigger>
                  <SelectContent>
                    {optional && <SelectItem value={NONE}>Sin asignar</SelectItem>}
                    {columns.map((column) => (
                      <SelectItem key={column} value={column}>
                        {column}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(1)}>
              Atrás
            </Button>
            <Button
              type="button"
              onClick={preview}
              disabled={pending || !mapping.code || !mapping.name || mapping.code === NONE || mapping.name === NONE}
            >
              {pending ? "Analizando…" : "Previsualizar cambios"}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && diff && (
        <div className="space-y-4">
          <p className="text-sm">
            <strong>{diff.created}</strong> cuenta(s) a crear · <strong>{diff.updated}</strong> a actualizar ·{" "}
            <strong>{diff.skipped}</strong> sin cambios. Todavía no se ha escrito nada.
          </p>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.preview.map((row) => (
                  <TableRow key={`${row.action}-${row.code}`}>
                    <TableCell className="font-code text-xs">{row.code}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.action === "create" ? "Crear" : "Actualizar"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <label className="flex max-w-xl flex-col gap-1">
            <span className="text-sm font-medium">Motivo (opcional)</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep(2)}>
              Atrás
            </Button>
            <Button type="button" onClick={confirm} disabled={pending || diff.created + diff.updated === 0}>
              {pending ? "Importando…" : "Importar"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
