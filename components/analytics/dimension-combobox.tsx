"use client"

import type { DimensionOption } from "@/components/analytics/types"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useId, useMemo, useRef, useState } from "react"

/**
 * E4 · T15 — Destino analítico de una línea 6/7 (`E4-analitica.md` §6).
 *
 * Un solo control para las dos familias: **proyecto** (directo) o **centro de
 * coste** (indirecto), porque la regla de destino admite exactamente uno de los
 * dos (C-9, I-E4-2). Devuelve `{ projectId, costCenterId }` con el otro a
 * `null`, de modo que el formulario no pueda mandar los dos.
 *
 * Búsqueda por código y por nombre, igual que `AccountCombobox`; la lista llega
 * ya filtrada del servidor (dimensiones activas del tenant).
 */
export type DimensionValue = { projectId: string | null; costCenterId: string | null }

export const EMPTY_DIMENSION: DimensionValue = { projectId: null, costCenterId: null }

export function DimensionCombobox({
  options,
  value,
  onChange,
  label,
  placeholder = "Proyecto o centro de coste",
  disabled,
  invalid,
  required,
  className,
}: {
  options: readonly DimensionOption[]
  value: DimensionValue
  onChange: (value: DimensionValue) => void
  label: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  required?: boolean
  className?: string
}) {
  const listId = useId()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selected = useMemo(
    () =>
      options.find(
        (o) =>
          (o.family === "project" && o.id === value.projectId) ||
          (o.family === "costCenter" && o.id === value.costCenterId)
      ) ?? null,
    [options, value.projectId, value.costCenterId]
  )

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const usable = options.filter((o) => !o.disabled)
    if (needle === "") return usable.slice(0, 40)
    return usable
      .filter((o) => o.code.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle))
      .slice(0, 40)
  }, [options, query])

  const shown = open ? query : selected ? `${selected.code} · ${selected.name}` : ""

  const commit = (option: DimensionOption) => {
    onChange(
      option.family === "project"
        ? { projectId: option.id, costCenterId: null }
        : { projectId: null, costCenterId: option.id }
    )
    setQuery("")
    setOpen(false)
  }

  return (
    <div className={cn("relative", className)}>
      <Input
        aria-label={label}
        aria-required={required || undefined}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={shown}
        placeholder={disabled ? "—" : placeholder}
        data-dimension-project={value.projectId ?? ""}
        data-dimension-cost-center={value.costCenterId ?? ""}
        className={cn("h-8 text-xs", invalid && "border-[#F5A623]")}
        onFocus={() => {
          setQuery("")
          setOpen(true)
          setHighlight(0)
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120)
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setHighlight(0)
          if (event.target.value.trim() === "") onChange(EMPTY_DIMENSION)
        }}
        onKeyDown={(event) => {
          if (!open) return
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setHighlight((h) => Math.min(h + 1, matches.length - 1))
          } else if (event.key === "ArrowUp") {
            event.preventDefault()
            setHighlight((h) => Math.max(h - 1, 0))
          } else if (event.key === "Enter" && matches[highlight]) {
            event.preventDefault()
            commit(matches[highlight])
          } else if (event.key === "Escape") {
            setOpen(false)
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-[24rem] overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.map((option, index) => (
            <li key={`${option.family}-${option.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(event) => {
                  event.preventDefault()
                  if (blurTimer.current) clearTimeout(blurTimer.current)
                  commit(option)
                }}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs",
                  index === highlight && "bg-muted"
                )}
              >
                <span className="font-code w-20 shrink-0">{option.code}</span>
                <span className="truncate">{option.name}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {option.family === "project" ? "Proyecto" : "Centro de coste"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
