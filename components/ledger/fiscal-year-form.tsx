"use client"

import { createFiscalYearAction } from "@/app/(app)/settings/fiscal-years/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T12 — Alta de ejercicio (ADMIN). El ejercicio irregular está permitido:
 * la única regla es que no se solape con otro de la organización, y quien la
 * impone es la base (`fiscal_years_no_overlap`, un EXCLUDE gist), no esta
 * pantalla.
 */
export function FiscalYearForm() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [code, setCode] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [error, setError] = useState<string | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    startTransition(async () => {
      setError(null)
      const state = await createFiscalYearAction({ code: code.trim(), startDate, endDate })
      if (!state.success) {
        setError(state.error ?? "No se ha podido crear el ejercicio")
        return
      }
      setCode("")
      setStartDate("")
      setEndDate("")
      router.refresh()
    })
  }

  return (
    <form className="grid items-end gap-3 rounded-md border p-4 md:grid-cols-4" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Etiqueta</span>
        <Input
          aria-label="Etiqueta del ejercicio"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="2026"
          maxLength={16}
          className="font-code"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Inicio</span>
        <Input aria-label="Inicio del ejercicio" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Fin</span>
        <Input aria-label="Fin del ejercicio" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>
      <Button type="submit" disabled={pending || code.trim() === "" || startDate === "" || endDate === ""}>
        {pending ? "Creando…" : "Crear ejercicio"}
      </Button>
      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm md:col-span-4" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
