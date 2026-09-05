"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E6 · T16 — Barra de parámetros de los informes.
 *
 * El estado vive en la URL y la consulta la resuelve el Server Component: así
 * un informe es un enlace que se puede pegar en un correo y que devuelve
 * exactamente las mismas cifras (mismo `paramsHash`).
 */

export type ToolbarField =
  | {
      kind: "select"
      name: string
      label: string
      value: string
      options: readonly { value: string; label: string }[]
      hint?: string
    }
  | { kind: "date"; name: string; label: string; value: string; hint?: string }

export function ReportToolbar({
  basePath,
  fields,
  submitLabel = "Ver informe",
}: {
  basePath: string
  fields: readonly ToolbarField[]
  submitLabel?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((field) => [field.name, field.value]))
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const search = new URLSearchParams()
    for (const field of fields) {
      const value = draft[field.name]
      if (value) search.set(field.name, value)
    }
    startTransition(() => router.push(`${basePath}?${search.toString()}`))
  }

  return (
    <form
      className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-4 lg:grid-cols-5"
      onSubmit={submit}
      aria-label="Parámetros del informe"
      data-testid="report-toolbar"
    >
      {fields.map((field) => (
        <label key={field.name} className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{field.label}</span>
          {field.kind === "select" ? (
            <select
              aria-label={field.label}
              name={field.name}
              value={draft[field.name] ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label={field.label}
              name={field.name}
              type="date"
              value={draft[field.name] ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          )}
          {field.hint && <span className="text-[11px] text-muted-foreground">{field.hint}</span>}
        </label>
      ))}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Calculando…" : submitLabel}
      </Button>
    </form>
  )
}
