"use client"

import type { AccountOption } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T12 — Selector de ejercicio, periodo y cuenta de los informes.
 *
 * Igual que los filtros del diario: el estado vive en la URL y la consulta la
 * resuelve el Server Component. Elegir ejercicio recoloca las fechas a sus
 * extremos; a partir de ahí se pueden afinar a mano.
 */
export function ReportPeriodPicker({
  basePath,
  fiscalYears,
  selectedFiscalYearId,
  from,
  to,
  accounts,
  account,
}: {
  basePath: string
  fiscalYears: readonly { id: string; code: string; startDate: string; endDate: string; status: string }[]
  selectedFiscalYearId: string
  from: string
  to: string
  /** Si se omite, el selector no ofrece filtro por cuenta (sumas y saldos). */
  accounts?: readonly AccountOption[]
  account?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState({ fiscalYearId: selectedFiscalYearId, from, to, account: account ?? "" })

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const search = new URLSearchParams()
    if (draft.fiscalYearId) search.set("fiscalYearId", draft.fiscalYearId)
    if (draft.from) search.set("from", draft.from)
    if (draft.to) search.set("to", draft.to)
    if (draft.account) search.set("account", draft.account)
    startTransition(() => router.push(`${basePath}?${search.toString()}`))
  }

  return (
    <form className="grid items-end gap-3 rounded-md border p-3 md:grid-cols-5" onSubmit={submit} aria-label="Periodo del informe">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Ejercicio</span>
        <select
          aria-label="Ejercicio"
          value={draft.fiscalYearId}
          onChange={(event) => {
            const fy = fiscalYears.find((f) => f.id === event.target.value)
            setDraft((current) => ({
              ...current,
              fiscalYearId: event.target.value,
              from: fy ? fy.startDate : current.from,
              to: fy ? fy.endDate : current.to,
            }))
          }}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Sin ejercicio</option>
          {fiscalYears.map((fy) => (
            <option key={fy.id} value={fy.id}>
              {fy.code} {fy.status === "CLOSED" ? "(cerrado)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Desde</span>
        <Input aria-label="Desde" type="date" value={draft.from} onChange={(e) => setDraft((c) => ({ ...c, from: e.target.value }))} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Hasta</span>
        <Input aria-label="Hasta" type="date" value={draft.to} onChange={(e) => setDraft((c) => ({ ...c, to: e.target.value }))} />
      </label>

      {accounts && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Cuenta</span>
          <Input
            aria-label="Cuenta"
            list="report-accounts"
            className="font-code"
            value={draft.account}
            onChange={(e) => setDraft((c) => ({ ...c, account: e.target.value }))}
            placeholder="Todas"
          />
          <datalist id="report-accounts">
            {accounts.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </datalist>
        </label>
      )}

      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Cargando…" : "Ver informe"}
      </Button>
    </form>
  )
}
