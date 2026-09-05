"use client"

import type { AccountOption } from "@/components/ledger/types"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useId, useMemo, useRef, useState } from "react"

/**
 * E3 · T11 — Autocompletado de cuenta por **código y nombre** (diseño §6).
 *
 * Sólo ofrece cuentas activas y postables: la lista llega ya filtrada del
 * servidor (`getPlan` + `isPostable && isActive`), que es la misma condición
 * que el trigger `journal_lines_account_postable` impone en la base (I9).
 *
 * La lista se recorta a 40 coincidencias para no montar 900 nodos por cada
 * línea del asiento; escribir más letras es lo que la afina.
 */
export function AccountCombobox({
  accounts,
  value,
  onChange,
  label,
  placeholder = "Código o nombre",
  disabled,
  invalid,
}: {
  accounts: readonly AccountOption[]
  value: string
  onChange: (code: string) => void
  label: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
}) {
  const listId = useId()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === "") return accounts.slice(0, 40)
    return accounts
      .filter((a) => a.code.startsWith(needle) || a.name.toLowerCase().includes(needle))
      .slice(0, 40)
  }, [accounts, query])

  const selected = accounts.find((a) => a.code === value)
  const shown = open ? query : (value === "" ? "" : selected ? `${selected.code} · ${selected.name}` : value)

  const commit = (option: AccountOption) => {
    onChange(option.code)
    setQuery("")
    setOpen(false)
  }

  return (
    <div className="relative">
      <Input
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={shown}
        placeholder={placeholder}
        className={cn("font-code h-8 text-xs", invalid && "border-[#F5A623]")}
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
          // Escribir un código completo lo selecciona sin necesidad de pinchar.
          const exact = accounts.find((a) => a.code === event.target.value.trim())
          if (exact) onChange(exact.code)
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
          className="absolute z-50 mt-1 max-h-64 w-[22rem] overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.map((option, index) => (
            <li key={option.code}>
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
                <span className="font-code w-16 shrink-0">{option.code}</span>
                <span className="truncate text-muted-foreground">{option.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
