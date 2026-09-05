"use client"

import { Amount, AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { KindBadge, ReversalBadge, VoidedBadge } from "@/components/ledger/entry-badges"
import type { EntryView } from "@/components/ledger/types"
import { SOURCE_TYPE_LABELS } from "@/components/ledger/types"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

/**
 * E3 · T11 — Libro diario: tabla jerárquica asiento → líneas (diseño §6).
 *
 * El orden viene del servidor, `(entryDate, entryNumber)` (N-5): un asiento con
 * fecha retroactiva no se renumera, se coloca en su sitio al presentarlo. Los
 * totales de cada asiento y del pie llegan calculados por
 * `lib/ledger/reports/diario.ts`; aquí no se suma nada.
 */
export function JournalTable({
  entries,
  totals,
  baseCurrency,
  initiallyExpanded,
}: {
  entries: readonly EntryView[]
  totals: { totalDebitCents: number; totalCreditCents: number; differenceCents: number; balanced: boolean }
  baseCurrency: string
  /** Ids de asiento abiertos de partida (p. ej. el recién contabilizado). */
  initiallyExpanded?: readonly string[]
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(initiallyExpanded ?? []))

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (entries.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="journal-empty">
        No hay asientos que cumplan estos filtros.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm" data-testid="journal-table">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-8 px-2 py-2" />
            <th className="px-3 py-2 text-left font-medium">Nº</th>
            <th className="px-3 py-2 text-left font-medium">Fecha</th>
            <th className="px-3 py-2 text-left font-medium">Concepto</th>
            <th className="px-3 py-2 text-left font-medium">Origen</th>
            <th className="px-3 py-2 text-right font-medium">Debe</th>
            <th className="px-3 py-2 text-right font-medium">Haber</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((entry) => {
            const isOpen = expanded.has(entry.id)
            return (
              <FragmentRows key={entry.id} entry={entry} isOpen={isOpen} onToggle={() => toggle(entry.id)} />
            )
          })}
        </tbody>
        <tfoot className="border-t-2 bg-muted/30 font-medium">
          <tr className="h-9" data-testid="journal-totals">
            <td className="px-2 py-1" colSpan={5}>
              Totales del periodo ({baseCurrency})
            </td>
            <td className="px-3 py-1 text-right">
              <AmountPlain cents={totals.totalDebitCents} zeroAsDash={false} />
            </td>
            <td className="px-3 py-1 text-right">
              <AmountPlain cents={totals.totalCreditCents} zeroAsDash={false} />
            </td>
          </tr>
          <tr className="h-9 border-t" data-testid="journal-difference">
            <td className="px-2 py-1" colSpan={5}>
              <span className="text-muted-foreground">Σdebe − Σhaber = </span>
              <span className="font-code" data-difference-cents={totals.differenceCents}>
                <Amount cents={totals.differenceCents} currency={baseCurrency} zeroAsDash={false} />
              </span>
            </td>
            <td className="px-3 py-1 text-right" colSpan={2}>
              {totals.balanced ? <span>✓ cuadrado</span> : <span className="text-[#F5A623]">⚠ descuadrado</span>}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function FragmentRows({ entry, isOpen, onToggle }: { entry: EntryView; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="h-8 hover:bg-muted/20" data-entry-number={entry.entryNumber} data-entry-id={entry.id}>
        <td className="px-2 py-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? "Contraer" : "Desplegar"} el asiento nº ${entry.entryNumber}`}
            className="rounded p-0.5 hover:bg-muted"
          >
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </td>
        <td className="px-3 py-1">
          <Link href={`/ledger/${entry.id}`} className="font-code underline-offset-2 hover:underline">
            {entry.entryNumber}
          </Link>
        </td>
        <td className="px-3 py-1 tabular-nums whitespace-nowrap">{formatLocalDate(entry.entryDate)}</td>
        <td className="px-3 py-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>{entry.description}</span>
            <KindBadge kind={entry.kind} />
            <VoidedBadge entry={entry} />
            <ReversalBadge entry={entry} />
          </div>
        </td>
        <td className="px-3 py-1 text-xs text-muted-foreground">
          {SOURCE_TYPE_LABELS[entry.sourceType] ?? entry.sourceType}
          {entry.templateCode && <span className="font-code ml-1">{entry.templateCode}</span>}
        </td>
        <td className="px-3 py-1 text-right">
          <AmountPlain cents={entry.totalDebitCents} zeroAsDash={false} />
        </td>
        <td className="px-3 py-1 text-right">
          <AmountPlain cents={entry.totalCreditCents} zeroAsDash={false} />
        </td>
      </tr>
      {isOpen &&
        entry.lines.map((line) => (
          <tr key={`${entry.id}-${line.lineNo}`} className="h-8 bg-muted/10" data-line-no={line.lineNo}>
            <td className="px-2 py-1" />
            <td className="px-3 py-1" />
            <td className="px-3 py-1 text-xs text-muted-foreground">
              {line.dueDate ? `vto. ${formatLocalDate(line.dueDate)}` : ""}
            </td>
            <td className="px-3 py-1" colSpan={2}>
              <div className="flex items-center gap-2 pl-6">
                <Link
                  href={`/ledger/mayor?account=${line.accountCode}`}
                  className="font-code text-xs underline-offset-2 hover:underline"
                >
                  {line.accountCode}
                </Link>
                <span className="truncate text-muted-foreground">{line.accountName}</span>
                {line.description && <span className="truncate text-xs text-muted-foreground">· {line.description}</span>}
              </div>
            </td>
            <td className={cn("px-3 py-1 text-right")}>
              <AmountPlain cents={line.debitCents} />
            </td>
            <td className={cn("px-3 py-1 text-right")}>
              <AmountPlain cents={line.creditCents} />
            </td>
          </tr>
        ))}
    </>
  )
}
