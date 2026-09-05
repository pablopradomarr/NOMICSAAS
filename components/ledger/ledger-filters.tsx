"use client"

import type { AccountOption, FiscalYearView } from "@/components/ledger/types"
import { ENTRY_KIND_LABELS } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter, useSearchParams } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T11 — Filtros del libro diario (diseño §6).
 *
 * Los filtros viven en la URL (`searchParams`), no en estado del cliente: la
 * consulta la resuelve el Server Component, así que un enlace al diario
 * filtrado es compartible y el botón "atrás" funciona. El cliente no consulta
 * la base ni filtra nada localmente.
 */

export type LedgerFilterValues = {
  fiscalYearId?: string
  from?: string
  to?: string
  account?: string
  q?: string
  kind?: string
  templateCode?: string
  voided?: string
}

export function LedgerFilters({
  fiscalYears,
  accounts,
  templateCodes,
  values,
}: {
  fiscalYears: readonly FiscalYearView[]
  accounts: readonly AccountOption[]
  templateCodes: readonly { code: string; label: string }[]
  values: LedgerFilterValues
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<LedgerFilterValues>(values)

  const apply = (next: LedgerFilterValues) => {
    const search = new URLSearchParams(params.toString())
    for (const [key, value] of Object.entries(next)) {
      if (value && value !== "") search.set(key, value)
      else search.delete(key)
    }
    search.delete("page")
    startTransition(() => router.push(`/ledger?${search.toString()}`))
  }

  const set = <K extends keyof LedgerFilterValues>(key: K, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <form
      className="grid gap-3 rounded-md border p-3 md:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault()
        apply(draft)
      }}
      aria-label="Filtros del libro diario"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Ejercicio</span>
        <select
          value={draft.fiscalYearId ?? ""}
          onChange={(event) => set("fiscalYearId", event.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos</option>
          {fiscalYears.map((fy) => (
            <option key={fy.id} value={fy.id}>
              {fy.code} {fy.status === "CLOSED" ? "(cerrado)" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Desde</span>
        <Input type="date" value={draft.from ?? ""} onChange={(event) => set("from", event.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Hasta</span>
        <Input type="date" value={draft.to ?? ""} onChange={(event) => set("to", event.target.value)} />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Cuenta</span>
        <Input
          list="ledger-filter-accounts"
          value={draft.account ?? ""}
          onChange={(event) => set("account", event.target.value)}
          placeholder="430, 705…"
          className="font-code"
        />
        <datalist id="ledger-filter-accounts">
          {accounts.map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} · {account.name}
            </option>
          ))}
        </datalist>
      </label>

      <label className="flex flex-col gap-1 text-sm md:col-span-2">
        <span className="text-xs font-medium text-muted-foreground">Texto</span>
        <Input
          value={draft.q ?? ""}
          onChange={(event) => set("q", event.target.value)}
          placeholder="Concepto del asiento o de la línea"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Tipo / plantilla</span>
        <select
          value={draft.templateCode ? `T:${draft.templateCode}` : draft.kind ? `K:${draft.kind}` : ""}
          onChange={(event) => {
            const raw = event.target.value
            setDraft((current) => ({
              ...current,
              kind: raw.startsWith("K:") ? raw.slice(2) : "",
              templateCode: raw.startsWith("T:") ? raw.slice(2) : "",
            }))
          }}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos</option>
          <optgroup label="Naturaleza del asiento">
            {Object.entries(ENTRY_KIND_LABELS).map(([code, label]) => (
              <option key={code} value={`K:${code}`}>
                {label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Plantilla">
            {templateCodes.map((template) => (
              <option key={template.code} value={`T:${template.code}`}>
                {template.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Anulaciones</span>
        <select
          value={draft.voided ?? ""}
          onChange={(event) => set("voided", event.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">Todos los asientos</option>
          <option value="only">Solo anulados</option>
          <option value="none">Solo no anulados</option>
          <option value="reversals">Solo contra-asientos</option>
        </select>
      </label>

      <div className="flex items-end gap-2 md:col-span-4">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Filtrando…" : "Aplicar filtros"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setDraft({})
            startTransition(() => router.push("/ledger"))
          }}
        >
          Limpiar
        </Button>
      </div>
    </form>
  )
}
